import type { Mutex } from "async-mutex";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StateStore } from "./state-store.js";
import type { CoordinationClient } from "./coordination-client.js";
import type { EnforcedPerms } from "./enforced-perms.js";

/**
 * The shared services JobBoard and LockRegistry need from the NerveCenter
 * facade. Exposed as live accessors (getters on the implementing object)
 * because supabase/projectId/projectName all change at runtime — on init()
 * and on switch_project — and captured copies would go stale.
 *
 * The mutex is SHARED: job and lock mutations were serialized through one
 * mutex before the split (audit #3), and must remain so.
 */
export interface CoreServices {
    readonly mutex: Mutex;
    readonly store: StateStore;
    readonly coordination: CoordinationClient;
    readonly enforcement: EnforcedPerms;
    readonly supabase: SupabaseClient | undefined;
    readonly useSupabase: boolean;
    readonly projectId: string | undefined;
    readonly projectName: string;
    /**
     * Absolute repo root. Lock paths are resolved and contained against this,
     * NOT against process.cwd(): the two differ whenever the client launches the
     * server outside the repo, or when root detection walks up to an ancestor.
     */
    readonly projectRoot: string;
    readonly lockTimeout: number;
    /** Append to the live notepad (persists locally + syncs to Supabase/API). */
    appendToNotepad(text: string): Promise<void>;
}
