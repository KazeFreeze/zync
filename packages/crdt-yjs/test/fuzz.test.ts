import { describe, it, expect, afterEach } from "vitest";
import { SyncEngine, type EnginePorts, type EngineConfig } from "@zync/core";
import type { DeviceId, IdentityPort, VaultPath } from "@zync/core";
import {
  FakeVault,
  FakeClock,
  FakeBlobStore,
  FakeDocStore,
  MemEngineState,
  InProcessBus,
  type InProcessTransport,
} from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";

/**
 * Phase 0b-2 Task 14 + Task 8b — randomized-op convergence fuzzer.
 *
 * N peers on a shared in-process bus apply a deterministic stream of random ops
 * (edit / create / DELETE / partition / heal); after healing everyone and driving
 * the engines to a joint fixed point, EVERY peer's vault must be byte-identical
 * AND every peer's synced inbox must hold the SAME set of entries.
 *
 * DETERMINISM: the op stream is driven by a seeded `mulberry32` PRNG — NO
 * `Math.random`, NO wall-clock — and each fixed seed is its own `it()` so a
 * failure is reproducible and isolated. Bounded (peers × ops capped), so a
 * runaway relay loop trips the 15s worker timeout / heap cap instead of hanging.
 *
 * CONVERGENCE WITHOUT ARTIFACTS (prose arm): peer `i` only ever mutates LINE `i`
 * of a shared note (and never adds/removes a line), so concurrent edits are always
 * line-disjoint → merge3 stays clean → no conflict artifacts from the prose edits.
 *
 * STRUCTURAL ARM (Task 8b):
 *   • DELETE — a peer deletes one of ITS OWN uniquely-created (single-author)
 *     notes. The delete is uncontested, so the note + its content must be GONE on
 *     ALL peers at quiescence (tombstone replicates through any partition/heal).
 *   • PRE-START CREATE-COLLISIONS (in SETUP, not the op loop) — 2+ peers each
 *     create the SAME `collide-<k>.md` path with DIFFERENT content while offline.
 *     The index LWW binds one winner; the orphan-sweep RECOVERS the loser to a
 *     deterministic conflict path. After convergence BOTH contents are present on
 *     ALL peers, which is WHY the inbox is no longer empty (one recovery entry per
 *     loser) — so the assertion changed from "inboxes empty" to "inboxes CONVERGE
 *     IDENTICALLY across peers". (POST-start collisions are the deferred D5 case
 *     and are NOT injected into the running loop.)
 *
 * Uniquely-named creates in the op loop still avoid concurrent-create races; what
 * the fuzz stresses is the real risk: offline-origin edits, after-start creates
 * (Task 13b Part 2), uncontested deletes, and pre-start collision recovery ALL
 * surviving arbitrary partition/heal interleavings — converging byte-identically.
 */

const path = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Narrow `T | undefined` → `T` (strict-mode lint forbids non-null assertions). */
function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`fuzz invariant: ${what} is undefined`);
  return v;
}

/** Deterministic PRNG (mulberry32). Pure integer math — no Math.random/Date. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function identity(id: string, name: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => name };
}

interface Device {
  id: string;
  engine: SyncEngine;
  vault: FakeVault;
  transport: InProcessTransport;
  online: boolean;
  created: number;
  /** Live (not-yet-deleted) paths this peer created — the only notes it may delete. */
  liveCreated: string[];
}

function makeDevice(bus: InProcessBus, deviceId: string): Device {
  const vault = new FakeVault();
  const transport = bus.connect();
  const ports: EnginePorts = {
    vault,
    crdt: new YjsCrdtProvider(),
    transport,
    blobs: new FakeBlobStore(),
    docStore: new FakeDocStore(),
    clock: new FakeClock(),
    identity: identity(deviceId, deviceId),
    engineState: new MemEngineState(),
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
  };
  return {
    id: deviceId,
    engine: new SyncEngine(ports, config),
    vault,
    transport,
    online: true,
    created: 0,
    liveCreated: [],
  };
}

/**
 * Snapshot the SYNCED vault (user-visible notes) as a path→content map for a
 * byte-identical compare. EXCLUDES the config dir `.obsidian/zync/…`, which holds
 * the BaseStore's per-device reconcile records (`zync/base/<docId>.json`). Those
 * paths classify as `excluded` (classify.ts) — they are NEVER synced between
 * devices and legitimately differ per device: a DELETED doc keeps its base record
 * as local resurrection state (read by `onDelete`/edit-beats-delete), and its
 * device-specific `crdtToken` reflects that device's own attach history. So those
 * files MUST be excluded from a "byte-identical VAULT" compare — convergence is a
 * property of the synced notes, not of excluded local metadata.
 */
