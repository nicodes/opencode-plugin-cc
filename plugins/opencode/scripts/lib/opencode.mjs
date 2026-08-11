import { spawn } from "node:child_process";
import process from "node:process";
import readline from "node:readline";

import { binaryAvailable, runCommand } from "./process.mjs";

const STDERR_LIMIT = 64 * 1024;
const RAW_OUTPUT_LIMIT = 64 * 1024;
const ANSI_ESCAPE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

class CappedText {
  constructor(limit) {
    this.limit = limit;
    this.value = "";
  }

  append(value) {
    this.value = `${this.value}${value}`.slice(-this.limit);
  }
}

export function opencodeBinary(env = process.env) {
  return env.OPENCODE_PLUGIN_BIN || "opencode";
}

export function getOpenCodeAvailability(cwd, env = process.env) {
  return binaryAvailable(opencodeBinary(env), ["--version"], { cwd, env });
}

export function getOpenCodeAuth(cwd, env = process.env) {
  const result = runCommand(opencodeBinary(env), ["auth", "list"], { cwd, env });
  const providers = result.stdout.replace(ANSI_ESCAPE, "").trim();
  return {
    ready: !result.error && result.status === 0,
    configuredProviders: providers.length > 0,
    detail: (providers || result.stderr.trim() || "No credentials-file providers detected; environment credentials and local providers may still work.").trim()
  };
}

export function parseAgentList(output) {
  const agents = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = line.match(/^(.+?)\s+\((primary|subagent|all)\)\s*$/);
    if (match) {
      agents.push({ name: match[1].trim(), mode: match[2], runnable: match[2] !== "subagent" });
    }
  }
  return agents;
}

export function listOpenCodeAgents(cwd, env = process.env) {
  const result = runCommand(opencodeBinary(env), ["agent", "list"], { cwd, env });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `opencode agent list exited ${result.status}`);
  }
  return parseAgentList(result.stdout);
}

export function validateRoleAssignments(agents, roles) {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  const errors = [];
  for (const role of ["coder", "explorer", "reviewer"]) {
    const name = roles[role];
    if (!name) {
      errors.push(`${role} is not assigned`);
      continue;
    }
    const agent = byName.get(name);
    if (!agent) {
      errors.push(`${role} references unknown agent "${name}"`);
      continue;
    }
    if (!agent.runnable) {
      errors.push(`${role} agent "${name}" uses mode subagent; opencode run --agent requires primary or all`);
    }
  }
  return errors;
}

function describeTool(part) {
  const tool = String(part.tool ?? "tool");
  const input = part.state?.input ?? {};
  if (/bash|shell/i.test(tool)) {
    const command = String(input.command ?? "").trim().replace(/\s+/g, " ");
    const verifying = /\b(test|lint|build|typecheck|check|verify|pytest|jest|vitest|cargo test|go test)\b/i.test(command);
    return { message: command ? `Running command: ${command.slice(0, 120)}` : `Running ${tool}.`, phase: verifying ? "verifying" : "running" };
  }
  if (/edit|write|patch|delete|move/i.test(tool)) {
    return { message: `Applying file change with ${tool}.`, phase: "editing" };
  }
  return { message: `Running ${tool}.`, phase: "investigating" };
}

export function createJsonEventParser(options = {}) {
  const state = {
    sessionId: null,
    finalMessage: "",
    toolCallCount: 0,
    errors: [],
    raw: new CappedText(RAW_OUTPUT_LIMIT)
  };

  function handleLine(line) {
    if (!line.trim()) {
      return;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      state.raw.append(`${line}\n`);
      return;
    }
    if (typeof event.sessionID === "string") {
      state.sessionId = event.sessionID;
      options.onProgress?.({ message: `OpenCode session: ${event.sessionID}`, phase: null, sessionId: event.sessionID });
    }
    if (event.type === "tool_use") {
      state.toolCallCount += 1;
      options.onProgress?.(describeTool(event.part ?? {}));
      return;
    }
    if (event.type === "step_start") {
      options.onProgress?.({ message: "OpenCode started a step.", phase: "investigating" });
      return;
    }
    if (event.type === "step_finish") {
      options.onProgress?.({ message: "OpenCode finished a step.", phase: "finalizing" });
      return;
    }
    if (event.type === "text" && typeof event.part?.text === "string" && event.part.text.trim()) {
      state.finalMessage = event.part.text.trim();
      return;
    }
    if (event.type === "error") {
      const message = event.error?.data?.message ?? event.error?.message ?? event.error?.name ?? "OpenCode reported an error.";
      state.errors.push(String(message));
      return;
    }
    state.raw.append(`${line}\n`);
  }

  function finalize() {
    return {
      sessionId: state.sessionId,
      finalMessage: state.finalMessage || state.raw.value.trim(),
      toolCallCount: state.toolCallCount,
      errors: state.errors,
      rawOutput: state.raw.value
    };
  }

  return { handleLine, finalize };
}

export function buildOpenCodeArgs(options) {
  if (!options.prompt?.trim()) {
    throw new Error("A prompt is required.");
  }
  if (!options.agent?.trim()) {
    throw new Error("An assigned OpenCode agent is required.");
  }
  const args = [];
  if (options.pure) {
    args.push("--pure");
  }
  args.push("run", "--format", "json", "--dir", options.cwd, "--agent", options.agent);
  if (options.sessionId) {
    args.push("--session", options.sessionId);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.variant) {
    args.push("--variant", options.variant);
  }
  for (const file of options.files ?? []) {
    args.push("--file", file);
  }
  args.push(options.prompt);
  return args;
}

export function classifyOpenCodeFailure(status, stderr, error = null) {
  if (error?.code === "ENOENT") {
    return { kind: "not-installed", detail: "OpenCode is not installed. Run /opencode:setup." };
  }
  const detail = String(stderr ?? "").trim();
  if (/unauthorized|forbidden|authentication|auth login|api[ _-]?key|credentials/i.test(detail)) {
    return { kind: "auth", detail: "OpenCode reported an authentication problem. Run `opencode auth login`." };
  }
  return { kind: "error", detail: detail || `OpenCode exited ${status}.` };
}

export async function runOpenCode(cwd, options) {
  const env = options.env ?? process.env;
  const args = buildOpenCodeArgs({ ...options, cwd });
  options.onProgress?.({ message: options.sessionId ? `Resuming OpenCode session ${options.sessionId}.` : `Starting OpenCode agent ${options.agent}.`, phase: "starting" });

  const child = spawn(opencodeBinary(env), args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true
  });
  const parser = createJsonEventParser({ onProgress: options.onProgress });
  const stderr = new CappedText(STDERR_LIMIT);
  const stdoutDone = new Promise((resolve) => {
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", parser.handleLine);
    lines.on("close", resolve);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.append(chunk));

  const completed = await new Promise((resolve) => {
    let settled = false;
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        resolve({ status: 1, error });
      }
    });
    child.on("close", (status) => {
      if (!settled) {
        settled = true;
        resolve({ status: status ?? 1, error: null });
      }
    });
  });
  await stdoutDone;
  const parsed = parser.finalize();
  const failure = completed.status === 0 && parsed.errors.length === 0 ? null : classifyOpenCodeFailure(completed.status || 1, [...parsed.errors, stderr.value].filter(Boolean).join("\n"), completed.error);
  if (!failure && !parsed.finalMessage) {
    return { status: 1, classification: { kind: "error", detail: "OpenCode produced no final text response." }, stderr: stderr.value, ...parsed };
  }
  return {
    status: failure ? completed.status || 1 : 0,
    classification: failure,
    stderr: stderr.value,
    ...parsed
  };
}
