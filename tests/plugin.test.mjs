import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(".");

function json(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

test("version metadata stays synchronized", () => {
  const packageVersion = json("package.json").version;
  assert.equal(json("plugins/opencode/.claude-plugin/plugin.json").version, packageVersion);
  const marketplace = json(".claude-plugin/marketplace.json");
  assert.equal(marketplace.metadata.version, packageVersion);
  assert.equal(marketplace.plugins.find((plugin) => plugin.name === "opencode").version, packageVersion);
});

test("plugin exposes seven skills and no Claude subagents", () => {
  const skills = fs.readdirSync(path.join(root, "plugins/opencode/skills"))
    .filter((skill) => fs.existsSync(path.join(root, "plugins/opencode/skills", skill, "SKILL.md")))
    .sort();
  assert.deepEqual(skills, ["agents", "cancel", "result", "review", "run", "setup", "status"]);
  assert.equal(fs.existsSync(path.join(root, "plugins/opencode/agents")), false);
});

test("generic skills select OpenCode agents at runtime", () => {
  for (const skill of ["run", "review"]) {
    const content = fs.readFileSync(path.join(root, "plugins/opencode/skills", skill, "SKILL.md"), "utf8");
    assert.match(content, /opencode-companion\.mjs/);
    assert.match(content, /--agent <name>/);
    assert.doesNotMatch(content, /^model:/m);
    assert.doesNotMatch(content, /^tools:/m);
  }
  const run = fs.readFileSync(path.join(root, "plugins/opencode/skills/run/SKILL.md"), "utf8");
  assert.match(run, /Add `--read-only` by default for research/);
});
