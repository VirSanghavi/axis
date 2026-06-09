import fs from "fs/promises";
import path from "path";
import os from "os";

export type TranscriptEventKind = "message" | "tool_call" | "tool_result" | "system";
export type TranscriptEventRole = "user" | "assistant" | "system" | "tool";

export interface TranscriptEvent {
    id: string;
    kind: TranscriptEventKind;
    role: TranscriptEventRole;
    timestamp?: string;
    agent?: string;
    provider?: string;
    content?: string;
    toolName?: string;
    toolCallId?: string;
    arguments?: unknown;
    output?: unknown;
    isError?: boolean;
    durationMs?: number;
}

export interface CollectedTranscript {
    events: TranscriptEvent[];
    metadata: {
        source: "codex" | "claude" | "unknown";
        provider: "openai" | "anthropic" | null;
        agent: "codex" | "claude-code" | null;
        thread_id: string | null;
        transcript_path: string | null;
    };
}

const MAX_EVENTS = 2_000;
const MAX_EVENT_CHARS = 150_000;
const MAX_TOTAL_CHARS = 3_000_000;

function textContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .filter((item) => item.type === "input_text" || item.type === "output_text" || item.type === "text")
        .map((item) => typeof item.text === "string" ? item.text : "")
        .filter(Boolean)
        .join("\n");
}

function parseJson(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function isErrorOutput(output: unknown): boolean {
    const text = typeof output === "string" ? output : JSON.stringify(output);
    return /tool call error|process exited with code [1-9]|"is_error"\s*:\s*true|error:/i.test(text || "");
}

function limitString(value: string): string {
    if (/encrypted_content|base_instructions/i.test(value)) {
        return "[Axis redacted a tool output containing raw hidden agent instructions or reasoning.]";
    }
    if (value.length <= MAX_EVENT_CHARS) return value;
    return `${value.slice(0, MAX_EVENT_CHARS)}\n... truncated by Axis`;
}

function limitValue(value: unknown): unknown {
    if (typeof value === "string") return limitString(value);
    try {
        const serialized = JSON.stringify(value);
        const limited = limitString(serialized);
        return limited === serialized ? value : limited;
    } catch {
        return limitString(String(value));
    }
}

function compactEvents(events: TranscriptEvent[]): TranscriptEvent[] {
    const seen = new Set<string>();
    const compacted: TranscriptEvent[] = [];
    let totalChars = 0;

    for (const event of events) {
        if (compacted.length >= MAX_EVENTS) break;
        const normalized = {
            ...event,
            content: event.content ? limitString(event.content) : undefined,
            arguments: event.arguments === undefined ? undefined : limitValue(event.arguments),
            output: event.output === undefined ? undefined : limitValue(event.output),
        };
        const signature = JSON.stringify([
            normalized.kind,
            normalized.role,
            normalized.timestamp,
            normalized.toolCallId,
            normalized.toolName,
            normalized.content,
            normalized.arguments,
            normalized.output,
        ]);
        if (seen.has(signature)) continue;
        if (totalChars + signature.length > MAX_TOTAL_CHARS) break;
        seen.add(signature);
        totalChars += signature.length;
        compacted.push(normalized);
    }

    return compacted;
}

export function parseCodexTranscript(raw: string): TranscriptEvent[] {
    const events: TranscriptEvent[] = [];
    const toolNames = new Map<string, string>();

    for (const [index, line] of raw.split("\n").entries()) {
        if (!line.trim()) continue;
        let record: Record<string, any>;
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }
        if (record.type !== "response_item" || !record.payload) continue;
        const payload = record.payload;
        const base = {
            timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
            agent: "codex",
            provider: "openai",
        };

        if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
            const content = textContent(payload.content);
            if (!content || (payload.role === "user" && /^<(environment_context|turn_aborted)>/.test(content.trim()))) continue;
            events.push({
                id: `codex-message-${index}`,
                kind: "message",
                role: payload.role,
                content,
                ...base,
            });
        } else if (payload.type === "function_call") {
            const callId = String(payload.call_id || `call-${index}`);
            const toolName = [payload.namespace, payload.name].filter(Boolean).join(".") || "tool";
            toolNames.set(callId, toolName);
            events.push({
                id: `codex-call-${callId}`,
                kind: "tool_call",
                role: "assistant",
                toolName,
                toolCallId: callId,
                arguments: parseJson(payload.arguments),
                ...base,
            });
        } else if (payload.type === "function_call_output") {
            const callId = String(payload.call_id || `call-${index}`);
            const output = payload.output;
            events.push({
                id: `codex-result-${callId}`,
                kind: "tool_result",
                role: "tool",
                toolName: toolNames.get(callId) || "tool",
                toolCallId: callId,
                output,
                isError: isErrorOutput(output),
                ...base,
            });
        }
    }

    return compactEvents(events);
}

