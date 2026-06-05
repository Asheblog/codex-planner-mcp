#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  clampInteger,
  discoverJobProcesses,
  ensureState,
  fileInfo,
  findClaudeCommand,
  jobDir,
  listJobIds,
  newJobId,
  nowIso,
  quietMsSince,
  readJson,
  readJsonl,
  toAbsoluteCwd,
  VERSION,
  withLock,
  writeJson,
} from "./shared.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runnerPath = path.join(__dirname, "runner.mjs");
const maxPollWaitMs = clampInteger(
  process.env.CODEX_CLAUDE_WORKER_POLL_MAX_WAIT_MS,
  900_000,
  0,
  3_600_000
);
const ACTIVE_QUIET_GRACE_MS = 5 * 60 * 1000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const POLL_INTERVALS = {
  simple: { minMs: 2 * 60 * 1000, maxMs: 4 * 60 * 1000 },
  medium: { minMs: 4 * 60 * 1000, maxMs: 8 * 60 * 1000 },
  complex: { minMs: 8 * 60 * 1000, maxMs: 15 * 60 * 1000 },
};

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function stripRaw(event, includeRaw) {
  if (includeRaw) return event;
  const { raw, ...rest } = event;
  return rest;
}

async function getSnapshot(jobId) {
  const dir = jobDir(jobId);
  const status = await readJson(path.join(dir, "status.json"), {
    status: "unknown",
  });
  const request = await readJson(path.join(dir, "request.json"), {});
  const events = await readJsonl(path.join(dir, "events.jsonl"));
  const stdout = await fileInfo(path.join(dir, "stdout.jsonl"));
  const stderr = await fileInfo(path.join(dir, "stderr.log"));
  const discovered = await discoverJobProcesses({
    jobId,
    dir,
    runnerPid: status.runnerPid,
    claudePid: status.claudePid,
  });
  const lastActivityAt =
    status.lastEventAt ||
    status.lastStdoutAt ||
    status.lastStderrAt ||
    status.updatedAt ||
    status.startedAt ||
    null;
  const latestResultEvent = [...events].reverse().find((event) => event.type === "result");
  const anyAlive = discovered.processes.some((processInfo) => processInfo.alive);
  const quietMs = quietMsSince(lastActivityAt);
  const activeRecently = quietMs !== null && quietMs < ACTIVE_QUIET_GRACE_MS;
  const effective = deriveEffectiveState({
    status,
    anyAlive,
    activeRecently,
    latestResultEvent,
  });

  return {
    dir,
    request,
    status,
    effective,
    events,
    heartbeat: {
      runner: sanitizeProcess(discovered.runner),
      claude: sanitizeProcess(discovered.claude),
      processes: discovered.processes.map(sanitizeProcess),
      runnerPidAlive: Boolean(discovered.runner.alive),
      claudePidAlive: Boolean(discovered.claude.alive),
      runnerPid: discovered.runner.pid || status.runnerPid || null,
      claudePid: discovered.claude.pid || status.claudePid || null,
      lastActivityAt,
      quietMs,
      activeRecently,
      lastEventAt: status.lastEventAt || null,
      lastStdoutAt: status.lastStdoutAt || null,
      lastStderrAt: status.lastStderrAt || null,
      stdout,
      stderr,
      eventsCount: events.length,
    },
  };
}

function sanitizeProcess(processInfo) {
  return {
    role: processInfo.role,
    pid: processInfo.pid || null,
    alive: Boolean(processInfo.alive),
    verified: Boolean(processInfo.verified),
    reason: processInfo.reason,
    state: processInfo.state,
    ppid: processInfo.ppid ?? null,
    cwd: processInfo.cwd ?? null,
    command: processInfo.command,
    sources: processInfo.sources || [],
  };
}

function deriveEffectiveState({ status, anyAlive, activeRecently, latestResultEvent }) {
  if (latestResultEvent) {
    return {
      status: latestResultEvent.isError ? "failed" : "completed",
      phase: anyAlive ? "result_seen_process_draining" : "terminal",
      isTerminal: !anyAlive,
      source: "result_event",
      resultEvent: latestResultEvent,
    };
  }

  if (anyAlive) {
    const cancelling = status.status === "cancelled" || status.status === "cancelling";
    return {
      status: cancelling ? "cancelling" : "running",
      phase: cancelling ? "cancelling" : "running",
      isTerminal: false,
      source: "process_alive",
    };
  }

  if (TERMINAL_STATUSES.has(status.status)) {
    return {
      status: status.status,
      phase: "terminal",
      isTerminal: true,
      source: "status_file",
    };
  }

  if (status.status === "running" || status.status === "queued" || activeRecently) {
    return {
      status: status.status === "queued" ? "queued" : "running",
      phase: activeRecently ? "activity_without_verified_process" : "process_unknown",
      isTerminal: false,
      source: activeRecently ? "recent_activity" : "status_file",
    };
  }

  return {
    status: status.status || "unknown",
    phase: "unknown",
    isTerminal: false,
    source: "unknown",
  };
}

