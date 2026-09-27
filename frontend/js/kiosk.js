/**
 * PrintMate Kiosk Client Controller - Minimal & Responsive
 * Changes implemented:
 * 1. QR code disappears immediately upon mobile scan, showing "Device Connected! Waiting for document upload... ⏳"
 * 2. Minimal public kiosk display without hardware clutter
 * 3. Dedicated "Printer Diagnostics" button & modal for USB / Wi-Fi status, paper trays, and ink
 * 4. Standard USB & Wi-Fi office/desktop printer support (non-thermal) with clean, minimal animations
 */

const API_BASE = (window.PRINTMATE_CONFIG && window.PRINTMATE_CONFIG.BACKEND_URL) ? window.PRINTMATE_CONFIG.BACKEND_URL : '';

let socket = null;
let currentSessionId = null;
let currentPin = null;
let currentMobileUrl = null;
let currentStage = 'WAITING_SCAN';
let soundEnabled = true;
let networkHost = null;

// Sound Synthesizer via Web Audio API
class SoundPlayer {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
  }

  playTone(freq, type = 'sine', duration = 0.2, gainVal = 0.15) {
    if (!soundEnabled) return;
    try {
      this.init();
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      gain.gain.setValueAtTime(gainVal, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch (e) {
      console.warn('Audio tone error:', e);
    }
  }

  deviceConnected() {
    this.playTone(523.25, 'sine', 0.15, 0.2); // C5
    setTimeout(() => this.playTone(659.25, 'sine', 0.25, 0.2), 120); // E5
  }

  fileUploaded() {
    this.playTone(587.33, 'triangle', 0.18, 0.2); // D5
    setTimeout(() => this.playTone(880.00, 'triangle', 0.25, 0.2), 140); // A5
  }

  paymentReceived() {
    this.playTone(659.25, 'sine', 0.12, 0.2); // E5
    setTimeout(() => this.playTone(783.99, 'sine', 0.12, 0.2), 100); // G5
    setTimeout(() => this.playTone(1046.50, 'sine', 0.3, 0.25), 200); // C6
  }

  printStarted() {
    this.playTone(440.00, 'sine', 0.15, 0.15);
    setTimeout(() => this.playTone(554.37, 'sine', 0.2, 0.15), 100);
  }

  printCompleted() {
    this.playTone(523.25, 'sine', 0.15, 0.25);
    setTimeout(() => this.playTone(659.25, 'sine', 0.15, 0.25), 100);
    setTimeout(() => this.playTone(1046.50, 'sine', 0.45, 0.25), 250);
  }
}

const sounds = new SoundPlayer();

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  initClock();
  initSocket();
  initPrinters();
  initNetwork();
  initNewSession();
  bindUIEvents();
  bindDiagnostics();
});

