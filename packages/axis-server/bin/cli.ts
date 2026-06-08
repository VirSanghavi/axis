#!/usr/bin/env node

import { program } from "commander";
import chalk from "chalk";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from 'url';
import fs from 'fs';
import { indexCodebase } from "../../../src/local/indexer";
import { deriveProjectName, findProjectRoot, resolveProjectIdentity } from "../../../src/local/project-identity";

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

        const identity = resolveProjectIdentity(root, process.cwd());
        if (root && !fs.existsSync(path.resolve(root)) && identity.source !== "runtime") {
            console.error(chalk.red(`Error: Project root not found: ${path.resolve(root)}`));
            process.exit(1);
        }
        if (identity.ignoredConfiguredRoot) {
            console.error(chalk.yellow(
                `Active workspace changed to ${identity.root}; ignoring stale configured root ${identity.ignoredConfiguredRoot}.`
            ));
        }
        console.error(chalk.blue(`Project: ${identity.projectName} (${identity.root})`));
        process.chdir(identity.root);

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
            env: {
                ...process.env,
                PROJECT_NAME: identity.projectName,
                AXIS_PROJECT_ROOT: identity.root,
                FORCE_COLOR: '1'
            }
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

program
    .command("index")
    .description("Index the codebase for search_codebase / deep_search (incremental, content-hashed)")
    .argument("[root]", "Project root to index (default: auto-detected repo root)")
    .option("-p, --project <name>", "Project name (default: auto-detected)")
    .action(async (root: string | undefined, opts: { project?: string }) => {
        const apiKey = process.env.AXIS_API_KEY;
        if (!apiKey) {
            console.error(chalk.red("AXIS_API_KEY is required. Set it in your environment."));
            process.exit(1);
        }
        const apiUrl = process.env.SHARED_CONTEXT_API_URL || "https://useaxis.dev/api/v1";
        const rootDir = findProjectRoot(path.resolve(root || process.cwd()));
        const projectName = opts.project || deriveProjectName(rootDir);

        console.error(chalk.bold.blue(`Indexing "${projectName}"`) + chalk.gray(` (${rootDir})`));
        try {
            const summary = await indexCodebase(apiUrl, apiKey, projectName, rootDir, {
                info: (m) => console.error(chalk.gray(`  ${m}`)),
            });
            console.error(
                chalk.green("✓ done — ") +
                `${summary.uploaded} updated (${summary.chunks} chunks), ${summary.unchanged} unchanged, ${summary.pruned} pruned`
            );
        } catch (e) {
            console.error(chalk.red(`Index failed: ${e instanceof Error ? e.message : String(e)}`));
            process.exit(1);
        }
    });

program.parse();
