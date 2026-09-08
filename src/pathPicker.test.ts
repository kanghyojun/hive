import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collapseHome, expandHome, fuzzyMatch, listDirCandidates, sliceStart } from "./pathPicker.js";

describe("fuzzyMatch", () => {
  it("흩어진 글자도 순서만 맞으면 매치한다", () => {
    expect(fuzzyMatch("ab-bridge", "abr")).not.toBeNull();
  });

  it("순서가 어긋나면 매치하지 않는다", () => {
    expect(fuzzyMatch("ab-bridge", "rba")).toBeNull();
  });

  it("없는 글자가 있으면 매치하지 않는다", () => {
    expect(fuzzyMatch("hive", "hz")).toBeNull();
  });

  it("빈 질의는 무엇에나 매치한다", () => {
    expect(fuzzyMatch("hive", "")).not.toBeNull();
  });

  it("대소문자를 무시한다", () => {
    expect(fuzzyMatch("MacHandoff", "mach")).not.toBeNull();
  });

  it("앞에서부터 붙어 있는 매치에 더 높은 점수를 준다", () => {
    const prefix = fuzzyMatch("hive", "hi");
    const scattered = fuzzyMatch("highlevel-vote", "hi");
    expect(prefix).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(prefix!).toBeGreaterThan(0);
  });

  it("연속 매치가 흩어진 매치보다 점수가 높다", () => {
    const contiguous = fuzzyMatch("xxhive", "hive")!;
    const scattered = fuzzyMatch("xxhaiavae", "hive")!;
    expect(contiguous).toBeGreaterThan(scattered);
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "hive-pathpicker-"));
  mkdirSync(join(root, "hive", ".git"), { recursive: true });
  mkdirSync(join(root, "highlevel"), { recursive: true });
  mkdirSync(join(root, "samata"), { recursive: true });
  mkdirSync(join(root, ".hidden"), { recursive: true });
  // worktree는 .git이 디렉토리가 아니라 파일이다.
  mkdirSync(join(root, "linked"), { recursive: true });
  writeFileSync(join(root, "linked", ".git"), "gitdir: /elsewhere\n");
  writeFileSync(join(root, "notes.md"), "");
  symlinkSync(join(root, "samata"), join(root, "linkdir"));
  symlinkSync(join(root, "notes.md"), join(root, "linkfile.md"));
  return root;
}

describe("listDirCandidates", () => {
  it("디렉토리만 주고 파일은 뺀다", () => {
    const root = fixture();
    const names = listDirCandidates(`${root}/`).map((c) => c.name);
    expect(names).toContain("hive");
    expect(names).not.toContain("notes.md");
  });

  it("마지막 세그먼트를 질의로 써서 거른다", () => {
    const root = fixture();
    const names = listDirCandidates(`${root}/sam`).map((c) => c.name);
    expect(names).toEqual(["samata"]);
  });

  it("슬래시로 끝나면 그 디렉토리를 통째로 나열한다", () => {
    const root = fixture();
    const names = listDirCandidates(`${root}/`).map((c) => c.name);
    expect(names).toContain("hive");
    expect(names).toContain("samata");
    expect(names).toContain("highlevel");
  });

  it("점수가 높은 후보를 앞에 놓는다", () => {
    const root = fixture();
    const names = listDirCandidates(`${root}/hi`).map((c) => c.name);
    expect(names).toEqual(["hive", "highlevel"]);
  });

  it(".git 디렉토리가 있으면 저장소로 표시한다", () => {
    const root = fixture();
    const hive = listDirCandidates(`${root}/hive`)[0];
    expect(hive.isRepo).toBe(true);
  });

  it(".git이 파일인 worktree도 저장소로 표시한다", () => {
    const root = fixture();
    const linked = listDirCandidates(`${root}/linked`)[0];
    expect(linked.isRepo).toBe(true);
  });

  it("저장소가 아닌 디렉토리는 표시하지 않는다", () => {
    const root = fixture();
    const samata = listDirCandidates(`${root}/samata`)[0];
    expect(samata.isRepo).toBe(false);
  });

  it("숨김 디렉토리는 기본으로 감춘다", () => {
    const root = fixture();
    const names = listDirCandidates(`${root}/`).map((c) => c.name);
    expect(names).not.toContain(".hidden");
  });

  it("점으로 시작하는 질의에는 숨김 디렉토리를 보여준다", () => {
    const root = fixture();
    const names = listDirCandidates(`${root}/.hid`).map((c) => c.name);
    expect(names).toEqual([".hidden"]);
  });

  it("절대경로를 함께 준다", () => {
    const root = fixture();
    expect(listDirCandidates(`${root}/hive`)[0].path).toBe(join(root, "hive"));
  });

  it("디렉토리를 가리키는 심볼릭 링크도 후보로 넣는다", () => {
    const root = fixture();
    const names = listDirCandidates(`${root}/link`).map((c) => c.name);
    expect(names).toContain("linkdir");
  });

  it("파일을 가리키는 심볼릭 링크는 빼놓는다", () => {
    const root = fixture();
    const names = listDirCandidates(`${root}/link`).map((c) => c.name);
    expect(names).not.toContain("linkfile.md");
  });

  it("없는 디렉토리는 빈 목록이다", () => {
    const root = fixture();
    expect(listDirCandidates(`${root}/nope/deeper`)).toEqual([]);
  });

  it("물결표 하나만 있으면 홈 전체를 나열한다", () => {
    const root = fixture();
    const names = listDirCandidates("~/", root).map((c) => c.name);
    expect(names).toContain("samata");
    expect(names).toContain("hive");
  });

  it("물결표를 홈으로 편다", () => {
    const root = fixture();
    const names = listDirCandidates("~/sam", root).map((c) => c.name);
    expect(names).toEqual(["samata"]);
  });
});

describe("collapseHome", () => {
  it("홈 아래 경로는 물결표로 줄인다", () => {
    expect(collapseHome("/home/ed/src/hive", "/home/ed")).toBe("~/src/hive");
  });

  it("홈 자체는 물결표 하나다", () => {
    expect(collapseHome("/home/ed", "/home/ed")).toBe("~");
  });

  it("홈 밖 경로는 그대로 둔다", () => {
    expect(collapseHome("/opt/work/repo", "/home/ed")).toBe("/opt/work/repo");
  });

  it("이름만 겹치는 형제 디렉토리를 홈으로 착각하지 않는다", () => {
    expect(collapseHome("/home/edward/src", "/home/ed")).toBe("/home/edward/src");
  });
});

describe("sliceStart", () => {
  it("다 들어가면 처음부터 보여준다", () => {
    expect(sliceStart(0, 3, 8)).toBe(0);
  });

  it("커서가 첫 화면 안이면 밀지 않는다", () => {
    expect(sliceStart(7, 20, 8)).toBe(0);
  });

  it("커서가 화면 밖으로 나가면 한 줄씩 민다", () => {
    expect(sliceStart(8, 20, 8)).toBe(1);
  });

  it("끝까지 가도 빈 줄이 남지 않게 멈춘다", () => {
    expect(sliceStart(19, 20, 8)).toBe(12);
  });

  it("후보가 없으면 0이다", () => {
    expect(sliceStart(0, 0, 8)).toBe(0);
  });
});

describe("expandHome", () => {
  it("뒤따르는 슬래시를 잃지 않는다", () => {
    expect(expandHome("~/", "/home/x")).toBe("/home/x/");
  });

  it("홈 아래 경로를 편다", () => {
    expect(expandHome("~/src/hive", "/home/x")).toBe("/home/x/src/hive");
  });

  it("홈 밖 절대경로는 그대로 둔다", () => {
    expect(expandHome("/opt/repo", "/home/x")).toBe("/opt/repo");
  });
});
