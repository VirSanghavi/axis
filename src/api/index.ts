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

const app = new Hono<{ Bindings: Bindings }>();

// Enable CORS
const allowedOrigins = (process.env.CORS_ORIGIN || "*").split(",");
app.use("/*", cors({
    origin: (origin) => {
        if (allowedOrigins.includes("*")) return origin; // Allow all if * is present
        return allowedOrigins.includes(origin) ? origin : null;
    }
}));

// Logging Middleware
app.use("/*", async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    if (c.res.status >= 400) {
        logger.error(`[HTTP] ${c.req.method} ${c.req.path}`, { status: c.res.status, duration: ms });
    } else {
        logger.info(`[HTTP] ${c.req.method} ${c.req.path}`, { status: c.res.status, duration: ms });
    }
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

// Auth Middleware
app.use("/*", async (c, next) => {
  const secret = c.env.SHARED_CONTEXT_API_SECRET || process.env.SHARED_CONTEXT_API_SECRET;
  if (!secret) {
      console.warn("WARNING: SHARED_CONTEXT_API_SECRET is not set. API is unsecured.");
      return next();
  }
  
  const authMiddleware = bearerAuth({ token: secret });
  return authMiddleware(c, next);
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
