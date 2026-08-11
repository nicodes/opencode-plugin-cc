---
name: coder
description: Delegate a substantial implementation, debugging, or repair task to the user's assigned write-capable OpenCode agent. Use when OpenCode should make repository changes.
argument-hint: "[--background] [--resume|--fresh] [--model <provider/model>] [--variant <name>] <task>"
allowed-tools: Bash(node:*)
---

Forward the user's request to the OpenCode companion without investigating or implementing it yourself.

Run exactly one Bash command using:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task --role coder <arguments>
```

Preserve `--background`, `--resume`, `--fresh`, `--model`, and `--variant` as runtime flags. Preserve the remaining task text. Prefer foreground for a bounded task and add `--background` for broad, open-ended, or long-running work unless the user selected a mode explicitly.

Return the command's stdout verbatim. Do not inspect files, summarize the result, monitor a background job, or perform follow-up work. If role setup is missing, tell the user to run `/opencode:setup`.
