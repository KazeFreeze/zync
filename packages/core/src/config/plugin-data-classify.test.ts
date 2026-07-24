import { describe, it, expect } from "vitest";
import { classifyPluginDataChange, tryParseJson, NOISY_DATA_KEYS } from "./plugin-data-classify.js";
import type { Sha256 } from "../ports.js";

const sha = (s: string): Sha256 => s as Sha256;
const enc = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));

describe("classifyPluginDataChange", () => {
  const base = {
    s: sha("S"),
    m: sha("M"),
    r: null,
    materialized: { a: 1 },
    local: { a: 1, b: 2 },
    noisyKeys: NOISY_DATA_KEYS,
  };
  it("S===M → suppress", () => {
    expect(classifyPluginDataChange({ ...base, s: sha("M"), m: sha("M") })).toBe("suppress");
  });
  it("S===R → suppress", () => {
    expect(classifyPluginDataChange({ ...base, s: sha("R"), r: sha("R") })).toBe("suppress");
  });
  it("benign superset (adds key) → adopt-normalized", () => {
    expect(classifyPluginDataChange(base)).toBe("adopt-normalized");
  });
  it("changed value → publish", () => {
    expect(classifyPluginDataChange({ ...base, materialized: { a: 1 }, local: { a: 9 } })).toBe(
      "publish",
    );
  });
  it("local unparseable (undefined) → publish", () => {
    expect(classifyPluginDataChange({ ...base, local: undefined })).toBe("publish");
  });
  it("materialized undefined (blob absent) → publish", () => {
    expect(classifyPluginDataChange({ ...base, materialized: undefined })).toBe("publish");
  });
});

describe("tryParseJson", () => {
  it("parses valid JSON, undefined on garbage/null", () => {
    expect(tryParseJson(enc({ a: 1 }))).toEqual({ a: 1 });
    expect(tryParseJson(new TextEncoder().encode("{not json"))).toBeUndefined();
    expect(tryParseJson(null)).toBeUndefined();
  });
});
