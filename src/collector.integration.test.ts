import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { collectorSocketPath } from "./paths.js";
import { NdjsonDecoder, type CollectorSnapshot } from "./collectorProtocol.js";
import { openDb } from "./db.js";

let hasTmux = true;
try { execFileSync("tmux", ["-V"], { stdio: "ignore", timeout: 3000 }); } catch { hasTmux = false; }

async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error("수집기 실프로세스 검증 시간이 초과됐습니다");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function readSnapshot(path: string): Promise<CollectorSnapshot | null> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => finish(null), 1500);
    const finish = (snapshot: CollectorSnapshot | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(snapshot);
    };
    const decoder = new NdjsonDecoder((value) => {
      const message = value as { type?: string; snapshot?: CollectorSnapshot };
      if (message.type === "snapshot") finish(message.snapshot ?? null);
    });
    socket.on("data", (chunk) => {
      try { decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk); } catch { finish(null); }
    });
    socket.on("error", () => finish(null));
  });
}

it.skipIf(!hasTmux)("실제 병렬 시작과 SIGKILL 복구에도 owner는 하나이며 구독자가 없어도 수집합니다", async () => {
  const home = mkdtempSync("/tmp/hive-process-test-");
  const tmuxSocket = join(home, "tmux socket");
  const children: ChildProcess[] = [];
  const tmux = (args: string[]) => execFileSync("tmux", ["-S", tmuxSocket, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
  }).trim();
  try {
    tmux(["-f", "/dev/null", "new-session", "-d", "-s", "test", "-c", home, "sleep 120"]);
    const [pid, startTime, socketPath] = tmux(["display-message", "-p", "#{pid}\t#{start_time}\t#{socket_path}"]).split("\t");
    const server = { pid, startTime, socketPath };
    const pane = tmux(["display-message", "-p", "#{pane_id}"]);
    const ipc = collectorSocketPath(home, server);
    const launch = () => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./collectorEntry.ts", import.meta.url)),
        "--home", home, "--server", JSON.stringify(server)], { stdio: "ignore", env: { ...process.env, HIVE_HOME: home } });
      children.push(child);
    };
    for (let i = 0; i < 4; i++) launch();
    const first = (await until(() => readSnapshot(ipc), (s) => s !== null))!;
    await until(() => children.filter((c) => c.exitCode === null && c.signalCode === null), (live) => live.length === 1);
    expect(children.find((c) => c.pid === first.collectorPid)).toBeDefined();
    process.kill(first.collectorPid, "SIGKILL");
    await until(() => children.find((c) => c.pid === first.collectorPid)!.signalCode, (signal) => signal === "SIGKILL");
    for (let i = 0; i < 4; i++) launch();
    const recovered = (await until(() => readSnapshot(ipc), (s) => s !== null && s.collectorPid !== first.collectorPid))!;
    await until(() => children.filter((c) => c.exitCode === null && c.signalCode === null), (live) => live.length === 1);
    appendFileSync(join(home, "spool", "test.jsonl"), `${JSON.stringify({ v: 1, ts: Date.now(), pane,
      tmux: `${tmuxSocket},${pid},0`, payload: { hook_event_name: "UserPromptSubmit", prompt: "화면 없이도 계속 수집합니다" } })}\n`);
    const db = await openDb(join(home, "hive.db"));
    try {
      await until(() => db.getAgent(pid, pane)?.title, (title) => title === "화면 없이도 계속 수집합니다");
      expect(db.raw.prepare("SELECT count(*) AS n FROM collector_owners").get()).toMatchObject({ n: 1 });
      tmux(["kill-server"]);
      await until(() => children.find((c) => c.pid === recovered.collectorPid)!.exitCode, (code) => code === 0);
      expect(existsSync(ipc)).toBe(false);
      expect(db.raw.prepare("SELECT count(*) AS n FROM collector_owners").get()).toMatchObject({ n: 0 });
    } finally { db.close(); }
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    try { tmux(["kill-server"]); } catch { /* 테스트 서버가 이미 종료됐을 수 있다. */ }
    await Promise.all(children.filter((c) => c.exitCode === null && c.signalCode === null).map((c) => new Promise((resolve) => c.once("exit", resolve))));
    rmSync(home, { recursive: true, force: true });
  }
}, 25_000);
