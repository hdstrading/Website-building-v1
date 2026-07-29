'use strict';
// Dependency-free TOTP (RFC 6238) compatible with Google Authenticator / Authy.
// 6 digits, 30-second period, HMAC-SHA1 — the Google Authenticator defaults.
const crypto = require('crypto');

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Encode a Buffer to RFC 4648 base32 (no padding), as used in otpauth secrets.
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// Decode a base32 string (padding/whitespace/case-insensitive) to a Buffer.
function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

// A fresh 20-byte (160-bit) secret, base32-encoded.
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// The HOTP/TOTP code for a given counter.
function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter (JS numbers are safe well past any real timestamp/30).
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | (hmac[offset + 3]);
  return String(bin % 1000000).padStart(6, '0');
}

// The current TOTP code for a base32 secret.
function generateToken(secret, forTime = Date.now()) {
  return hotp(base32Decode(secret), Math.floor(forTime / 1000 / 30));
}

// Verify a submitted code against the secret, allowing ±`window` steps of drift
// (default ±1 = 30s either side) to tolerate clock skew and entry lag.
function verifyToken(token, secret, window = 1) {
  const code = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const secretBuf = base32Decode(secret);
  if (!secretBuf.length) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    // Constant-time compare against each candidate.
    const candidate = hotp(secretBuf, step + w);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(code))) return true;
  }
  return false;
}

// Build the otpauth:// URI an authenticator app enrols from (via QR or manual key).
function otpauthURL(secret, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { generateSecret, generateToken, verifyToken, otpauthURL, base32Encode, base32Decode };
