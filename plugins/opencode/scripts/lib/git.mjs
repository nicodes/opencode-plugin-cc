import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runCommand, runCommandChecked } from "./process.mjs";

const GIT_BUFFER = 64 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;
const MAX_UNTRACKED_CONTEXT_FILES = 100;
const MAX_UNTRACKED_CONTEXT_BYTES = 8 * 1024 * 1024;
const FINGERPRINT_SAMPLE_BYTES = 64 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, maxBuffer: GIT_BUFFER, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, maxBuffer: GIT_BUFFER, ...options });
}

function lines(value) {
  return value.trim().split(/\r?\n/).filter(Boolean);
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.error?.code === "ENOENT") {
    throw new Error("Git is not installed.");
  }
  if (result.status !== 0) {
    throw new Error("The reviewer must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function isGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return !result.error && result.status === 0 && result.stdout.trim() === "true";
}

function resolveCommit(cwd, reference) {
  return gitChecked(cwd, ["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    return symbolic.stdout.trim().replace(/^refs\/remotes\/origin\//, "origin/");
  }
  for (const name of ["main", "master", "trunk"]) {
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).status === 0) {
      return name;
    }
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${name}`]).status === 0) {
      return `origin/${name}`;
    }
  }
  throw new Error("Unable to detect the default branch. Pass --base <ref>.");
}

export function workingTreeState(cwd) {
  const staged = lines(gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout);
  const unstaged = lines(gitChecked(cwd, ["diff", "--name-only"]).stdout);
  const untracked = lines(gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout);
  return { staged, unstaged, untracked, dirty: staged.length + unstaged.length + untracked.length > 0 };
}

export function resolveReviewTarget(cwd, options = {}) {
  const root = ensureGitRepository(cwd);
  const scope = options.scope ?? "auto";
  if (!["auto", "working-tree", "branch"].includes(scope)) {
    throw new Error("--scope must be auto, working-tree, or branch.");
  }
  if (options.base) {
    return {
      root,
      mode: "branch",
      base: options.base,
      baseCommit: resolveCommit(root, options.base),
      label: `branch against ${options.base}`
    };
  }
  if (scope === "working-tree" || (scope === "auto" && workingTreeState(root).dirty)) {
    return { root, mode: "working-tree", base: null, label: "working tree" };
  }
  const base = detectDefaultBranch(root);
  return { root, mode: "branch", base, baseCommit: resolveCommit(root, base), label: `branch against ${base}` };
}

function section(title, body) {
  return `## ${title}\n\n${body.trim() || "(none)"}\n`;
}

function untrackedContent(root, files) {
  let includedBytes = 0;
  const selected = files.slice(0, MAX_UNTRACKED_CONTEXT_FILES);
  const content = selected.map((file) => {
    const absolute = path.join(root, file);
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) {
        return `### ${file}\n(skipped: not a regular file)`;
      }
      if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
        return `### ${file}\n(skipped: ${stat.size} bytes)`;
      }
      if (includedBytes + stat.size > MAX_UNTRACKED_CONTEXT_BYTES) {
        return `### ${file}\n(skipped: total untracked context limit reached)`;
      }
      const descriptor = fs.openSync(absolute, "r");
      const buffer = Buffer.alloc(stat.size);
      try {
        const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
        if (bytesRead !== buffer.length) {
          return `### ${file}\n(skipped: file changed while reading)`;
        }
      } finally {
        fs.closeSync(descriptor);
      }
      includedBytes += buffer.length;
      if (buffer.includes(0)) {
        return `### ${file}\n(skipped: binary file)`;
      }
      return `### ${file}\n\n\`\`\`\n${buffer.toString("utf8").trimEnd()}\n\`\`\``;
    } catch {
      return `### ${file}\n(skipped: unreadable)`;
    }
  });
  if (files.length > selected.length) {
    content.push(`(${files.length - selected.length} additional untracked files omitted)`);
  }
  return content.join("\n\n");
}

function hashFileSample(hash, file) {
  const stat = fs.statSync(file);
  hash.update(`${stat.size}:${stat.mtimeMs}`);
  if (!stat.isFile()) {
    return;
  }
  if (stat.size <= FINGERPRINT_SAMPLE_BYTES * 2) {
    hash.update(fs.readFileSync(file));
    return;
  }
  const descriptor = fs.openSync(file, "r");
  try {
    const first = Buffer.allocUnsafe(FINGERPRINT_SAMPLE_BYTES);
    const last = Buffer.allocUnsafe(FINGERPRINT_SAMPLE_BYTES);
    fs.readSync(descriptor, first, 0, first.length, 0);
    fs.readSync(descriptor, last, 0, last.length, stat.size - last.length);
    hash.update(first);
    hash.update(last);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function collectReviewContext(target) {
  if (target.mode === "working-tree") {
    const state = workingTreeState(target.root);
    return [
      section("Target", "Uncommitted staged, unstaged, and untracked changes."),
      section("Git Status", gitChecked(target.root, ["status", "--short", "--untracked-files=all"]).stdout),
      section("Staged Diff", gitChecked(target.root, ["diff", "--cached", "--binary", "--no-ext-diff"]).stdout),
      section("Unstaged Diff", gitChecked(target.root, ["diff", "--binary", "--no-ext-diff"]).stdout),
      section("Untracked Files", untrackedContent(target.root, state.untracked))
    ].join("\n");
  }

  const mergeBase = gitChecked(target.root, ["merge-base", "HEAD", target.baseCommit]).stdout.trim();
  const range = `${mergeBase}..HEAD`;
  return [
    section("Target", `Current branch changes relative to ${target.base}. Merge base: ${mergeBase}.`),
    section("Commit Log", gitChecked(target.root, ["log", "--oneline", "--decorate", range]).stdout),
    section("Diff", gitChecked(target.root, ["diff", "--binary", "--no-ext-diff", range]).stdout)
  ].join("\n");
}

export function captureRepositoryFingerprint(cwd) {
  const root = ensureGitRepository(cwd);
  const hash = createHash("sha256");
  for (const args of [
    ["rev-parse", "HEAD"],
    ["status", "--porcelain=v2", "--untracked-files=all"],
    ["diff", "--cached", "--binary", "--no-ext-diff"],
    ["diff", "--binary", "--no-ext-diff"]
  ]) {
    hash.update(args.join("\0"));
    hash.update(gitChecked(root, args).stdout);
  }
  for (const file of lines(gitChecked(root, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout.replace(/\0/g, "\n"))) {
    hash.update(file);
    try {
      hashFileSample(hash, path.join(root, file));
    } catch {
      hash.update("<unreadable>");
    }
  }
  return hash.digest("hex");
}
