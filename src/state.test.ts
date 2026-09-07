import { describe, expect, it } from "vitest";
import { effectiveState, looksLikePermissionPrompt, reduceAgent, type AgentRecord } from "./state.js";

const TMUX_PID = "111";
const PANE_ID = "%1";

function ev(event: string, payload: unknown, ts = 1000) {
  return { ts, event, payload, tmuxPid: TMUX_PID, paneId: PANE_ID };
}

describe("reduceAgent", () => {
  it("UserPromptSubmit -> working", () => {
    const rec = reduceAgent(undefined, ev("UserPromptSubmit", { prompt: "hi" }));
    expect(rec.state).toBe("working");
    expect(rec.prompt).toBe("hi");
    expect(rec.lastPromptTs).toBe(1000);
  });

  it("PreToolUse AskUserQuestion -> waiting, 질문 텍스트 보관", () => {
    const rec = reduceAgent(undefined, ev("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "which?" }] } }));
    expect(rec.state).toBe("waiting");
    expect(rec.prompt).toBe("which?");
  });

  it("PreToolUse 일반 tool -> working", () => {
    const rec = reduceAgent(undefined, ev("PreToolUse", { tool_name: "Bash" }));
    expect(rec.state).toBe("working");
  });

  it("PermissionRequest -> waiting", () => {
    const rec = reduceAgent(undefined, ev("PermissionRequest", { permission_prompt: "proceed?" }));
    expect(rec.state).toBe("waiting");
    expect(rec.prompt).toBe("proceed?");
  });

  it("Stop -> done", () => {
    const prev = reduceAgent(undefined, ev("UserPromptSubmit", { prompt: "hi" }));
    const rec = reduceAgent(prev, ev("Stop", {}, 2000));
    expect(rec.state).toBe("done");
  });

  it("Stop이지만 서브에이전트가 working으로 남아있으면 working 유지", () => {
    let rec: AgentRecord | undefined = reduceAgent(undefined, ev("UserPromptSubmit", { prompt: "hi" }));
    rec = reduceAgent(rec, ev("SubagentStart", { agent_id: "sub1" }, 1500));
    rec = reduceAgent(rec, ev("Stop", {}, 2000));
    expect(rec.state).toBe("working");

    rec = reduceAgent(rec, ev("SubagentStop", { agent_id: "sub1" }, 2500));
    rec = reduceAgent(rec, ev("Stop", {}, 3000));
    expect(rec.state).toBe("done");
  });

  it("SessionStart는 로스터를 리셋한다", () => {
    let rec: AgentRecord | undefined = reduceAgent(undefined, ev("UserPromptSubmit", { prompt: "hi" }));
    rec = reduceAgent(rec, ev("SubagentStart", { agent_id: "sub1" }, 1500));
    rec = reduceAgent(rec, ev("SessionStart", { source: "startup" }, 2000));
    expect(rec.state).toBe("done");
    expect(rec.prompt).toBeNull();
    expect(JSON.parse(rec.subagents)).toEqual({});
  });

  it("SessionEnd는 ended 플래그를 세운다", () => {
    const prev = reduceAgent(undefined, ev("UserPromptSubmit", { prompt: "hi" }));
    const rec = reduceAgent(prev, ev("SessionEnd", { reason: "clear" }, 2000));
    expect(rec.ended).toBe(1);
  });
});

describe("effectiveState", () => {
  it("agent 기록이 없으면 unknown", () => {
    expect(effectiveState(undefined, 1000, false)).toEqual({ state: "unknown", source: "none" });
  });

  it("ended면 idle", () => {
    const rec = reduceAgent(undefined, ev("SessionEnd", {}, 1000));
    expect(effectiveState(rec, 2000, false).state).toBe("idle");
  });

  it("마지막 이벤트로부터 30분 넘으면 idle", () => {
    const rec = reduceAgent(undefined, ev("UserPromptSubmit", { prompt: "hi" }, 0));
    expect(effectiveState(rec, 30 * 60 * 1000 + 1, false).state).toBe("idle");
    expect(effectiveState(rec, 30 * 60 * 1000 - 1, false).state).toBe("working");
  });

  it("화면 폴백이 waiting이면 소스가 screen인 waiting을 우선한다", () => {
    const rec = reduceAgent(undefined, ev("UserPromptSubmit", { prompt: "hi" }, 1000));
    const result = effectiveState(rec, 1500, true);
    expect(result).toEqual({ state: "waiting", source: "screen" });
  });
});

describe("looksLikePermissionPrompt", () => {
  it("Do you want to proceed? 문구를 인식한다", () => {
    expect(looksLikePermissionPrompt("blah\nDo you want to proceed?\nblah")).toBe(true);
  });

  it("Yes, and don't ask again 문구를 인식한다", () => {
    expect(looksLikePermissionPrompt("1. Yes, and don't ask again")).toBe(true);
  });

  it("관계없는 텍스트는 false", () => {
    expect(looksLikePermissionPrompt("hello world")).toBe(false);
  });
});

describe("codex Interrupt", () => {
  it("사용자가 턴을 끊으면 done으로 떨어뜨린다", () => {
    const working = reduceAgent(undefined, ev("PreToolUse", { tool_name: "shell" }, 1000));
    expect(working.state).toBe("working");
    const interrupted = reduceAgent(working, ev("Interrupt", {}, 1100));
    expect(interrupted.state).toBe("done");
    expect(interrupted.toolName).toBeNull();
  });

  it("서브에이전트가 남아 있어도 done으로 본다", () => {
    const sub = reduceAgent(undefined, ev("SubagentStart", { agent_id: "a1" }, 1000));
    const interrupted = reduceAgent(sub, ev("Interrupt", {}, 1100));
    expect(interrupted.state).toBe("done");
    expect(interrupted.subagents).toBe("{}");
  });
});
