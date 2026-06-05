#!/usr/bin/env node
import { startJob } from "./smoke-api.mjs";

const cwd = process.argv[2] || process.cwd();
const prompt =
  "Return exactly this short sentence and do not edit files: codex-claude-worker smoke ok";

const result = await startJob({ prompt, cwd });
console.log(JSON.stringify(result, null, 2));

if (result.status !== "completed") {
  process.exitCode = 1;
}
