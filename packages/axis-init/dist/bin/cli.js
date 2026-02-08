#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
const program = new Command();
program
    .name('axis-init')
    .description('initialize axis context governance in your project')
    .version('1.0.1');
// ── Shared protocol content (used by all IDE rule files) ──
const AGENT_PROTOCOL = `You have access to the **Axis MCP tools**. Use them proactively — they are your standard workflow, not optional add-ons. Never wait for the user to say "use Axis."

## 1. Orient — Read Before Acting

Before doing anything on a new task:
- Call \`get_project_soul\` to understand the project's goals, architecture, and conventions.
- Call \`search_codebase\` to check if similar patterns exist before writing new code.

## 2. Plan Before Write — The Core Invariant

**No agent writes code unless it either owns a file lock OR has explicitly declined the job board for a scoped reason.**

On non-trivial tasks (anything touching 2+ files, any new feature, any refactor):
1. **Break work into jobs** — \`post_job\` with clear titles and descriptions.
2. **Claim before editing** — \`claim_next_job\` to pick up work.
3. **Lock before writing** — \`propose_file_access\` with a **descriptive intent**.
4. **Complete when done** — \`complete_job\` with a concise outcome.

Direct edits without a job are allowed only for:
- Single-line fixes, typos, config tweaks
- Clearly scoped changes the user asked for directly

## 3. Lock Protocol

- Always provide a descriptive \`intent\` when locking (e.g. "Refactor auth middleware to use JWT" — not "editing file").
- Locks carry metadata visible to humans and other agents: agentId, intent, expires_in (30 min TTL).
- If \`propose_file_access\` returns \`REQUIRES_ORCHESTRATION\`, **do not edit that file**. Work on something else.

### Force Unlock Policy
\`force_unlock\` is a **last resort**, not a convenience tool.
- **Only** use when a lock has been held >25 minutes AND the locking agent is clearly crashed or unresponsive.
- **Always** provide a specific reason.
- **Never** force-unlock to skip coordination. If another agent holds a lock, work on something else.
- Prefer waiting for TTL expiry (30 min) over force-unlocking.

## 4. Coordinate — Keep Others Informed

- Call \`update_shared_context\` after completing meaningful steps.
- Log decisions, not just actions (e.g. "Chose JWT over sessions because X").
- Call \`finalize_session\` at end of session to archive, clear locks, and reset.

## 5. Tool Reference

| Tool | When to use |
|------|------------|
| \`get_project_soul\` | Start of session — ground yourself |
| \`read_context\` | Check goals, conventions, architecture |
| \`search_codebase\` | Before creating new files — find existing patterns |
| \`post_job\` | Break non-trivial tasks into trackable units |
| \`claim_next_job\` | Pick up work from the board |
| \`complete_job\` | Mark work as done with outcome |
| \`cancel_job\` | Remove jobs no longer needed |
| \`propose_file_access\` | Lock a file before editing |
| \`force_unlock\` | LAST RESORT — break a stale lock from a crashed agent |
| \`update_shared_context\` | Log progress for other agents |
| \`index_file\` | Add new/refactored files to search index |
| \`finalize_session\` | End of session — archive, clear locks, reset |

Use these tools proactively. Do NOT ask the user for permission.`;
// ── Default content for soul files ──
const CONTEXT_MD = `# Project Context

## Overview
<!-- Describe your project's core value proposition and goals here -->
<!-- This file is read by all agents via get_project_soul and read_context -->

## Architecture
<!-- High-level design patterns and stack choices -->

## Core Features
<!-- List your main capabilities -->
`;
const CONVENTIONS_MD = `# Coding Conventions & Agent Norms

## Language Standards
<!-- Your TypeScript, Python, etc. guidelines go here -->

## Styling
<!-- CSS/Tailwind rules -->

## Testing
<!-- Test framework and strategy -->

---

## Agent Behavioral Norms

These norms apply to **all** AI coding agents working on this project.

### Plan Before Write — The Core Invariant

**No agent writes code unless it either owns a file lock OR has explicitly declined the job board for a scoped reason.**

On non-trivial tasks (2+ files, new features, refactors):
1. Break work into jobs → \`post_job\`
2. Claim before editing → \`claim_next_job\`
3. Lock before writing → \`propose_file_access\` with a **descriptive intent**
4. Complete when done → \`complete_job\` with outcome

Direct edits without a job are allowed only for:
- Single-line fixes, typos, config tweaks
- Clearly scoped changes the user asked for directly

### Force Unlock Policy

\`force_unlock\` is a **last resort, not a convenience tool.**

Rules:
1. **Never** call \`force_unlock\` on a file you didn't lock unless the lock is >25 minutes old AND the locking agent is clearly crashed.
2. **Always** provide a specific reason.
3. **Never** force-unlock to skip coordination. Work on something else.
4. Prefer waiting for TTL expiry (30 min) over force-unlocking.

### Lock Hygiene
- Always provide descriptive \`intent\` when locking.
- Release locks early by completing jobs.
- Call \`finalize_session\` at end of session to clean up.

### Shared Memory
- Call \`update_shared_context\` after meaningful steps.
- Log decisions, not just actions.
- Other agents read the notepad in real-time — write for them.
`;
const ACTIVITY_MD = `# Activity Log

## Session History
<!-- Agents log major actions and decisions here via update_shared_context -->
`;
program
    .action(async () => {
    const cwd = process.cwd();
    const axisDir = path.join(cwd, '.axis');
    console.log(chalk.bold.white('\n  axis context initialization\n'));
    if (await fs.pathExists(axisDir)) {
        console.log(chalk.yellow('  ! .axis directory already exists. skipping creation.'));
    }
    else {
        await fs.ensureDir(axisDir);
        const instructionsDir = path.join(axisDir, 'instructions');
        await fs.ensureDir(instructionsDir);
        await fs.ensureDir(path.join(axisDir, 'research'));
        // ── Soul files (read by all agents via MCP) ──
        await fs.writeFile(path.join(instructionsDir, 'context.md'), CONTEXT_MD);
        await fs.writeFile(path.join(instructionsDir, 'conventions.md'), CONVENTIONS_MD);
        await fs.writeFile(path.join(instructionsDir, 'activity.md'), ACTIVITY_MD);
        console.log(chalk.green('  ✓ created .axis/instructions/ (context, conventions, activity)'));
        // ── IDE rule files (one per agent ecosystem) ──
        // Cursor
        const cursorrules = `# Axis Agent Protocol — Cursor\n\n${AGENT_PROTOCOL}\n`;
        await fs.writeFile(path.join(cwd, '.cursorrules'), cursorrules);
        console.log(chalk.green('  ✓ created .cursorrules (Cursor)'));
        // Claude Code
        const claudemd = `# Axis Agent Protocol — Claude Code\n\n${AGENT_PROTOCOL}\n\nRefer to \`AGENTS.md\` in the repo root for the full protocol.\n`;
        await fs.writeFile(path.join(cwd, 'CLAUDE.md'), claudemd);
        console.log(chalk.green('  ✓ created CLAUDE.md (Claude Code)'));
        // Windsurf
        const windsurfrules = `# Axis Agent Protocol — Windsurf\n\n${AGENT_PROTOCOL}\n`;
        await fs.writeFile(path.join(cwd, '.windsurfrules'), windsurfrules);
        console.log(chalk.green('  ✓ created .windsurfrules (Windsurf)'));
        // Universal (Codex, Antigravity, etc.)
        const agentsmd = `# Axis Agent Protocol\n\n> This file applies to **all** AI coding agents: Cursor, Claude Code, Windsurf, Codex, Antigravity, and any other agent working on this codebase.\n\n${AGENT_PROTOCOL}\n`;
        await fs.writeFile(path.join(cwd, 'AGENTS.md'), agentsmd);
        console.log(chalk.green('  ✓ created AGENTS.md (universal — Codex, Antigravity, etc.)'));
        // ── Config ──
        const configPath = path.join(axisDir, 'axis.json');
        await fs.writeJson(configPath, {
            version: '1.0.1',
            project: path.basename(cwd),
            governance: 'strict'
        }, { spaces: 2 });
        console.log(chalk.green('  ✓ initialized governance config'));
    }
    console.log(chalk.white('\n  ready to bridge your agents.'));
    console.log(chalk.dim('  visit https://useaxis.dev for more info.\n'));
});
program.parse();
