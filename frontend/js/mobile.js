/**
 * PrintMate Customer Mobile Web App (Zero-Install)
 * Features:
 * - Multi-document client-side upload & inspection (PDF, Word, JPG, PNG)
 * - Accurate client-side page counting per document and aggregated totals
 * - Real-time print configuration: Color Mode (B&W ₹2/pg vs Color ₹10/pg), A4/A3, Duplex, Copies
 * - Real-time dynamic cost estimator based on total aggregated pages
 * - Seamless checkout (UPI / Card / Mock Gateway) triggering kiosk hardware dispatch
 * - Automatic session disconnect on job completion with clear kiosk new session guidance
 */

const API_BASE = (window.PRINTMATE_CONFIG && window.PRINTMATE_CONFIG.BACKEND_URL) ? window.PRINTMATE_CONFIG.BACKEND_URL : '';

let socket = null;
let sessionId = null;
let uploadedFiles = [];
let totalSessionPages = 0;
let currentTotalCost = 2.0;

// Print configuration state
const printSettings = {
  copies: 1,
  colorMode: 'bw', // 'bw' (₹2) or 'color' (₹10)
  paperSize: 'A4',  // 'A4' or 'A3'
  duplex: 'single', // 'single' or 'double'
  pageCount: 1,
  orientation: 'portrait'
};

function initApp() {
  extractSessionId();
  initSocket();
  bindDropzone();
  bindSettingsControls();
  bindPaymentModal();
  updateCostEstimator();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// Extract session ID from URL path (e.g. /kiosk/:sessionId or /session/:sessionId)
function extractSessionId() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  sessionId = parts[parts.length - 1] || 'DEMO';
  
  // Also check query parameter fallback ?session=XYZ
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('session')) {
    sessionId = urlParams.get('session');
  }

  const badge = document.getElementById('session-tag');
  if (badge) {
    badge.textContent = `PIN: ${sessionId.length > 8 ? sessionId.substring(0, 8) + '...' : sessionId}`;
  }
}

// Socket Connection & Real-Time Sync
function initSocket() {
  const bannerText = document.getElementById('banner-text');

  socket = io(API_BASE, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1500
  });

  socket.on('connect', () => {
    console.log('📱 Mobile linked with socket id:', socket.id);
    if (bannerText) bannerText.textContent = 'Hardware Synchronized. Ready for document upload.';
    socket.emit('join_session', { sessionId, clientType: 'mobile' });
  });

  socket.on('connect_error', () => {
    if (bannerText) bannerText.textContent = 'Connecting to PrintMate Cloud... Please wait.';
  });

  socket.on('session:state', (data) => {
    if (data.session) {
      if (Array.isArray(data.session.files) && data.session.files.length > 0) {
        uploadedFiles = data.session.files;
        totalSessionPages = data.session.totalPages || uploadedFiles.reduce((acc, f) => acc + (f.pageCount || 1), 0);
        renderFilesList();
        updateCostEstimator();
      } else if (data.session.file) {
        uploadedFiles = [data.session.file];
        totalSessionPages = data.session.file.pageCount || 1;
        renderFilesList();
        updateCostEstimator();
      }
    }
  });

  socket.on('session:print_started', () => {
    switchToTrackerView();
  });

  socket.on('session:print_progress', (data) => {
    switchToTrackerView();
    updateProgress(data.progress, data.message);
  });

  socket.on('session:print_completed', () => {
    handlePrintFinished();
  });

  socket.on('session:wiped', (data) => {
    handleSessionClosed(data?.message || 'Print job completed. Previous session closed for security.');
  });

  socket.on('session:disconnected_by_server', () => {
    handleSessionClosed('Previous session closed for security. Ready for next customer.');
  });

  socket.on('session:reset', () => {
    window.location.reload();
  });
}

function syncSettingsToKiosk() {
  if (socket && socket.connected) {
    socket.emit('client:preview_sync', {
      ...printSettings,
      pageCount: totalSessionPages || 1,
      estimatedCost: currentTotalCost,
      fileCount: uploadedFiles.length
    });
  }
}

// Multi-File Upload & Client-Side Page Counting
function bindDropzone() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const clearAllBtn = document.getElementById('btn-clear-all');

  ['dragenter', 'dragover'].forEach(name => {
    dropzone.addEventListener(name, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    dropzone.addEventListener(name, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      inspectAndUploadFilesBatch(files);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      inspectAndUploadFilesBatch(Array.from(e.target.files));
      fileInput.value = '';
    }
  });

  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', async () => {
      if (confirm('Remove all uploaded documents?')) {
        for (const f of [...uploadedFiles]) {
          await removeFileFromSession(f.id || f.filename);
        }
      }
    });
  }
}

