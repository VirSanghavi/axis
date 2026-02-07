
# 🚀 Shared Context Deployment Guide

This guide covers deploying the **Axis Shared Context** platform, including the Frontend (Next.js), the Database (Supabase + pgvector), and the Context Server (Local MCP).

---

## 🏗️ 1. Database Setup (Supabase)

The core persistence layer relies on Supabase for Auth, PostgreSQL, and Vector Storage (RAG).

1.  **Create a Project**: Go to [Supabase](https://supabase.com) and create a new project.
2.  **Enable Extensions**: The schema script will handle this, but ensure your instance supports `pgvector`.
3.  **Apply Schema**:
    - Go to **SQL Editor** in your Supabase Dashboard.
    - Copy the content of [`supabase/schema_full.sql`](./supabase/schema_full.sql).
    - Run the entire script. It will:
        - Enable `vector` extension.
        - Create tables: `profiles`, `api_keys`, `projects`, `embeddings`, `jobs`, `locks`.
        - Set up **Strict RLS Policies** (Row Level Security).
        - Create the `match_embeddings` function for vector search.

4.  **Get Credentials**:
    - Go to **Project Settings -> API**.
    - Copy:
        - `Project URL`
        - `anon` key (Public)
        - `service_role` key (Secret - needed for Server/RAG)

---

## 🌐 2. Frontend Deployment (Vercel)

The frontend is a Next.js app located in the `frontend/` directory.

1.  **Import to Vercel**:
    - Build setting: **Framework Preset**: `Next.js`.
    - **Root Directory**: `frontend`. (Click Edit next to "Root Directory" and select `frontend`).

2.  **Environment Variables**:
    Add the following variables in the Vercel Project Settings:

    | Variable | Description |
    | :--- | :--- |
    | `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase Project URL |
    | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase `anon` key |
    | `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase `service_role` key (Required for API Routes/RAG) |
    | `OPENAI_API_KEY` | Key starting with `sk-...` (Required for Chat & Vector Embeddings) |
    | `STRIPE_SECRET_KEY` | Key starting with `sk_...` (Required for Payments) |
    | `STRIPE_WEBHOOK_SECRET` | Secret for Stripe Webhooks (Optional for initial deploy) |
    | `SHARED_CONTEXT_API_SECRET` | A robust random string (e.g. `openssl rand -hex 32`) to secure the API. |

3.  **Deploy**: Click **Deploy**. Vercel will build and serve the app.

---

## 🔌 3. MCP Server (Local Nerve Center)

The "Nerve Center" runs locally on your machine or on a VPS to provide context to AI agents (Cursor, Windsurf, etc).

### Build & Install
1.  **Install Dependencies**:
    ```bash
    npm install
    cd packages/axis-server && npm install
    ```
2.  **Build**:
    ```bash
    npm run build
    ```
3.  **Configure Env**:
    Create a `.env.local` in `packages/axis-server` (or root) with the same keys as Vercel, especially:
    - `NEXT_PUBLIC_SUPABASE_URL`
    - `SUPABASE_SERVICE_ROLE_KEY` (Crucial for persistence locks)
    - `OPENAI_API_KEY` (Crucial for RAG)

### Run Manually
```bash
node packages/axis-server/dist/mcp-server.mjs
```

### Connect to AI (Cursor/Windsurf)
Add this to your MCP Config (`~/.cursor/mcp.json` or similar):

```json
{
  "mcpServers": {
    "shared-context": {
      "command": "node",
      "args": ["/absolute/path/to/shared-context/packages/axis-server/dist/mcp-server.mjs"],
      "env": {
        "NEXT_PUBLIC_SUPABASE_URL": "...",
        "SUPABASE_SERVICE_ROLE_KEY": "...",
        "OPENAI_API_KEY": "..."
      }
    }
  }
}
```

---

## 🐍 4. Python SDK

If you are building Python agents (LangChain, AutoGen):

1.  **Install**:
    ```bash
    pip install ./packages/python-sdk
    ```
2.  **Usage**:
    ```python
    from axis import AxisClient
    client = AxisClient(api_url="https://your-vercel-app.com/api/v1", api_secret="...")
    context = client.get_context()
    ```

---

## ✅ Post-Deployment Verification

1.  **Check RAG**: Go to your deployed site's chat (`/docs` or equivalent) and ask "What is Axis?". If it replies using context, the Vector Search is working.
2.  **Check Auth**: Login/Signup flows should work and create rows in Supabase `auth.users` + `public.profiles`.
3.  **Check API**:
    ```bash
    curl -H "Authorization: Bearer <YOUR_SECRET>" https://your-domain.com/api/v1/context
    ```

---

## 🛠 Troubleshooting

- **500 Error on Chat**: Likely missing `OPENAI_API_KEY` or `SUPABASE_SERVICE_ROLE_KEY`. Check Vercel logs.
- **RLS Errors**: If you can't see data, ensure the user ID matches the row owner. The schema uses `auth.uid() = user_id`.
- **Build Failures**: Ensure `npm install` was run in `frontend` directory specifically if dependencies were added there.
