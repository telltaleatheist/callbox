const grandiose = require('grandiose');

let sender = null;
let isActive = false;

// Audio settings - matches Web Audio API output
const SAMPLE_RATE = 48000;
const NUM_CHANNELS = 2;

// FourCC for float planar audio: "FLTp"
const FOURCC_FLTp = grandiose.FOURCC_FLTp;

async function start(name = 'CallBox Audio') {
  if (sender) {
    console.log('NDI sender already running');
    return true;
  }

  try {
    sender = await grandiose.send({
      name: name,
      clockVideo: false,
      clockAudio: true
    });
    isActive = true;
    console.log(`NDI sender started: "${name}"`);
    return true;
  } catch (err) {
    console.error('Failed to start NDI sender:', err);
    return false;
  }
}

function stop() {
  if (sender) {
    sender = null;
    isActive = false;
    console.log('NDI sender stopped');
  }
}

function sendAudio(floatSamples, sampleRate = SAMPLE_RATE, channels = NUM_CHANNELS) {
  if (!sender || !isActive) return;

  try {
    // floatSamples is a Float32Array of interleaved stereo samples
    // Convert to planar format (all of channel 0, then all of channel 1, etc.)
    const numSamples = Math.floor(floatSamples.length / channels);

    // Create planar buffer: each channel's samples stored contiguously
    const planarBuffer = Buffer.alloc(numSamples * channels * 4); // 4 bytes per float32

    // De-interleave: interleaved [L0,R0,L1,R1,...] -> planar [L0,L1,...,R0,R1,...]
    for (let ch = 0; ch < channels; ch++) {
      for (let i = 0; i < numSamples; i++) {
        const sample = floatSamples[i * channels + ch];
        planarBuffer.writeFloatLE(sample, (ch * numSamples + i) * 4);
      }
    }

    // Send to NDI
    sender.audio({
      sampleRate: sampleRate,
      noChannels: channels,
      noSamples: numSamples,
      channelStrideBytes: numSamples * 4, // bytes per channel
      fourCC: FOURCC_FLTp,
      data: planarBuffer
    });
  } catch (err) {
    // Log errors for debugging but don't spam
    if (!sendAudio.lastError || Date.now() - sendAudio.lastError > 5000) {
      console.error('NDI audio send error:', err.message);
      sendAudio.lastError = Date.now();
    }
  }
}

function getStatus() {
  return {
    active: isActive,
    name: sender ? 'CallBox Audio' : null
  };
}

module.exports = {
  start,
  stop,
  sendAudio,
  getStatus
};
