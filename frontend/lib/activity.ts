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
        const { error } = await supabase.from("activity_feed").insert({
            user_id: userId,
            type,
            target,
            metadata,
            status,
        });

        if (error) {
            console.error("[Activity Log] Error inserting record:", error);
        }
    } catch (err) {
        console.error("[Activity Log] Unexpected error:", err);
    }
}
