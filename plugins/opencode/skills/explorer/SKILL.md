---
name: explorer
description: Delegate read-only codebase or web research to the user's assigned OpenCode explorer agent. Use for investigation, diagnosis, documentation research, and codebase orientation without changes.
argument-hint: "[--background] [--resume|--fresh] [--model <provider/model>] [--variant <name>] <question>"
allowed-tools: Bash(node:*)
---

Forward the research request to the OpenCode companion without researching it yourself.

Run exactly one Bash command using:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task --role explorer <arguments>
```

Preserve runtime flags and the user's question. Prefer foreground for a narrow question and add `--background` for broad research unless the user selected a mode explicitly. The companion runs the configured agent with external OpenCode plugins disabled and verifies that the Git repository did not change.

Return stdout verbatim. Do not inspect files, summarize, monitor, or perform follow-up work. If role setup is missing, tell the user to run `/opencode:setup`.
