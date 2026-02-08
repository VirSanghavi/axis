
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { logger } from "../utils/logger.js";

// Make sure process.env is available or pass in options
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

export class RagEngine {
    private supabase: SupabaseClient;
    private openai: OpenAI;
    private projectId?: string;

    constructor(supabaseUrl: string, supabaseKey: string, openaiKey: string, projectId?: string) {
        this.supabase = createClient(supabaseUrl, supabaseKey);
        this.openai = new OpenAI({ apiKey: openaiKey });
        this.projectId = projectId;
    }

    setProjectId(id: string) {
        this.projectId = id;
    }

    async indexContent(filePath: string, content: string): Promise<boolean> {
        if (!this.projectId) {
            logger.error("RAG: Project ID missing.");
            return false;
        }

        try {
            // 1. Embedding
            const resp = await this.openai.embeddings.create({
                model: "text-embedding-3-small",
                input: content.substring(0, 8000), // simplistic chunking
            });
            const embedding = resp.data[0].embedding;

            // 2. Clear old for this file
            await this.supabase
                .from("embeddings")
                .delete()
                .eq("project_id", this.projectId)
                .contains("metadata", { filePath });

            // 3. Insert new
            const { error } = await this.supabase
                .from("embeddings")
                .insert({
                    project_id: this.projectId,
                    content: content,
                    embedding,
                    metadata: { filePath }
                });

            if (error) {
                logger.error("RAG Insert Error:", error);
                return false;
            }
            logger.info(`Indexed ${filePath}`);
            return true;
        } catch (e) {
            logger.error("RAG Error:", e);
            return false;
        }
    }

    async search(query: string, limit = 5): Promise<string[]> {
        if (!this.projectId) return [];

        try {
            const resp = await this.openai.embeddings.create({
                model: "text-embedding-3-small",
                input: query,
            });
            const embedding = resp.data[0].embedding;

            const { data, error } = await this.supabase.rpc('match_embeddings', {
                query_embedding: embedding,
                match_threshold: 0.1,
                match_count: limit,
                p_project_id: this.projectId
            });

            if (error || !data) {
                logger.error("RAG Search DB Error:", error);
                return [];
            }

            return data.map((d: any) => d.content);
        } catch (e) {
            logger.error("RAG Search Fail:", e);
            return [];
        }
    }
}
