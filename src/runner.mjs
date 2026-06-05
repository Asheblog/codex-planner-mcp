#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  findClaudeCommand,
  nowIso,
  readJson,
  writeJson,
} from "./shared.mjs";

const args = process.argv.slice(2);
const jobDirIndex = args.indexOf("--job-dir");
if (jobDirIndex < 0 || !args[jobDirIndex + 1]) {
  console.error("Missing --job-dir.");
  process.exit(2);
}

const jobDir = path.resolve(args[jobDirIndex + 1]);
const requestPath = path.join(jobDir, "request.json");
const statusPath = path.join(jobDir, "status.json");
const eventsPath = path.join(jobDir, "events.jsonl");
const stdoutPath = path.join(jobDir, "stdout.jsonl");
const stderrPath = path.join(jobDir, "stderr.log");
const runnerPidPath = path.join(jobDir, "runner.pid");
const claudePidPath = path.join(jobDir, "claude.pid");

const request = await readJson(requestPath);
let eventId = 0;
let child = null;
let closing = false;
let statusQueue = Promise.resolve();
let eventQueue = Promise.resolve();

async function writeStatus(patch) {
  statusQueue = statusQueue.then(async () => {
    const previous = await readJson(statusPath, {});
    await writeJson(statusPath, {
      ...previous,
      ...patch,
      updatedAt: nowIso(),
    });
  });
  return statusQueue;
}

async function appendEvent(event) {
  const entry = {
    id: eventId++,
    ts: nowIso(),
    ...event,
  };
  eventQueue = eventQueue.then(async () => {
    await appendFile(eventsPath, `${JSON.stringify(entry)}\n`, "utf8");
    await writeStatus({ lastEventAt: entry.ts });
  });
  return eventQueue;
}

function summarizeInput(value) {
  if (value === null || value === undefined) return value;
  const text = JSON.stringify(value);
  if (text.length <= 1000) return value;
  return `${text.slice(0, 1000)}...`;
}

function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "thinking" && typeof block.thinking === "string") {
        return `[thinking] ${block.thinking}`;
      }
      if (block.type === "tool_use") return `[tool_use:${block.name || "unknown"}]`;
      if (block.type === "tool_result") return "[tool_result]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeClaudeJson(raw) {
  if (raw.type === "system" && raw.subtype === "init") {
    return {
      source: "stdout",
      type: "init",
      sessionId: raw.session_id,
      model: raw.model,
      permissionMode: raw.permissionMode,
      cwd: raw.cwd,
      tools: Array.isArray(raw.tools) ? raw.tools : undefined,
      raw,
    };
  }

  if (raw.type === "assistant") {
    const content = raw.message?.content;
    const toolUses = Array.isArray(content)
      ? content
          .filter((block) => block?.type === "tool_use")
          .map((block) => ({
            id: block.id,
            name: block.name,
            input: summarizeInput(block.input),
          }))
      : [];
    return {
      source: "stdout",
      type: toolUses.length > 0 ? "tool_use" : "assistant",
      sessionId: raw.session_id,
      text: textFromContent(content),
      toolUses,
      raw,
    };
  }

  if (raw.type === "stream_event") {
    const event = raw.event || {};
    const delta = event.delta || {};
    const text =
      delta.text ||
      delta.thinking ||
      delta.partial_json ||
      event.message?.content?.map?.((block) => block.text).filter(Boolean).join("\n") ||
      "";
    return {
      source: "stdout",
      type: "partial",
      sessionId: raw.session_id,
      streamType: event.type,
      text,
      raw,
    };
  }

  if (raw.type === "result") {
    return {
      source: "stdout",
      type: "result",
      sessionId: raw.session_id,
      subtype: raw.subtype,
      isError: raw.is_error,
      stopReason: raw.stop_reason,
      terminalReason: raw.terminal_reason,
      durationMs: raw.duration_ms,
      totalCostUsd: raw.total_cost_usd,
      result: raw.result,
      errors: raw.errors,
      raw,
    };
  }

  return {
    source: "stdout",
    type: raw.type || "stdout_json",
    sessionId: raw.session_id,
    raw,
  };
}

function createLineConsumer(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      return Promise.all(lines.filter((line) => line.trim() !== "").map(onLine));
    },
    flush() {
      if (!buffer.trim()) return Promise.resolve();
      const line = buffer;
      buffer = "";
      return onLine(line);
    },
  };
}

function buildClaudeArgs() {
  const claudeArgs = ["-p", "--output-format", "stream-json", "--verbose"];

  if (request.includePartialMessages !== false) {
    claudeArgs.push("--include-partial-messages");
  }

  const permissionMode = request.permissionMode || "bypassPermissions";
  if (request.dangerouslySkipPermissions !== false && permissionMode === "bypassPermissions") {
    claudeArgs.push("--dangerously-skip-permissions");
  } else {
    claudeArgs.push("--permission-mode", permissionMode);
  }

  claudeArgs.push("--effort", request.effort || "max");

  if (request.model) claudeArgs.push("--model", request.model);
  if (request.maxTurns) claudeArgs.push("--max-turns", String(request.maxTurns));
  if (request.resumeSessionId) claudeArgs.push("--resume", request.resumeSessionId);
  if (request.forkSession) claudeArgs.push("--fork-session");
  if (request.fallbackModel) claudeArgs.push("--fallback-model", request.fallbackModel);

  claudeArgs.push(request.prompt);
  return claudeArgs;
}

