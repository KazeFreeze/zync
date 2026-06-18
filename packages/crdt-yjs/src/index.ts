// @zync/crdt-yjs — Yjs adapters for @zync/core ports. Populated in 0b-2 Tasks 1–3.
export { YjsCrdtProvider, YjsCrdtDoc, TEXT_NAME } from "./crdt.js";
export { YjsCrdtMap } from "./crdt-map.js";
export { HocuspocusTransport } from "./transport-hocuspocus.js";
export type { HocuspocusTransportConfig } from "./transport-hocuspocus.js";
// NOTE: `buildEditorBinding` (browser/CodeMirror-only) is NOT re-exported here — it lives behind the
// `@zync/crdt-yjs/binding` subpath so Node consumers (the headless daemon) don't drag DOM/CM types into
// their typecheck. The Obsidian plugin imports it from `@zync/crdt-yjs/binding`.
