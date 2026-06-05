# codex-claude-worker-mcp

English | [简体中文](README.zh-CN.md)

---

Let Codex supervise Claude Code as an async background worker.

This is not another "add a tool to Claude Code" MCP. It works in reverse: it wraps Claude Code as an async execution layer that Codex can start, poll, cancel, and diagnose. Codex handles planning, task decomposition, acceptance criteria, result review, and directing rework; Claude Code handles the actual coding, test running, and failure fixing inside a given repository.

## Why

Letting a single coding agent run a long task end-to-end often causes several problems:

- Context gets flooded with test logs, process output, and intermediate thoughts.
- Long-running tasks occupy the foreground session indefinitely.
- The executor tends to drift further off course following local failures without external review.
- During multi-round rework, it is hard to tell whether the agent is still alive, stuck, or already failed.

`codex-claude-worker-mcp` solves the orchestration problem. It runs Claude Code in the background and exposes the worker lifecycle to Codex:

```text
You / Codex
  |
  | plan, decompose, write acceptance criteria, launch worker
  v
codex-claude-worker-mcp
  |
  | start / poll / cancel / diagnose
  v
Claude Code background process
  |
  | modify code, run tests, report results
  v
Codex reviews diff, tests, and risks; directs rework if needed
```

## How it differs from typical Claude Code MCPs

Most MCPs are designed for **Claude Code calling external tools** — giving Claude access to browsers, databases, Figma, GitHub, documentation systems, etc.

This project is designed for **Codex calling Claude Code**. It does not connect a data source into Claude; it turns Claude Code itself into a background executor.

| Aspect | Typical Claude Code MCP | This project |
|--------|--------------------------|--------------|
| Primary user | Claude Code | Codex |
| Exposed capability | Data sources, browsers, design files, issues, databases, etc. | Claude Code worker lifecycle |
| Task model | The current agent calls tools and continues working | Codex plans, Claude Code executes in background |
| Long task handling | Usually continuous output in a single foreground session | `start` returns jobId immediately; low-frequency long-poll thereafter |
| Cost control | Depends on foreground context and tool output | Hides event details by default; returns summary, heartbeat, and final result only |
| Failure handling | The current agent decides next steps on its own | Codex can externally review diffs/tests, then use resumeSessionId to direct rework |
| Best for | Extending Claude's capabilities | Multi-agent collaboration, long-running coding, supervised execution |

In one sentence: a typical MCP gives Claude a tool; this MCP gives Codex a manageable Claude worker.

## Core advantages

### 1. Codex as the directing layer, Claude Code as the execution layer

Codex excels at structured foreground collaboration: understanding requirements, decomposing tasks, setting constraints, controlling risk, and reviewing worker results. Claude Code excels at long hands-on sessions inside a repository: editing files, running commands, fixing failures from logs.

This separation makes long tasks feel like a small engineering pipeline:

```text
Codex: read code -> write task spec -> dispatch to Claude worker
Claude: implement -> run tests -> report files, commands, risks
Codex: review diff -> spot-check tests -> direct rework or close out
```

### 2. Designed for a cost-optimized model stack

This project's recommended stack:

- **Codex foreground** (planning, task decomposition, review): GPT-5.5 with reasoning/effort `xhigh`. A small number of high-quality planning and review calls.
- **Claude Code background** (execution): DeepSeek V4 Pro with `effort=max`. Long-running coding sessions that do the heavy lifting.

Why this is cost-efficient in this setup:

- The model with higher per-token cost handles only the critical reasoning work — architecture boundaries, acceptance criteria, risk assessment, rework instructions.
- The lower-cost model handles the bulk execution — editing, testing, refining over many turns.
- Codex does not need to consume all execution logs; it only reads worker summaries, key diffs, and verification results.

This is not a claim that one model is strictly better than another; it is about putting capabilities in the right place: the planning layer should be steady, the execution layer should be hands-on, and the review layer should keep distance — while keeping overall cost lower than running a single high-cost model end-to-end.

### 3. Long tasks won't block the foreground session

`claude_worker_start` returns `jobId` and a recommended `pollAfterMs` immediately. Codex can wait as suggested — no need to poll every second.

By default, polls do not return the full event stream. They return:

- Current status
- Heartbeat info
- New event summary
- Next cursor
- Recommended next poll time
- Terminal result

Only enable `includeEvents` when diagnosing anomalies. This is token-friendly for Codex.

### 4. Can tell "quiet but alive" from "dead"

Long coding tasks sometimes produce no new output for minutes. This MCP tracks the runner/Claude PID, stdout/stderr mtime, event count, and last activity time, and tries to distinguish:

- Still running, just temporarily quiet
- Process has exited
- State file is corrupt
- Worker is stuck or unreachable

This is better suited for background tasks than simply waiting for a command to return.

