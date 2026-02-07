import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { resolveUserId } from "@/lib/db-utils";
import { logActivity } from "@/lib/activity";

function getSupabaseClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key || url.includes("<") || url.includes("your-project")) {
        return null;
    }

    return createClient(url, key);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const supabase = getSupabaseClient();
    if (!supabase) {
        return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
    }

    const { id } = await params;
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const userId = session.sub || session.id || await getUserId(supabase, session.email);

        if (!userId) {
            return NextResponse.json({ error: "User not found" }, { status: 404 });
        }

        // Fetch key name before deletion for logging
        const { data: keyData } = await supabase
            .from("api_keys")
            .select("name")
            .match({ id, user_id: userId })
            .single();

        const { error } = await supabase
            .from("api_keys")
            .delete()
            .match({ id, user_id: userId });

        if (error) {
            console.error("Delete key error:", error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Log activity
        await logActivity(userId as string, "KEY_DELETED", keyData?.name || "Unknown Key", { key_id: id });

        return NextResponse.json({ success: true });
    } catch (err: unknown) {
        console.error("Delete key exception:", err);
        const errorMessage = err instanceof Error ? err.message : "Failed to delete key";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}

async function getUserId(supabase: SupabaseClient, email: string) {
    return resolveUserId(email);
}
