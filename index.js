import express from "express";
import axios from "axios";
import WebSocket from "ws";

const ELEVEN_WSS = "wss://api.elevenlabs.io/v1/convai/conversation";
const {
  PORT = 8080,
  ELEVEN_KEY,
  DEFAULT_AGENT_ID,
  STREAM_WEBHOOK_URL,
  IDLE_MINUTES = 7
} = process.env;

if (!ELEVEN_KEY || !STREAM_WEBHOOK_URL) {
  console.error("Missing ELEVEN_KEY or STREAM_WEBHOOK_URL in env");
  process.exit(1);
}

const IDLE_MS = Number(IDLE_MINUTES) * 60_000;
const sockets = new Map(); // psid -> { ws, lastSeen, timer, initialized }

const app = express();
app.use(express.json({ limit: "1mb" }));

function bumpIdleTimer(psid, entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    try { entry.ws.close(1000, "idle-timeout"); } catch {}
    sockets.delete(psid);
  }, IDLE_MS);
}

function forwardToMake(payload) {
  return axios.post(STREAM_WEBHOOK_URL, payload).catch((err) => {
    console.error("forwardToMake error:", err?.message || err);
  });
}

function handleServerEvents(psid) {
  return async (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    const entry = sockets.get(psid);
    if (!entry) return;
    entry.lastSeen = Date.now();
    bumpIdleTimer(psid, entry);

    // Ping/pong keepalive
    if (data.type === "ping" || data.ping_event) {
      try {
        entry.ws.send(JSON.stringify({ type: "pong", event_id: data.ping_event?.event_id }));
      } catch (e) {
        console.error("pong send error:", e?.message || e);
      }
      return;
    }

    // Partial (tentative) text
    if (data.type === "internal_tentative_agent_response") {
      const text = data.tentative_agent_response_internal_event?.tentative_agent_response;
      if (text) await forwardToMake({ psid, type: "partial", text, final: false });
      return;
    }

    // Final text
    if (data.type === "agent_response") {
      const text = data.agent_response_event?.agent_response;
      if (text) await forwardToMake({ psid, type: "final", text, final: true });
      return;
    }

    // (Optional) audio chunks: if (data.type === "audio") { ... }
  };
}

// ---- NEW: wait for ws to be OPEN before sending ----
function waitForOpen(ws, timeoutMs = 10000) {
  if (ws.readyState === 1) return Promise.resolve(); // OPEN
  return new Promise((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("WS closed before open")); };
    const onError = (err) => { cleanup(); reject(err instanceof Error ? err : new Error(String(err))); };
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeListener("open", onOpen);
      ws.removeListener("close", onClose);
      ws.removeListener("error", onError);
    };
    ws.on("open", onOpen);
    ws.on("close", onClose);
    ws.on("error", onError);
    const timer = setTimeout(() => { cleanup(); reject(new Error("WS open timeout")); }, timeoutMs);
  });
}
// ----------------------------------------------------

async function ensureSocket(psid, agentId, pendingInitContext) {
  let entry = sockets.get(psid);
  const open = entry?.ws?.readyState === 1; // OPEN

  if (!entry || !open) {
    const url = `${ELEVEN_WSS}?agent_id=${encodeURIComponent(agentId)}`;
    const ws = new WebSocket(url, {
      headers: { "xi-api-key": ELEVEN_KEY }
    });

    entry = { ws, lastSeen: Date.now(), timer: null, initialized: false };
    sockets.set(psid, entry);

    ws.on("open", () => {
      // Send init context once (optional), immediately after connect
      if (pendingInitContext && !entry.initialized) {
        try { ws.send(JSON.stringify(pendingInitContext)); entry.initialized = true; } catch (e) {
          console.error("initContext send error:", e?.message || e);
        }
      }
    });
    ws.on("message", handleServerEvents(psid));
    ws.on("close", () => sockets.delete(psid));
    ws.on("error", (e) => {
      console.error("ElevenLabs WS error:", e?.message || e);
      sockets.delete(psid);
    });
  } else {
    // If socket exists and we received an init context but never sent it
    if (pendingInitContext && !entry.initialized) {
      try { entry.ws.send(JSON.stringify(pendingInitContext)); entry.initialized = true; } catch (e) {
        console.error("late initContext send error:", e?.message || e);
      }
    }
  }

  entry.lastSeen = Date.now();
  bumpIdleTimer(psid, entry);
  return entry.ws;
}

app.post("/send", async (req, res) => {
  try {
    const { psid, text, agentId, initContext } = req.body || {};
    if (!psid || !text) return res.status(400).json({ ok: false, error: "psid and text are required" });

    const id = agentId || DEFAULT_AGENT_ID;
    if (!id) return res.status(400).json({ ok: false, error: "agentId or DEFAULT_AGENT_ID required" });

    const ws = await ensureSocket(psid, id, initContext);

    // wait until the socket is OPEN before sending
    await waitForOpen(ws, 10000);

    ws.send(JSON.stringify({ type: "user_message", text }));
    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /send error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Optional: root alias so POST / also works
app.post("/", (req, res, next) => {
  req.url = "/send";
  next();
});

app.get("/", (req, res) => res.json({ ok: true, hint: "POST /send with { psid, text }" }));
app.get("/health", (req, res) => res.json({ ok: true, sockets: sockets.size }));
app.get("/debug/sockets", (req, res) => {
  const list = [...sockets.entries()].map(([k, v]) => ({ psid: k, lastSeen: v.lastSeen }));
  res.json({ count: list.length, list });
});

app.listen(PORT, () => console.log(`Relay listening on :${PORT}`));
