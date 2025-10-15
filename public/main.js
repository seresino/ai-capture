// public/main.js (Final Corrected Version)

const recordBtn = document.getElementById("record-button");
const transcriptDiv = document.getElementById("transcript");
const sourceTypeSel = document.getElementById("source-type");
const deviceSelect = document.getElementById("audio-input");
const deviceSelectWrap = document.getElementById("device-select-wrap");
const fileInputWrap = document.getElementById("file-input-wrap");
const statusEl = document.getElementById("status-indicator");

let isRecording = false;
let transcriber;
let mediaStream;
let audioCtx;
let sourceNode;
let processorNode;

let selectedDeviceId = localStorage.getItem("selectedDeviceId") || "";

// FR-2: simple state for take segmentation
let takeActive = false;

// FR-3: pending scene/take state
let pendingScene = null;
let pendingTake = null;
let pendingTs = 0;

const natoMap = {
  alpha: "A", bravo: "B", charlie: "C", delta: "D", echo: "E", foxtrot: "F",
  golf: "G", hotel: "H", india: "I", juliet: "J", juliett: "J", kilo: "K",
  lima: "L", mike: "M", november: "N", oscar: "O", papa: "P", quebec: "Q",
  romeo: "R", sierra: "S", tango: "T", uniform: "U", victor: "V", whiskey: "W",
  xray: "X", "x-ray": "X", yankee: "Y", zulu: "Z"
};

// Basic number word parsing for English (0..9999 typical for scenes/takes)
const smallNumbers = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19
};
const tensNumbers = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
};
const scaleNumbers = { hundred: 100, thousand: 1000 };

function wordsToNumber(str) {
  if (!str) return null;
  const tokens = str
    .toLowerCase()
    .replace(/-/g, " ")
    .trim()
    .split(/\s+/);
  let total = 0;
  let current = 0;
  let consumed = 0;
  let usedAny = false;
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      // Digit token short-circuits and stops number word parsing
      total += current;
      total += parseInt(tok, 10);
      consumed++;
      usedAny = true;
      break;
    } else if (tok in smallNumbers) {
      current += smallNumbers[tok];
      consumed++;
      usedAny = true;
    } else if (tok in tensNumbers) {
      current += tensNumbers[tok];
      consumed++;
      usedAny = true;
    } else if (tok in scaleNumbers) {
      // e.g., one hundred -> multiply current by 100
      current = (current || 1) * scaleNumbers[tok];
      consumed++;
      usedAny = true;
    } else if (tok === 'and') {
      consumed++;
      continue;
    } else {
      break;
    }
  }
  if (!usedAny) return null;
  total += current;
  return { value: total, consumed };
}

function parseSceneTake(text) {
  if (!text) return;
  const t = text.toLowerCase();
  const now = Date.now();
  // Try to capture a scene block up to the next keyword to avoid over-capture
  const sceneBlock = t.match(/\bscene\s+([a-z0-9\s-]+?)(?=\b(take|action|rolling|turnover|cut)\b|$)/);
  if (sceneBlock) {
    const block = sceneBlock[1].trim();
    const parts = block.split(/\s+/);
    // Parse leading number (digits or words)
    const numParse = wordsToNumber(parts.join(' '));
    let sceneNum = null;
    let consumed = 0;
    if (numParse) {
      sceneNum = numParse.value;
      consumed = numParse.consumed;
    } else if (/^\d+$/.test(parts[0])) {
      sceneNum = parseInt(parts[0], 10);
      consumed = 1;
    }
    if (sceneNum !== null) {
      const suffixParts = parts.slice(consumed);
      let letters = "";
      for (const p of suffixParts) {
        if (!p) continue;
        const w = p.replace(/[^a-z]/g, "");
        if (!w) continue;
        if (natoMap[w]) {
          letters += natoMap[w];
        } else {
          letters += w[0].toUpperCase();
        }
      }
      pendingScene = letters ? `${sceneNum}${letters}` : `${sceneNum}`;
      pendingTs = now;
    }
  }

  // TAKE: support digits or number words
  let takeMatched = false;
  const takeDigits = t.match(/\btake\s+(\d+)\b/);
  if (takeDigits) {
    pendingTake = takeDigits[1];
    pendingTs = now;
    takeMatched = true;
  }
  if (!takeMatched) {
    const takeBlock = t.match(/\btake\s+([a-z0-9\s-]+?)(?=\b(action|rolling|turnover|cut)\b|$)/);
    if (takeBlock) {
      const parsed = wordsToNumber(takeBlock[1]);
      if (parsed && typeof parsed.value === 'number') {
        pendingTake = String(parsed.value);
        pendingTs = now;
      }
    }
  }
}

