import { describe, expect, it } from "vitest";
import { applyHiveHooks, HIVE_HOOK_EVENTS, hiveHookStatus, removeHiveHooks, type Settings } from "./hookInstall.js";

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
