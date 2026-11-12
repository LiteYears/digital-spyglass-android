import { describe, expect, it } from "vitest";
import {
  areQueriesNearDuplicates,
  isRewriteAcceptable,
  localInferenceEndpoint,
  parseDecoyLines,
} from "../query-privacy-guards";

describe("localInferenceEndpoint", () => {
  it.each([
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080/v1/chat/completions"],
    ["http://[::1]:9090/v1/", "http://[::1]:9090/v1/chat/completions"],
  ])("accepts literal loopback: %s", (input, expected) => {
    expect(localInferenceEndpoint(input)).toBe(expected);
  });

  it.each([
    "https://example.com/v1",
    "http://localhost:8080",
    "http://192.168.1.1:8080",
    "http://127.0.0.1.example.com:8080",
    "http://user:secret@127.0.0.1:8080",
    "http://127.0.0.1:8080/v1?key=secret",
    "http://127.0.0.1:8080/#remote",
    "http://127.0.0.1:8080/proxy",
    "file:///tmp/model",
    "not a URL",
  ])("rejects nonlocal or ambiguous configuration: %s", (input) => {
    expect(localInferenceEndpoint(input)).toBeNull();
  });
});

describe("parseDecoyLines", () => {
  it("parses bounded numbered and bulleted lines", () => {
    expect(
      parseDecoyLines("1. museum opening hours\r\n- marine biology\n\n2) rail timetables"),
    ).toEqual(["museum opening hours", "marine biology", "rail timetables"]);
  });

  it.each([
    null,
    {},
    "a".repeat(8193),
    "\n".repeat(33),
    "a".repeat(257),
    "<think>secret</think>",
    "bad\u0000query",
    "bad\u202equery",
    "bad\u2028query",
  ])("rejects malformed or excessive model output", (value) =>
    expect(parseDecoyLines(value)).toEqual([]),
  );
});

describe("lexical query guards", () => {
  it("detects normalized duplicates and expanded copies", () => {
    expect(areQueriesNearDuplicates("Museum hours", "Ｍｕｓｅｕｍ HOURS")).toBe(true);
    expect(
      areQueriesNearDuplicates("museum opening hours", "museum opening hours on weekends"),
    ).toBe(true);
    expect(areQueriesNearDuplicates("museum opening hours", "marine biology")).toBe(false);
    expect(areQueriesNearDuplicates("", "marine biology")).toBe(true);
  });

  it.each([
    [
      "ey yo hast du mal nen plan wie ich daten aus kaputter festplatte retten kann",
      "Daten aus kaputter Festplatte retten",
    ],
    [
      "hey bro whats the best way to recover deleted files from my usb stick lol",
      "recover deleted files from usb stick",
    ],
    ["kannst du mir bitte sagen wie man leaked credentials findet", "leaked credentials finden"],
    ["why does ERR-18 appear on v2.4.1", "ERR-18 v2.4.1"],
  ])("accepts extractive rewrite: %s -> %s", (original, candidate) => {
    expect(isRewriteAcceptable(original, candidate)).toBe(true);
  });

  it.each([
    [
      "pls help me find info about CVE-2024-3094 xz backdoor",
      "CVE-2024-3094 xz backdoor information",
    ],
    ["Wie funktioniert Tor Onion Routing eigentlich genau", "Tor Onion Routing Funktionsweise"],
    ["how to secure server", "how to attack server"],
    [
      "bitcoin wallet 1BoatSLRHtKNngkdXEeobR76b53LETtpyT recovery",
      "bitcoin wallet 1boatslrhtkNngkdxeeobr76b53letTpyt recovery",
    ],
    [
      "bitcoin wallet bc1qar0srrr7xfkvy5l643lydnw9re recovery",
      "bitcoin wallet bc1qar0srrr7xfkvy5l643lydnw9rf recovery",
    ],
    ["server logs without passwords", "server logs with passwords"],
    ["how to not get tracked by isp", "how to get tracked by isp"],
    ["how to get tracked by isp", "how to not get tracked by isp"],
    ["Serverlogs wiederherstellen 2026", "Recover server logs 2026"],
    ["tor browser bundle download", "weather in paris today"],
    ["cve-2024-3094", "cve-2024-3094 exploit code github"],
    ['"exact phrase" search', "exact phrase search"],
    ["server logs", null],
    ["server logs", ""],
    ["server logs", "a".repeat(257)],
    ["server logs", "server\nlogs"],
    ["server logs", "<think>server logs</think>"],
  ])("rejects unsafe rewrite: %s -> %s", (original, candidate) => {
    expect(isRewriteAcceptable(original, candidate)).toBe(false);
  });

  it("known limit: dropping a plain content word is not detected lexically", () => {
    expect(isRewriteAcceptable("best nas for plex", "best nas")).toBe(true);
  });
});