async function snapshotVault(d: Device): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const { path: p } of await d.vault.list()) {
    if (p.startsWith(".obsidian/zync/")) continue; // excluded-from-sync BaseStore records.
    const bytes = await d.vault.read(p);
    if (bytes !== null) out[p] = decode(bytes);
  }
  return out;
}

/** Drive all peers to a joint fixed point: round-robin waitConverged until clean. */
async function convergeAll(peers: Device[]): Promise<void> {
  for (let round = 0; round < 60; round++) {
    for (const p of peers) await p.engine.waitConverged();
    let clean = true;
    for (const p of peers) {
      if ((await p.engine.pendingDocs()).length > 0) {
        clean = false;
        break;
      }
    }
    if (clean) return;
  }
  throw new Error("convergeAll: peers did not reach a joint fixed point");
}

/** Mutate ONE character within a single line (never inserts/removes a newline). */
function mutateLine(line: string, rnd: () => number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 ";
  if (line.length > 0 && rnd() < 0.4) {
    const pos = Math.floor(rnd() * line.length);
    return line.slice(0, pos) + line.slice(pos + 1);
  }
  const pos = Math.floor(rnd() * (line.length + 1));
  const ch = alphabet[Math.floor(rnd() * alphabet.length)] ?? "x";
  return line.slice(0, pos) + ch + line.slice(pos);
}

const NUM_PEERS = 3;
const NUM_SHARED = 3;
/** Pre-start collision paths; each is created by EVERY peer with distinct content. */
const NUM_COLLISIONS = 2;
const OPS = 200;
const SEEDS = [1, 7, 42, 1337];

