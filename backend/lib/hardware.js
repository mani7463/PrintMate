/**
 * PrintMate Printer Diagnostics & Hardware Monitor
 * Manages printer connectivity via:
 * 1. USB Connection to Laptop / Host PC (USB001 / Direct USB Host)
 * 2. Wi-Fi / LAN Network Connection (WLAN / IP Port)
 * Tracks paper trays, ink/toner cartridges, and print spooler status.
 */

let hardwareState = {
  connection: {
    type: 'USB & Wi-Fi Dual-Link',
    usbPort: 'USB001 (Direct Host to Laptop)',
    usbStatus: 'Connected & Active',
    wifiNetwork: 'PrintMate-Local-WLAN',
    wifiIp: '192.168.10.80',
    wifiStatus: 'Online (Signal: Excellent)'
  },
  paperTrays: {
    tray1: {
      id: 'tray-1',
      name: 'Paper Tray 1 (A4 / Letter)',
      size: 'A4',
      maxSheets: 500,
      currentSheets: 428,
      status: 'OK'
    },
    tray2: {
      id: 'tray-2',
      name: 'Paper Tray 2 (A3 Ledger)',
      size: 'A3',
      maxSheets: 250,
      currentSheets: 165,
      status: 'OK'
    }
  },
  toner: {
    black: { color: 'Black (K)', percent: 89, hex: '#1e293b' },
    cyan: { color: 'Cyan (C)', percent: 76, hex: '#06b6d4' },
    magenta: { color: 'Magenta (M)', percent: 68, hex: '#ec4899' },
    yellow: { color: 'Yellow (Y)', percent: 84, hex: '#eab308' }
  },
  spooler: {
    system: 'Windows Spooler / CUPS Print Daemon',
    queueJobs: 0,
    status: 'Ready - Waiting for jobs',
    activeInterface: 'USB Direct (Laptop Link)'
  },
  lastUpdated: new Date().toISOString()
};

function getHardwareStatus() {
  hardwareState.paperTrays.tray1.percent = Math.round((hardwareState.paperTrays.tray1.currentSheets / hardwareState.paperTrays.tray1.maxSheets) * 100);
  hardwareState.paperTrays.tray2.percent = Math.round((hardwareState.paperTrays.tray2.currentSheets / hardwareState.paperTrays.tray2.maxSheets) * 100);
  hardwareState.lastUpdated = new Date().toISOString();
  return hardwareState;
}

function consumeHardwareSupplies({ paperSize = 'A4', copies = 1, pageCount = 1, colorMode = 'bw', duplex = 'single' }) {
  const totalPages = (pageCount || 1) * (copies || 1);
  const sheetsNeeded = duplex === 'double' ? Math.ceil(totalPages / 2) : totalPages;

  if (paperSize === 'A3') {
    hardwareState.paperTrays.tray2.currentSheets = Math.max(0, hardwareState.paperTrays.tray2.currentSheets - sheetsNeeded);
    if (hardwareState.paperTrays.tray2.currentSheets <= 15) hardwareState.paperTrays.tray2.status = 'LOW';
  } else {
    hardwareState.paperTrays.tray1.currentSheets = Math.max(0, hardwareState.paperTrays.tray1.currentSheets - sheetsNeeded);
    if (hardwareState.paperTrays.tray1.currentSheets <= 25) hardwareState.paperTrays.tray1.status = 'LOW';
  }

  const inkDeduction = (sheetsNeeded * 0.15);
  hardwareState.toner.black.percent = Math.max(2, Math.round(hardwareState.toner.black.percent - inkDeduction));
  if (colorMode === 'color') {
    hardwareState.toner.cyan.percent = Math.max(2, Math.round(hardwareState.toner.cyan.percent - inkDeduction * 0.8));
    hardwareState.toner.magenta.percent = Math.max(2, Math.round(hardwareState.toner.magenta.percent - inkDeduction * 0.8));
    hardwareState.toner.yellow.percent = Math.max(2, Math.round(hardwareState.toner.yellow.percent - inkDeduction * 0.8));
  }
}

function setSpoolerActive(active, jobCount = 1) {
  if (active) {
    hardwareState.spooler.queueJobs = jobCount;
    hardwareState.spooler.status = 'Printing (USB / Wi-Fi Active)';
  } else {
    hardwareState.spooler.queueJobs = 0;
    hardwareState.spooler.status = 'Ready - Waiting for jobs';
  }
}

function refillSupplies() {
  hardwareState.paperTrays.tray1.currentSheets = 500;
  hardwareState.paperTrays.tray1.status = 'OK';
  hardwareState.paperTrays.tray2.currentSheets = 250;
  hardwareState.paperTrays.tray2.status = 'OK';
  hardwareState.toner.black.percent = 100;
  hardwareState.toner.cyan.percent = 100;
  hardwareState.toner.magenta.percent = 100;
  hardwareState.toner.yellow.percent = 100;
  return getHardwareStatus();
}

module.exports = {
  getHardwareStatus,
  consumeHardwareSupplies,
  setSpoolerActive,
  refillSupplies
};
