/**
 * PrintMate Customer Mobile Web App (Zero-Install)
 * Features:
 * - Client-side document page counting & canvas preview (PDF, Docx, JPG, PNG)
 * - Real-time print configuration: Color Mode (B&W ₹2/pg vs Color ₹10/pg), A4/A3, Duplex, Copies
 * - Real-time dynamic cost estimator updating dynamically based on selections
 * - Payment trigger (UPI / Cards / Mock Gateway) triggering kiosk hardware dispatch on success
 * - Real-time bidirectional synchronization with Kiosk display
 */

const API_BASE = (window.PRINTMATE_CONFIG && window.PRINTMATE_CONFIG.BACKEND_URL) ? window.PRINTMATE_CONFIG.BACKEND_URL : '';

let socket = null;
let sessionId = null;
let uploadedFile = null;
let detectedPageCount = 1;
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
    if (data.session && data.session.file) {
      uploadedFile = data.session.file;
      detectedPageCount = data.session.file.pageCount || 1;
      printSettings.pageCount = detectedPageCount;
      showUploadedFileUI(uploadedFile.originalName, uploadedFile.size, detectedPageCount);
      updateCostEstimator();
    }
  });

  socket.on('session:print_started', (data) => {
    switchToTrackerView();
  });

  socket.on('session:print_progress', (data) => {
    switchToTrackerView();
    updateProgress(data.progress, data.message);
  });

  socket.on('session:print_completed', (data) => {
    handlePrintFinished();
  });

  socket.on('session:wiped', (data) => {
    handleSessionClosed(data?.message || 'Print job completed. Previous connection closed for security.');
  });

  socket.on('session:disconnected_by_server', () => {
    handleSessionClosed('Previous connection closed for security. Ready for next customer.');
  });

  socket.on('session:reset', () => {
    window.location.reload();
  });
}

function syncSettingsToKiosk() {
  if (socket && socket.connected) {
    socket.emit('client:preview_sync', {
      ...printSettings,
      pageCount: detectedPageCount,
      estimatedCost: currentTotalCost
    });
  }
}

// File Upload & Client-Side Page Counting & Preview
function bindDropzone() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const removeBtn = document.getElementById('btn-remove-file');

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
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      inspectAndUploadFile(files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      inspectAndUploadFile(e.target.files[0]);
    }
  });

  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    uploadedFile = null;
    fileInput.value = '';
    document.getElementById('file-card').style.display = 'none';
    document.getElementById('dropzone').style.display = 'block';
    document.getElementById('btn-open-payment').disabled = true;
    detectedPageCount = 1;
    printSettings.pageCount = 1;
    updateCostEstimator();
    const bannerText = document.getElementById('banner-text');
    if (bannerText) bannerText.textContent = 'Hardware Synchronized. Ready for document upload.';
  });
}

// Client-Side Page Counter & Preview Generator
async function inspectAndUploadFile(file) {
  let pageCount = 1;

  try {
    if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
      pageCount = await countPdfPagesAndPreview(file);
    } else if (file.type.startsWith('image/')) {
      pageCount = 1;
      renderImagePreview(file);
    } else if (file.name.match(/\.(docx?|txt)$/i)) {
      pageCount = await estimateTextOrDocxPages(file);
    }
  } catch (err) {
    console.warn('Client-side inspection fallback:', err);
    pageCount = 1;
  }

  processSelectedFile(file, pageCount);
}

// Fast Client-Side PDF Page Counting & Canvas Preview
function countPdfPagesAndPreview(file) {
  return Promise.race([
    new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async function() {
        const buffer = reader.result;

        // 1. If pdf.js is loaded, use it to get exact count and render page 1 thumbnail
        if (window.pdfjsLib) {
          try {
            const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
            const numPages = pdf.numPages || 1;

            // Render first page thumbnail to canvas
            try {
              const page = await pdf.getPage(1);
              const canvas = document.getElementById('preview-canvas');
              const context = canvas.getContext('2d');
              const viewport = page.getViewport({ scale: 0.25 });
              canvas.height = viewport.height;
              canvas.width = viewport.width;
              await page.render({ canvasContext: context, viewport }).promise;
              canvas.style.display = 'block';
              document.getElementById('preview-fallback-icon').style.display = 'none';
            } catch (renderErr) {
              console.warn('Thumbnail render fallback:', renderErr);
            }

            return resolve(numPages);
          } catch (e) {
            console.warn('PDF.js parse fallback:', e);
          }
        }

        // 2. Fast binary fallback parser: scan PDF byte stream for /Type /Page and /Count
        try {
          const text = new TextDecoder('latin1').decode(new Uint8Array(buffer));
          let matches = text.match(/\/Type\s*\/Page[^s]/g);
          let pageCount = matches ? matches.length : 1;

          const countMatch = text.match(/\/Count\s+(\d+)/);
          if (countMatch && parseInt(countMatch[1], 10) > pageCount) {
            pageCount = parseInt(countMatch[1], 10);
          }

          resolve(Math.max(1, pageCount));
        } catch (_) {
          resolve(1);
        }
      };

      reader.onerror = () => resolve(1);
      reader.readAsArrayBuffer(file);
    }),
    new Promise(resolve => setTimeout(() => resolve(1), 2500))
  ]);
}

