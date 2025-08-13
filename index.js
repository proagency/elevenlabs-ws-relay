import express from "express";
import axios from "axios";
import { WebSocket } from "ws";

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
    // See docs for full list; we handle text + ping. 

---

# 5) Make (Streaming back to the user)

- Your **streaming scenario** receives payloads like:
  ```json
  { "psid": "12345", "type": "partial", "text": "hello wor", "final": false }
  { "psid": "12345", "type": "final",   "text": "Hello world!", "final": true }
