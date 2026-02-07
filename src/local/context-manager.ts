import fs from "fs/promises";
import path from "path";
import { Mutex } from "async-mutex";

import * as fsSync from "fs";

function getEffectiveInstructionsDir() {
    const cwd = process.cwd();
    const axisDir = path.resolve(cwd, ".axis");
    const instructionsDir = path.resolve(axisDir, "instructions");
    const legacyDir = path.resolve(cwd, "agent-instructions");

    // Prefer .axis/instructions if it exists, otherwise fallback
    try {
        if (fsSync.existsSync(instructionsDir)) {
            // console.error to stderr for MCP logging
            console.error(`[ContextManager] Using instructions dir: ${instructionsDir}`);
            return instructionsDir;
        }
    } catch { }

    console.error(`[ContextManager] Fallback to legacy dir: ${legacyDir}`);
    return legacyDir;
}

export class ContextManager {
    private mutex: Mutex;
    private apiUrl?: string;
    private apiSecret?: string;

    constructor(apiUrl?: string, apiSecret?: string) {
        this.mutex = new Mutex();
        this.apiUrl = apiUrl;
        this.apiSecret = apiSecret;
    }

    private resolveFilePath(filename: string) {
        if (!filename || filename.includes("\0")) {
            throw new Error("Invalid filename");
        }
        const resolved = path.resolve(getEffectiveInstructionsDir(), filename);
        // Security check: must be within the effective dir
        const effectiveDir = getEffectiveInstructionsDir();
        if (!resolved.startsWith(effectiveDir + path.sep)) {
            throw new Error("Invalid file path");
        }
        return resolved;
    }

    async listFiles() {
        try {
            const dir = getEffectiveInstructionsDir();
            // Ensure dir exists before reading, to avoid crashing if neither exists (though we rely on ensureFileSystem)
            try { await fs.access(dir); } catch { return []; }

            const files = await fs.readdir(dir);
            // also allow reading from a "docs" folder if it exists
            const docFiles = await this.listDocs();

            const instructionFiles = files
                .filter(f => f.endsWith('.md'))
                .map(f => ({
                    uri: `context://local/${f}`,
                    name: f,
                    mimeType: "text/markdown",
                    description: `Shared context file: ${f}`
                }));

            return [...instructionFiles, ...docFiles];
        } catch (error) {
            console.error("Error listing resources:", error);
            return [];
        }
    }

    async listDocs() {
        const docsDir = path.resolve(process.cwd(), "docs");
        try {
            await fs.access(docsDir);
            const files = await fs.readdir(docsDir);
            return files
                .filter(f => f.endsWith('.md'))
                .map(f => ({
                    uri: `context://docs/${f}`,
                    name: `Docs: ${f}`,
                    mimeType: "text/markdown",
                    description: `Documentation file: ${f}`
                }));
        } catch {
            return [];
        }
    }

    async readFile(filename: string) {
        // Check if it's a doc request
        if (filename.startsWith("docs/")) {
            const docName = filename.replace("docs/", "");
            const docPath = path.resolve(process.cwd(), "docs", docName);
            // Security check
            if (!docPath.startsWith(path.resolve(process.cwd(), "docs"))) {
                throw new Error("Invalid doc path");
            }
            return await fs.readFile(docPath, "utf-8");
        }

        const filePath = this.resolveFilePath(filename);
        // Read is safe to run concurrently, but we might want to ensure we don't read while writing
        // For max concurrency, we can let reads happen, but atomic writes are key.
        return await fs.readFile(filePath, "utf-8");
    }

    async updateFile(filename: string, content: string, append: boolean = false) {
        const filePath = this.resolveFilePath(filename);

        return await this.mutex.runExclusive(async () => {
            if (append) {
                // Read first to ensure newline if needed, or just append
                // fs.appendFile is mostly atomic, but this guarantees strict ordering
                // especially if we add logic later (like git commit, or broadcasting)
                await fs.appendFile(filePath, "\n" + content);
            } else {
                await fs.writeFile(filePath, content);
            }
            return `Updated ${filename}`;
        });
    }

    async searchContext(query: string, projectName: string = "default") {
        if (!this.apiUrl) {
            throw new Error("SHARED_CONTEXT_API_URL not configured.");
        }

        // Ensure we hit the correct endpoint version
        const endpoint = this.apiUrl.endsWith("/v1") ? `${this.apiUrl}/search` : `${this.apiUrl}/v1/search`;

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.apiSecret || ""}`
            },
            body: JSON.stringify({ query, projectName })
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`API Error ${response.status}: ${text}`);
        }

        const result = await response.json() as any;

        if (result.results && Array.isArray(result.results)) {
            return result.results.map((r: any) =>
                `[Similarity: ${(r.similarity * 100).toFixed(1)}%] ${r.content}`
            ).join("\n\n---\n\n") || "No results found.";
        }

        throw new Error("No results format recognized.");
    }

    async embedContent(items: { content: string, metadata: any }[], projectName: string = "default") {
        if (!this.apiUrl) {
            console.warn("Skipping RAG embedding: SHARED_CONTEXT_API_URL not configured.");
            return;
        }

        const endpoint = this.apiUrl.endsWith("/v1") ? `${this.apiUrl}/embed` : `${this.apiUrl}/v1/embed`;

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.apiSecret || ""}`
            },
            body: JSON.stringify({ items, projectName })
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`API Error ${response.status}: ${text}`);
        }

        return await response.json();
    }
}
