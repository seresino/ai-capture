// index.js (Token Server)

import express from "express";
import { AssemblyAI } from "assemblyai";
import "dotenv/config";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
const port = 3000;

app.use(express.static("public"));
app.use(express.json());

const client = new AssemblyAI({
  apiKey: process.env.ASSEMBLYAI_API_KEY,
});

app.get("/token", async (req, res) => {
  try {
    const token = await client.streaming.createTemporaryToken({
      expires_in_seconds: 600,
    });
    res.json({ token });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/index.html");
});

// Create HTTP server to attach WebSocket server
const server = http.createServer(app);

// Deepgram proxy WebSocket: ws://localhost:3000/deepgram?sample_rate=48000
const wss = new WebSocketServer({ server, path: "/deepgram" });

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    const sampleRate = parseInt(url.searchParams.get("sample_rate") || "48000", 10);
    const encoding = url.searchParams.get("encoding") || "linear16";

    const dgUrl = new URL("wss://api.deepgram.com/v1/listen");
    dgUrl.searchParams.set("diarize", "true");
    dgUrl.searchParams.set("punctuate", "true");
    dgUrl.searchParams.set("encoding", encoding);
    dgUrl.searchParams.set("sample_rate", String(sampleRate));
    // Optional sensible defaults: enable smart formatting if supported
    dgUrl.searchParams.set("smart_format", "true");
    // Recommended additional options
    dgUrl.searchParams.set("language", "en-US");
    dgUrl.searchParams.set("utterances", "true");
    dgUrl.searchParams.set("vad_events", "true");
    dgUrl.searchParams.set("endpointing", "100");
    dgUrl.searchParams.set("numerals", "true");
    dgUrl.searchParams.set("model", "nova-2");

    const dgHeaders = {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
    };

    const dg = new WebSocket(dgUrl.toString(), { headers: dgHeaders });

    dg.on("open", () => {
      ws.send(JSON.stringify({ type: "deepgram_open" }));
    });

    dg.on("message", (data) => {
      // Forward Deepgram JSON results to the browser as text
      try {
        ws.send(data);
      } catch {}
    });

    dg.on("close", () => {
      try { ws.close(); } catch {}
    });
    dg.on("error", (err) => {
      try { ws.send(JSON.stringify({ type: "error", error: String(err) })); } catch {}
      try { ws.close(); } catch {}
    });

    ws.on("message", (msg, isBinary) => {
      // Forward binary PCM audio to Deepgram
      if (dg.readyState === WebSocket.OPEN) {
        dg.send(msg, { binary: true });
      }
    });

    ws.on("close", () => {
      try { dg.close(); } catch {}
    });
    ws.on("error", () => {
      try { dg.close(); } catch {}
    });
  } catch (e) {
    try { ws.send(JSON.stringify({ type: "error", error: String(e) })); } catch {}
    try { ws.close(); } catch {}
  }
});

server.listen(port, () => {
  console.log(`Server is listening on http://localhost:${port}`);
});
