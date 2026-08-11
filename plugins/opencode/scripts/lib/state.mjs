import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const MAX_JOBS = 50;
const FALLBACK_ROOT = path.join(os.tmpdir(), "opencode-companion");

function canonicalPath(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

export function resolveStateDir(cwd, env = process.env) {
  const workspace = resolveWorkspaceRoot(cwd);
  const slug = (path.basename(workspace) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const hash = createHash("sha256").update(canonicalPath(workspace)).digest("hex").slice(0, 16);
  const root = env.CLAUDE_PLUGIN_DATA ? path.join(env.CLAUDE_PLUGIN_DATA, "state") : FALLBACK_ROOT;
  return path.join(root, `${slug}-${hash}`);
}

export function resolveConfigFile(cwd, env = process.env) {
  return path.join(resolveStateDir(cwd, env), "config.json");
}

export function resolveJobsDir(cwd, env = process.env) {
  return path.join(resolveStateDir(cwd, env), "jobs");
}

function ensurePrivateDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Windows does not implement POSIX mode bits.
  }
}

function writeJsonAtomic(file, value) {
  ensurePrivateDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function getConfig(cwd, env = process.env) {
  return readJson(resolveConfigFile(cwd, env), { version: 1, roles: {} });
}

export function saveConfig(cwd, config, env = process.env) {
  const next = { version: 1, roles: {}, ...config };
  writeJsonAtomic(resolveConfigFile(cwd, env), next);
  return next;
}

export function generateJobId(kind = "job") {
  return `${kind}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function resolveJobFile(cwd, jobId, env = process.env) {
  return path.join(resolveJobsDir(cwd, env), `${jobId}.json`);
}

export function resolveJobLog(cwd, jobId, env = process.env) {
  return path.join(resolveJobsDir(cwd, env), `${jobId}.log`);
}

export function writeJob(cwd, job, env = process.env) {
  writeJsonAtomic(resolveJobFile(cwd, job.id, env), job);
  pruneJobs(cwd, env);
  return job;
}

export function readJob(cwd, jobId, env = process.env) {
  return readJson(resolveJobFile(cwd, jobId, env));
}

export function listJobs(cwd, env = process.env) {
  const directory = resolveJobsDir(cwd, env);
  let files;
  try {
    files = fs.readdirSync(directory).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((file) => readJson(path.join(directory, file)))
    .filter((job) => job && typeof job.id === "string")
    .sort((left, right) => String(right.updatedAt ?? right.createdAt).localeCompare(String(left.updatedAt ?? left.createdAt)));
}

export function updateJob(cwd, jobId, patch, env = process.env) {
  const current = readJob(cwd, jobId, env);
  if (!current) {
    throw new Error(`No stored job found for ${jobId}.`);
  }
  return writeJob(cwd, { ...current, ...patch, updatedAt: new Date().toISOString() }, env);
}

export function appendJobLog(cwd, jobId, message, env = process.env) {
  const text = String(message ?? "").trim();
  if (!text) {
    return;
  }
  const file = resolveJobLog(cwd, jobId, env);
  ensurePrivateDir(path.dirname(file));
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`, { encoding: "utf8", mode: 0o600 });
}

function pruneJobs(cwd, env) {
  const jobs = listJobs(cwd, env);
  for (const job of jobs.slice(MAX_JOBS)) {
    for (const file of [resolveJobFile(cwd, job.id, env), resolveJobLog(cwd, job.id, env)]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Another process may have pruned the same file.
      }
    }
  }
}
