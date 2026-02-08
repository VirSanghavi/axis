
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { logUsage } from "@/lib/usage";
import { getOrCreateProjectId } from "@/lib/project-utils";

// Force dynamic to ensure we don't cache auth
export const dynamic = 'force-dynamic';
// Force Node runtime (Supabase service role doesn't work in Edge)
export const runtime = "nodejs";

// Create Supabase client inside function to avoid stale clients on Vercel cold starts
function getSupabase() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!url || !key) {
        console.error("[search] Missing Supabase env vars:", { hasUrl: !!url, hasKey: !!key });
        throw new Error("Supabase configuration missing");
    }
    
    return createClient(url, key);
}

export async function POST(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { query, projectName } = await req.json();

    if (!query) {
        return NextResponse.json({ error: "Query is required" }, { status: 400 });
    }

    const supabase = getSupabase();

    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });

    try {
        // Resolve Project ID - auto-creates if it doesn't exist
        const effectiveProjectName = projectName || "default";
        const projectId = await getOrCreateProjectId(effectiveProjectName, session.sub!);

        // Generate Embedding
        const embeddingResponse = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: query,
        });
        const embedding = embeddingResponse.data[0].embedding;

        // Search via RPC
        const { data: results, error: searchError } = await supabase.rpc('match_embeddings', {
            query_embedding: embedding,
            match_threshold: 0.5,
            match_count: 5,
            p_project_id: projectId
        });

        if (searchError) {
            console.error("Search RPC Error:", searchError);
            return NextResponse.json({ error: "Search failed" }, { status: 500 });
        }

        // Format results
        // match_embeddings returns { content, similarity, metadata }
        const formatted = results.map((r: any) => ({
            content: r.content,
            similarity: r.similarity,
            metadata: r.metadata
        }));

        // Log usage
        await logUsage({
            userId: session.sub!,
            apiKeyId: session.role === 'api_key' ? session.keyId : undefined,
            endpoint: "/api/v1/search",
            method: "POST",
            statusCode: 200,
            metadata: { query, project: effectiveProjectName, resultCount: results.length }
        });

        return NextResponse.json({ results: formatted });

    } catch (error: any) {
        console.error("Link Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