### 5. Supports rework loops

After a worker completes, it returns Claude Code's `sessionId`. Codex can carry `resumeSessionId` into the next round, explicitly stating:

- Which acceptance criteria were not met
- Which behaviors must not be broken
- Which verification commands to re-run
- Which files to focus on

This preserves task continuity better than starting a completely fresh agent.

## When to use

- Large refactors, cross-module migrations, end-to-end feature implementations.
- Bugfixes that need TDD or multiple rounds of test-and-fix.
- Codex needs to design/review first, then hand off a concrete task to Claude Code for execution.
- You want the foreground agent to stay clear-headed, not drowned in long logs.
- You need to manage worker state, cancel tasks, and inspect recent jobs.

## When not to use

- Small changes that take under a minute or two.
- Pure Q&A, pure planning, code review — no actual file changes needed.
- Untrusted repositories or environments where dangerous commands might be run.
- You just want to use a database/browser/Figma MCP directly inside Claude Code. In that case, configure that MCP for Claude Code, not this project.

## Installation

### Prerequisites

- Node.js >= 18
- npm
- Claude Code CLI installed and logged in; `claude --version` must work
- Codex CLI installed

### Global install from this repo

```bash
cd /path/to/codex-claude-worker-mcp
npm install -g .
codex-claude-worker-mcp --doctor
```

### Install from Git or npm

Once published to a public repository:

```bash
npm install -g git+https://<your-git-host>/<owner>/codex-claude-worker-mcp.git
```

If published to npm:

```bash
npm install -g codex-claude-worker-mcp
```

## Configuring Codex

Recommended: install globally for Codex:

```bash
codex mcp add claude_worker -- codex-claude-worker-mcp
```

Or manually edit `~/.codex/config.toml`:

```toml
[mcp_servers.claude_worker]
command = "codex-claude-worker-mcp"
startup_timeout_sec = 20
tool_timeout_sec = 1200
```

`tool_timeout_sec` must exceed the maximum poll wait. The default `CODEX_CLAUDE_WORKER_POLL_MAX_WAIT_MS` is `900000` ms (15 minutes), so `1200` seconds is appropriate here. If you raise the poll max wait to 1 hour, increase `tool_timeout_sec` accordingly.

After configuration, run `/mcp` in Codex and confirm you see `claude_worker` with 6 tools.

## Why not recommended as a default Claude Code MCP

This project's default path is:

```text
Codex -> claude_worker MCP -> Claude Code
```

Not:

```text
Claude Code -> claude_worker MCP -> another Claude Code
```

If you really want Claude Code to call it too, you can add it:

```bash
claude mcp add --scope user claude_worker -- codex-claude-worker-mcp
```

But this creates nested Claude-calls-Claude execution, making permissions, costs, and state management more complex. Not recommended as a default.

## Tool list

| Tool | Purpose |
|------|---------|
| `claude_worker_start` | Start a background Claude Code task; returns `jobId`, `nextCursor`, `pollAfterMs` |
| `claude_worker_poll` | Long-poll status by cursor; token-efficient by default, skips full events |
| `claude_worker_result` | Get current/final result, heartbeat, and optional events |
| `claude_worker_cancel` | Terminate a running worker |
| `claude_worker_list` | View recent jobs |
| `claude_worker_doctor` | Check Claude command, version, permissions, state directory |

## Recommended workflow

### Codex delegation prompt shape

When treating Claude Code as an executor, don't just write "fix this for me." Write an engineering task ticket:

```text
You are working in repository <cwd>.

Goal:
- Fix xxx behavior.

Constraints:
- Use English by default, unless the user or project instructions request another language.
- All files UTF-8 without BOM.
- No dangerous commands; no leaking keys/tokens/internal links.
- Do not commit, push, or publish.
- Compatible with both Linux and Windows.

TDD:
- This is a behavior change; write a failing test first and confirm it fails.
- Implement minimally, then run tests.
- Refactor only after passing.

Acceptance:
- npm test passes.
- Report modified files, executed commands, failure summary, and residual risks.
```

### Codex polling pattern

```text
1. claude_worker_start({ prompt, cwd })
2. Record jobId and nextCursor
3. Wait for the returned pollAfterMs
4. claude_worker_poll({ jobId, cursor: nextCursor, waitMs: pollAfterMs })
5. If not done, wait for the new pollAfterMs and repeat
6. When done, Codex reviews diff, test results, and risks
7. If unsatisfactory, direct rework using resumeSessionId
```

Keep the defaults:

- `includeEvents: false`
- `returnOnNewEvents: false`
- Low-frequency polling per `pollAfterMs`

Only switch on event details when diagnosing.

## Permissions and security

By default, workers start with:

