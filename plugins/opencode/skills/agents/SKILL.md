---
name: agents
description: List every OpenCode agent available in the current workspace and show which ones can be invoked directly from Claude Code.
argument-hint: ""
allowed-tools: Bash(node:*)
---

Run exactly one Bash command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" agents
```

Present stdout verbatim. Agents configured with OpenCode `mode: subagent` are listed but marked as not directly runnable because `opencode run --agent` accepts only `primary` and `all` agents.