describe("SyncEngine convergence fuzzer (deterministic, seeded)", () => {
  let peers: Device[] = [];

  afterEach(async () => {
    for (const p of peers) await p.engine.stop();
    peers = [];
  });

  for (const seed of SEEDS) {
    it(`seed ${String(seed)}: ${String(NUM_PEERS)} peers × ${String(OPS)} random ops → byte-identical vaults`, async () => {
      const rnd = mulberry32(seed);
      const bus = new InProcessBus();
      peers = Array.from({ length: NUM_PEERS }, (_, i) => makeDevice(bus, `dev-${String(i)}`));

      // Seed shared multi-line notes on peer 0 (one line per peer) BEFORE start so
      // they bootstrap-seed + attach on everyone.
      const shared = Array.from({ length: NUM_SHARED }, (_, n) => path(`shared-${String(n)}.md`));
      for (const sp of shared) {
        const lines = Array.from({ length: NUM_PEERS }, (_, i) => `n${String(i)}:start`);
        await must(peers[0], "peer 0").vault.writeAtomic(sp, utf8(lines.join("\n")));
      }

      // PRE-START CREATE-COLLISIONS (Task 8b §2): while ALL peers are offline, EVERY
      // peer creates the SAME `collide-<k>.md` path with DISTINCT content. Offline,
      // each peer cannot see the others' index, so each seeds its OWN docId — a
      // genuine concurrent-create. On heal the index LWW binds one winner per path;
      // the orphan-sweep recovers the loser(s) to deterministic conflict paths. The
      // collisions live in SETUP (pre-start) — the in-scope case; POST-start
      // collisions are the deferred D5 path and are NOT injected into the op loop.
      const collidePaths = Array.from({ length: NUM_COLLISIONS }, (_, k) =>
        path(`collide-${String(k)}.md`),
      );
      for (const p of peers) {
        p.transport.goOffline();
        p.online = false;
      }
      for (const [pi, p] of peers.entries()) {
        for (const cp of collidePaths) {
          await p.vault.writeAtomic(cp, utf8(`collision ${cp} from ${p.id} (peer ${String(pi)})`));
        }
      }

      // Start every engine WHILE offline so each bootstrap-seeds its own colliding
      // docId in isolation; whenIdle is safe offline (catch-up is a no-op).
      for (const p of peers) await p.engine.start();
      for (const p of peers) await p.engine.whenIdle();

      // Heal everyone and converge: shared notes adopt + collisions resolve together.
      for (const p of peers) {
        p.transport.goOnline();
        p.online = true;
      }
      await convergeAll(peers);

      // Sanity: everyone adopted the shared notes before the storm.
      for (const p of peers) {
        for (const sp of shared) expect(await p.vault.read(sp)).not.toBeNull();
      }

      // Sanity: every distinct collision CONTENT survived SOMEWHERE on every peer
      // (winner at collide-<k>.md, loser(s) at recovered conflict paths). Content is
      // never dropped by the collision recovery.
      for (const p of peers) {
        const bodies = new Set<string>();
        for (const { path: fp } of await p.vault.list()) {
          const bytes = await p.vault.read(fp);
          if (bytes !== null) bodies.add(decode(bytes));
        }
        for (const cp of collidePaths) {
          for (const other of peers) {
            const expected = `collision ${cp} from ${other.id} (peer ${String(peers.indexOf(other))})`;
            expect(bodies.has(expected)).toBe(true);
          }
        }
      }

      let edits = 0;
      let creates = 0;
      let deletes = 0;
      let partitions = 0;
      let heals = 0;

      for (let op = 0; op < OPS; op++) {
        const actorIdx = Math.floor(rnd() * NUM_PEERS);
        const actor = must(peers[actorIdx], "actor");
        const roll = rnd();

        if (roll < 0.55) {
          // EDIT: actor mutates ITS OWN line of a random shared note (line-disjoint).
          const sp = must(shared[Math.floor(rnd() * NUM_SHARED)], "shared note");
          const bytes = await actor.vault.read(sp);
          if (bytes !== null) {
            const lines = decode(bytes).split("\n");
            lines[actorIdx] = mutateLine(lines[actorIdx] ?? "", rnd);
            await actor.vault.writeAtomic(sp, utf8(lines.join("\n")));
            edits++;
          }
        } else if (roll < 0.73) {
          // CREATE: uniquely-named single-line note (no concurrent-create races).
          actor.created++;
          const name = `${actor.id}-note-${String(actor.created)}.md`;
          await actor.vault.writeAtomic(
            path(name),
            utf8(`created by ${actor.id} #${String(actor.created)}`),
          );
          actor.liveCreated.push(name);
          creates++;
        } else if (roll < 0.83) {
          // DELETE: actor removes ONE of ITS OWN previously-created notes. Single-
          // author → the delete is uncontested, so the note MUST be gone on ALL
          // peers at quiescence (the tombstone replicates through any partition).
          if (actor.liveCreated.length > 0) {
            const di = Math.floor(rnd() * actor.liveCreated.length);
            const target = must(actor.liveCreated[di], "delete target");
            actor.liveCreated.splice(di, 1);
            await actor.vault.remove(path(target));
            deletes++;
          }
        } else if (roll < 0.92) {
          // PARTITION the actor (no-op if already offline).
          if (actor.online) {
            actor.transport.goOffline();
            actor.online = false;
            partitions++;
          }
        } else {
          // HEAL the actor (no-op if already online).
          if (!actor.online) {
            actor.transport.goOnline();
            actor.online = true;
            heals++;
          }
        }

        // Settle the actor's own in-flight work. whenIdle is safe offline: catch-up
        // is a no-op while disconnected (Task 13b Part 2), so this cannot hang.
        await actor.engine.whenIdle();
      }

      // Heal everyone and drive to a joint fixed point.
      for (const p of peers) {
        if (!p.online) {
          p.transport.goOnline();
          p.online = true;
        }
      }
      await convergeAll(peers);

      // Every peer's ENTIRE vault is byte-identical — recovered collision artifacts
      // AND tombstone-removals replicated to every peer (zero divergence).
      const ref = await snapshotVault(must(peers[0], "peer 0"));
      for (let i = 1; i < NUM_PEERS; i++) {
        expect(await snapshotVault(must(peers[i], "peer i"))).toEqual(ref);
      }

      // Every UNCONTESTED delete propagated: a deleted own-created note is absent on
      // EVERY peer's disk (the tombstone reached everyone through partition/heal).
      for (const p of peers) {
        for (let c = 1; c <= p.created; c++) {
          const name = `${p.id}-note-${String(c)}.md`;
          if (p.liveCreated.includes(name)) continue;
          for (const other of peers) {
            expect(await other.vault.read(path(name))).toBeNull();
          }
        }
      }

      // The synced inbox CONVERGES IDENTICALLY across peers (the empty-inbox invariant
      // no longer holds: pre-start collisions produce one recovery entry per loser).
      // Line-disjoint prose edits and single-author deletes add NO artifacts, so the
      // only entries are the deterministic collision recoveries — identical everywhere.
      const inboxView = (p: Device): string[] =>
        p.engine.inbox
          .list()
          .map((e) => `${e.kind}|${e.path}|${e.id}`)
          .sort();
      const refInbox = inboxView(must(peers[0], "peer 0"));
      for (let i = 1; i < NUM_PEERS; i++) {
        expect(inboxView(must(peers[i], "peer i"))).toEqual(refInbox);
      }
      // The collisions actually produced recovery entries (no vacuous inbox compare).
      expect(refInbox.length).toBeGreaterThan(0);

      // The run actually exercised every op kind (no vacuous pass).
      expect(edits).toBeGreaterThan(0);
      expect(creates).toBeGreaterThan(0);
      expect(deletes).toBeGreaterThan(0);
      expect(partitions).toBeGreaterThan(0);
      expect(heals).toBeGreaterThan(0);
      // The shared notes carry real merged content from all peers.
      expect(Object.keys(ref).length).toBeGreaterThanOrEqual(NUM_SHARED);
    });
  }
});