async function run() {
  const stdoutFile = createWriteStream(stdoutPath, { flags: "a", encoding: "utf8" });
  const stderrFile = createWriteStream(stderrPath, { flags: "a", encoding: "utf8" });
  const startedAt = nowIso();
  await writeFile(runnerPidPath, `${process.pid}\n`, "utf8");

  await writeStatus({
    status: "running",
    phase: "running",
    startedAt,
    runnerPid: process.pid,
    jobId: request.jobId,
    cwd: request.cwd,
    claudeCommand: findClaudeCommand(),
    effort: request.effort || "max",
    permissionMode: request.permissionMode || "bypassPermissions",
    lastEventAt: null,
    lastStdoutAt: null,
    lastStderrAt: null,
  });

  const env = {
    ...process.env,
    API_TIMEOUT_MS: request.apiTimeoutMs || process.env.API_TIMEOUT_MS || "1800000",
    CLAUDE_CODE_MAX_RETRIES:
      request.maxRetries || process.env.CLAUDE_CODE_MAX_RETRIES || "3",
    CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS:
      request.asyncAgentStallTimeoutMs ||
      process.env.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS ||
      "1800000",
    CLAUDE_AGENT_SDK_CLIENT_APP: "codex-claude-worker-mcp",
    CODEX_CLAUDE_WORKER_JOB_ID: request.jobId,
    CODEX_CLAUDE_WORKER_JOB_DIR: jobDir,
    ...(request.env || {}),
  };

  const claudeArgs = buildClaudeArgs();
  await appendEvent({
    source: "runner",
    type: "started",
    cwd: request.cwd,
    command: findClaudeCommand(),
    argsPreview: claudeArgs.map((arg) => (arg === request.prompt ? "[prompt]" : arg)),
  });

  child = spawn(findClaudeCommand(), claudeArgs, {
    cwd: request.cwd,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (child.pid) await writeFile(claudePidPath, `${child.pid}\n`, "utf8");
  await writeStatus({ claudePid: child.pid });

  const stdoutConsumer = createLineConsumer(async (line) => {
    stdoutFile.write(`${line}\n`);
    await writeStatus({ lastStdoutAt: nowIso() });
    try {
      await appendEvent(normalizeClaudeJson(JSON.parse(line)));
    } catch {
      await appendEvent({ source: "stdout", type: "stdout", text: line });
    }
  });

  const stderrConsumer = createLineConsumer(async (line) => {
    stderrFile.write(`${line}\n`);
    await writeStatus({ lastStderrAt: nowIso() });
    await appendEvent({ source: "stderr", type: "stderr", text: line });
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutConsumer.push(chunk).catch((error) => {
      console.error(error);
    });
  });
  child.stderr.on("data", (chunk) => {
    stderrConsumer.push(chunk).catch((error) => {
      console.error(error);
    });
  });

  child.on("error", async (error) => {
    await appendEvent({ source: "runner", type: "error", text: error.message });
    await writeStatus({
      status: "failed",
      phase: "terminal",
      error: error.message,
      completedAt: nowIso(),
    });
  });

  child.on("close", async (code, signal) => {
    await stdoutConsumer.flush();
    await stderrConsumer.flush();
    stdoutFile.end();
    stderrFile.end();
    if (closing) return;

    const completedAt = nowIso();
    let result = null;
    try {
      const stdout = await readFile(stdoutPath, "utf8");
      const resultLine = stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .reverse()
        .find((line) => {
          try {
            return JSON.parse(line).type === "result";
          } catch {
            return false;
          }
        });
      result = resultLine ? JSON.parse(resultLine) : null;
    } catch {
      result = null;
    }

    const status = code === 0 ? "completed" : "failed";
    await appendEvent({
      source: "runner",
      type: "finished",
      status,
      exitCode: code,
      signal,
    });
    await writeStatus({
      status,
      phase: "terminal",
      exitCode: code,
      signal,
      completedAt,
      resultSubtype: result?.subtype,
      resultSessionId: result?.session_id,
      resultText: result?.result,
      durationMs: Date.parse(completedAt) - Date.parse(startedAt),
    });
  });
}

async function shutdown(signal) {
  if (closing) return;
  closing = true;
  await appendEvent({ source: "runner", type: "cancelled", signal });
  await writeStatus({
    status: "cancelled",
    phase: "cancelling",
    signal,
    completedAt: nowIso(),
  });
  const closed = child
    ? new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("close", resolve);
      })
    : Promise.resolve();
  const timeout = new Promise((resolve) => {
    setTimeout(() => {
      if (child && !child.killed) child.kill("SIGKILL");
      resolve();
    }, 5_000);
  });
  if (child && !child.killed) child.kill("SIGTERM");
  await Promise.race([closed, timeout]);
  await eventQueue;
  await statusQueue;
  await writeStatus({ phase: "terminal" });
  process.exit(0);
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch(() => process.exit(1));
});
process.on("SIGINT", () => {
  shutdown("SIGINT").catch(() => process.exit(1));
});

await run();
