// index.js (Token Server)

import express from "express";
import { AssemblyAI } from "assemblyai";
import "dotenv/config";

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

app.listen(port, () => {
  console.log(`Server is listening on http://localhost:${port}`);
});
