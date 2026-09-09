import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyHiveHooks,
  codexStateKey,
  HIVE_CODEX_HOOK_EVENTS,
  HIVE_HOOK_EVENTS,
  hiveHookStatus,
  installHooks,
  parseCodexHookState,
  pruneMissingHiveHooks,
  removeHiveHooks,
  statusHooks,
  uninstallHooks,
  type Settings,
} from "./hookInstall.js";

const SCRIPT = "/home/ed/src/hive/hooks/claude-hook.sh";

describe("applyHiveHooks", () => {
  it("빈 settings에 14개 이벤트를 전부 설치한다", () => {
    const next = applyHiveHooks({}, SCRIPT);
    expect(Object.keys(next.hooks ?? {})).toHaveLength(HIVE_HOOK_EVENTS.length);
    for (const { event } of HIVE_HOOK_EVENTS) {
      const groups = next.hooks?.[event] ?? [];
      expect(groups.some((g) => g.hooks.some((h) => h.command === SCRIPT))).toBe(true);
    }
  });

  it("툴 이벤트 4개에만 matcher *를 붙인다", () => {
    const next = applyHiveHooks({}, SCRIPT);
    const toolEvents = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"];
    for (const { event } of HIVE_HOOK_EVENTS) {
      const group = next.hooks![event].find((g) => g.hooks.some((h) => h.command === SCRIPT))!;
      if (toolEvents.includes(event)) {
        expect(group.matcher).toBe("*");
      } else {
        expect(group.matcher).toBeUndefined();
      }
    }
  });

  it("기존 orca/curl hook을 보존한다", () => {
    const existing: Settings = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "/home/ed/.orca/agent-hooks/claude-hook.sh" }] },
          { hooks: [{ type: "command", command: "curl -s 127.0.0.1:47100/event?agent=claude" }] },
        ],
      },
      otherTopLevelKey: "keep-me",
    };
    const next = applyHiveHooks(existing, SCRIPT);
    const stopCommands = next.hooks!.Stop.flatMap((g) => g.hooks.map((h) => h.command));
    expect(stopCommands).toEqual(
      expect.arrayContaining([
        "/home/ed/.orca/agent-hooks/claude-hook.sh",
        "curl -s 127.0.0.1:47100/event?agent=claude",
        SCRIPT,
      ])
    );
    expect(next.otherTopLevelKey).toBe("keep-me");
  });

  it("두 번 적용해도 결과가 같다 (멱등)", () => {
    const once = applyHiveHooks({}, SCRIPT);
    const twice = applyHiveHooks(once, SCRIPT);
    expect(twice).toEqual(once);
  });
});

describe("removeHiveHooks", () => {
  it("우리 hook만 제거하고 다른 hook은 남긴다", () => {
    const withOrca = applyHiveHooks(
      {
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "/home/ed/.orca/agent-hooks/claude-hook.sh" }] }],
        },
      },
      SCRIPT
    );
    const removed = removeHiveHooks(withOrca, SCRIPT);
    const stopCommands = removed.hooks?.Stop?.flatMap((g) => g.hooks.map((h) => h.command)) ?? [];
    expect(stopCommands).toEqual(["/home/ed/.orca/agent-hooks/claude-hook.sh"]);
  });

  it("빈 이벤트 배열과 빈 hooks 객체는 정리한다", () => {
    const installed = applyHiveHooks({}, SCRIPT);
    const removed = removeHiveHooks(installed, SCRIPT);
    expect(removed.hooks).toBeUndefined();
  });
});

describe("hiveHookStatus", () => {
  it("설치된 이벤트만 installed:true로 표시한다", () => {
    const empty = hiveHookStatus({}, SCRIPT);
    expect(empty.every((s) => s.installed === false)).toBe(true);

    const installed = hiveHookStatus(applyHiveHooks({}, SCRIPT), SCRIPT);
    expect(installed.every((s) => s.installed === true)).toBe(true);
  });
});

