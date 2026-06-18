// Standalone Microsoft Teams third-party app API probe (teamdeck Phase 0A).
//
// Purpose: empirically settle the unverified protocol before designing the plugin's
// WebSocket client. The reference repos disagree on the pairing mechanism, the unpaired
// token-param form, and some wire strings, so we determine the truth against the live API
// and write REDACTED fixtures for later deterministic tests.
//
// Zero dependencies: uses Node's built-in global WebSocket (Node >= 22).
// Run from the repo root. Most modes require a solo Teams "Meet now" meeting.
//
//   node tools/probe/probe.mjs observe [--seconds=60] [--unpaired]
//   node tools/probe/probe.mjs pair
//   node tools/probe/probe.mjs send <action> [--type=<reaction>]
//   node tools/probe/probe.mjs reactions
//   node tools/probe/probe.mjs dead-token
//   node tools/probe/probe.mjs second-client
//
// The pairing token is saved to agent/progress/probe-token.json (gitignored) and reused.
// Console output and written fixtures redact all token values.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const identity = JSON.parse(readFileSync(join(repoRoot, "shared", "identity.json"), "utf8"));
const progressDir = join(repoRoot, "agent", "progress");
const tokenFile = join(progressDir, "probe-token.json");

const HOST = process.env.TEAMS_API_HOST || "ws://127.0.0.1:8124";
const PROTOCOL_VERSION = "2.0.0";

// ---- args ----
const [mode = "observe", ...rest] = process.argv.slice(2);
const positional = rest.filter((a) => !a.startsWith("--"));
const flags = Object.fromEntries(
  rest
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? true];
    }),
);

// ---- token persistence ----
function loadToken() {
  try {
    return JSON.parse(readFileSync(tokenFile, "utf8")).token || null;
  } catch {
    return null;
  }
}
function saveToken(token) {
  if (!existsSync(progressDir)) mkdirSync(progressDir, { recursive: true });
  writeFileSync(tokenFile, JSON.stringify({ token, savedAt: new Date().toISOString() }, null, 2));
}

// ---- redaction ----
const SECRET_KEYS = new Set(["token", "tokenrefresh"]);
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) && typeof v === "string" ? `<redacted:${v.length}>` : redact(v);
    }
    return out;
  }
  return value;
}

// ---- connection ----
function buildUrl(token) {
  const params = new URLSearchParams({
    "protocol-version": PROTOCOL_VERSION,
    manufacturer: identity.manufacturer,
    device: identity.device,
    app: identity.app,
    "app-version": identity.appVersion,
  });
  if (token) params.set("token", token);
  return `${HOST}?${params.toString()}`;
}

const session = { mode, startedAt: new Date().toISOString(), identity: { ...identity }, messages: [], events: [] };
const seen = { stateFields: {}, permissionFields: {}, reactions: {} };
let requestId = 0;

function record(direction, payload, extra = {}) {
  const entry = { t: new Date().toISOString(), direction, payload: redact(payload), ...extra };
  session.messages.push(entry);
  return entry;
}
function note(event, detail = {}) {
  const entry = { t: new Date().toISOString(), event, ...detail };
  session.events.push(entry);
  console.log(`[probe] ${event}${Object.keys(detail).length ? " " + JSON.stringify(redact(detail)) : ""}`);
}

function ingest(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    record("in", { unparseable: String(raw).slice(0, 200) });
    note("inbound-unparseable", { sample: String(raw).slice(0, 120) });
    return null;
  }
  record("in", msg);
  const update = msg.meetingUpdate;
  if (update?.meetingState) {
    const changed = [];
    for (const [k, v] of Object.entries(update.meetingState)) {
      if (seen.stateFields[k] !== v) changed.push(`${k}=${v}`);
      seen.stateFields[k] = v;
    }
    if (changed.length) note("state-change", { changed });
  }
  if (update?.meetingPermissions) for (const [k, v] of Object.entries(update.meetingPermissions)) seen.permissionFields[k] = v;
  if (msg.tokenRefresh) note("token-refresh-received", { length: String(msg.tokenRefresh).length });
  if (msg.errorMsg) note("error-msg", { errorMsg: msg.errorMsg, requestId: msg.requestId });
  if (msg.response) note("response", { response: msg.response, requestId: msg.requestId });
  return msg;
}

function open(token) {
  const url = buildUrl(token);
  note("connecting", { urlWithoutToken: buildUrl(null), tokenPresent: Boolean(token) });
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => note("open"));
  ws.addEventListener("message", (e) => ingest(typeof e.data === "string" ? e.data : String(e.data)));
  ws.addEventListener("close", (e) => note("close", { code: e.code, reason: String(e.reason || "") }));
  ws.addEventListener("error", () => note("error", { hint: "ws error event (Node exposes little detail)" }));
  return ws;
}

function sendCommand(ws, action, parameters = {}) {
  const payload = { action, parameters, requestId: ++requestId };
  record("out", payload);
  note("send", { action, requestId: payload.requestId });
  ws.send(JSON.stringify(payload));
  return payload.requestId;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("close", (e) => reject(new Error(`closed before open: code ${e.code}`)), { once: true });
  });
}

