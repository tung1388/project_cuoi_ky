// =====================================================================
// docs/crypto.js
// ---------------------------------------------------------------------
// Browser (Web Crypto / SubtleCrypto) port of ../src/crypto.js, kept to
// the exact same wire format so ciphertext produced by the Node CLI and
// by this page are interchangeable:
//
//   iv (12 bytes) || tag (16 bytes) || ciphertext
//
// SubtleCrypto's AES-GCM encrypt() returns (ciphertext || tag)
// concatenated, unlike Node's createCipheriv (which hands the tag back
// separately via getAuthTag()) - so encrypt/decrypt here slice and
// reassemble to match that layout.
// =====================================================================

const NONCE_SIZE = 12;
const TAG_SIZE = 16;

function normalizedKeyBytes(passphrase) {
  const padded = (passphrase || "").padEnd(32, "0").slice(0, 32);
  return new TextEncoder().encode(padded);
}

async function importKey(passphrase) {
  return crypto.subtle.importKey("raw", normalizedKeyBytes(passphrase), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptBuffer(bytes, passphrase) {
  const key = await importKey(passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(NONCE_SIZE));
  const combined = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const ciphertext = combined.slice(0, combined.length - TAG_SIZE);
  const tag = combined.slice(combined.length - TAG_SIZE);

  const out = new Uint8Array(NONCE_SIZE + TAG_SIZE + ciphertext.length);
  out.set(iv, 0);
  out.set(tag, NONCE_SIZE);
  out.set(ciphertext, NONCE_SIZE + TAG_SIZE);
  return out;
}

export async function decryptBuffer(bytes, passphrase) {
  if (bytes.length <= NONCE_SIZE + TAG_SIZE) {
    throw new Error("Invalid encrypted payload: too short to contain iv+tag.");
  }
  const key = await importKey(passphrase);
  const iv = bytes.slice(0, NONCE_SIZE);
  const tag = bytes.slice(NONCE_SIZE, NONCE_SIZE + TAG_SIZE);
  const ciphertext = bytes.slice(NONCE_SIZE + TAG_SIZE);

  // SubtleCrypto wants (ciphertext || tag) as one blob - reassemble it.
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);

  // GCM tag verification happens inside decrypt() - throws on tampering
  // or a wrong key, same as Node's decipher.final().
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
  return new Uint8Array(plain);
}

// Fixed-size chunking for large files. Two independent ceilings, not one:
// the Contents/Git-Data blob APIs' base64-inflated request body chokes
// well before git's own ~100MB blob cap, and separately (more strictly)
// jsDelivr's GitHub-CDN mode hard-caps served files at ~20MB. 18MB clears
// both with margin. Metadata (name/type) lives only in the manifest entry
// now, not packed into each blob - a chunked file would otherwise need
// the same JSON repeated on every chunk for no benefit, since the
// manifest is already fully encrypted.
export const CHUNK_SIZE = 18 * 1024 * 1024; // 18MB

export function splitIntoChunks(bytes, chunkSize = CHUNK_SIZE) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, offset + chunkSize));
  }
  // A zero-byte file still needs exactly one (empty) chunk to round-trip.
  if (chunks.length === 0) chunks.push(bytes.subarray(0, 0));
  return chunks;
}
