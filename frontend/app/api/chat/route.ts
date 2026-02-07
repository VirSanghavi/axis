import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { logUsage } from "@/lib/usage";
import { getSessionFromRequest } from "@/lib/auth";

// Use standard rate limiter
const LIMIT = 10;
const WINDOW_MS = 60 * 1000; // 1 minute

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    // 0. Rate Limiting
    const ip = getClientIp(req.headers);
    const { allowed, remaining, reset } = await rateLimit(`chat:${ip}`, LIMIT, WINDOW_MS);

    if (!allowed) {
        return NextResponse.json({
            error: "rate limit exceeded: max 10 requests per minute. please slow down and come back in a little bit :)"
        }, {
            status: 429, headers: {
                "x-rate-limit-remaining": String(remaining),
                "x-rate-limit-reset": String(reset)
            }
        });
    }

    const session = await getSessionFromRequest(req);

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!supabaseUrl || !supabaseKey || !openaiKey) {
        return NextResponse.json({
            error: "axis connection error: environment variables are not configured correctly."
        }, { status: 500 });
    }

    const openai = new OpenAI({
        apiKey: openaiKey,
    });

    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        const body = (await req.json()) as { query?: string };
        let { query } = body;

        if (!query || typeof query !== 'string') {
            return NextResponse.json({ error: "Invalid query" }, { status: 400 });
        }

        query = query.trim().slice(0, 500);

        let contextContent = "";

        // 1. Try Vector Search
        try {
            const embeddingResponse = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: query,
            });
            const embedding = embeddingResponse.data[0].embedding;

            const { data: chunks } = await supabase.rpc('match_embeddings', {
                query_embedding: embedding,
                match_threshold: 0.5,
                match_count: 5,
                p_project_id: null
            });

            if (chunks && Array.isArray(chunks) && chunks.length > 0) {
                contextContent = "--- HISTORICAL CONTEXT & SESSIONS ---\n" +
                    (chunks as Array<{ content: string; metadata: Record<string, unknown> }>).map((c) => `[Content]: ${c.content}\n[Metadata]: ${JSON.stringify(c.metadata)}`).join('\n---\n');
            }
        } catch (e) {
            console.warn("Vector search failed, falling back to basic response", e);
        }

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `you are axis, the intelligence layer for context governance. your aesthetic is premium, technical, and high-fidelity.

--- BASE KNOWLEDGE ---
- CORE PURPOSE: axis mirrors project structures and streams high-fidelity context directly into agent prompts to eliminate hallucinations.
- INSTALLATION: use 'npx @virsanghavi/axis-init@latest' to map a workspace.
- MCP INTEGRATION: agents connect via '@virsanghavi/axis-server'. setup involves setting 'AXIS_API_KEY' and running 'axis-server'.
- MCP CONFIG (JSON): command: "npx", args: ["-y", "@virsanghavi/axis-server"], env: {"AXIS_API_KEY": "..."}.
- PRICING: $5/month (Tier Pro). includes live streaming, unlimited MCP connectors, priority recall, and audit trails.
- FEATURES: context mirroring (not just RAG), file locking (concurrency), job board (orchestration), and session synchronization.
- SDK: 'pip install virsanghavi-axis' for python programmatic access.
---

YOU MUST:
1. answer based on provided context if relevant.
2. if context is missing, use your base knowledge about axis to provide a smart, helpful response.
3. maintain a professional, technical, and slightly "machine-mode" aesthetic.
4. use markdown formatting (bolding, code blocks) for clarity.

CURRENT CONTEXT:
${contextContent}`
                },
                {
                    role: "user",
                    content: query
                }
            ],
            temperature: 0,
        });

        const answer = response.choices[0].message.content;

        if (session) {
            logUsage({
                userId: session.sub!,
                apiKeyId: session.role === 'api_key' ? session.keyId : undefined,
                endpoint: "/api/chat",
                method: "POST",
                statusCode: 200,
                responseTimeMs: Date.now() - startTime,
                tokensUsed: response.usage?.total_tokens || 0
            });
        }

        return NextResponse.json({ answer });
    } catch (error: unknown) {
        console.error("DEBUG: Chat Error:", error);
        const errorMessage = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
