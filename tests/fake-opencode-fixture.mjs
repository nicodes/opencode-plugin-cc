import fs from "node:fs";
import path from "node:path";

import { writeExecutable } from "./helpers.mjs";

export function installFakeOpenCode(directory) {
  const binary = path.join(directory, process.platform === "win32" ? "opencode-fake.js" : "opencode");
  const stateFile = path.join(directory, "state.json");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const stateFile = ${JSON.stringify(stateFile)};
function state() {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch { return { nextSession: 1, invocations: [] }; }
}
function save(value) { fs.writeFileSync(stateFile, JSON.stringify(value, null, 2)); }
function value(argv, name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : null; }
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("1.18.16");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "list") {
  if (process.env.FAKE_OPENCODE_BEHAVIOR === "no-auth") process.exit(0);
  console.log("anthropic");
  process.exit(0);
}
if (argv[0] === "agent" && argv[1] === "list") {
  console.log("build (primary)\\n  {}\\ncoder-custom (primary)\\n  {}\\nexplorer-custom (all)\\n  {}\\nreviewer-custom (primary)\\n  {}\\nchild-only (subagent)\\n  {}");
  process.exit(0);
}

const runIndex = argv.indexOf("run");
if (runIndex < 0) {
  console.error("unsupported fake command");
  process.exit(2);
}
const current = state();
const cwd = value(argv, "--dir") || process.cwd();
const existingSession = value(argv, "--session");
const sessionID = existingSession || "ses_fake_" + current.nextSession++;
current.invocations.push({ argv, cwd, agent: value(argv, "--agent"), sessionID, files: argv.filter((item, index) => argv[index - 1] === "--file") });
save(current);

if (process.env.FAKE_OPENCODE_BEHAVIOR === "auth-error") {
  send({ type: "error", sessionID, error: { name: "ProviderAuthError", data: { message: "unauthorized credentials" } } });
  process.exit(1);
}
if (process.env.FAKE_OPENCODE_BEHAVIOR === "write-file") {
  fs.writeFileSync(path.join(cwd, "unexpected.txt"), "changed\\n");
}

send({ type: "step_start", sessionID, part: { type: "step-start" } });
send({ type: "tool_use", sessionID, part: { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "app.js" } } } });
const answer = existingSession ? "Resumed OpenCode session." : "Completed by " + value(argv, "--agent") + ".";
const finish = () => {
  send({ type: "text", sessionID, part: { type: "text", text: answer, time: { end: Date.now() } } });
  send({ type: "step_finish", sessionID, part: { type: "step-finish" } });
};
if (process.env.FAKE_OPENCODE_BEHAVIOR === "slow") setTimeout(finish, 5000);
else finish();
`;
  writeExecutable(binary, source);
  return { binary, stateFile };
}

export function fakeEnvironment(binary, pluginData, extra = {}) {
  return {
    ...process.env,
    OPENCODE_PLUGIN_BIN: binary,
    CLAUDE_PLUGIN_DATA: pluginData,
    OPENCODE_COMPANION_SESSION_ID: "claude-test-session",
    ...extra
  };
}

export function readFakeState(stateFile) {
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}
