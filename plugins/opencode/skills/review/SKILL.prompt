---
name: review
description: Review local Git changes with any user-selected OpenCode agent. Use for working-tree reviews, branch reviews, and pull request review preparation.
argument-hint: "[--agent <name>] [--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <provider/model>] [--variant <name>] [focus]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Forward the review request to the selected OpenCode agent. Do not inspect or fix the changes yourself.

If `--agent <name>` is absent, run the companion's `agents --json` command and use AskUserQuestion once to select a `runnableAgents` entry. Do not infer review capability from names.

Then run exactly one review command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review --agent <name> <arguments>
```

Preserve `--base`, `--scope`, `--background`, `--model`, `--variant`, and focus text. For pull request branches, pin `--base` to the target branch because `--scope auto` selects a dirty working tree first.

Review always disables external OpenCode plugins, attaches bounded Git context, and verifies that the repository did not change. Return stdout verbatim, including any warning. Never fix findings.
