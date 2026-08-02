import { normalizeTranscriptEvents, TranscriptEvent } from "./session-transcript.js";

/**
 * In-memory buffer of MCP tool calls/results for the current session,
 * merged into the archived transcript at finalize_session.
 * Extracted verbatim from NerveCenter.captureToolExecution (audit #3).
 */
export class ProtocolTranscript {
    private events: TranscriptEvent[] = [];

    get snapshot(): TranscriptEvent[] {
        return this.events;
    }

    clear(): void {
        this.events = [];
    }

    async capture<T>(
        toolName: string,
        args: unknown,
        agent: string,
        execute: () => Promise<T>
    ): Promise<T> {
        const callId = `axis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const startedAt = Date.now();
        this.events = normalizeTranscriptEvents([
            ...this.events,
            {
                id: `${callId}-call`,
                kind: "tool_call",
                role: "assistant",
                timestamp: new Date(startedAt).toISOString(),
                agent,
                provider: "mcp",
                toolName,
                toolCallId: callId,
                arguments: args,
            },
        ]);

        try {
            const result = await execute();
            // finalize_session archives and clears the event buffer itself. Its
            // call is present in the archived session; its result belongs after it.
            if (toolName !== "finalize_session") {
                this.events = normalizeTranscriptEvents([
                    ...this.events,
                    {
                        id: `${callId}-result`,
                        kind: "tool_result",
                        role: "tool",
                        timestamp: new Date().toISOString(),
                        agent,
                        provider: "mcp",
                        toolName,
                        toolCallId: callId,
                        output: result,
                        isError: !!(result && typeof result === "object" && (result as Record<string, unknown>).isError),
                        durationMs: Date.now() - startedAt,
                    },
                ]);
            }
            return result;
        } catch (error) {
            if (toolName !== "finalize_session") {
                this.events = normalizeTranscriptEvents([
                    ...this.events,
                    {
                        id: `${callId}-error`,
                        kind: "tool_result",
                        role: "tool",
                        timestamp: new Date().toISOString(),
                        agent,
                        provider: "mcp",
                        toolName,
                        toolCallId: callId,
                        output: error instanceof Error ? error.message : String(error),
                        isError: true,
                        durationMs: Date.now() - startedAt,
                    },
                ]);
            }
            throw error;
        }
    }
}
