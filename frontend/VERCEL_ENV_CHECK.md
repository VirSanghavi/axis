# Vercel Environment Variables Checklist

## Critical Variables (Required)

Make sure these are set in **Vercel Dashboard → Settings → Environment Variables**:

### Production Environment
- ✅ `NEXT_PUBLIC_SUPABASE_URL` - Your Supabase project URL (e.g., `https://xxxxx.supabase.co`)
- ✅ `SUPABASE_SERVICE_ROLE_KEY` - Your Supabase service role key (starts with `eyJ...`)
- ✅ `OPENAI_API_KEY` - Your OpenAI API key (for embeddings)
- ✅ `APP_SESSION_SECRET` - Random secret for JWT signing (optional but recommended)

### Important Notes

1. **NOT `SUPABASE_ANON_KEY`** - You MUST use the service role key, not the anon key
2. **NOT `SUPABASE_URL`** - Use `NEXT_PUBLIC_SUPABASE_URL` (the Next.js convention)
3. **No trailing spaces** - Copy values carefully
4. **No quotes** - Don't wrap values in quotes
5. **Correct environment** - Make sure variables are set for Production (not just Preview)

## Quick Test

After setting variables, add this temporarily to any API route:

```typescript
console.log("SUPABASE_URL", !!process.env.NEXT_PUBLIC_SUPABASE_URL);
console.log("SERVICE_ROLE", !!process.env.SUPABASE_SERVICE_ROLE_KEY);
```

Deploy and check logs. Both should log `true`.

## Where to Find Supabase Keys

1. Go to your Supabase project dashboard
2. Settings → API
3. Copy:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **service_role key** (secret) → `SUPABASE_SERVICE_ROLE_KEY`

⚠️ **Never commit the service role key to git!**