function flashStatus(msg, color = "#ef4444", durationMs = 2000) {
  if (!statusEl) return;
  const prevColor = statusEl.style.color;
  const prevText = statusEl.textContent;
  statusEl.style.color = color;
  statusEl.textContent = msg;
  setTimeout(() => {
    // Restore only if not overwritten by recording status
    if (isRecording) {
      statusEl.style.color = prevColor || "";
      statusEl.textContent = "Recording";
    } else {
      statusEl.style.color = prevColor || "";
      statusEl.textContent = "";
    }
  }, durationMs);
}

function handleStructuralKeywords(text) {
  if (!text) return;
  const t = text.toLowerCase();
  const hasAction = /\b(action|rolling|turnover)\b/.test(t);
  const hasCut = /\bcut\b/.test(t);

  // If both appear, respect ordering within the string
  const firstActionIdx = t.search(/\b(action|rolling|turnover)\b/);
  const firstCutIdx = t.search(/\bcut\b/);

  const ordered = [];
  if (hasAction) ordered.push({ type: "action", idx: firstActionIdx });
  if (hasCut) ordered.push({ type: "cut", idx: firstCutIdx });
  ordered.sort((a, b) => a.idx - b.idx);

  for (const evt of ordered) {
    if (evt.type === "action") {
      if (!takeActive) {
        takeActive = true;
        // If we have a recent pending scene/take, show header
        const now = Date.now();
        if (pendingTs && now - pendingTs < 10000 /* 10s window */) {
          const sceneText = pendingScene ? `SCENE ${pendingScene}` : null;
          const takeText = pendingTake ? `TAKE ${pendingTake}` : null;
          const header = [sceneText, takeText].filter(Boolean).join(" / ");
          if (header) {
            transcriptDiv.innerHTML += `<p><strong>${header}</strong></p>`;
          }
        }
        transcriptDiv.innerHTML += `<p>--- ACTION ---</p>`;
        flashStatus("ACTION detected", "#16a34a");
      }
    } else if (evt.type === "cut") {
      if (takeActive) {
        takeActive = false;
        transcriptDiv.innerHTML += `<p>--- CUT ---</p>`;
        flashStatus("CUT detected", "#2563eb");
        // Reset pending scene/take after a take completes
        pendingScene = null;
        pendingTake = null;
        pendingTs = 0;
      }
    }
  }
}

async function listAudioInputs() {
  try {
    // Request permission so labels are available
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch {}
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    if (deviceSelect) {
      deviceSelect.innerHTML = "";
      const optDefault = document.createElement("option");
      optDefault.value = "";
      optDefault.textContent = "Default microphone";
      deviceSelect.appendChild(optDefault);
      for (const d of inputs) {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || `Input ${deviceSelect.options.length}`;
        deviceSelect.appendChild(opt);
      }
      if (selectedDeviceId) {
        deviceSelect.value = selectedDeviceId;
      }
      deviceSelect.onchange = () => {
        selectedDeviceId = deviceSelect.value;
        try { localStorage.setItem("selectedDeviceId", selectedDeviceId); } catch {}
      };
    }
  } catch (e) {
    console.warn("enumerateDevices failed:", e);
  }
}

// Function to get the temporary token from our server
async function getToken() {
  try {
    const response = await fetch("/token");
    const data = await response.json();
    if (data.error) {
      throw new Error(data.error);
    }
    return data.token;
  } catch (error) {
    alert("Error fetching token: " + error.message);
    return null;
  }
}

