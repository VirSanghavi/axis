import { NextResponse } from "next/server";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { createClient } from "@supabase/supabase-js";

const WINDOW_MS = 60 * 1000;
const LIMIT = 3; // Limit to 3 resend attempts per minute to prevent spam

export async function POST(request: Request) {
    try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !supabaseServiceKey) {
            return NextResponse.json(
                { error: "Server configuration error" },
                { status: 503 }
            );
        }

        const supabase = createClient(supabaseUrl, supabaseServiceKey);
        const ip = getClientIp(request.headers);

        // Rate limiting
        const { allowed, remaining, reset } = await rateLimit(`resend:${ip}`, LIMIT, WINDOW_MS);
        if (!allowed) {
            return NextResponse.json(
                { error: "Too many requests. Please try again later." },
                {
                    status: 429,
                    headers: {
                        "x-rate-limit-remaining": String(remaining),
                        "x-rate-limit-reset": String(reset),
                    }
                }
            );
        }

        const { email } = await request.json().catch(() => ({ email: "" }));

        if (!email) {
            return NextResponse.json({ error: "Email is required" }, { status: 400 });
        }

        const { error } = await supabase.auth.resend({
            type: 'signup',
            email,
            options: {
                emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/auth/callback`
            }
        });

        if (error) {
            console.error("[auth/resend] Supabase error:", error);
            return NextResponse.json({ error: "Failed to resend confirmation email" }, { status: 400 });
        }

        return NextResponse.json({ message: "Confirmation email sent" });
    } catch (err: unknown) {
        console.error("Resend confirmation error:", err);
        return NextResponse.json(
            { error: "An unexpected error occurred" },
            { status: 500 }
        );
    }
}
