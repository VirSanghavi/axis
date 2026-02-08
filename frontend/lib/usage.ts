import { createClient } from "@supabase/supabase-js";

export async function logUsage({
    userId,
    apiKeyId,
    endpoint,
    method,
    statusCode,
    responseTimeMs,
    tokensUsed = 0,
    metadata
}: {
    userId: string;
    apiKeyId?: string;
    endpoint: string;
    method: string;
    statusCode: number;
    responseTimeMs?: number;
    tokensUsed?: number;
    metadata?: Record<string, any>;
}) {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || "",
        process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    );

    try {
        // Note: api_usage table doesn't have a metadata column
        // Only includes: id, user_id, api_key_id, endpoint, method, status_code, response_time_ms, tokens_used, created_at
        const { error } = await supabase.from("api_usage").insert({
            user_id: userId,
            api_key_id: apiKeyId,
            endpoint,
            method,
            status_code: statusCode,
            response_time_ms: responseTimeMs,
            tokens_used: tokensUsed
            // metadata field removed - not in schema
        });

        if (error) {
            console.error("Usage logging error:", error);
        }
    } catch (err) {
        console.error("Usage logging exception:", err);
    }
}
