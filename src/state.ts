export type AgentState = "working" | "waiting" | "done" | "idle" | "unknown";

export interface AgentRecord {
  tmuxPid: string;
  paneId: string;
  state: AgentState;
  source: string; // "hook" | "screen"
  toolName: string | null;
  prompt: string | null;
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

export const PERMISSION_PATTERNS = [/Do you want to proceed\?/, /Yes, and don't ask again/];

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
      next.subagents = "{}";
      return next;

    case "SessionEnd":
      next.ended = 1;
      break;

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
