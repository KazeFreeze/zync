import type { VaultPath } from "../ports.js";

export type Route = "crdt-prose" | "structured-blob" | "binary-blob" | "config" | "excluded";
export interface Caps {
  maxProseBytes: number;
  configDir: string;
}
export interface Classification {
  route: Route;
  notice?: string;
}

const PROSE_EXT = new Set(["md", "markdown", "txt"]);
const STRUCTURED_EXT = new Set(["canvas", "base", "json"]);

function ext(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i + 1).toLowerCase();
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function classify(path: VaultPath, bytes: Uint8Array, caps: Caps): Classification {
  if (
    path.startsWith(".trash/") ||
    path === `${caps.configDir}/workspace.json` ||
    path === `${caps.configDir}/workspace-mobile.json` ||
    path.startsWith(`${caps.configDir}/zync/`)
  ) {
    return { route: "excluded" };
  }

  if (path.startsWith(`${caps.configDir}/`)) return { route: "config" };

  const e = ext(path);
  if (PROSE_EXT.has(e)) {
    if (bytes.length > caps.maxProseBytes) {
      return {
        route: "binary-blob",
        notice: `Note exceeds size cap (${String(bytes.length)} bytes); synced as a blob, not live-merged.`,
      };
    }
    if (!isValidUtf8(bytes)) return { route: "binary-blob" };
    return { route: "crdt-prose" };
  }
  if (STRUCTURED_EXT.has(e)) return { route: "structured-blob" };
  return { route: "binary-blob" };
}
