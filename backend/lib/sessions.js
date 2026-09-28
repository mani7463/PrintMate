const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// Volatile in-memory store for active sessions
const sessions = new Map();

// Session timeout: 5 minutes of inactivity (300,000 ms)
const SESSION_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

function generateShortPin() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let pin = '';
  for (let i = 0; i < 4; i++) {
    pin += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `PM-${pin}`;
}

/**
 * Creates a brand new ephemeral print session
 */
function createSession() {
  const id = uuidv4();
  const pin = generateShortPin();
  const now = Date.now();

  const session = {
    id,
    pin,
    createdAt: now,
    lastActivity: now,
    expiresAt: now + SESSION_INACTIVITY_TIMEOUT_MS,
    stage: 'WAITING_SCAN', // WAITING_SCAN -> CONNECTED -> UPLOADED -> PAYMENT_PENDING -> PRINTING -> COMPLETED -> WIPED
    connectedClients: 0,
    file: null,
    files: [],
    printSettings: null,
    payment: null,
    job: null
  };

  sessions.set(id, session);
  return session;
}

/**
 * Retrieve session by UUID or PIN (case-insensitive)
 */
function getSession(id) {
  if (!id) return null;
  const cleanId = String(id).trim();

  // Try direct UUID lookup
  if (sessions.has(cleanId)) {
    return sessions.get(cleanId);
  }

  // Try case-insensitive UUID match
  for (const [key, sess] of sessions.entries()) {
    if (key.toLowerCase() === cleanId.toLowerCase()) {
      return sess;
    }
    // Also support finding by short PIN (e.g. PM-XXXX or XXXX)
    if (sess.pin.toLowerCase() === cleanId.toLowerCase() || sess.pin.replace('PM-', '').toLowerCase() === cleanId.toLowerCase()) {
      return sess;
    }
  }

  return null;
}

/**
 * Touch / update session activity timestamp and push expiry by 5 minutes
 */
function updateSession(id, updates = {}) {
  const session = getSession(id);
  if (!session) return null;

  const now = Date.now();
  Object.assign(session, updates, {
    lastActivity: now,
    expiresAt: now + SESSION_INACTIVITY_TIMEOUT_MS
  });

  return session;
}

/**
 * Securely shred and wipe an uploaded file from disk:
 * Overwrites file contents with zeros/random bytes before unlinking.
 */
function secureWipeFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      const zeroBuffer = Buffer.alloc(stats.size, 0);
      fs.writeFileSync(filePath, zeroBuffer);
      fs.unlinkSync(filePath);
      console.log(`🔒 [Privacy Shredder]: Securely zero-wiped and deleted ${filePath}`);
      return true;
    }
  } catch (err) {
    console.warn(`[Privacy Shredder Error]: Failed to wipe ${filePath}:`, err.message);
  }
  return false;
}

function wipeAllSessionFiles(session) {
  if (!session) return;
  if (Array.isArray(session.files)) {
    session.files.forEach(f => {
      if (f && f.path) secureWipeFile(f.path);
    });
  }
  if (session.file && session.file.path) {
    secureWipeFile(session.file.path);
  }
}

/**
 * Securely wipes session file and volatile memory
 */
function secureWipeSession(id) {
  const session = getSession(id);
  if (!session) return null;

  wipeAllSessionFiles(session);

  // Purge file and memory details
  session.file = null;
  session.files = [];
  session.stage = 'WIPED';
  session.printSettings = null;
  session.payment = null;
  session.job = null;
  session.lastActivity = Date.now();

  return session;
}

/**
 * Removes a specific file from session and shreds it
 */
function removeSessionFile(id, fileIdentifier) {
  const session = getSession(id);
  if (!session || !Array.isArray(session.files)) return null;

  const index = session.files.findIndex(f => 
    f.id === fileIdentifier || f.filename === fileIdentifier || f.originalName === fileIdentifier
  );

  if (index !== -1) {
    const [removed] = session.files.splice(index, 1);
    if (removed && removed.path) {
      secureWipeFile(removed.path);
    }
    session.file = session.files.length > 0 ? session.files[0] : null;
    if (session.files.length === 0) {
      session.stage = 'CONNECTED';
    }
    return { removed, remainingFiles: session.files };
  }
  return null;
}

/**
 * Resets an existing session for a new user, or removes it
 */
function resetSession(id) {
  const session = getSession(id);
  if (!session) return null;

  wipeAllSessionFiles(session);

  session.stage = 'WAITING_SCAN';
  session.file = null;
  session.files = [];
  session.printSettings = null;
  session.payment = null;
  session.job = null;
  session.lastActivity = Date.now();
  session.expiresAt = Date.now() + SESSION_INACTIVITY_TIMEOUT_MS;
  return session;
}

/**
 * Remove session completely from memory
 */
function removeSession(id) {
  const session = getSession(id);
  if (!session) return;

  wipeAllSessionFiles(session);

  sessions.delete(session.id);
}

/**
 * Clean up expired sessions (inactivity > 5 minutes)
 */
function sweepExpiredSessions(onExpired) {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now > session.expiresAt) {
      console.log(`⏱️ [Auto-Expire]: Session ${session.id} (${session.pin}) expired after 5m inactivity. Shredding memory & disk.`);
      wipeAllSessionFiles(session);
      sessions.delete(id);
      if (onExpired) onExpired(session);
    }
  }
}

// Background cleanup daemon every 10 seconds
setInterval(() => {
  sweepExpiredSessions();
}, 10 * 1000);

module.exports = {
  createSession,
  getSession,
  updateSession,
  secureWipeSession,
  removeSessionFile,
  resetSession,
  removeSession,
  sweepExpiredSessions,
  SESSION_INACTIVITY_TIMEOUT_MS
};
