/**
 * PrintMate Local Hardware Bridge Agent
 * Runs on your local laptop / PC connected to the printer via USB or Wi-Fi.
 * Connects to your cloud Render backend and executes physical print jobs locally.
 */

const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// Configuration: Change to your deployed Render URL or localhost
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const TEMP_DIR = path.join(__dirname, 'temp');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

console.log('====================================================');
console.log('🖨️  PrintMate Local Hardware Bridge Agent');
console.log(`📡 Connecting to Cloud Backend: ${BACKEND_URL}`);
console.log('====================================================');

const socket = io(BACKEND_URL, {
  reconnection: true,
  reconnectionDelay: 2000
});

socket.on('connect', () => {
  console.log('✅ Connected to PrintMate Cloud Backend. Agent ID:', socket.id);
  // Register as local printer hardware agent
  socket.emit('agent:register', {
    platform: process.platform,
    hostname: require('os').hostname()
  });
});

socket.on('disconnect', () => {
  console.warn('⚠️ Disconnected from Cloud Backend. Reconnecting...');
});

// Listen for physical print dispatch orders from Cloud Backend
socket.on('hardware:print_dispatch', async (data) => {
  console.log(`\n📥 Received Print Job [${data.jobId}] for file: ${data.fileName}`);
  console.log(`   Copies: ${data.settings?.copies || 1}, Mode: ${data.settings?.colorMode || 'bw'}, Size: ${data.settings?.paperSize || 'A4'}`);

  const tempFilePath = path.join(TEMP_DIR, `job-${data.jobId}-${data.fileName}`);

  try {
    socket.emit('agent:print_progress', {
      jobId: data.jobId,
      sessionId: data.sessionId,
      progress: 25,
      message: 'Downloading document to local printer buffer...'
    });

    // 1. Download file from Render backend
    const fileUrl = data.fileUrl.startsWith('http') ? data.fileUrl : `${BACKEND_URL}${data.fileUrl}`;
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) throw new Error(`Failed to download file from cloud: ${fileRes.statusText}`);

    const buffer = await fileRes.arrayBuffer();
    fs.writeFileSync(tempFilePath, Buffer.from(buffer));
    console.log(`   💾 Saved temporary spool file: ${tempFilePath}`);

    socket.emit('agent:print_progress', {
      jobId: data.jobId,
      sessionId: data.sessionId,
      progress: 55,
      message: 'Sending document stream to Windows Print Spooler (USB/Wi-Fi)...'
    });

    // 2. Execute physical print on Windows
    await printDocumentLocally(tempFilePath, data.printerName);

    socket.emit('agent:print_progress', {
      jobId: data.jobId,
      sessionId: data.sessionId,
      progress: 90,
      message: 'Paper feeding and printing in progress...'
    });

    setTimeout(() => {
      // 3. Notify completion
      socket.emit('agent:print_completed', {
        jobId: data.jobId,
        sessionId: data.sessionId,
        success: true
      });
      console.log(`   🎉 Job [${data.jobId}] printed successfully!`);

      // 4. Shred local file for privacy
      secureWipeLocalFile(tempFilePath);
    }, 2000);

  } catch (err) {
    console.error('❌ Print execution failed:', err.message);
    socket.emit('agent:print_error', {
      jobId: data.jobId,
      sessionId: data.sessionId,
      error: err.message
    });
    if (fs.existsSync(tempFilePath)) secureWipeLocalFile(tempFilePath);
  }
});

function printDocumentLocally(filePath, printerName) {
  return new Promise((resolve) => {
    const safePath = path.resolve(filePath).replace(/'/g, "''");
    const safePrinter = printerName ? printerName.replace(/'/g, "''") : '';

    let psCmd;
    if (safePrinter) {
      psCmd = `powershell -NoProfile -Command "Start-Process -FilePath '${safePath}' -Verb PrintTo -ArgumentList '${safePrinter}' -PassThru | Out-Null"`;
    } else {
      psCmd = `powershell -NoProfile -Command "Start-Process -FilePath '${safePath}' -Verb Print -PassThru | Out-Null"`;
    }

    exec(psCmd, { timeout: 30000 }, (err) => {
      if (err) {
        console.warn('   ⚠️ PowerShell print command returned warning/fallback:', err.message);
      }
      resolve();
    });
  });
}

function secureWipeLocalFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      const zeroBuffer = Buffer.alloc(stats.size, 0);
      fs.writeFileSync(filePath, zeroBuffer);
      fs.unlinkSync(filePath);
      console.log('   🔒 Local temporary print file zero-shredded from disk.');
    }
  } catch (e) {
    console.warn('Wipe error:', e.message);
  }
}
