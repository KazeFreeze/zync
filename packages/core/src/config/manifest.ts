import type { ConfigPort, VaultPath } from "../ports.js";

/** Read a plugin's local manifest.json version via the config port; undefined if absent/unparseable. */
export async function readManifestVersion(
  configPort: ConfigPort,
  id: string,
): Promise<string | undefined> {
  const bytes = await configPort.read(`.obsidian/plugins/${id}/manifest.json` as VaultPath);
  if (bytes === null) return undefined;
  try {
    return (JSON.parse(new TextDecoder().decode(bytes)) as { version?: string }).version;
  } catch {
    return undefined;
  }
}
