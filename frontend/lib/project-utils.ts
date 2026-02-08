import { createClient } from "@supabase/supabase-js";

// Create Supabase client inside function to avoid stale clients on Vercel cold starts
function getSupabase() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!url || !key) {
        console.error("[project-utils] Missing Supabase env vars:", { hasUrl: !!url, hasKey: !!key });
        throw new Error("Supabase configuration missing");
    }
    
    return createClient(url, key);
}

/**
 * Get or create a project ID for a user and project name.
 * This function automatically creates the project if it doesn't exist,
 * making the MCP experience seamless for users.
 */
export async function getOrCreateProjectId(projectName: string, userId: string): Promise<string> {
    const supabase = getSupabase();
    
    // Try to find existing project
    // Note: Using owner_id as that's the correct field name in the projects table
    const { data: project, error: findError } = await supabase
        .from("projects")
        .select("id")
        .eq("name", projectName)
        .eq("owner_id", userId)
        .maybeSingle();

    if (findError) {
        console.error("Error finding project:", findError);
        throw findError;
    }

    // Return existing project ID if found
    if (project?.id) {
        return project.id;
    }

    // Create project if it doesn't exist
    // Note: projects table doesn't have a description column, only: id, name, created_at, owner_id, live_notepad
    const { data: created, error: createError } = await supabase
        .from("projects")
        .insert({
            name: projectName,
            owner_id: userId
        })
        .select("id")
        .single();

    if (createError) {
        console.error("Error creating project:", createError);
        throw createError;
    }

    if (!created?.id) {
        throw new Error("Failed to create project: no ID returned");
    }

    return created.id;
}
