// =====================================================================
// src/githubStore.js
// ---------------------------------------------------------------------
// Encrypted static-file storage using a public GitHub repo as the blob
// store and jsDelivr as the free CDN in front of it.
//
// IMPORTANT: jsDelivr's /gh/ mode serves files committed into the git
// tree - NOT GitHub Release assets. That caps practical file size at
// git's own limit (~100MB hard block without Git LFS, and jsDelivr
// can't read LFS-tracked content anyway). This prototype is scoped to
// images, documents, and small video clips - not large video, which
// would need chunking (splitting into multiple <100MB parts and
// reassembling on download) - left as future work.
//
// cdn_url is always pinned to the exact commit SHA, not a branch name,
// so jsDelivr treats it as immutable content and serves it without the
// ~24h cache lag branch-based URLs get.
//
// Per-folder keys: config.keys is a { folderName: keyString } map, not a
// single global key. Each file lives under blobs/<folder>/<uuid>.enc and
// is encrypted with that folder's key. "Admin sees everything" just means
// admin's own config.keys contains every folder's key; a friend's config
// only ever contains their own folder's key, so their client can encrypt/
// decrypt within their own folder and nothing else - it could still fetch
// (but not decrypt) other folders' ciphertext, since the repo is public.
// Confidentiality here comes entirely from key possession, not from any
// network-level access control.
// =====================================================================

import { randomUUID } from "crypto";
import { encryptBuffer, decryptBuffer } from "./crypto.js";

const GITHUB_API = "https://api.github.com";
const JSDELIVR_RETRY_DELAYS_MS = [500, 1000, 2000]; // brand-new commits can take a moment to appear

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function keyForFolder(config, folder) {
  const key = config.keys?.[folder];
  if (!key) {
    throw new Error(`no encryption key configured for folder "${folder}"`);
  }
  return key;
}

/** Current sha for `path`, or undefined if it doesn't exist yet - needed to overwrite an existing path (GitHub rejects a PUT to an existing path with no sha). */
async function getExistingSha({ path, config }) {
  const { token, owner, repo } = config;
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
    headers: githubHeaders(token),
  });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`github get failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.sha;
}

/** Shared PUT-encrypted-content-at-a-path core, used by uploadFile (random path, always new) and storePat (fixed path, may already exist). */
async function putEncrypted({ encrypted, path, message, config, sha }) {
  const { token, owner, repo } = config;
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
    {
      method: "PUT",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        content: encrypted.toString("base64"),
        ...(sha ? { sha } : {}),
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`github upload failed: ${res.status} ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const commitSha = data.commit?.sha;
  if (!commitSha) {
    throw new Error("github upload failed: no commit sha in response");
  }

  return {
    path,
    commit_sha: commitSha,
    cdn_url: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${commitSha}/${path}`,
  };
}

/**
 * Encrypt `buffer` with `folder`'s key and commit it to the configured
 * GitHub repo via the Contents API (a plain HTTPS PUT - no local git
 * binary needed).
 *
 * The stored filename is a random UUID, deliberately unrelated to
 * `fileName` or the file's content - the repo has to be public for
 * jsDelivr to read it at all, so nothing about what's stored (name,
 * type, whether two uploads share content) should be visible from the
 * repo listing beyond "this folder has N files."
 *
 * Returns { path, commit_sha, cdn_url }.
 */
export async function uploadFile({ buffer, fileName, folder, config }) {
  if (!folder) throw new Error("folder is required");
  const encrypted = encryptBuffer(buffer, keyForFolder(config, folder));
  return putEncrypted({
    encrypted,
    path: `blobs/${folder}/${randomUUID()}.enc`,
    message: `store: ${fileName || "blob"}`,
    config,
  });
}

/**
 * Admin-only: encrypt a friend's real GitHub PAT with their folder's key
 * and store it at a FIXED path (blobs/<folder>/pat.enc), so their web
 * frontend can bootstrap login from just folder+key (see docs/app.js) -
 * fetched unauthenticated via GitHub's public-repo API, since a friend
 * doesn't have a token yet at that point.
 *
 * SECURITY NOTE: this stores a real, live, write-scoped credential
 * (encrypted) in the same public repo whose confidentiality depends on
 * that folder's key. A leaked/guessed key for that folder now exposes a
 * working GitHub token with write access to the WHOLE repo, not just
 * that folder - not a new exposure in kind (the PAT already sits
 * unencrypted in that friend's browser localStorage after first login
 * today), but the encryption key itself now needs the same care as a
 * password, not just "protects my files."
 *
 * Safe to re-run: fetches the current sha (if pat.enc already exists) so
 * this both creates it the first time and rotates it on later calls,
 * rather than only ever working once.
 */
export async function storePat({ folder, pat, config }) {
  if (!folder) throw new Error("folder is required");
  if (!pat) throw new Error("pat is required");
  const path = `blobs/${folder}/pat.enc`;
  const encrypted = encryptBuffer(Buffer.from(pat, "utf8"), keyForFolder(config, folder));
  const sha = await getExistingSha({ path, config });
  return putEncrypted({ encrypted, path, message: `store pat for ${folder}`, config, sha });
}

// Pulls "quantran" out of ".../blobs/quantran/<uuid>.enc" so downloadFile
// can look up the right key without the caller having to pass it in
// separately - the folder is already encoded in the URL uploadFile made.
function folderFromCdnUrl(cdnUrl) {
  const match = String(cdnUrl).match(/\/blobs\/([^/]+)\/[^/]+\.enc$/);
  if (!match) throw new Error(`cdn_url doesn't look like a githost path: ${cdnUrl}`);
  return match[1];
}

/**
 * Fetch + decrypt a file previously stored via uploadFile(). The caller's
 * config must contain the key for whichever folder the URL belongs to -
 * if it doesn't (e.g. a friend's client trying to decrypt someone else's
 * folder), this throws rather than silently failing.
 *
 * jsDelivr fetching a just-created commit can lag by a moment, so a
 * fresh upload is retried a few times before giving up - this is NOT a
 * general-purpose retry for network failures, just for "the CDN hasn't
 * caught up yet" (a 404 immediately after upload).
 */
export async function downloadFile({ cdnUrl, config }) {
  const key = keyForFolder(config, folderFromCdnUrl(cdnUrl));
  let lastError;
  for (let attempt = 0; attempt <= JSDELIVR_RETRY_DELAYS_MS.length; attempt += 1) {
    const res = await fetch(cdnUrl);
    if (res.ok) {
      const encrypted = Buffer.from(await res.arrayBuffer());
      return decryptBuffer(encrypted, key);
    }
    lastError = new Error(`jsdelivr fetch failed: ${res.status}`);
    if (attempt < JSDELIVR_RETRY_DELAYS_MS.length) {
      await sleep(JSDELIVR_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}
