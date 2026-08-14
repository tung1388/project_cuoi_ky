// =====================================================================
// docs/github.js
// ---------------------------------------------------------------------
// Thin wrapper around GitHub's APIs - reads and writes go straight from
// the browser using the friend's own personal PAT, no mediating server.
// jsDelivr isn't used here: this page already holds an authenticated
// token, so it reads/writes GitHub directly rather than waiting on
// jsDelivr's cache to catch up on a fresh commit.
//
// Reads deliberately go through the Git Data API (git/blobs/<sha>), NOT
// the Contents API's own GET .../contents/<path>. Found live: for a path
// written to repeatedly in quick succession, Contents API GET can return
// a WRONG byte count for `content` (varies between reads) while its own
// `sha`/`size` fields stay correct, and while the underlying git blob -
// fetched directly by that same sha via the Git Data API - is always
// correct. Root cause not identified (looks like a GitHub-side read-path
// caching quirk specific to that endpoint, not anything on our end -
// commit history was confirmed clean, no bot/webhook involved). The
// two-step "Contents API for existence+sha, Git Data API for bytes"
// pattern below sidesteps it entirely.
// =====================================================================

const API = "https://api.github.com";
const RULE_TIMEOUT_RETRY_DELAYS_MS = [500, 1000, 2000]; // GitHub repo-ruleset validation occasionally times out transiently

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getBlobBytes({ owner, repo, sha, authHeaders }) {
  const res = await fetch(`${API}/repos/${owner}/${repo}/git/blobs/${sha}`, { headers: authHeaders });
  if (!res.ok) throw new Error(`github blob fetch failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return base64ToBytes(data.content);
}

/** Returns { bytes, sha } for an existing file, or null if the path doesn't exist. */
export async function getFile({ owner, repo, token, path }) {
  const authHeaders = headers(token);
  const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}`, { headers: authHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github get failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const meta = await res.json();
  return { bytes: await getBlobBytes({ owner, repo, sha: meta.sha, authHeaders }), sha: meta.sha };
}

/**
 * Same as getFile(), but with no Authorization header - used exactly
 * once, at login, before the app has a real token yet: GitHub allows
 * unauthenticated reads of PUBLIC repo contents (just at a much lower
 * rate limit - ~60 req/hour per IP - which is fine for an occasional
 * login, not something to use for regular file operations).
 */
export async function getPublicFile({ owner, repo, path }) {
  const authHeaders = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}`, { headers: authHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github get failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const meta = await res.json();
  return { bytes: await getBlobBytes({ owner, repo, sha: meta.sha, authHeaders }), sha: meta.sha };
}

/**
 * Creates or updates a file. Pass `sha` (from a prior getFile()) when
 * overwriting an existing path - GitHub requires it as a concurrency
 * check, rejecting the write if the file has moved on since you read it.
 */
export async function putFile({ owner, repo, token, path, bytes, message, sha }) {
  const body = JSON.stringify({
    message,
    content: bytesToBase64(bytes),
    ...(sha ? { sha } : {}),
  });

  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
      method: "PUT",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body,
    });
    if (res.ok) {
      const data = await res.json();
      return { sha: data.content.sha, commit_sha: data.commit.sha };
    }

    const text = await res.text();
    // GitHub repo rulesets occasionally time out validating a push and
    // ask the caller to just retry - a transient server-side hiccup, safe
    // to retry blindly (unlike a real sha-conflict 409, whose message is
    // different and means "your write really did lose a race").
    const isRuleTimeout = res.status === 409 && /timed out validating rule/i.test(text);
    if (!isRuleTimeout || attempt >= RULE_TIMEOUT_RETRY_DELAYS_MS.length) {
      throw new Error(`github put failed: ${res.status} ${text.slice(0, 300)}`);
    }
    await sleep(RULE_TIMEOUT_RETRY_DELAYS_MS[attempt]);
  }
}
