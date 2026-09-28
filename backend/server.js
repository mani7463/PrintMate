const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
const QRCode = require('qrcode');

const { getNetworkAddresses, getPrimaryIp } = require('./lib/network');
const { getInstalledPrinters, getDetailedPrinterDriverSettings, printJob, getJobHistory } = require('./lib/printer');
const { 
  createSession, 
  getSession, 
  updateSession, 
  resetSession, 
  secureWipeSession, 
  removeSessionFile,
  removeSession, 
  sweepExpiredSessions 
} = require('./lib/sessions');
const { getHardwareStatus, setDriverSettings, refillSupplies } = require('./lib/hardware');

// Initialize printer drivers status asynchronously on startup
getDetailedPrinterDriverSettings().then(drivers => {
  if (drivers && drivers.length > 0) {
    setDriverSettings(drivers);
    console.log(`🖨️ [Hardware Discovery]: Loaded ${drivers.length} printer driver profiles.`);
  }
}).catch(e => console.warn('Printer discovery init warning:', e.message));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer storage for document upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e6);
    const ext = path.extname(file.originalname);
    cb(null, `doc-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB limit
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp'
    ];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(pdf|docx?|txt|png|jpe?g|webp)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file format. Please upload PDF, Word DOCX, Image (JPG/PNG) or TXT.'));
    }
  }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// Page routes (serves static kiosk if present, otherwise returns API status)
app.get('/', (req, res) => {
  const kioskPath = path.join(__dirname, 'public', 'kiosk.html');
  if (fs.existsSync(kioskPath)) {
    return res.sendFile(kioskPath);
  }
  res.json({
    status: 'online',
    service: 'PrintMate Backend Engine & Real-Time Print Spooler',
    environment: process.env.NODE_ENV || 'production',
    websocket: 'active',
    timestamp: new Date().toISOString()
  });
});

app.get('/kiosk', (req, res) => {
  const kioskPath = path.join(__dirname, 'public', 'kiosk.html');
  if (fs.existsSync(kioskPath)) {
    return res.sendFile(kioskPath);
  }
  res.redirect('/');
});

// Architecture Requirement 2: Open when scanning Kiosk QR (/kiosk/:sessionId or /session/:sessionId)
app.get('/kiosk/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
});

app.get('/session/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
});

// API: Hardware Health Monitors
app.get('/api/hardware/status', async (req, res) => {
  const hw = getHardwareStatus();
  if (!hw.driverSettings || hw.driverSettings.length === 0) {
    try {
      const drivers = await getDetailedPrinterDriverSettings();
      setDriverSettings(drivers);
    } catch (_) {}
  }
  res.json({
    success: true,
    hardware: getHardwareStatus()
  });
});

app.post('/api/hardware/refill', (req, res) => {
  const hardware = refillSupplies();
  io.emit('hardware:status', hardware);
  res.json({ success: true, hardware });
});

// API: Printer Diagnostics & Accurate Device Driver Settings
app.get('/api/printers/diagnostics', async (req, res) => {
  try {
    const drivers = await getDetailedPrinterDriverSettings();
    setDriverSettings(drivers);
    const hw = getHardwareStatus();
    res.json({
      success: true,
      hardware: hw,
      drivers: hw.driverSettings || drivers,
      selectedPrinter: hw.selectedPrinter || (drivers.length > 0 ? drivers[0].name : null)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Set active printer for diagnostics
app.post('/api/hardware/select-printer', (req, res) => {
  const { printerName } = req.body;
  const hw = getHardwareStatus();
  if (printerName) {
    setDriverSettings(hw.driverSettings, printerName);
  }
  const updatedHw = getHardwareStatus();
  io.emit('hardware:status', updatedHw);
  res.json({ success: true, hardware: updatedHw });
});

// API: Network Discovery
app.get('/api/network', (req, res) => {
  const addresses = getNetworkAddresses();
  const primaryIp = getPrimaryIp();
  const protocol = req.protocol;
  const host = req.get('host');
  res.json({
    addresses,
    primaryIp,
    port: PORT,
    detectedHost: host,
    protocol
  });
});

// API: Printers Discovery
app.get('/api/printers', async (req, res) => {
  try {
    const printers = await getInstalledPrinters();
    res.json({ success: true, printers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/history', (req, res) => {
  res.json({ success: true, jobs: getJobHistory() });
});

function resolveFrontendMobileUrl(req, sessionId) {
  // 1. Explicit environment variable set on backend
  let frontendBase = process.env.FRONTEND_URL;

  // 2. Explicit frontend URL sent in request body from kiosk client
  if (!frontendBase && req && req.body && req.body.frontendUrl) {
    frontendBase = req.body.frontendUrl;
  }

  // 3. Origin or Referer header sent by browser
  if (!frontendBase && req && req.headers) {
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    if (origin && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
      frontendBase = origin;
    } else if (referer && !referer.includes('localhost') && !referer.includes('127.0.0.1')) {
      try {
        frontendBase = new URL(referer).origin;
      } catch (_) {}
    }
  }

  // 4. If running in cloud (Render) without frontendBase, never use internal container IP (10.x.x.x)
  const isCloudEnvironment = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL || (process.env.PORT && process.env.PORT === '10000'));
  if (!frontendBase && isCloudEnvironment) {
    frontendBase = process.env.RENDER_EXTERNAL_URL || 'https://printmate-tau.vercel.app';
  }

  // 5. Local development fallback to local Wi-Fi / LAN IP
  if (!frontendBase) {
    const hostOverride = (req && req.body && req.body.host) ? req.body.host : null;
    const primaryIp = hostOverride || getPrimaryIp();
    frontendBase = `http://${primaryIp}:${PORT}`;
  }

  return `${frontendBase.replace(/\/+$/, '')}/kiosk/${sessionId}`;
}