// Inspect page counts of multiple files and upload in batch
async function inspectAndUploadFilesBatch(files) {
  const bannerText = document.getElementById('banner-text');
  if (bannerText) bannerText.textContent = `Analyzing ${files.length} document(s)... ⏳`;

  const filesWithPages = [];
  for (const file of files) {
    let pageCount = 1;
    try {
      if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
        pageCount = await countPdfPages(file);
      } else if (file.type.startsWith('image/')) {
        pageCount = 1;
      } else if (file.name.match(/\.(docx?|txt)$/i)) {
        pageCount = await estimateTextOrDocxPages(file);
      }
    } catch (_) {
      pageCount = 1;
    }
    filesWithPages.push({ file, pageCount });
  }

  // Upload to backend
  const formData = new FormData();
  filesWithPages.forEach(item => {
    formData.append('documents', item.file);
  });
  formData.append('pageCounts', JSON.stringify(filesWithPages.map(i => i.pageCount)));

  if (bannerText) bannerText.textContent = `Uploading ${files.length} document(s) to secure kiosk buffer... ⏳`;

  try {
    const res = await fetch(`${API_BASE}/api/session/${sessionId}/upload`, {
      method: 'POST',
      body: formData
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Upload failed');

    uploadedFiles = data.files || [];
    totalSessionPages = data.totalPages || uploadedFiles.reduce((acc, f) => acc + (f.pageCount || 1), 0);

    renderFilesList();
    updateCostEstimator();
    syncSettingsToKiosk();

    if (bannerText) bannerText.textContent = `✅ ${uploadedFiles.length} document(s) ready. Configure & proceed to pay.`;
  } catch (err) {
    console.error('Batch upload error:', err);
    if (bannerText) bannerText.textContent = `❌ Upload failed: ${err.message}. Tap to retry.`;
    alert('Upload failed: ' + err.message);
  }
}

// Fast Client-Side PDF Page Counting
function countPdfPages(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async function() {
      const buffer = reader.result;

      if (window.pdfjsLib) {
        try {
          const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
          return resolve(pdf.numPages || 1);
        } catch (_) {}
      }

      // Fast binary fallback
      try {
        const text = new TextDecoder('latin1').decode(new Uint8Array(buffer));
        const matches = text.match(/\/Type\s*\/Page[^s]/g);
        let count = matches ? matches.length : 1;
        const countMatch = text.match(/\/Count\s+(\d+)/);
        if (countMatch && parseInt(countMatch[1], 10) > count) {
          count = parseInt(countMatch[1], 10);
        }
        resolve(Math.max(1, count));
      } catch (_) {
        resolve(1);
      }
    };
    reader.onerror = () => resolve(1);
    reader.readAsArrayBuffer(file);
  });
}

function estimateTextOrDocxPages(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = function() {
      const text = reader.result;
      const wordCount = (typeof text === 'string') ? text.split(/\s+/).length : Math.ceil(file.size / 1000);
      const pages = Math.max(1, Math.ceil(wordCount / 400));
      resolve(pages);
    };
    reader.onerror = () => resolve(1);
    if (file.name.endsWith('.txt')) {
      reader.readAsText(file);
    } else {
      resolve(Math.max(1, Math.ceil(file.size / 40000)));
    }
  });
}

