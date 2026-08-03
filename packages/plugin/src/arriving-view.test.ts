import { describe, it, expect } from "vitest";
import {
  ARRIVING_NOTICE_THRESHOLD,
  arrivingNotice,
  arrivingSegment,
  type ArrivingInputs,
} from "./arriving-view.js";

const base: ArrivingInputs = {
  started: true,
  connected: true,
  hydrated: true,
  arriving: 0,
  blobsOutstanding: 0,
  showing: false,
};
const w = (o: Partial<ArrivingInputs>): ArrivingInputs => ({ ...base, ...o });

describe("arrivingSegment", () => {
  it("is absent before the engine starts", () => {
    expect(arrivingSegment(w({ started: false, arriving: 99 }))).toBeNull();
  });
  it("is absent at zero (exceptions-only: never assert 'nothing is arriving')", () => {
    expect(arrivingSegment(base)).toBeNull();
  });
  it("shows the count when files are arriving", () => {
    expect(arrivingSegment(w({ arriving: 214 }))).toEqual({
      icon: "download-cloud",
      text: "214 arriving",
      tooltip:
        "214 files are downloading from your other devices. They will appear as they arrive.",
    });
  });
  it("shows an INDETERMINATE segment when connected but the index has not hydrated", () => {
    expect(arrivingSegment(w({ hydrated: false }))).toEqual({
      icon: "refresh-cw",
      text: "receiving index",
      tooltip:
        "Connected. Zync is getting the list of files on your other devices. The count appears once it arrives.",
    });
  });
  it("does not claim to be receiving the index while offline", () => {
    expect(arrivingSegment(w({ hydrated: false, connected: false }))).toBeNull();
  });
  it("adds thousands separators to a 5-digit count", () => {
    const seg = arrivingSegment(w({ arriving: 12481 }));
    expect(seg?.text).toBe("12,481 arriving");
    expect(seg?.tooltip).toContain("12,481 files");
  });
});

