import type { DocId, VaultPath } from "../ports.js";

/** A live index entry whose on-disk file has vanished (candidate rename source / vanished-synced file). */
export interface RenameLost {
  path: VaultPath;
  docId: DocId;
  hash: string; // the LOCAL base.fileHash — never the index stamp (spec 2.4 finding 4)
}
/** An on-disk file with no LIVE index entry (candidate rename target). */
export interface RenameCreated {
  path: VaultPath;
  hash: string;
}
export interface RenameMatch {
  from: VaultPath;
  to: VaultPath;
  docId: DocId;
}
export interface RenameMatchResult {
  matches: RenameMatch[];
  unmatchedLost: RenameLost[];
  unmatchedCreated: RenameCreated[];
}
export interface RenameMatchOpts {
  /** Paths to never treat as a rename target (e.g. atomic-write temp files). */
  isExcludedPath: (p: VaultPath) => boolean;
  /** Content hashes too weak to be identity (e.g. the empty-file hash). */
  isTrivialHash: (h: string) => boolean;
  /** A hash also present on a STILL-LIVE on-disk file => the created file is likely a COPY, not a rename
   *  (spec 2.4 finding 3, the copy-of-template trap). Such hashes never match. */
  isLiveElsewhere: (h: string) => boolean;
}

/**
 * Pair "lost" entries with "created" files by UNIQUE 1:1 content hash. Conservative by design: a hash that
 * is non-unique on either side, trivial, excluded, or live-elsewhere is NEVER matched — it falls through to
 * unmatched (the caller handles it safely). Content hash is corroborating evidence, not proof of identity,
 * so we err toward false negatives. Pure + deterministic (no I/O, no clock).
 */
export function matchRenames(
  lost: RenameLost[],
  created: RenameCreated[],
  opts: RenameMatchOpts,
): RenameMatchResult {
  const lostByHash = new Map<string, RenameLost[]>();
  for (const l of lost) {
    if (opts.isTrivialHash(l.hash)) continue;
    let arr = lostByHash.get(l.hash);
    if (arr === undefined) {
      arr = [];
      lostByHash.set(l.hash, arr);
    }
    arr.push(l);
  }
  const createdByHash = new Map<string, RenameCreated[]>();
  for (const c of created) {
    if (opts.isExcludedPath(c.path) || opts.isTrivialHash(c.hash)) continue;
    let arr = createdByHash.get(c.hash);
    if (arr === undefined) {
      arr = [];
      createdByHash.set(c.hash, arr);
    }
    arr.push(c);
  }

  const matches: RenameMatch[] = [];
  const matchedLost = new Set<RenameLost>();
  const matchedCreated = new Set<RenameCreated>();
  for (const [hash, ls] of lostByHash) {
    if (opts.isLiveElsewhere(hash)) continue;
    const cs = createdByHash.get(hash);
    const l = ls[0];
    const c = cs?.[0];
    if (ls.length === 1 && cs?.length === 1 && l !== undefined && c !== undefined) {
      matches.push({ from: l.path, to: c.path, docId: l.docId });
      matchedLost.add(l);
      matchedCreated.add(c);
    }
  }
  return {
    matches,
    unmatchedLost: lost.filter((l) => !matchedLost.has(l)),
    unmatchedCreated: created.filter((c) => !matchedCreated.has(c)),
  };
}