function buildResult(snapshot) {
  const latest = snapshot.effective.resultEvent;
  return {
    status: snapshot.effective.status,
    phase: snapshot.effective.phase,
    isTerminal: snapshot.effective.isTerminal,
    source: snapshot.effective.source,
    exitCode: snapshot.status.exitCode,
    signal: snapshot.status.signal,
    resultSubtype: latest?.subtype || snapshot.status.resultSubtype,
    sessionId: latest?.sessionId || snapshot.status.resultSessionId,
    resultText: latest?.result || snapshot.status.resultText,
    errors: latest?.errors || snapshot.status.errors,
    error: snapshot.status.error,
    durationMs: latest?.durationMs || snapshot.status.durationMs,
    startedAt: snapshot.status.startedAt,
    completedAt: snapshot.status.completedAt,
    cwd: snapshot.status.cwd || snapshot.request.cwd,
    effort: snapshot.status.effort || snapshot.request.effort,
    permissionMode: snapshot.status.permissionMode || snapshot.request.permissionMode,
  };
}

function classifyTask(prompt = "") {
  const length = prompt.length;
  const complexSignals = [
    "端到端",
    "迁移",
    "数据库",
    "prisma",
    "测试",
    "前端",
    "后端",
    "重构",
    "完整",
    "实现",
    "integration",
    "migration",
    "database",
    "frontend",
    "backend",
    "refactor",
  ];
  const signalCount = complexSignals.filter((signal) =>
    prompt.toLowerCase().includes(signal.toLowerCase())
  ).length;

  if (length > 6000 || signalCount >= 5) return "complex";
  if (length > 1800 || signalCount >= 2) return "medium";
  return "simple";
}

function buildPollPlan({ jobId, prompt, cursor = 0, eventsCount = 0, terminal = false }) {
  const complexity = classifyTask(prompt || "");
  if (terminal) {
    return {
      complexity,
      minMs: 0,
      maxMs: 0,
      suggestedMs: 0,
      reason: "terminal",
    };
  }

  const range = POLL_INTERVALS[complexity];
  const seed = stableHash(`${jobId}:${cursor}:${eventsCount}`);
  const span = range.maxMs - range.minMs;
  const suggestedMs = range.minMs + (seed % Math.max(1, span + 1));
  return {
    complexity,
    minMs: range.minMs,
    maxMs: range.maxMs,
    suggestedMs,
    reason: "token_saving_backoff",
  };
}

