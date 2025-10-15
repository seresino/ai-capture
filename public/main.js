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
