// public/pcm-worker.js
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input.length > 0) {
      const channelData = input[0];
      
      // Convert Float32 to Int16 PCM immediately in the worker thread
      const pcm16 = new Int16Array(channelData.length);
      for (let i = 0; i < channelData.length; i++) {
        let s = Math.max(-1, Math.min(1, channelData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      
      // Send the buffer back to the main UI thread via port
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }
    // Returning true keeps the processor alive
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
