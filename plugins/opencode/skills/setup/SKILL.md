---
name: setup
description: Check OpenCode installation and authentication, discover directly runnable OpenCode agents, and assign agents to the companion's coder, explorer, and reviewer roles.
disable-model-invocation: true
argument-hint: ""
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" setup --json
```

Follow these rules:

- If OpenCode is missing and npm is available, ask once whether to install it with `npm install -g opencode-ai`. Install only after explicit approval, then rerun setup.
- Never run `opencode auth login`. `opencode auth list` cannot detect environment credentials or local providers, so an empty provider list is informational rather than a setup failure. If a delegated run later reports an authentication error, tell the user to type `! opencode auth login`.
- Only agents listed in `runnableAgents` can be assigned. OpenCode `mode: subagent` agents cannot be targeted by `opencode run --agent`; the user must define the assigned agents with `mode: primary` or `mode: all`.
- If setup is already ready, present the report and do not ask questions.
- Otherwise, use one AskUserQuestion call with three questions to select the coder, explorer, and reviewer assignments from `runnableAgents`. The same agent may be assigned more than once.
- Do not infer capabilities from names. The user owns each OpenCode agent's prompt, model, tools, plugins, and permissions.

After the selections, run this with each selected name safely shell-quoted:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" configure --coder <name> --explorer <name> --reviewer <name>
```

Present the final output.