// Remove an individual file from the multi-document list
async function removeFileFromSession(fileId) {
  try {
    const res = await fetch(`${API_BASE}/api/session/${sessionId}/file/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId })
    });
    const data = await res.json();
    if (data.success) {
      uploadedFiles = data.files || [];
      totalSessionPages = data.totalPages || uploadedFiles.reduce((acc, f) => acc + (f.pageCount || 1), 0);
      renderFilesList();
      updateCostEstimator();
      syncSettingsToKiosk();
    }
  } catch (err) {
    console.warn('Remove file error:', err);
  }
}

// Render multi-document file cards in the UI
function renderFilesList() {
  const dropzone = document.getElementById('dropzone');
  const container = document.getElementById('files-container');
  const listEl = document.getElementById('files-list');
  const countBadge = document.getElementById('files-count-badge');
  const totalPagesBadge = document.getElementById('files-total-pages');
  const payBtn = document.getElementById('btn-open-payment');

  if (uploadedFiles.length === 0) {
    dropzone.style.display = 'block';
    container.style.display = 'none';
    if (payBtn) payBtn.disabled = true;
    return;
  }

  dropzone.style.display = 'none';
  container.style.display = 'flex';
  if (payBtn) payBtn.disabled = false;

  countBadge.textContent = `${uploadedFiles.length} ${uploadedFiles.length > 1 ? 'Documents' : 'Document'}`;
  totalPagesBadge.textContent = `${totalSessionPages} ${totalSessionPages > 1 ? 'Total Pages' : 'Page'}`;

  listEl.innerHTML = uploadedFiles.map((file) => `
    <div class="file-item-row" data-id="${file.id || file.filename}">
      <div class="file-item-left">
        <div class="file-item-icon">
          <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <div class="file-item-details">
          <div class="file-item-name" title="${escapeHtml(file.originalName)}">${escapeHtml(file.originalName)}</div>
          <div class="file-item-sub">
            <span>${formatBytes(file.size || 0)}</span>
            <span>•</span>
            <span class="page-tag">${file.pageCount || 1} ${file.pageCount > 1 ? 'Pages' : 'Page'}</span>
          </div>
        </div>
      </div>
      <button class="btn-file-del" data-action="delete" title="Remove document">✕</button>
    </div>
  `).join('');

  // Bind delete handlers
  listEl.querySelectorAll('[data-action="delete"]').forEach((btn, index) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetFile = uploadedFiles[index];
      if (targetFile) {
        removeFileFromSession(targetFile.id || targetFile.filename);
      }
    });
  });
}

// Print Configuration Controls
function bindSettingsControls() {
  // Copies stepper
  const copiesVal = document.getElementById('copies-val');
  document.getElementById('btn-copies-minus').addEventListener('click', () => {
    if (printSettings.copies > 1) {
      printSettings.copies--;
      copiesVal.textContent = printSettings.copies;
      updateCostEstimator();
      syncSettingsToKiosk();
    }
  });

  document.getElementById('btn-copies-plus').addEventListener('click', () => {
    if (printSettings.copies < 50) {
      printSettings.copies++;
      copiesVal.textContent = printSettings.copies;
      updateCostEstimator();
      syncSettingsToKiosk();
    }
  });

  // Color mode: B&W (₹2) vs Color (₹10)
  const colorBtns = [document.getElementById('btn-color-bw'), document.getElementById('btn-color-full')];
  colorBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      colorBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      printSettings.colorMode = btn.dataset.color;
      updateCostEstimator();
      syncSettingsToKiosk();
    });
  });

  // Paper Size: A4 vs A3
  const paperBtns = document.querySelectorAll('[data-paper]');
  paperBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      paperBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      printSettings.paperSize = btn.dataset.paper;
      updateCostEstimator();
      syncSettingsToKiosk();
    });
  });

  // Duplex: Single vs Double
  const duplexBtns = document.querySelectorAll('[data-duplex]');
  duplexBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      duplexBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      printSettings.duplex = btn.dataset.duplex;
      updateCostEstimator();
      syncSettingsToKiosk();
    });
  });
}

// Dynamic Cost Estimator
function updateCostEstimator() {
  const pages = totalSessionPages || 1;
  const copies = printSettings.copies || 1;
  const isColor = printSettings.colorMode === 'color';
  const isA3 = printSettings.paperSize === 'A3';
  const isDuplex = printSettings.duplex === 'double';

  let ratePerPage = isColor ? (isA3 ? 15 : 10) : (isA3 ? 4 : 2);
  let total = pages * copies * ratePerPage;
  currentTotalCost = total;

  const formattedCost = `₹${total.toFixed(2)}`;

  document.getElementById('cost-total-display').textContent = formattedCost;
  document.getElementById('cost-final-amount').textContent = formattedCost;
  document.getElementById('cost-subtotal-val').textContent = formattedCost;

  const docsLabel = uploadedFiles.length > 1 ? ` (${uploadedFiles.length} Docs)` : '';
  document.getElementById('cost-pages-detail').textContent = 
    `${pages} ${pages > 1 ? 'Pages' : 'Page'}${docsLabel} × ${copies} ${copies > 1 ? 'Copies' : 'Copy'} ${isDuplex ? '(2-Sided)' : ''}`;

  document.getElementById('cost-rate-detail').textContent = 
    `${isColor ? 'Color' : 'B&W'} ${isA3 ? 'A3' : 'A4'} @ ₹${ratePerPage}/pg`;

  const btnPayText = document.getElementById('btn-pay-text');
  if (btnPayText) {
    btnPayText.textContent = `Pay & Print (${formattedCost})`;
  }

  document.getElementById('pay-modal-amount').textContent = formattedCost;
  document.querySelectorAll('.pay-btn-amt').forEach(el => {
    el.textContent = total.toFixed(2);
  });
}

// Interactive Payment Modal & Hardware Trigger
function bindPaymentModal() {
  const modal = document.getElementById('payment-modal');
  const openBtn = document.getElementById('btn-open-payment');
  const closeBtn = document.getElementById('btn-close-pay-modal');

  openBtn.addEventListener('click', () => {
    if (uploadedFiles.length === 0) return;
    updateUpiQrCode();
    modal.classList.add('open');
  });

  closeBtn.addEventListener('click', () => {
    modal.classList.remove('open');
  });

  // Payment Tabs
  const tabs = document.querySelectorAll('.pay-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.pay-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const targetContent = document.getElementById(`tab-content-${tab.dataset.tab}`);
      if (targetContent) targetContent.classList.add('active');
    });
  });

  // UPI Payment Trigger
  document.getElementById('btn-pay-upi').addEventListener('click', () => {
    executePaymentAndHardwareDispatch('UPI', 'customer@okaxis');
  });

  // Card Payment Trigger
  document.getElementById('btn-pay-card').addEventListener('click', () => {
    executePaymentAndHardwareDispatch('CARD', 'Card ending 8492');
  });

  // 1-Tap Mock Trigger
  document.getElementById('btn-pay-mock').addEventListener('click', () => {
    executePaymentAndHardwareDispatch('MOCK_INSTANT', 'PrintMate FastPay');
  });
}

function updateUpiQrCode() {
  const upiUrl = `upi://pay?pa=printmate@kiosk&pn=PrintMate%20PVM&am=${currentTotalCost.toFixed(2)}&cu=INR&tn=Kiosk%20Print%20Job`;
  const qrImg = document.getElementById('upi-qr-image');
  if (qrImg) {
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(upiUrl)}`;
  }
}

// Authorizes Payment & Triggers Kiosk Hardware Dispatch Immediately
async function executePaymentAndHardwareDispatch(method, identifier) {
  const modal = document.getElementById('payment-modal');
  modal.classList.remove('open');

  const openBtn = document.getElementById('btn-open-payment');
  openBtn.disabled = true;
  openBtn.textContent = 'Authorizing & Dispatching Hardware...';

  try {
    const res = await fetch(`${API_BASE}/api/session/${sessionId}/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method,
        amount: currentTotalCost,
        upiId: identifier,
        printSettings: {
          ...printSettings,
          pageCount: totalSessionPages,
          simulation: true
        }
      })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Payment failed');

    document.getElementById('payment-txn-id').textContent = data.payment?.txnId || 'TXN-CONFIRMED';
    switchToTrackerView();
  } catch (err) {
    alert('Payment error: ' + err.message);
    openBtn.disabled = false;
    openBtn.textContent = `Pay & Print (₹${currentTotalCost.toFixed(2)})`;
  }
}