// API: Create new session with UUID & QR code
app.post('/api/session/new', async (req, res) => {
  const session = createSession();
  
  // Real-time production URL resolution for QR code (Vercel public URL / custom domain)
  const mobileUrl = resolveFrontendMobileUrl(req, session.id);

  try {
    const qrDataUrl = await QRCode.toDataURL(mobileUrl, {
      margin: 2,
      width: 420,
      color: {
        dark: '#030712',
        light: '#ffffff'
      }
    });

    res.json({
      success: true,
      sessionId: session.id,
      pin: session.pin,
      session,
      mobileUrl,
      qrDataUrl,
      hardware: getHardwareStatus()
    });
  } catch (qrErr) {
    res.status(500).json({ success: false, error: qrErr.message });
  }
});

// API: Get session details
app.get('/api/session/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session expired or not found' });
  }
  const remainingSeconds = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
  res.json({ 
    success: true, 
    session, 
    remainingSeconds,
    hardware: getHardwareStatus() 
  });
});

// API: Refresh / New session trigger (for Kiosk Refresh Session button)
app.post(['/api/session/refresh', '/api/session/:id/refresh'], async (req, res) => {
  const oldSessionId = (req.params && req.params.id) || (req.body && req.body.sessionId);
  if (oldSessionId) {
    secureWipeSession(oldSessionId);
    console.log(`🔄 [Session-Refresh]: Wiped previous session ${oldSessionId}`);
  }

  const session = createSession();
  const mobileUrl = resolveFrontendMobileUrl(req, session.id);

  try {
    const qrDataUrl = await QRCode.toDataURL(mobileUrl, {
      margin: 2,
      width: 420,
      color: {
        dark: '#030712',
        light: '#ffffff'
      }
    });

    const responsePayload = {
      success: true,
      sessionId: session.id,
      pin: session.pin,
      session,
      mobileUrl,
      qrDataUrl,
      hardware: getHardwareStatus()
    };

    io.emit('kiosk:fresh_session', responsePayload);
    res.json(responsePayload);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Upload document(s) for session - Supports Single & Multiple Files
app.post('/api/session/:id/upload', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session expired or not found' });
  }

  upload.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    const uploadedFiles = req.files || (req.file ? [req.file] : []);
    if (uploadedFiles.length === 0) {
      return res.status(400).json({ success: false, error: 'No document files provided' });
    }

    // Parse page counts (can be array or single number)
    let parsedPageCounts = [];
    if (req.body.pageCounts) {
      try {
        parsedPageCounts = typeof req.body.pageCounts === 'string' ? JSON.parse(req.body.pageCounts) : req.body.pageCounts;
      } catch (_) {
        parsedPageCounts = String(req.body.pageCounts).split(',').map(n => parseInt(n.trim(), 10));
      }
    }
    const defaultPageCount = parseInt(req.body.pageCount, 10) || 1;

    const backendBase = process.env.RENDER_EXTERNAL_URL || 
                        process.env.BACKEND_URL || 
                        `${req.protocol}://${req.get('host')}`;

    session.files = session.files || [];

    const newFilesInfo = uploadedFiles.map((file, idx) => {
      const pageCount = (Array.isArray(parsedPageCounts) && parsedPageCounts[idx]) ? parseInt(parsedPageCounts[idx], 10) : defaultPageCount;
      const fileInfo = {
        id: 'file-' + Date.now() + '-' + Math.round(Math.random() * 1e5),
        originalName: file.originalname,
        filename: file.filename,
        size: file.size,
        mimetype: file.mimetype,
        path: file.path,
        url: `${backendBase.replace(/\/+$/, '')}/uploads/${file.filename}`,
        pageCount: pageCount,
        uploadedAt: new Date().toISOString()
      };
      session.files.push(fileInfo);
      return fileInfo;
    });

    session.file = session.files[0];
    session.totalPages = session.files.reduce((sum, f) => sum + (f.pageCount || 1), 0);

    updateSession(session.id, {
      file: session.file,
      files: session.files,
      totalPages: session.totalPages,
      stage: 'UPLOADED'
    });

    // Notify all connected clients in the session room (Kiosk and Mobile)
    io.to(`session:${session.id}`).emit('session:file_uploaded', {
      sessionId: session.id,
      files: session.files,
      file: session.file,
      totalPages: session.totalPages,
      newFiles: newFilesInfo,
      hardware: getHardwareStatus()
    });

    res.json({
      success: true,
      files: session.files,
      file: session.file,
      totalPages: session.totalPages,
      newFiles: newFilesInfo
    });
  });
});

