#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "server.mjs");

export function createMcpClient(env = {}) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...env },
  });
  let out = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });

  function messages() {
    return out
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

  function send(method, params) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return id;
  }

  async function waitFor(id, timeoutMs = 60_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const message = messages().find((item) => item.id === id);
      if (message) return message;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for MCP response ${id}.`);
  }

  async function init() {
    const id = send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "codex-claude-worker-test", version: "0.1.0" },
    });
    await waitFor(id);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`
    );
  }

  async function callTool(name, args = {}, timeoutMs = 60_000) {
    const id = send("tools/call", { name, arguments: args });
    const message = await waitFor(id, timeoutMs);
    if (message.error) throw new Error(JSON.stringify(message.error));
    const text = message.result?.content?.[0]?.text || "{}";
    const payload = JSON.parse(text);
    if (message.result?.isError || payload.isError) {
      throw new Error(payload.error || text);
    }
    return payload;
  }

  function close() {
    child.kill("SIGTERM");
  }

  return { init, callTool, close, child };
}
