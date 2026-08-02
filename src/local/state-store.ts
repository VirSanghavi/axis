import fs from "fs/promises";
import { logger } from "../utils/logger.js";
import { createEmptyState, NerveCenterState } from "./coordination-types.js";
import { CoalescedWriter, serializeState } from "./atomic-file.js";

/**
 * JSON-file persistence for the local fallback state (locks, jobs, notepad).
 * Owns the state OBJECT itself so that consumers holding a StateStore
 * reference always see the current state even after load()/reset() swap it
 * (NerveCenter reassigned `this.state` in several places — an aliasing trap
 * for anything that had captured the old object).
 *
 * Extracted from NerveCenter.saveState/loadState (audit #3). Writes go
 * through atomic-file.ts (audit #5): an advisory cross-process lockfile
 * closes the two-server clobber race, a temp-file + rename makes torn writes
 * impossible, serialization is compact, and bursts of mutations coalesce
 * into at most one in-flight write plus one trailing write.
 */
export class StateStore {
    current: NerveCenterState;
    private writer: CoalescedWriter;

    constructor(private filePath: string) {
        this.current = createEmptyState();
        this.writer = new CoalescedWriter(filePath);
    }

    get stateFilePath(): string {
        return this.filePath;
    }

    setFilePath(filePath: string): void {
        if (filePath === this.filePath) return;
        this.filePath = filePath;
        this.writer = new CoalescedWriter(filePath);
    }

    reset(): void {
        this.current = createEmptyState();
    }

    async save(): Promise<void> {
        try {
            await this.writer.write(serializeState(this.current));
        } catch (error) {
            logger.error("Failed to persist state", error);
        }
    }

    async load(): Promise<void> {
        try {
            const data = await fs.readFile(this.filePath, "utf-8");
            const parsed = JSON.parse(data) as Partial<NerveCenterState>;
            this.current = {
                ...createEmptyState(),
                ...parsed,
                locks: parsed.locks || {},
                jobs: parsed.jobs || {},
                liveNotepad: parsed.liveNotepad || createEmptyState().liveNotepad,
            };
            logger.info("State loaded from disk");
        } catch (_error) {
            this.current = createEmptyState();
        }
    }
}
