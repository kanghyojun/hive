import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
// promisify(execFile)은 모듈 로드 시점에 한 번 돈다. custom 심볼을 안 달면 콜백 규약으로
// 감싸져 { stdout } 구조분해가 깨진다. 실제 execFile과 같은 모양을 흉내 낸다.
(execFileMock as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] = (
  ...args: unknown[]
) => execFileMock(...args);

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const { parseAbConfig, probeAbBridge } = await import("./abBridge.js");

// ab-bridge/profiles.example.json과 같은 모양. 값은 일부러 기본값과 다르게 둔다.
// 기본값과 같은 값을 기대하면 파싱을 통째로 지워도 테스트가 통과한다.
const EXAMPLE = JSON.stringify({
  macHost: "studio",
  profiles: {
    main: { port: 9444, description: "일상 로그인 보관용 프로필", sites: [] },
    work: { port: 9333 },
  },
});

describe("parseAbConfig", () => {
  it("설정이 없으면 lib/config.sh와 같은 기본값", () => {
    expect(parseAbConfig(undefined)).toEqual({ macHost: "macbookpro", port: 9222 });
  });

  it("정상 설정에서 macHost와 main 포트를 읽는다", () => {
    expect(parseAbConfig(EXAMPLE)).toEqual({ macHost: "studio", port: 9444 });
  });

  it("프로필을 지정하면 그 포트를 쓴다", () => {
    expect(parseAbConfig(EXAMPLE, "work")).toEqual({ macHost: "studio", port: 9333 });
  });

  it("없는 프로필은 기본 포트로 떨어진다. macHost는 그대로다", () => {
    expect(parseAbConfig(EXAMPLE, "nope")).toEqual({ macHost: "studio", port: 9222 });
  });

  it("깨진 JSON은 기본값", () => {
    expect(parseAbConfig("{not json")).toEqual({ macHost: "macbookpro", port: 9222 });
  });

  it("macHost만 다르면 그것만 반영된다", () => {
    expect(parseAbConfig(JSON.stringify({ macHost: "mini" }))).toEqual({ macHost: "mini", port: 9222 });
  });

  it("포트가 숫자가 아니면 기본 포트로 떨어진다", () => {
    const raw = JSON.stringify({ macHost: "mini", profiles: { main: { port: "구천이백이십이" } } });
    expect(parseAbConfig(raw)).toEqual({ macHost: "mini", port: 9222 });
  });
});

describe("probeAbBridge", () => {
  const cfg = { macHost: "mac", port: 9222 };

  afterEach(() => {
    execFileMock.mockReset();
    vi.unstubAllGlobals();
  });

  const okResponse = (body: unknown) => ({
    ok: true,
    body: null,
    json: () => Promise.resolve(body),
  });

  it("tailscale 바이너리가 없으면 no-tailscale", async () => {
    execFileMock.mockRejectedValue(Object.assign(new Error("spawn"), { code: "ENOENT" }));
    expect(await probeAbBridge(cfg)).toEqual({ status: "no-tailscale" });
  });

  // 맥이 꺼져 있거나 tailnet에 없으면 tailscale이 exit 1을 낸다(실측).
  // 종료 코드까지 no-tailscale로 묶으면 no-ip가 영원히 안 나온다.
  it("호스트를 못 찾아 exit 1이면 no-ip", async () => {
    execFileMock.mockRejectedValue(Object.assign(new Error("no such host"), { code: 1 }));
    expect(await probeAbBridge(cfg)).toEqual({ status: "no-ip" });
  });

  it("CDP 응답이면 up", async () => {
    execFileMock.mockResolvedValue({ stdout: "100.1.2.3\n", stderr: "" });
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ webSocketDebuggerUrl: "ws://100.1.2.3:9222/x" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeAbBridge(cfg)).toEqual({ status: "up", ip: "100.1.2.3" });
    expect(fetchMock.mock.calls[0][0]).toBe("http://100.1.2.3:9222/json/version");
  });

  // 9222에 CDP가 아닌 서버가 떠 있어도 200은 온다. res.ok만 보면 ab●가 거짓으로 뜬다.
  it("200이어도 webSocketDebuggerUrl이 없으면 down", async () => {
    execFileMock.mockResolvedValue({ stdout: "100.1.2.3\n", stderr: "" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({ hello: "world" })));
    expect(await probeAbBridge(cfg)).toEqual({ status: "down", ip: "100.1.2.3" });
  });

  it("JSON이 아닌 200 응답도 down", async () => {
    execFileMock.mockResolvedValue({ stdout: "100.1.2.3\n", stderr: "" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      body: null,
      json: () => Promise.reject(new SyntaxError("not json")),
    }));
    expect(await probeAbBridge(cfg)).toEqual({ status: "down", ip: "100.1.2.3" });
  });

  it("연결이 거부되면 down", async () => {
    execFileMock.mockResolvedValue({ stdout: "100.1.2.3\n", stderr: "" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(await probeAbBridge(cfg)).toEqual({ status: "down", ip: "100.1.2.3" });
  });

  it("200이 아니면 본문을 버리고 down", async () => {
    execFileMock.mockResolvedValue({ stdout: "100.1.2.3\n", stderr: "" });
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, body: { cancel }, json: () => Promise.resolve({}) }));
    expect(await probeAbBridge(cfg)).toEqual({ status: "down", ip: "100.1.2.3" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
