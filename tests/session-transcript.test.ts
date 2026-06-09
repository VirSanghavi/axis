import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { NerveCenter } from "../src/local/nerve-center.js";
import {
    mergeTranscriptEvents,
    parseClaudeTranscript,
    parseCodexTranscript,
    parseGenericTranscript,
    transcriptTitle,
} from "../src/local/session-transcript.js";

describe("session transcript parsing", () => {
    test("normalizes Codex messages and tool calls without hidden reasoning", () => {
        const raw = [
            JSON.stringify({ timestamp: "2026-06-08T00:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Build the page" }] } }),
            JSON.stringify({ timestamp: "2026-06-08T00:00:01Z", type: "response_item", payload: { type: "reasoning", encrypted_content: "secret" } }),
            JSON.stringify({ timestamp: "2026-06-08T00:00:02Z", type: "response_item", payload: { type: "function_call", namespace: "mcp__axis", name: "list_jobs", arguments: "{}", call_id: "call-1" } }),
            JSON.stringify({ timestamp: "2026-06-08T00:00:03Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "{\"jobs\":[]}" } }),
            JSON.stringify({ timestamp: "2026-06-08T00:00:03Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-raw", output: "{\"encrypted_content\":\"private chain\"}" } }),
            JSON.stringify({ timestamp: "2026-06-08T00:00:04Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } }),
        ].join("\n");

        const events = parseCodexTranscript(raw);
        expect(events).toHaveLength(5);
        expect(events[0]).toMatchObject({ kind: "message", role: "user", content: "Build the page" });
        expect(events[1]).toMatchObject({ kind: "tool_call", toolName: "mcp__axis.list_jobs", arguments: {} });
        expect(events[2]).toMatchObject({ kind: "tool_result", toolName: "mcp__axis.list_jobs", isError: false });
        expect(events[3]).toMatchObject({ kind: "tool_result", output: expect.stringContaining("redacted") });
        expect(events[4]).toMatchObject({ kind: "message", role: "assistant", content: "Done." });
        expect(JSON.stringify(events)).not.toContain("secret");
        expect(JSON.stringify(events)).not.toContain("private chain");
    });

    test("normalizes Claude text, tool use, and failed tool results", () => {
        const raw = [
            JSON.stringify({ type: "user", timestamp: "2026-06-08T00:00:00Z", message: { role: "user", content: "Fix auth" } }),
            JSON.stringify({ type: "assistant", timestamp: "2026-06-08T00:00:01Z", message: { role: "assistant", content: [
                { type: "thinking", thinking: "private" },
                { type: "text", text: "Checking." },
                { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "auth.ts" } },
            ] } }),
            JSON.stringify({ type: "user", timestamp: "2026-06-08T00:00:02Z", message: { role: "user", content: [
                { type: "tool_result", tool_use_id: "tool-1", content: "Error: missing", is_error: true },
            ] } }),
        ].join("\n");

        const events = parseClaudeTranscript(raw);
        expect(events).toHaveLength(4);
        expect(events[1]).toMatchObject({ kind: "message", role: "assistant", content: "Checking." });
        expect(events[2]).toMatchObject({ kind: "tool_call", toolName: "Read" });
        expect(events[3]).toMatchObject({ kind: "tool_result", toolName: "Read", isError: true });
        expect(JSON.stringify(events)).not.toContain("private");
    });

    test("uses the first user message as a concise session title", () => {
        const events = parseCodexTranscript(JSON.stringify({
            type: "response_item",
            payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a session details page" }] },
        }));
        expect(transcriptTitle(events, "fallback")).toBe("Add a session details page");
    });

    test("parses generic JSON and JSONL exports from arbitrary clients", () => {
        const events = parseGenericTranscript(JSON.stringify({
            messages: [
                { role: "user", content: "Ship it", client: "cursor" },
                {
                    role: "assistant",
                    content: "Working.",
                    tool_calls: [{ id: "c1", function: { name: "list_jobs", arguments: "{\"includeCompleted\":false}" } }],
                },
                { role: "tool", tool_call_id: "c1", name: "list_jobs", content: "{\"jobs\":[]}" },
            ],
        }));
        expect(events).toHaveLength(4);
        expect(events[0]).toMatchObject({ role: "user", content: "Ship it" });
        expect(events[2]).toMatchObject({ kind: "tool_call", toolName: "list_jobs" });
        expect(events[3]).toMatchObject({ kind: "tool_result", toolCallId: "c1" });
    });

    test("merges guaranteed MCP events without duplicating native tool calls", () => {
        const native = parseGenericTranscript(JSON.stringify([
            { role: "user", content: "Check jobs" },
            { type: "tool_call", name: "mcp__axis.list_jobs", call_id: "native-1", arguments: {} },
        ]));
        const protocol = parseGenericTranscript(JSON.stringify([
            { type: "tool_call", name: "list_jobs", call_id: "protocol-1", arguments: {} },
            { type: "tool_result", name: "list_jobs", call_id: "protocol-1", output: { jobs: [] } },
        ]));
        const merged = mergeTranscriptEvents(native, protocol);
        expect(merged.filter((event) => event.kind === "tool_call")).toHaveLength(1);
        expect(merged.filter((event) => event.kind === "tool_result")).toHaveLength(1);
    });

    test("archives MCP calls for an unknown client without a native transcript", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "axis-universal-transcript-"));
        const stateFile = path.join(root, "state.json");
        await writeFile(stateFile, JSON.stringify({ locks: {}, jobs: {}, liveNotepad: "Session Start\n" }));
        const envKeys = [
            "AXIS_TRANSCRIPT_PATH",
            "CODEX_THREAD_ID",
            "CODEX_TUI_SESSION_LOG_PATH",
            "CLAUDE_SESSION_ID",
            "CLAUDE_CODE_SESSION_ID",
        ];
        const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
        for (const key of envKeys) delete process.env[key];

        try {
            const nerveCenter = new NerveCenter({}, { projectRoot: root, stateFilePath: stateFile });
            await nerveCenter.init();
            const toolResult = await nerveCenter.captureToolExecution(
                "list_jobs",
                { includeCompleted: false },
                "unknown-mcp-client",
                async () => ({ content: [{ type: "text", text: "{\"jobs\":[]}" }] })
            );
            expect(toolResult).toBeDefined();
            const finalized = await nerveCenter.finalizeSession();
            expect(finalized).toMatchObject({
                transcriptEvents: 2,
                transcriptSource: "mcp",
            });
        } finally {
            for (const key of envKeys) {
                if (previous[key] === undefined) delete process.env[key];
                else process.env[key] = previous[key];
            }
            await rm(root, { recursive: true, force: true });
        }
    });
});
