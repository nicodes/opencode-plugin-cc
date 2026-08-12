import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenCodeArgs,
  createJsonEventParser,
  parseAgentList,
  runOpenCode,
  validateAgentSelection
} from "../plugins/opencode/scripts/lib/opencode.mjs";
import { fakeEnvironment, installFakeOpenCode, readFakeState } from "./fake-opencode-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

test("parseAgentList identifies directly runnable agents", () => {
  const agents = parseAgentList("writer (primary)\n  {}\nresearch (all)\n  {}\nchild (subagent)\n  {}");
  assert.deepEqual(agents, [
    { name: "writer", mode: "primary", runnable: true },
    { name: "research", mode: "all", runnable: true },
    { name: "child", mode: "subagent", runnable: false }
  ]);
});

test("validateAgentSelection accepts any runnable agent and rejects invalid selections", () => {
  const agents = parseAgentList("writer (primary)\nchild (subagent)");
  assert.equal(validateAgentSelection(agents, "writer").name, "writer");
  assert.throws(() => validateAgentSelection(agents, "child"), /mode subagent/);
  assert.throws(() => validateAgentSelection(agents, "missing"), /was not found/);
  assert.throws(() => validateAgentSelection(agents, ""), /--agent/);
});

test("buildOpenCodeArgs selects a configured agent without injecting agent config", () => {
  assert.deepEqual(buildOpenCodeArgs({
    cwd: "/work",
    prompt: "do it",
    agent: "my-writer",
    pure: true,
    sessionId: "ses_1",
    model: "openai/gpt-5",
    variant: "high",
    files: ["/tmp/context.md"]
  }), [
    "--pure", "run", "--format", "json", "--dir", "/work", "--agent", "my-writer",
    "--session", "ses_1", "--model", "openai/gpt-5", "--variant", "high", "--file", "/tmp/context.md", "--", "do it"
  ]);
});

test("event parser captures session, tools, and final text", () => {
  const parser = createJsonEventParser();
  parser.handleLine(JSON.stringify({ type: "tool_use", sessionID: "ses_1", part: { tool: "bash", state: { input: { command: "npm test" } } } }));
  parser.handleLine(JSON.stringify({ type: "text", sessionID: "ses_1", part: { text: "finished" } }));
  const parsed = parser.finalize();
  assert.equal(parsed.sessionId, "ses_1");
  assert.equal(parsed.toolCallCount, 1);
  assert.equal(parsed.finalMessage, "finished");
});

test("runOpenCode executes the selected agent and resumes its session", async () => {
  const bin = makeTempDir();
  const pluginData = makeTempDir();
  const work = makeTempDir();
  const fake = installFakeOpenCode(bin);
  const env = fakeEnvironment(fake.binary, pluginData);

  const first = await runOpenCode(work, { prompt: "task", agent: "coder-custom", env });
  assert.equal(first.status, 0);
  assert.equal(first.sessionId, "ses_fake_1");
  assert.match(first.finalMessage, /coder-custom/);

  const resumed = await runOpenCode(work, { prompt: "continue", agent: "coder-custom", sessionId: first.sessionId, env });
  assert.equal(resumed.status, 0);
  assert.match(resumed.finalMessage, /Resumed/);
  const invocations = readFakeState(fake.stateFile).invocations;
  assert.equal(invocations[1].agent, "coder-custom");
  assert.ok(invocations[1].argv.includes("--session"));
});

test("runOpenCode classifies provider authentication failures", async () => {
  const bin = makeTempDir();
  const pluginData = makeTempDir();
  const work = makeTempDir();
  const fake = installFakeOpenCode(bin);
  const env = fakeEnvironment(fake.binary, pluginData, { FAKE_OPENCODE_BEHAVIOR: "auth-error" });
  const result = await runOpenCode(work, { prompt: "task", agent: "coder-custom", env });
  assert.equal(result.status, 1);
  assert.equal(result.classification.kind, "auth");
  assert.match(result.classification.detail, /authentication problem/);
});
