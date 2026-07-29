#!/usr/bin/env node
// =====================================================================
// src/cli.js
// ---------------------------------------------------------------------
// Manual end-to-end check against the real GitHub + jsDelivr APIs - the
// one thing the mocked test suite can't validate (whether jsDelivr
// actually serves a freshly-committed file).
//
//   node src/cli.js upload <folder> ./photo.png
//   node src/cli.js download <cdn_url> ./out.png
//   node src/cli.js store-pat <folder> <friend's-pat>
//
// <folder> selects which key encrypts the upload (from ENCRYPTION_KEYS -
// see .env.example). download doesn't take a folder: the folder is
// parsed out of the cdn_url itself, and the key is looked up from
// whichever keys THIS .env happens to have - so running this with
// quantran's single-key .env against admin's folder correctly fails.
//
// store-pat is admin-only (uses THIS .env's GITHUB_TOKEN to write, same
// as upload) - it's how a friend's web login stops needing them to paste
// their own token in every time. See githubStore.js's storePat() for the
// security trade-off this introduces before using it.
// =====================================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { uploadFile, downloadFile, storePat } from "./githubStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// No dotenv dependency (per the prototype's "no deps beyond Node
// built-ins" goal) - just enough parsing to read KEY=VALUE lines.
async function loadEnvFile() {
  const envPath = path.join(__dirname, "..", ".env");
  let contents;
  try {
    contents = await fs.readFile(envPath, "utf8");
  } catch {
    return; // no .env - fall through to whatever's already in process.env
  }
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

// ENCRYPTION_KEYS is "folder:key,folder:key,..." - e.g.
// "admin:tung1883,quantran:quantran" - mirrors the comma-separated
// multi-value env convention telecord itself uses for bot tokens.
function parseKeys(raw) {
  const keys = {};
  for (const pair of String(raw || "").split(",")) {
    const [folder, ...rest] = pair.split(":");
    const key = rest.join(":").trim();
    if (folder?.trim() && key) keys[folder.trim()] = key;
  }
  return keys;
}

function loadConfig() {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, ENCRYPTION_KEYS } = process.env;
  const missing = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO", "ENCRYPTION_KEYS"].filter(
    (key) => !process.env[key]
  );
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")} (see .env.example)`);
  }
  const keys = parseKeys(ENCRYPTION_KEYS);
  if (Object.keys(keys).length === 0) {
    throw new Error(`ENCRYPTION_KEYS didn't parse to any folder:key pairs - got "${ENCRYPTION_KEYS}"`);
  }
  return { token: GITHUB_TOKEN, owner: GITHUB_OWNER, repo: GITHUB_REPO, keys };
}

async function main() {
  await loadEnvFile();
  const [command, ...args] = process.argv.slice(2);
  const config = loadConfig();

  if (command === "upload") {
    const [folder, filePath] = args;
    if (!folder || !filePath) throw new Error("usage: node src/cli.js upload <folder> <path>");
    const buffer = await fs.readFile(filePath);
    const result = await uploadFile({ buffer, fileName: path.basename(filePath), folder, config });
    console.log(`Uploaded ${filePath} (${buffer.length} bytes plaintext)`);
    console.log(`  path:       ${result.path}`);
    console.log(`  commit_sha: ${result.commit_sha}`);
    console.log(`  cdn_url:    ${result.cdn_url}`);
    return;
  }

  if (command === "download") {
    const [cdnUrl, outPath] = args;
    if (!cdnUrl || !outPath) throw new Error("usage: node src/cli.js download <cdn_url> <out_path>");
    const buffer = await downloadFile({ cdnUrl, config });
    await fs.writeFile(outPath, buffer);
    console.log(`Downloaded + decrypted -> ${outPath} (${buffer.length} bytes)`);
    return;
  }

  if (command === "store-pat") {
    const [folder, pat] = args;
    if (!folder || !pat) throw new Error("usage: node src/cli.js store-pat <folder> <pat>");
    const result = await storePat({ folder, pat, config });
    console.log(`Stored encrypted PAT for folder "${folder}" at ${result.path}`);
    return;
  }

  throw new Error(`unknown command "${command}" - expected "upload", "download", or "store-pat"`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
