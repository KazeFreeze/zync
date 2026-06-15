import { describe, it, expect, afterEach } from "vitest";
import { SyncEngine, type EnginePorts, type EngineConfig } from "@zync/core";
import type { DeviceId, IdentityPort, VaultEvent, VaultPath } from "@zync/core";
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

/**
 * A {@link FakeVault} whose `rename` ALSO emits the REORDERED post-rename watcher
 * fallout a REAL recursive `fs.watch` produces after a physical move (0b-3 rename
 * transaction, GPT-5.5 root cause). The plain FakeVault emits ONLY the synthetic
 * `{type:"rename"}`, so the fuzzer would keep the SAME blind spot the in-process
 * structural rename test had — a renamed file failing to materialize over a real
 * watcher would never surface. Wiring the fallout here makes every RENAME op exercise
 * the watcher-transaction path: both the INITIATING device (its own rename) and any
 * RECEIVER whose structural reconcile issues `vault.rename` (which routes through this
 * same override) fire the fallout identically.
 *
 * The fallout shape ROTATES DETERMINISTICALLY (an internal counter — NO wall-clock, NO
 * Math.random) across the three shapes the real watcher can produce, INCLUDING the fatal
 * `delete(new)` reordering the prior synchronous `delete(old)+modify(new)` model never
 * exercised. Emitted synchronously (the worst-case race: the engine's onRename has
 * re-keyed + opened the transaction, the fallout handlers queue immediately behind it),
 * so the fuzzer stays deterministic while covering the reordered shapes.
 */
class WatcherVault extends FakeVault {
  /** Deterministic fallout-shape rotation counter (no wall-clock, no Math.random). */
  private falloutSeq = 0;

  override async rename(from: VaultPath, to: VaultPath): Promise<void> {
    const existed = (await this.read(from)) !== null;
    await super.rename(from, to); // physical move + synthetic {type:"rename"}.
    if (!existed) return;
    // Rotate across the real watcher's fallout shapes — incl. a `delete(new)` (the
    // coalesced target probe racing a transient absence) and a reordered delete-after-
    // modify. The transaction must quarantine ALL of them; the renamed file must survive.
    const shape = this.falloutSeq++ % 3;
    const fallout: VaultEvent[] =
      shape === 0
        ? [
            { type: "delete", path: from },
            { type: "modify", path: to },
          ]
        : shape === 1
          ? [
              { type: "delete", path: to }, // the fatal delete(new).
              { type: "delete", path: from },
            ]
          : [
              { type: "modify", path: to },
              { type: "delete", path: from }, // delete(old) AFTER modify(new).
            ];
    for (const e of fallout) this.emitRaw(e);
  }

  private emitRaw(e: VaultEvent): void {
    for (const l of this.spuriousListeners) l(e);
  }

  private readonly spuriousListeners = new Set<(e: VaultEvent) => void>();

  override onEvent(cb: (e: VaultEvent) => void): () => void {
    this.spuriousListeners.add(cb);
    const unsub = super.onEvent(cb);
    return () => {
      this.spuriousListeners.delete(cb);
      unsub();
    };
  }
}

interface Device {
  id: string;
  engine: SyncEngine;
  vault: WatcherVault;
  transport: InProcessTransport;
  online: boolean;
  created: number;
  /** Live (not-yet-deleted, not-yet-renamed) paths this peer created — the only notes it may delete or rename. */
  liveCreated: string[];
}

