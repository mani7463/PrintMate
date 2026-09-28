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

// Initialize on DOM ready or immediate if already loaded
function startKiosk() {
  initClock();
  initSocket();
  initPrinters();
  initNetwork();
  initNewSession();
  bindUIEvents();
  bindSessionRefresh();
  bindDiagnostics();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startKiosk);
} else {
  startKiosk();
}

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
  socket = io(API_BASE, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1500
  });

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
    console.log('📄 Files uploaded to session:', data.files?.length || 1);
    sounds.fileUploaded();
    displayDocumentInfo(data.file, data.files, data.totalPages);
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

  // Security countdown
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

// Refresh Session Button Binding
function bindSessionRefresh() {
  const refreshBtns = [
    document.getElementById('btn-refresh-session'),
    document.getElementById('btn-qr-refresh-sub')
  ].filter(Boolean);

  refreshBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.classList.add('spinning');
      await refreshKioskSession();
      setTimeout(() => btn.classList.remove('spinning'), 600);
    });
  });
}

// Manually trigger a fresh session and new QR code immediately
async function refreshKioskSession() {
  try {
    const payload = {
      sessionId: currentSessionId,
      frontendUrl: window.location.origin,
      ...(networkHost ? { host: networkHost } : {})
    };
    const res = await fetch(`${API_BASE}/api/session/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    applySessionData(data);
    console.log('🔄 Session manually refreshed. New QR & PIN active.');
  } catch (err) {
    console.warn('Manual refresh fallback to initNewSession:', err.message);
    initNewSession();
  }
}

// Create New Session (Live Session UUID & QR)
async function initNewSession(customHost = null) {
  try {
    const payload = {
      frontendUrl: window.location.origin,
      ...(customHost ? { host: customHost } : (networkHost ? { host: networkHost } : {}))
    };
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
    const urlText = document.getElementById('session-url-text');
    if (urlText) urlText.textContent = 'Error generating QR. Please reload.';
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
let currentSessionFiles = [];
let currentSessionTotalPages = 1;

function displayDocumentInfo(file, files = null, totalPages = null) {
  const docName = document.getElementById('doc-name');
  const multiContainer = document.getElementById('doc-multi-container');
  const multiCount = document.getElementById('doc-multi-count');
  const multiChips = document.getElementById('doc-multi-chips');
  const filesPill = document.getElementById('doc-files-pill');
  const pagesPill = document.getElementById('doc-pages-pill');

  const fileList = (Array.isArray(files) && files.length > 0) ? files : (file ? [file] : []);
  currentSessionFiles = fileList;

  const computedTotalPages = totalPages || fileList.reduce((acc, f) => acc + (f.pageCount || 1), 0);
  currentSessionTotalPages = computedTotalPages;

  if (fileList.length > 1) {
    if (docName) docName.textContent = `${fileList.length} Documents Ready to Print`;
    if (multiContainer) multiContainer.style.display = 'block';
    if (multiCount) multiCount.textContent = `${fileList.length} Documents Uploaded (${computedTotalPages} Total Pages)`;
    if (multiChips) {
      multiChips.innerHTML = fileList.map(f => `
        <div class="doc-chip" title="${escapeHtml(f.originalName)}">
          <span class="doc-chip-name">${escapeHtml(f.originalName)}</span>
          <span class="doc-chip-pg">${f.pageCount || 1}p</span>
        </div>
      `).join('');
    }
    if (filesPill) {
      filesPill.style.display = 'inline-block';
      filesPill.textContent = `${fileList.length} Files`;
    }
  } else if (fileList.length === 1) {
    const singleFile = fileList[0];
    if (docName) docName.textContent = singleFile.originalName;
    if (multiContainer) multiContainer.style.display = 'none';
    if (filesPill) filesPill.style.display = 'none';
  }

  if (pagesPill) {
    pagesPill.textContent = `${computedTotalPages} ${computedTotalPages > 1 ? 'Pages' : 'Page'}`;
  }
}

function updateDynamicCostAndSettings(settings) {
  if (!settings) return;
  const pages = settings.pageCount || currentSessionTotalPages || 1;
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

// Dedicated Printer Diagnostics & Real Hardware Drivers Modal
let activeDriverProfiles = [];

function bindDiagnostics() {
  const modal = document.getElementById('diagnostics-modal');
  const openBtn = document.getElementById('btn-open-diagnostics');
  const closeBtn = document.getElementById('btn-close-diagnostics');

  openBtn.addEventListener('click', () => {
    fetchHardwareStatus();
    fetchDriverDiagnostics();
    modal.classList.add('open');
  });

  const hwIndicator = document.getElementById('kiosk-hw-indicator');
  if (hwIndicator) {
    hwIndicator.addEventListener('click', () => {
      fetchHardwareStatus();
      fetchDriverDiagnostics();
      modal.classList.add('open');
    });
  }

  closeBtn.addEventListener('click', () => {
    modal.classList.remove('open');
  });

  // Re-query device drivers button inside diagnostics
  const refreshDriversBtn = document.getElementById('btn-diag-refresh-drivers');
  if (refreshDriversBtn) {
    refreshDriversBtn.addEventListener('click', async () => {
      refreshDriversBtn.textContent = 'Querying...';
      await fetchDriverDiagnostics();
      setTimeout(() => {
        refreshDriversBtn.textContent = '🔄 Re-query Drivers';
      }, 500);
    });
  }

  // Device profile selector change
  const driverSelect = document.getElementById('diag-driver-select');
  if (driverSelect) {
    driverSelect.addEventListener('change', () => {
      const selectedName = driverSelect.value;
      const profile = activeDriverProfiles.find(d => d.name === selectedName);
      if (profile) {
        displayDriverSpecifications(profile);
      }
    });
  }

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

async function fetchDriverDiagnostics() {
  try {
    const res = await fetch(`${API_BASE}/api/printers/diagnostics`);
    const data = await res.json();
    if (data.success && data.drivers) {
      activeDriverProfiles = data.drivers;
      populateDriverSelect(data.drivers, data.selectedPrinter);
    }
  } catch (err) {
    console.warn('Driver diagnostics query warning:', err);
  }
}

function populateDriverSelect(drivers, selectedName = null) {
  const select = document.getElementById('diag-driver-select');
  if (!select) return;

  select.innerHTML = '';
  if (!Array.isArray(drivers) || drivers.length === 0) {
    const noOpt = document.createElement('option');
    noOpt.value = '__none__';
    noOpt.textContent = '⚠️ No Printers Detected (Connect USB/Wi-Fi)';
    noOpt.selected = true;
    select.appendChild(noOpt);
    displayDriverSpecifications(null);
    return;
  }

  const physicalPrinters = drivers.filter(d => d.isPhysical);
  const virtualPrinters = drivers.filter(d => !d.isPhysical);

  if (physicalPrinters.length > 0) {
    const physGroup = document.createElement('optgroup');
    physGroup.label = 'Physical Hardware Printers (Active)';
    physicalPrinters.forEach((drv) => {
      const opt = document.createElement('option');
      opt.value = drv.name;
      opt.textContent = `🖨️ ${drv.name} [${drv.status || 'Ready'}]`;
      if (selectedName ? drv.name === selectedName : drv.isDefault) {
        opt.selected = true;
      }
      physGroup.appendChild(opt);
    });
    select.appendChild(physGroup);
  } else {
    const noOpt = document.createElement('option');
    noOpt.value = '__none__';
    noOpt.textContent = '⚠️ No Physical Printer Connected (Connect USB/Wi-Fi)';
    if (!selectedName || !virtualPrinters.some(v => v.name === selectedName)) {
      noOpt.selected = true;
    }
    select.appendChild(noOpt);
  }

  if (virtualPrinters.length > 0) {
    const virtGroup = document.createElement('optgroup');
    virtGroup.label = 'Software / Virtual Queues (Document Output)';
    virtualPrinters.forEach((drv) => {
      const opt = document.createElement('option');
      opt.value = drv.name;
      opt.textContent = `📄 ${drv.name} [Virtual Queue]`;
      if (selectedName && drv.name === selectedName) {
        opt.selected = true;
      }
      virtGroup.appendChild(opt);
    });
    select.appendChild(virtGroup);
  }

  // Handle user changing active device
  select.onchange = async () => {
    if (select.value === '__none__') {
      displayDriverSpecifications(null);
      return;
    }
    const chosen = drivers.find(d => d.name === select.value);
    if (chosen) {
      displayDriverSpecifications(chosen);
      try {
        await fetch(`${API_BASE}/api/hardware/select-printer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ printerName: chosen.name })
        });
      } catch (_) {}
    }
  };

  const active = drivers.find(d => d.name === select.value) || (physicalPrinters[0] || (select.value === '__none__' ? null : virtualPrinters[0]));
  displayDriverSpecifications(active);
}