export function parseClaudeTranscript(raw: string): TranscriptEvent[] {
    const events: TranscriptEvent[] = [];
    const toolNames = new Map<string, string>();

    for (const [index, line] of raw.split("\n").entries()) {
        if (!line.trim()) continue;
        let record: Record<string, any>;
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }
        if (record.type !== "user" && record.type !== "assistant") continue;
        const message = record.message;
        if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
        const content = message.content;
        const base = {
            timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
            agent: "claude-code",
            provider: "anthropic",
        };

        if (typeof content === "string") {
            if (content) {
                events.push({
                    id: `claude-message-${index}`,
                    kind: "message",
                    role: message.role,
                    content,
                    ...base,
                });
            }
            continue;
        }
        if (!Array.isArray(content)) continue;

        const text = textContent(content);
        if (text) {
            events.push({
                id: `claude-message-${index}`,
                kind: "message",
                role: message.role,
                content: text,
                ...base,
            });
        }

        for (const [contentIndex, item] of content.entries()) {
            if (!item || typeof item !== "object") continue;
            if (item.type === "tool_use") {
                const callId = String(item.id || `call-${index}-${contentIndex}`);
                const toolName = String(item.name || "tool");
                toolNames.set(callId, toolName);
                events.push({
                    id: `claude-call-${callId}`,
                    kind: "tool_call",
                    role: "assistant",
                    toolName,
                    toolCallId: callId,
                    arguments: item.input,
                    ...base,
                });
            } else if (item.type === "tool_result") {
                const callId = String(item.tool_use_id || `call-${index}-${contentIndex}`);
                const output = textContent(item.content) || item.content;
                events.push({
                    id: `claude-result-${callId}`,
                    kind: "tool_result",
                    role: "tool",
                    toolName: toolNames.get(callId) || "tool",
                    toolCallId: callId,
                    output,
                    isError: item.is_error === true || isErrorOutput(output),
                    ...base,
                });
            }
        }
    }

    return compactEvents(events);
}

async function findFile(root: string, filename: string): Promise<string | null> {
    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
        return null;
    }
    for (const entry of entries) {
        const candidate = path.join(root, entry.name);
        if (entry.isFile() && entry.name === filename) return candidate;
        if (entry.isDirectory()) {
            const nested = await findFile(candidate, filename);
            if (nested) return nested;
        }
    }
    return null;
}

async function resolveTranscriptPath(env: NodeJS.ProcessEnv, homeDir: string): Promise<{
    path: string | null;
    source: "codex" | "claude" | "unknown";
    threadId: string | null;
}> {
    if (env.AXIS_TRANSCRIPT_PATH) {
        const source = env.CODEX_THREAD_ID ? "codex" : env.CLAUDE_SESSION_ID ? "claude" : "unknown";
        return { path: env.AXIS_TRANSCRIPT_PATH, source, threadId: env.CODEX_THREAD_ID || env.CLAUDE_SESSION_ID || null };
    }
    if (env.CODEX_THREAD_ID) {
        const filenameSuffix = `${env.CODEX_THREAD_ID}.jsonl`;
        const sessionsRoot = path.join(homeDir, ".codex", "sessions");
        const match = await findFile(sessionsRoot, filenameSuffix);
        if (match) return { path: match, source: "codex", threadId: env.CODEX_THREAD_ID };
        const entries = await collectFiles(sessionsRoot);
        const rollout = entries.find((entry) => entry.endsWith(filenameSuffix));
        if (rollout) return { path: rollout, source: "codex", threadId: env.CODEX_THREAD_ID };
    }
    if (env.CODEX_TUI_SESSION_LOG_PATH) {
        return { path: env.CODEX_TUI_SESSION_LOG_PATH, source: "codex", threadId: env.CODEX_THREAD_ID || null };
    }
    const claudeSessionId = env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID;
    if (claudeSessionId) {
        const match = await findFile(path.join(homeDir, ".claude", "projects"), `${claudeSessionId}.jsonl`);
        if (match) return { path: match, source: "claude", threadId: claudeSessionId };
    }
    return { path: null, source: "unknown", threadId: null };
}

async function collectFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
        return files;
    }
    for (const entry of entries) {
        const candidate = path.join(root, entry.name);
        if (entry.isDirectory()) files.push(...await collectFiles(candidate));
        else files.push(candidate);
    }
    return files;
}

export async function collectSessionTranscript(
    env: NodeJS.ProcessEnv = process.env,
    homeDir = os.homedir()
): Promise<CollectedTranscript> {
    const resolved = await resolveTranscriptPath(env, homeDir);
    if (!resolved.path) {
        return {
            events: [],
            metadata: {
                source: "unknown",
                provider: null,
                agent: null,
                thread_id: resolved.threadId,
                transcript_path: null,
            },
        };
    }

    try {
        const raw = await fs.readFile(resolved.path, "utf8");
        const source = resolved.source === "unknown"
            ? raw.includes("\"originator\":\"codex") ? "codex" : "claude"
            : resolved.source;
        return {
            events: source === "codex" ? parseCodexTranscript(raw) : parseClaudeTranscript(raw),
            metadata: {
                source,
                provider: source === "codex" ? "openai" : "anthropic",
                agent: source === "codex" ? "codex" : "claude-code",
                thread_id: resolved.threadId,
                transcript_path: resolved.path,
            },
        };
    } catch {
        return {
            events: [],
            metadata: {
                source: resolved.source,
                provider: resolved.source === "codex" ? "openai" : resolved.source === "claude" ? "anthropic" : null,
                agent: resolved.source === "codex" ? "codex" : resolved.source === "claude" ? "claude-code" : null,
                thread_id: resolved.threadId,
                transcript_path: resolved.path,
            },
        };
    }
}

export function transcriptTitle(events: TranscriptEvent[], fallback: string): string {
    const firstUserMessage = events.find((event) => event.kind === "message" && event.role === "user")?.content;
    if (!firstUserMessage) return fallback;
    const firstLine = firstUserMessage.replace(/\s+/g, " ").trim();
    return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}