function makeDevice(bus: InProcessBus, deviceId: string): Device {
  const vault = new WatcherVault();
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
    // The fuzzer's WatcherVault emits its fallout SYNCHRONOUSLY (consumed before
    // `vault.rename` returns, while the transaction is open), so the settle window need
    // not bridge any async gap — a tiny window keeps the 200-op × 4-seed budget well
    // under the 15s worker timeout while still exercising the full quarantine + settle.
    renameSettleMs: 1,
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
      let renames = 0;
      let partitions = 0;
      let heals = 0;
      // RENAME tracking (0b-3 Fix 2). Each rename of an own-created note records the
      // NEW path → its content, so the final byte-identical-vaults + identical-inboxes
      // assertions catch a renamed file that fails to MATERIALIZE at the new path or is
      // MIS-TOMBSTONED (the watcher-echo bug: a spurious delete(old)/modify(new) strands
      // the old file or re-mints a new docId). A note may be renamed more than once, so
      // we key by the FINAL new path and store its (unchanged) content. The OLD names are
      // dropped from `liveCreated`, so the delete-propagation assertion already verifies
      // each renamed-away old path is gone on EVERY peer.
      const renamedNotes = new Map<string, string>();
      // POST-start create-collisions (0b-3 Fix 1). Each collision op partitions ALL peers,
      // then has EVERY peer create the SAME fresh `collide-post-<k>.md` path with distinct
      // content (a genuine after-start concurrent create — the case the in-process
      // engine-after-start-create test reproduces). On the final heal the index LWW binds
      // one winner per path and the orphan sweep recovers the loser(s); the byte-identical
      // vaults + identical-inboxes assertions below catch any lost loser.
      let collisions = 0;
      const postCollideContents = new Map<string, string[]>();

      for (let op = 0; op < OPS; op++) {
        const actorIdx = Math.floor(rnd() * NUM_PEERS);
        const actor = must(peers[actorIdx], "actor");
        const roll = rnd();

        if (roll < 0.46) {
          // EDIT: actor mutates ITS OWN line of a random shared note (line-disjoint).
          const sp = must(shared[Math.floor(rnd() * NUM_SHARED)], "shared note");
          const bytes = await actor.vault.read(sp);
          if (bytes !== null) {
            const lines = decode(bytes).split("\n");
            lines[actorIdx] = mutateLine(lines[actorIdx] ?? "", rnd);
            await actor.vault.writeAtomic(sp, utf8(lines.join("\n")));
            edits++;
          }
        } else if (roll < 0.64) {
          // CREATE: uniquely-named single-line note (no concurrent-create races).
          actor.created++;
          const name = `${actor.id}-note-${String(actor.created)}.md`;
          await actor.vault.writeAtomic(
            path(name),
            utf8(`created by ${actor.id} #${String(actor.created)}`),
          );
          actor.liveCreated.push(name);
          creates++;
        } else if (roll < 0.74) {
          // DELETE: actor removes ONE of ITS OWN previously-created notes. Single-
          // author → the delete is uncontested, so the note MUST be gone on ALL
          // peers at quiescence (the tombstone replicates through any partition).
          if (actor.liveCreated.length > 0) {
            const di = Math.floor(rnd() * actor.liveCreated.length);
            const target = must(actor.liveCreated[di], "delete target");
            actor.liveCreated.splice(di, 1);
            // A note may have been RENAMED before this delete (its current name is a
            // `-renamed-` path tracked in `renamedNotes`). Deleting it must drop that
            // survival expectation — otherwise the rename-survival assertion would wrongly
            // demand a legitimately-deleted note still exist. (The delete-propagation
            // assertion still verifies the deleted path is absent on every peer.)
            renamedNotes.delete(target);
            await actor.vault.remove(path(target));
            deletes++;
          }
        } else if (roll < 0.82) {
          // RENAME (0b-3 Fix 2): actor renames ONE of ITS OWN previously-created notes
          // via `vault.rename`. The WatcherVault ALSO emits the spurious post-rename
          // `delete(old)` + `modify(new)` the real recursive watcher produces — the blind
          // spot the plain-FakeVault rename never exercised. Single-author → no rename
          // conflict; the renamed file must MATERIALIZE at the new path with docId
          // continuity on EVERY peer (caught by the byte-identical-vaults compare), and
          // the old path must be GONE everywhere (caught by the delete-propagation check,
          // since the old name is dropped from `liveCreated`). The new path is unique
          // (`-renamed-<n>`) so it never collides with a future create. May rename an
          // already-renamed note again — content is preserved across renames.
          if (actor.liveCreated.length > 0) {
            const ri = Math.floor(rnd() * actor.liveCreated.length);
            const from = must(actor.liveCreated[ri], "rename source");
            const fromBytes = await actor.vault.read(path(from));
            if (fromBytes !== null) {
              actor.created++;
              const to = `${actor.id}-renamed-${String(actor.created)}.md`;
              await actor.vault.rename(path(from), path(to));
              actor.liveCreated.splice(ri, 1);
              actor.liveCreated.push(to);
              renamedNotes.delete(from); // a renamed-AGAIN note: its old new-path is gone.
              renamedNotes.set(to, decode(fromBytes));
              renames++;
            }
          }
        } else if (roll < 0.87) {
          // POST-START CREATE-COLLISION (0b-3 Fix 1): partition ALL peers, then have
          // EVERY peer create the SAME fresh `collide-post-<k>.md` with peer-distinct
          // content — a genuine after-start concurrent create. Each peer settles its
          // offline ingest in isolation (no peer sees another's index), so each mints its
          // OWN docId. On the final heal the index LWW binds one winner per path and the
          // orphan sweep recovers the loser(s); the byte-identical-vaults + identical-
          // inbox assertions then catch a lost loser. Driven entirely from the ingest/
          // vault path (NOT a bootstrap seed) and fully deterministic (no wall-clock).
          const k = collisions;
          const cp = path(`collide-post-${String(k)}.md`);
          const bodies: string[] = [];
          for (const p of peers) {
            if (p.online) {
              p.transport.goOffline();
              p.online = false;
              partitions++;
            }
          }
          for (const p of peers) {
            const body = `post-collision ${cp} from ${p.id}`;
            await p.vault.writeAtomic(cp, utf8(body));
            bodies.push(body);
            await p.engine.whenIdle();
          }
          postCollideContents.set(cp, bodies);
          collisions++;
        } else if (roll < 0.93) {
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

      // Every POST-start collision's DISTINCT contents ALL survive on EVERY peer (winner
      // at collide-post-<k>.md, loser(s) at recovered conflict paths). This is the direct
      // 0b-3 Fix 1 assertion: an after-start concurrent-create loser is never silently
      // dropped. (The byte-identical-vaults compare above already proves they survive
      // IDENTICALLY across peers; this names the specific contents so a regression can't
      // pass vacuously.)
      for (const p of peers) {
        const bodies = new Set<string>();
        for (const { path: fp } of await p.vault.list()) {
          if (fp.startsWith(".obsidian/zync/")) continue;
          const bytes = await p.vault.read(fp);
          if (bytes !== null) bodies.add(decode(bytes));
        }
        for (const contents of postCollideContents.values()) {
          for (const body of contents) expect(bodies.has(body)).toBe(true);
        }
      }

      // Every RENAME materialized at its NEW path with the ORIGINAL content on EVERY peer
      // (0b-3 Fix 2). A renamed note (only ever renamed within `liveCreated`, never deleted
      // afterwards) must be present at its final new path with the unchanged content on
      // ALL peers — the direct watcher-echo assertion: a spurious delete(old)/modify(new)
      // that stranded the old file, re-minted a docId, or failed to materialize the renamed
      // content would fail this. (The old names are absent everywhere via the delete-
      // propagation check above; the byte-identical-vaults compare proves identical
      // materialization, this names the specific path+content so a regression can't pass
      // vacuously.)
      for (const [newPath, content] of renamedNotes) {
        for (const p of peers) {
          const bytes = await p.vault.read(path(newPath));
          expect(bytes === null ? null : decode(bytes)).toBe(content);
        }
      }

      // The synced inbox CONVERGES IDENTICALLY across peers (the empty-inbox invariant
      // no longer holds: pre-start collisions produce one recovery entry per loser).
      // Line-disjoint prose edits, single-author deletes, and single-author renames add NO
      // artifacts, so the only entries are the deterministic collision recoveries —
      // identical everywhere. A rename that mis-tombstoned/divergently-resolved would add a
      // spurious resurrection/conflict entry and break this identical-inbox compare.
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
      // At least one RENAME was injected AND survived to assert (0b-3 Fix 2 — no vacuous
      // pass: the renamed-notes survival + byte-identical assertions above must have had a
      // renamed file at a new path to test against the watcher-echo).
      expect(renames).toBeGreaterThan(0);
      expect(renamedNotes.size).toBeGreaterThan(0);
      expect(partitions).toBeGreaterThan(0);
      expect(heals).toBeGreaterThan(0);
      // At least one POST-start create-collision was injected (0b-3 Fix 1 — no vacuous
      // pass: the survival + byte-identical assertions above must have had a loser to test).
      expect(collisions).toBeGreaterThan(0);
      // The shared notes carry real merged content from all peers.
      expect(Object.keys(ref).length).toBeGreaterThanOrEqual(NUM_SHARED);
    });
  }
});
