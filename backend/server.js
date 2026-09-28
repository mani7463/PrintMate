const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
const QRCode = require('qrcode');

const { getNetworkAddresses, getPrimaryIp } = require('./lib/network');
const { getInstalledPrinters, printJob, getJobHistory } = require('./lib/printer');
const { 
  createSession, 
  getSession, 
  updateSession, 
  resetSession, 
  secureWipeSession, 
  removeSession, 
  sweepExpiredSessions 
} = require('./lib/sessions');
const { getHardwareStatus, refillSupplies } = require('./lib/hardware');

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
app.get('/api/hardware/status', (req, res) => {
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

// API: Upload document for session
app.post('/api/session/:id/upload', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session expired or not found' });
  }

  upload.single('document')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No document file provided' });
    }

    const pageCount = parseInt(req.body.pageCount, 10) || 1;
    const backendBase = process.env.RENDER_EXTERNAL_URL || 
                        process.env.BACKEND_URL || 
                        `${req.protocol}://${req.get('host')}`;

    const fileInfo = {
      originalName: req.file.originalname,
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
      path: req.file.path,
      url: `${backendBase.replace(/\/+$/, '')}/uploads/${req.file.filename}`,
      pageCount: pageCount,
      uploadedAt: new Date().toISOString()
    };

    updateSession(session.id, {
      file: fileInfo,
      stage: 'UPLOADED'
    });

    // Notify all connected clients in the session room (Kiosk and Mobile)
    io.to(`session:${session.id}`).emit('session:file_uploaded', {
      sessionId: session.id,
      file: fileInfo,
      hardware: getHardwareStatus()
    });

    res.json({ success: true, file: fileInfo });
  });
});

// API: Payment trigger (UPI / Cards / Mock Gateway)
app.post('/api/session/:id/pay', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session expired or not found' });
  }

  if (!session.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded yet for this session' });
  }

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
      pageCount: parseInt(printSettings.pageCount, 10) || session.file.pageCount || 1,
      simulation: printSettings.simulation !== false
    }
  });

  // Notify Kiosk & Mobile of payment success
  io.to(`session:${session.id}`).emit('session:payment_success', {
    sessionId: session.id,
    payment: paymentRecord,
    settings: session.printSettings
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

  if (!session.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded yet for this session' });
  }

  const {
    copies = 1,
    colorMode = 'bw',
    orientation = 'portrait',
    paperSize = 'A4',
    duplex = 'single',
    pageCount = 1,
    printerName = null,
    simulation = false
  } = req.body;

  const printSettings = {
    copies: parseInt(copies, 10) || 1,
    colorMode,
    orientation,
    paperSize,
    duplex,
    pageCount: parseInt(pageCount, 10) || session.file.pageCount || 1,
    simulation
  };

  updateSession(session.id, { printSettings });
  dispatchPrintWorkflow(session.id, res);
});

// Helper function to dispatch print workflow and handle 5s auto security reset
function dispatchPrintWorkflow(sessionId, res = null, paymentInfo = null) {
  const session = getSession(sessionId);
  if (!session || !session.file) return;

  const jobId = 'job-' + Date.now().toString(36);
  const printSettings = session.printSettings || {
    copies: 1,
    colorMode: 'bw',
    paperSize: 'A4',
    duplex: 'single',
    pageCount: session.file.pageCount || 1,
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
    file: session.file,
    hardware: getHardwareStatus()
  });

  if (res && !res.headersSent) {
    res.json({
      success: true,
      message: 'Print job dispatched to hardware spooler',
      jobId,
      payment: paymentInfo
    });
  }

  // Broadcast to any connected Local Printer Agent (on laptop with USB printer)
  io.emit('hardware:print_dispatch', {
    jobId,
    sessionId: session.id,
    fileName: session.file.originalName,
    fileUrl: session.file.url,
    settings: printSettings
  });

  // Execute print job
  printJob({
    jobId,
    filePath: session.file.path,
    fileName: session.file.originalName,
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
        pickupTray: 'Tray B (Physical Output Dispense)',
        hardware: getHardwareStatus()
      });

      // Automatically reset, disconnect previous mobile connection, and create new session
      initiateSecurityWipeCountdown(session.id, 4);
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
function initiateSecurityWipeCountdown(sessionId, countdownSeconds = 4) {
  let remaining = countdownSeconds;

  const timer = setInterval(async () => {
    io.to(`session:${sessionId}`).emit('session:security_countdown', {
      sessionId,
      remaining
    });

    remaining--;
    if (remaining < 0) {
      clearInterval(timer);

      // 1. Perform secure disk & memory wipe
      secureWipeSession(sessionId);
      console.log(`🛡️ [Auto-Reset]: Session ${sessionId} documents shredded from memory & disk.`);

      // 2. Disconnect previous mobile client connection
      io.to(`session:${sessionId}`).emit('session:wiped', {
        sessionId,
        message: 'Print job completed. Previous connection closed for security.'
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