function switchToTrackerView() {
  document.getElementById('form-view').style.display = 'none';
  document.getElementById('tracker-view').style.display = 'block';
}

function updateProgress(percent, message) {
  document.getElementById('tracker-progress-fill').style.width = `${percent}%`;
  document.getElementById('tracker-percent').textContent = `${percent}%`;
  if (message) {
    document.getElementById('tracker-status-text').textContent = message;
  }
}

// Handle Print Completion: Disconnect mobile and direct customer to scan new QR on kiosk
function handlePrintFinished() {
  updateProgress(100, 'Print job completed! Paper dispensed to Tray B.');
  document.getElementById('tracker-title').textContent = '🎉 Dispense Complete!';
  document.getElementById('tracker-desc').textContent = 'Your printed pages have been ejected to the physical collection tray at the kiosk.';

  const iconBox = document.getElementById('tracker-icon-box');
  if (iconBox) {
    iconBox.style.color = '#10b981';
    iconBox.style.borderColor = '#10b981';
    iconBox.innerHTML = `
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
      </svg>
    `;
  }

  document.getElementById('mobile-pickup-box').style.display = 'flex';
  
  // Show Session Closed & Disconnected notification
  const closedNotice = document.getElementById('session-closed-notice');
  if (closedNotice) {
    closedNotice.style.display = 'block';
  }

  // Update banner text
  const banner = document.getElementById('connection-banner');
  const bannerText = document.getElementById('banner-text');
  if (bannerText) {
    bannerText.textContent = '🔒 Session Finished & Disconnected for Security.';
  }
  if (banner) {
    banner.style.background = 'rgba(99, 102, 241, 0.15)';
    banner.style.color = '#c7d2fe';
  }

  // Disconnect socket cleanly from this session
  if (socket && socket.connected) {
    console.log('🔒 Disconnecting mobile socket as job is complete.');
    socket.disconnect();
  }
}

function handleSessionClosed(message) {
  const desc = document.getElementById('tracker-desc');
  if (desc) {
    desc.innerHTML = `<span style="color:#94a3b8;">${message}</span>`;
  }
  const closedNotice = document.getElementById('session-closed-notice');
  if (closedNotice) {
    closedNotice.style.display = 'block';
  }
  if (socket && socket.connected) {
    socket.disconnect();
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
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
