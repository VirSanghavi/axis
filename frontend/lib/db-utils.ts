import { createClient } from "@supabase/supabase-js";

/**
 * Standard resolveUserId to avoid expensive admin.listUsers() calls in production.
 * Relies on the profiles table being synced during auth.
 */
export async function resolveUserId(email: string): Promise<string | null> {
    if (!email) return null;

    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || "",
        process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    );

    // Use case-insensitive lookup — emails are case-insensitive per RFC 5321
    const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .ilike("email", email)
        .single();

    return profile?.id || null;
}
