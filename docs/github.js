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
const REQUEST_TIMEOUT_MS = 60_000; // generous enough for an 18MB chunk's base64-inflated body over a slow connection

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Plain fetch() never times out on its own - a stalled connection (flaky
// wifi, a dropped packet mid-upload of an 18MB chunk, GitHub itself
// hanging) just leaves the caller awaiting forever with nothing to catch
// or retry (confirmed as the cause of large uploads/downloads "just
// getting stuck" with no error). Aborting after REQUEST_TIMEOUT_MS turns
// that into an ordinary rejected promise, so the retry loops below (and
// the shared write queue, which would otherwise wedge for the rest of
// the session behind a single hung write) actually get a chance to run.
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      // status: 0 is the conventional "never got an HTTP response at all"
      // marker (network failure, timeout) - lets callers retry this the
      // same way they'd retry a 409/422, without conflating it with a
      // real (non-retryable) 4xx from GitHub.
      throw Object.assign(new Error(`request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${url}`), { status: 0 });
    }
    throw Object.assign(err, { status: err.status ?? 0 });
  } finally {
    clearTimeout(timer);
  }
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// Building the binary string one character at a time (`binary +=
// String.fromCharCode(bytes[i])` in a loop) is ~19 million synchronous
// operations for an 18MB chunk - the size used everywhere else in this
// app - with zero opportunity for the browser to repaint in between. That
// blocks the main thread for multiple seconds per chunk, which is what
// "uploading/decrypting large files just gets stuck" actually was: not a
// hung network request (already fixed separately), the tab genuinely
// freezing on CPU-bound work with no yield point. String.fromCharCode.
// apply() over blocks of the array is dramatically faster - one call per
// 32KB block instead of one per byte - so the loop finishes in a small
// fraction of the time.
const BASE64_BLOCK_SIZE = 0x8000; // 32768 - comfortably under engines' apply()/spread argument-count ceiling
function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_BLOCK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + BASE64_BLOCK_SIZE));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const BLOB_FETCH_RETRY_DELAYS_MS = [300, 1000, 3000];

