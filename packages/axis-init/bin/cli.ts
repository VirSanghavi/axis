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

const AGENT_PROTOCOL = `## CRITICAL: AUTONOMOUS EXECUTION RULES

These rules are mandatory. They are not suggestions. Violating them degrades the user experience and forces manual intervention.

1. **NEVER** wait for the user to tell you to use Axis tools. They are your default workflow the instant a session begins.
2. **IMMEDIATELY** call \`get_project_soul\` as your very first action when you receive a task. Do not read files, do not respond to the user — call this tool first.
3. **ALWAYS** post jobs via \`post_job\` before starting non-trivial work (2+ files, new features, refactors). Do this automatically. The user should never have to remind you.
4. **NEVER** pause to report findings and wait for permission to continue. When you identify issues, fixes needed, or work to do — start building immediately. The user asked you to act, not narrate and wait.
5. **ALWAYS** complete jobs (\`complete_job\`) as soon as you finish each task. This releases file locks. Do not leave locks dangling.
6. **ALWAYS** call \`finalize_session\` when the user's entire request is fully complete. This is mandatory — not optional cleanup.

## Session Lifecycle

Execute this sequence automatically. Do not wait for the user to walk you through it.

### START (do this immediately when you receive a task)
1. \`get_project_soul\` — load project context, goals, conventions
2. \`search_codebase\` — check for existing patterns relevant to the task

### WORK (for each unit of work)
1. \`post_job\` — break the task into trackable jobs (skip ONLY for single-line typo fixes)
2. \`claim_next_job\` — claim the first job
3. \`propose_file_access\` — lock each file before editing (with descriptive intent)
4. Make the changes
5. \`complete_job\` — report outcome (this releases the lock)
6. \`update_shared_context\` — log what you did and why
7. Repeat from step 2 for remaining jobs

### CLEANUP (do this when the user's request is fully complete)
1. Verify all jobs are completed
2. \`update_shared_context\` — final summary of what was accomplished
3. \`finalize_session\` — archive context, clear all locks, reset state

## Lock Protocol

- Provide a descriptive \`intent\` when locking (e.g. "Refactor auth middleware to use JWT" — not "editing file").
- If \`propose_file_access\` returns \`REQUIRES_ORCHESTRATION\` — do NOT edit that file. Work on a different file or job instead.
- Release locks early by completing jobs promptly. Do not hold locks while doing unrelated work.

### Force Unlock Policy
\`force_unlock\` is a **last resort**, not a convenience.
- **Only** use when a lock is >25 minutes old AND the locking agent is clearly crashed.
- **Always** provide a specific reason.
- **Never** force-unlock to skip coordination. Work on something else instead.

## Tool Reference

| Tool | When |
|------|------|
| \`get_project_soul\` | FIRST action in every session — non-negotiable |
| \`read_context\` | Check goals, conventions, architecture |
| \`search_codebase\` | Before creating new files — find existing patterns |
| \`search_docs\` | Look up Axis feature usage |
| \`post_job\` | IMMEDIATELY when you receive a non-trivial task |
| \`claim_next_job\` | Before starting each job |
| \`complete_job\` | IMMEDIATELY after finishing each job |
| \`cancel_job\` | Remove jobs no longer needed |
| \`propose_file_access\` | Before EVERY file edit |
| \`force_unlock\` | LAST RESORT — crashed agent only |
| \`update_shared_context\` | After every meaningful step |
| \`index_file\` | After creating or significantly changing a file |
| \`finalize_session\` | When the user's request is FULLY complete — mandatory |

These tools are not optional. Do NOT ask the user for permission to use them. Do NOT skip steps. Execute the full lifecycle autonomously.`;

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

## Agent Behavioral Norms (MANDATORY)

These norms apply to **all** AI coding agents working on this project. They are not optional.

### Autonomous Execution

Agents MUST execute the full Axis workflow autonomously:
- **Do NOT** wait for the user to say "use Axis" or "post a job" or "lock the file." Just do it.
- **Do NOT** pause after analysis to ask permission to proceed. Identify issues → start fixing immediately.
- **Do NOT** leave locks or jobs dangling. Complete jobs and finalize sessions without being told.

### Plan Before Write

**No agent writes code unless it either owns a file lock OR has explicitly declined the job board for a scoped reason.**

On non-trivial tasks (2+ files, new features, refactors):
1. \`post_job\` — break into trackable jobs (do this IMMEDIATELY, not after being asked)
2. \`claim_next_job\` — claim before starting
3. \`propose_file_access\` — lock with a **descriptive intent**
4. \`complete_job\` — report outcome when done (this releases the lock)

Skip jobs ONLY for: single-line fixes, typos, config tweaks.

### Lock Hygiene
- Descriptive \`intent\` when locking (not "editing file").
- Release locks IMMEDIATELY by completing jobs. Never hold a lock while doing unrelated work.
- \`force_unlock\` is a **last resort** — only for locks >25 min old from a crashed agent.

### Session Cleanup (MANDATORY)
- \`complete_job\` after EVERY finished task — do not accumulate incomplete jobs.
- \`update_shared_context\` after meaningful steps — log decisions, not just actions.
- \`finalize_session\` when the user's request is fully complete — this is required, not optional.
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
        } else {
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
