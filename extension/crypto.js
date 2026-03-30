// ===================================================
// SaferTab – Shared Crypto & Utility Functions
// ===================================================

// ─── Helpers ──────────────────────────────────────

function bufToHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function generateSalt() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(16)));
}

// ─── Password Hashing (SHA-256 + salt) ────────────

async function hashPassword(password, saltHex) {
  const encoder = new TextEncoder();
  const data = encoder.encode(saltHex + password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bufToHex(hash);
}

// ─── AES-GCM Encryption (key from PBKDF2) ────────

async function deriveEncryptionKey(password, saltHex) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: hexToBuf(saltHex), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptData(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  // Store as hex: iv (24 chars) + ciphertext
  return bufToHex(iv) + bufToHex(ciphertext);
}

async function decryptData(key, encryptedHex) {
  const iv = hexToBuf(encryptedHex.substring(0, 24));
  const ciphertext = hexToBuf(encryptedHex.substring(24));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

// ─── Log Pruning ──────────────────────────────────

const MAX_LOG_ENTRIES = 2000;
const MAX_LOG_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function pruneLog(entries) {
  const cutoff = Date.now() - MAX_LOG_AGE_MS;
  const filtered = entries.filter(e => e.timestamp >= cutoff);
  if (filtered.length > MAX_LOG_ENTRIES) filtered.length = MAX_LOG_ENTRIES;
  return filtered;
}
