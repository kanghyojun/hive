#!/usr/bin/env node
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startCollector } from "./collector.js";
import { isServerInfo } from "./collectorProtocol.js";
import { collectorLogPath, ensureDirs, setHiveHomeOverride } from "./paths.js";

async function main(): Promise<void> {
  process.removeAllListeners("warning");
  process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") log(w); });
  const args = process.argv.slice(2);
  const home = args[args.indexOf("--home") + 1];
  if (!args.includes("--home") || !home) throw new Error("--home이 필요합니다");
  setHiveHomeOverride(home);
  const server = JSON.parse(args[args.indexOf("--server") + 1] ?? "null") as unknown;
  if (!args.includes("--server") || !isServerInfo(server)) throw new Error("--server 정보가 올바르지 않습니다");
  const handle = await startCollector({ home, server });
  if (!handle) return;
  const stop = () => { void handle.close().catch(log); };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, stop);
  await handle.done;
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(signal, stop);
}

function log(err: unknown): void {
  try {
    ensureDirs();
    appendFileSync(collectorLogPath(), `${new Date().toISOString()} ${err instanceof Error ? err.stack : String(err)}\n`);
  } catch { /* 로그 쓰기 실패가 종료 처리를 막지 않도록 한다. */ }
}

function isEntry(): boolean {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isEntry()) void main().catch((err) => { log(err); process.exitCode = 1; });