```json
{
  "permissionMode": "bypassPermissions",
  "dangerouslySkipPermissions": true,
  "effort": "max",
  "includePartialMessages": true
}
```

This suits high-trust, locally isolated environments where you explicitly want Claude Code to complete long tasks autonomously. It also means higher risk: Claude Code may not pause to ask you before every action.

For a conservative mode:

```json
{
  "prompt": "your task",
  "permissionMode": "default",
  "dangerouslySkipPermissions": false
}
```

Regardless of mode, it is strongly recommended to write into Codex global `~/.codex/AGENTS.md` and Claude global `~/.claude/CLAUDE.md`:

- No dangerous commands.
- No commit, push, or publish.
- No leaking keys, tokens, internal links, or personal configuration.
- Use TDD for new features, bugfixes, or behavior changes.
- After completion, the worker must report commands, results, modified files, and residual risks.

Templates (root directory = quick-start; `examples/` = detailed):

- `AGENTS.MD` — root Codex global prompt template
- `CLAUDE.MD` — root Claude Code global prompt template
- `examples/codex/AGENTS.md` — detailed Codex example
- `examples/codex/config.toml` — Codex MCP config example
- `examples/claude/CLAUDE.md` — detailed Claude Code example
- `examples/claude/settings.json` — Claude Code permissions example

## Global prompt templates

The project root provides two `.MD` template files for easy browsing and quick copying:

| File | Purpose | Effective location |
|------|---------|-------------------|
| `AGENTS.MD` | Codex global prompt template | Copy to `~/.codex/AGENTS.md` |
| `CLAUDE.MD` | Claude Code global prompt template | Copy to `~/.claude/CLAUDE.md` |

**Notes:**

- Root files do not take effect automatically. You must copy them to the corresponding global directories for Codex / Claude Code to load them.
- Linux/WSL are case-sensitive. After copying, use the official filenames (`AGENTS.md` / `CLAUDE.md`), which differ from the root `.MD` uppercase suffix.
- The `examples/` directory contains more detailed reference templates with richer configuration examples. The root files are "at-a-glance quick-start" versions, concentrating core rules and copy instructions for immediate use.
- If your project repository has only `AGENTS.md` and no `CLAUDE.md`, you can import project rules in a Claude Code session via `@AGENTS.md`.

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CODEX_CLAUDE_WORKER_STATE_DIR` | Worker state directory | `~/.local/state/codex-claude-worker-mcp` |
| `CODEX_CLAUDE_WORKER_POLL_MAX_WAIT_MS` | Max single poll wait | `900000`, cap `3600000` |
| `CLAUDE_CLI_PATH` | Full path to Claude CLI | Auto-detected |
| `CLAUDE_CLI_NAME` | Claude CLI command name | `claude` |

On Windows, if `claude` is not found, ensure the npm global bin directory is in PATH, or explicitly set `CLAUDE_CLI_PATH` to point to `claude.cmd`.

## Verification

```bash
npm run doctor
npm run regression
```

`doctor` checks:

- Whether Claude CLI is available
- Claude Code version
- Permission configuration in `~/.claude/settings.json`
- Worker state directory
- Poll max wait configuration

`regression` uses a fake Claude — no real Claude API calls. Suitable for quick self-checks before open-sourcing.

Real end-to-end smoke test:

```bash
npm run smoke /path/to/test-repo
```

This command calls the real Claude Code. Recommended only inside a trusted test repository.

## FAQ

**Is this a Claude Code replacement?**

No. It depends on the Claude Code CLI. It just turns Claude Code into a background worker that Codex can manage.

**Is this stronger than using Claude Code directly?**

Not stronger in a single-point sense, but more stable as a process. Separating "planner" and "executor" for long tasks lets Codex maintain an external review perspective while Claude Code focuses on execution.

**Is the GPT-5.5 + DeepSeek V4 Pro stack required?**

No. It is the recommended cost-optimized combination this project is designed around: Codex (GPT-5.5, `xhigh`) handles planning and review; Claude Code (DeepSeek V4 Pro, `effort=max`) handles execution. You can use other model configurations with Codex. The key design: the foreground model handles high-quality planning and review; the background Claude Code handles execution — and the split itself is what this MCP enables.

**Why not return full events by default?**

Because long tasks generate many events, and returning them all would consume massive context. The default returns summaries; enable `includeEvents` only when diagnosing.

**Is the worker dead if there is no output?**

Not necessarily. Check `heartbeat` first: runner/Claude PID, lastActivityAt, stdout/stderr mtime, and eventsCount all help determine whether it is quiet, stuck, or already exited.

## Official documentation

- [Codex manual](https://developers.openai.com/codex/codex-manual.md)
- [Claude Code memory / CLAUDE.md](https://docs.anthropic.com/en/docs/claude-code/memory)
- [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings)
- [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)

## License

MIT
