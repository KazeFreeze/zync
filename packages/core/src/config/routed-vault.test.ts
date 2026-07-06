import { describe, it, expect, vi } from "vitest";
import { RoutedVault } from "./routed-vault.js";
import type { ConfigPort, VaultPort, VaultPath } from "../ports.js";

const p = (s: string) => s as VaultPath;

function makeVaultStub() {
  const read = vi.fn(() => Promise.resolve(null));
  const writeAtomic = vi.fn(() => Promise.resolve());
  const remove = vi.fn(() => Promise.resolve());
  const rename = vi.fn(() => Promise.resolve());
  const list = vi.fn(() => Promise.resolve([]));
  const onEvent = vi.fn(() => () => undefined);
  const vault = { read, writeAtomic, remove, rename, list, onEvent } as unknown as VaultPort;
  return { vault, read, writeAtomic, remove, rename, list, onEvent };
}

function makeConfigStub() {
  const read = vi.fn(() => Promise.resolve(new Uint8Array([1])));
  const writeAtomic = vi.fn(() => Promise.resolve());
  const remove = vi.fn(() => Promise.resolve());
  const list = vi.fn(() => Promise.resolve([]));
  const onChange = vi.fn(() => () => undefined);
  const rescan = vi.fn(() => Promise.resolve());
  const close = vi.fn();
  const config = { read, writeAtomic, remove, list, onChange, rescan, close } as ConfigPort;
  return { config, read, writeAtomic, remove, list, onChange, rescan, close };
}

describe("RoutedVault", () => {
  it("routes config-zone writes to ConfigPort", async () => {
    const { vault: v, writeAtomic: vWrite } = makeVaultStub();
    const { config: c, writeAtomic: cWrite } = makeConfigStub();
    const rv = new RoutedVault(v, c);
    await rv.writeAtomic(p(".obsidian/snippets/x.css"), new Uint8Array([9]));
    expect(cWrite).toHaveBeenCalled();
    expect(vWrite).not.toHaveBeenCalled();
  });
  it("routes non-config writes to the inner vault", async () => {
    const { vault: v, writeAtomic: vWrite } = makeVaultStub();
    const { config: c, writeAtomic: cWrite } = makeConfigStub();
    const rv = new RoutedVault(v, c);
    await rv.writeAtomic(p("notes/a.md"), new Uint8Array([9]));
    expect(vWrite).toHaveBeenCalled();
    expect(cWrite).not.toHaveBeenCalled();
  });
  it("routes config-zone reads/removes to ConfigPort", async () => {
    const { vault: v } = makeVaultStub();
    const { config: c, read: cRead, remove: cRemove } = makeConfigStub();
    const rv = new RoutedVault(v, c);
    expect(await rv.read(p(".obsidian/themes/F/theme.css"))).toEqual(new Uint8Array([1]));
    await rv.remove(p(".obsidian/themes/F/theme.css"));
    expect(cRead).toHaveBeenCalled();
    expect(cRemove).toHaveBeenCalled();
  });
});
