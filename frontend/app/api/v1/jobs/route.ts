import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";
import { logUsage } from "@/lib/usage";
import { getOrCreateProjectId } from "@/lib/project-utils";

// Force Node runtime (Supabase service role doesn't work in Edge)
export const runtime = "nodejs";

// Create Supabase client inside function to avoid stale clients on Vercel cold starts
function getSupabase() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!url || !key) {
        console.error("[jobs] Missing Supabase env vars:", { hasUrl: !!url, hasKey: !!key });
        throw new Error("Supabase configuration missing");
    }
    
    return createClient(url, key);
}

export async function GET(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const projectName = searchParams.get("projectName") || "default";

    try {
        const supabase = getSupabase();
        const projectId = await getOrCreateProjectId(projectName, session.sub!);

        const { data: jobs, error } = await supabase
            .from("jobs")
            .select("*")
            .eq("project_id", projectId)
            .order("created_at", { ascending: false });

        if (error) throw error;

        return NextResponse.json({ jobs: jobs || [] });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const supabase = getSupabase();
        const body = await req.json();
        const { projectName = "default", action, ...jobData } = body;
        const projectId = await getOrCreateProjectId(projectName, session.sub!);

        if (action === "post") {
            // --- Input validation ---
            if (!jobData.title || typeof jobData.title !== "string" || jobData.title.length > 500) {
                return NextResponse.json({ error: "title is required (max 500 chars)" }, { status: 400 });
            }
            if (jobData.description !== undefined && (typeof jobData.description !== "string" || jobData.description.length > 5000)) {
                return NextResponse.json({ error: "description must be a string (max 5000 chars)" }, { status: 400 });
            }
            const validPriorities = ["low", "medium", "high", "critical"];
            if (jobData.priority && !validPriorities.includes(jobData.priority)) {
                return NextResponse.json({ error: `priority must be one of: ${validPriorities.join(", ")}` }, { status: 400 });
            }

            const { data, error } = await supabase
                .from("jobs")
                .insert({
                    project_id: projectId,
                    title: jobData.title,
                    description: jobData.description || "",
                    priority: jobData.priority || "medium",
                    status: "todo",
                    dependencies: jobData.dependencies || []
                })
                .select()
                .single();
            if (error) throw error;
            return NextResponse.json(data);
        }

        if (action === "claim") {
            // Atomic job claiming using database function with FOR UPDATE SKIP LOCKED
            // This prevents two agents from claiming the same job simultaneously.
            const agentId = jobData.agentId || jobData.agent_id;
            if (!agentId) {
                return NextResponse.json({ error: "agentId is required for claim" }, { status: 400 });
            }

            const { data, error } = await supabase.rpc("claim_next_job", {
                p_project_id: projectId,
                p_agent_id: agentId,
            });

            if (error) throw error;

            // claim_next_job returns jsonb: { status: "CLAIMED", job: {...} } or { status: "NO_JOBS_AVAILABLE" }
            return NextResponse.json(data);
        }

        if (action === "update") {
            const { jobId, ...updates } = jobData;
            if (!jobId) {
                return NextResponse.json({ error: "jobId is required for update" }, { status: 400 });
            }

            // --- Input validation ---
            const validStatuses = ["todo", "in_progress", "done", "cancelled"];
            if (updates.status && !validStatuses.includes(updates.status)) {
                return NextResponse.json({ error: `status must be one of: ${validStatuses.join(", ")}` }, { status: 400 });
            }
            const validPriorities = ["low", "medium", "high", "critical"];
            if (updates.priority && !validPriorities.includes(updates.priority)) {
                return NextResponse.json({ error: `priority must be one of: ${validPriorities.join(", ")}` }, { status: 400 });
            }

            // Sanitize: only allow known fields to be updated
            const allowedFields: Record<string, unknown> = {};
            if (updates.status) allowedFields.status = updates.status;
            if (updates.assigned_to) allowedFields.assigned_to = updates.assigned_to;
            if (updates.priority) allowedFields.priority = updates.priority;
            if (updates.cancel_reason) allowedFields.cancel_reason = updates.cancel_reason;
            allowedFields.updated_at = new Date().toISOString();

            const { data, error } = await supabase
                .from("jobs")
                .update(allowedFields)
                .eq("id", jobId)
                .eq("project_id", projectId)
                .select()
                .single();
            if (error) throw error;
            return NextResponse.json(data);
        }

        return NextResponse.json({ error: "Invalid action. Use 'post', 'claim', or 'update'." }, { status: 400 });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
