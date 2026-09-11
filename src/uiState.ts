import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ViewMode } from "./model.js";
import { uiStatePath } from "./paths.js";

export function loadMode(): ViewMode {
  try {
    const raw = JSON.parse(readFileSync(uiStatePath(), "utf8"));
    return raw.mode === "group" ? "group" : "recent";
  } catch {
    return "recent";
  }
}

export function saveMode(mode: ViewMode): void {
  const path = uiStatePath();
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ mode }), { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch { /* rename이 성공하면 임시 파일은 이미 없다. */ }
  }
}
