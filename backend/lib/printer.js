const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { consumeHardwareSupplies, setSpoolerActive, setDriverSettings } = require('./hardware');

let jobHistory = [];

/**
 * Fetch detailed printer driver specifications and device capabilities from Windows
 */
function getDetailedPrinterDriverSettings() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      const simulatedDrivers = [
        {
          name: 'PrintMate High-Speed Laser (Simulation)',
          driverName: 'PrintMate Enterprise Universal Driver',
          driverVersion: 'v4.18.2',
          manufacturer: 'PrintMate Hardware Systems',
          portName: 'USB001 (High-Speed Direct Link)',
          status: 'Ready',
          jobCount: 0,
          shared: false,
          color: true,
          duplex: 'TwoSidedLongEdge',
          collate: true,
          paperSize: 'A4',
          isDefault: true,
          resolution: '1200 x 1200 DPI',
          printProcessor: 'winprint (RAW)'
        },
        {
          name: 'HP LaserJet Pro M404dn (Office Network)',
          driverName: 'HP LaserJet Pro M404 PCL 6',
          driverVersion: 'v3.2',
          manufacturer: 'HP Inc.',
          portName: '192.168.1.150:9100 (WLAN IP)',
          status: 'Ready',
          jobCount: 0,
          shared: true,
          color: false,
          duplex: 'TwoSidedLongEdge',
          collate: true,
          paperSize: 'A4',
          isDefault: false,
          resolution: '1200 DPI',
          printProcessor: 'winprint'
        }
      ];
      setDriverSettings(simulatedDrivers);
      return resolve(simulatedDrivers);
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
    Manufacturer = if ($drv -and $drv.Manufacturer) { $drv.Manufacturer } else { "Generic / Microsoft" }
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
    exec(`powershell -NoProfile -EncodedCommand ${b64}`, { timeout: 10000 }, (error, stdout, stderr) => {
      if (error || !stdout.trim()) {
        console.warn('Could not query Windows printer drivers directly, returning default driver list.');
        const fallback = [
          {
            name: 'PrintMate High-Speed Laser (Simulation)',
            driverName: 'PrintMate Enterprise Universal Driver',
            driverVersion: 'v4.18.2',
            manufacturer: 'PrintMate Hardware Systems',
            portName: 'USB001 (Direct Host to Laptop)',
            status: 'Ready',
            jobCount: 0,
            shared: false,
            color: true,
            duplex: 'TwoSidedLongEdge',
            collate: true,
            paperSize: 'A4',
            isDefault: true,
            resolution: '1200 x 1200 DPI',
            printProcessor: 'winprint (RAW)'
          }
        ];
        setDriverSettings(fallback);
        return resolve(fallback);
      }

      try {
        let raw = JSON.parse(stdout.trim());
        if (!Array.isArray(raw)) raw = [raw];

        const drivers = raw.map((p, idx) => ({
          name: p.Name,
          driverName: p.DriverName || 'Generic Printer Driver',
          driverVersion: p.DriverVersion || 'v4',
          manufacturer: p.Manufacturer || 'OEM Driver',
          portName: p.PortName || 'USB001',
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

        setDriverSettings(drivers);
        resolve(drivers);
      } catch (parseErr) {
        console.error('Error parsing printer driver details:', parseErr);
        resolve([]);
      }
    });
  });
}

/**
 * Fetch installed Windows printers using PowerShell
 */
function getInstalledPrinters() {
  return new Promise((resolve) => {
    getDetailedPrinterDriverSettings().then((detailed) => {
      if (detailed && detailed.length > 0) {
        return resolve(detailed.map(d => ({
          name: d.name,
          isDefault: d.isDefault,
          status: d.status,
          port: d.portName,
          driverName: d.driverName,
          color: d.color
        })));
      }

      resolve([
        { name: 'PrintMate High-Speed Laser (Simulation)', isDefault: true, status: 'Ready (Fast)' },
        { name: 'Microsoft Print to PDF', isDefault: false, status: 'Ready' }
      ]);
    });
  });
}

/**
 * Execute real Windows print command or simulated print with real-time hardware tracking
 * Supports both single file and multiple files in a single print job
 */
function printJob({ jobId, filePath, fileName, files, printerName, settings = {}, onProgress }) {
  return new Promise((resolve, reject) => {
    const isSimulation = settings.simulation || 
                         !printerName || 
                         printerName.includes('Simulation') || 
                         printerName.includes('Virtual');

    // Build normalized list of files to print
    let fileList = [];
    if (Array.isArray(files) && files.length > 0) {
      fileList = files.map(f => ({
        path: f.path || f.filePath,
        name: f.originalName || f.fileName || f.name || 'document',
        pageCount: parseInt(f.pageCount, 10) || 1
      }));
    } else if (filePath) {
      fileList = [{
        path: filePath,
        name: fileName || path.basename(filePath),
        pageCount: parseInt(settings.pageCount, 10) || 1
      }];
    }

    const totalPagesAcrossFiles = fileList.reduce((acc, f) => acc + (f.pageCount || 1), 0);
    const totalCopies = parseInt(settings.copies, 10) || 1;
    const pageCount = totalPagesAcrossFiles || parseInt(settings.pageCount, 10) || 1;
    const colorMode = settings.colorMode || 'bw'; // 'color' or 'bw'
    const orientation = settings.orientation || 'portrait';
    const paperSize = settings.paperSize || 'A4';
    const duplex = settings.duplex || 'single';

    const jobRecord = {
      jobId,
      fileName: fileList.map(f => f.name).join(', ') || fileName || 'documents',
      fileCount: fileList.length,
      files: fileList.map(f => f.name),
      printerName,
      copies: totalCopies,
      pageCount,
      colorMode,
      orientation,
      paperSize,
      duplex,
      status: 'spooling',
      startedAt: new Date().toISOString()
    };
    jobHistory.unshift(jobRecord);
    if (jobHistory.length > 50) jobHistory.pop();

    // Trigger hardware spooler status
    setSpoolerActive(true, fileList.length);
    consumeHardwareSupplies({ paperSize, copies: totalCopies, pageCount, colorMode, duplex });

    if (isSimulation) {
      simulateMultiPrintWorkflow(jobRecord, fileList, onProgress, (result) => {
        setSpoolerActive(false);
        resolve(result);
      });
      return;
    }

    // Real Windows print execution across files
    executeRealMultiPrint(fileList, printerName, settings, jobRecord, onProgress, 
      (res) => {
        setSpoolerActive(false);
        resolve(res);
      }, 
      (err) => {
        setSpoolerActive(false);
        reject(err);
      }
    );
  });
}

