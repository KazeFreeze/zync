import { describe, it, expect } from "vitest";
import { isDocStampPending } from "./doc-pending.js";
import { makeStamp } from "./stamp.js";
import type { DeviceId, Sha256 } from "../ports.js";

const sha = (h: string) => h as Sha256;
const stamp = (h: string, dev = "devA") => makeStamp(sha(h), dev as DeviceId);

describe("isDocStampPending", () => {
  it("not pending when synced-stamp and disk-hash match the entry stamp (hash-only equality)", () => {
    // same hash, DIFFERENT device suffix must still count equal (the keystone rule)
    expect(
      isDocStampPending(stamp("aaa", "devA"), stamp("aaa", "devB"), stamp("aaa", "devC")),
    ).toBe(false);
  });
  it("pending when the synced stamp differs (not yet acked by the relay)", () => {
    expect(isDocStampPending(stamp("aaa"), stamp("bbb"), stamp("aaa"))).toBe(true);
  });
  it("pending when the disk hash differs (not yet materialized to disk)", () => {
    expect(isDocStampPending(stamp("aaa"), stamp("aaa"), stamp("bbb"))).toBe(true);
  });
  it("pending when there is no synced stamp yet (null)", () => {
    expect(isDocStampPending(stamp("aaa"), null, stamp("aaa"))).toBe(true);
  });
  it("pending when the file is absent on disk (null disk hash)", () => {
    expect(isDocStampPending(stamp("aaa"), stamp("aaa"), null)).toBe(true);
  });
});