describe("codex hooks", () => {
  const CODEX_SCRIPT = "/home/ed/src/hive/hooks/codex-hook.sh";
  const HOOKS_PATH = "/home/ed/.codex/hooks.json";

  it("codex가 아는 이벤트만 설치한다", () => {
    const next = applyHiveHooks({}, CODEX_SCRIPT, HIVE_CODEX_HOOK_EVENTS);
    const events = Object.keys(next.hooks ?? {});
    expect(events).toHaveLength(HIVE_CODEX_HOOK_EVENTS.length);
    // codex는 Notification/StopFailure/TeammateIdle/PostToolUseFailure를 모른다.
    expect(events).not.toContain("Notification");
    expect(events).not.toContain("PostToolUseFailure");
  });

  it("codex 쪽에는 matcher를 붙이지 않는다", () => {
    const next = applyHiveHooks({}, CODEX_SCRIPT, HIVE_CODEX_HOOK_EVENTS);
    for (const groups of Object.values(next.hooks!)) {
      expect(groups.every((g) => g.matcher === undefined)).toBe(true);
    }
  });

  it("codex가 3초로 잘라내는 이벤트는 처음부터 3초로 등록한다", () => {
    const next = applyHiveHooks({}, CODEX_SCRIPT, HIVE_CODEX_HOOK_EVENTS);
    expect(next.hooks!.SessionEnd[0].hooks[0].timeout).toBe(3);
    expect(next.hooks!.Interrupt[0].hooks[0].timeout).toBe(3);
    expect(next.hooks!.SessionStart[0].hooks[0].timeout).toBe(5);
  });

  it("기존 orca codex hook을 보존한다", () => {
    const existing: Settings = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "/home/ed/.orca/agent-hooks/codex-hook.sh" }] }],
      },
    };
    const next = applyHiveHooks(existing, CODEX_SCRIPT, HIVE_CODEX_HOOK_EVENTS);
    expect(next.hooks!.Stop.flatMap((g) => g.hooks.map((h) => h.command))).toEqual([
      "/home/ed/.orca/agent-hooks/codex-hook.sh",
      CODEX_SCRIPT,
    ]);
  });

  it("신뢰 키는 <경로>:<snake_case 이벤트>:<그룹>:<항목> 형식이다", () => {
    expect(codexStateKey(HOOKS_PATH, "PreToolUse", 0, 0)).toBe(`${HOOKS_PATH}:pre_tool_use:0:0`);
    expect(codexStateKey(HOOKS_PATH, "UserPromptSubmit", 1, 2)).toBe(`${HOOKS_PATH}:user_prompt_submit:1:2`);
  });

  it("config.toml의 hooks.state에서 trusted_hash와 enabled를 읽는다", () => {
    const toml = [
      `model = "gpt-6-astra"`,
      `[hooks.state]`,
      ``,
      `[hooks.state."${HOOKS_PATH}:pre_tool_use:0:0"]`,
      `enabled = true`,
      `trusted_hash = "sha256:abc"`,
      ``,
      `[hooks.state."${HOOKS_PATH}:stop:0:0"]`,
      `trusted_hash = "sha256:def"`,
      ``,
      `[hooks.state."${HOOKS_PATH}:session_end:0:0"]`,
      `enabled = false`,
      `trusted_hash = "sha256:ghi"`,
      ``,
      `[hooks.state."${HOOKS_PATH}:interrupt:0:0"]`,
      `enabled = true`,
      ``,
      `[tui]`,
      `enabled = true`,
    ].join("\n");
    const state = parseCodexHookState(toml);
    expect(state.get(`${HOOKS_PATH}:pre_tool_use:0:0`)).toBe(true);
    // codex는 trust 승인 시 trusted_hash만 적는다. enabled가 없어도 켜진 것이다.
    expect(state.get(`${HOOKS_PATH}:stop:0:0`)).toBe(true);
    // 사용자가 끈 hook은 해시가 있어도 꺼진 것이다.
    expect(state.get(`${HOOKS_PATH}:session_end:0:0`)).toBe(false);
    // 승인 해시가 없으면 아직 신뢰 전이다.
    expect(state.get(`${HOOKS_PATH}:interrupt:0:0`)).toBe(false);
    // [tui] 섹션의 enabled가 직전 hook 상태로 새면 안 된다.
    expect(state.size).toBe(4);
  });
});

