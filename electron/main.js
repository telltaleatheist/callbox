const { app, BrowserWindow, session, ipcMain, shell, desktopCapturer, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const ndiSender = require('./ndi-sender');

// Secure credential storage - supports multiple accounts
const credentialsPath = path.join(app.getPath('userData'), 'accounts.enc');
let selectedAccountEmail = null; // Currently selected account for auto-login

// Log file setup
const logPath = path.join(app.getPath('userData'), 'callbox.log');
function writeLog(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  fs.appendFileSync(logPath, line);
  console.log(msg);
}
writeLog('=== CallBox started ===');
writeLog('Log file: ' + logPath);

const store = new Store({
  name: 'callbox-preferences',
  defaults: {
    microphoneId: null,
    speakerId: null,
    masterVolume: 100,
    ndiEnabled: false,
    windowBounds: { width: 1400, height: 900 }
  }
});

let mainWindow;
let setupWindow;

// Credential management functions - supports multiple accounts
function getAllAccounts() {
  if (!fs.existsSync(credentialsPath)) {
    return [];
  }

  try {
    const data = fs.readFileSync(credentialsPath);

    if (!safeStorage.isEncryptionAvailable()) {
      // Fallback: parse as JSON with base64 passwords
      const parsed = JSON.parse(data.toString());
      return parsed.map(acc => ({
        email: acc.email,
        password: Buffer.from(acc.password, 'base64').toString()
      }));
    }

    const decrypted = safeStorage.decryptString(data);
    return JSON.parse(decrypted);
  } catch (err) {
    writeLog('Failed to read accounts: ' + err.message);
    return [];
  }
}

function saveAllAccounts(accounts) {
  if (!safeStorage.isEncryptionAvailable()) {
    writeLog('WARNING: Encryption not available, storing with basic encoding');
    const data = JSON.stringify(accounts.map(acc => ({
      email: acc.email,
      password: Buffer.from(acc.password).toString('base64')
    })));
    fs.writeFileSync(credentialsPath, data);
    return;
  }

  const encrypted = safeStorage.encryptString(JSON.stringify(accounts));
  fs.writeFileSync(credentialsPath, encrypted);
  writeLog('Accounts saved securely');
}

function addAccount(email, password) {
  const accounts = getAllAccounts();
  // Remove existing account with same email if exists
  const filtered = accounts.filter(a => a.email !== email);
  filtered.push({ email, password });
  saveAllAccounts(filtered);
  writeLog('Account added: ' + email);
}

function removeAccount(email) {
  const accounts = getAllAccounts();
  const filtered = accounts.filter(a => a.email !== email);
  saveAllAccounts(filtered);
  writeLog('Account removed: ' + email);
}

function getCredentials() {
  // Return the selected account credentials
  if (!selectedAccountEmail) {
    return null;
  }
  const accounts = getAllAccounts();
  return accounts.find(a => a.email === selectedAccountEmail) || null;
}

function hasAccounts() {
  return getAllAccounts().length > 0;
}

function clearAllAccounts() {
  if (fs.existsSync(credentialsPath)) {
    fs.unlinkSync(credentialsPath);
    writeLog('All accounts cleared');
  }
}

// Setup window for first-time credential entry
function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 450,
    height: 550,
    resizable: false,
    frame: false,
    transparent: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  setupWindow.loadFile(path.join(__dirname, 'setup.html'));

  setupWindow.on('closed', () => {
    setupWindow = null;
    // If setup was closed without selecting an account, quit the app
    if (!mainWindow) {
      app.quit();
    }
  });
}

function createWindow() {
  const bounds = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Auto-allow audio/video permissions
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Load callinstudio.com directly
  mainWindow.loadURL('https://callinstudio.com');

  // Handle new window requests - allow webrtc to open in new window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    writeLog('[Main] Window open requested: ' + url);

    // WebRTC page - load in same window
    if (url.includes('/hostcenter/webrtc/')) {
      console.log('[Main] Loading webrtc page');
      mainWindow.loadURL(url);
      return { action: 'deny' };
    }

    // Other URLs load in same window
    mainWindow.loadURL(url);
    return { action: 'deny' };
  });

  // Also handle navigation
  mainWindow.webContents.on('will-navigate', (event, url) => {
    console.log('[Main] Navigation:', url);
  });

  // Save window size
  mainWindow.on('resize', () => {
    const { width, height } = mainWindow.getBounds();
    store.set('windowBounds', { width, height });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Log renderer crashes
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.log('[Main] Renderer crashed:', JSON.stringify(details));
  });

  mainWindow.webContents.on('crashed', (event) => {
    console.log('[Main] WebContents crashed');
  });
}

// IPC for logging from renderer
ipcMain.on('log', (e, msg) => writeLog('[Renderer] ' + msg));
ipcMain.on('log-error', (e, msg) => writeLog('[Renderer ERROR] ' + msg));

// IPC for credentials/accounts
ipcMain.handle('get-accounts', () => {
  // Return list of accounts (emails only, no passwords)
  return getAllAccounts().map(a => ({ email: a.email }));
});

ipcMain.handle('add-account', async (e, { email, password }) => {
  addAccount(email, password);
  return true;
});

ipcMain.handle('remove-account', async (e, email) => {
  removeAccount(email);
  return true;
});

ipcMain.handle('select-account', async (e, email) => {
  selectedAccountEmail = email;
  writeLog('Selected account: ' + email);
  // Close setup window and open main window
  if (setupWindow) {
    setupWindow.close();
  }
  createWindow();
  return true;
});

ipcMain.handle('get-credentials', () => {
  return getCredentials();
});

ipcMain.handle('clear-all-accounts', () => {
  clearAllAccounts();
  return true;
});

// IPC for device preferences
ipcMain.handle('get-preferred-mic', () => store.get('microphoneId'));
ipcMain.handle('get-preferred-speaker', () => store.get('speakerId'));
ipcMain.handle('get-master-volume', () => store.get('masterVolume'));
ipcMain.handle('get-ndi-enabled', () => store.get('ndiEnabled'));
ipcMain.on('set-preferred-mic', (e, id) => store.set('microphoneId', id));
ipcMain.on('set-preferred-speaker', (e, id) => store.set('speakerId', id));
ipcMain.on('set-master-volume', (e, vol) => store.set('masterVolume', vol));

// IPC for desktop capture sources
ipcMain.handle('get-capture-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window'] });
  return sources.map(s => ({ id: s.id, name: s.name }));
});

// IPC for NDI
ipcMain.handle('ndi-start', async () => {
  const success = await ndiSender.start('CallBox Audio');
  if (success) store.set('ndiEnabled', true);
  return success;
});

ipcMain.handle('ndi-stop', () => {
  ndiSender.stop();
  store.set('ndiEnabled', false);
  return true;
});

ipcMain.handle('ndi-status', () => ndiSender.getStatus());

// High-frequency audio data - use 'on' not 'handle' for performance
ipcMain.on('ndi-audio', (e, audioData) => {
  // audioData is { samples: Float32Array, sampleRate: number, channels: number }
  if (audioData && audioData.samples) {
    ndiSender.sendAudio(
      new Float32Array(audioData.samples),
      audioData.sampleRate,
      audioData.channels
    );
  }
});

app.whenReady().then(() => {
  // Always show setup/account selection window at startup
  createSetupWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
