# opencode-plugin-cc

Delegate Claude Code tasks to your own [OpenCode](https://opencode.ai/) agents.

This plugin does not define OpenCode agents. You create and maintain the agents in OpenCode, including their prompts, models, tools, plugins, and permissions. `/opencode:setup` only maps three Claude-facing roles to their OpenCode agent names:

- `coder` for implementation and debugging
- `explorer` for research and investigation
- `reviewer` for Git change reviews

## Install

Requirements: Node.js 18.18 or newer, Git, and a configured OpenCode CLI.

1. Add the marketplace:

   ```text
   /plugin marketplace add nicodes/opencode-plugin-cc
   ```

2. Install the plugin:

   ```text
   /plugin install opencode@opencode-plugin-cc
   ```

3. Reload Claude Code plugins:

   ```text
   /reload-plugins
   ```

4. Assign your OpenCode agents:

   ```text
   /opencode:setup
   ```

OpenCode authentication is interactive. If a delegated run reports missing credentials, type `! opencode auth login` yourself. Setup treats an empty `opencode auth list` as informational because environment credentials and local providers do not necessarily appear there.

## OpenCode Agents

Create agents with OpenCode before running setup:

```bash
opencode agent create
```

Assigned agents must use `mode: primary` or `mode: all`. OpenCode 1.18.16 does not allow `opencode run --agent` to target an agent configured with `mode: subagent`.

Agent definitions normally live in one of these locations:

```text
~/.config/opencode/agents/
.opencode/agents/
```

The plugin never writes to either location. It stores only the selected agent names in Claude's private plugin data directory. If an agent is renamed or removed, rerun `/opencode:setup`.

## Skills

| Skill | Purpose |
|---|---|
| `/opencode:setup` | Check OpenCode, list directly runnable agents, and assign the three roles. |
| `/opencode:coder [--background] [--resume\|--fresh] [--model <id>] [--variant <name>] <task>` | Run the assigned coder agent. |
| `/opencode:explorer [--background] [--resume\|--fresh] [--model <id>] [--variant <name>] <question>` | Run the assigned explorer agent. |
| `/opencode:reviewer [--background] [--base <ref>] [--scope auto\|working-tree\|branch] [focus]` | Attach a Git change set to the assigned reviewer agent. |
| `/opencode:status [job-id] [--wait] [--all]` | List jobs or wait for one job. |
| `/opencode:result [job-id]` | Return a finished job's complete stored output. |
| `/opencode:cancel [job-id]` | Cancel an active background job. |

`--model` and `--variant` are optional per-run overrides. Without them, OpenCode and the selected agent choose the model configuration.

## Behavior

The companion runs one-shot processes using:

```text
opencode run --format json --dir <workspace> --agent <assigned-name> <prompt>
```

It parses OpenCode's NDJSON events, records the session ID, and stores bounded workspace-specific job metadata under `CLAUDE_PLUGIN_DATA`. No persistent HTTP server or listening port is created.

`--resume` continues only the latest tracked session for the same role and Claude session. It never resumes a coder session as an explorer or reviewer session.

Reviews collect staged, unstaged, untracked, or branch-diff context with direct Git process arguments and attach it through `opencode run --file`. The plugin does not replace your reviewer's prompt or output format.

Explorer and reviewer runs use OpenCode's `--pure` flag, which disables external OpenCode plugins. Their actual tool and permission policy still comes from the assigned OpenCode agent. The companion fingerprints Git state before and after these runs and fails loudly if tracked, staged, untracked, or committed content changes. This check is detection, not a sandbox; configure the OpenCode agents themselves as read-only.

The coder runs with normal OpenCode configuration and plugins. The companion never passes `--auto`, so permissions configured as `ask` are rejected by non-interactive OpenCode rather than silently approved.

## Environment

| Variable | Purpose |
|---|---|
| `OPENCODE_PLUGIN_BIN` | Override the `opencode` executable path. Useful for nonstandard installations and tests. |
| `CLAUDE_PLUGIN_DATA` | Claude-managed private data root used for role mappings and jobs. |

## Development

```bash
npm test
npm run check-version
claude plugin validate plugins/opencode --strict
```

The tests use a fake OpenCode executable and require no provider account.

## Verified Compatibility

The runtime behavior is tested against the OpenCode 1.18.16 CLI contract:

- `opencode agent list` exposes each agent's name and mode.
- `opencode run --agent` accepts `primary` and `all` agents, but rejects `subagent` agents.
- `--format json` emits NDJSON `step_start`, `tool_use`, `text`, `step_finish`, and `error` events carrying a `sessionID`.
- `--session <id>` resumes an existing session and can be combined with `--agent`.
- `--pure` disables external plugins without suppressing configured agents.
