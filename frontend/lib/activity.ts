import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder';

const supabase = createClient(supabaseUrl, supabaseKey);

export async function logActivity(
    userId: string,
    type: string,
    target: string,
    metadata: any = {},
    status: string = "success"
) {
    try {
        const activity = {
            user_id: userId,
            type,
            target,
            metadata,
            status,
            created_at: new Date().toISOString()
        };

        const { error } = await supabase.from("activity_feed").insert(activity);

        if (error) {
            console.error("[Activity Log] Error inserting record:", error);
        }

        // Also broadcast to a user-specific channel for real-time updates
        // This bypasses RLS issues with custom auth
        await supabase.channel(`activity-feed-${userId}`).send({
            type: 'broadcast',
            event: 'new-activity',
            payload: activity
        });

    } catch (err) {
        console.error("[Activity Log] Unexpected error:", err);
    }
}
