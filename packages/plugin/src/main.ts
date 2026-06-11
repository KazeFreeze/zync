import { Plugin, MarkdownView, TFile, Notice } from "obsidian";
import { Compartment } from "@codemirror/state";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import { buildBinding } from "./binding";

// set to your server's address
const RELAY_URL = "ws://127.0.0.1:1234";
const TOKEN = "dev-static-token";

interface FileSession {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  idb: IndexeddbPersistence;
}

export default class ZyncSpike extends Plugin {
  private sessions = new Map<string, FileSession>();
  private bindingCompartment = new Compartment();

  async onload() {
    this.app.workspace.onLayoutReady(() => {
      this.registerEditorExtension(this.bindingCompartment.of([]));
      this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncActiveLeaf()));
      this.syncActiveLeaf();
    });
  }

  private ensureSession(path: string): FileSession {
    let s = this.sessions.get(path);
    if (s) return s;
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: RELAY_URL,
      name: path,
      document: doc,
      token: TOKEN,
    });
    const idb = new IndexeddbPersistence(`zync:${path}`, doc);
    s = { doc, provider, idb };
    this.sessions.set(path, s);
    console.log(`[zync] session for ${path}`);
    return s;
  }

  private syncActiveLeaf(retries = 5) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file: TFile | null = view?.file ?? null;
    if (!view || !file) return;

    const cm = (view.editor as any).cm; // EditorView
    if (!cm) {
      if (retries > 0) window.setTimeout(() => this.syncActiveLeaf(retries - 1), 50);
      return;
    }

    const session = this.ensureSession(file.path);
    const ytext = session.doc.getText("content");
    const { extension } = buildBinding(ytext, session.provider.awareness!);
    cm.dispatch({ effects: this.bindingCompartment.reconfigure(extension) });
    new Notice(`Zync bound: ${file.path}`, 1500);
  }

  onunload() {
    for (const s of this.sessions.values()) {
      s.provider.destroy();
      s.idb.destroy();
      s.doc.destroy();
    }
    this.sessions.clear();
  }
}
