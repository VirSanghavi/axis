import fs from "fs/promises";
import path from "path";
import { Mutex } from "async-mutex";

const INSTRUCTIONS_DIR = path.resolve(process.cwd(), "agent-instructions");

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
        const resolved = path.resolve(INSTRUCTIONS_DIR, filename);
        if (!resolved.startsWith(INSTRUCTIONS_DIR + path.sep)) {
            throw new Error("Invalid file path");
        }
        return resolved;
    }

    async listFiles() {
        try {
            const files = await fs.readdir(INSTRUCTIONS_DIR);
            return files
                .filter(f => f.endsWith('.md'))
                .map(f => ({
                    uri: `context://local/${f}`,
                    name: f,
                    mimeType: "text/markdown",
                    description: `Shared context file: ${f}`
                }));
        } catch (error) {
            console.error("Error listing resources:", error);
            return [];
        }
    }

    async readFile(filename: string) {
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

    async searchContext(query: string) {
        if (!this.apiUrl) {
             throw new Error("SHARED_CONTEXT_API_URL not configured.");
        }

        const response = await fetch(`${this.apiUrl}/search`, {
             method: "POST",
             headers: {
                 "Content-Type": "application/json",
                 "Authorization": `Bearer ${this.apiSecret || ""}`
             },
             body: JSON.stringify({ query })
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

    async embedContent(items: { content: string, metadata: any }[]) {
        if (!this.apiUrl) {
             console.warn("Skipping RAG embedding: SHARED_CONTEXT_API_URL not configured.");
             return;
        }

        const response = await fetch(`${this.apiUrl}/embed`, {
             method: "POST",
             headers: {
                 "Content-Type": "application/json",
                 "Authorization": `Bearer ${this.apiSecret || ""}`
             },
             body: JSON.stringify({ items })
         });
         
         if (!response.ok) {
              const text = await response.text();
              throw new Error(`API Error ${response.status}: ${text}`);
         }
         
         return await response.json();
    }
}
