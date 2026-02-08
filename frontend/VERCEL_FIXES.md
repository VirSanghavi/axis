# Vercel + Supabase Fixes Applied

## Issues Fixed

### 1. ✅ Supabase Client Initialization Pattern
**Problem**: Clients were created at module level, causing stale clients on Vercel cold starts.

**Fix**: Moved all Supabase client creation inside functions using `getSupabase()` helper.

**Files Fixed**:
- `app/api/v1/usage/route.ts`
- `app/api/v1/locks/route.ts`
- `app/api/v1/jobs/route.ts`
- `app/api/v1/search/route.ts`
- `app/api/v1/embed/route.ts`
- `lib/project-utils.ts`

### 2. ✅ Runtime Declaration
**Problem**: Missing `export const runtime = "nodejs"` - Supabase service role doesn't work in Edge runtime.

**Fix**: Added `export const runtime = "nodejs"` to all API routes.

**Files Fixed**:
- All routes in `app/api/v1/`

### 3. ✅ Environment Variable Validation
**Problem**: No validation if env vars are missing, causing silent failures.

**Fix**: Added validation in `getSupabase()` functions with error logging.

## Remaining Routes to Fix

These routes still need the same fixes:
- `app/api/v1/sessions/sync/route.ts`
- `app/api/v1/sessions/finalize/route.ts`
- `app/api/v1/projects/route.ts`
- `app/api/v1/governance/route.ts`
- `app/api/v1/sessions/route.ts`
- `app/api/v1/context/mirror/route.ts`

## Vercel Environment Variables Checklist

Make sure these are set in Vercel dashboard:
- ✅ `NEXT_PUBLIC_SUPABASE_URL` - Your Supabase project URL
- ✅ `SUPABASE_SERVICE_ROLE_KEY` - Your Supabase service role key (NOT anon key)
- ✅ `OPENAI_API_KEY` - For embeddings
- ✅ `APP_SESSION_SECRET` - For JWT signing

## Testing

After deploying to Vercel:
1. Check function logs for any "Missing Supabase env vars" errors
2. Test MCP tools - they should now work correctly
3. Monitor for "Database not connected" errors - should be resolved