function stableHash(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function summarizeEvents(events) {
  const counts = {};
  let lastText = "";
  let lastTool = null;
  let lastError = null;
  let latestResult = null;

  for (const event of events) {
    counts[event.type] = (counts[event.type] || 0) + 1;
    if ((event.type === "assistant" || event.type === "partial") && event.text) {
      lastText = event.text;
    }
    if (event.type === "tool_use" && Array.isArray(event.toolUses) && event.toolUses.length > 0) {
      const tool = event.toolUses[event.toolUses.length - 1];
      lastTool = { name: tool.name, id: tool.id };
    }
    if (event.type === "stderr" || event.type === "error") {
      lastError = truncate(event.text || event.error || "", 240);
    }
    if (event.type === "result") {
      latestResult = {
        subtype: event.subtype,
        isError: event.isError,
        terminalReason: event.terminalReason,
        errors: event.errors,
      };
    }
  }

  return {
    count: events.length,
    counts,
    lastText: truncate(lastText, 240),
    lastTool,
    lastError,
    latestResult,
  };
}

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function shapeHeartbeat(heartbeat, includeProcessDetails) {
  const slimProcess = (processInfo) => {
    const base = {
      role: processInfo.role,
      pid: processInfo.pid,
      alive: processInfo.alive,
      verified: processInfo.verified,
      reason: processInfo.reason,
      state: processInfo.state,
      sources: processInfo.sources,
    };
    return includeProcessDetails
      ? { ...base, ppid: processInfo.ppid, cwd: processInfo.cwd, command: processInfo.command }
      : base;
  };

  return {
    runner: slimProcess(heartbeat.runner),
    claude: slimProcess(heartbeat.claude),
    processes: includeProcessDetails ? heartbeat.processes.map(slimProcess) : undefined,
    runnerPidAlive: heartbeat.runnerPidAlive,
    claudePidAlive: heartbeat.claudePidAlive,
    runnerPid: heartbeat.runnerPid,
    claudePid: heartbeat.claudePid,
    lastActivityAt: heartbeat.lastActivityAt,
    quietMs: heartbeat.quietMs,
    activeRecently: heartbeat.activeRecently,
    lastEventAt: heartbeat.lastEventAt,
    lastStdoutAt: heartbeat.lastStdoutAt,
    lastStderrAt: heartbeat.lastStderrAt,
    stdout: heartbeat.stdout,
    stderr: heartbeat.stderr,
    eventsCount: heartbeat.eventsCount,
  };
}

async function patchStatus(jobId, patch) {
  const dir = jobDir(jobId);
  const current = await readJson(path.join(dir, "status.json"), {});
  await writeJson(path.join(dir, "status.json"), {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  });
}

async function findActiveConflicts({ cwd, resumeSessionId }) {
  const ids = await listJobIds();
  const conflicts = [];
  for (const id of ids) {
    const snapshot = await getSnapshot(id).catch(() => null);
    if (!snapshot || snapshot.effective.isTerminal) continue;
    const sameCwd = snapshot.request.cwd === cwd || snapshot.status.cwd === cwd;
    const sameSession =
      resumeSessionId &&
      (snapshot.request.resumeSessionId === resumeSessionId ||
        snapshot.status.resultSessionId === resumeSessionId);
    if (sameCwd || sameSession) {
      conflicts.push({
        jobId: id,
        status: snapshot.effective.status,
        phase: snapshot.effective.phase,
        cwd: snapshot.request.cwd || snapshot.status.cwd,
        resumeSessionId: snapshot.request.resumeSessionId,
        runnerPid: snapshot.heartbeat.runner.pid,
        claudePid: snapshot.heartbeat.claude.pid,
        reason: sameCwd && sameSession ? "same_cwd_and_session" : sameCwd ? "same_cwd" : "same_session",
      });
    }
  }
  return conflicts;
}

async function startJob(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Input must be an object.");
  }
  if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
    throw new Error("prompt is required.");
  }

  const cwd = toAbsoluteCwd(input.cwd, process.cwd());
  const cwdInfo = await stat(cwd).catch(() => null);
  if (!cwdInfo?.isDirectory()) {
    throw new Error(`cwd does not exist or is not a directory: ${cwd}`);
  }

  const effort = input.effort || "max";
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    throw new Error("effort must be one of low, medium, high, xhigh, max.");
  }

  const permissionMode = input.permissionMode || "bypassPermissions";
  if (!["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"].includes(permissionMode)) {
    throw new Error("permissionMode is invalid.");
  }

  await ensureState();
  return withLock("start", async () => {
    if (input.force !== true) {
      const conflicts = await findActiveConflicts({
        cwd,
        resumeSessionId: input.resumeSessionId,
      });
      if (conflicts.length > 0) {
        throw new Error(
          `Refusing to start: active job exists for same cwd/session. Pass force: true only if concurrent edits are intentional. Conflicts: ${JSON.stringify(conflicts)}`
        );
      }
    }

    const jobId = newJobId();
    const dir = jobDir(jobId);
    await mkdir(dir, { recursive: true });

    const request = {
      jobId,
      prompt: input.prompt,
      cwd,
      model: input.model,
      fallbackModel: input.fallbackModel,
      effort,
      permissionMode,
      dangerouslySkipPermissions: input.dangerouslySkipPermissions !== false,
      includePartialMessages: input.includePartialMessages !== false,
      maxTurns: input.maxTurns,
      resumeSessionId: input.resumeSessionId,
      forkSession: input.forkSession === true,
      apiTimeoutMs: input.apiTimeoutMs ? String(input.apiTimeoutMs) : undefined,
      asyncAgentStallTimeoutMs: input.asyncAgentStallTimeoutMs
        ? String(input.asyncAgentStallTimeoutMs)
        : undefined,
      maxRetries: input.maxRetries ? String(input.maxRetries) : undefined,
      env: input.env && typeof input.env === "object" ? input.env : undefined,
      pollPlan: buildPollPlan({ jobId, prompt: input.prompt }),
      createdAt: nowIso(),
    };
    await writeJson(path.join(dir, "request.json"), request);
    await writeJson(path.join(dir, "status.json"), {
      status: "queued",
      phase: "queued",
      createdAt: request.createdAt,
      jobId,
      cwd,
    });
    await writeFile(path.join(dir, "events.jsonl"), "", "utf8");

    const child = spawn(process.execPath, [runnerPath, "--job-dir", dir], {
      cwd: dir,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CODEX_CLAUDE_WORKER_JOB_ID: jobId,
        CODEX_CLAUDE_WORKER_JOB_DIR: dir,
      },
    });
    child.unref();

    await writeFile(path.join(dir, "runner.pid"), `${child.pid}\n`, "utf8");
    const currentStatus = await readJson(path.join(dir, "status.json"), {});
    await writeJson(path.join(dir, "status.json"), {
      ...currentStatus,
      status: currentStatus.status === "running" ? "running" : "queued",
      runnerPid: child.pid,
      updatedAt: nowIso(),
    });

    return {
      jobId,
      status: "queued",
      runnerPid: child.pid,
      cwd,
      pollAfterMs: request.pollPlan.suggestedMs,
      pollPlan: request.pollPlan,
      nextCursor: 0,
      maxTurns: request.maxTurns || null,
    };
  });
}

