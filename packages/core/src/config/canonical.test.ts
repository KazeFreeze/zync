import { describe, it, expect } from "vitest";
import { canonicalJsonBytes, configIdentitySha, configStoredBytes } from "./canonical.js";
import { sha256OfBytes } from "../hash.js";
import type { VaultPath } from "../ports.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dataPath = ".obsidian/plugins/dataview/data.json" as VaultPath;
const themePath = ".obsidian/themes/x/theme.css" as VaultPath;

describe("canonicalJsonBytes", () => {
  it("sorts keys so reordering is identical", () => {
    expect(canonicalJsonBytes(enc(`{"b":1,"a":2}`))).toEqual(
      canonicalJsonBytes(enc(`{"a":2,"b":1}`)),
    );
  });
  it("normalizes whitespace", () => {
    expect(canonicalJsonBytes(enc(`{ "a":  1 }`))).toEqual(canonicalJsonBytes(enc(`{"a":1}`)));
  });
  it("sorts nested keys", () => {
    expect(canonicalJsonBytes(enc(`{"o":{"y":1,"x":2}}`))).toEqual(
      canonicalJsonBytes(enc(`{"o":{"x":2,"y":1}}`)),
    );
  });
  it("returns raw bytes on non-JSON (never throws)", () => {
    const raw = enc("not json {");
    expect(canonicalJsonBytes(raw)).toEqual(raw);
  });
});

describe("configIdentitySha", () => {
  it("plugin-data: key-reorder yields the same sha", async () => {
    expect(await configIdentitySha(dataPath, enc(`{"b":1,"a":2}`))).toBe(
      await configIdentitySha(dataPath, enc(`{"a":2,"b":1}`)),
    );
  });
  it("plugin-data: value change yields a different sha", async () => {
    expect(await configIdentitySha(dataPath, enc(`{"a":1}`))).not.toBe(
      await configIdentitySha(dataPath, enc(`{"a":2}`)),
    );
  });
  it("non-plugin-data (themes) uses RAW sha (no canonicalization)", async () => {
    const a = enc(`{"b":1,"a":2}`);
    expect(await configIdentitySha(themePath, a)).toBe(await sha256OfBytes(a));
  });
});

describe("configStoredBytes", () => {
  it("plugin-data: stored bytes are canonical and hash to the identity sha (invariant)", async () => {
    const raw = enc(`{"b":1,"a":2}`);
    expect(configStoredBytes(dataPath, raw)).toEqual(canonicalJsonBytes(raw));
    // Invariant: configIdentitySha(path, bytes) === sha256OfBytes(configStoredBytes(path, bytes)).
    expect(await sha256OfBytes(configStoredBytes(dataPath, raw))).toBe(
      await configIdentitySha(dataPath, raw),
    );
  });
  it("non-plugin-data (themes) returns raw bytes unchanged", () => {
    const raw = enc(`{"b":1,"a":2}`);
    expect(configStoredBytes(themePath, raw)).toBe(raw);
  });
});
