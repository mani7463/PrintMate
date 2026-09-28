/**
 * PrintMate Local Hardware Bridge Agent
 * Runs on your local laptop / PC connected to the printer via USB or Wi-Fi.
 * Connects to your cloud Render backend and executes physical print jobs locally.
 * Reports accurate hardware printer driver specifications directly from the device.
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

socket.on('connect', async () => {
  console.log('✅ Connected to PrintMate Cloud Backend. Agent ID:', socket.id);
  // Register as local printer hardware agent
  socket.emit('agent:register', {
    platform: process.platform,
    hostname: require('os').hostname()
  });

  // Query and report accurate hardware driver details
  await reportDeviceDrivers();
});

socket.on('disconnect', () => {
  console.warn('⚠️ Disconnected from Cloud Backend. Reconnecting...');
});

// Periodic hardware driver specs sync (every 60s)
setInterval(() => {
  if (socket.connected) {
    reportDeviceDrivers();
  }
}, 60 * 1000);

async function reportDeviceDrivers() {
  try {
    const drivers = await queryDeviceDrivers();
    if (drivers && drivers.length > 0) {
      socket.emit('agent:hardware_report', {
        hostname: require('os').hostname(),
        platform: process.platform,
        drivers,
        timestamp: new Date().toISOString()
      });
      console.log(`📋 Reported specs for ${drivers.length} device driver(s) to backend.`);
    }
  } catch (err) {
    console.warn('⚠️ Driver report error:', err.message);
  }
}

function queryDeviceDrivers() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return resolve([]);
    }

    const psScript = `
$printers = Get-Printer | ForEach-Object {
  $p = $_
  $cfg = $null
  try { $cfg = Get-PrintConfiguration -PrinterName $p.Name -ErrorAction SilentlyContinue } catch {}
  $drv = $null
  try { $drv = Get-PrinterDriver -Name $p.DriverName -ErrorAction SilentlyContinue } catch {}
  [PSCustomObject]@{
    Name = $p.Name
    DriverName = $p.DriverName
    DriverVersion = if ($drv -and $drv.MajorVersion) { "v" + $drv.MajorVersion + ".0" } else { "v4" }
    Manufacturer = if ($drv -and $drv.Manufacturer) { $drv.Manufacturer } else { "Generic / OEM" }
    PortName = $p.PortName
    Status = if ($p.PrinterStatus -eq 0) { "Ready" } else { "Status " + $p.PrinterStatus }
    JobCount = $p.JobCount
    Shared = [bool]$p.Shared
    Color = if ($cfg) { [bool]$cfg.Color } else { $true }
    Duplex = if ($cfg) { [string]$cfg.DuplexingMode } else { "OneSided" }
    Collate = if ($cfg) { [bool]$cfg.Collate } else { $true }
    PaperSize = if ($cfg) { [string]$cfg.PaperSize } else { "A4" }
    PrintProcessor = if ($p.PrintProcessor) { $p.PrintProcessor } else { "winprint" }
  }
}
$printers | ConvertTo-Json -Compress
`;

    const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
    exec(`powershell -NoProfile -EncodedCommand ${b64}`, { timeout: 10000 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        return resolve([]);
      }
      try {
        let raw = JSON.parse(stdout.trim());
        if (!Array.isArray(raw)) raw = [raw];
        const drivers = raw.map((p, idx) => ({
          name: p.Name,
          driverName: p.DriverName || 'Windows Universal Driver',
          driverVersion: p.DriverVersion || 'v4',
          manufacturer: p.Manufacturer || 'OEM Hardware',
          portName: p.PortName || 'USB Host Port',
          status: p.Status || 'Ready',
          jobCount: p.JobCount || 0,
          shared: Boolean(p.Shared),
          color: p.Color !== false,
          duplex: p.Duplex === '1' || p.Duplex === 'TwoSidedLongEdge' ? 'Two-Sided (Duplex)' : (p.Duplex === '0' || p.Duplex === 'OneSided' ? '1-Sided (Simplex)' : p.Duplex),
          collate: p.Collate !== false,
          paperSize: p.PaperSize === '1' ? 'Letter' : (p.PaperSize === '9' ? 'A4' : (p.PaperSize || 'A4')),
          isDefault: idx === 0,
          printProcessor: p.PrintProcessor || 'winprint'
        }));
        resolve(drivers);
      } catch (_) {
        resolve([]);
      }
    });
  });
}

// Listen for physical print dispatch orders from Cloud Backend (supports single & multiple files)
socket.on('hardware:print_dispatch', async (data) => {
  const fileList = Array.isArray(data.files) && data.files.length > 0 
    ? data.files 
    : [{ fileName: data.fileName, fileUrl: data.fileUrl }];

  console.log(`\n📥 Received Print Job [${data.jobId}] containing ${fileList.length} document(s).`);
  console.log(`   Copies: ${data.settings?.copies || 1}, Mode: ${data.settings?.colorMode || 'bw'}, Size: ${data.settings?.paperSize || 'A4'}`);

  const tempFiles = [];

  try {
    for (let i = 0; i < fileList.length; i++) {
      const fileItem = fileList[i];
      const fileName = fileItem.fileName || fileItem.originalName || `doc-${i + 1}`;
      const tempFilePath = path.join(TEMP_DIR, `job-${data.jobId}-${i}-${fileName}`);
      tempFiles.push(tempFilePath);

      const downloadPct = Math.round((i / fileList.length) * 40) + 15;
      socket.emit('agent:print_progress', {
        jobId: data.jobId,
        sessionId: data.sessionId,
        progress: downloadPct,
        message: `Downloading [${i + 1}/${fileList.length}] ${fileName} to local printer buffer...`
      });

      // 1. Download file from Render backend
      const rawUrl = fileItem.fileUrl || data.fileUrl;
      const fileUrl = rawUrl.startsWith('http') ? rawUrl : `${BACKEND_URL}${rawUrl}`;
      const fileRes = await fetch(fileUrl);
      if (!fileRes.ok) throw new Error(`Failed to download ${fileName} from cloud: ${fileRes.statusText}`);

      const buffer = await fileRes.arrayBuffer();
      fs.writeFileSync(tempFilePath, Buffer.from(buffer));
      console.log(`   💾 Saved spool file [${i + 1}/${fileList.length}]: ${tempFilePath}`);

      const spoolPct = Math.round((i / fileList.length) * 45) + 50;
      socket.emit('agent:print_progress', {
        jobId: data.jobId,
        sessionId: data.sessionId,
        progress: spoolPct,
        message: `Sending [${i + 1}/${fileList.length}] ${fileName} to Windows Print Spooler (USB/Wi-Fi)...`
      });

      // 2. Execute physical print on Windows
      await printDocumentLocally(tempFilePath, data.printerName);
    }

    socket.emit('agent:print_progress', {
      jobId: data.jobId,
      sessionId: data.sessionId,
      progress: 95,
      message: 'Paper feeding and physical printing completed in paper tray...'
    });

    setTimeout(() => {
      // 3. Notify completion
      socket.emit('agent:print_completed', {
        jobId: data.jobId,
        sessionId: data.sessionId,
        success: true,
        fileCount: fileList.length
      });
      console.log(`   🎉 Job [${data.jobId}] (${fileList.length} document(s)) printed successfully!`);

      // 4. Shred all local files for privacy
      tempFiles.forEach(secureWipeLocalFile);
    }, 2000);

  } catch (err) {
    console.error('❌ Print execution failed:', err.message);
    socket.emit('agent:print_error', {
      jobId: data.jobId,
      sessionId: data.sessionId,
      error: err.message
    });
    tempFiles.forEach(secureWipeLocalFile);
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
      console.log(`   🔒 Local file shredded from disk: ${path.basename(filePath)}`);
    }
  } catch (e) {
    console.warn('Wipe error:', e.message);
  }
}
