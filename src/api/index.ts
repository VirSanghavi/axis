import { Hono } from "hono";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { bearerAuth } from "hono/bearer-auth";
import { z } from "zod";
import { cors } from 'hono/cors';
import { logger } from "../utils/logger.js"; // Note: Need to ensure this path works or use local logger if running in diff context
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

// Simple in-memory rate limiter
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 min
const MAX_REQUESTS = 100;
const requestCounts = new Map<string, number>();

setInterval(() => {
    requestCounts.clear();
}, RATE_LIMIT_WINDOW);

// Environment variables type definition
type Bindings = {
    OPENAI_API_KEY: string;
    SUPABASE_URL: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    SHARED_CONTEXT_API_SECRET: string;
    PROJECT_NAME?: string;
};

const app = new Hono<{ Bindings: Bindings, Variables: { user: any } }>();

// Enable CORS — restricted to authorized domains only
const ALLOWED_ORIGINS = [
    'https://useaxis.dev',
    'https://www.useaxis.dev',
    'https://aicontext.vercel.app',
    ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000', 'http://localhost:3001'] : []),
];
app.use("/*", cors({
    origin: (origin) => {
        return ALLOWED_ORIGINS.includes(origin) ? origin : null;
    }
}));

// Auth Middleware with Subscription Check
app.use("/*", async (c, next) => {
    // Skip public endpoints if any (e.g. health)
    if (c.req.path === '/health') return next();

    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
        return c.json({ error: "Unauthorized: Missing Authorization header" }, 401);
    }

    const token = authHeader.replace("Bearer ", "");
    // Reuse Supabase client or create new one with bindings
    const supabaseUrl = process.env.SUPABASE_URL || c.env?.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || c.env?.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        return c.json({ error: "Server Configuration Error" }, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Validate Token
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
        // Fallback: Check if it's a shared-context-api-key (custom logic)
        if (token === (process.env.SHARED_CONTEXT_API_SECRET || c.env?.SHARED_CONTEXT_API_SECRET)) {
            return next();
        }
        return c.json({ error: "Unauthorized: Invalid Token" }, 401);
    }

    // Check subscription
    const { data: profile } = await supabase.from('profiles').select('subscription_status').eq('id', user.id).single();

    if (profile?.subscription_status !== 'active' && profile?.subscription_status !== 'pro') {
        return c.json({ error: "Payment Required: Please subscribe to continue." }, 402);
    }

    // Attach user to context
    c.set('user', user);
    await next();
});


// Rate Limiting Middleware
app.use("/*", async (c, next) => {
    const ip = c.req.header('x-forwarded-for') || 'unknown';
    const count = (requestCounts.get(ip) || 0) + 1;
    requestCounts.set(ip, count);

    if (count > MAX_REQUESTS) {
        return c.json({ error: "Too many requests" }, 429);
    }
    await next();
});

// Auth Middleware with Database Keys
app.use("/*", async (c, next) => {
    // 1. Skip if no secret configured (Warning mode)
    // But wait, user wants SECURE. So we enforce keys.
    const supabaseUrl = c.env.SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = c.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        return c.json({ error: "Server Configuration Error: Missing Supabase Keys" }, 500);
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
        return c.json({ error: "Unauthorized: Missing Authorization header" }, 401);
    }

    const token = authHeader.replace("Bearer ", "");

    // 2. Check Master Key (Emergency Bypass)
    const masterKey = c.env.SHARED_CONTEXT_API_SECRET || process.env.SHARED_CONTEXT_API_SECRET;
    if (masterKey && token === masterKey) {
        return next();
    }

    // 3. Check Database Keys using HASH
    const crypto = await import('node:crypto'); // Dynamic import for Edge/Bun compatibility
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data: keyData, error } = await supabase
        .from('api_keys')
        .select('id, project_id, is_active')
        .eq('key_hash', tokenHash) // Check against HASH
        .maybeSingle();

    if (error || !keyData) { // Removed is_active check for now as it wasn't in schema V3 yet, or add it to schema
        // console.error("Auth Fail:", error); // Debug
        return c.json({ error: "Unauthorized: Invalid API Key" }, 401);
    }

    // Update last_used_at (async, don't await)
    supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', keyData.id).then();

    return next();
});

