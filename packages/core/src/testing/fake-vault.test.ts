import { describe, it, expect, vi } from "vitest";
import { FakeVault } from "./fake-vault.js";
import type { VaultEvent, VaultPath } from "../ports.js";

const p = (s: string) => s as VaultPath;
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

describe("FakeVault", () => {
  it("writes, reads, lists, and removes", async () => {
    const v = new FakeVault();
    await v.writeAtomic(p("a.md"), enc("hello"));
    const readResult = await v.read(p("a.md"));
    expect(readResult).not.toBeNull();
    expect(dec(readResult ?? new Uint8Array())).toBe("hello");
    expect(await v.read(p("missing.md"))).toBeNull();
    expect((await v.list()).map((f) => f.path)).toEqual([p("a.md")]);
    await v.remove(p("a.md"));
    expect(await v.read(p("a.md"))).toBeNull();
  });
  it("emits events for writes, renames, deletes", async () => {
    const v = new FakeVault();
    const cb = vi.fn<(e: VaultEvent) => void>();
    v.onEvent(cb);
    await v.writeAtomic(p("a.md"), enc("x"));
    await v.rename(p("a.md"), p("b.md"));
    await v.remove(p("b.md"));
    expect(cb.mock.calls.map((c) => c[0].type)).toEqual(["create", "rename", "delete"]);
  });
  it("emits 'modify' (not 'create') when overwriting", async () => {
    const v = new FakeVault();
    const cb = vi.fn<(e: VaultEvent) => void>();
    await v.writeAtomic(p("a.md"), enc("x"));
    v.onEvent(cb);
    await v.writeAtomic(p("a.md"), enc("y"));
    const firstCall = cb.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.[0].type).toBe("modify");
  });
});

describe("FakeVault test capabilities (M1b)", () => {
  it("durabilityTrusted reflects the constructor flag (default false)", () => {
    expect(new FakeVault().durabilityTrusted()).toBe(false);
    expect(new FakeVault({ durable: true }).durabilityTrusted()).toBe(true);
  });

  it("hideFromList hides a path from list() but read() still returns its bytes", async () => {
    const v = new FakeVault();
    await v.writeAtomic(p("notes/x.md"), enc("hello"));
    v.hideFromList(p("notes/x.md"));
    expect((await v.list()).map((e) => e.path)).not.toContain("notes/x.md");
    expect(await v.read(p("notes/x.md"))).not.toBeNull();
  });
});
