import { NextResponse } from "next/server";
import { createSession, setSessionCookie, createRefreshToken, setRefreshCookie } from "@/lib/auth";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { createClient } from "@supabase/supabase-js";
import { isValidEmail, isValidPassword } from "@/lib/validation";
import { logAndSanitize } from "@/lib/safe-error";

const WINDOW_MS = 60 * 1000;
const LIMIT = 10;

export async function POST(request: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey || supabaseUrl.includes("YOUR_") || supabaseServiceKey.includes("YOUR_")) {
    return NextResponse.json(
      { error: "Supabase is not configured. Please update .env.local with valid credentials." },
      { status: 503 }
    );
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const ip = getClientIp(request.headers);
  const { allowed, remaining, reset } = await rateLimit(`login:${ip}`, LIMIT, WINDOW_MS);
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: rateHeaders(remaining, reset) }
    );
  }

  let body: { email?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400, headers: rateHeaders(remaining, reset) }
    );
  }

  const { email, password } = body;

  // Input validation
  if (!isValidEmail(email)) {
    return NextResponse.json(
      { error: "Invalid email format" },
      { status: 400, headers: rateHeaders(remaining, reset) }
    );
  }

  if (!isValidPassword(password)) {
    return NextResponse.json(
      { error: "Password must be between 8 and 128 characters" },
      { status: 400, headers: rateHeaders(remaining, reset) }
    );
  }

  // Hybrid Auth: 
  // 1. Check Env Password (Admin/Simple Mode)
  // 2. Or check Supabase Auth (Real User Mode)

  let userId: string | undefined;

  const expected = process.env.APP_LOGIN_PASSWORD;
  if (expected && password === expected) {
    // Admin login - Lookup user by email in profiles to get ID
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', email)
      .single();
    userId = profile?.id;
    if (!userId) {
      return NextResponse.json(
        { error: "No account found for this email" },
        { status: 401, headers: rateHeaders(remaining, reset) }
      );
    }
  } else {
    // Try Supabase Auth
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });
    if (error || !data.user) {
      // Modern Supabase returns "Invalid login credentials" for BOTH wrong
      // passwords AND unconfirmed emails (security feature). Check the user's
      // actual confirmation status via profiles table + admin API.
      if (email) {
        try {
          const { data: profile } = await supabase
            .from('profiles')
            .select('id')
            .ilike('email', email)
            .single();
          if (profile?.id) {
            const { data: { user: authUser } } = await supabase.auth.admin.getUserById(profile.id);
            if (authUser && !authUser.email_confirmed_at) {
              return NextResponse.json(
                { error: "Email not confirmed" },
                { status: 403, headers: rateHeaders(remaining, reset) }
              );
            }
          }
        } catch {
          // Admin lookup failed — fall through to generic error
        }
      }

      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401, headers: rateHeaders(remaining, reset) }
      );
    }
    userId = data.user.id;
  }

  // Create user in profiles if not exists (lazy sync)
  if (userId) {
    await supabase.from('profiles').insert({
      id: userId,
      email: email
    });
    // Ignore error if already exists as per RLS or unique constraint
  }

  try {
    // Issue 7-day JWT access token
    const token = await createSession(email, userId);
    await setSessionCookie(token);

    // Issue refresh token (30-day, stored in Redis)
    if (userId) {
      const refreshToken = await createRefreshToken(userId, email);
      await setRefreshCookie(refreshToken);
    }

    return NextResponse.json(
      { ok: true },
      { headers: rateHeaders(remaining, reset) }
    );
  } catch (err) {
    const msg = logAndSanitize("Login", err, "Authentication failed");
    return NextResponse.json(
      { error: msg },
      { status: 500, headers: rateHeaders(remaining, reset) }
    );
  }
}

function rateHeaders(remaining: number, reset: number) {
  return {
    "x-rate-limit-remaining": String(remaining),
    "x-rate-limit-reset": String(reset),
  };
}