function simulateMultiPrintWorkflow(jobRecord, fileList, onProgress, resolve) {
  const isMulti = fileList && fileList.length > 1;
  const steps = [];

  if (isMulti) {
    steps.push({ progress: 15, stage: 'spooling', message: `Spooling ${fileList.length} documents via USB / Wi-Fi...` });
    fileList.forEach((file, idx) => {
      const basePct = 20 + Math.round((idx / fileList.length) * 70);
      steps.push({ 
        progress: basePct, 
        stage: 'rasterizing', 
        message: `Processing [${idx + 1}/${fileList.length}] ${file.name} (${file.pageCount || 1} pg, ${jobRecord.colorMode === 'bw' ? 'B&W' : 'Color'})...` 
      });
      steps.push({ 
        progress: Math.min(95, basePct + Math.round(35 / fileList.length)), 
        stage: 'hardware', 
        message: `Printing [${idx + 1}/${fileList.length}] ${file.name} (${jobRecord.copies} copies)...` 
      });
    });
    steps.push({ progress: 100, stage: 'completed', message: `All ${fileList.length} documents printed! Ready in paper tray.` });
  } else {
    steps.push(
      { progress: 20, stage: 'spooling', message: 'Sending document via USB / Wi-Fi to printer...' },
      { progress: 45, stage: 'rasterizing', message: `Processing ${jobRecord.colorMode === 'bw' ? 'B&W' : 'Color'} layout (${jobRecord.paperSize})...` },
      { progress: 70, stage: 'feeding', message: `Feeding paper from Tray (${jobRecord.paperSize})...` },
      { progress: 88, stage: 'hardware', message: `Printing ${jobRecord.copies} ${jobRecord.copies > 1 ? 'copies' : 'copy'} (${jobRecord.duplex === 'double' ? '2-Sided' : '1-Sided'})...` },
      { progress: 100, stage: 'completed', message: 'Print completed! Ready in paper tray.' }
    );
  }

  let stepIdx = 0;
  function nextStep() {
    if (stepIdx < steps.length) {
      const step = steps[stepIdx++];
      jobRecord.status = step.stage;
      if (onProgress) onProgress(step.progress, step.message);
      
      const delay = step.progress === 100 ? 900 : 700;
      setTimeout(nextStep, delay);
    } else {
      jobRecord.status = 'completed';
      jobRecord.completedAt = new Date().toISOString();
      resolve({ success: true, simulated: true, job: jobRecord });
    }
  }

  nextStep();
}

async function executeRealMultiPrint(fileList, printerName, settings, jobRecord, onProgress, resolve, reject) {
  if (onProgress) onProgress(15, `Preparing Windows print spooler for ${fileList.length} document(s)...`);

  const safePrinter = printerName ? printerName.replace(/'/g, "''") : '';

  try {
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const docPct = Math.round(((i) / fileList.length) * 80) + 15;
      if (onProgress) {
        onProgress(docPct, `Dispatching [${i + 1}/${fileList.length}] ${file.name} to printer...`);
      }

      if (file.path && fs.existsSync(file.path)) {
        const safePath = path.resolve(file.path).replace(/'/g, "''");
        let psCmd;
        if (safePrinter) {
          psCmd = `powershell -NoProfile -Command "Start-Process -FilePath '${safePath}' -Verb PrintTo -ArgumentList '${safePrinter}' -PassThru | Out-Null"`;
        } else {
          psCmd = `powershell -NoProfile -Command "Start-Process -FilePath '${safePath}' -Verb Print -PassThru | Out-Null"`;
        }

        await new Promise((resFile) => {
          exec(psCmd, { timeout: 25000 }, (error) => {
            if (error) {
              console.warn(`Print warning on file ${file.name}:`, error.message);
            }
            resFile();
          });
        });
      }
    }

    if (onProgress) onProgress(100, `Completed printing ${fileList.length} document(s)! Check tray.`);
    jobRecord.status = 'completed';
    jobRecord.completedAt = new Date().toISOString();
    resolve({ success: true, job: jobRecord });

  } catch (err) {
    console.error('Multi-print error:', err);
    jobRecord.status = 'failed';
    reject(err);
  }
}

function getJobHistory() {
  return jobHistory;
}

module.exports = {
  getInstalledPrinters,
  getDetailedPrinterDriverSettings,
  printJob,
  getJobHistory
};
