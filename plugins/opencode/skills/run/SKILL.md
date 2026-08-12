---
name: run
description: Delegate any task to any user-defined OpenCode agent. Use for implementation, research, debugging, planning, documentation, or any custom workflow owned by an OpenCode agent.
argument-hint: "[--agent <name>] [--read-only] [--background] [--resume|--fresh] [--model <provider/model>] [--variant <name>] <prompt>"
allowed-tools: Bash(node:*), AskUserQuestion
---

Forward the user's request to the selected OpenCode agent without doing the work yourself.

If `--agent <name>` is absent, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" agents --json
```

Use AskUserQuestion once to ask which `runnableAgents` entry to invoke. Do not infer capabilities from an agent's name. If there are more options than the question UI can display, include the custom-answer choice so the user can type an exact agent name.

Then run exactly one delegation command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" run --agent <name> <arguments>
```

Preserve `--read-only`, `--background`, `--resume`, `--fresh`, `--model`, `--variant`, and the remaining prompt. Prefer foreground for a bounded task and add `--background` for broad, open-ended, or long-running work unless the user selected a mode explicitly.

`--read-only` disables external OpenCode plugins and verifies that the Git repository did not change. Without it, normal OpenCode configuration and plugins apply.

Return delegation stdout verbatim. Do not inspect files, summarize, monitor, or perform follow-up work.
