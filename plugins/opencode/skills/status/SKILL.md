---
name: status
description: Show active and recent OpenCode companion jobs for the current workspace or wait for a specific job.
argument-hint: "[job-id] [--wait] [--timeout-ms <ms>] [--all]"
allowed-tools: Bash(node:*)
---

Run exactly one Bash command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status <arguments>
```

Present stdout without adding a second table or summarizing it. Without a job ID, keep the companion's compact table. With a job ID, preserve the complete status.
