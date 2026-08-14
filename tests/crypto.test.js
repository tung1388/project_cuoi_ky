import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptBuffer, decryptBuffer, normalizedAesKey } from "../src/crypto.js";

const KEY = "test-encryption-key";

test("normalizedAesKey always returns exactly 32 bytes", () => {
  assert.equal(normalizedAesKey("short").length, 32);
  assert.equal(normalizedAesKey("a".repeat(64)).length, 32);
  assert.equal(normalizedAesKey("").length, 32);
});

test("encryptBuffer/decryptBuffer round-trips arbitrary binary data", () => {
  // Non-UTF8-safe bytes (0x00-0xFF), the kind a real image/video would have.
  const original = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const encrypted = encryptBuffer(original, KEY);
  const decrypted = decryptBuffer(encrypted, KEY);
  assert.deepEqual(decrypted, original);
});

test("encryptBuffer produces different ciphertext each call (random IV)", () => {
  const original = Buffer.from("same plaintext");
  const first = encryptBuffer(original, KEY);
  const second = encryptBuffer(original, KEY);
  assert.notDeepEqual(first, second);
  assert.deepEqual(decryptBuffer(first, KEY), original);
  assert.deepEqual(decryptBuffer(second, KEY), original);
});

test("decryptBuffer throws on tampered ciphertext", () => {
  const original = Buffer.from("do not tamper with me");
  const encrypted = encryptBuffer(original, KEY);
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 0xff; // flip a byte in the ciphertext
  assert.throws(() => decryptBuffer(tampered, KEY));
});

test("decryptBuffer throws on the wrong key", () => {
  const original = Buffer.from("secret");
  const encrypted = encryptBuffer(original, KEY);
  assert.throws(() => decryptBuffer(encrypted, "wrong-key"));
});

test("decryptBuffer throws on truncated payload", () => {
  assert.throws(() => decryptBuffer(Buffer.from([1, 2, 3]), KEY));
});