// API: Remove a specific file from a multi-file upload session
app.post('/api/session/:id/file/remove', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session expired or not found' });
  }

  const { fileId } = req.body;
  if (!fileId) {
    return res.status(400).json({ success: false, error: 'Missing fileId to remove' });
  }

  const result = removeSessionFile(session.id, fileId);
  if (!result) {
    return res.status(404).json({ success: false, error: 'File not found in active session' });
  }

  session.totalPages = (session.files || []).reduce((sum, f) => sum + (f.pageCount || 1), 0);
  updateSession(session.id, {
    file: session.file,
    files: session.files,
    totalPages: session.totalPages,
    stage: session.files.length > 0 ? 'UPLOADED' : 'CONNECTED'
  });

  io.to(`session:${session.id}`).emit('session:file_uploaded', {
    sessionId: session.id,
    files: session.files,
    file: session.file,
    totalPages: session.totalPages,
    hardware: getHardwareStatus()
  });

  res.json({
    success: true,
    files: session.files,
    file: session.file,
    totalPages: session.totalPages
  });
});

// API: Payment trigger (UPI / Cards / Mock Gateway)
app.post('/api/session/:id/pay', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session expired or not found' });
  }

  const files = (session.files && session.files.length > 0) ? session.files : (session.file ? [session.file] : []);
  if (files.length === 0) {
    return res.status(400).json({ success: false, error: 'No files uploaded yet for this session' });
  }

  const totalPages = files.reduce((sum, f) => sum + (f.pageCount || 1), 0);

  const {
    method = 'UPI',
    amount = 10,
    upiId = 'customer@okaxis',
    printSettings = {}
  } = req.body;

  const txnId = 'TXN-' + (method || 'PAY').toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
  const paymentRecord = {
    txnId,
    method,
    amount: parseFloat(amount) || 10,
    upiId: method === 'UPI' ? upiId : null,
    status: 'SUCCESS',
    timestamp: new Date().toISOString()
  };

  updateSession(session.id, {
    payment: paymentRecord,
    printSettings: {
      copies: parseInt(printSettings.copies, 10) || 1,
      colorMode: printSettings.colorMode || 'bw',
      orientation: printSettings.orientation || 'portrait',
      paperSize: printSettings.paperSize || 'A4',
      duplex: printSettings.duplex || 'single',
      pageCount: totalPages,
      simulation: printSettings.simulation !== false
    }
  });

  // Notify Kiosk & Mobile of payment success
  io.to(`session:${session.id}`).emit('session:payment_success', {
    sessionId: session.id,
    payment: paymentRecord,
    settings: session.printSettings,
    fileCount: files.length,
    totalPages
  });

  // Automatically dispatch print to hardware spooler
  dispatchPrintWorkflow(session.id, res, paymentRecord);
});

