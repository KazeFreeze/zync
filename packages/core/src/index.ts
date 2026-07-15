export * from "./ports.js";
export {
  ClosedError,
  CorruptBlobError,
  BlobTransientError,
  BlobNotFoundError,
  BlobPermanentError,
} from "./errors.js";
export { classify } from "./classify/classify.js";
export type { Route, Caps, Classification } from "./classify/classify.js";
export {
  CONFIG_ZONE_PREFIXES,
  COMMUNITY_PLUGINS_PATH,
  isConfigZone,
  configCategoryOf,
} from "./config/config-entry.js";
export type { ConfigEntry, ConfigCategory } from "./config/config-entry.js";
export type { CommunityPluginsPort } from "./config/plugin-enabled-channel.js";
export { sha256OfBytes, sha256OfText } from "./hash.js";
export { reconnectHealJitterMs } from "./reconnect-jitter.js";
export { diffToEdits, merge3, applyEdits } from "./bridge/merge.js";
export { EchoLedger } from "./bridge/echo.js";
export { FileAuthority } from "./bridge/fsm.js";
export { BaseStore } from "./bridge/base.js";
export type { BaseRecord } from "./bridge/base.js";
export { IngestPipeline } from "./bridge/ingest.js";
export type { IngestDeps, IngestResult } from "./bridge/ingest.js";
export { OutboundPipeline } from "./bridge/outbound.js";
export type { OutboundDeps } from "./bridge/outbound.js";
export { recordTombstone, resolveTombstone, applyResurrection } from "./bridge/tombstone.js";
export type { ResurrectedNotice } from "./bridge/tombstone.js";
export {
  applyRename,
  resolveRenameConflict,
  applyRenameConflictResolution,
} from "./bridge/rename.js";
export { bootstrapDecision, applyBootstrap } from "./protocol/bootstrap.js";
export type {
  BootstrapInputs,
  BootstrapDecision,
  ApplyBootstrapArgs,
  ApplyBootstrapResult,
} from "./protocol/bootstrap.js";
export {
  findOrphans,
  orphanRecoveryPath,
  recoverOrphan,
  orphanSweep,
} from "./protocol/orphan-sweep.js";
export type { OrphanMeta } from "./protocol/orphan-sweep.js";
export { makeStamp, stampHash, stampsEqual } from "./protocol/stamp.js";
export { IndexDoc } from "./protocol/index-doc.js";
export type { TreeEntry } from "./protocol/index-doc.js";
export { LazyAttachManager } from "./protocol/lazy-attach.js";
export type { LazyAttachDeps } from "./protocol/lazy-attach.js";
export { runStructuralReconcile } from "./protocol/structural-reconcile.js";
export type { StructuralReconcileDeps } from "./protocol/structural-reconcile.js";
export { conflictArtifactPath, writeConflictArtifact } from "./conflicts/artifact.js";
export { Inbox } from "./conflicts/inbox.js";
export type { InboxEntry, InboxKind } from "./conflicts/inbox.js";
export { supervisedImport } from "./conflicts/supervised-import.js";
export { ArtifactNotLocalError } from "./conflicts/resolve.js";
export type { ResolveAction, ResolveConfigAction } from "./conflicts/resolve.js";
export { describeInboxEntry, isActionableConflict } from "./conflicts/entry-view.js";
export type { EntryView, EntryAction, EntryActionSpec } from "./conflicts/entry-view.js";
export {
  SyncEngine,
  AUDIT_QUIESCENCE_MS,
  AUDIT_MAX_STALENESS_MS,
  SELFHEAL_BACKOFF_MS,
  SELFHEAL_MAX_NO_PROGRESS,
  SELFHEAL_MAX_PASSES,
} from "./engine.js";
export type { EnginePorts, EngineConfig } from "./engine.js";
export { BlobEngine } from "./blobs/blob-engine.js";
export type { BlobManifestEntry, BlobFetchPolicy, BlobEngineDeps } from "./blobs/blob-engine.js";
export * from "./blobs/blob-fetch-queue.js";
