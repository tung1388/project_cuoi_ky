// =====================================================================
// docs/app.js
// ---------------------------------------------------------------------
// Wires the login form, file list, upload, download, and preview
// together.
//
// This page is deployed for one specific repo, so owner/repo are fixed
// constants rather than form fields - login only asks for a username
// (= storage folder) and password (= encryption key). On submit,
// resolveToken() fetches blobs/<username>/pat.enc (unauthenticated -
// nothing to authenticate with yet) and decrypts it with the entered
// password to recover the real GitHub token an admin pre-stored via the
// CLI's `store-pat` command. From then on, the resolved token +
// everything else lives in localStorage only - never baked into this
// shipped code, so the page itself has no secret to leak.
//
// The manifest (blobs/<username>/manifest.enc) is a single encrypted
// JSON index of {id, name, type, size, uploadedAt} - it's how the list
// view shows real filenames without any of that being visible to
// someone browsing the public repo directly. It's a single shared
// mutable file per folder, so concurrent uploads from two tabs/devices
// at once could race and clobber each other's entry - acceptable at
// "one person using their own account from their own browser" scale,
// not something this prototype tries to solve properly.
//
// The "public" folder (see PUBLIC_FOLDER/PUBLIC_KEY below) is the one
// exception to "your folder needs your password": it's readable by any
// visitor with no login, using a fixed key shipped in this file instead
// of a per-user password.
// =====================================================================

import { encryptBuffer, decryptBuffer, CHUNK_SIZE, splitIntoChunks } from "./crypto.js";
import { getFile, putFile, getPublicFile, createBlob, commitBatch } from "./github.js";
import { isSqliteFile, renderSqlitePreview } from "./sqlitePreview.js";
import { renderPdfPreview } from "./pdfPreview.js";

const OWNER = "tung1388";
const REPO = "project_cuoi_ky";
const STORAGE_KEY = "githost.session";

const PUBLIC_FOLDER = "public";
// Not a real secret - it's shipped in this client file so the page can
// auto-decrypt the public folder for every visitor with no login. It
// keeps blobs/public/*.enc unreadable when browsing the repo/GitHub UI
// directly; anyone who reads this file can derive it too, same tradeoff
// as any client-side-only encryption scheme (see pat.enc for the private
// folders' equivalent, gated behind a password instead).
const PUBLIC_KEY = "githost-public-folder-shared-key-v1";

const CHUNK_UPLOAD_CONCURRENCY = 4; // chunks within one big file
const FILE_UPLOAD_CONCURRENCY = 8; // whole files within one batch upload - blob creation only, no commit contention
const COMMIT_BATCH_SIZE = 50; // files per commit - keeps each commit's tree small and bounds how much uncommitted work a crash mid-batch loses