// API: Print document for session
app.post('/api/session/:id/print', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session expired or not found' });
  }

  const files = (session.files && session.files.length > 0) ? session.files : (session.file ? [session.file] : []);
  if (files.length === 0) {
    return res.status(400).json({ success: false, error: 'No files uploaded yet for this session' });
  }

  const totalPages = files.reduce((sum, f) => sum + (f.pageCount || 1), 0);

  const {
    copies = 1,
    colorMode = 'bw',
    orientation = 'portrait',
    paperSize = 'A4',
    duplex = 'single',
    pageCount = null,
    printerName = null,
    simulation = false
  } = req.body;

  const printSettings = {
    copies: parseInt(copies, 10) || 1,
    colorMode,
    orientation,
    paperSize,
    duplex,
    pageCount: parseInt(pageCount, 10) || totalPages || 1,
    simulation
  };

  updateSession(session.id, { printSettings });
  dispatchPrintWorkflow(session.id, res);
});

// Helper function to dispatch print workflow and handle auto security reset
function dispatchPrintWorkflow(sessionId, res = null, paymentInfo = null) {
  const session = getSession(sessionId);
  if (!session) return;

  const files = (session.files && session.files.length > 0) ? session.files : (session.file ? [session.file] : []);
  if (files.length === 0) return;

  const totalPages = files.reduce((sum, f) => sum + (f.pageCount || 1), 0);
  const jobId = 'job-' + Date.now().toString(36);
  const printSettings = session.printSettings || {
    copies: 1,
    colorMode: 'bw',
    paperSize: 'A4',
    duplex: 'single',
    pageCount: totalPages || 1,
    simulation: true
  };

  updateSession(session.id, {
    stage: 'PRINTING',
    job: { jobId, progress: 0, status: 'starting' }
  });

  io.to(`session:${session.id}`).emit('session:print_started', {
    sessionId: session.id,
    jobId,
    settings: printSettings,
    files: files,
    file: files[0],
    totalPages,
    hardware: getHardwareStatus()
  });

  if (res && !res.headersSent) {
    res.json({
      success: true,
      message: 'Print job dispatched to hardware spooler',
      jobId,
      fileCount: files.length,
      totalPages,
      payment: paymentInfo
    });
  }

  // Broadcast to any connected Local Printer Agent (on laptop with USB printer)
  io.emit('hardware:print_dispatch', {
    jobId,
    sessionId: session.id,
    files: files.map(f => ({ fileName: f.originalName, fileUrl: f.url, path: f.path, pageCount: f.pageCount })),
    fileName: files.map(f => f.originalName).join(', '),
    fileUrl: files[0]?.url,
    settings: printSettings
  });

  // Execute print job (supports multiple files)
  printJob({
    jobId,
    files,
    filePath: files[0]?.path,
    fileName: files.map(f => f.originalName).join(', '),
    printerName: null,
    settings: printSettings,
    onProgress: (progress, message) => {
      io.to(`session:${session.id}`).emit('session:print_progress', {
        sessionId: session.id,
        jobId,
        progress,
        message,
        hardware: getHardwareStatus()
      });
    }
  })
    .then((result) => {
      updateSession(session.id, {
        stage: 'COMPLETED',
        job: { ...result.job, progress: 100, status: 'completed' }
      });

      // Notify completion and physical pickup tray instructions
      io.to(`session:${session.id}`).emit('session:print_completed', {
        sessionId: session.id,
        jobId,
        result,
        fileCount: files.length,
        pickupTray: 'Tray B (Physical Output Dispense)',
        hardware: getHardwareStatus()
      });

      // Automatically reset, disconnect previous mobile connection, and create new session
      initiateSecurityWipeCountdown(session.id, 3);
    })
    .catch((err) => {
      io.to(`session:${session.id}`).emit('session:print_error', {
        sessionId: session.id,
        jobId,
        error: err.message
      });
    });
}

