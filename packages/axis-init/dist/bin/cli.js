#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
const program = new Command();
program
    .name('axis-init')
    .description('initialize axis context governance in your project')
    .version('1.0.0');
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
            // Initialize standard context files
            await fs.writeFile(path.join(instructionsDir, 'context.md'), `# Project Context

## Overview
<!-- Describe the project's core value proposition and goals -->

## Architecture
<!-- High-level design patterns and stack choices -->

## Core Features
<!-- List of main capabilities -->
`);
            await fs.writeFile(path.join(instructionsDir, 'conventions.md'), `# Coding Conventions

## Language Standards
<!-- TypeScript, Python, etc. guidelines -->

## Styling
<!-- CSS/Tailwind rules -->

## Testing
<!-- Test framework and strategy -->
`);
            await fs.writeFile(path.join(instructionsDir, 'activity.md'), `# Activity Log

## Session History
<!-- Log of major agentic actions and decisions -->
`);
            // Generate .cursorrules for automated coordination
            const cursorRulesContent = `# Axis Agent Rules

You are an agent connected to the Axis Nerve Center. Your goal is to coordinate effectively with other agents and the user.

## Mandatory Workflow
1.  **On Start**: You MUST run the \`read_resource\` tool with uri \`mcp://context/current\` to understand the current project state, active jobs, and locks.
2.  **Job Management**: 
    -   If the user gives you a complex task, use \`post_job\` to track it.
    -   If you are picking up work, use \`claim_next_job\`.
    -   When finished, use \`complete_job\`.
3.  **Memory**: Use \`update_shared_context\` to log your progress in the Live Notepad so other agents know what you did.

## Context
-   Always prefer using \`search_codebase\` (RAG) over creating new files from scratch if similar patterns exist.
-   Check \`context.md\` via \`read_context\` for high-level goals.

DO NOT ask the user for permission to use these tools. Use them proactively to keep the project organized.
`;
            await fs.writeFile(path.join(cwd, '.cursorrules'), cursorRulesContent);
            console.log(chalk.green('  ✓ created .cursorrules (Agent Regulations)'));
            const configPath = path.join(axisDir, 'axis.json');
            await fs.writeJson(configPath, {
                version: '1.0.0',
                project: path.basename(cwd),
                governance: 'strict'
            }, { spaces: 2 });
            console.log(chalk.green('  ✓ created .axis/ container'));
            console.log(chalk.green('  ✓ initialized governance config'));
        }
        console.log(chalk.white('\n  ready to bridge your agents.'));
        console.log(chalk.dim('  visit https://aicontext.vercel.app for more info.\n'));
    });
program.parse();