describe("arrivingNotice", () => {
  it("is hidden before the engine starts", () => {
    expect(arrivingNotice(w({ started: false, arriving: 999 })).kind).toBe("hidden");
  });
  it("is hidden below the threshold on both planes", () => {
    expect(arrivingNotice(w({ arriving: 5, blobsOutstanding: 5 })).kind).toBe("hidden");
  });
  it("shows once prose crosses the threshold", () => {
    const n = arrivingNotice(w({ arriving: ARRIVING_NOTICE_THRESHOLD }));
    expect(n).toEqual({ kind: "shown", title: "Receiving 20 files", detail: null });
  });
  it("shows on BLOBS alone, so an attachment-heavy first sync is not silent", () => {
    const n = arrivingNotice(w({ blobsOutstanding: 340 }));
    expect(n).toEqual({ kind: "shown", title: "Receiving 340 attachments", detail: null });
  });
  it("mentions both planes when both are outstanding", () => {
    expect(arrivingNotice(w({ arriving: 30, blobsOutstanding: 340 }))).toEqual({
      kind: "shown",
      title: "Receiving 30 files",
      detail: "Plus 340 attachments downloading.",
    });
  });
  it("STAYS shown below the threshold once showing (retires at zero, not at 19)", () => {
    expect(arrivingNotice(w({ arriving: 19, showing: true })).kind).toBe("shown");
  });
  it("retires only when BOTH planes reach zero", () => {
    expect(arrivingNotice(w({ arriving: 0, blobsOutstanding: 4, showing: true })).kind).toBe(
      "shown",
    );
    expect(arrivingNotice(w({ arriving: 0, blobsOutstanding: 0, showing: true })).kind).toBe(
      "hidden",
    );
  });
  it("shows an indeterminate notice while the index has not hydrated", () => {
    const n = arrivingNotice(w({ hydrated: false, arriving: 0 }));
    expect(n.kind).toBe("shown");
    expect(n.kind === "shown" && n.title).toBe("Receiving your library");
  });
  it("never retires an existing notice while the index has not hydrated", () => {
    // A transient empty read mid-first-sync must not tear the notice down. This shares the
    // hydration branch with the test above ON PURPOSE: it is a regression guard against a future
    // refactor that folds the `showing` check in ahead of the hydration gate.
    expect(arrivingNotice(w({ hydrated: false, showing: true, arriving: 0 })).kind).toBe("shown");
  });
  it("is hidden when offline and unhydrated, rather than claiming to receive anything", () => {
    // The mirror of arrivingSegment's offline test. Unhydrated is only meaningful while connected;
    // offline it says nothing, and with both planes at zero the notice stays down.
    expect(arrivingNotice(w({ connected: false, hydrated: false })).kind).toBe("hidden");
  });
  it("adds thousands separators to a 5-digit count in the toast title", () => {
    const n = arrivingNotice(w({ arriving: 12481 }));
    expect(n).toEqual({ kind: "shown", title: "Receiving 12,481 files", detail: null });
  });

  describe("offline", () => {
    // The counts are still true (this work IS outstanding) while offline, but "Receiving" asserts
    // an active transfer that is not happening — the toast must say what is true instead. These
    // mirror the online-shown cases directly above/below so a reviewer can diff the two side by side.
    it("says 'Waiting' with the prose count when only files are outstanding", () => {
      const n = arrivingNotice(w({ connected: false, arriving: ARRIVING_NOTICE_THRESHOLD }));
      expect(n).toEqual({
        kind: "shown",
        title: "Waiting",
        detail: "20 files still to download. This continues when you are back online.",
      });
    });
    it("sums BOTH planes into one total when both are outstanding", () => {
      const n = arrivingNotice(w({ connected: false, arriving: 30, blobsOutstanding: 340 }));
      expect(n).toEqual({
        kind: "shown",
        title: "Waiting",
        detail: "370 files still to download. This continues when you are back online.",
      });
    });
    it("says '1 file', not '1 files', on the last frame", () => {
      const n = arrivingNotice(w({ connected: false, arriving: 1, showing: true }));
      expect(n).toEqual({
        kind: "shown",
        title: "Waiting",
        detail: "1 file still to download. This continues when you are back online.",
      });
    });
    it("adds thousands separators to a 5-digit outstanding total", () => {
      const n = arrivingNotice(w({ connected: false, arriving: 12481 }));
      expect(n).toEqual({
        kind: "shown",
        title: "Waiting",
        detail: "12,481 files still to download. This continues when you are back online.",
      });
    });
    it("stays hidden offline below the threshold, same hysteresis as online", () => {
      expect(arrivingNotice(w({ connected: false, arriving: 5, blobsOutstanding: 5 })).kind).toBe(
        "hidden",
      );
    });
    it("does NOT change any ONLINE case (connected defaults true in the base fixture)", () => {
      // Same inputs as the "shows once prose crosses the threshold" test above, connected implicit.
      const n = arrivingNotice(w({ arriving: ARRIVING_NOTICE_THRESHOLD }));
      expect(n).toEqual({ kind: "shown", title: "Receiving 20 files", detail: null });
    });
  });

  describe("singular wording", () => {
    // The hysteresis holds the notice open until BOTH planes reach zero (see the "retires only
    // when BOTH planes reach zero" test above), so 1 is not a corner case — it is the LAST FRAME
    // of every drain. `showing: true` is what makes 1 reachable below the 20-item threshold.
    it("says '1 file', not '1 files', on the last frame of a prose drain", () => {
      const n = arrivingNotice(w({ arriving: 1, showing: true }));
      expect(n).toEqual({ kind: "shown", title: "Receiving 1 file", detail: null });
    });
    it("says '1 attachment', not '1 attachments', on the last frame of a blob drain", () => {
      const n = arrivingNotice(w({ blobsOutstanding: 1, showing: true }));
      expect(n).toEqual({ kind: "shown", title: "Receiving 1 attachment", detail: null });
    });
    it("says '1 attachment downloading', not '1 attachments downloading', in the combined detail", () => {
      const n = arrivingNotice(w({ arriving: 1, blobsOutstanding: 1, showing: true }));
      expect(n).toEqual({
        kind: "shown",
        title: "Receiving 1 file",
        detail: "Plus 1 attachment downloading.",
      });
    });
  });
});
