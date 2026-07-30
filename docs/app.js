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
// =====================================================================

import { encryptBuffer, decryptBuffer, packEnvelope, unpackEnvelope } from "./crypto.js";
import { getFile, putFile, getPublicFile } from "./github.js";
import { isSqliteFile, renderSqlitePreview } from "./sqlitePreview.js";

const OWNER = "tung1388";
const REPO = "project_cuoi_ky";

const STORAGE_KEY = "githost.session";

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
  uploadStatus: document.getElementById("upload-status"),
  fileList: document.getElementById("file-list"),
  refreshBtn: document.getElementById("refresh-btn"),
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

async function loadManifest(session) {
  const existing = await getFile({ ...session, path: manifestPath(session) });
  if (!existing) return { entries: [], sha: null };
  const decrypted = await decryptBuffer(existing.bytes, session.key);
  const entries = JSON.parse(new TextDecoder().decode(decrypted));
  return { entries, sha: existing.sha };
}

async function saveManifest(session, entries, sha) {
  const bytes = new TextEncoder().encode(JSON.stringify(entries));
  const encrypted = await encryptBuffer(bytes, session.key);
  await putFile({
    ...session,
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

// Object URLs created for auto-loaded image thumbnails - tracked so they
// can all be revoked before the next render, otherwise every refresh
// leaks the previous batch (Blob URLs aren't garbage-collected on their
// own).
let thumbnailObjectUrls = [];
function revokeThumbnails() {
  for (const url of thumbnailObjectUrls) URL.revokeObjectURL(url);
  thumbnailObjectUrls = [];
}

async function loadThumbnail(entry, imgEl) {
  try {
    const fileBytes = await fetchEntryBytes(entry);
    const url = URL.createObjectURL(new Blob([fileBytes], { type: entry.type }));
    thumbnailObjectUrls.push(url);
    imgEl.src = url;
    imgEl.classList.remove("loading");
  } catch {
    imgEl.replaceWith(Object.assign(document.createElement("div"), { className: "file-icon", textContent: "⚠️" }));
  }
}

function renderList(entries) {
  revokeThumbnails();
  els.fileList.innerHTML = "";
  els.fileList.className = "file-grid";
  if (entries.length === 0) {
    els.fileList.innerHTML = '<li class="empty">No files yet.</li>';
    return;
  }
  for (const entry of [...entries].reverse()) {
    const li = document.createElement("li");
    li.className = "file-tile";
    li.title = `${entry.name} · ${formatBytes(entry.size)} · ${new Date(entry.uploadedAt).toLocaleString()}`;
    li.onclick = () => previewEntry(entry);

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
    downloadBtn.onclick = (e) => { e.stopPropagation(); downloadEntry(entry); };
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "✕";
    deleteBtn.title = "Remove";
    deleteBtn.className = "danger";
    deleteBtn.onclick = (e) => { e.stopPropagation(); removeEntry(entry.id); };
    actions.append(downloadBtn, deleteBtn);

    li.append(thumb, name, actions);
    els.fileList.appendChild(li);
  }
}

let currentSession = null;
let currentEntries = [];
let currentManifestSha = null;

async function refresh() {
  els.fileList.innerHTML = '<li class="empty">Loading…</li>';
  const { entries, sha } = await loadManifest(currentSession);
  currentEntries = entries;
  currentManifestSha = sha;
  renderList(entries);
}

// Browsers generally don't recognize .sqlite/.db as a MIME type, so
// file.type comes back as "" for them - fall back to the extension so
// the manifest still records a type the preview can recognize later.
function guessType(file) {
  if (file.type) return file.type;
  if (/\.(sqlite3?|db3?)$/i.test(file.name)) return "application/vnd.sqlite3";
  return "application/octet-stream";
}

async function handleUpload(file) {
  els.uploadStatus.textContent = `Encrypting ${file.name}…`;
  const type = guessType(file);
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const envelope = packEnvelope({ name: file.name, type }, fileBytes);
  const encrypted = await encryptBuffer(envelope, currentSession.key);

  const id = crypto.randomUUID();
  els.uploadStatus.textContent = `Uploading ${file.name}…`;
  await putFile({
    ...currentSession,
    path: blobPath(currentSession, id),
    bytes: encrypted,
    message: `store: ${file.name}`,
  });

  const entry = { id, name: file.name, type, size: file.size, uploadedAt: new Date().toISOString() };
  els.uploadStatus.textContent = "Updating index…";
  const nextEntries = [...currentEntries, entry];
  await saveManifest(currentSession, nextEntries, currentManifestSha);
  currentEntries = nextEntries;
  currentManifestSha = null; // stale after the write above; refresh() re-fetches it if needed

  els.uploadStatus.textContent = `Done: ${file.name}`;
  renderList(currentEntries);
}

// Fetch + decrypt + unpack an uploaded entry - shared by download and
// preview, which only differ in what they do with the resulting bytes.
async function fetchEntryBytes(entry) {
  const stored = await getFile({ ...currentSession, path: blobPath(currentSession, entry.id) });
  if (!stored) {
    throw new Error(`${entry.name} is missing from the repo (was it deleted outside this app?).`);
  }
  const decrypted = await decryptBuffer(stored.bytes, currentSession.key);
  return unpackEnvelope(decrypted).fileBytes;
}

async function downloadEntry(entry) {
  let fileBytes;
  try {
    fileBytes = await fetchEntryBytes(entry);
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

// Tracks the last object URL / open sql.js Database shown in the preview
// modal so both can be released when replaced or closed - otherwise each
// preview leaks memory (an object URL, or WASM-heap memory for a SQLite
// DB) for as long as the page stays open.
let previewObjectUrl = null;
let previewSqliteDb = null;

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
}

async function previewEntry(entry) {
  els.previewTitle.textContent = entry.name;
  els.previewBody.innerHTML = '<p class="hint">Decrypting…</p>';
  els.previewModal.classList.remove("hidden");

  let fileBytes;
  try {
    fileBytes = await fetchEntryBytes(entry);
  } catch (err) {
    els.previewBody.innerHTML = `<p class="error">${err.message}</p>`;
    return;
  }

  if (isSqliteFile(entry)) {
    previewSqliteDb = await renderSqlitePreview(fileBytes, els.previewBody);
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
  } else if (entry.type === "application/pdf" || kind === "text") {
    // Browsers render PDFs and plain text natively inside an <iframe>.
    el = document.createElement("iframe");
    el.src = url;
  } else {
    el = document.createElement("p");
    el.className = "hint";
    el.textContent = `No inline preview for ${entry.type || "this file type"} - use Download instead.`;
  }
  els.previewBody.appendChild(el);
}

async function removeEntry(id) {
  // Removes the entry from the index only - the encrypted blob itself
  // stays in git history (git doesn't cheaply "forget" old commits).
  // Good enough for "stop showing it in the list"; not a real delete.
  if (!confirm("Remove this from your file list? (The underlying git history isn't erased.)")) return;
  const nextEntries = currentEntries.filter((e) => e.id !== id);
  const { sha } = await loadManifest(currentSession); // re-fetch sha to avoid a stale write
  await saveManifest(currentSession, nextEntries, sha);
  currentEntries = nextEntries;
  renderList(currentEntries);
}

function showApp(session) {
  currentSession = session;
  els.loginForm.classList.add("hidden");
  els.app.classList.remove("hidden");
  els.whoami.textContent = `Logged in as ${session.folder}`;
  refresh().catch((err) => {
    els.fileList.innerHTML = `<li class="empty error">Failed to load: ${err.message}</li>`;
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
});

els.refreshBtn.addEventListener("click", () => {
  refresh().catch((err) => alert(`Refresh failed: ${err.message}`));
});

els.fileInput.addEventListener("change", async () => {
  const file = els.fileInput.files[0];
  els.fileInput.value = "";
  if (!file) return;
  try {
    await handleUpload(file);
  } catch (err) {
    els.uploadStatus.textContent = `Upload failed: ${err.message}`;
  }
});

els.previewClose.addEventListener("click", closePreview);
els.previewModal.addEventListener("click", (e) => {
  if (e.target === els.previewModal) closePreview(); // click on the dimmed backdrop, not the panel itself
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.previewModal.classList.contains("hidden")) closePreview();
});

const existingSession = loadSession();
if (existingSession) showApp(existingSession);
