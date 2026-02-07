
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { logUsage } from "@/lib/usage";
import { getOrCreateProjectId } from "@/lib/project-utils";

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { items, projectName } = await req.json();

    if (!items || !Array.isArray(items)) {
        return NextResponse.json({ error: "Items array is required" }, { status: 400 });
    }

    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });

    try {
        const effectiveProjectName = projectName || "default";

        // 1. Resolve Project - auto-creates if it doesn't exist
        const projectId = await getOrCreateProjectId(effectiveProjectName, session.sub!);

        // 2. Process Items
        // We'll process sequentially or strictly limited parallel to avoid rate limits
        const results = [];

        for (const item of items) {
            const { content, metadata } = item;
            if (!content) continue;

            // Check if exists/overwrite logic?
            // rag-engine.ts did: delete where metadata->filePath matches, then insert.
            // We should replicate that.
            const filePath = metadata?.filePath;

            if (filePath) {
                await supabase
                    .from("embeddings")
                    .delete()
                    .eq("project_id", projectId)
                    .contains("metadata", { filePath });
            }

            // Embed
            const embeddingResponse = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: content.substring(0, 8000),
            });
            const embedding = embeddingResponse.data[0].embedding;

            // Insert
            const { error: insertError } = await supabase
                .from("embeddings")
                .insert({
                    project_id: projectId,
                    content,
                    embedding,
                    metadata
                });

            if (insertError) {
                console.error("Insert error for", filePath, insertError);
                results.push({ filePath, status: "error", error: insertError.message });
            } else {
                results.push({ filePath, status: "indexed" });
            }
        }

        // Log usage
        await logUsage({
            userId: session.sub!,
            apiKeyId: session.role === 'api_key' ? session.keyId : undefined,
            endpoint: "/api/v1/embed",
            method: "POST",
            statusCode: 200,
            metadata: { project: effectiveProjectName, itemCount: items.length }
        });

        return NextResponse.json({ results });

    } catch (error: any) {
        console.error("Embed Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
