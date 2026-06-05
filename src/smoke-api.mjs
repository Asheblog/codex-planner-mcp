import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "server.mjs");

let requestId = 1;

function send(process, method, params) {
  const id = requestId++;
  process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return id;
}

function parseMessages(buffer) {
  return buffer
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export async function startJob({ prompt, cwd }) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  const initId = send(child, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.1.0" },
  });

  await waitForResponse(() => stdout, initId);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);

  const startId = send(child, "tools/call", {
    name: "claude_worker_start",
    arguments: {
      prompt,
      cwd,
      maxTurns: 1,
      includePartialMessages: true,
    },
  });
  const start = await waitForResponse(() => stdout, startId);
  const startPayload = JSON.parse(start.result.content[0].text);

  let cursor = startPayload.nextCursor || 0;
  let latest = null;
  for (let i = 0; i < 90; i += 1) {
    const pollId = send(child, "tools/call", {
      name: "claude_worker_poll",
      arguments: {
        jobId: startPayload.jobId,
        cursor,
        waitMs: 1000,
        maxEvents: 50,
      },
    });
    const poll = await waitForResponse(() => stdout, pollId);
    latest = JSON.parse(poll.result.content[0].text);
    cursor = latest.nextCursor;
    if (latest.result?.isTerminal) break;
  }

  child.kill("SIGTERM");
  return {
    jobId: startPayload.jobId,
    status: latest?.status,
    result: latest?.result,
    heartbeat: latest?.heartbeat,
  };
}

async function waitForResponse(readStdout, id) {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    for (const message of parseMessages(readStdout())) {
      if (message.id === id) return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for MCP response ${id}.`);
}
