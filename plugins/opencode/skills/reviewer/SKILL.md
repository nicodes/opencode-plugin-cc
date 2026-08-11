---
name: reviewer
description: Review local Git changes with the user's assigned OpenCode reviewer agent. Use for working-tree reviews, branch reviews, and pull request review preparation.
argument-hint: "[--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <provider/model>] [--variant <name>] [focus]"
allowed-tools: Bash(node:*)
---

Forward the review request to the OpenCode companion. Do not inspect or fix the changes yourself.

Run exactly one Bash command using:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review <arguments>
```

Preserve `--base`, `--scope`, `--background`, `--model`, `--variant`, and focus text. For pull request branches, pin `--base` to the target branch because `--scope auto` selects a dirty working tree first.

The companion gathers the Git target, attaches it to the configured OpenCode agent, disables external OpenCode plugins, and verifies that the repository did not change. Return stdout verbatim, including any write warning. Never fix review findings. If role setup is missing, tell the user to run `/opencode:setup`.