async function run() {
  if (isRecording) {
    // Stop recording
    try {
      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
      }
      if (processorNode) {
        try {
          // Notify worklet to stop if applicable
          if (processorNode.port && typeof processorNode.port.postMessage === "function") {
            processorNode.port.postMessage({ type: "disconnect" });
          }
        } catch {}
        try {
          processorNode.disconnect();
        } catch {}
        try {
          processorNode.onaudioprocess = null;
        } catch {}
        processorNode = null;
      }
      if (sourceNode) {
        try {
          sourceNode.disconnect();
        } catch {}
        sourceNode = null;
      }
      if (audioCtx) {
        try {
          audioCtx.close();
        } catch {}
        audioCtx = null;
      }
      if (transcriber) {
        await transcriber.close();
        transcriber = null;
      }
    } catch (e) {
      console.error("Error stopping recording:", e);
    } finally {
      recordBtn.innerText = "Record";
      isRecording = false;
      if (statusEl) statusEl.textContent = "";
    }
  } else {
    // Start recording
    transcriptDiv.innerHTML = "";
    recordBtn.innerText = "Connecting...";
    if (statusEl) statusEl.textContent = "";

    // 1) Fetch token and validate response
    const token = await getToken();
    if (!token) {
      console.error("No token received from /token");
      recordBtn.innerText = "Record";
      return;
    }
    console.log("Got temp token (truncated):", token.slice(0, 8) + "...");

    // 2) Choose source: mic or file (file stub for future)
    const srcType = (sourceTypeSel && sourceTypeSel.value) || "mic";
    if (srcType === "file") {
      alert("Audio file input coming soon. Please select Microphone / Line-in for now.");
      recordBtn.innerText = "Record";
      return;
    }
    // Mic/line-in path: getUserMedia with optional deviceId constraint
    try {
      const constraints = selectedDeviceId
        ? { audio: { deviceId: { exact: selectedDeviceId } } }
        : { audio: true };
      mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      console.error("Mic permission/error:", err);
      recordBtn.innerText = "Record";
      return;
    }

    let detectedSampleRate = 48000;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({});
      detectedSampleRate = audioCtx.sampleRate || detectedSampleRate;
    } catch (e) {
      console.warn(
        "Could not detect sampleRate via AudioContext; defaulting to",
        detectedSampleRate
      );
    }
    console.log("Detected sampleRate:", detectedSampleRate);

    // 3) Create StreamingTranscriber using detected sample rate
    try {
      transcriber = new assemblyai.StreamingTranscriber({
        token,
        sampleRate: detectedSampleRate,
        speakerLabels: true,
      });
    } catch (e) {
      console.error("Failed to instantiate StreamingTranscriber:", e);
      recordBtn.innerText = "Record";
      // Stop mic since we failed to create transcriber
      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
      }
      return;
    }

    transcriber.on("open", (info) => {
      console.log("Session started.", info);
      recordBtn.innerText = "Stop Recording";
      isRecording = true;
      if (statusEl) statusEl.textContent = "Recording";
    });

    transcriber.on("error", (error) => {
      console.error("StreamingTranscriber error:", error);
      isRecording = false;
      recordBtn.innerText = "Record";
    });

    transcriber.on("close", (code, reason) => {
      console.log("Session closed.", { code, reason });
      isRecording = false;
      recordBtn.innerText = "Record";
      // Prevent further sends if the socket is closed
      transcriber = null;
      if (statusEl) statusEl.textContent = "";
    });

    transcriber.on("turn", (turn) => {
      // Display final transcripts at end of turn
      if (turn && turn.transcript) {
        // Update scene/take state and detect structural keywords
        try { parseSceneTake(turn.transcript); } catch {}
        try { handleStructuralKeywords(turn.transcript); } catch {}
      }
      if (turn && turn.transcript && turn.end_of_turn) {
        transcriptDiv.innerHTML += `<p>${turn.transcript}</p>`;
      }
    });

    // 4) Connect after handlers are ready
    try {
      // Log the connection URL with token redacted
      {
        const url = transcriber.connectionUrl().toString();
        const masked = url.replace(/token=[^&]+/, "token=****");
        console.log("Connecting to:", masked);
      }
      await transcriber.connect();
      console.log("WebSocket connect() resolved");
    } catch (e) {
      console.error("Failed to connect to StreamingTranscriber:", e);
      recordBtn.innerText = "Record";
      // Stop mic if connect failed
      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
      }
      if (audioCtx) {
        try {
          audioCtx.close();
        } catch {}
        audioCtx = null;
      }
      return;
    }

    // 5) Stream raw PCM using AudioWorkletNode with fallback to ScriptProcessorNode
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({});
      }
      sourceNode = audioCtx.createMediaStreamSource(mediaStream);

      const floatTo16BitPCM = (input) => {
        const output = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return output;
      };

      // Accumulation buffers to meet service min input duration (>=50ms)
      let chunkBuffer = [];
      let chunkLength = 0;
      const sr = audioCtx.sampleRate || detectedSampleRate || 48000;
      const minSamples = Math.round(sr * 0.05); // 50ms
      const maxSamples = Math.round(sr * 0.2);  // 200ms cap

      try {
        await audioCtx.audioWorklet.addModule("/audio-processor.js");
        const workletNode = new AudioWorkletNode(audioCtx, "audio-processor");
        workletNode.port.onmessage = (event) => {
          if (!transcriber) return;
          const float32 = event.data; // Float32Array [-1,1] ~128 samples/frame
          if (!float32 || !float32.length) return;
          chunkBuffer.push(float32);
          chunkLength += float32.length;

          if (chunkLength >= minSamples) {
            // Build a contiguous chunk up to maxSamples
            const take = Math.min(chunkLength, maxSamples);
            const merged = new Float32Array(take);
            let offset = 0;
            while (offset < take && chunkBuffer.length) {
              const cur = chunkBuffer[0];
              const copyCount = Math.min(cur.length, take - offset);
              merged.set(cur.subarray(0, copyCount), offset);
              offset += copyCount;
              if (copyCount === cur.length) {
                chunkBuffer.shift();
              } else {
                // Keep the remainder of the current buffer
                chunkBuffer[0] = cur.subarray(copyCount);
              }
            }
            chunkLength -= take;

            try {
              const pcm16 = floatTo16BitPCM(merged);
              transcriber.sendAudio(pcm16.buffer);
            } catch (sendErr) {
              // If the socket closed, avoid further sends
              console.warn("sendAudio failed:", sendErr);
            }
          }
        };
        sourceNode.connect(workletNode);
        // Do not connect to destination to avoid echo
        processorNode = workletNode;
        console.log("PCM streaming started via AudioWorkletNode");
      } catch (workletErr) {
        console.warn("AudioWorkletNode failed, falling back to ScriptProcessorNode:", workletErr);
        // Fallback: ScriptProcessorNode
        const bufferSize = 4096;
        const channels = 1;
        const scriptNode = audioCtx.createScriptProcessor(bufferSize, channels, channels);
        scriptNode.onaudioprocess = (e) => {
          if (!transcriber) return;
          const inputBuffer = e.inputBuffer.getChannelData(0); // Float32 [-1,1]
          const pcm16 = floatTo16BitPCM(inputBuffer);
          transcriber.sendAudio(pcm16.buffer);
        };
        sourceNode.connect(scriptNode);
        // Some browsers require connection to destination
        try { scriptNode.connect(audioCtx.destination); } catch {}
        processorNode = scriptNode;
        console.log("PCM streaming started via ScriptProcessorNode");
      }
    } catch (e) {
      console.error("Failed to start PCM streaming:", e);
      // Cleanup
      try {
        if (processorNode) processorNode.disconnect();
      } catch {}
      try {
        if (sourceNode) sourceNode.disconnect();
      } catch {}
      if (audioCtx) {
        try {
          audioCtx.close();
        } catch {}
        audioCtx = null;
      }
      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
      }
      // Close the transcriber session
      try {
        if (transcriber) transcriber.close();
      } catch {}
      recordBtn.innerText = "Record";
      isRecording = false;
      return;
    }
  }
}

recordBtn.addEventListener("click", run);

// Initialize UI
if (sourceTypeSel) {
  try {
    const savedSrc = localStorage.getItem("sourceType") || "mic";
    sourceTypeSel.value = savedSrc;
  } catch {}
  sourceTypeSel.onchange = () => {
    const val = sourceTypeSel.value;
    try { localStorage.setItem("sourceType", val); } catch {}
    // Toggle visibility for device vs file inputs
    if (deviceSelectWrap) deviceSelectWrap.style.display = val === "mic" ? "inline-block" : "none";
    if (fileInputWrap) fileInputWrap.style.display = val === "file" ? "inline-block" : "none";
  };
  // Initial toggle state
  sourceTypeSel.onchange();
}

// Populate audio device list (best-effort)
listAudioInputs();
