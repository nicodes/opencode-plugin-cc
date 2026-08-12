# opencode-plugin-cc

Delegate Claude Code tasks to your own [OpenCode](https://opencode.ai/) agents.

This plugin does not define or map OpenCode agents. You create and maintain any number of agents in OpenCode, including their prompts, models, tools, plugins, and permissions. Claude Code selects an agent by name at invocation time.

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

4. Check the toolchain and discover agents:

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

The plugin never writes to either location and does not maintain a second agent registry. `/opencode:agents` always reads the current OpenCode configuration.

## Skills

| Skill | Purpose |
|---|---|
| `/opencode:setup` | Check OpenCode installation, authentication visibility, and directly runnable agents. |
| `/opencode:agents` | List every current OpenCode agent and whether the CLI can invoke it directly. |
| `/opencode:run --agent <name> [--read-only] [--background] [--resume\|--fresh] [--model <id>] [--variant <name>] <prompt>` | Run any OpenCode agent. If `--agent` is omitted, Claude asks which one to use. |
| `/opencode:review --agent <name> [--background] [--base <ref>] [--scope auto\|working-tree\|branch] [focus]` | Attach a Git change set to any selected OpenCode agent. |
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

`--resume` continues only the latest tracked session for the same agent name, read-only mode, workspace, and Claude session. A read-only run never resumes a write-capable session, even when both use the same agent.

Reviews collect staged, unstaged, untracked, or branch-diff context with direct Git process arguments and attach it through `opencode run --file`. The plugin does not replace your reviewer's prompt or output format.

`/opencode:run --read-only` and every `/opencode:review` use OpenCode's `--pure` flag, which disables external OpenCode plugins. The selected agent's actual tool and permission policy still comes from OpenCode. The companion fingerprints Git state before and after these runs and fails loudly if tracked, staged, untracked, or committed content changes. This check is detection, not a sandbox; configure agents used for read-only work accordingly.

A normal `/opencode:run` uses normal OpenCode configuration and plugins. The companion never passes `--auto`, so permissions configured as `ask` are rejected by non-interactive OpenCode rather than silently approved.

## Environment

| Variable | Purpose |
|---|---|
| `OPENCODE_PLUGIN_BIN` | Override the `opencode` executable path. Useful for nonstandard installations and tests. |
| `CLAUDE_PLUGIN_DATA` | Claude-managed private data root used for jobs and session metadata. |

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