// Called once per chunk when reassembling a large chunked file for
// preview/download (see fetchEntryBytes in app.js) - same exposure as
// createBlob's per-chunk writes, just on the read side, so it gets the
// same small retry for a timeout/network failure (status 0). A real HTTP
// error response still fails immediately.
async function getBlobBytes({ owner, repo, sha, authHeaders }) {
  let lastError;
  for (let attempt = 0; attempt <= BLOB_FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const res = await fetchWithTimeout(`${API}/repos/${owner}/${repo}/git/blobs/${sha}`, { headers: authHeaders });
      if (!res.ok) throw Object.assign(new Error(`github blob fetch failed: ${res.status} ${(await res.text()).slice(0, 300)}`), { status: res.status });
      const data = await res.json();
      return base64ToBytes(data.content);
    } catch (err) {
      lastError = err;
      if (err.status !== 0 || attempt === BLOB_FETCH_RETRY_DELAYS_MS.length) throw lastError;
      await sleep(BLOB_FETCH_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

/** Returns { bytes, sha } for an existing file, or null if the path doesn't exist. */
export async function getFile({ owner, repo, token, path }) {
  const authHeaders = headers(token);
  const res = await fetchWithTimeout(`${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}`, { headers: authHeaders });
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
  const res = await fetchWithTimeout(`${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}`, { headers: authHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github get failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const meta = await res.json();
  return { bytes: await getBlobBytes({ owner, repo, sha: meta.sha, authHeaders }), sha: meta.sha };
}

const COMMIT_CONFLICT_RETRY_DELAYS_MS = [300, 600, 1200, 2000, 3000];

// The Contents API's commits are inherently serialized per-repo: each PUT
// creates a new commit with the branch's current HEAD as its sole parent,
// then fast-forwards the branch ref - only one commit can land at a time,
// no matter how many PUTs (even to completely unrelated paths) are in
// flight at once. Actual writes are funneled through this one-at-a-time
// queue so a chunked upload's concurrency (see docs/app.js) doesn't spend
// itself racing against its own other chunks - only the prep work before
// a write (encrypting a chunk) benefits from that concurrency. Also
// covers GitHub repo-ruleset validation occasionally timing out and
// asking the caller to just retry - both cases surface as a 409, and
// retrying either is safe (a stale-sha 409 just 409s again immediately).
let writeQueue = Promise.resolve();
function enqueueWrite(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {}); // keep the queue alive even if this write ultimately fails
  return run;
}

/**
 * Creates or updates a file. Pass `sha` (from a prior getFile()) when
 * overwriting an existing path - GitHub requires it as a concurrency
 * check, rejecting the write if the file has moved on since you read it.
 */
export async function putFile({ owner, repo, token, path, bytes, message, sha }) {
  return enqueueWrite(() => putFileNow({ owner, repo, token, path, bytes, message, sha }));
}

async function putFileNow({ owner, repo, token, path, bytes, message, sha }) {
  const body = JSON.stringify({
    message,
    content: bytesToBase64(bytes),
    ...(sha ? { sha } : {}),
  });

  let lastError;
  for (let attempt = 0; attempt <= COMMIT_CONFLICT_RETRY_DELAYS_MS.length; attempt += 1) {
    let status;
    try {
      const res = await fetchWithTimeout(`${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
        method: "PUT",
        headers: { ...headers(token), "Content-Type": "application/json" },
        body,
      });
      if (res.ok) {
        const data = await res.json();
        return { sha: data.content.sha, commit_sha: data.commit.sha };
      }
      status = res.status;
      lastError = new Error(`github put failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    } catch (err) {
      // A timeout/network failure (status 0, from fetchWithTimeout) never
      // got a response at all - retry it the same as a 409, since a fetch
      // that stalled on a slow connection is exactly the kind of thing a
      // retry (or just trying again a moment later) can recover from.
      status = err.status ?? 0;
      lastError = err;
    }
    if ((status !== 409 && status !== 0) || attempt === COMMIT_CONFLICT_RETRY_DELAYS_MS.length) throw lastError;
    await sleep(COMMIT_CONFLICT_RETRY_DELAYS_MS[attempt]);
  }
  throw lastError;
}

// ---------------------------------------------------------------------
// Git Data API primitives - used for chunked/batch uploads instead of one
// Contents-API PUT (= one commit) per blob. Blob creation touches no ref
// and has zero commit contention, so it can run at full caller
// concurrency; only the final tree+commit+ref-update step needs the
// one-at-a-time queue, and there's exactly one of those per BATCH of
// blobs rather than one per blob - this is what lets a multi-file/folder
// upload land as one commit instead of one per file.
// ---------------------------------------------------------------------

const BLOB_CREATE_RETRY_DELAYS_MS = [300, 1000, 3000];

/**
 * Creates a git blob (raw content, not yet reachable from any commit) -
 * no ref/commit involved, so many can run concurrently with zero
 * contention. Called once per chunk on a large upload (see
 * createBlobsForFile in app.js), so it's the single most-repeated network
 * call during a big upload and the one most exposed to a single stalled
 * connection - retries a timeout/network failure (status 0) a few times
 * before giving up; a real HTTP error response (bad token, payload too
 * large, etc.) still fails immediately since retrying that wouldn't help.
 */
export async function createBlob({ owner, repo, token, bytes }) {
  const body = JSON.stringify({ content: bytesToBase64(bytes), encoding: "base64" });
  let lastError;
  for (let attempt = 0; attempt <= BLOB_CREATE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const res = await fetchWithTimeout(`${API}/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        headers: { ...headers(token), "Content-Type": "application/json" },
        body,
      });
      if (!res.ok) throw Object.assign(new Error(`github blob create failed: ${res.status} ${(await res.text()).slice(0, 300)}`), { status: res.status });
      const data = await res.json();
      return data.sha;
    } catch (err) {
      lastError = err;
      if (err.status !== 0 || attempt === BLOB_CREATE_RETRY_DELAYS_MS.length) throw lastError;
      await sleep(BLOB_CREATE_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

const branchCache = new Map(); // "owner/repo" -> default_branch, doesn't change mid-session
async function getDefaultBranch({ owner, repo, token }) {
  const key = `${owner}/${repo}`;
  if (branchCache.has(key)) return branchCache.get(key);
  const res = await fetchWithTimeout(`${API}/repos/${owner}/${repo}`, { headers: headers(token) });
  if (!res.ok) throw new Error(`github repo lookup failed: ${res.status}`);
  const { default_branch } = await res.json();
  branchCache.set(key, default_branch);
  return default_branch;
}

const BATCH_COMMIT_RETRY_DELAYS_MS = [300, 600, 1200, 2000, 3000, 4000, 6000, 8000, 10000, 15000, 20000, 30000];
function withJitter(ms) {
  return ms + Math.floor(Math.random() * ms * 0.3);
}

/**
 * Commits many already-created blobs in ONE commit: read current HEAD ->
 * build a new tree on top of it (base_tree + new entries) -> create a
 * commit -> fast-forward the branch ref. Queued (enqueueWrite) since the
 * ref-update step is still a single per-repo point of contention, but
 * that's now the ONLY serialized step per batch, not per file/chunk.
 *
 * `buildEntries()` is called fresh on every retry attempt (not just
 * once) so a caller whose entries depend on other freshly-read state
 * (e.g. re-reading the manifest to merge in new entries) stays correct
 * even if an external writer's commit landed in between.
 *
 * `entries` is `[{ path, blobSha }]`. Returns `{ commit_sha }`.
 */
export async function commitBatch({ owner, repo, token, buildEntries, message }) {
  return enqueueWrite(() => commitBatchNow({ owner, repo, token, buildEntries, message }));
}

async function commitBatchNow({ owner, repo, token, buildEntries, message }) {
  let lastError;
  for (let attempt = 0; attempt <= BATCH_COMMIT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const branch = await getDefaultBranch({ owner, repo, token }); // memoized on success, so retrying this is cheap
      const refRes = await fetchWithTimeout(`${API}/repos/${owner}/${repo}/git/ref/heads/${branch}`, { headers: headers(token) });
      if (!refRes.ok) throw Object.assign(new Error(`github ref lookup failed: ${refRes.status}`), { status: refRes.status });
      const { object: { sha: parentSha } } = await refRes.json();

      const parentCommitRes = await fetchWithTimeout(`${API}/repos/${owner}/${repo}/git/commits/${parentSha}`, { headers: headers(token) });
      if (!parentCommitRes.ok) throw Object.assign(new Error(`github commit lookup failed: ${parentCommitRes.status}`), { status: parentCommitRes.status });
      const { tree: { sha: baseTreeSha } } = await parentCommitRes.json();

      const entries = await buildEntries();

      const treeRes = await fetchWithTimeout(`${API}/repos/${owner}/${repo}/git/trees`, {
        method: "POST",
        headers: { ...headers(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: entries.map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: e.blobSha })),
        }),
      });
      if (!treeRes.ok) {
        const body = await treeRes.text().catch(() => "");
        throw Object.assign(new Error(`github tree create failed: ${treeRes.status} ${body.slice(0, 300)}`), { status: treeRes.status });
      }
      const { sha: newTreeSha } = await treeRes.json();

      const commitRes = await fetchWithTimeout(`${API}/repos/${owner}/${repo}/git/commits`, {
        method: "POST",
        headers: { ...headers(token), "Content-Type": "application/json" },
        body: JSON.stringify({ message, tree: newTreeSha, parents: [parentSha] }),
      });
      if (!commitRes.ok) {
        const body = await commitRes.text().catch(() => "");
        throw Object.assign(new Error(`github commit create failed: ${commitRes.status} ${body.slice(0, 300)}`), { status: commitRes.status });
      }
      const { sha: newCommitSha } = await commitRes.json();

      const updateRefRes = await fetchWithTimeout(`${API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
        method: "PATCH",
        headers: { ...headers(token), "Content-Type": "application/json" },
        body: JSON.stringify({ sha: newCommitSha }),
      });
      if (!updateRefRes.ok) {
        const body = await updateRefRes.text().catch(() => "");
        // Non-fast-forward (422) is this endpoint's version of the same "someone else
        // committed first" race a Contents-API PUT reports as 409 - treated identically below.
        throw Object.assign(new Error(`github ref update failed: ${updateRefRes.status} ${body.slice(0, 300)}`), { status: updateRefRes.status });
      }

      return { commit_sha: newCommitSha };
    } catch (err) {
      lastError = err;
      // status 0 is a timeout/network failure (see fetchWithTimeout) - retry
      // it the same as a genuine 409/422 conflict, since a stalled request
      // is exactly the kind of thing trying again a moment later recovers.
      const isRetryable = err.status === 409 || err.status === 422 || err.status === 0;
      if (!isRetryable || attempt === BATCH_COMMIT_RETRY_DELAYS_MS.length) throw lastError;
      await sleep(withJitter(BATCH_COMMIT_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
}
