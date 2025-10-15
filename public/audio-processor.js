// public/audio-processor.js (with disconnect logic)

class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isDisconnected = false;
    this.port.onmessage = (event) => {
      if (event.data.type === "disconnect") {
        this.isDisconnected = true;
      }
    };
  }

  process(inputs, outputs, parameters) {
    if (this.isDisconnected) {
      return false; // Stop processing
    }

    const input = inputs[0];
    const channelData = input[0];

    if (channelData) {
      this.port.postMessage(channelData);
    }

    return true; // Keep alive
  }
}

registerProcessor("audio-processor", AudioProcessor);