async function pollJob(input) {
  const jobId = input?.jobId;
  if (typeof jobId !== "string") throw new Error("jobId is required.");
  const cursor = clampInteger(input.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
  const waitMs = clampInteger(input.waitMs, 0, 0, maxPollWaitMs);
  const maxEvents = clampInteger(input.maxEvents, 20, 1, 200);
  const includeRaw = input.includeRaw === true;
  const includeEvents = input.includeEvents === true;
  const includeProcessDetails = input.includeProcessDetails === true;
  const returnOnNewEvents = input.returnOnNewEvents === true;

  const started = Date.now();
  let snapshot = await getSnapshot(jobId);

  while (
    waitMs > 0 &&
    !snapshot.effective.isTerminal &&
    Date.now() - started < waitMs &&
    (!returnOnNewEvents || snapshot.events.length <= cursor)
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    snapshot = await getSnapshot(jobId);
  }

  const waitedMs = Date.now() - started;
  let wakeReason;
  if (snapshot.effective.isTerminal) {
    wakeReason = "terminal";
  } else if (returnOnNewEvents && snapshot.events.length > cursor) {
    wakeReason = "new_events";
  } else if (waitMs > 0 && waitedMs >= waitMs) {
    wakeReason = "timeout";
  } else {
    wakeReason = "immediate";
  }

  const allNewEvents = snapshot.events.filter((event) => event.id >= cursor);
  const events = includeEvents
    ? allNewEvents.slice(0, maxEvents).map((event) => stripRaw(event, includeRaw))
    : [];
  const lastReturnedId = events.length > 0 ? events[events.length - 1].id : cursor - 1;
  const nextCursor = includeEvents && allNewEvents.length > maxEvents
    ? lastReturnedId + 1
    : snapshot.events.length;
  const pollPlan = buildPollPlan({
    jobId,
    prompt: snapshot.request.prompt,
    cursor: nextCursor,
    eventsCount: snapshot.events.length,
    terminal: snapshot.effective.isTerminal,
  });

  return {
    jobId,
    status: snapshot.effective.status,
    phase: snapshot.effective.phase,
    nextCursor,
    truncated: includeEvents && allNewEvents.length > maxEvents,
    omittedEvents: includeEvents ? 0 : allNewEvents.length,
    eventSummary: summarizeEvents(allNewEvents),
    pollAfterMs: pollPlan.suggestedMs,
    pollPlan,
    waitedMs,
    wakeReason,
    events: includeEvents ? events : undefined,
    heartbeat: shapeHeartbeat(snapshot.heartbeat, includeProcessDetails),
    result: buildResult(snapshot),
  };
}

async function resultJob(input) {
  const jobId = input?.jobId;
  if (typeof jobId !== "string") throw new Error("jobId is required.");
  const includeEvents = input.includeEvents === true;
  const includeRaw = input.includeRaw === true;
  const includeProcessDetails = input.includeProcessDetails === true;
  const snapshot = await getSnapshot(jobId);
  const pollPlan = buildPollPlan({
    jobId,
    prompt: snapshot.request.prompt,
    eventsCount: snapshot.events.length,
    terminal: snapshot.effective.isTerminal,
  });
  return {
    jobId,
    status: snapshot.effective.status,
    phase: snapshot.effective.phase,
    pollAfterMs: pollPlan.suggestedMs,
    pollPlan,
    heartbeat: shapeHeartbeat(snapshot.heartbeat, includeProcessDetails),
    result: buildResult(snapshot),
    events: includeEvents
      ? snapshot.events.map((event) => stripRaw(event, includeRaw))
      : undefined,
  };
}

async function cancelJob(input) {
  const jobId = input?.jobId;
  if (typeof jobId !== "string") throw new Error("jobId is required.");
  const snapshot = await getSnapshot(jobId);
  const killed = [];
  await patchStatus(jobId, {
    status: snapshot.effective.isTerminal ? snapshot.effective.status : "cancelling",
    phase: snapshot.effective.isTerminal ? "terminal" : "cancelling",
    cancelRequestedAt: nowIso(),
  });

  const killable = snapshot.heartbeat.processes.filter((processInfo) => processInfo.alive);
  const runner = killable.find((processInfo) => processInfo.role === "runner");
  if (runner?.pid) {
    try {
      process.kill(-runner.pid, "SIGTERM");
      killed.push({ pid: -runner.pid, role: "process_group", signal: "SIGTERM" });
    } catch {
      // Fall through to individual process kills below.
    }
  }

  for (const processInfo of killable.sort((a, b) => (a.role === "claude" ? -1 : 1))) {
    if (!processInfo.pid) continue;
    try {
      process.kill(processInfo.pid, "SIGTERM");
      killed.push({ pid: processInfo.pid, role: processInfo.role, signal: "SIGTERM" });
    } catch {
      // The process may have exited between discovery and kill.
    }
  }

  return {
    jobId,
    status: killed.length > 0 ? "cancelling" : snapshot.effective.status,
    killed,
    discovered: snapshot.heartbeat.processes.map((processInfo) => ({
      role: processInfo.role,
      pid: processInfo.pid,
      alive: processInfo.alive,
      reason: processInfo.reason,
      state: processInfo.state,
      sources: processInfo.sources,
    })),
  };
}

async function listJobs(input = {}) {
  const limit = clampInteger(input.limit, 20, 1, 200);
  const ids = await listJobIds();
  const rows = [];
  for (const id of ids) {
    const snapshot = await getSnapshot(id);
    rows.push({
      jobId: id,
      status: snapshot.effective.status,
      phase: snapshot.effective.phase,
      cwd: snapshot.status.cwd || snapshot.request.cwd,
      createdAt: snapshot.request.createdAt || snapshot.status.createdAt,
      updatedAt: snapshot.status.updatedAt,
      runnerPid: snapshot.heartbeat.runner.pid,
      claudePid: snapshot.heartbeat.claude.pid,
      runnerAlive: snapshot.heartbeat.runner.alive,
      claudeAlive: snapshot.heartbeat.claude.alive,
      quietMs: snapshot.heartbeat.quietMs,
      eventsCount: snapshot.heartbeat.eventsCount,
      resultSessionId: snapshot.status.resultSessionId,
    });
  }
  rows.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return { jobs: rows.slice(0, limit), total: rows.length };
}

async function doctor() {
  const command = findClaudeCommand();
  const version = await new Promise((resolve) => {
    execFile(command, ["--version"], { timeout: 10_000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: error?.message,
      });
    });
  });

  const settingsPath = path.join(process.env.HOME || "", ".claude", "settings.json");
  const settings = existsSync(settingsPath) ? await readJson(settingsPath, {}) : {};
  return {
    version: VERSION,
    claudeCommand: command,
    claudeVersion: version,
    settings: {
      path: settingsPath,
      hasSettings: existsSync(settingsPath),
      defaultMode: settings.permissions?.defaultMode,
      skipDangerousModePermissionPrompt:
        settings.permissions?.skipDangerousModePermissionPrompt === true,
      disableBypassPermissionsMode: settings.permissions?.disableBypassPermissionsMode,
    },
    stateRoot: path.dirname(path.dirname(jobDir("ccw_000000000000000000000000"))),
    maxPollWaitMs,
  };
}