function renderImagePreview(file) {
  const canvas = document.getElementById('preview-canvas');
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => {
    canvas.width = 70;
    canvas.height = 90;
    ctx.drawImage(img, 0, 0, 70, 90);
    canvas.style.display = 'block';
    document.getElementById('preview-fallback-icon').style.display = 'none';
  };
  img.src = URL.createObjectURL(file);
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

async function processSelectedFile(file, pageCount = 1) {
  detectedPageCount = pageCount;
  printSettings.pageCount = pageCount;

  showUploadedFileUI(file.name, file.size, pageCount);
  updateCostEstimator();

  const bannerText = document.getElementById('banner-text');
  if (bannerText) bannerText.textContent = `Uploading ${file.name}... ⏳`;

  // Upload to server
  const formData = new FormData();
  formData.append('document', file);
  formData.append('pageCount', pageCount);

  try {
    const res = await fetch(`${API_BASE}/api/session/${sessionId}/upload`, {
      method: 'POST',
      body: formData
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Upload failed');

    uploadedFile = data.file;
    document.getElementById('btn-open-payment').disabled = false;
    if (bannerText) bannerText.textContent = `✅ ${file.name} uploaded. Choose settings & proceed to pay.`;
    syncSettingsToKiosk();
  } catch (err) {
    console.error('Upload failed:', err);
    if (bannerText) bannerText.textContent = `❌ Upload failed: ${err.message}. Please tap to retry.`;
    alert('Upload failed: ' + err.message);
  }
}

function showUploadedFileUI(name, size, pages) {
  const dropzone = document.getElementById('dropzone');
  const fileCard = document.getElementById('file-card');
  const fileName = document.getElementById('file-name');
  const fileSize = document.getElementById('file-size');
  const filePages = document.getElementById('file-pages-badge');

  dropzone.style.display = 'none';
  fileCard.style.display = 'flex';
  fileName.textContent = name;
  fileSize.textContent = formatBytes(size);
  filePages.textContent = `${pages} ${pages > 1 ? 'Pages Detected' : 'Page Detected'}`;
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

// Real-Time Dynamic Cost Estimator
function updateCostEstimator() {
  const pages = detectedPageCount || 1;
  const copies = printSettings.copies || 1;
  const isColor = printSettings.colorMode === 'color';
  const isA3 = printSettings.paperSize === 'A3';
  const isDuplex = printSettings.duplex === 'double';

  // Base pricing matrix:
  // B&W A4: ₹2/pg | B&W A3: ₹4/pg
  // Color A4: ₹10/pg | Color A3: ₹15/pg
  let ratePerPage = isColor ? (isA3 ? 15 : 10) : (isA3 ? 4 : 2);
  let total = pages * copies * ratePerPage;
  currentTotalCost = total;

  const formattedCost = `₹${total.toFixed(2)}`;

  // Update Estimator Card
  document.getElementById('cost-total-display').textContent = formattedCost;
  document.getElementById('cost-final-amount').textContent = formattedCost;
  document.getElementById('cost-subtotal-val').textContent = formattedCost;

  document.getElementById('cost-pages-detail').textContent = 
    `${pages} ${pages > 1 ? 'Pages' : 'Page'} × ${copies} ${copies > 1 ? 'Copies' : 'Copy'} ${isDuplex ? '(2-Sided Duplex)' : ''}`;

  document.getElementById('cost-rate-detail').textContent = 
    `${isColor ? 'Color' : 'B&W'} ${isA3 ? 'A3' : 'A4'} @ ₹${ratePerPage}/pg`;

  // Update Pay Button
  const btnPayText = document.getElementById('btn-pay-text');
  if (btnPayText) {
    btnPayText.textContent = `Pay & Print (${formattedCost})`;
  }

  // Update Modal amounts
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
    if (!uploadedFile) return;
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

  // Another document button
  document.getElementById('btn-print-another').addEventListener('click', () => {
    window.location.reload();
  });
}

function updateUpiQrCode() {
  const upiUrl = `upi://pay?pa=printmate@kiosk&pn=PrintMate%20PVM&am=${currentTotalCost.toFixed(2)}&cu=INR&tn=Kiosk%20Print%20Job`;
  // Generate simple QR or fallback image
  const qrImg = document.getElementById('upi-qr-image');
  qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(upiUrl)}`;
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
          pageCount: detectedPageCount,
          simulation: true
        }
      })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Payment failed');

    // Display transaction reference
    document.getElementById('payment-txn-id').textContent = data.payment?.txnId || 'TXN-CONFIRMED';

    // Switch to Synchronized Live Progress Tracker
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

function handlePrintFinished() {
  updateProgress(100, 'Document printed & dispatched to Tray B!');
  document.getElementById('tracker-title').textContent = '🎉 Dispense Complete!';
  document.getElementById('tracker-desc').textContent = 'Your printed pages have been ejected to the physical collection tray.';

  const iconBox = document.getElementById('tracker-icon-box');
  iconBox.style.color = '#10b981';
  iconBox.style.borderColor = '#10b981';
  iconBox.innerHTML = `
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
    </svg>
  `;

  document.getElementById('mobile-pickup-box').style.display = 'flex';
  document.getElementById('btn-print-another').style.display = 'flex';
}

function handleSessionClosed(message) {
  const desc = document.getElementById('tracker-desc');
  if (desc) {
    desc.innerHTML = `<span style="color:#94a3b8;">${message}</span>`;
  }
  const btn = document.getElementById('btn-print-another');
  if (btn) {
    btn.textContent = 'Scan New Session';
    btn.style.display = 'flex';
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