const els = {
  loginForm: document.getElementById("login-form"),
  loginUsername: document.getElementById("login-username"),
  loginPassword: document.getElementById("login-password"),
  loginStatus: document.getElementById("login-status"),
  loginError: document.getElementById("login-error"),
  app: document.getElementById("app"),
  whoami: document.getElementById("whoami"),
  logoutBtn: document.getElementById("logout-btn"),
  fileInput: document.getElementById("file-input"),
  folderInput: document.getElementById("folder-input"),
  uploadStatus: document.getElementById("upload-status"),
  fileList: document.getElementById("file-list"),
  refreshBtn: document.getElementById("refresh-btn"),
  publicFileList: document.getElementById("public-file-list"),
  publicRefreshBtn: document.getElementById("public-refresh-btn"),
  publicUploadRow: document.getElementById("public-upload-row"),
  publicFileInput: document.getElementById("public-file-input"),
  publicFolderInput: document.getElementById("public-folder-input"),
  publicUploadStatus: document.getElementById("public-upload-status"),
  previewModal: document.getElementById("preview-modal"),
  previewTitle: document.getElementById("preview-title"),
  previewBody: document.getElementById("preview-body"),
  previewClose: document.getElementById("preview-close"),
};

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function saveSession(session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

function manifestPath(session) {
  return `blobs/${session.folder}/manifest.enc`;
}

function blobPath(session, id) {
  return `blobs/${session.folder}/${id}.enc`;
}

function chunkPath(session, id, index) {
  return `blobs/${session.folder}/${id}/${index}.enc`;
}

// Runs `worker` over `items` with at most `limit` in flight at once - no
// dependency needed for a pool this small. Mirrors src/githubStore.js's
// runWithConcurrency (the Node CLI side).
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runNext() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

// Authenticated reads use the normal token'd endpoint; a session with no
// token (the public folder, viewed by a logged-out visitor) falls back to
// GitHub's unauthenticated public-repo read instead.
async function fetchFile(session, path) {
  return session.token
    ? getFile({ owner: session.owner, repo: session.repo, token: session.token, path })
    : getPublicFile({ owner: session.owner, repo: session.repo, path });
}

async function loadManifest(session) {
  const existing = await fetchFile(session, manifestPath(session));
  if (!existing) return { entries: [], sha: null };
  const decrypted = await decryptBuffer(existing.bytes, session.key);
  const entries = JSON.parse(new TextDecoder().decode(decrypted));
  return { entries, sha: existing.sha };
}

async function saveManifest(session, entries, sha) {
  const bytes = new TextEncoder().encode(JSON.stringify(entries));
  const encrypted = await encryptBuffer(bytes, session.key);
  await putFile({
    owner: session.owner,
    repo: session.repo,
    token: session.token,
    path: manifestPath(session),
    bytes: encrypted,
    message: `update manifest (${entries.length} files)`,
    sha,
  });
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Emoji stand-ins for a file-type icon - good enough for a prototype
// without pulling in an icon font/library.
const TYPE_ICON = { video: "🎬", audio: "🎵", application_pdf: "📄", text: "📝" };
function iconFor(entry) {
  if (isSqliteFile(entry)) return "🗄️";
  if (entry.type === "application/pdf") return TYPE_ICON.application_pdf;
  const kind = (entry.type || "").split("/")[0];
  return TYPE_ICON[kind] || "📦";
}

// Browsers generally don't recognize .sqlite/.db as a MIME type, so
// file.type comes back as "" for them - fall back to the extension so
// the manifest still records a type the preview can recognize later.
function guessType(file) {
  if (file.type) return file.type;
  if (/\.(sqlite3?|db3?)$/i.test(file.name)) return "application/vnd.sqlite3";
  return "application/octet-stream";
}

// entry.id -> decrypted Uint8Array. Thumbnail loading, preview, and
// download can all independently ask for the same entry's bytes (e.g.
// opening a preview right after its thumbnail already decrypted it, or
// downloading a file you just previewed) - without this, each of those
// would re-fetch and re-decrypt every chunk from scratch. Keyed by the
// entry's own id (a random UUID, globally unique across folders), so
// there's no collision risk between galleries sharing this cache.
const decryptedCache = new Map();

// Fetch + decrypt an uploaded entry - shared by thumbnail loading,
// download, and preview, which only differ in what they do with the
// resulting bytes. A chunked entry (see createBlobsForFile) fetches+
// decrypts every chunk in parallel and reassembles them in order; name/
// type/size all live on the manifest entry itself, so there's no
// per-blob envelope to unpack.
//
// `onProgress(completed, total)`, if given, fires after each chunk
// finishes decrypting (skipped entirely on a cache hit) - for a large
// (100MB+) chunked file, the network requests themselves finish in a
// second or two, but base64-decoding + decrypting many multi-megabyte
// chunks is CPU-bound and can block the tab for a long stretch with zero
// visible feedback otherwise, which reads as "hung" or "broken" rather
// than "still working."
async function fetchEntryBytes(session, entry, onProgress) {
  const cached = decryptedCache.get(entry.id);
  if (cached) return cached;

  let bytes;
  if (entry.chunked) {
    let completed = 0;
    const chunks = await Promise.all(
      Array.from({ length: entry.chunkCount }, async (_, index) => {
        const stored = await fetchFile(session, chunkPath(session, entry.id, index));
        if (!stored) throw new Error(`${entry.name} is missing chunk ${index} (was it deleted outside this app?).`);
        const chunkBytes = await decryptBuffer(stored.bytes, session.key);
        onProgress?.(++completed, entry.chunkCount);
        return chunkBytes;
      })
    );
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  } else {
    const stored = await fetchFile(session, blobPath(session, entry.id));
    if (!stored) {
      throw new Error(`${entry.name} is missing from the repo (was it deleted outside this app?).`);
    }
    bytes = await decryptBuffer(stored.bytes, session.key);
  }

  decryptedCache.set(entry.id, bytes);
  return bytes;
}

async function downloadEntry(session, entry, onProgress) {
  let fileBytes;
  try {
    fileBytes = await fetchEntryBytes(session, entry, onProgress);
  } catch (err) {
    alert(err.message);
    return;
  }
  const blob = new Blob([fileBytes], { type: entry.type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = entry.name;
  a.click();
  URL.revokeObjectURL(url);
}

// Tracks the last object URL / open sql.js Database / open pdf.js
// document shown in the preview modal so all three can be released when
// replaced or closed - otherwise each preview leaks memory (an object
// URL, or WASM/parsed-document heap memory) for as long as the page
// stays open.
let previewObjectUrl = null;
let previewSqliteDb = null;
let previewPdfDoc = null;

function closePreview() {
  els.previewModal.classList.add("hidden");
  els.previewBody.innerHTML = "";
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
  if (previewSqliteDb) {
    previewSqliteDb.close();
    previewSqliteDb = null;
  }
  if (previewPdfDoc) {
    previewPdfDoc.destroy();
    previewPdfDoc = null;
  }
}

// `onEdited` is called after a successful in-place SQLite save so the
// gallery that opened this preview can re-render; omitted (read-only
// session, e.g. an anonymous visitor on the public folder) disables saving.
async function previewEntry(session, entry, onEdited) {
  els.previewTitle.textContent = entry.name;
  els.previewBody.innerHTML = '<p class="hint">Decrypting…</p>';
  els.previewModal.classList.remove("hidden");

  let fileBytes;
  try {
    fileBytes = await fetchEntryBytes(session, entry, entry.chunked
      ? (completed, total) => { els.previewBody.innerHTML = `<p class="hint">Decrypting… (${completed}/${total} chunks)</p>`; }
      : undefined);
  } catch (err) {
    els.previewBody.innerHTML = `<p class="error">${err.message}</p>`;
    return;
  }

  // A big PDF/text file rendered inline means the browser's own PDF/text
  // viewer then has to parse and lay out the whole thing inside an
  // iframe - on top of the decrypt work above, that's enough to freeze
  // the tab for tens of seconds on a large (100MB+, many-hundred-page)
  // document, with nothing on screen suggesting it's still working
  // (confirmed live: the tab became unresponsive to screenshots for
  // 20-30s on a 200MB+ PDF before it finally rendered). Chunked implies
  // over CHUNK_SIZE (18MB) already, so gate just that case rather than
  // guessing at a separate size threshold. fileBytes are already decrypted
  // and cached at this point, so choosing to risk it costs nothing extra.
  const kindForGate = entry.type.split("/")[0];
  if (entry.chunked && (entry.type === "application/pdf" || kindForGate === "text")) {
    els.previewBody.innerHTML = "";
    const notice = document.createElement("div");
    notice.className = "preview-gate";
    const text = document.createElement("span");
    text.className = "hint";
    text.textContent = `${formatBytes(entry.size)} is too large`;
    const riskBtn = document.createElement("button");
    riskBtn.className = "danger";
    riskBtn.textContent = "Preview anyway";
    riskBtn.onclick = () => renderMedia();
    notice.append(text, riskBtn);
    els.previewBody.appendChild(notice);
    return;
  }

  if (isSqliteFile(entry)) {
    previewSqliteDb = await renderSqlitePreview(fileBytes, els.previewBody, {
      // Chunked entries aren't editable in place here - that would need
      // the same re-chunk-and-batch-commit machinery as a fresh upload,
      // not worth it for the in-browser SQLite editor. Small (single-blob)
      // entries still use the simple single-file overwrite pattern.
      onSave: session.token && !entry.chunked
        ? async (newDbBytes) => {
            // Re-fetch the blob's current sha right before writing (not
            // the one from when the preview opened) so a concurrent
            // change elsewhere isn't clobbered blind.
            const path = blobPath(session, entry.id);
            const current = await getFile({ owner: session.owner, repo: session.repo, token: session.token, path });
            const encrypted = await encryptBuffer(newDbBytes, session.key);
            await putFile({ owner: session.owner, repo: session.repo, token: session.token, path, bytes: encrypted, message: "edit: blob", sha: current?.sha });

            const { entries: freshEntries, sha: manifestSha } = await loadManifest(session);
            const idx = freshEntries.findIndex((e) => e.id === entry.id);
            if (idx !== -1) freshEntries[idx] = { ...freshEntries[idx], size: newDbBytes.length, uploadedAt: new Date().toISOString() };
            await saveManifest(session, freshEntries, manifestSha);
            decryptedCache.set(entry.id, newDbBytes); // the cached bytes are now stale ciphertext-wise; we already have the new plaintext in hand
            onEdited?.();
          }
        : undefined,
    });
    return;
  }

  renderMedia();

  async function renderMedia() {
    // PDFs go through pdf.js, one page at a time, instead of the native
    // <iframe> PDF viewer - that's what actually made loading a big
    // document freeze the tab (laying out every page up front), not
    // network/decrypt speed. See pdfPreview.js.
    if (entry.type === "application/pdf") {
      previewPdfDoc = await renderPdfPreview(fileBytes, els.previewBody);
      return;
    }

    const blob = new Blob([fileBytes], { type: entry.type });
    const url = URL.createObjectURL(blob);
    previewObjectUrl = url;
    els.previewBody.innerHTML = "";

    const kind = entry.type.split("/")[0];
    let el;
    if (kind === "image") {
      el = document.createElement("img");
      el.src = url;
    } else if (kind === "video") {
      el = document.createElement("video");
      el.src = url;
      el.controls = true;
    } else if (kind === "audio") {
      el = document.createElement("audio");
      el.src = url;
      el.controls = true;
    } else if (kind === "text") {
      // Browsers render plain text natively inside an <iframe>.
      el = document.createElement("iframe");
      el.src = url;
    } else {
      el = document.createElement("p");
      el.className = "hint";
      el.textContent = `No inline preview for ${entry.type || "this file type"} - use Download instead.`;
    }
    els.previewBody.appendChild(el);
  }
}

// One gallery = one folder's worth of upload/list/preview/delete state.
// Used twice: once for the logged-in user's own private folder, once for
// the shared "public" folder (readable/writable by anyone, but writable
// only once `getSession()` carries a token, i.e. someone is logged in).
function createGallery({ listEl, getSession, canManage }) {
  let entries = [];
  let thumbnailObjectUrls = [];

  function revokeThumbnails() {
    for (const url of thumbnailObjectUrls) URL.revokeObjectURL(url);
    thumbnailObjectUrls = [];
  }

  async function loadThumbnail(entry, imgEl) {
    try {
      const fileBytes = await fetchEntryBytes(getSession(), entry);
      const url = URL.createObjectURL(new Blob([fileBytes], { type: entry.type }));
      thumbnailObjectUrls.push(url);
      imgEl.src = url;
      imgEl.classList.remove("loading");
    } catch {
      imgEl.replaceWith(Object.assign(document.createElement("div"), { className: "file-icon", textContent: "⚠️" }));
    }
  }

  function render() {
    revokeThumbnails();
    listEl.innerHTML = "";
    listEl.className = "file-grid";
    if (entries.length === 0) {
      listEl.innerHTML = '<li class="empty">No files yet.</li>';
      return;
    }
    for (const entry of [...entries].reverse()) {
      const li = document.createElement("li");
      li.className = "file-tile";
      li.title = `${entry.name} · ${formatBytes(entry.size)} · ${new Date(entry.uploadedAt).toLocaleString()}`;
      li.onclick = () => previewEntry(getSession(), entry, canManage() ? render : undefined);

      const thumb = document.createElement("div");
      thumb.className = "file-thumb";
      if (entry.type?.startsWith("image/")) {
        const img = document.createElement("img");
        img.className = "loading";
        img.alt = entry.name;
        thumb.appendChild(img);
        loadThumbnail(entry, img); // fire-and-forget - fills in once decrypted
      } else {
        const icon = document.createElement("div");
        icon.className = "file-icon";
        icon.textContent = iconFor(entry);
        thumb.appendChild(icon);
      }

      const name = document.createElement("span");
      name.className = "file-tile-name";
      name.textContent = entry.name;

      const actions = document.createElement("div");
      actions.className = "file-tile-actions";
      const downloadBtn = document.createElement("button");
      downloadBtn.textContent = "⭳";
      downloadBtn.title = "Download";
      downloadBtn.onclick = (e) => {
        e.stopPropagation();
        const onProgress = entry.chunked
          ? (completed, total) => { downloadBtn.textContent = `${completed}/${total}`; }
          : undefined;
        downloadEntry(getSession(), entry, onProgress).finally(() => { downloadBtn.textContent = "⭳"; });
      };
      actions.append(downloadBtn);
      if (canManage()) {
        const deleteBtn = document.createElement("button");
        deleteBtn.textContent = "✕";
        deleteBtn.title = "Remove";
        deleteBtn.className = "danger";
        deleteBtn.onclick = (e) => { e.stopPropagation(); removeEntry(entry.id); };
        actions.append(deleteBtn);
      }

      li.append(thumb, name, actions);
      listEl.appendChild(li);
    }
  }

  async function refresh() {
    listEl.innerHTML = '<li class="empty">Loading…</li>';
    const result = await loadManifest(getSession());
    entries = result.entries;
    render();
  }

  // Creates every blob a single file needs (one if it fits under
  // CHUNK_SIZE, one per chunk otherwise) WITHOUT committing anything - the
  // caller batches these across many files into one commit. A folder
  // input's files carry webkitRelativePath (e.g. "myfolder/sub/file.txt")
  // - used as the stored name when present so folder structure survives
  // as part of the (encrypted) filename; a plain file picker leaves it ""
  // and falls back to the bare name.
  async function createBlobsForFile(file, session, onStatus) {
    const name = file.webkitRelativePath || file.name;
    const type = guessType(file);
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const id = crypto.randomUUID();

    if (fileBytes.length <= CHUNK_SIZE) {
      onStatus?.(`Encrypting ${name}…`);
      const encrypted = await encryptBuffer(fileBytes, session.key);
      const blobSha = await createBlob({ owner: session.owner, repo: session.repo, token: session.token, bytes: encrypted });
      return {
        manifestEntry: { id, name, type, size: file.size, uploadedAt: new Date().toISOString() },
        blobEntries: [{ path: blobPath(session, id), blobSha }],
      };
    }

    const chunks = splitIntoChunks(fileBytes);
    let uploaded = 0;
    const blobShas = await runWithConcurrency(chunks, CHUNK_UPLOAD_CONCURRENCY, async (chunk) => {
      const encrypted = await encryptBuffer(chunk, session.key);
      const sha = await createBlob({ owner: session.owner, repo: session.repo, token: session.token, bytes: encrypted });
      uploaded += 1;
      onStatus?.(`Uploading ${name}… (${uploaded}/${chunks.length} chunks)`);
      return sha;
    });
    const blobEntries = blobShas.map((blobSha, index) => ({ path: chunkPath(session, id, index), blobSha }));
    return {
      manifestEntry: { id, name, type, size: file.size, uploadedAt: new Date().toISOString(), chunked: true, chunkCount: chunks.length },
      blobEntries,
    };
  }

  // Batches many already-created blobs into ONE commit that ALSO updates
  // the manifest, via the Git Data API (see commitBatch in github.js).
  //
  // `baseEntries`, if given, is used as the starting point on the FIRST
  // attempt instead of re-reading the manifest - GitHub's Contents API GET
  // can return stale content for a path immediately after writing it (see
  // the read-path note atop github.js), which would otherwise silently
  // drop entries an earlier batch in this same upload just committed. A
  // retry (only reached after a genuine 409/422 conflict from commitBatch)
  // DOES re-read fresh, since at that point something really did change
  // underneath us and a stale local baseline would be actively wrong.
  async function commitFilesToManifest(session, blobEntries, newManifestEntries, message, baseEntries) {
    let attempt = 0;
    return commitBatch({
      owner: session.owner,
      repo: session.repo,
      token: session.token,
      message,
      buildEntries: async () => {
        const existing = attempt === 0 && baseEntries ? baseEntries : (await loadManifest(session)).entries;
        attempt += 1;
        const merged = [...existing, ...newManifestEntries];
        const manifestBytes = new TextEncoder().encode(JSON.stringify(merged));
        const manifestEncrypted = await encryptBuffer(manifestBytes, session.key);
        const manifestBlobSha = await createBlob({ owner: session.owner, repo: session.repo, token: session.token, bytes: manifestEncrypted });
        return [...blobEntries, { path: manifestPath(session), blobSha: manifestBlobSha }];
      },
    });
  }

  // A lone file that doesn't need chunking has nothing to batch with -
  // one Contents-API PUT already bundles blob+tree+commit+ref into a
  // single HTTP call, cheaper than the Git Data API's blob+ref-lookup+
  // tree+commit+ref-update sequence commitFilesToManifest needs. So the
  // common "pick one file" case stays on the plain putFile path; batching
  // only pays off once there's more than one blob to land together
  // (multiple files, or one file's worth of chunks).
  async function uploadSingleSmallFile(file, session, statusEl) {
    const name = file.webkitRelativePath || file.name;
    const type = guessType(file);
    statusEl.textContent = `Encrypting ${name}…`;
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const encrypted = await encryptBuffer(fileBytes, session.key);
    const id = crypto.randomUUID();

    statusEl.textContent = `Uploading ${name}…`;
    await putFile({ owner: session.owner, repo: session.repo, token: session.token, path: blobPath(session, id), bytes: encrypted, message: "store: blob" });

    const entry = { id, name, type, size: file.size, uploadedAt: new Date().toISOString() };
    statusEl.textContent = "Updating index…";
    const { entries: freshEntries, sha } = await loadManifest(session); // re-fetch sha to avoid a stale write
    await saveManifest(session, [...freshEntries, entry], sha);
    statusEl.textContent = `Done: ${name}`;
    return entry;
  }

  // Accepts a FileList (or array). Every file's blob(s) are created
  // concurrently (FILE_UPLOAD_CONCURRENCY at once, no commit contention at
  // that stage - createBlob just writes loose objects), then committed in
  // batches of COMMIT_BATCH_SIZE files: one commit per batch instead of
  // one per file/chunk, which is what actually bounds upload time on a
  // big multi-file/folder upload (GitHub's Contents API can only land one
  // commit at a time, no matter how many PUTs are in flight). A final
  // flush after the loop commits whatever's left under a full batch.
  async function upload(files, statusEl) {
    const session = getSession();
    const fileArray = Array.from(files);

    if (fileArray.length === 1 && fileArray[0].size <= CHUNK_SIZE) {
      const entry = await uploadSingleSmallFile(fileArray[0], session, statusEl);
      // Update local state directly rather than re-fetching the manifest we
      // just wrote - GitHub's Contents API GET can return stale content for
      // a path immediately after writing it (see the read-path caching note
      // atop github.js), which would silently show the old (pre-upload)
      // list even though the commit genuinely landed.
      entries = [...entries, entry];
      render();
      return;
    }

    let pending = [];
    let commitQueue = Promise.resolve();
    let committedCount = 0;
    const committedEntries = [];
    let baseEntries = entries; // grows after each batch so a later batch's commit doesn't need to re-read (and risk a stale read of) what an earlier batch in this same upload just wrote
    function flush() {
      if (pending.length === 0) return commitQueue;
      const batch = pending;
      pending = [];
      commitQueue = commitQueue.then(async () => {
        const batchManifestEntries = batch.map((b) => b.manifestEntry);
        await commitFilesToManifest(
          session,
          batch.flatMap((b) => b.blobEntries),
          batchManifestEntries,
          `store: ${batch.length} file(s)`,
          baseEntries
        );
        baseEntries = [...baseEntries, ...batchManifestEntries];
        committedCount += batch.length;
        committedEntries.push(...batchManifestEntries);
        statusEl.textContent = `Committed ${committedCount}/${fileArray.length} file(s)…`;
      });
      return commitQueue;
    }

    // Files upload FILE_UPLOAD_CONCURRENCY at a time, so createBlobsForFile's
    // own per-file/per-chunk status messages (below) interleave unpredictably
    // - preparedCount gives a steady, monotonic "N/Total" on top of that
    // instead of only ever moving at commit checkpoints.
    let preparedCount = 0;
    await runWithConcurrency(fileArray, FILE_UPLOAD_CONCURRENCY, async (file) => {
      const result = await createBlobsForFile(file, session, (msg) => { statusEl.textContent = msg; });
      preparedCount += 1;
      statusEl.textContent = `Prepared ${preparedCount}/${fileArray.length} file(s)…`;
      pending.push(result);
      if (pending.length >= COMMIT_BATCH_SIZE) await flush();
    });
    await flush();

    // Update local state directly rather than re-fetching the manifest we
    // just wrote - see the comment on the single-file fast path above for
    // why: an immediate re-read can come back stale even after a genuinely
    // landed commit.
    entries = [...entries, ...committedEntries];
    render();
    statusEl.textContent = fileArray.length > 1 ? `Done: ${fileArray.length} files.` : `Done: ${fileArray[0].name}`;
  }

  async function removeEntry(id) {
    // Removes the entry from the index only - the encrypted blob itself
    // stays in git history (git doesn't cheaply "forget" old commits).
    // Good enough for "stop showing it in the list"; not a real delete.
    if (!confirm("Remove this from your file list? (The underlying git history isn't erased.)")) return;
    const session = getSession();
    const nextEntries = entries.filter((e) => e.id !== id);
    const { sha } = await loadManifest(session); // re-fetch sha to avoid a stale write
    await saveManifest(session, nextEntries, sha);
    entries = nextEntries;
    decryptedCache.delete(id); // frees the (possibly large) decrypted bytes now that nothing references this entry
    render();
  }

  return { refresh, upload };
}

let currentSession = null;

const privateGallery = createGallery({
  listEl: els.fileList,
  getSession: () => currentSession,
  canManage: () => true,
});

function publicSession() {
  // Reuses whatever GitHub token the logged-in user has (writes need
  // auth); with no one logged in, token is undefined and reads fall back
  // to the unauthenticated public endpoint (see fetchFile).
  return { owner: OWNER, repo: REPO, token: currentSession?.token, folder: PUBLIC_FOLDER, key: PUBLIC_KEY };
}

const publicGallery = createGallery({
  listEl: els.publicFileList,
  getSession: publicSession,
  canManage: () => !!currentSession,
});

function showApp(session) {
  currentSession = session;
  els.loginForm.classList.add("hidden");
  els.app.classList.remove("hidden");
  els.whoami.textContent = `Logged in as ${session.folder}`;
  els.publicUploadRow.classList.remove("hidden");
  privateGallery.refresh().catch((err) => {
    els.fileList.innerHTML = `<li class="empty error">Failed to load: ${err.message}</li>`;
  });
  // Re-run with the now-available token, mainly so delete buttons show up.
  publicGallery.refresh().catch((err) => {
    els.publicFileList.innerHTML = `<li class="empty error">Failed to load: ${err.message}</li>`;
  });
}

// Fetches blobs/<username>/pat.enc unauthenticated (getPublicFile - no
// token exists yet at this point) and decrypts it with the entered
// password to recover the real GitHub PAT an admin stored via
// `store-pat`. This is the one request in the whole app that isn't
// authenticated.
async function resolveToken({ username, password }) {
  const stored = await getPublicFile({ owner: OWNER, repo: REPO, path: `blobs/${username}/pat.enc` });
  if (!stored) {
    throw new Error(`No account found for "${username}" - ask the admin to set one up first.`);
  }
  const decrypted = await decryptBuffer(stored.bytes, password);
  return new TextDecoder().decode(decrypted);
}

els.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = els.loginUsername.value.trim();
  const password = els.loginPassword.value;

  if (!username || !password) {
    els.loginError.textContent = "Username and password are required.";
    return;
  }

  els.loginError.textContent = "";
  els.loginStatus.textContent = "Logging in…";
  try {
    const token = await resolveToken({ username, password });
    els.loginStatus.textContent = "";
    // Internally still {folder, key} - that's the vocabulary the storage
    // layer (crypto.js/github.js/manifest logic) is built around; the
    // username/password framing is a login-screen-only relabeling of the
    // same underlying folder+key concept.
    const session = { token, owner: OWNER, repo: REPO, folder: username, key: password };
    saveSession(session);
    showApp(session);
  } catch (err) {
    els.loginStatus.textContent = "";
    // A wrong password still fetches pat.enc fine (it's public) but fails
    // to decrypt it - GCM's auth tag check throws, which reads to the
    // user as a generic "operation failed" from SubtleCrypto, so we give
    // a clearer message for the common case instead of the raw error.
    els.loginError.textContent = err.message.includes("No account found")
      ? err.message
      : "Wrong username or password.";
  }
});

els.logoutBtn.addEventListener("click", () => {
  clearSession();
  currentSession = null;
  els.app.classList.add("hidden");
  els.loginForm.classList.remove("hidden");
  els.publicUploadRow.classList.add("hidden");
  publicGallery.refresh().catch((err) => {
    els.publicFileList.innerHTML = `<li class="empty error">Failed to load: ${err.message}</li>`;
  });
});

els.refreshBtn.addEventListener("click", () => {
  privateGallery.refresh().catch((err) => alert(`Refresh failed: ${err.message}`));
});

async function handlePick(input, gallery, statusEl) {
  // input.files is a LIVE FileList - clearing input.value clears that same
  // object in place, so capturing it and then resetting value would empty
  // this reference too (confirmed live: the resulting length check always
  // saw 0, silently no-opping every upload with no error and no network
  // call). Array.from() snapshots the files into a real array first, so
  // resetting the input afterward doesn't touch them.
  const files = Array.from(input.files);
  input.value = "";
  if (!files.length) return;
  try {
    await gallery.upload(files, statusEl);
  } catch (err) {
    statusEl.textContent = `Upload failed: ${err.message}`;
  }
}

els.fileInput.addEventListener("change", () => handlePick(els.fileInput, privateGallery, els.uploadStatus));
els.folderInput.addEventListener("change", () => handlePick(els.folderInput, privateGallery, els.uploadStatus));

els.publicRefreshBtn.addEventListener("click", () => {
  publicGallery.refresh().catch((err) => alert(`Refresh failed: ${err.message}`));
});

els.publicFileInput.addEventListener("change", () => handlePick(els.publicFileInput, publicGallery, els.publicUploadStatus));
els.publicFolderInput.addEventListener("change", () => handlePick(els.publicFolderInput, publicGallery, els.publicUploadStatus));

els.previewClose.addEventListener("click", closePreview);
els.previewModal.addEventListener("click", (e) => {
  if (e.target === els.previewModal) closePreview(); // click on the dimmed backdrop, not the panel itself
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.previewModal.classList.contains("hidden")) closePreview();
});

const existingSession = loadSession();
if (existingSession) {
  showApp(existingSession);
} else {
  publicGallery.refresh().catch((err) => {
    els.publicFileList.innerHTML = `<li class="empty error">Failed to load: ${err.message}</li>`;
  });
}
