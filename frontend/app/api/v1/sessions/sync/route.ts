import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { logUsage } from "@/lib/usage";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

const WINDOW_MS = 60 * 1000;
const LIMIT = 50; // Increased limit for syncs

export async function GET(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const projectName = searchParams.get("projectName") || "default";

    try {
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL || "",
            process.env.SUPABASE_SERVICE_ROLE_KEY || ""
        );

        const { data: project, error } = await supabase
            .from("projects")
            .select("live_notepad")
            .eq("name", projectName)
            .eq("owner_id", session.sub)
            .maybeSingle();

        if (error) throw error;

        return NextResponse.json({ liveNotepad: project?.live_notepad || "" });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    const session = await getSessionFromRequest(req);

    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const ip = getClientIp(req.headers);
    const { allowed } = await rateLimit(`session_sync:${ip}`, LIMIT, WINDOW_MS);
    if (!allowed) {
        return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    try {
        const body = await req.json();
        const { title, context, projectId, metadata } = body;

        if (!title || !context) {
            return NextResponse.json({ error: "Title and context are required" }, { status: 400 });
        }

        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL || "",
            process.env.SUPABASE_SERVICE_ROLE_KEY || ""
        );

        const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });

        // 1. Create or Update Session Record
        const { data: sessionRecord, error: sessionError } = await supabase
            .from("sessions")
            .insert({
                project_id: projectId,
                user_id: session.sub,
                title,
                summary: context.slice(0, 500) + "...", // Auto-summary
                metadata: metadata || {},
                completed_at: new Date().toISOString()
            })
            .select()
            .single();

        if (sessionError) throw sessionError;

        // 2. Generate Embedding for the context
        const embeddingResponse = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: context.trim().slice(0, 8000), // OpenAI limit approx
        });
        const embedding = embeddingResponse.data[0].embedding;

        // 3. Store in Embeddings Table
        const { error: embedError } = await supabase.from("embeddings").insert({
            project_id: projectId,
            session_id: sessionRecord.id,
            content: context,
            embedding,
            metadata: { ...metadata, source: "session_sync" }
        });

        if (embedError) throw embedError;

        // 4. Log Usage
        logUsage({
            userId: session.sub!,
            apiKeyId: session.role === 'api_key' ? session.keyId : undefined,
            endpoint: "/api/v1/sessions/sync",
            method: "POST",
            statusCode: 200,
            responseTimeMs: Date.now() - startTime,
            tokensUsed: embeddingResponse.usage.total_tokens
        });

        return NextResponse.json({
            success: true,
            sessionId: sessionRecord.id,
            message: "Context synced and indexed for RAG"
        });

    } catch (error: unknown) {
        console.error("Session Sync Error:", error);
        const errorMessage = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
