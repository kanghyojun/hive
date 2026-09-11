import { describe, expect, it } from "vitest";
import { encodeMessage, NdjsonDecoder, parseRequest } from "./collectorProtocol.js";

describe("수집기 NDJSON", () => {
  it("한글 UTF-8을 바이트마다 잘라도 복수 메시지를 복구합니다", () => {
    const received: unknown[] = [];
    const decoder = new NdjsonDecoder((value) => received.push(value));
    const values = [{ title: "수집 중입니다" }, { title: "완료했습니다" }];
    for (const byte of Buffer.from(values.map(encodeMessage).join(""))) decoder.push(Buffer.from([byte]));
    expect(received).toEqual(values);
  });

  it("한 chunk의 복수 메시지와 다음 chunk의 나머지를 처리합니다", () => {
    const received: unknown[] = [];
    const decoder = new NdjsonDecoder((value) => received.push(value));
    decoder.push(Buffer.from('1\n2\n{"a":'));
    expect(received).toEqual([1, 2]);
    decoder.push(Buffer.from('3}\n'));
    expect(received).toEqual([1, 2, { a: 3 }]);
  });

  it("개행 없는 입력과 완성된 큰 메시지 모두 크기를 제한합니다", () => {
    const decoder = new NdjsonDecoder(() => {}, 10);
    decoder.push(Buffer.from("123456"));
    expect(() => decoder.push(Buffer.from("12345"))).toThrow("너무 큽니다");
    expect(() => new NdjsonDecoder(() => {}, 3).push(Buffer.from('"abc"\n'))).toThrow("너무 큽니다");
    expect(() => new NdjsonDecoder(() => {}).push(Buffer.from("{broken}\n"))).toThrow();
  });

  it("요청 id, window id, 모드와 사용량 관심 필드를 검사합니다", () => {
    for (const value of [null, { id: "", command: { type: "refresh" } },
      { id: "1", command: { type: "toggleSleep", windowId: "other" } },
      { id: "1", command: { type: "usage", interested: "yes" } },
      { id: "1", command: { type: "setMode", mode: "other" } }]) {
      expect(() => parseRequest(value)).toThrow();
    }
    const request = { id: "1", command: { type: "toggleSleep", windowId: "@3" } };
    expect(parseRequest(request)).toEqual(request);
  });
});
