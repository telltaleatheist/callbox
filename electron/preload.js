const { ipcRenderer } = require('electron');

// Terminal logging
const log = (msg) => { console.log(msg); ipcRenderer.send('log', msg); };
const logError = (msg) => { console.error(msg); ipcRenderer.send('log-error', msg); };

log('Preload script loaded');

// Inject WebRTC interception into main world
// Must wait for document to exist, but run before page JS
function injectMainWorldScript() {
  const injectScript = document.createElement('script');
  injectScript.textContent = `
(function() {
  // NDI audio capture runs entirely in main world
  let audioContext = null;
  let ndiProcessor = null;
  let ndiEnabled = false;
  let masterVolume = 100; // Volume 0-100
  const capturedStreams = new Set();

  function initAudioContext() {
    if (audioContext) return;
    audioContext = new AudioContext({ sampleRate: 48000 });
    console.log('[CallBox] AudioContext created:', audioContext.sampleRate + 'Hz');

    ndiProcessor = audioContext.createScriptProcessor(4096, 2, 2);
    ndiProcessor.onaudioprocess = (e) => {
      if (!ndiEnabled) return;
      const left = e.inputBuffer.getChannelData(0);
      const right = e.inputBuffer.getChannelData(1);
      const interleaved = new Float32Array(left.length * 2);
      const volumeMultiplier = masterVolume / 100; // Convert 0-100 to 0.0-1.0
      for (let i = 0; i < left.length; i++) {
        interleaved[i * 2] = left[i] * volumeMultiplier;
        interleaved[i * 2 + 1] = right[i] * volumeMultiplier;
      }
      // Send to preload via postMessage
      window.postMessage({
        type: 'callbox-ndi-audio',
        samples: Array.from(interleaved),
        sampleRate: audioContext.sampleRate,
        channels: 2
      }, '*');
    };

    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    ndiProcessor.connect(silentGain);
    silentGain.connect(audioContext.destination);
  }

  function connectStream(stream, label) {
    if (!audioContext) initAudioContext();
    if (capturedStreams.has(stream.id)) return;

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      console.log('[CallBox] Stream has no audio:', label);
      return;
    }

    try {
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(ndiProcessor);
      capturedStreams.add(stream.id);
      console.log('[CallBox] Connected stream to NDI:', label, '(tracks:', audioTracks.length + ')');
      window.postMessage({ type: 'callbox-log', msg: 'Connected stream to NDI: ' + label }, '*');
    } catch (err) {
      console.error('[CallBox] Failed to connect stream:', err);
    }
  }

  // Listen for NDI enable/disable and volume changes from preload
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'callbox-ndi-enable') {
      ndiEnabled = e.data.enabled;
      console.log('[CallBox] NDI enabled:', ndiEnabled);
      if (ndiEnabled) {
        initAudioContext();
        // Connect any pending streams
        window.__callbox_streams.forEach(s => connectStream(s, 'pending stream'));
        // Also scan for audio/video elements
        document.querySelectorAll('audio, video').forEach(el => {
          if (el.srcObject instanceof MediaStream) {
            connectStream(el.srcObject, el.tagName + ' element');
          }
        });
      }
    } else if (e.data && e.data.type === 'callbox-volume-change') {
      masterVolume = e.data.volume;
      console.log('[CallBox] Volume changed to:', masterVolume + '%');
    }
  });

  // Store captured streams
  window.__callbox_streams = [];

  // Hook RTCPeerConnection in main world
  const OrigRTC = window.RTCPeerConnection;
  window.RTCPeerConnection = function(...args) {
    const pc = new OrigRTC(...args);
    console.log('[CallBox] RTCPeerConnection created');

    pc.addEventListener('track', (event) => {
      console.log('[CallBox] RTCPeerConnection track event:', event.track.kind);
      if (event.track.kind === 'audio' && event.streams.length > 0) {
        event.streams.forEach(stream => {
          if (!window.__callbox_streams.find(s => s.id === stream.id)) {
            window.__callbox_streams.push(stream);
            console.log('[CallBox] Captured audio stream:', stream.id);
            if (ndiEnabled) {
              connectStream(stream, 'WebRTC stream');
            }
          }
        });
      }
    });

    return pc;
  };
  Object.assign(window.RTCPeerConnection, OrigRTC);
  console.log('[CallBox] RTCPeerConnection hook installed');
})();
`;
  // Append to document - script runs synchronously
  if (document.documentElement) {
    document.documentElement.appendChild(injectScript);
    injectScript.remove();
  } else {
    // Wait for document to be ready
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.appendChild(injectScript);
      injectScript.remove();
    }, { once: true });
  }
}

