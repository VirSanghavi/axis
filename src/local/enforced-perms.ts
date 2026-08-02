import path from "path";
import { denyWrites, restoreWrites } from "./fs-guard.js";

/**
 * Physical lock enforcement (opt-in via AXIS_ENFORCE_LOCKS).
 * Files are always local to the MCP server even in hosted persistence modes,
 * so chmod-based enforcement is tracked here independently of where lock
 * metadata is stored.
 *
 * Extracted from NerveCenter (audit #3): owns the normalized-path → {prior
 * mode, owner} map and the deny/restore lifecycle around it.
 */
export class EnforcedPerms {
    /** Files made read-only on disk while locked, keyed by normalized path → {prior mode, owner}. */
    private perms: Map<string, { mode?: number; agentId: string }> = new Map();

    constructor(private enabled: boolean) {}

    /** Make a freshly-locked file read-only on disk so non-Axis writers get EACCES. */
    async enforce(normalizedPath: string, agentId: string, filePath: string): Promise<void> {
        if (!this.enabled) return;
        const mode = await denyWrites(path.resolve(process.cwd(), filePath));
        this.perms.set(normalizedPath, { mode, agentId });
    }

    /** Restore write permission for a single released path. */
    async restore(normalizedPath: string): Promise<void> {
        const entry = this.perms.get(normalizedPath);
        if (!entry) return;
        await restoreWrites(path.resolve(process.cwd(), normalizedPath), entry.mode);
        this.perms.delete(normalizedPath);
    }

    /** Restore every file an agent had locked (or all, if agentId omitted). */
    async restoreForAgent(agentId?: string): Promise<void> {
        for (const [p, entry] of [...this.perms]) {
            if (!agentId || entry.agentId === agentId) {
                await restoreWrites(path.resolve(process.cwd(), p), entry.mode);
                this.perms.delete(p);
            }
        }
    }

    /** Whether enforcement is active AND this path is currently enforced. */
    get(normalizedPath: string): { mode?: number; agentId: string } | undefined {
        return this.perms.get(normalizedPath);
    }

    get isEnabled(): boolean {
        return this.enabled;
    }
}
