
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.chunkSize = Math.round(sampleRate * 0.1); // 100 ms
  }

  process(inputs) {
    const input = inputs[0]?.[0];

    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.buffer.push(input[i]);
      }

      while (this.buffer.length >= this.chunkSize) {
        const chunk = this.buffer.splice(0, this.chunkSize);

        this.port.postMessage(
          Float32Array.from(chunk)
        );
      }
    }

    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