// Try to inject immediately, or wait for document
if (document.documentElement) {
  injectMainWorldScript();
} else {
  // Poll for document.documentElement
  const waitForDoc = setInterval(() => {
    if (document.documentElement) {
      clearInterval(waitForDoc);
      injectMainWorldScript();
    }
  }, 1);
}

// Listen for audio data from main world
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'callbox-ndi-audio') {
    ipcRenderer.send('ndi-audio', {
      samples: e.data.samples,
      sampleRate: e.data.sampleRate,
      channels: e.data.channels
    });
  } else if (e.data && e.data.type === 'callbox-log') {
    log(e.data.msg);
  }
});

// Initialize preload for all pages
initPreload();

function initPreload() {

let preferredMicId = null;
let preferredSpeakerId = null;
let masterVolume = 100;
let ndiEnabled = false;


// Auto-login handler - will be called from DOMContentLoaded
async function tryAutoLogin() {
  const emailInput = document.querySelector('input[name="email"]');
  const passInput = document.querySelector('input[name="pwd"]');

  if (!emailInput || !passInput) {
    log('No login form found on this page');
    return;
  }

  log('Login form detected - checking for saved credentials');

  // Get credentials from secure storage
  const credentials = await ipcRenderer.invoke('get-credentials');

  if (!credentials || !credentials.email || !credentials.password) {
    log('No saved credentials found - user must log in manually');
    return;
  }

  log('Found saved credentials for: ' + credentials.email);
  const submitBtn = document.querySelector('button[type="submit"]');

  emailInput.value = credentials.email;
  passInput.value = credentials.password;

  // Trigger input events so the site registers the values
  emailInput.dispatchEvent(new Event('input', { bubbles: true }));
  passInput.dispatchEvent(new Event('input', { bubbles: true }));

  if (submitBtn) {
    log('Auto-submitting login form');
    setTimeout(() => submitBtn.click(), 300);
  }
}

// Load saved preferences
(async () => {
  preferredMicId = await ipcRenderer.invoke('get-preferred-mic');
  preferredSpeakerId = await ipcRenderer.invoke('get-preferred-speaker');
  masterVolume = await ipcRenderer.invoke('get-master-volume') ?? 100;
  ndiEnabled = await ipcRenderer.invoke('get-ndi-enabled') ?? false;
})();

// Apply volume to all audio/video elements
function applyMasterVolume() {
  document.querySelectorAll('audio, video').forEach(el => {
    el.volume = masterVolume / 100;
  });
}

// Override getUserMedia to use selected mic
const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (constraints) => {
  log('getUserMedia called with: ' + JSON.stringify(constraints));
  try {
    // Don't override deviceId for desktop capture (NDI) - check for chromeMediaSource
    const isDesktopCapture = constraints.audio &&
      typeof constraints.audio === 'object' &&
      constraints.audio.mandatory &&
      constraints.audio.mandatory.chromeMediaSource === 'desktop';

    if (constraints.audio && preferredMicId && !isDesktopCapture) {
      log('Overriding audio deviceId to: ' + preferredMicId);
      if (typeof constraints.audio === 'boolean') {
        constraints.audio = { deviceId: { exact: preferredMicId } };
      } else {
        constraints.audio.deviceId = { exact: preferredMicId };
      }
    }
    const result = await originalGetUserMedia(constraints);
    log('getUserMedia succeeded');
    return result;
  } catch (err) {
    logError('getUserMedia failed: ' + err.message);
    throw err;
  }
};

// Inject toolbar
window.addEventListener('DOMContentLoaded', async () => {
  try {
    log('DOMContentLoaded fired');
    log('Current URL: ' + window.location.href);

    // Try auto-login first
    tryAutoLogin();

    // Sync NDI state to main world if already enabled
    const savedNdiEnabled = await ipcRenderer.invoke('get-ndi-enabled');
    if (savedNdiEnabled) {
      log('NDI was already enabled - syncing to main world');
      window.postMessage({ type: 'callbox-ndi-enable', enabled: true }, '*');
      // Also sync the current volume
      window.postMessage({ type: 'callbox-volume-change', volume: masterVolume }, '*');
    }


    const devices = await navigator.mediaDevices.enumerateDevices();
    log('Found ' + devices.length + ' media devices');
    log('Filtering devices...');
    const mics = devices.filter(d => d.kind === 'audioinput');
    log('Found ' + mics.length + ' mics');
    const speakers = devices.filter(d => d.kind === 'audiooutput');
    log('Found ' + speakers.length + ' speakers');
    log('Creating toolbar element...');
    const toolbar = document.createElement('div');
  toolbar.id = 'callbox-toolbar';
  toolbar.innerHTML = `
    <style>
      #callbox-toolbar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 38px;
        background: rgba(30, 30, 30, 0.95);
        border-bottom: 1px solid #444;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        padding: 0 12px 0 80px;
        gap: 16px;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 12px;
        color: #ccc;
        -webkit-app-region: drag;
        backdrop-filter: blur(10px);
      }
      #callbox-toolbar .device-group {
        display: flex;
        align-items: center;
        gap: 6px;
        -webkit-app-region: no-drag;
      }
      #callbox-toolbar label {
        color: #888;
        font-size: 11px;
      }
      #callbox-toolbar select {
        background: #333;
        color: #fff;
        border: 1px solid #555;
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 11px;
        max-width: 180px;
        cursor: pointer;
      }
      #callbox-toolbar select:hover { border-color: #ff6b35; }
      #callbox-toolbar input[type="range"] {
        width: 80px;
        height: 4px;
        -webkit-appearance: none;
        background: #555;
        border-radius: 2px;
        cursor: pointer;
        -webkit-app-region: no-drag;
      }
      #callbox-toolbar input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 14px;
        height: 14px;
        background: #ff6b35;
        border-radius: 50%;
        cursor: pointer;
      }
      #callbox-toolbar .vol-label {
        min-width: 32px;
        text-align: right;
        font-size: 11px;
        color: #ff6b35;
      }
      #callbox-toolbar .ndi-btn {
        background: #333;
        color: #888;
        border: 1px solid #555;
        border-radius: 4px;
        padding: 4px 10px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        -webkit-app-region: no-drag;
      }
      #callbox-toolbar .ndi-btn:hover { border-color: #ff6b35; }
      #callbox-toolbar .ndi-btn.active {
        background: #ff6b35;
        color: #fff;
        border-color: #ff6b35;
      }
      body { padding-top: 38px !important; }
    </style>
    <div class="device-group">
      <label>Mic</label>
      <select id="callbox-mic">
        ${mics.map(m => `<option value="${m.deviceId}" ${m.deviceId === preferredMicId ? 'selected' : ''}>${m.label || 'Microphone'}</option>`).join('')}
      </select>
    </div>
    <div class="device-group">
      <label>Speaker</label>
      <select id="callbox-speaker">
        ${speakers.map(s => `<option value="${s.deviceId}" ${s.deviceId === preferredSpeakerId ? 'selected' : ''}>${s.label || 'Speaker'}</option>`).join('')}
      </select>
    </div>
    <div class="device-group">
      <label>Vol</label>
      <input type="range" id="callbox-volume" min="0" max="100" value="${masterVolume}">
      <span class="vol-label" id="callbox-vol-label">${masterVolume}%</span>
    </div>
    <div class="device-group">
      <button id="callbox-ndi" class="ndi-btn">NDI OFF</button>
    </div>
  `;
  document.body.appendChild(toolbar);

  // Mic change
  document.getElementById('callbox-mic').addEventListener('change', (e) => {
    preferredMicId = e.target.value;
    ipcRenderer.send('set-preferred-mic', preferredMicId);
  });

  // Speaker change
  document.getElementById('callbox-speaker').addEventListener('change', async (e) => {
    preferredSpeakerId = e.target.value;
    ipcRenderer.send('set-preferred-speaker', preferredSpeakerId);
    document.querySelectorAll('audio, video').forEach(el => {
      if (el.setSinkId) el.setSinkId(preferredSpeakerId).catch(() => {});
    });
  });

  // Volume change
  document.getElementById('callbox-volume').addEventListener('input', (e) => {
    masterVolume = parseInt(e.target.value);
    document.getElementById('callbox-vol-label').textContent = masterVolume + '%';
    ipcRenderer.send('set-master-volume', masterVolume);
    applyMasterVolume();
    // Also update NDI audio volume in main world
    window.postMessage({ type: 'callbox-volume-change', volume: masterVolume }, '*');
  });

  // NDI toggle
  const ndiButton = document.getElementById('callbox-ndi');

  // Set initial NDI button state based on saved preference
  if (savedNdiEnabled) {
    ndiButton.classList.add('active');
    ndiButton.textContent = 'NDI ON';
    ndiEnabled = true;
  }

  ndiButton.addEventListener('click', async () => {
    log('NDI button clicked');
    try {
      if (ndiButton.classList.contains('active')) {
        // Stop NDI
        log('Stopping NDI...');
        await ipcRenderer.invoke('ndi-stop');
        ndiEnabled = false;
        // Tell main world to stop capturing
        window.postMessage({ type: 'callbox-ndi-enable', enabled: false }, '*');
        ndiButton.classList.remove('active');
        ndiButton.textContent = 'NDI OFF';
        log('NDI stopped');
      } else {
        // Start NDI sender
        log('Starting NDI...');
        const success = await ipcRenderer.invoke('ndi-start');
        log('ndi-start returned: ' + success);
        if (success) {
          ndiEnabled = true;
          ndiButton.classList.add('active');
          ndiButton.textContent = 'NDI ON';
          // Tell main world to start capturing WebRTC audio
          log('Enabling NDI capture in main world...');
          window.postMessage({ type: 'callbox-ndi-enable', enabled: true }, '*');
          // Sync current volume to main world
          window.postMessage({ type: 'callbox-volume-change', volume: masterVolume }, '*');
          log('NDI fully started');
        }
      }
    } catch (err) {
      logError('NDI toggle error: ' + err.message);
    }
  });

  // Watch for new audio/video elements (for speaker output and volume)
  log('Setting up MutationObserver...');
  const observer = new MutationObserver(() => {
    document.querySelectorAll('audio, video').forEach(el => {
      if (!el.dataset.callboxInit) {
        if (preferredSpeakerId && el.setSinkId) {
          el.setSinkId(preferredSpeakerId).catch(() => {});
        }
        el.volume = masterVolume / 100;
        el.dataset.callboxInit = 'true';
      }
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  log('MutationObserver started');
  log('Toolbar injection complete');
  } catch (err) {
    logError('DOMContentLoaded error: ' + err.message + '\n' + err.stack);
  }
});

} // end initPreload()