// Automatically reset session, disconnect previous connection, and generate fresh QR
function initiateSecurityWipeCountdown(sessionId, countdownSeconds = 3) {
  let remaining = countdownSeconds;

  const timer = setInterval(async () => {
    io.to(`session:${sessionId}`).emit('session:security_countdown', {
      sessionId,
      remaining
    });

    remaining--;
    if (remaining < 0) {
      clearInterval(timer);

      // 1. Perform secure disk & memory wipe of all files
      secureWipeSession(sessionId);
      console.log(`🛡️ [Auto-Reset]: Session ${sessionId} documents shredded from memory & disk.`);

      // 2. Disconnect previous mobile client connection
      io.to(`session:${sessionId}`).emit('session:wiped', {
        sessionId,
        message: 'Print job completed. Previous session closed for security.'
      });

      // Disconnect all sockets currently in this session room
      const room = io.sockets.adapter.rooms.get(`session:${sessionId}`);
      if (room) {
        for (const socketId of room) {
          const s = io.sockets.sockets.get(socketId);
          if (s && s.clientType === 'mobile') {
            s.emit('session:disconnected_by_server');
            s.leave(`session:${sessionId}`);
            s.disconnect(true);
          }
        }
      }

      // 3. Automatically create fresh session for kiosk
      const newSession = createSession();
      const mobileUrl = resolveFrontendMobileUrl(null, newSession.id);

      try {
        const qrDataUrl = await QRCode.toDataURL(mobileUrl, {
          margin: 2,
          width: 420,
          color: { dark: '#030712', light: '#ffffff' }
        });

        io.emit('kiosk:fresh_session', {
          sessionId: newSession.id,
          pin: newSession.pin,
          mobileUrl,
          qrDataUrl,
          hardware: getHardwareStatus()
        });
        console.log(`✨ [Auto-Reset]: Created fresh session ${newSession.id} (${newSession.pin}) for kiosk.`);
      } catch (qrErr) {
        console.error('Failed to generate fresh session QR:', qrErr);
      }
    }
  }, 1000);
}

// API: Manual secure wipe
app.post('/api/session/:id/secure-wipe', (req, res) => {
  const session = secureWipeSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  io.to(`session:${req.params.id}`).emit('session:wiped', { sessionId: req.params.id });
  res.json({ success: true, message: 'Session securely wiped from disk and memory' });
});

