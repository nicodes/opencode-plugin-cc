#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { listJobs, updateJob } from "./lib/state.mjs";

const SESSION_ID_ENV = "OPENCODE_COMPANION_SESSION_ID";

function hookInput() {
  const value = fs.readFileSync(0, "utf8").trim();
  return value ? JSON.parse(value) : {};
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function persistEnvironment(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || !value) {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellQuote(value)}\n`, "utf8");
}

function endSession(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  if (!sessionId) {
    return;
  }
  for (const job of listJobs(cwd).filter((candidate) => candidate.claudeSessionId === sessionId && ["queued", "running"].includes(candidate.status))) {
    try {
      terminateProcessTree(job.pid);
    } catch {
      // Session shutdown must continue even when a process already exited.
    }
    updateJob(cwd, job.id, {
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      completedAt: new Date().toISOString(),
      errorMessage: "Cancelled when the Claude session ended.",
      request: undefined
    });
  }
}

const input = hookInput();
const event = process.argv[2] || input.hook_event_name;
if (event === "SessionStart") {
  persistEnvironment(SESSION_ID_ENV, input.session_id);
  persistEnvironment("CLAUDE_PLUGIN_DATA", process.env.CLAUDE_PLUGIN_DATA);
} else if (event === "SessionEnd") {
  endSession(input);
}
