#!/usr/bin/env node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpClient } from "./mcp-test-client.mjs";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ccw-regression-"));
const binDir = path.join(tempRoot, "bin");
const stateDir = path.join(tempRoot, "state");
const cwd = path.join(tempRoot, "repo");
await mkdir(binDir, { recursive: true });
await mkdir(cwd, { recursive: true });

const fakeClaudePath = path.join(binDir, "fake-claude.mjs");
await writeFile(
  fakeClaudePath,
  `#!/usr/bin/env node
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (process.argv.includes("--version")) {
  console.log("fake-claude 1.0.0");
  process.exit(0);
}
const sessionId = process.env.FAKE_SESSION_ID || "fake-session-1";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), model: "fake", permissionMode: "bypassPermissions", tools: ["Read"] }));
for (let i = 0; i < 20; i += 1) {
  console.log(JSON.stringify({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text: "tick-" + i } } }));
  await sleep(250);
}
console.log(JSON.stringify({ type: "result", subtype: "success", duration_ms: 5000, duration_api_ms: 0, is_error: false, num_turns: 1, stop_reason: "end_turn", session_id: sessionId, total_cost_usd: 0, result: "fake done" }));
`,
  { encoding: "utf8", mode: 0o755 }
);

// ── Client 1: with env override ──────────────────────────────────
const client = createMcpClient({
  CODEX_CLAUDE_WORKER_STATE_DIR: stateDir,
  CLAUDE_CLI_PATH: fakeClaudePath,
  CODEX_CLAUDE_WORKER_POLL_MAX_WAIT_MS: "30000",
});

try {
  await client.init();
  const doctor = await client.callTool("claude_worker_doctor");
  assert(doctor.claudeVersion.ok, "doctor should find fake claude");
  assert(doctor.maxPollWaitMs === 30000, `maxPollWaitMs should reflect env override, got ${doctor.maxPollWaitMs}`);

  // ── Basic start / poll / cancel ──────────────────────────────
  const started = await client.callTool("claude_worker_start", {
    cwd,
    prompt: "fake long task",
    resumeSessionId: "shared-session",
  });
  assert(started.status === "running" || started.status === "queued", "start status should be active");

  let poll = await client.callTool("claude_worker_poll", {
    jobId: started.jobId,
    cursor: 0,
    waitMs: 1000,
    maxEvents: 5,
  });
  assert(poll.status === "running", "poll should report running");
  assert(poll.heartbeat.runner.alive, "runner should be alive");
  assert(poll.heartbeat.claude.alive, "claude should be alive");
  assert(poll.result.status === "running", "non-terminal result should say running");
  assert(!("events" in poll), "default poll should omit event payloads to save tokens");
  assert(poll.omittedEvents > 0, "default poll should report omitted event count");
  assert(typeof poll.waitedMs === "number", "poll should report waitedMs");
  assert(typeof poll.wakeReason === "string", "poll should report wakeReason");
  assert(
    poll.pollAfterMs >= 2 * 60 * 1000 && poll.pollAfterMs <= 15 * 60 * 1000,
    `pollAfterMs should be 2-15 minutes, got ${poll.pollAfterMs}`
  );

  // ── Concurrent protection ────────────────────────────────────
  const blocked = await client.callTool("claude_worker_start", {
    cwd,
    prompt: "should be blocked",
    resumeSessionId: "shared-session",
  }).catch((error) => ({ error: error.message }));
  assert(String(blocked.error || "").includes("active job"), "same cwd/session should be blocked");

  // ── Cancel ───────────────────────────────────────────────────
  const cancelled = await client.callTool("claude_worker_cancel", { jobId: started.jobId });
  assert(cancelled.killed.length > 0, "cancel should kill at least one process");

  let terminal = null;
  let cursor = poll.nextCursor;
  for (let i = 0; i < 20; i += 1) {
    terminal = await client.callTool("claude_worker_poll", {
      jobId: started.jobId,
      cursor,
      waitMs: 500,
    });
    cursor = terminal.nextCursor;
    if (terminal.status === "cancelled" || terminal.status === "failed") break;
  }
  assert(terminal.status === "cancelled", `expected cancelled, got ${terminal.status}`);
  assert(!terminal.heartbeat.runner.alive, "runner should be dead after cancel");

  // ── Default long poll waits for terminal (not new events) ────
  const job2 = await client.callTool("claude_worker_start", {
    cwd,
    prompt: "fake long task",
  });
  // Let events accumulate, then poll with returnOnNewEvents: false
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const pollDefault = await client.callTool("claude_worker_poll", {
    jobId: job2.jobId,
    cursor: 0,
    waitMs: 20000,
    returnOnNewEvents: false,
  });
  assert(
    pollDefault.wakeReason === "terminal",
    `default poll should wait for terminal, got wakeReason=${pollDefault.wakeReason}`
  );
  assert(pollDefault.waitedMs > 1000, `default poll should have waited, got ${pollDefault.waitedMs}ms`);
  assert(pollDefault.status === "completed", `default poll job should complete, got ${pollDefault.status}`);

  // ── returnOnNewEvents: true returns early on new events ──────
  const job3 = await client.callTool("claude_worker_start", {
    cwd,
    prompt: "fake long task",
  });
  const pollRealtime = await client.callTool("claude_worker_poll", {
    jobId: job3.jobId,
    cursor: 0,
    waitMs: 20000,
    returnOnNewEvents: true,
  });
  assert(
    pollRealtime.wakeReason === "new_events" || pollRealtime.wakeReason === "terminal",
    `returnOnNewEvents should wake on new_events or terminal, got ${pollRealtime.wakeReason}`
  );
  assert(
    pollRealtime.waitedMs < 5000,
    `returnOnNewEvents should return quickly, waited ${pollRealtime.waitedMs}ms`
  );
  // Clean up job3 if still running
  if (!pollRealtime.result?.isTerminal) {
    await client.callTool("claude_worker_cancel", { jobId: job3.jobId });
  }

  console.log(JSON.stringify({ ok: true, jobId: started.jobId, job2Id: job2.jobId, stateDir }, null, 2));
} finally {
  client.close();
}

// ── Client 2: env override to 900000 ───────────────────────────
const client2 = createMcpClient({
  CODEX_CLAUDE_WORKER_STATE_DIR: stateDir,
  CLAUDE_CLI_PATH: fakeClaudePath,
  CODEX_CLAUDE_WORKER_POLL_MAX_WAIT_MS: "900000",
});
try {
  await client2.init();
  const doctor2 = await client2.callTool("claude_worker_doctor");
  assert(
    doctor2.maxPollWaitMs === 900000,
    `maxPollWaitMs should accept 900000, got ${doctor2.maxPollWaitMs}`
  );
} finally {
  client2.close();
}

// ── Client 3: verify cap at 1 hour ─────────────────────────────
const client3 = createMcpClient({
  CODEX_CLAUDE_WORKER_STATE_DIR: stateDir,
  CLAUDE_CLI_PATH: fakeClaudePath,
  CODEX_CLAUDE_WORKER_POLL_MAX_WAIT_MS: "9999999",
});
try {
  await client3.init();
  const doctor3 = await client3.callTool("claude_worker_doctor");
  assert(
    doctor3.maxPollWaitMs === 3600000,
    `maxPollWaitMs should cap at 3600000 (1 hour), got ${doctor3.maxPollWaitMs}`
  );
} finally {
  client3.close();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
