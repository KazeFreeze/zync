import { describe, it, expect } from "vitest";
import { FileAuthority } from "./fsm.js";

describe("FileAuthority", () => {
  it("starts file-bridged and ingests external writes", () => {
    const fa = new FileAuthority("a.md");
    expect(fa.state).toBe("inactive");
    expect(fa.onExternalWrite()).toBe("ingest");
  });
  it("binds an editor → becomes the authority; ordinary saves are not re-ingested", () => {
    const fa = new FileAuthority("a.md");
    fa.bindEditor("pane-1");
    expect(fa.state).toBe("active-bound");
    expect(fa.onOwnEditorSave()).toBe("ignore");
  });
  it("models multiple panes as a binding SET", () => {
    const fa = new FileAuthority("a.md");
    fa.bindEditor("pane-1");
    fa.bindEditor("pane-2");
    fa.unbindEditor("pane-1");
    expect(fa.state).toBe("active-bound");
    fa.unbindEditor("pane-2");
    expect(fa.state).toBe("inactive");
  });
  it("external write while bound → detach/merge/rebind", () => {
    const fa = new FileAuthority("a.md");
    fa.bindEditor("pane-1");
    expect(fa.onExternalWrite()).toBe("detach-merge-rebind");
    expect(fa.state).toBe("active-bound");
  });
});