function displayDriverSpecifications(drv) {
  const setEl = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val || '-';
  };

  const statusEl = document.getElementById('spec-driver-status');

  if (!drv || drv.name === '__none__') {
    setEl('spec-driver-name', 'None Detected');
    setEl('spec-driver-ver', 'N/A');
    setEl('spec-driver-mfr', 'No Hardware Connected');
    setEl('spec-driver-port', 'Disconnected');
    if (statusEl) {
      statusEl.textContent = 'Disconnected / Offline';
      statusEl.className = 'badge-offline';
    }
    setEl('spec-driver-color', 'N/A');
    setEl('spec-driver-duplex', 'N/A');
    setEl('spec-driver-paper', 'N/A');
    setEl('spec-driver-spool', 'Idle (0 active jobs)');
    setEl('spec-driver-collate', 'N/A');
    return;
  }

  setEl('spec-driver-name', drv.driverName || drv.name);
  setEl('spec-driver-ver', drv.driverVersion || 'v4');
  setEl('spec-driver-mfr', drv.manufacturer || (drv.isPhysical ? 'OEM Hardware' : 'Microsoft / Virtual Software'));
  setEl('spec-driver-port', drv.portName || drv.port || (drv.isPhysical ? 'USB Port' : 'Software Queue'));

  if (statusEl) {
    if (drv.isPhysical) {
      statusEl.textContent = drv.status || 'Ready';
      statusEl.className = 'badge-success';
    } else {
      statusEl.textContent = 'Virtual / Software Destination';
      statusEl.className = 'badge-virtual';
    }
  }

  setEl('spec-driver-color', drv.color ? 'Full Color (CMYK/RGB)' : 'Monochrome (B&W Only)');
  setEl('spec-driver-duplex', drv.duplex || '1-Sided / 2-Sided');
  setEl('spec-driver-paper', drv.paperSize || 'A4 Standard (210×297mm)');
  setEl('spec-driver-spool', `${drv.printProcessor || 'winprint'} (${drv.jobCount || 0} active jobs)`);
  setEl('spec-driver-collate', drv.collate ? 'Hardware Supported' : 'Software Fallback');
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

  // Header status indicator dot & label
  const hwDot = document.getElementById('hw-indicator-dot');
  const hwText = document.getElementById('hw-indicator-text');
  if (hwDot && hwText) {
    if (hw.physicalPrinterConnected) {
      hwDot.className = 'hw-dot online';
      hwText.textContent = `Printer Ready (${hw.selectedPrinter || 'USB'})`;
    } else if (hw.driverSettings && hw.driverSettings.some(d => !d.isPhysical)) {
      hwDot.className = 'hw-dot virtual';
      hwText.textContent = 'Software / Virtual Mode';
    } else {
      hwDot.className = 'hw-dot offline';
      hwText.textContent = 'Printer Disconnected';
    }
  }

  // Driver Settings
  if (hw.driverSettings) {
    activeDriverProfiles = hw.driverSettings;
    populateDriverSelect(hw.driverSettings, hw.selectedPrinter);
  }

  // Connectivity
  if (hw.connection) {
    const usbEl = document.getElementById('diag-usb-status');
    if (usbEl) {
      usbEl.textContent = hw.connection.usbStatus || 'Disconnected (No USB Printer Plugged In)';
      usbEl.className = hw.physicalPrinterConnected ? 'badge-success' : 'badge-offline';
    }

    const wifiEl = document.getElementById('diag-wifi-status');
    if (wifiEl) {
      wifiEl.textContent = hw.connection.wifiStatus || 'No Network Printer Detected';
      wifiEl.className = (hw.physicalPrinterConnected && !hw.connection.usbStatus.includes('USB')) 
        ? 'badge-success' 
        : (hw.connection.wifiStatus && hw.connection.wifiStatus.includes('Online') ? 'badge-warning' : 'badge-offline');
    }
  }

  // Spooler
  if (hw.spooler) {
    const spoolerEl = document.getElementById('diag-spooler-status');
    if (spoolerEl) {
      spoolerEl.textContent = `${hw.spooler.system} (${hw.spooler.queueJobs || 0} active jobs)`;
    }
  }

  // Paper Trays & Offline Alert
  const suppliesNotice = document.getElementById('diag-supplies-offline-notice');
  const suppliesContainer = document.getElementById('diag-supplies-container');
  const tonerNotice = document.getElementById('diag-toner-offline-notice');
  const tonerGrid = document.getElementById('diag-toner-grid');

  if (hw.hasPhysicalSupplies) {
    if (suppliesNotice) suppliesNotice.style.display = 'none';
    if (suppliesContainer) suppliesContainer.style.display = 'block';
    if (tonerNotice) tonerNotice.style.display = 'none';
    if (tonerGrid) tonerGrid.style.opacity = '1';

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
  } else {
    // Offline state: hide fake supplies and show truthful notices
    if (suppliesNotice) suppliesNotice.style.display = 'block';
    if (suppliesContainer) suppliesContainer.style.display = 'none';
    if (tonerNotice) tonerNotice.style.display = 'block';
    if (tonerGrid) tonerGrid.style.opacity = '0.35';

    document.getElementById('diag-tray1-val').textContent = 'Offline (0 / 500)';
    document.getElementById('diag-tray1-fill').style.width = '0%';
    document.getElementById('diag-tray2-val').textContent = 'Offline (0 / 250)';
    document.getElementById('diag-tray2-fill').style.width = '0%';

    ['k', 'c', 'm', 'y'].forEach(c => {
      const bar = document.getElementById(`diag-toner-${c}`);
      const pct = document.getElementById(`diag-toner-${c}-pct`);
      if (bar) bar.style.height = '0%';
      if (pct) pct.textContent = '0%';
    });
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
