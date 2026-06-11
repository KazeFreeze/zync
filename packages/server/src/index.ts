// NOTE: In @hocuspocus/server >=2.x, `Server` is a pre-instantiated singleton.
// Use the `Hocuspocus` class directly for constructor-style instantiation.
import { Hocuspocus } from "@hocuspocus/server";
import { Logger } from "@hocuspocus/extension-logger";

const TOKEN = process.env.ZYNC_TOKEN ?? "dev-static-token";
const PORT = Number(process.env.ZYNC_PORT ?? 1234);

const server = new Hocuspocus({
  port: PORT,
  extensions: [new Logger()],
  // Phase-0a auth = a single static token over localhost/private network.
  // Real per-device tokens + TLS are Phase 1 (spec §14).
  async onAuthenticate({ token, documentName }) {
    if (token !== TOKEN) throw new Error("unauthorized");
    console.log(`[zync] authed for doc: ${documentName}`);
    return { user: "dev" };
  },
});

server.listen();
console.log(`[zync] relay on ws://127.0.0.1:${PORT} (token: ${TOKEN})`);
