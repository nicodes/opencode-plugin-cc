---
name: setup
description: Check OpenCode installation and authentication and show every directly runnable OpenCode agent.
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
- OpenCode `mode: subagent` agents cannot be targeted by `opencode run --agent`; directly invoked agents must use `mode: primary` or `mode: all`.
- Do not ask users to map roles. Every runnable agent remains available through `/opencode:run` and `/opencode:review`.
- Present the final setup report.
