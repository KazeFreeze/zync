import { describe, expect, it } from "vitest";
import { sha256OfBytes } from "../hash.js";
import { canonicalJsonBytes } from "./canonical.js";
import { mergeDeviceLocalPluginData } from "./device-local-plugin-data.js";
import { classifyPluginDataChange, NOISY_DATA_KEYS, tryParseJson } from "./plugin-data-classify.js";

const enc = (value: string): Uint8Array => new TextEncoder().encode(value);
const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));

describe("mergeDeviceLocalPluginData", () => {
  it("preserves local device-owned keys while materializing every other incoming setting", async () => {
    const incoming = enc(
      JSON.stringify({
        fieldMapping: { title: "peer-title" },
        enableGoogleCalendar: true,
        enabledGoogleCalendars: ["peer-calendar"],
      }),
    );
    const local = enc(
      JSON.stringify({
        fieldMapping: { title: "local-title" },
        enableGoogleCalendar: false,
        enabledGoogleCalendars: [],
      }),
    );

    const merged = mergeDeviceLocalPluginData("tasknotes", incoming, local);

    expect(merged).not.toBeNull();
    if (merged === null) throw new Error("expected device-local merge");
    expect(json(merged)).toEqual({
      enableGoogleCalendar: false,
      enabledGoogleCalendars: [],
      fieldMapping: { title: "peer-title" },
    });

    // The deliberate disk != map result is durable normalization, not a conflict or pending edit.
    const mapSha = await sha256OfBytes(canonicalJsonBytes(incoming));
    const mergedSha = await sha256OfBytes(merged);
    const conflicts: string[] = [];
    expect(
      classifyPluginDataChange({
        s: mergedSha,
        m: mapSha,
        r: mergedSha,
        materialized: tryParseJson(incoming),
        local: tryParseJson(merged),
        noisyKeys: NOISY_DATA_KEYS,
      }),
    ).toBe("suppress");
    expect(conflicts).toEqual([]);
  });

  it("adopts an incoming device-owned key when it is absent locally", () => {
    const incoming = enc(
      JSON.stringify({ fieldMapping: { title: "peer" }, enableGoogleCalendar: true }),
    );
    const local = enc(JSON.stringify({ fieldMapping: { title: "local" } }));

    const merged = mergeDeviceLocalPluginData("tasknotes", incoming, local);

    expect(merged).not.toBeNull();
    if (merged === null) throw new Error("expected device-local merge");
    expect(json(merged)).toEqual({
      enableGoogleCalendar: true,
      fieldMapping: { title: "peer" },
    });
  });
});