// API: Reset session
app.post('/api/session/:id/reset', async (req, res) => {
  const session = resetSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  io.to(`session:${session.id}`).emit('session:reset', { sessionId: session.id });
  res.json({ success: true, session });
});

// Socket.IO events for real-time bidirectional synchronization
io.on('connection', (socket) => {
  // Listen for Local Hardware Agent (laptop connected to USB printer)
  socket.on('agent:register', (data) => {
    console.log('🖨️ [Hardware Bridge]: Local agent connected from', data?.hostname, `(${data?.platform})`);
  });

  socket.on('agent:hardware_report', (data) => {
    if (data?.drivers && Array.isArray(data.drivers)) {
      setDriverSettings(data.drivers, data.selectedPrinter);
      console.log(`🖨️ [Hardware Bridge]: Received driver specs for ${data.drivers.length} printers from local agent.`);
      io.emit('hardware:status', getHardwareStatus());
    }
  });

  socket.on('agent:print_progress', (data) => {
    io.to(`session:${data.sessionId}`).emit('session:print_progress', {
      sessionId: data.sessionId,
      jobId: data.jobId,
      progress: data.progress,
      message: data.message,
      hardware: getHardwareStatus()
    });
  });

  socket.on('agent:print_completed', (data) => {
    io.to(`session:${data.sessionId}`).emit('session:print_completed', {
      sessionId: data.sessionId,
      jobId: data.jobId,
      pickupTray: 'Tray B (Physical Output Dispense)',
      hardware: getHardwareStatus()
    });
    initiateSecurityWipeCountdown(data.sessionId, 4);
  });

  socket.on('join_session', ({ sessionId, clientType }) => {
    if (!sessionId) return;
    const session = getSession(sessionId);
    if (!session) {
      socket.emit('session:error', { error: 'Session expired or invalid' });
      return;
    }

    socket.join(`session:${session.id}`);
    socket.sessionId = session.id;
    socket.clientType = clientType; // 'kiosk' or 'mobile'

    if (clientType === 'mobile') {
      if (session.stage === 'WAITING_SCAN') {
        session.stage = 'CONNECTED';
      }
      // Architecture Requirement 1:
      // Real-time display updates immediately upon user mobile scan to show:
      // "Device Connected! Waiting for document upload... ⏳"
      io.to(`session:${session.id}`).emit('session:mobile_connected', {
        sessionId: session.id,
        connectedAt: Date.now(),
        message: 'Device Connected! Waiting for document upload... ⏳'
      });
    }

    // Send initial session state and hardware status
    socket.emit('session:state', {
      session,
      hardware: getHardwareStatus()
    });
  });

  // Client syncs live settings / page count preview
  socket.on('client:preview_sync', (data) => {
    if (socket.sessionId) {
      updateSession(socket.sessionId, { printSettings: data });
      io.to(`session:${socket.sessionId}`).emit('session:preview_synced', data);
    }
  });

  socket.on('disconnect', () => {
    if (socket.sessionId && socket.clientType === 'mobile') {
      io.to(`session:${socket.sessionId}`).emit('session:mobile_disconnected', {
        sessionId: socket.sessionId
      });
    }
  });
});

// Background session auto-expiry sweep
sweepExpiredSessions((expiredSession) => {
  io.to(`session:${expiredSession.id}`).emit('session:expired', {
    sessionId: expiredSession.id
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const addresses = getNetworkAddresses();
  console.log(`\n======================================================`);
  console.log(`🚀 PrintMate Self-Service Kiosk Running on Port ${PORT}`);
  console.log(`🖥️ Kiosk Screen:   http://localhost:${PORT}/kiosk`);
  console.log(`📱 Customer LAN Access Addresses:`);
  addresses.forEach(addr => {
    console.log(`   👉 http://${addr.ip}:${PORT}/kiosk (Interface: ${addr.interface})`);
  });
  console.log(`======================================================\n`);
});
