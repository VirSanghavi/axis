#!/usr/bin/env node

import { program } from "commander";
import chalk from "chalk";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from 'url';
import fs from 'fs';

// ESM dirname shim
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

program
    .name("axis-server")
    .description("Start the Axis Shared Context MCP Server")
    .version("1.0.0");

program
    .argument('[root]', 'Project root directory (optional)')
    .action((root) => {
        console.error(chalk.bold.blue("Axis MCP Server Starting..."));

        // If root is provided, change CWD
        if (root) {
            const resolvedRoot = path.resolve(root);
            if (fs.existsSync(resolvedRoot)) {
                console.error(chalk.blue(`Setting CWD to: ${resolvedRoot}`));
                process.chdir(resolvedRoot);
            } else {
                console.error(chalk.red(`Error: Project root not found: ${resolvedRoot}`));
                process.exit(1);
            }
        }

        // Locate the bundled server script
        const serverScript = path.resolve(__dirname, "../dist/mcp-server.mjs");

        if (!fs.existsSync(serverScript)) {
            console.error(chalk.red("Error: Server script not found."));
            console.error(chalk.yellow(`Expected at: ${serverScript}`));
            console.error(chalk.gray("Did you run 'npm run build'?"));
            process.exit(1);
        }

        console.error(chalk.gray(`Launching server context...`));

        // Pass through all arguments from the CLI to the underlying server
        const args = [serverScript, ...process.argv.slice(2)];


        const proc = spawn("node", args, {
            stdio: "inherit",
            cwd: process.cwd(),
            env: { ...process.env, FORCE_COLOR: '1' }
        });

        proc.on("close", (code) => {
            if (code !== 0) {
                console.error(chalk.red(`Server process exited with code ${code}`));
            } else {
                console.error(chalk.green("Server stopped gracefully."));
            }
        });

        // Handle signals to cleanup child
        process.on('SIGINT', () => {
            proc.kill('SIGINT');
        });
        process.on('SIGTERM', () => {
            proc.kill('SIGTERM');
        });
    });

program.parse();
