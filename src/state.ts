export type AgentState = "working" | "waiting" | "done" | "idle" | "unknown";

// hive가 상태를 추적하는 에이전트 종류.
export type AgentKind = "claude" | "codex";

export const AGENT_KINDS: AgentKind[] = ["claude", "codex"];

// 행 맨 앞 에이전트 표시. 폭 1 글리프만 쓴다(string-width로 확인).
// 이모지와 Nerd Font 보조평면 글리프는 2칸이라 열이 어긋난다.
export const AGENT_GLYPH: Record<AgentKind, string> = { claude: "✱", codex: "⬡" };
export const AGENT_GLYPH_WIDTH = 1;
// 목록에 에이전트 종류가 하나뿐이면 글리프 열을 비운다.
export const HIDE_GLYPH_WHEN_UNIFORM = true;

export interface AgentRecord {
  tmuxPid: string;
  paneId: string;
  state: AgentState;
  source: string; // "hook" | "screen"
  toolName: string | null;
  prompt: string | null;
  /** 이 세션의 첫 사용자 입력. 창 이름이 자동 생성일 때 라벨로 쓴다. */
  title: string | null;
  lastEvent: string | null;
  lastTs: number;
  lastPromptTs: number | null;
  subagents: string; // JSON 직렬화된 Record<agentId, "working">
  ended: number;
}

export interface RawEvent {
  ts: number;
  event: string;
  payload: unknown;
  tmuxPid: string;
  paneId: string;
}

const IDLE_MS = 30 * 60 * 1000;

// 앞의 둘은 Claude Code, 뒤의 둘은 codex 화면 문구다(실측).
export const PERMISSION_PATTERNS = [
  /Do you want to proceed\?/,
  /Yes, and don't ask again/,
  /Would you like to run the following command\?/,
  /Yes, proceed \(y\)/,
];

export function looksLikePermissionPrompt(text: string): boolean {
  return PERMISSION_PATTERNS.some((re) => re.test(text));
}

export function normalizeToolName(name: unknown): string {
  return typeof name === "string" ? name.replace(/[^a-z0-9]/gi, "").toLowerCase() : "";
}

export function isInteractiveTool(name: unknown): boolean {
  const n = normalizeToolName(name);
  return n === "askuserquestion" || n === "requestuserinput";
}

const TITLE_MAX = 120;

// 첫 입력을 한 줄짜리 제목으로 줄인다. 여러 줄 붙여넣기를 그대로 들고 있을 이유가 없다.
export function promptTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  const collapsed = line.replace(/\s+/g, " ");
  return collapsed.length > TITLE_MAX ? collapsed.slice(0, TITLE_MAX) : collapsed;
}

function parseSubagents(s: string): Record<string, "working"> {
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function payloadOf(ev: RawEvent): Record<string, unknown> {
  return ev.payload && typeof ev.payload === "object" ? (ev.payload as Record<string, unknown>) : {};
}

// PreToolUse의 tool_input.question(s), PermissionRequest/Notification의 permission_prompt 순으로 찾는다.
function extractWaitingPrompt(payload: Record<string, unknown>, fallback: string | null): string | null {
  const input = payload.tool_input as Record<string, unknown> | undefined;
  if (input) {
    if (typeof input.question === "string") return input.question;
    if (Array.isArray(input.questions)) {
      const first = input.questions[0] as Record<string, unknown> | undefined;
      if (first && typeof first.question === "string") return first.question;
    }
  }
  if (typeof payload.permission_prompt === "string") return payload.permission_prompt;
  return fallback;
}

function emptyRecord(tmuxPid: string, paneId: string): AgentRecord {
  return {
    tmuxPid,
    paneId,
    state: "unknown",
    source: "hook",
    toolName: null,
    prompt: null,
    title: null,
    lastEvent: null,
    lastTs: 0,
    lastPromptTs: null,
    subagents: "{}",
    ended: 0,
  };
}

export function reduceAgent(prev: AgentRecord | undefined, ev: RawEvent): AgentRecord {
  const base = prev ?? emptyRecord(ev.tmuxPid, ev.paneId);
  const payload = payloadOf(ev);
  const subagents = parseSubagents(base.subagents);
  const next: AgentRecord = { ...base, lastEvent: ev.event, lastTs: ev.ts, ended: 0 };

  switch (ev.event) {
    case "UserPromptSubmit":
      next.state = "working";
      next.source = "hook";
      next.toolName = null;
      next.prompt = typeof payload.prompt === "string" ? payload.prompt : null;
      // 제목은 세션의 첫 입력만 잡는다. 이후 입력으로 덮어쓰면 라벨이 계속 흔들린다.
      if (base.title == null) next.title = promptTitle(payload.prompt);
      next.lastPromptTs = ev.ts;
      break;

    case "PostToolUse":
    case "PostToolUseFailure":
      next.state = "working";
      next.source = "hook";
      break;

    case "PreToolUse": {
      const toolName = typeof payload.tool_name === "string" ? payload.tool_name : null;
      next.toolName = toolName;
      next.source = "hook";
      if (isInteractiveTool(toolName)) {
        next.state = "waiting";
        next.prompt = extractWaitingPrompt(payload, base.prompt);
      } else {
        next.state = "working";
      }
      break;
    }

    case "PermissionRequest":
      next.state = "waiting";
      next.source = "hook";
      next.prompt = extractWaitingPrompt(payload, base.prompt);
      break;

    case "Notification": {
      const notificationType = typeof payload.notification_type === "string" ? payload.notification_type : "";
      if (notificationType === "permission_prompt" || notificationType === "elicitation_dialog") {
        next.state = "waiting";
        next.source = "hook";
        next.prompt = extractWaitingPrompt(payload, base.prompt);
      }
      break;
    }

    case "Stop":
    case "StopFailure":
      next.state = Object.keys(subagents).length > 0 ? "working" : "done";
      next.source = "hook";
      break;

    case "PostCompact":
      if (payload.trigger === "manual") {
        next.state = Object.keys(subagents).length > 0 ? "working" : "done";
        next.source = "hook";
      }
      break;

    case "SessionStart":
      next.state = "done";
      next.source = "hook";
      next.toolName = null;
      next.prompt = null;
      next.title = null;
      next.subagents = "{}";
      return next;

    case "SessionEnd":
      next.ended = 1;
      break;

    // codex 전용. 사용자가 턴을 끊은 것이라 진행 중이던 도구가 있어도 에이전트는 멈춘다.
    case "Interrupt":
      next.state = "done";
      next.source = "hook";
      next.toolName = null;
      next.subagents = "{}";
      return next;

    case "SubagentStart": {
      const agentId = typeof payload.agent_id === "string" ? payload.agent_id : null;
      if (agentId) subagents[agentId] = "working";
      next.state = "working";
      next.source = "hook";
      break;
    }

    case "SubagentStop":
    case "TeammateIdle": {
      const agentId = typeof payload.agent_id === "string" ? payload.agent_id : null;
      if (agentId) delete subagents[agentId];
      break;
    }

    default:
      break;
  }

  next.subagents = JSON.stringify(subagents);
  return next;
}

export function effectiveState(
  rec: AgentRecord | undefined,
  now: number,
  screenWaiting: boolean
): { state: AgentState; source: string } {
  if (!rec) return { state: "unknown", source: "none" };
  if (rec.ended) return { state: "idle", source: "hook" };
  if (now - rec.lastTs > IDLE_MS) return { state: "idle", source: "hook" };
  if (screenWaiting) return { state: "waiting", source: "screen" };
  return { state: rec.state, source: rec.source };
}
