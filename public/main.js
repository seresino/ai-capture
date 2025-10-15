// public/main.js (Final Corrected Version)

const recordBtn = document.getElementById("record-button");
const transcriptDiv = document.getElementById("transcript");

let isRecording = false;
let transcriber;
let mediaStream;
let audioCtx;
let sourceNode;
let processorNode;

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
          processorNode.disconnect();
        } catch {}
        processorNode.onaudioprocess = null;
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
    }
  } else {
    // Start recording
    transcriptDiv.innerHTML = "";
    recordBtn.innerText = "Connecting...";

    // 1) Fetch token and validate response
    const token = await getToken();
    if (!token) {
      console.error("No token received from /token");
      recordBtn.innerText = "Record";
      return;
    }
    console.log("Got temp token (truncated):", token.slice(0, 8) + "...");

    // 2) Ask for microphone first and detect sample rate
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error("Mic permission error:", err);
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
    });

    transcriber.on("turn", (turn) => {
      // Display final transcripts at end of turn
      if (turn && turn.transcript && turn.end_of_turn) {
        transcriptDiv.innerHTML += `<p>${turn.transcript}</p>`;
      }
    });

    // 4) Connect after handlers are ready
    try {
      // Log the actual connection URL for debugging
      console.log("Connecting to:", transcriber.connectionUrl().toString());
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

    // 5) Stream raw PCM using AudioContext + ScriptProcessorNode
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({});
      }
      sourceNode = audioCtx.createMediaStreamSource(mediaStream);
      // Buffer size: 4096 gives reasonable latency
      const bufferSize = 4096;
      const channels = 1;
      processorNode = audioCtx.createScriptProcessor(
        bufferSize,
        channels,
        channels
      );

      const floatTo16BitPCM = (input) => {
        const output = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return output;
      };

      processorNode.onaudioprocess = (e) => {
        if (!transcriber) return;
        const inputBuffer = e.inputBuffer.getChannelData(0); // Float32 [-1,1]
        const pcm16 = floatTo16BitPCM(inputBuffer);
        transcriber.sendAudio(pcm16.buffer);
      };

      sourceNode.connect(processorNode);
      processorNode.connect(audioCtx.destination); // required by some browsers
      console.log("PCM streaming started via ScriptProcessorNode");
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
