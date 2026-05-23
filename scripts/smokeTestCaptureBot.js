import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

if (process.env.SKIP_NET === "1") {
  console.log("SKIP smokeTestCaptureBot (SKIP_NET=1)");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cap-bot-"));
const env = { ...process.env, LOG_ROOT: tmp };

const proc = spawn(process.execPath, ["src/indexCapture.js"], { env, stdio: "inherit" });

await new Promise((res) => setTimeout(res, 60_000));
proc.kill("SIGTERM");
await new Promise((res) => proc.on("exit", res));

const obFile = path.join(tmp, "capture", "orderbook_5m.jsonl");
assert.ok(fs.existsSync(obFile), "orderbook_5m.jsonl gravado");
const lines = fs.readFileSync(obFile, "utf8").trim().split("\n").filter(Boolean);
assert.ok(lines.length >= 1, "ao menos 1 linha capturada");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`OK capture bot — ${lines.length} linhas em 60s`);
