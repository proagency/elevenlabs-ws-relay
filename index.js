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
  return axios.post(STREAM_WEBHOOK_URL, payload).catch(() => {});
}

function handleServerEvents(psid) {
  return async (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    const entry = sockets.get(psid);
    if (!entry) return;
    entry.lastSeen = Date.now();
    bumpIdleTimer(psid, entry);

    // ElevenLabs server → client events (subset)
    if (data.type === "ping" || data.ping_event) {
      // Reply with pong; event_id may be present on some ping events
      entry.ws.send(JSON.stringify({ type: "pong", event_id: data.ping_event?.event_id }));
      return;
    }

    // Stream tentative (token-y) text
    if (data.type === "internal_tentative_agent_response") {
      const text = data.tentative_agent_response_internal_event?.tentative_agent_response;
      if (text) await forwardToMake({ psid, type: "partial", text, final: false });
      return;
    }

    // Final agent response
    if (data.type === "agent_response") {
      const text = data.agent_response_event?.agent_response;
      if (text) await forwardToMake({ psid, type: "final", text, final: true });
      return;
    }

    // (Optional) handle audio chunks if you need TTS streaming
    // if (data.type === "audio") { ... }
  };
}

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
        try { ws.send(JSON.stringify(pendingInitContext)); entry.initialized = true; } catch {}
      }
    });
    ws.on("message", handleServerEvents(psid));
    ws.on("close", () => sockets.delete(psid));
    ws.on("error", () => sockets.delete(psid));
  } else {
    // If socket exists and we received an init context but never sent it
    if (pendingInitContext && !entry.initialized) {
      try { entry.ws.send(JSON.stringify(pendingInitContext)); entry.initialized = true; } catch {}
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
    const ws = await ensureSocket(psid, id, initContext);

    // Forward user text to ElevenLabs
    ws.send(JSON.stringify({ type: "user_message", text }));
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/health", (req, res) => res.json({ ok: true, sockets: sockets.size }));
app.get("/debug/sockets", (req, res) => {
  const list = [...sockets.entries()].map(([k, v]) => ({ psid: k, lastSeen: v.lastSeen }));
  res.json({ count: list.length, list });
});

app.listen(PORT, () => console.log(`Relay listening on :${PORT}`));
