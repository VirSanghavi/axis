#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/tsup/assets/cjs_shims.js
var getImportMetaUrl = () => typeof document === "undefined" ? new URL(`file:${__filename}`).href : document.currentScript && document.currentScript.tagName.toUpperCase() === "SCRIPT" ? document.currentScript.src : new URL("main.js", document.baseURI).href;
var importMetaUrl = /* @__PURE__ */ getImportMetaUrl();

// bin/cli.ts
var import_commander = require("commander");
var import_chalk = __toESM(require("chalk"));
var import_child_process = require("child_process");
var import_path = __toESM(require("path"));
var import_url = require("url");
var import_fs = __toESM(require("fs"));
var __filename2 = (0, import_url.fileURLToPath)(importMetaUrl);
var __dirname = import_path.default.dirname(__filename2);
import_commander.program.name("axis-server").description("Start the Axis Shared Context MCP Server").version("1.0.0");
import_commander.program.action(() => {
  console.log(import_chalk.default.bold.blue("Axis MCP Server Starting..."));
  const serverScript = import_path.default.resolve(__dirname, "../dist/mcp-server.mjs");
  if (!import_fs.default.existsSync(serverScript)) {
    console.error(import_chalk.default.red("Error: Server script not found."));
    console.error(import_chalk.default.yellow(`Expected at: ${serverScript}`));
    console.error(import_chalk.default.gray("Did you run 'npm run build'?"));
    process.exit(1);
  }
  console.log(import_chalk.default.gray(`Launching server context...`));
  const args = [serverScript, ...process.argv.slice(2)];
  const proc = (0, import_child_process.spawn)("node", args, {
    stdio: "inherit",
    env: { ...process.env, FORCE_COLOR: "1" }
  });
  proc.on("close", (code) => {
    if (code !== 0) {
      console.log(import_chalk.default.red(`Server process exited with code ${code}`));
    } else {
      console.log(import_chalk.default.green("Server stopped gracefully."));
    }
  });
  process.on("SIGINT", () => {
    proc.kill("SIGINT");
  });
  process.on("SIGTERM", () => {
    proc.kill("SIGTERM");
  });
});
import_commander.program.parse();
