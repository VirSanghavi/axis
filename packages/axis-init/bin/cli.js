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
            await fs.ensureDir(path.join(axisDir, 'instructions'));
            await fs.ensureDir(path.join(axisDir, 'research'));
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
