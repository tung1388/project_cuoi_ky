import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadFile, downloadFile, storePat } from "../src/githubStore.js";
import { encryptBuffer, decryptBuffer } from "../src/crypto.js";

const ADMIN_CONFIG = {
  token: "fake-token",
  owner: "fake-owner",
  repo: "fake-repo",
  keys: { admin: "admin-key", quantran: "quantran-key" },
};

const QUANTRAN_CONFIG = {
  token: "fake-token",
  owner: "fake-owner",
  repo: "fake-repo",
  keys: { quantran: "quantran-key" }, // no "admin" entry - can't touch admin's folder
};

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("uploadFile PUTs base64-encrypted content under blobs/<folder>/ and returns a SHA-pinned cdn_url", async (t) => {
  let capturedUrl, capturedInit;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({ commit: { sha: "abc123" } });
  });

  const result = await uploadFile({
    buffer: Buffer.from("hello world"),
    fileName: "hello.txt",
    folder: "quantran",
    config: ADMIN_CONFIG,
  });

  assert.equal(capturedUrl, "https://api.github.com/repos/fake-owner/fake-repo/contents/" + result.path);
  assert.equal(capturedInit.method, "PUT");
  assert.equal(capturedInit.headers.Authorization, "Bearer fake-token");

  const body = JSON.parse(capturedInit.body);
  assert.match(body.content, /^[A-Za-z0-9+/]+=*$/); // valid base64
  assert.match(body.message, /hello\.txt/);

  assert.match(result.path, /^blobs\/quantran\/[0-9a-f-]{36}\.enc$/);
  assert.equal(result.commit_sha, "abc123");
  assert.equal(
    result.cdn_url,
    `https://cdn.jsdelivr.net/gh/fake-owner/fake-repo@abc123/${result.path}`
  );
});

test("uploadFile throws if the caller's config has no key for that folder", async () => {
  await assert.rejects(
    () => uploadFile({ buffer: Buffer.from("x"), fileName: "x.txt", folder: "admin", config: QUANTRAN_CONFIG }),
    /no encryption key configured for folder "admin"/
  );
});

test("uploadFile requires a folder", async () => {
  await assert.rejects(
    () => uploadFile({ buffer: Buffer.from("x"), fileName: "x.txt", config: ADMIN_CONFIG }),
    /folder is required/
  );
});

test("storePat (first time) checks for an existing sha, finds none, and creates pat.enc", async (t) => {
  let putUrl, putInit, getCalled = false;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (!init || init.method === undefined) {
      // getExistingSha's plain GET (no method specified defaults to GET)
      getCalled = true;
      return { ok: false, status: 404 };
    }
    putUrl = url;
    putInit = init;
    return jsonResponse({ commit: { sha: "def456" } });
  });

  const result = await storePat({ folder: "quantran", pat: "github_pat_realtoken", config: ADMIN_CONFIG });

  assert.equal(getCalled, true);
  assert.equal(putUrl, "https://api.github.com/repos/fake-owner/fake-repo/contents/blobs/quantran/pat.enc");
  assert.equal(result.path, "blobs/quantran/pat.enc");
  assert.equal(result.commit_sha, "def456");

  const body = JSON.parse(putInit.body);
  assert.equal(body.sha, undefined); // nothing to overwrite - no sha in the request
  const encrypted = Buffer.from(body.content, "base64");
  const decrypted = decryptBuffer(encrypted, ADMIN_CONFIG.keys.quantran);
  assert.equal(decrypted.toString("utf8"), "github_pat_realtoken");
});

test("storePat (rotating) includes the existing sha so GitHub allows the overwrite", async (t) => {
  let putInit;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (!init || init.method === undefined) {
      return jsonResponse({ sha: "existing-sha-123" }); // pat.enc already exists
    }
    putInit = init;
    return jsonResponse({ commit: { sha: "def789" } });
  });

  await storePat({ folder: "quantran", pat: "github_pat_rotated", config: ADMIN_CONFIG });

  const body = JSON.parse(putInit.body);
  assert.equal(body.sha, "existing-sha-123");
});

test("storePat throws if the caller's config has no key for that folder", async () => {
  await assert.rejects(
    () => storePat({ folder: "admin", pat: "x", config: QUANTRAN_CONFIG }),
    /no encryption key configured for folder "admin"/
  );
});

test("uploadFile throws with the response body on a non-ok GitHub response", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse({ message: "Bad credentials" }, { ok: false, status: 401 })
  );

  await assert.rejects(
    () => uploadFile({ buffer: Buffer.from("x"), fileName: "x.txt", folder: "admin", config: ADMIN_CONFIG }),
    /github upload failed: 401/
  );
});

test("downloadFile fetches, decrypts using the folder parsed from the URL, and returns the original plaintext", async (t) => {
  const original = Buffer.from("the actual file bytes");
  const encrypted = encryptBuffer(original, ADMIN_CONFIG.keys.quantran);

  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => encrypted.buffer.slice(
      encrypted.byteOffset,
      encrypted.byteOffset + encrypted.byteLength
    ),
  }));

  const cdnUrl = "https://cdn.jsdelivr.net/gh/x/y@z/blobs/quantran/f.enc";
  const result = await downloadFile({ cdnUrl, config: ADMIN_CONFIG });
  assert.deepEqual(result, original);
});

test("downloadFile throws (never even fetches) when the config has no key for that folder", async (t) => {
  let fetchCalled = false;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalled = true;
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  });

  const cdnUrl = "https://cdn.jsdelivr.net/gh/x/y@z/blobs/admin/f.enc";
  await assert.rejects(
    () => downloadFile({ cdnUrl, config: QUANTRAN_CONFIG }),
    /no encryption key configured for folder "admin"/
  );
  assert.equal(fetchCalled, false);
});

test("downloadFile throws on a cdn_url that doesn't look like a githost path", async () => {
  await assert.rejects(
    () => downloadFile({ cdnUrl: "https://example.com/not-a-githost-url", config: ADMIN_CONFIG }),
    /doesn't look like a githost path/
  );
});

test("downloadFile retries a 404 (jsDelivr not caught up yet) before succeeding", async (t) => {
  const original = Buffer.from("eventually available");
  const encrypted = encryptBuffer(original, ADMIN_CONFIG.keys.admin);
  let calls = 0;

  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => encrypted.buffer.slice(
        encrypted.byteOffset,
        encrypted.byteOffset + encrypted.byteLength
      ),
    };
  });

  const cdnUrl = "https://cdn.jsdelivr.net/gh/x/y@z/blobs/admin/f.enc";
  const result = await downloadFile({ cdnUrl, config: ADMIN_CONFIG });
  assert.deepEqual(result, original);
  assert.equal(calls, 3);
});

test("downloadFile gives up and throws after exhausting retries", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 }));

  const cdnUrl = "https://cdn.jsdelivr.net/gh/x/y@z/blobs/admin/f.enc";
  await assert.rejects(
    () => downloadFile({ cdnUrl, config: ADMIN_CONFIG }),
    /jsdelivr fetch failed: 404/
  );
});