describe("installHooks / statusHooks (codex 파일 왕복)", () => {
  function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), "hive-hooks-"));
  }

  it("codex hooks.json을 새로 만들고 status가 installed로 읽는다", () => {
    const dir = tmpDir();
    const hooksPath = join(dir, "hooks.json");
    const configPath = join(dir, "config.toml");

    const results = installHooks({ agents: ["codex"], codexHooksPath: hooksPath });
    expect(results).toHaveLength(1);
    expect(results[0].agent).toBe("codex");
    expect(existsSync(hooksPath)).toBe(true);

    const rows = statusHooks({ agents: ["codex"], codexHooksPath: hooksPath, codexConfigPath: configPath });
    expect(rows).toHaveLength(HIVE_CODEX_HOOK_EVENTS.length);
    expect(rows.every((r) => r.installed)).toBe(true);
    // config.toml이 없으면 아직 아무것도 승인되지 않은 상태다.
    expect(rows.every((r) => r.trusted === false)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("config.toml에 승인이 있으면 그 이벤트만 trusted로 표시한다", () => {
    const dir = tmpDir();
    const hooksPath = join(dir, "hooks.json");
    const configPath = join(dir, "config.toml");

    installHooks({ agents: ["codex"], codexHooksPath: hooksPath });
    // 신뢰 키의 그룹/항목 index는 hooks.json에 실제로 쓰인 위치를 따른다.
    writeFileSync(configPath, `[hooks.state."${hooksPath}:session_start:0:0"]\ntrusted_hash = "sha256:abc"\n`);

    const rows = statusHooks({ agents: ["codex"], codexHooksPath: hooksPath, codexConfigPath: configPath });
    expect(rows.find((r) => r.event === "SessionStart")?.trusted).toBe(true);
    expect(rows.find((r) => r.event === "Stop")?.trusted).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it("uninstall하면 hive hook만 빠지고 남의 hook은 남는다", () => {
    const dir = tmpDir();
    const hooksPath = join(dir, "hooks.json");
    const orca = { type: "command" as const, command: "/home/ed/.orca/agent-hooks/codex-hook.sh" };
    writeFileSync(hooksPath, JSON.stringify({ hooks: { Stop: [{ hooks: [orca] }] } }));

    installHooks({ agents: ["codex"], codexHooksPath: hooksPath });
    uninstallHooks({ agents: ["codex"], codexHooksPath: hooksPath });

    const after = JSON.parse(readFileSync(hooksPath, "utf8")) as Settings;
    expect(after.hooks!.Stop.flatMap((g) => g.hooks.map((h) => h.command))).toEqual([orca.command]);

    rmSync(dir, { recursive: true, force: true });
  });
});

// 워크트리에서 hooks install을 돌리면 그 워크트리 경로가 hook으로 박힌다. 워크트리를 지우면
// 실행할 수 없는 hook만 남아서 agent가 뜰 때마다 "not found"를 뱉는다.
describe("pruneMissingHiveHooks", () => {
  const dead = "/home/ed/src/hive-worktrees/hive/cron/hooks/claude-hook.sh";
  const alive = SCRIPT;
  const exists = (path: string) => path === alive;

  it("사라진 hive hook을 지운다", () => {
    const settings: Settings = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: alive }] }, { hooks: [{ type: "command", command: dead }] }],
      },
    };
    const after = pruneMissingHiveHooks(settings, exists);
    expect(after.hooks!.Stop.flatMap((g) => g.hooks.map((h) => h.command))).toEqual([alive]);
  });

  it("hive가 심지 않은 명령은 파일이 없어도 그대로 둔다", () => {
    const other = { type: "command" as const, command: "/opt/other/tool.sh" };
    const settings: Settings = { hooks: { Stop: [{ hooks: [other] }] } };
    expect(pruneMissingHiveHooks(settings, exists)).toEqual(settings);
  });

  it("codex hook도 같은 기준으로 지운다", () => {
    const deadCodex = "/home/ed/src/hive-worktrees/hive/cron/hooks/codex-hook.sh";
    const settings: Settings = { hooks: { Stop: [{ hooks: [{ type: "command", command: deadCodex }] }] } };
    expect(pruneMissingHiveHooks(settings, exists).hooks?.Stop).toBeUndefined();
  });

  it("지우고 나서 빈 그룹은 남기지 않는다", () => {
    const settings: Settings = {
      hooks: {
        Stop: [{ matcher: "*", hooks: [{ type: "command", command: dead }] }],
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: alive }] }],
      },
    };
    const after = pruneMissingHiveHooks(settings, exists);
    expect(after.hooks?.Stop).toBeUndefined();
    expect(after.hooks!.PreToolUse).toHaveLength(1);
  });
});
