// =====================================================================
// src/crypto.js
// ---------------------------------------------------------------------
// AES-256-GCM encryption for arbitrary binary buffers - so a file
// committed into a *public* GitHub repo (required for jsDelivr to serve
// it) is still opaque to anyone who doesn't hold ENCRYPTION_KEY.
//
// Format: iv (12 bytes) || tag (16 bytes) || ciphertext
// The result is self-contained - decryptBuffer needs nothing but the
// key and this one buffer, no separate metadata store.
//
// Same layout telecord's own src/utils/crypto.js already uses for its
// /drive/:token payload, just generalized here from a small JSON-ish
// string to arbitrary file bytes.
// =====================================================================

import crypto from "crypto";

const AES_ALGO = "aes-256-gcm";
const NONCE_SIZE = 12; // GCM-recommended IV length
const TAG_SIZE = 16;   // GCM auth tag length

// Pads or truncates an arbitrary string to exactly 32 bytes so it can be
// used as an AES-256 key. Padding with "0" is fine - predictability of
// the padding doesn't help an attacker who already knows it; key
// strength comes entirely from the caller's secret.
export function normalizedAesKey(key) {
  const normalized = (key || "").padEnd(32, "0");
  return Buffer.from(normalized.slice(0, 32), "utf8");
}

export function encryptBuffer(buffer, key) {
  const aesKey = normalizedAesKey(key);
  const iv = crypto.randomBytes(NONCE_SIZE);
  const cipher = crypto.createCipheriv(AES_ALGO, aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decryptBuffer(buffer, key) {
  if (buffer.length <= NONCE_SIZE + TAG_SIZE) {
    throw new Error("Invalid encrypted payload: too short to contain iv+tag.");
  }
  const aesKey = normalizedAesKey(key);
  const iv = buffer.subarray(0, NONCE_SIZE);
  const tag = buffer.subarray(NONCE_SIZE, NONCE_SIZE + TAG_SIZE);
  const ciphertext = buffer.subarray(NONCE_SIZE + TAG_SIZE);

  const decipher = crypto.createDecipheriv(AES_ALGO, aesKey, iv);
  decipher.setAuthTag(tag); // GCM verifies on final() - tampering throws here
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
