# Codex Global Prompt (AGENTS.md)

<!--
  Copy this file to ~/.codex/AGENTS.md as your global prompt.
  For temporary per-repo overrides, create ~/.codex/AGENTS.override.md.
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

  <worker_usage>
    <summary>For coding tasks, prefer delegating to Claude Code via the claude_worker MCP.</summary>

    <when_to_use>
      <rule>For coding tasks expected to take Claude Code more than ~30 seconds, use claude_worker_start to launch a background task.</rule>
      <rule>Pure information lookup, simple Q&A, and short analysis can be done directly — no worker needed.</rule>
      <rule>If no code needs to be written, no worker is needed.</rule>
    </when_to_use>

    <worker_prompt_rules>
      <rule>The delegation prompt MUST repeat all constraints from this file that are relevant to the task.</rule>
      <rule>The delegation prompt MUST include: language preference, UTF-8 without BOM, no dangerous commands / no leaking keys / no commit-push-publish, Linux/Windows compatibility, low coupling.</rule>
      <rule>If the task involves a new feature, bugfix, or behavior change, the delegation prompt MUST require TDD (write failing test first, implement, then refactor).</rule>
    </worker_prompt_rules>

    <poll_rules>
      <rule>After start completes, wait for the returned pollAfterMs before polling — do not poll immediately.</rule>
      <rule>On each poll, use the previous response's nextCursor as the cursor.</rule>
      <rule>Keep includeEvents=false by default to save tokens; only enable when diagnosing anomalies.</rule>
      <rule>Keep returnOnNewEvents=false by default; only enable when real-time observation is needed.</rule>
      <rule>Do not use short-polling (every second) loops that waste tokens.</rule>
    </poll_rules>

    <review_rules>
      <rule>After a worker task completes, Codex MUST review the diff, tests, and risks.</rule>
      <rule>If the worker returns anomalies or errors, diagnose the cause; use claude_worker_doctor to check the environment if needed.</rule>
    </review_rules>
  </worker_usage>

  <pass_criteria>
    <rule>Pass if no issues or only P2 issues remain (explain P2 items briefly).</rule>
    <exception>Trivial changes (typo, single-line fix, simple styling) may skip the full process.</exception>
  </pass_criteria>

  <compatibility>
    <rule>All commands and path descriptions must account for both Linux/WSL and Windows.</rule>
  </compatibility>

  <coupling>
    <rule>Low coupling principle: do not cram large amounts of content into a single file; organize docs and templates in layers.</rule>
  </coupling>
</system>
