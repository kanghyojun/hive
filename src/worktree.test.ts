import { describe, expect, it } from "vitest";
import { uniqueSessionName } from "./worktree.js";

describe("uniqueSessionName", () => {
  const taken = (...names: string[]) => (name: string) => names.includes(name);

  it("비어 있는 이름은 그대로 쓴다", () => {
    expect(uniqueSessionName("codex-support", taken())).toBe("codex-support");
  });

  it("이미 있으면 -2부터 붙인다", () => {
    expect(uniqueSessionName("feat", taken("feat"))).toBe("feat-2");
    expect(uniqueSessionName("feat", taken("feat", "feat-2"))).toBe("feat-3");
  });

  it("tmux가 target 구분자로 쓰는 . : 와 공백은 -로 바꾼다", () => {
    expect(uniqueSessionName("release.1", taken())).toBe("release-1");
    expect(uniqueSessionName("fix:bug", taken())).toBe("fix-bug");
    expect(uniqueSessionName("my branch", taken())).toBe("my-branch");
  });

  it("치환 후 남는 앞뒤 -는 떼고, 전부 사라지면 hive로 둔다", () => {
    expect(uniqueSessionName(".hidden.", taken())).toBe("hidden");
    expect(uniqueSessionName("...", taken())).toBe("hive");
  });
});