// Digital Clock (optional)
function initClock() {
  const clockEl = document.getElementById('clock-display');
  if (!clockEl) return;
  function updateClock() {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  updateClock();
  setInterval(updateClock, 1000);
}

// Socket Connection & Real-Time Synchronization
function initSocket() {
  socket = io(API_BASE);

  socket.on('connect', () => {
    console.log('⚡ Connected to PrintMate Server:', socket.id);
    if (currentSessionId) {
      socket.emit('join_session', { sessionId: currentSessionId, clientType: 'kiosk' });
    }
  });

  // Requirement 1: When QR gets scanned, QR disappears and display waits for upload
  socket.on('session:mobile_connected', (data) => {
    console.log('📱 Mobile device connected to session:', data.sessionId);
    sounds.deviceConnected();
    updateStage('CONNECTED');
  });

  socket.on('session:file_uploaded', (data) => {
    console.log('📄 File uploaded:', data.file.originalName);
    sounds.fileUploaded();
    displayDocumentInfo(data.file);
    updateStage('UPLOADED');
  });

  socket.on('session:preview_synced', (data) => {
    updateDynamicCostAndSettings(data);
  });

  socket.on('session:payment_success', (data) => {
    sounds.paymentReceived();
    updateStage('PAYMENT_CONFIRMED', data);
  });

  socket.on('session:print_started', (data) => {
    sounds.printStarted();
    updateStage('PRINTING', { settings: data.settings });
  });

  socket.on('session:print_progress', (data) => {
    updatePrintProgress(data.progress, data.message);
  });

  socket.on('session:print_completed', (data) => {
    sounds.printCompleted();
    updateStage('COMPLETED');
  });

  // Security 5-second countdown
  socket.on('session:security_countdown', (data) => {
    updateSecurityCountdown(data.remaining);
  });

  // When session is wiped and fresh session is emitted
  socket.on('session:wiped', () => {
    console.log('🛡️ Security wipe completed.');
  });

  socket.on('kiosk:fresh_session', (data) => {
    console.log('✨ Fresh session generated by server. Resetting kiosk display.');
    applySessionData(data);
  });

  socket.on('session:mobile_disconnected', () => {
    // If mobile disconnected while in CONNECTED stage (before file upload), restore QR code immediately
    if (currentStage === 'CONNECTED') {
      console.log('📱 Mobile disconnected early. Restoring QR code for next user.');
      updateStage('WAITING_SCAN');
    }
  });

  socket.on('hardware:status', (hw) => {
    updateDiagnosticsUI(hw);
  });

  socket.on('session:reset', () => {
    initNewSession();
  });
}

// Create New Session (Live Session UUID & QR)
async function initNewSession(customHost = null) {
  try {
    const payload = customHost ? { host: customHost } : (networkHost ? { host: networkHost } : {});
    const res = await fetch(`${API_BASE}/api/session/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    applySessionData(data);
  } catch (err) {
    console.error('Failed to create session:', err);
    document.getElementById('session-url-text').textContent = 'Error generating QR. Please reload.';
  }
}

function applySessionData(data) {
  currentSessionId = data.sessionId;
  currentPin = data.pin || data.session?.pin || 'PM-XXXX';
  currentMobileUrl = data.mobileUrl;

  const qrImg = document.getElementById('qr-image');
  if (qrImg) qrImg.src = data.qrDataUrl;

  const pinEl = document.getElementById('session-pin-display');
  if (pinEl) pinEl.textContent = `PIN: ${currentPin}`;

  if (socket && socket.connected) {
    socket.emit('join_session', { sessionId: currentSessionId, clientType: 'kiosk' });
  }

  updateStage('WAITING_SCAN');
  resetProgressBar();
}

// Stage State Machine & Visuals - Minimal Viewport
function updateStage(stage, extra = {}) {
  currentStage = stage;
  const states = ['state-scan', 'state-connected', 'state-uploaded', 'state-printing', 'state-completed'];
  states.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  if (stage === 'WAITING_SCAN') {
    document.getElementById('state-scan').style.display = 'flex';
  } else if (stage === 'CONNECTED') {
    // When mobile connects, QR disappears immediately!
    document.getElementById('state-connected').style.display = 'flex';
  } else if (stage === 'UPLOADED') {
    document.getElementById('state-uploaded').style.display = 'flex';
  } else if (stage === 'PAYMENT_CONFIRMED' || stage === 'PRINTING') {
    document.getElementById('state-printing').style.display = 'flex';
  } else if (stage === 'COMPLETED') {
    document.getElementById('state-completed').style.display = 'flex';
    updatePrintProgress(100, 'Print complete! Ready in paper tray.');
  }
}

// Document Info & Dynamic Pricing Sync
function displayDocumentInfo(file) {
  const docName = document.getElementById('doc-name');
  if (docName) docName.textContent = file.originalName;
  const pagesPill = document.getElementById('doc-pages-pill');
  if (pagesPill) pagesPill.textContent = `${file.pageCount || 1} ${file.pageCount > 1 ? 'Pages' : 'Page'}`;
}

function updateDynamicCostAndSettings(settings) {
  if (!settings) return;
  const pages = settings.pageCount || 1;
  const copies = settings.copies || 1;
  const isColor = settings.colorMode === 'color';
  const isA3 = settings.paperSize === 'A3';

  let ratePerPage = isColor ? (isA3 ? 15 : 10) : (isA3 ? 4 : 2);
  let totalCost = pages * copies * ratePerPage;

  const pagesPill = document.getElementById('doc-pages-pill');
  if (pagesPill) pagesPill.textContent = `${pages} ${pages > 1 ? 'Pages' : 'Page'}`;
  
  const copiesPill = document.getElementById('doc-copies-pill');
  if (copiesPill) copiesPill.textContent = `${copies} ${copies > 1 ? 'Copies' : 'Copy'}`;

  const colorPill = document.getElementById('doc-color-pill');
  if (colorPill) colorPill.textContent = isColor ? 'Color' : 'B&W';

  const totalCostEl = document.getElementById('doc-total-cost');
  if (totalCostEl) totalCostEl.textContent = `₹${totalCost.toFixed(2)}`;
}

// Standard Print Progress
function updatePrintProgress(percent, message) {
  const bar = document.getElementById('progress-bar');
  if (bar) bar.style.width = `${percent}%`;
  const pct = document.getElementById('progress-percent');
  if (pct) pct.textContent = `${percent}%`;
  if (message) {
    const statusText = document.getElementById('progress-status-text');
    if (statusText) statusText.textContent = message;
  }
}

function resetProgressBar() {
  const bar = document.getElementById('progress-bar');
  if (bar) bar.style.width = '0%';
  const pct = document.getElementById('progress-percent');
  if (pct) pct.textContent = '0%';
  const statusText = document.getElementById('progress-status-text');
  if (statusText) statusText.textContent = 'Sending document to printer...';
}

// Security Countdown
function updateSecurityCountdown(remaining) {
  const secondsEl = document.getElementById('wipe-countdown-seconds');
  if (secondsEl) secondsEl.textContent = Math.max(0, remaining);
}

// Requirement 4: Dedicated Printer Diagnostics Modal
function bindDiagnostics() {
  const modal = document.getElementById('diagnostics-modal');
  const openBtn = document.getElementById('btn-open-diagnostics');
  const closeBtn = document.getElementById('btn-close-diagnostics');

  openBtn.addEventListener('click', () => {
    fetchHardwareStatus();
    modal.classList.add('open');
  });

  closeBtn.addEventListener('click', () => {
    modal.classList.remove('open');
  });

  // Test Print button inside diagnostics
  document.getElementById('btn-diag-test-print').addEventListener('click', async () => {
    if (!currentSessionId) return;
    const res = await fetch(`${API_BASE}/api/session/${currentSessionId}/upload`, {
      method: 'POST',
      body: (() => {
        const formData = new FormData();
        const testBlob = new Blob(['PRINTMATE PRINTER ALIGNMENT TEST\nConnection: USB / Wi-Fi Active\nStatus: 100% Operational\n'], { type: 'text/plain' });
        formData.append('document', testBlob, 'Printer_Alignment_Test.txt');
        formData.append('pageCount', '1');
        return formData;
      })()
    });
    const uploadData = await res.json();
    if (uploadData.success) {
      fetch(`${API_BASE}/api/session/${currentSessionId}/print`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ copies: 1, colorMode: 'bw', paperSize: 'A4', simulation: true })
      });
      modal.classList.remove('open');
    }
  });

  // Refill supplies button inside diagnostics
  document.getElementById('btn-diag-refill').addEventListener('click', async () => {
    const res = await fetch(`${API_BASE}/api/hardware/refill`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      updateDiagnosticsUI(data.hardware);
      alert('Paper trays and ink cartridges refilled successfully!');
    }
  });
}

async function fetchHardwareStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/hardware/status`);
    const data = await res.json();
    if (data.success && data.hardware) {
      updateDiagnosticsUI(data.hardware);
    }
  } catch (err) {
    console.warn('Diagnostics fetch error:', err);
  }
}

function updateDiagnosticsUI(hw) {
  if (!hw) return;

  // Connectivity
  if (hw.connection) {
    document.getElementById('diag-usb-status').textContent = hw.connection.usbStatus || 'Connected (USB001)';
    document.getElementById('diag-wifi-status').textContent = hw.connection.wifiStatus || 'Online (WLAN Link)';
  }

  // Spooler
  if (hw.spooler) {
    document.getElementById('diag-spooler-status').textContent = `${hw.spooler.system} (${hw.spooler.queueJobs} active jobs)`;
  }

  // Paper Trays
  if (hw.paperTrays) {
    const t1 = hw.paperTrays.tray1;
    const t2 = hw.paperTrays.tray2;
    if (t1) {
      document.getElementById('diag-tray1-val').textContent = `${t1.currentSheets} / ${t1.maxSheets} sheets`;
      document.getElementById('diag-tray1-fill').style.width = `${t1.percent}%`;
    }
    if (t2) {
      document.getElementById('diag-tray2-val').textContent = `${t2.currentSheets} / ${t2.maxSheets} sheets`;
      document.getElementById('diag-tray2-fill').style.width = `${t2.percent}%`;
    }
  }

  // Ink Cartridges
  if (hw.toner) {
    if (hw.toner.black) {
      document.getElementById('diag-toner-k').style.height = `${hw.toner.black.percent}%`;
      document.getElementById('diag-toner-k-pct').textContent = `${hw.toner.black.percent}%`;
    }
    if (hw.toner.cyan) {
      document.getElementById('diag-toner-c').style.height = `${hw.toner.cyan.percent}%`;
      document.getElementById('diag-toner-c-pct').textContent = `${hw.toner.cyan.percent}%`;
    }
    if (hw.toner.magenta) {
      document.getElementById('diag-toner-m').style.height = `${hw.toner.magenta.percent}%`;
      document.getElementById('diag-toner-m-pct').textContent = `${hw.toner.magenta.percent}%`;
    }
    if (hw.toner.yellow) {
      document.getElementById('diag-toner-y').style.height = `${hw.toner.yellow.percent}%`;
      document.getElementById('diag-toner-y-pct').textContent = `${hw.toner.yellow.percent}%`;
    }
  }
}

// Printers Discovery
async function initPrinters() {
  try {
    const res = await fetch('/api/printers');
    const data = await res.json();
    if (!data.success) return;

    const select = document.getElementById('printer-select');
    if (select) {
      select.innerHTML = '';
      data.printers.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = `${p.name} ${p.isDefault ? '★' : ''} [${p.status}]`;
        if (p.isDefault) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', () => {
        const activeEl = document.getElementById('active-printer-name');
        if (activeEl) activeEl.textContent = select.value;
      });
    }
  } catch (err) {
    console.warn('Printers query info:', err);
  }
}

// Network Discovery (optional / background)
async function initNetwork() {
  try {
    const res = await fetch('/api/network');
    const data = await res.json();
    const netEl = document.getElementById('network-ip-display');
    if (netEl) netEl.textContent = `${data.primaryIp}:${data.port}`;
  } catch (err) {
    console.warn('Network query info:', err);
  }
}

// Bind UI actions
function bindUIEvents() {
  const btnFullscreen = document.getElementById('btn-fullscreen');
  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => console.log(err));
      } else {
        document.exitFullscreen();
      }
    });
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
