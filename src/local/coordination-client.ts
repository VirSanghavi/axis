import { logger } from "../utils/logger.js";

// Circuit breaker constants
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000; // 60 seconds

export class CircuitOpenError extends Error {
    constructor() {
        super("Circuit breaker open — remote API temporarily unavailable, falling back to local");
        this.name = "CircuitOpenError";
    }
}

/**
 * Accessors instead of captured values: apiUrl/apiSecret live on the
 * ContextManager and orgId/projectName change on switch_project, so the
 * client must always read the CURRENT value at call time.
 */
export interface CoordinationClientConfig {
    getApiUrl(): string | undefined;
    getApiSecret(): string | undefined;
    getOrgId(): string | undefined;
    getProjectName(): string;
}

/**
 * HTTP client for the hosted coordination API (jobs, locks, sessions,
 * lock-events, agents, usage). Owns retry with exponential backoff and a
 * circuit breaker: 5 consecutive 5xx/network failures open the circuit for
 * 60s, during which calls fail fast with CircuitOpenError so callers drop
 * to their local fallbacks instead of stacking 10s timeouts.
 *
 * Extracted verbatim from NerveCenter.callCoordination (audit #3).
 */
export class CoordinationClient {
    private failures = 0;
    private openUntil = 0;

    constructor(private config: CoordinationClientConfig) {}

    /** Whether a remote API is configured at all. */
    get enabled(): boolean {
        return !!this.config.getApiUrl();
    }

    async call(endpoint: string, method: string = "GET", body?: Record<string, unknown>): Promise<unknown> {
        const apiUrl = this.config.getApiUrl();
        const apiSecret = this.config.getApiSecret();
        const orgId = this.config.getOrgId();
        const projectName = this.config.getProjectName();

        logger.info(`[callCoordination] Starting - endpoint: ${endpoint}, method: ${method}`);
        logger.info(`[callCoordination] apiUrl: ${apiUrl}, apiSecret: ${apiSecret ? 'SET (' + apiSecret.substring(0, 10) + '...)' : 'NOT SET'}`);

        if (!apiUrl) {
            logger.error("[callCoordination] Remote API not configured - apiUrl is:", apiUrl);
            throw new Error("Remote API not configured");
        }

        // Circuit breaker: if open, fail fast
        if (this.failures >= CIRCUIT_FAILURE_THRESHOLD && Date.now() < this.openUntil) {
            logger.warn(`[callCoordination] Circuit breaker OPEN — skipping remote call (resets at ${new Date(this.openUntil).toISOString()})`);
            throw new CircuitOpenError();
        }

        // If cooldown expired, allow a probe attempt (half-open)
        if (this.failures >= CIRCUIT_FAILURE_THRESHOLD && Date.now() >= this.openUntil) {
            logger.info("[callCoordination] Circuit breaker half-open — allowing probe request");
        }

        const url = apiUrl.endsWith("/v1")
            ? `${apiUrl}/${endpoint}`
            : `${apiUrl}/v1/${endpoint}`;

        logger.info(`[callCoordination] Full URL: ${method} ${url}`);
        logger.info(`[callCoordination] Request body: ${body ? JSON.stringify({
            keys: Object.keys(body),
            projectName,
            transcriptEvents: Array.isArray((body as { transcript?: unknown[] }).transcript)
                ? (body as { transcript: unknown[] }).transcript.length
                : 0,
        }) : 'none'}`);

        const maxRetries = 3;
        const baseDelay = 1000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);

            try {
                const response = await fetch(url, {
                    method,
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${apiSecret || ""}`,
                        // Pin coordination to the configured org so teammates
                        // resolve the same board (absent → personal org).
                        ...(orgId ? { "X-Axis-Org": orgId } : {})
                    },
                    body: body ? JSON.stringify({ ...body, projectName }) : undefined,
                    signal: controller.signal,
                });
                clearTimeout(timeout);

                logger.info(`[callCoordination] Response status: ${response.status} ${response.statusText}`);

                if (!response.ok) {
                    const text = await response.text();
                    logger.error(`[callCoordination] API Error Response (${response.status}): ${text}`);

                    // 4xx errors: do NOT retry, do NOT trip circuit
                    if (response.status >= 400 && response.status < 500) {
                        if (response.status === 401) {
                            throw new Error(`Authentication failed (401): ${text}. Check if API key is valid and exists in api_keys table.`);
                        }
                        throw new Error(`API Error (${response.status}): ${text}`);
                    }

                    // 5xx: retry-eligible, trip circuit
                    if (attempt < maxRetries) {
                        const delay = baseDelay * Math.pow(2, attempt - 1);
                        logger.warn(`[callCoordination] 5xx error, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
                        await new Promise(r => setTimeout(r, delay));
                        continue;
                    }

                    // Final attempt failed with 5xx
                    this.recordFailure();
                    throw new Error(`Server error (${response.status}): ${text}. Check Vercel logs for details.`);
                }

                // Success — reset circuit breaker
                if (this.failures > 0) {
                    logger.info(`[callCoordination] Request succeeded, resetting circuit breaker (was at ${this.failures} failures)`);
                    this.failures = 0;
                    this.openUntil = 0;
                }

                const jsonResult = await response.json();
                logger.info(`[callCoordination] Success - Response: ${JSON.stringify(jsonResult).substring(0, 200)}...`);
                return jsonResult;
            } catch (e: unknown) {
                clearTimeout(timeout);
                const err = e as Error;

                // Re-throw CircuitOpenError and 4xx errors without retry
                if (err instanceof CircuitOpenError) throw err;
                if (err.message.includes("Authentication failed") || err.message.includes("API Error (4")) {
                    throw err;
                }

                // Network error or abort — retry-eligible
                if (attempt < maxRetries) {
                    const delay = baseDelay * Math.pow(2, attempt - 1);
                    logger.warn(`[callCoordination] Network/timeout error, retrying in ${delay}ms (attempt ${attempt}/${maxRetries}): ${err.message}`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }

                // Final attempt failed
                this.recordFailure();

                logger.error(`[callCoordination] Fetch failed after ${maxRetries} attempts: ${err.message}`, err);
                if (err.message.includes("401")) {
                    throw new Error(`API Authentication Error: ${err.message}. Verify AXIS_API_KEY in MCP config matches a key in the api_keys table.`);
                }
                throw err;
            }
        }

        // Should not be reached, but satisfy TypeScript
        throw new Error("callCoordination: unexpected end of retry loop");
    }

    private recordFailure(): void {
        this.failures++;
        if (this.failures >= CIRCUIT_FAILURE_THRESHOLD) {
            this.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
            logger.error(`[callCoordination] Circuit breaker OPENED after ${this.failures} consecutive failures`);
        }
    }
}
