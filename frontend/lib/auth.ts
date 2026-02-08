import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SESSION_COOKIE = "sc_session";
const SECRET_KEY = process.env.APP_SESSION_SECRET || "default_secret_dont_use_in_prod";
const KEY = new TextEncoder().encode(SECRET_KEY);

type SessionPayload = {
  email: string;
  sub?: string; // User ID
  role?: string;
  keyId?: string;
  [key: string]: unknown;
};

export async function createSession(email: string, userId: string | undefined, ttlSeconds: number) {
  const jwt = await new SignJWT({ email, sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(KEY);
  return jwt;
}

export async function verifySession(token?: string): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, KEY);
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

async function hashKey(key: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function validateApiKey(key: string): Promise<SessionPayload | null> {
  console.log("[validateApiKey] Starting validation for key:", key.substring(0, 15) + "...");
  
  if (!key.startsWith("sk_sc_")) {
    console.log("[validateApiKey] ❌ Key doesn't start with sk_sc_:", key.substring(0, 10));
    return null;
  }

  const hash = await hashKey(key);
  console.log("[validateApiKey] Key hash (first 20 chars):", hash.substring(0, 20) + "...");

  // Create Supabase client inside function to avoid stale clients
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  console.log("[validateApiKey] Supabase config check:", { 
    hasUrl: !!url, 
    hasKey: !!serviceKey,
    urlPrefix: url ? url.substring(0, 30) + "..." : "none"
  });
  
  if (!url || !serviceKey) {
    console.error("[validateApiKey] ❌ Missing Supabase env vars:", { hasUrl: !!url, hasKey: !!serviceKey });
    return null;
  }

  try {
    const supabase = createClient(url, serviceKey);
    console.log("[validateApiKey] Supabase client created, querying api_keys table...");

    const { data, error } = await supabase
      .from("api_keys")
      .select("id, user_id, is_active")
      .eq("key_hash", hash)
      .single();

    if (error) {
      console.error("[validateApiKey] ❌ Database error:", error);
      return null;
    }
    
    if (!data) {
      console.log("[validateApiKey] ❌ No API key found in database for hash:", hash.substring(0, 20) + "...");
      return null;
    }
    
    if (!data.is_active) {
      console.log("[validateApiKey] ❌ API key found but is not active:", data.id);
      return null;
    }
    
    console.log("[validateApiKey] ✅ API key validated successfully:", { keyId: data.id, userId: data.user_id });

    // Fire and forget update last_used_at
    supabase.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then();

    return {
      email: "api-key-user",
      sub: data.user_id,
      keyId: data.id,
      role: "api_key"
    };
  } catch (e: any) {
    console.error("[validateApiKey] ❌ Exception during validation:", e.message, e.stack);
    return null;
  }
}

export async function getSessionFromRequest(req: NextRequest): Promise<SessionPayload | null> {
  console.log("[getSessionFromRequest] Starting validation");
  
  // 1. Check Cookie
  const cookieToken = req.cookies.get(SESSION_COOKIE)?.value;
  if (cookieToken) {
    console.log("[getSessionFromRequest] Found cookie token");
    return verifySession(cookieToken);
  }

  // 2. Check Authorization Header (Bearer Token or API Key)
  const authHeader = req.headers.get("Authorization");
  console.log("[getSessionFromRequest] Authorization header:", authHeader ? `${authHeader.substring(0, 30)}...` : "missing");
  
  if (authHeader) {
    const [scheme, token] = authHeader.split(" ");
    console.log("[getSessionFromRequest] Scheme:", scheme, "Token prefix:", token ? token.substring(0, 10) + "..." : "none");
    
    if (scheme === "Bearer" && token) {
      // Check if it's an API Key
      if (token.startsWith("sk_sc_")) {
        console.log("[getSessionFromRequest] Detected API key, validating...");
        const result = await validateApiKey(token);
        console.log("[getSessionFromRequest] API key validation result:", result ? "SUCCESS" : "FAILED");
        return result;
      }
      // Otherwise try as JWT
      console.log("[getSessionFromRequest] Trying as JWT...");
      return verifySession(token);
    }
  }

  console.log("[getSessionFromRequest] No valid session found");
  return null;
}

export async function setSessionCookie(token: string) {
  const secure = process.env.NODE_ENV === "production";
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, "", {
    httpOnly: true,
    expires: new Date(0),
    path: "/",
  });
}



export async function getSessionFromCookies() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  return await verifySession(token);
}
