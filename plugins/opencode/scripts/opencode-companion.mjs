#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import {
  captureRepositoryFingerprint,
  collectReviewContext,
  isGitRepository,
  resolveReviewTarget
} from "./lib/git.mjs";
import {
  getOpenCodeAuth,
  getOpenCodeAvailability,
  listOpenCodeAgents,
  runOpenCode,
  validateRoleAssignments
} from "./lib/opencode.mjs";
import { getProcessIdentity, terminateProcessTree } from "./lib/process.mjs";
import {
  appendJobLog,
  generateJobId,
  getConfig,
  listJobs,
  readJob,
  resolveJobLog,
  saveConfig,
  updateJob,
  writeJob
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { removeReviewTemporaryDirectory } from "./lib/temporary.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SESSION_ID_ENV = "OPENCODE_COMPANION_SESSION_ID";
const ACTIVE_STATUSES = new Set(["queued", "running"]);
const ROLES = new Set(["coder", "explorer", "reviewer"]);

function usage() {
  return [
    "Usage:",
    "  opencode-companion.mjs setup [--json]",
    "  opencode-companion.mjs configure --coder <agent> --explorer <agent> --reviewer <agent> [--json]",
    "  opencode-companion.mjs task --role <coder|explorer> [--background] [--resume|--fresh] [--model <id>] [--variant <name>] <prompt>",
    "  opencode-companion.mjs review [--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <id>] [--variant <name>] [focus]",
    "  opencode-companion.mjs status [job-id] [--wait] [--all] [--json]",
    "  opencode-companion.mjs result [job-id] [--json]",
    "  opencode-companion.mjs cancel [job-id] [--json]"
  ].join("\n");
}

function commandInput(argv, config = {}) {
  return parseArgs(argv, {
    ...config,
    aliases: { C: "cwd", m: "model", ...(config.aliases ?? {}) }
  });
}

function cwdFrom(options) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function output(payload, rendered, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
}

function now() {
  return new Date().toISOString();
}

function shorten(value, limit = 96) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function sessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function setupReport(cwd) {
  const availability = getOpenCodeAvailability(cwd);
  const config = getConfig(cwd);
  if (!availability.available) {
    return {
      ready: false,
      opencode: availability,
      auth: { ready: false, configuredProviders: false, detail: "Skipped because OpenCode is unavailable." },
      agents: [],
      runnableAgents: [],
      config,
      assignmentErrors: ["OpenCode is unavailable."]
    };
  }
  const auth = getOpenCodeAuth(cwd);
  let agents = [];
  let agentError = null;
  try {
    agents = listOpenCodeAgents(cwd);
  } catch (error) {
    agentError = error instanceof Error ? error.message : String(error);
  }
  const assignmentErrors = agentError ? [agentError] : validateRoleAssignments(agents, config.roles ?? {});
  return {
    ready: availability.available && auth.ready && assignmentErrors.length === 0,
    opencode: availability,
    auth,
    agents,
    runnableAgents: agents.filter((agent) => agent.runnable),
    config,
    assignmentErrors
  };
}

function renderSetup(report) {
  const assignments = ["coder", "explorer", "reviewer"]
    .map((role) => `${role}: ${report.config.roles?.[role] ?? "not assigned"}`)
    .join("\n");
  const available = report.runnableAgents.map((agent) => `${agent.name} (${agent.mode})`).join("\n") || "none";
  return [
    `OpenCode: ${report.opencode.available ? report.opencode.detail : "not installed"}`,
    `Authentication: ${report.auth.configuredProviders ? "credentials-file provider detected" : report.auth.detail}`,
    "",
    "Role assignments:",
    assignments,
    "",
    "Runnable agents:",
    available,
    "",
    report.ready ? "OpenCode Companion is ready." : `Setup required: ${report.assignmentErrors.join("; ")}`
  ].join("\n");
}

function handleSetup(argv) {
  const { options } = commandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const report = setupReport(cwdFrom(options));
  output(report, renderSetup(report), options.json);
}

function handleConfigure(argv) {
  const { options } = commandInput(argv, {
    valueOptions: ["cwd", "coder", "explorer", "reviewer"],
    booleanOptions: ["json"]
  });
  const cwd = cwdFrom(options);
  const roles = { coder: options.coder, explorer: options.explorer, reviewer: options.reviewer };
  const agents = listOpenCodeAgents(cwd);
  const errors = validateRoleAssignments(agents, roles);
  if (errors.length > 0) {
    throw new Error(`Invalid role assignments: ${errors.join("; ")}`);
  }
  const config = saveConfig(cwd, { version: 1, roles });
  const payload = { ready: true, config, agents: agents.filter((agent) => agent.runnable) };
  output(payload, `Saved OpenCode role assignments.\ncoder: ${roles.coder}\nexplorer: ${roles.explorer}\nreviewer: ${roles.reviewer}`, options.json);
}

function configuredAgent(cwd, role) {
  if (!ROLES.has(role)) {
    throw new Error(`Unknown role "${role}".`);
  }
  const config = getConfig(cwd);
  const name = config.roles?.[role];
  if (!name) {
    throw new Error(`No OpenCode agent is assigned to ${role}. Run /opencode:setup.`);
  }
  const errors = validateRoleAssignments(listOpenCodeAgents(cwd), { coder: role === "coder" ? name : config.roles.coder, explorer: role === "explorer" ? name : config.roles.explorer, reviewer: role === "reviewer" ? name : config.roles.reviewer })
    .filter((error) => error.startsWith(role));
  if (errors.length > 0) {
    throw new Error(`${errors[0]}. Run /opencode:setup to update the mapping.`);
  }
  return name;
}

function latestRoleSession(cwd, role, excludeId = null) {
  const currentSession = sessionId();
  const candidate = listJobs(cwd).find((job) =>
    job.id !== excludeId &&
    job.role === role &&
    job.openCodeSessionId &&
    !ACTIVE_STATUSES.has(job.status) &&
    (!currentSession || job.claudeSessionId === currentSession)
  );
  if (!candidate) {
    throw new Error(`No completed ${role} session is available to resume in this workspace.`);
  }
  return candidate.openCodeSessionId;
}

function progressReporter(cwd, jobId, foreground) {
  return (event) => {
    if (event.message) {
      appendJobLog(cwd, jobId, event.message);
      if (foreground) {
        process.stderr.write(`[opencode] ${event.message}\n`);
      }
    }
    const patch = {};
    if (event.phase) {
      patch.phase = event.phase;
    }
    if (event.sessionId) {
      patch.openCodeSessionId = event.sessionId;
    }
    if (Object.keys(patch).length > 0) {
      const job = readJob(cwd, jobId);
      if (job && ACTIVE_STATUSES.has(job.status)) {
        updateJob(cwd, jobId, patch);
      }
    }
  };
}

function reconcileStaleJobs(cwd) {
  for (const job of listJobs(cwd).filter((candidate) => candidate.background && ACTIVE_STATUSES.has(candidate.status))) {
    const age = Date.now() - Date.parse(job.createdAt ?? "");
    if (job.status === "queued" && (!job.pid || !job.processIdentity) && Number.isFinite(age) && age < 10000) {
      continue;
    }
    if (!job.pid || !job.processIdentity || getProcessIdentity(job.pid) !== job.processIdentity) {
      removeReviewTemporaryDirectory(job.temporaryDirectory);
      updateJob(cwd, job.id, {
        status: "failed",
        phase: "failed",
        pid: null,
        processIdentity: null,
        temporaryDirectory: null,
        completedAt: now(),
        errorMessage: "The background worker exited without recording a result.",
        request: undefined
      });
    }
  }
}

function renderExecution(role, result, changed, verificationError) {
  const parts = [];
  if (verificationError) {
    parts.push(`WARNING: The ${role} run completed, but the Git repository could not be verified afterward: ${verificationError}`);
  }
  if (changed) {
    parts.push(`WARNING: The ${role} run changed the Git repository despite being treated as read-only.`);
  }
  if (result.finalMessage) {
    parts.push(result.finalMessage);
  }
  if (result.classification) {
    parts.push(`OpenCode error: ${result.classification.detail}`);
  }
  if (result.sessionId) {
    parts.push(`OpenCode session ID: ${result.sessionId}`);
    parts.push(`Resume in OpenCode: opencode --session ${result.sessionId}`);
  }
  return parts.join("\n\n");
}

async function executeRequest(cwd, jobId, request, foreground) {
  const role = request.role;
  const agent = configuredAgent(cwd, role);
  const resumeSessionId = request.resume ? latestRoleSession(cwd, role, jobId) : null;
  const readOnly = role === "explorer" || role === "reviewer";
  const verifyRepository = readOnly && isGitRepository(cwd);
  const before = verifyRepository ? captureRepositoryFingerprint(cwd) : null;
  let temporaryDirectory = null;
  let files = [];
  let prompt = request.prompt;

  if (role === "reviewer") {
    const target = resolveReviewTarget(cwd, { base: request.base, scope: request.scope });
    const context = collectReviewContext(target);
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-review-"));
    fs.chmodSync(temporaryDirectory, 0o700);
    const contextFile = path.join(temporaryDirectory, "review-context.md");
    fs.writeFileSync(contextFile, context, { encoding: "utf8", mode: 0o600 });
    updateJob(cwd, jobId, { temporaryDirectory });
    files = [contextFile];
    prompt = [
      `Review the attached Git changes for ${target.label}.`,
      request.prompt ? `Additional focus: ${request.prompt}` : "Review the complete change set.",
      "Report your findings without modifying the repository."
    ].join("\n")
  }

  let result;
  try {
    result = await runOpenCode(resolveWorkspaceRoot(cwd), {
      prompt,
      agent,
      sessionId: resumeSessionId,
      model: request.model,
      variant: request.variant,
      files,
      pure: readOnly,
      onProgress: progressReporter(cwd, jobId, foreground)
    });
  } finally {
    removeReviewTemporaryDirectory(temporaryDirectory);
    const job = readJob(cwd, jobId);
    if (job && ACTIVE_STATUSES.has(job.status)) {
      updateJob(cwd, jobId, { temporaryDirectory: null });
    }
  }
  let after = null;
  let verificationError = null;
  if (verifyRepository) {
    try {
      after = captureRepositoryFingerprint(cwd);
    } catch (error) {
      verificationError = error instanceof Error ? error.message : String(error);
    }
  }
  const changed = Boolean(before && after && before !== after);
  const status = changed || verificationError ? 1 : result.status;
  const rendered = renderExecution(role, result, changed, verificationError);
  return {
    status,
    rendered,
    summary: changed ? `${role} violated the read-only repository contract.` : shorten(result.finalMessage || result.classification?.detail),
    openCodeSessionId: result.sessionId,
    payload: {
      role,
      agent,
      status,
      changedRepository: changed,
      openCodeSessionId: result.sessionId,
      classification: changed
        ? { kind: "read-only-violation", detail: `${role} changed the Git repository.` }
        : verificationError
          ? { kind: "repository-verification-failed", detail: verificationError }
          : result.classification,
      output: result.finalMessage,
      stderr: result.stderr,
      toolCallCount: result.toolCallCount
    }
  };
}

function createJob(cwd, request, background) {
  const timestamp = now();
  const id = generateJobId(request.role);
  const job = {
    id,
    role: request.role,
    kind: request.role === "reviewer" ? "review" : "task",
    status: "queued",
    phase: "queued",
    summary: shorten(request.prompt || `${request.role} request`),
    workspaceRoot: resolveWorkspaceRoot(cwd),
    background,
    claudeSessionId: sessionId(),
    createdAt: timestamp,
    updatedAt: timestamp,
    pid: null,
    logFile: resolveJobLog(cwd, id),
    request
  };
  writeJob(cwd, job);
  appendJobLog(cwd, id, `Queued ${request.role} job.`);
  return job;
}

async function runTracked(cwd, job, foreground) {
  updateJob(cwd, job.id, {
    status: "running",
    phase: "starting",
    pid: foreground ? null : process.pid,
    processIdentity: foreground ? null : getProcessIdentity(process.pid),
    startedAt: now()
  });
  try {
    const execution = await executeRequest(cwd, job.id, job.request, foreground);
    const current = readJob(cwd, job.id);
    if (current?.status === "cancelled") {
      return execution;
    }
    const status = execution.status === 0 ? "completed" : "failed";
    updateJob(cwd, job.id, {
      status,
      phase: status === "completed" ? "done" : "failed",
      pid: null,
      processIdentity: null,
      completedAt: now(),
      summary: execution.summary,
      openCodeSessionId: execution.openCodeSessionId,
      result: execution.payload,
      rendered: execution.rendered,
      request: undefined
    });
    appendJobLog(cwd, job.id, `Job ${status}.`);
    return execution;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = readJob(cwd, job.id);
    if (current?.status !== "cancelled") {
      updateJob(cwd, job.id, { status: "failed", phase: "failed", pid: null, processIdentity: null, completedAt: now(), errorMessage: message, request: undefined });
    }
    appendJobLog(cwd, job.id, `Failed: ${message}`);
    throw error;
  }
}

function spawnWorker(cwd, jobId) {
  const script = path.join(ROOT_DIR, "scripts", "opencode-companion.mjs");
  const gate = `${resolveJobLog(cwd, jobId)}.gate`;
  fs.writeFileSync(gate, "", { mode: 0o600 });
  const child = spawn(process.execPath, [script, "worker", "--cwd", cwd, "--job-id", jobId, "--gate", gate], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  try {
    const current = readJob(cwd, jobId);
    if (current && ACTIVE_STATUSES.has(current.status)) {
      updateJob(cwd, jobId, {
        pid: child.pid ?? null,
        processIdentity: child.pid ? getProcessIdentity(child.pid) : null
      });
    }
  } finally {
    fs.rmSync(gate, { force: true });
  }
}

async function launch(cwd, request, background, json) {
  configuredAgent(cwd, request.role);
  const job = createJob(cwd, request, background);
  if (background) {
    spawnWorker(cwd, job.id);
    const payload = { jobId: job.id, status: "queued", role: job.role, summary: job.summary };
    output(payload, `${request.role} started as ${job.id}. Check /opencode:status ${job.id}.`, json);
    return;
  }
  const execution = await runTracked(cwd, job, true);
  output(execution.payload, execution.rendered, json);
  if (execution.status !== 0) {
    process.exitCode = execution.status;
  }
}

async function handleTask(argv) {
  const { options, positionals } = commandInput(argv, {
    valueOptions: ["cwd", "role", "model", "variant"],
    booleanOptions: ["background", "resume", "fresh", "json"]
  });
  if (!ROLES.has(options.role) || options.role === "reviewer") {
    throw new Error("task --role must be coder or explorer.");
  }
  if (options.resume && options.fresh) {
    throw new Error("Choose either --resume or --fresh.");
  }
  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    throw new Error("Provide a task or research prompt.");
  }
  await launch(cwdFrom(options), {
    role: options.role,
    prompt,
    resume: Boolean(options.resume),
    model: options.model ?? null,
    variant: options.variant ?? null
  }, Boolean(options.background), Boolean(options.json));
}

async function handleReview(argv) {
  const { options, positionals } = commandInput(argv, {
    valueOptions: ["cwd", "base", "scope", "model", "variant"],
    booleanOptions: ["background", "json"]
  });
  await launch(cwdFrom(options), {
    role: "reviewer",
    prompt: positionals.join(" ").trim(),
    base: options.base ?? null,
    scope: options.scope ?? "auto",
    model: options.model ?? null,
    variant: options.variant ?? null,
    resume: false
  }, Boolean(options.background), Boolean(options.json));
}

async function handleWorker(argv) {
  const { options } = commandInput(argv, { valueOptions: ["cwd", "job-id", "gate"] });
  if (!options["job-id"]) {
    throw new Error("worker requires --job-id.");
  }
  const cwd = cwdFrom(options);
  if (options.gate) {
    const expectedGate = `${resolveJobLog(cwd, options["job-id"])}.gate`;
    if (path.resolve(options.gate) !== path.resolve(expectedGate)) {
      throw new Error("Worker received an unexpected start gate path.");
    }
    const deadline = Date.now() + 5000;
    while (fs.existsSync(options.gate) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    fs.rmSync(options.gate, { force: true });
  }
  const job = readJob(cwd, options["job-id"]);
  if (!job?.request) {
    throw new Error(`Job ${options["job-id"]} has no runnable request.`);
  }
  await runTracked(cwd, job, false);
}

function selectJob(cwd, reference, predicate = () => true) {
  const jobs = listJobs(cwd).filter(predicate);
  if (!reference) {
    return jobs[0] ?? null;
  }
  const exact = jobs.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }
  const matches = jobs.filter((job) => job.id.startsWith(reference));
  if (matches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous.`);
  }
  return matches[0] ?? null;
}

function duration(job) {
  const start = Date.parse(job.startedAt ?? job.createdAt ?? "");
  const end = Date.parse(job.completedAt ?? "") || Date.now();
  if (!Number.isFinite(start)) {
    return "-";
  }
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function renderStatus(jobs) {
  if (jobs.length === 0) {
    return "No OpenCode jobs found for this workspace.";
  }
  const rows = jobs.map((job) => `| ${job.id} | ${job.role} | ${job.status} | ${job.phase ?? "-"} | ${duration(job)} | ${String(job.summary ?? "").replace(/\|/g, "\\|")} |`);
  return ["| Job | Role | Status | Phase | Time | Summary |", "|---|---|---|---|---|---|", ...rows].join("\n");
}

async function handleStatus(argv) {
  const { options, positionals } = commandInput(argv, {
    valueOptions: ["cwd", "timeout-ms"],
    booleanOptions: ["wait", "all", "json"]
  });
  const cwd = cwdFrom(options);
  reconcileStaleJobs(cwd);
  const reference = positionals[0] ?? null;
  if (options.wait && !reference) {
    throw new Error("status --wait requires a job id.");
  }
  if (reference && options.wait) {
    const timeout = Number(options["timeout-ms"] ?? 240000);
    if (!Number.isFinite(timeout) || timeout < 0) {
      throw new Error("--timeout-ms must be a finite non-negative number.");
    }
    const deadline = Date.now() + timeout;
    while (true) {
      const job = selectJob(cwd, reference);
      if (!job) {
        throw new Error(`No job found for "${reference}".`);
      }
      if (!ACTIVE_STATUSES.has(job.status) || Date.now() >= deadline) {
        output({ jobs: [job] }, renderStatus([job]), options.json);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const jobs = reference
    ? [selectJob(cwd, reference)].filter(Boolean)
    : listJobs(cwd).filter((job) => options.all || !sessionId() || job.claudeSessionId === sessionId()).slice(0, options.all ? undefined : 8);
  if (reference && jobs.length === 0) {
    throw new Error(`No job found for "${reference}".`);
  }
  output({ jobs }, renderStatus(jobs), options.json);
}

function handleResult(argv) {
  const { options, positionals } = commandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = cwdFrom(options);
  reconcileStaleJobs(cwd);
  const job = selectJob(cwd, positionals[0] ?? null, (candidate) => !ACTIVE_STATUSES.has(candidate.status));
  if (!job) {
    throw new Error("No finished OpenCode job was found.");
  }
  output(job, job.rendered || job.errorMessage || `Job ${job.id} has no stored result.`, options.json);
}

function handleCancel(argv) {
  const { options, positionals } = commandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = cwdFrom(options);
  reconcileStaleJobs(cwd);
  const active = listJobs(cwd).filter((job) => job.background && ACTIVE_STATUSES.has(job.status));
  const reference = positionals[0] ?? null;
  let job;
  if (reference) {
    job = selectJob(cwd, reference, (candidate) => candidate.background && ACTIVE_STATUSES.has(candidate.status));
  } else {
    const scoped = active.filter((candidate) => !sessionId() || candidate.claudeSessionId === sessionId());
    if (scoped.length > 1) {
      throw new Error("Multiple OpenCode jobs are active. Pass a job id.");
    }
    job = scoped[0] ?? null;
  }
  if (!job) {
    throw new Error("No active OpenCode job was found.");
  }
  terminateProcessTree(job.pid, job.processIdentity);
  removeReviewTemporaryDirectory(job.temporaryDirectory);
  const next = updateJob(cwd, job.id, { status: "cancelled", phase: "cancelled", pid: null, processIdentity: null, temporaryDirectory: null, completedAt: now(), errorMessage: "Cancelled by user.", request: undefined });
  appendJobLog(cwd, job.id, "Cancelled by user.");
  output(next, `Cancelled ${job.id}.`, options.json);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  switch (command) {
    case "setup":
      handleSetup(argv);
      return;
    case "configure":
      handleConfigure(argv);
      return;
    case "task":
      await handleTask(argv);
      return;
    case "review":
      await handleReview(argv);
      return;
    case "worker":
      await handleWorker(argv);
      return;
    case "status":
      await handleStatus(argv);
      return;
    case "result":
      handleResult(argv);
      return;
    case "cancel":
      handleCancel(argv);
      return;
    case "help":
    case "--help":
    case undefined:
      process.stdout.write(`${usage()}\n`);
      return;
    default:
      throw new Error(`Unknown command "${command}".\n${usage()}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
