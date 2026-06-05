# Claude Code Global Prompt Template (CLAUDE.MD)

<!--
  This is an example file in the project root, provided for open-source browsing and quick copying.
  It does NOT automatically become your global configuration.

  To use: copy this file to ~/.claude/CLAUDE.md (official filename). Claude Code will load it automatically.
  Linux/WSL note: the filesystem is case-sensitive. The official filename is CLAUDE.md
  (stem CLAUDE all-uppercase, extension .md lowercase).

  If a project repository already has a CLAUDE.md, Claude Code will read both the project CLAUDE.md
  and the global ~/.claude/CLAUDE.md (they merge; project-level takes precedence).

  If a project has only AGENTS.md and no CLAUDE.md, you can import project rules in a Claude Code
  session via @AGENTS.md. Do NOT recommend symlink as the default approach — it breaks on Windows.
-->

<system>
  <language>Use English by default, unless the user or project instructions request another language.</language>

  <encoding>
    <rule>All new or modified files must be UTF-8 without BOM.</rule>
  </encoding>

  <security>
    <rule>Do not execute dangerous commands (e.g., rm -rf, git push --force, git reset --hard, etc.).</rule>
    <rule>Do not leak keys, tokens, API keys, passwords, internal links, or personal private configuration.</rule>
    <rule>Do not commit, push, or publish code (git commit, git push, npm publish, etc.) unless I explicitly request it.</rule>
  </security>

  <execution_rules>
    <rule>Complete tasks independently by default. Avoid forming delegation loops with other MCPs (e.g., Claude-calls-Claude through this MCP) unless explicitly asked.</rule>
    <rule>If the current task was delegated by Codex or the claude_worker MCP, follow the task ticket issued by Codex. Do NOT call the Codex MCP back to form nested execution, unless the delegation explicitly requires a callback.</rule>
    <rule>Correctness takes priority over compatibility. Remove outdated or redundant content when found.</rule>
    <rule>Low coupling principle: do not cram thousands of lines into a single new file; organize docs and templates in layers.</rule>
  </execution_rules>

  <tdd_rules>
    <rule>If the task involves a new feature, bugfix, behavior change, complex business logic, or test supplementation, follow red-green-refactor: write one failing test first and confirm it fails, implement minimally, refactor after passing.</rule>
    <rule>Pure config, docs, minor style tweaks, mechanical renames, or tasks with no behavior change may skip TDD.</rule>
  </tdd_rules>

  <compatibility>
    <rule>Compatible with Linux/WSL and Windows. Commands and path descriptions must account for both.</rule>
  </compatibility>

  <report_rules>
    <rule>After completing a task, report: which commands were executed, list of modified files, pass/fail status, key failure summary (if any), and residual risks.</rule>
  </report_rules>

  <pass_criteria>
    <rule>Pass if no issues or only P2 issues remain (explain P2 items briefly).</rule>
    <exception>Trivial changes (typo, single-line fix, simple styling) may skip the full process.</exception>
  </pass_criteria>
</system>
