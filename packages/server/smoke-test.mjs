/**
 * Headless relay smoke test for Zync Phase-0a.
 *
 * Proves two Yjs clients converge through the Hocuspocus relay in-process.
 * Usage: node packages/server/smoke-test.mjs
 * Exit 0 = SMOKE PASS, Exit 1 = SMOKE FAIL.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config ---
const RELAY_URL = "ws://127.0.0.1:1234";
const TOKEN = "dev-static-token";
const DOC_NAME = "smoke";
const RELAY_READY_TIMEOUT_MS = 8000;
const CONVERGENCE_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;

// --- Spawn relay ---
const tsxBin = path.join(__dirname, "node_modules/.bin/tsx");
const serverEntry = path.join(__dirname, "src/index.ts");

let relayProc = null;

function killRelay() {
  if (relayProc && !relayProc.killed) {
    relayProc.kill("SIGTERM");
  }
}

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  killRelay();
  process.exit(1);
}

console.log("[smoke] Spawning relay…");
relayProc = spawn(tsxBin, [serverEntry], {
  cwd: __dirname,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ZYNC_TOKEN: TOKEN },
});

relayProc.on("error", (err) => fail(`relay spawn error: ${err.message}`));
relayProc.on("exit", (code) => {
  if (code !== null && code !== 0) {
    console.error(`[smoke] relay exited with code ${code}`);
  }
});

// Collect relay output for debugging
const relayLogs = [];
relayProc.stdout.on("data", (d) => relayLogs.push(d.toString()));
relayProc.stderr.on("data", (d) => relayLogs.push(d.toString()));

// --- Wait for relay to be ready ---
async function waitForRelay() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + RELAY_READY_TIMEOUT_MS;
    const checker = setInterval(() => {
      const logs = relayLogs.join("");
      if (logs.includes("relay on")) {
        clearInterval(checker);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(checker);
        reject(
          new Error(
            `Relay did not emit 'relay on' within ${RELAY_READY_TIMEOUT_MS}ms.\nRelay output:\n${logs}`,
          ),
        );
      }
    }, 100);
  });
}

// --- Main smoke logic ---
async function runSmoke() {
  try {
    await waitForRelay();
  } catch (err) {
    fail(err.message);
  }

  console.log("[smoke] Relay ready. Creating two Y.Doc clients…");

  // Dynamic imports from server package's own node_modules
  const Y = await import("yjs");
  const { HocuspocusProvider } = await import("@hocuspocus/provider");
  const wsModule = await import("ws");
  // ws v8 exports default as the class
  const WS = wsModule.default ?? wsModule.WebSocket;

  const docA = new Y.Doc();
  const docB = new Y.Doc();

  const providerA = new HocuspocusProvider({
    url: RELAY_URL,
    name: DOC_NAME,
    document: docA,
    token: TOKEN,
    WebSocketPolyfill: WS,
  });

  const providerB = new HocuspocusProvider({
    url: RELAY_URL,
    name: DOC_NAME,
    document: docB,
    token: TOKEN,
    WebSocketPolyfill: WS,
  });

  // Wait for both providers to connect before inserting
  async function waitConnected(provider, label) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = setInterval(() => {
        if (provider.status === "connected") {
          clearInterval(check);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(check);
          reject(new Error(`${label} did not connect within 5s`));
        }
      }, 50);
    });
  }

  try {
    await Promise.all([
      waitConnected(providerA, "providerA"),
      waitConnected(providerB, "providerB"),
    ]);
  } catch (err) {
    providerA.destroy();
    providerB.destroy();
    fail(`Connection timeout: ${err.message}`);
  }

  console.log("[smoke] Both providers connected. Inserting text into doc A…");

  const ytextA = docA.getText("content");
  const INSERT_TEXT = "hello from smoke test";
  ytextA.insert(0, INSERT_TEXT);

  // Poll for docB to converge
  const ytextB = docB.getText("content");
  const deadline = Date.now() + CONVERGENCE_TIMEOUT_MS;

  await new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      const val = ytextB.toString();
      if (val === INSERT_TEXT) {
        clearInterval(poll);
        resolve(val);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(
          new Error(`doc B did not converge within ${CONVERGENCE_TIMEOUT_MS}ms. Got: "${val}"`),
        );
      }
    }, POLL_INTERVAL_MS);
  })
    .then((val) => {
      console.log(`SMOKE PASS: converged text = "${val}"`);
      providerA.destroy();
      providerB.destroy();
      killRelay();
      process.exit(0);
    })
    .catch((err) => {
      providerA.destroy();
      providerB.destroy();
      fail(err.message);
    });
}

runSmoke().catch((err) => fail(String(err)));
