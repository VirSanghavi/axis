/**
 * Canonical Axis MCP tool manifest — the single source of truth for which
 * tools each surface (local stdio server vs hosted useaxis.dev/api/mcp)
 * exposes, and WHY any tool is intentionally absent from a surface.
 *
 * CANONICAL COPY: shared-context/src/shared/tool-manifest.ts (this file).
 * A mirrored copy lives at axis-frontend/frontend/lib/tool-manifest.ts so the
 * hosted repo can contract-test its own registry; keep the two in sync until
 * the shared-package extraction (audit #1) gives both repos one import.
 *
 * Contract tests:
 *  - shared-context/tests/tool-manifest.test.ts  → local surface matches this
 *  - axis-frontend/frontend/lib/tool-manifest.test.ts → hosted surface matches this
 *
 * This module is dependency-free on purpose so it can be relocated into a
 * shared package without dragging anything along.
 */

export type ToolSurface = "local" | "hosted";

export interface ToolManifestEntry {
  name: string;
  surfaces: ToolSurface[];
  /** Required whenever a surface is missing: the reason the gap is intentional. */
  gap?: { missingFrom: ToolSurface; reason: string };
}

export const TOOL_MANIFEST: ToolManifestEntry[] = [
  // ── Job board (full lifecycle on both surfaces) ──
  { name: "post_job", surfaces: ["local", "hosted"] },
  { name: "claim_next_job", surfaces: ["local", "hosted"] },
  { name: "claim_job", surfaces: ["local", "hosted"] },
  { name: "complete_job", surfaces: ["local", "hosted"] },
  { name: "cancel_job", surfaces: ["local", "hosted"] },
  { name: "release_job", surfaces: ["local", "hosted"] },
  { name: "list_jobs", surfaces: ["local", "hosted"] },

  // ── File locking ──
  { name: "propose_file_access", surfaces: ["local", "hosted"] },
  { name: "release_file_access", surfaces: ["local", "hosted"] },
  { name: "list_locks", surfaces: ["local", "hosted"] },
  { name: "verify_file_lock", surfaces: ["local", "hosted"] },
  { name: "force_unlock", surfaces: ["local", "hosted"] },
  {
    name: "guarded_write",
    surfaces: ["local"],
    gap: {
      missingFrom: "hosted",
      reason:
        "Enforced writes happen on the developer's filesystem; the hosted server has no access to the client's local files. Hosted callers get tamper DETECTION via verify_file_lock; enforced writes require the local server.",
    },
  },

  // ── Presence & session ──
  { name: "list_agents", surfaces: ["local", "hosted"] },
  { name: "finalize_session", surfaces: ["local", "hosted"] },
  {
    name: "switch_project",
    surfaces: ["local"],
    gap: {
      missingFrom: "hosted",
      reason:
        "Workspace rebinding is a local-process concern. The hosted server is stateless per request and resolves the project from each call's projectName/org, so there is nothing to switch.",
    },
  },

  // ── Shared context / notepad ──
  { name: "update_shared_context", surfaces: ["local", "hosted"] },
  { name: "get_shared_context", surfaces: ["local", "hosted"] },
  {
    name: "read_context",
    surfaces: ["local"],
    gap: {
      missingFrom: "hosted",
      reason:
        "Context files (.axis/instructions/*.md) live in the client's repository on disk; the hosted server cannot read them. The hosted notepad is served by get_shared_context.",
    },
  },
  {
    name: "update_context",
    surfaces: ["local"],
    gap: {
      missingFrom: "hosted",
      reason:
        "Writes to .axis/instructions/*.md on the client's disk; filesystem access is local-only.",
    },
  },
  {
    name: "get_project_soul",
    surfaces: ["local"],
    gap: {
      missingFrom: "hosted",
      reason:
        "The project soul is stored in the client repo (.axis/instructions/context.md + conventions.md). The hosted context mirror (/api/v1/context/mirror) is not yet a real store; when it is, this becomes a shared tool.",
    },
  },
  {
    name: "update_project_soul",
    surfaces: ["local"],
    gap: {
      missingFrom: "hosted",
      reason: "Same as get_project_soul — soul files live on the client's disk.",
    },
  },

  // ── Intelligence (indexing & search) ──
  { name: "search_codebase", surfaces: ["local", "hosted"] },
  { name: "index_codebase", surfaces: ["local", "hosted"] },
  {
    name: "index_file",
    surfaces: ["local"],
    gap: {
      missingFrom: "hosted",
      reason:
        "Reads the file from the client's disk (sandboxed). Hosted indexing receives file content pushed through index_codebase's batch payload instead.",
    },
  },
  {
    name: "search_docs",
    surfaces: ["local"],
    gap: {
      missingFrom: "hosted",
      reason:
        "Backed by the local RAG fallback over indexed docs. A hosted docs search is a candidate feature, not yet built — tracked as an intentional gap until then.",
    },
  },
  {
    name: "deep_search",
    surfaces: ["hosted"],
    gap: {
      missingFrom: "local",
      reason:
        "Multi-step agentic search carries real server-side embedding/LLM cost — it is part of the paid hosted intelligence tier. Local users get search_codebase's instant local fallback.",
    },
  },

  // ── Account ──
  { name: "get_subscription_status", surfaces: ["local", "hosted"] },
  { name: "get_usage_stats", surfaces: ["local", "hosted"] },
];

export function toolNamesFor(surface: ToolSurface): string[] {
  return TOOL_MANIFEST.filter((t) => t.surfaces.includes(surface))
    .map((t) => t.name)
    .sort();
}

export const localToolNames = (): string[] => toolNamesFor("local");
export const hostedToolNames = (): string[] => toolNamesFor("hosted");
