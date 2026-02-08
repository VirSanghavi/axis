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
            const { data, error } = await supabase
                .from("jobs")
                .insert({
                    project_id: projectId,
                    title: jobData.title,
                    description: jobData.description,
                    priority: jobData.priority || "medium",
                    status: "todo",
                    dependencies: jobData.dependencies || []
                })
                .select()
                .single();
            if (error) throw error;
            return NextResponse.json(data);
        }

        if (action === "update") {
            const { jobId, ...updates } = jobData;
            const { data, error } = await supabase
                .from("jobs")
                .update({
                    ...updates,
                    updated_at: new Date().toISOString()
                })
                .eq("id", jobId)
                .eq("project_id", projectId)
                .select()
                .single();
            if (error) throw error;
            return NextResponse.json(data);
        }

        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
