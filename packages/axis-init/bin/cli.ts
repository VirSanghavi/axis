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
        } else {
            await fs.ensureDir(axisDir);
            const instructionsDir = path.join(axisDir, 'instructions');
            await fs.ensureDir(instructionsDir);
            await fs.ensureDir(path.join(axisDir, 'research'));

            // Initialize standard context files
            await fs.writeFile(path.join(instructionsDir, 'context.md'), '# Project Context\n\nHigh-level architectural context goes here.\n');
            await fs.writeFile(path.join(instructionsDir, 'conventions.md'), '# Coding Conventions\n\nProject-specific patterns and rules.\n');
            await fs.writeFile(path.join(instructionsDir, 'activity.md'), '# Activity Log\n\nLog of major agentic actions.\n');

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
        console.log(chalk.dim('  visit https://axis.sh for more info.\n'));
    });

program.parse();
