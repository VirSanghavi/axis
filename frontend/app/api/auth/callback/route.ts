import { NextRequest, NextResponse } from "next/server";
import { createSession, setSessionCookie, createRefreshToken, setRefreshCookie } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";
import { logAndSanitize } from "@/lib/safe-error";

/**
 * POST /api/auth/callback
 * Called by the client-side callback page after Supabase email verification.
 * Receives a Supabase access_token, validates it, creates the app's own
 * JWT session cookie, and returns success so the client can redirect.
 */
export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { access_token, user_id, email } = await req.json();

    if (!access_token || !user_id || !email) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Basic input sanitization
    if (typeof access_token !== 'string' || typeof user_id !== 'string' || typeof email !== 'string') {
      return NextResponse.json({ error: "Invalid field types" }, { status: 400 });
    }

    // Validate the user exists and email is confirmed via admin API
    const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(user_id);

    if (userError || !user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (!user.email_confirmed_at) {
      return NextResponse.json({ error: "Email not confirmed" }, { status: 403 });
    }

    // Ensure the user exists in our profiles table
    await supabase.from("profiles").upsert({
      id: user.id,
      email: user.email,
    }, { onConflict: "id" });

    // Create the app's own JWT session cookie (7 day TTL)
    const token = await createSession(email, user.id);
    await setSessionCookie(token);

    // Issue refresh token for token rotation (30-day, stored in Redis)
    const refreshToken = await createRefreshToken(user.id, email);
    await setRefreshCookie(refreshToken);

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const msg = logAndSanitize("Auth callback", err, "Callback failed");
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