function writeFixture() {
  if (!existsSync(progressDir)) mkdirSync(progressDir, { recursive: true });
  session.seen = seen;
  session.endedAt = new Date().toISOString();
  const stamp = session.startedAt.replace(/[:.]/g, "-");
  const file = join(progressDir, `probe-${mode}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(session, null, 2));
  note("fixture-written", { file: file.replace(repoRoot, ".") });
  console.log("[probe] state fields seen:", Object.keys(seen.stateFields).join(", ") || "(none)");
  console.log("[probe] permission fields seen:", Object.keys(seen.permissionFields).join(", ") || "(none)");
}

function finishOn(ws, ms) {
  return new Promise((resolve) => {
    const done = () => {
      try {
        ws.close();
      } catch {}
      writeFixture();
      resolve();
    };
    setTimeout(done, ms);
    process.once("SIGINT", () => {
      note("sigint");
      done();
    });
  });
}

// ---- modes ----
async function runObserve() {
  const seconds = Number(flags.seconds || 60);
  const token = flags.unpaired ? null : loadToken();
  const ws = open(token);
  await waitOpen(ws).catch((e) => note("open-failed", { error: e.message }));
  console.log(`[probe] observing for ${seconds}s. In Teams, toggle mute/camera/hand/blur to capture echoes.`);
  await finishOn(ws, seconds * 1000);
}

async function runPair() {
  const ws = open(null);
  await waitOpen(ws).catch((e) => note("open-failed", { error: e.message }));
  let attempted = false;
  const attempt = () => {
    if (attempted) return;
    attempted = true;
    note("pair-attempt");
    console.log("[probe] >>> Watch Teams now for an Allow / approve prompt <<<");
    sendCommand(ws, "pair", {});
  };
  ws.addEventListener("message", (e) => {
    const msg = (() => {
      try {
        return JSON.parse(typeof e.data === "string" ? e.data : String(e.data));
      } catch {
        return null;
      }
    })();
    if (msg?.meetingUpdate?.meetingPermissions?.canPair === true) attempt();
    if (msg?.tokenRefresh) {
      saveToken(msg.tokenRefresh);
      note("paired", { hint: "token saved to agent/progress/probe-token.json (gitignored)" });
      setTimeout(() => {
        try {
          ws.close();
        } catch {}
        writeFixture();
        process.exit(0);
      }, 500);
    }
  });
  console.log("[probe] connected; waiting for canPair===true (join a solo Meet now if not already).");
  await finishOn(ws, Number(flags.seconds || 60) * 1000);
}

async function runSend() {
  const action = positional[0];
  if (!action) return console.error("usage: send <action> [--type=...]");
  const token = loadToken();
  if (!token) return console.error("no saved token; run `pair` first.");
  const ws = open(token);
  await waitOpen(ws).catch((e) => note("open-failed", { error: e.message }));
  await sleep(1500); // let first meetingUpdate arrive
  sendCommand(ws, action, flags.type ? { type: String(flags.type) } : {});
  await finishOn(ws, 6000);
}

async function runReactions() {
  const token = loadToken();
  if (!token) return console.error("no saved token; run `pair` first.");
  const ws = open(token);
  await waitOpen(ws).catch((e) => note("open-failed", { error: e.message }));
  await sleep(1500);
  for (const type of ["like", "love", "applause", "laugh", "wow"]) {
    const id = sendCommand(ws, "send-reaction", { type });
    seen.reactions[type] = { requestId: id, sentAt: new Date().toISOString() };
    await sleep(2000);
  }
  await finishOn(ws, 2000);
}

async function runDeadToken() {
  const ws = open("00000000-dead-dead-dead-000000000000");
  await waitOpen(ws).catch((e) => note("open-failed-as-expected", { error: e.message }));
  await finishOn(ws, 8000);
}

async function runSecondClient() {
  const token = loadToken();
  const a = open(token);
  await waitOpen(a).catch((e) => note("a-open-failed", { error: e.message }));
  note("opening-second-client", { info: "expect Teams to drop one connection (one client at a time)" });
  const b = open(token);
  b.addEventListener("close", (e) => note("second-client-close", { which: "B", code: e.code, reason: String(e.reason || "") }));
  a.addEventListener("close", (e) => note("first-client-close", { which: "A", code: e.code, reason: String(e.reason || "") }));
  await sleep(6000);
  try {
    a.close();
  } catch {}
  try {
    b.close();
  } catch {}
  writeFixture();
}

const modes = {
  observe: runObserve,
  pair: runPair,
  send: runSend,
  reactions: runReactions,
  "dead-token": runDeadToken,
  "second-client": runSecondClient,
};

const run = modes[mode];
if (!run) {
  console.error(`unknown mode "${mode}". modes: ${Object.keys(modes).join(", ")}`);
  process.exit(1);
}
run().catch((e) => {
  console.error("[probe] fatal:", e);
  writeFixture();
  process.exit(1);
});
