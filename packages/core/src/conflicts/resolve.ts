import type { VaultPath } from "../ports.js";

/** The two content-conflict resolutions the engine can perform. */
export type ResolveAction = "keep-current" | "keep-backup";

/**
 * Thrown by `resolveContentConflict` when the conflict's backup artifact is not present on THIS
 * device. Content-conflict artifacts are device-local (written unbound/echo-suppressed on the
 * authoring device); a peer sees the synced inbox entry but not the file, so it can only
 * acknowledge. The plugin catches this to fall back to acknowledge-only.
 */
export class ArtifactNotLocalError extends Error {
  constructor(readonly artifactPath: VaultPath) {
    super(`Conflict backup is not on this device: ${artifactPath}`);
    this.name = "ArtifactNotLocalError";
  }
}
