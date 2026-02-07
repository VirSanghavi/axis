import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const userId = session.sub || session.id;
    if (!userId) return NextResponse.json({ error: "User ID not found in session" }, { status: 400 });

    try {
        const { data: activity, error } = await supabase
            .from("activity_feed")
            .select("*")
            .eq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(10);

        if (error) throw error;

        return NextResponse.json({ activity: activity || [] });
    } catch (err: unknown) {
        console.error("Activity GET error:", err);
        return NextResponse.json({ error: "Failed to fetch activity" }, { status: 500 });
    }
}