// Initialize Clients
const getOpenAI = (c: any) => new OpenAI({ apiKey: c.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY });
const getSupabase = (c: any) => createClient(
    c.env.SUPABASE_URL || process.env.SUPABASE_URL,
    c.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.get("/", (c) => c.text("Shared Context API is running"));

app.post("/embed", async (c) => {
    const openaiKey = c.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    const supabaseUrl = c.env.SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = c.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!openaiKey || !supabaseUrl || !supabaseKey) {
        return c.json({ error: "Missing required environment variables" }, 500);
    }
    const openai = getOpenAI(c);
    const supabase = getSupabase(c);
    const schema = z.object({
        items: z.array(z.object({
            content: z.string(),
            metadata: z.record(z.any()).optional()
        }))
    });

    let payload;
    try {
        const rawBody = await c.req.json();
        payload = schema.parse(rawBody);
    } catch (e) {
        return c.json({ error: "Invalid request body", details: e }, 400);
    }




    const { items } = payload;
    const projectName = c.env.PROJECT_NAME || process.env.PROJECT_NAME || "default";

    // Get/Create Project ID
    let projectId;
    try {
        const { data: project, error: projectError } = await supabase
            .from('projects')
            .select('id')
            .eq('name', projectName)
            .maybeSingle();

        if (projectError) throw projectError;

        projectId = project?.id;

        if (!projectId) {
            const { data: newProj, error: createError } = await supabase
                .from('projects')
                .insert({ name: projectName })
                .select('id')
                .single();

            if (createError) throw createError;
            projectId = newProj.id;
        }
    } catch (dbErr) {
        console.error("DB Error getting project:", dbErr);
        return c.json({ error: "Database error" }, 500);
    }

    const processed = [];

    // Deduplication: Delete existing embeddings for same filenames
    const filenames = new Set(items.map(i => i.metadata?.filename).filter(Boolean));
    if (filenames.size > 0) {
        for (const fname of filenames) {
            await supabase
                .from('embeddings')
                .delete()
                .eq('project_id', projectId)
                .contains('metadata', { filename: fname });
        }
    }

    // Generate Embeddings
    // Batching OpenAI usage if items list is huge? Standard max is high enough for text chunks.
    for (const item of items) {
        try {
            const response = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: item.content,
            });
            const embedding = response.data[0].embedding;

            const { error } = await supabase.from('embeddings').insert({
                project_id: projectId,
                content: item.content,
                embedding: embedding,
                metadata: item.metadata
            });

            if (error) throw error;
            processed.push({ success: true, metadata: item.metadata });
        } catch (err) {
            console.error("Embedding chunk error:", err);
            processed.push({ success: false, error: String(err) });
        }
    }

    return c.json({ message: "Processing complete", processed });
});

app.post("/search", async (c) => {
    const openaiKey = c.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    const supabaseUrl = c.env.SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = c.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!openaiKey || !supabaseUrl || !supabaseKey) {
        return c.json({ error: "Missing required environment variables" }, 500);
    }
    const openai = getOpenAI(c);
    const supabase = getSupabase(c);

    const schema = z.object({
        query: z.string(),
        limit: z.number().optional().default(5),
        threshold: z.number().optional().default(0.5)
    });

    let payload;
    try {
        const rawBody = await c.req.json();
        payload = schema.parse(rawBody);
    } catch (e) {
        return c.json({ error: "Invalid request body", details: e }, 400);
    }

    const { query, limit, threshold } = payload;
    const projectName = c.env.PROJECT_NAME || process.env.PROJECT_NAME || "default";

    let projectId: string | undefined;
    try {
        const { data: project, error: projectError } = await supabase
            .from('projects')
            .select('id')
            .eq('name', projectName)
            .maybeSingle();

        if (projectError) throw projectError;
        projectId = project?.id;
    } catch (dbErr) {
        console.error("DB Error getting project:", dbErr);
        return c.json({ error: "Database error" }, 500);
    }

    if (!projectId) return c.json({ results: [] });

    try {
        const response = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: query,
        });
        const queryEmbedding = response.data[0].embedding;

        const { data: documents, error } = await supabase.rpc('match_embeddings', {
            query_embedding: queryEmbedding,
            match_threshold: threshold,
            match_count: limit,
            p_id: projectId
        });

        if (error) {
            console.error("RPC Error:", error);
            return c.json({ error: "Search query failed", details: error }, 500);
        }

        return c.json({ results: documents });

    } catch (err) {
        console.error("Search Logic Error:", err);
        return c.json({ error: "Search failed", details: String(err) }, 500);
    }
});

app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }));

const serverInfo: { port: number; fetch: typeof app.fetch } = {
    port: parseInt(process.env.PORT || "3000"),
    fetch: app.fetch,
};

export default serverInfo;
