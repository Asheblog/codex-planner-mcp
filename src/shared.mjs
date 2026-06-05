import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SERVER_NAME = "codex-claude-worker-mcp";
export const VERSION = "0.1.0";

export function stateRoot() {
  return (
    process.env.CODEX_CLAUDE_WORKER_STATE_DIR ||
    path.join(os.homedir(), ".local", "state", SERVER_NAME)
  );
}

export function jobsRoot() {
  return path.join(stateRoot(), "jobs");
}

export async function ensureState() {
  await mkdir(jobsRoot(), { recursive: true });
}

export function newJobId() {
  return `ccw_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function jobDir(jobId) {
  if (!/^ccw_[a-f0-9]{24}$/.test(jobId)) {
    throw new Error("jobId is invalid.");
  }
  return path.join(jobsRoot(), jobId);
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
}

export async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

export async function readJsonl(file) {
  try {
    const text = await readFile(file, "utf8");
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export async function fileInfo(file) {
  try {
    const info = await stat(file);
    return {
      exists: true,
      bytes: info.size,
      mtime: info.mtime.toISOString(),
    };
  } catch {
    return {
      exists: false,
      bytes: 0,
      mtime: null,
    };
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readPidFile(file) {
  try {
    const value = Number((await readFile(file, "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function processSnapshot(pid) {
  const base = `/proc/${pid}`;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { pid, alive: false, reason: "invalid_pid" };
  }

  if (process.platform !== "linux") {
    return {
      pid,
      alive: isPidAlive(pid),
      reason: isPidAlive(pid) ? "kill0" : "not_alive",
    };
  }

  try {
    const statRaw = await readFile(path.join(base, "stat"), "utf8");
    const [cmdlineRaw, environRaw, cwdLink] = await Promise.all([
      readFile(path.join(base, "cmdline"), "utf8").catch(() => ""),
      readFile(path.join(base, "environ"), "utf8").catch(() => ""),
      readlink(path.join(base, "cwd")).catch(() => null),
    ]);
    const cmdline = cmdlineRaw.split("\0").filter(Boolean);
    const environ = environRaw.split("\0").filter(Boolean);
    const statMatch = statRaw.match(/^\d+\s+\(.+\)\s+(\S+)\s+(\d+)\s+/);
    const state = statMatch ? statMatch[1] : null;
    const ppid = statMatch ? Number(statMatch[2]) : null;
    if (state === "Z") {
      return {
        pid,
        alive: false,
        reason: "zombie",
        state,
        ppid: Number.isInteger(ppid) ? ppid : null,
        cwd: cwdLink,
        cmdline,
        command: cmdline.join(" "),
        environ,
      };
    }
    return {
      pid,
      alive: true,
      reason: "proc",
      state,
      ppid: Number.isInteger(ppid) ? ppid : null,
      cwd: cwdLink,
      cmdline,
      command: cmdline.join(" "),
      environ,
    };
  } catch {
    return { pid, alive: false, reason: "proc_missing" };
  }
}

export async function listProcSnapshots() {
  if (process.platform !== "linux") return [];
  let entries = [];
  try {
    entries = await readdir("/proc", { withFileTypes: true });
  } catch {
    return [];
  }

  const pids = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name));
  const snapshots = await Promise.all(pids.map((pid) => processSnapshot(pid)));
  return snapshots.filter((snapshot) => snapshot.alive);
}

export async function discoverJobProcesses({ jobId, dir, runnerPid, claudePid }) {
  const byPid = new Map();
  const add = async (pid, role, source) => {
    if (!pid || byPid.has(pid)) return;
    const snapshot = await processSnapshot(pid);
    byPid.set(pid, { ...snapshot, role, sources: [source] });
  };

  await add(runnerPid, "runner", "status");
  await add(claudePid, "claude", "status");
  await add(await readPidFile(path.join(dir, "runner.pid")), "runner", "runner.pid");
  await add(await readPidFile(path.join(dir, "claude.pid")), "claude", "claude.pid");

  const all = await listProcSnapshots();
  const envNeedle = `CODEX_CLAUDE_WORKER_JOB_ID=${jobId}`;
  for (const snapshot of all) {
    const command = snapshot.command || "";
    const envMatches = snapshot.environ?.includes(envNeedle);
    const commandMatches = dir && command.includes(dir);
    if (!envMatches && !commandMatches) continue;

    const role = command.includes("runner.mjs")
      ? "runner"
      : command.includes("claude")
        ? "claude"
        : "job_process";
    const existing = byPid.get(snapshot.pid);
    if (existing) {
      existing.sources.push(envMatches ? "proc_env" : "proc_cmdline");
    } else {
      byPid.set(snapshot.pid, {
        ...snapshot,
        role,
        sources: [envMatches ? "proc_env" : "proc_cmdline"],
      });
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const snapshot of all) {
      if (byPid.has(snapshot.pid)) continue;
      if (snapshot.ppid && byPid.has(snapshot.ppid)) {
        byPid.set(snapshot.pid, {
          ...snapshot,
          role: snapshot.command?.includes("claude") ? "claude" : "descendant",
          sources: ["proc_ppid"],
        });
        changed = true;
      }
    }
  }

  const processes = [...byPid.values()].map((item) => ({
    ...item,
    verified:
      item.alive &&
      (item.sources.includes("proc_env") ||
        item.sources.includes("proc_cmdline") ||
        item.sources.includes("proc_ppid") ||
        item.sources.includes("runner.pid") ||
        item.sources.includes("claude.pid")),
  }));

  return {
    processes,
    runner: pickProcess(processes, "runner"),
    claude: pickProcess(processes, "claude"),
  };
}

function pickProcess(processes, role) {
  const match = processes.find((processInfo) => processInfo.role === role && processInfo.alive);
  if (match) return match;
  const stale = processes.find((processInfo) => processInfo.role === role);
  if (stale) return stale;
  return { pid: null, alive: false, role, reason: "not_found", sources: [] };
}

export async function withLock(name, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 60_000;
  const lockDir = path.join(stateRoot(), "locks", name.replace(/[^a-zA-Z0-9_.-]/g, "_"));
  await mkdir(path.dirname(lockDir), { recursive: true });
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockDir);
      await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, at: nowIso() }));
      break;
    } catch {
      const info = await stat(lockDir).catch(() => null);
      if (info && Date.now() - info.mtimeMs > staleMs) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out acquiring lock: ${name}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

export function toAbsoluteCwd(cwd, base = process.cwd()) {
  if (!cwd || typeof cwd !== "string") return base;
  return path.resolve(base, cwd);
}

export async function listJobIds() {
  await ensureState();
  const entries = await readdir(jobsRoot(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^ccw_[a-f0-9]{24}$/.test(entry.name))
    .map((entry) => entry.name);
}

export function findClaudeCommand() {
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;
  if (process.env.CLAUDE_CLI_NAME) return process.env.CLAUDE_CLI_NAME;
  if (process.platform === "win32") {
    const localCmd = path.join(os.homedir(), "AppData", "Roaming", "npm", "claude.cmd");
    if (existsSync(localCmd)) return localCmd;
  }
  return "claude";
}

export function nowIso() {
  return new Date().toISOString();
}

export function quietMsSince(iso) {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Date.now() - time);
}

export function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