function tools() {
  return [
    {
      name: "claude_worker_start",
      description:
        "Start a long-running Claude Code job in the background. Returns immediately with jobId; poll with claude_worker_poll using cursor. Defaults to --dangerously-skip-permissions and --effort max.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Task prompt for Claude Code." },
          cwd: {
            type: "string",
            description: "Working directory. Relative paths resolve from the MCP server cwd.",
          },
          model: { type: "string", description: "Optional Claude model." },
          fallbackModel: { type: "string", description: "Optional fallback model." },
          effort: {
            type: "string",
            enum: ["low", "medium", "high", "xhigh", "max"],
            default: "max",
          },
          permissionMode: {
            type: "string",
            enum: ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"],
            default: "bypassPermissions",
          },
          dangerouslySkipPermissions: {
            type: "boolean",
            default: true,
            description:
              "When true with bypassPermissions, pass --dangerously-skip-permissions.",
          },
          includePartialMessages: {
            type: "boolean",
            default: true,
            description: "Enable Claude stream-json partial messages for realtime progress.",
          },
          maxTurns: {
            type: "number",
            description:
              "Optional hard cap on Claude agent turns. Omit for normal coding tasks; only set for tests or explicit budget limits.",
          },
          resumeSessionId: { type: "string" },
          forkSession: { type: "boolean" },
          force: {
            type: "boolean",
            default: false,
            description:
              "Allow starting even when another active job has the same cwd or resumeSessionId. Use only when concurrent edits are intentional.",
          },
          apiTimeoutMs: { type: "number", description: "Default 1800000." },
          asyncAgentStallTimeoutMs: { type: "number", description: "Default 1800000." },
          maxRetries: { type: "number", description: "Default 3." },
          env: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Optional environment overrides for the Claude child process.",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "claude_worker_poll",
      description:
        "Long-poll a Claude worker job. By default waits until terminal or timeout to save tokens — no early return on new events. Enable returnOnNewEvents for diagnostic real-time mode. Pass the previous nextCursor as cursor.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string" },
          cursor: { type: "number", default: 0 },
          waitMs: {
            type: "number",
            default: 0,
            description: "Max poll wait in ms. Default 0 returns immediately.",
          },
          maxEvents: { type: "number", default: 20 },
          returnOnNewEvents: {
            type: "boolean",
            default: false,
            description:
              "When true, return as soon as new events arrive (diagnostic/realtime mode). Default false: wait until terminal or timeout to save tokens.",
          },
          includeEvents: {
            type: "boolean",
            default: false,
            description:
              "Default false to save tokens. Set true only when inspecting event details.",
          },
          includeRaw: { type: "boolean", default: false },
          includeProcessDetails: {
            type: "boolean",
            default: false,
            description: "Include process command/cwd details for diagnostics.",
          },
        },
        required: ["jobId"],
      },
    },
    {
      name: "claude_worker_result",
      description: "Return final/current result and heartbeat for a Claude worker job.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string" },
          includeEvents: { type: "boolean", default: false },
          includeRaw: { type: "boolean", default: false },
          includeProcessDetails: { type: "boolean", default: false },
        },
        required: ["jobId"],
      },
    },
    {
      name: "claude_worker_cancel",
      description: "Terminate a running Claude worker job with SIGTERM.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string" },
        },
        required: ["jobId"],
      },
    },
    {
      name: "claude_worker_list",
      description: "List recent Claude worker jobs.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", default: 20 },
        },
      },
    },
    {
      name: "claude_worker_doctor",
      description: "Check Claude command, version, user dangerous-mode setting, and worker state path.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];
}

async function handleTool(name, input) {
  switch (name) {
    case "claude_worker_start":
      return startJob(input);
    case "claude_worker_poll":
      return pollJob(input);
    case "claude_worker_result":
      return resultJob(input);
    case "claude_worker_cancel":
      return cancelJob(input);
    case "claude_worker_list":
      return listJobs(input);
    case "claude_worker_doctor":
      return doctor();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function main() {
  if (process.argv.includes("--doctor")) {
    console.log(JSON.stringify(await doctor(), null, 2));
    return;
  }

  const server = new Server(
    {
      name: "codex-claude-worker",
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "Use claude_worker_start for long Claude Code jobs, then poll by cursor with claude_worker_poll. Do not wait in one call for long tasks; use heartbeat to distinguish quiet-but-alive from failed.",
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return textResult(await handleTool(request.params.name, request.params.arguments || {}));
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                isError: true,
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

await main();
