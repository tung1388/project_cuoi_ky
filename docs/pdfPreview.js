// =====================================================================
// docs/pdfPreview.js
// ---------------------------------------------------------------------
// In-browser PDF viewer using pdf.js, loaded lazily from jsDelivr's npm
// CDN - only when someone actually opens a PDF, mirroring
// sqlitePreview.js's lazy-CDN-dependency pattern. pdf.js ships a real ES
// module build, so this uses dynamic import() rather than sql.js's
// manual <script>-injection (that trick exists there only because sql.js
// is a classic global script, not a module).
//
// Renders ONE page at a time onto a <canvas>, instead of handing the
// whole decrypted PDF to the browser's native <iframe> PDF viewer: pdf.js
// only has to parse the document's page tree and render whichever page
// is currently visible, not lay out every page up front. That up-front
// layout of a many-hundred-page document was the actual cause of the tab
// freezing on large PDFs (see the chunked-PDF size gate in docs/app.js),
// not network/decrypt speed - first-page render here is close to instant
// even for a 1000+ page document, since pages are parsed on demand.
// =====================================================================

const PDF_JS_VERSION = "6.2.108";
const PDF_JS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDF_JS_VERSION}/build/`;

let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(`${PDF_JS_BASE}pdf.min.mjs`).then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDF_JS_BASE}pdf.worker.min.mjs`;
      return pdfjsLib;
    });
  }
  return pdfjsPromise;
}

/**
 * Renders a one-page-at-a-time PDF viewer for `bytes` (raw decrypted PDF)
 * into `container`. Returns the opened pdf.js document so the caller can
 * clean it up (`doc.destroy()`) once the preview is dismissed - same idea
 * as sqlitePreview's returned Database, just for pdf.js's parsed state.
 */
export async function renderPdfPreview(bytes, container) {
  container.innerHTML = '<p class="hint">Loading PDF engine…</p>';
  let pdfjsLib;
  try {
    pdfjsLib = await loadPdfJs();
  } catch (err) {
    container.innerHTML = `<p class="error">Couldn't load the PDF engine: ${err.message}</p>`;
    return null;
  }

  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  } catch (err) {
    container.innerHTML = `<p class="error">Not a valid PDF: ${err.message}</p>`;
    return null;
  }

  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "pdf-preview";

  const toolbar = document.createElement("div");
  toolbar.className = "pdf-toolbar";
  const prevBtn = document.createElement("button");
  prevBtn.className = "secondary";
  prevBtn.textContent = "◀";
  const pageLabel = document.createElement("span");
  pageLabel.className = "hint";
  const nextBtn = document.createElement("button");
  nextBtn.className = "secondary";
  nextBtn.textContent = "▶";
  toolbar.append(prevBtn, pageLabel, nextBtn);

  const canvas = document.createElement("canvas");
  canvas.className = "pdf-canvas";

  wrap.append(toolbar, canvas);
  container.appendChild(wrap);

  let pageNum = 1;
  let renderTask = null;

  async function renderPage() {
    pageLabel.textContent = `Page ${pageNum} / ${doc.numPages}`;
    prevBtn.disabled = pageNum <= 1;
    nextBtn.disabled = pageNum >= doc.numPages;

    const page = await doc.getPage(pageNum);
    const unscaledWidth = page.getViewport({ scale: 1 }).width;
    const fitWidth = wrap.clientWidth || 640;
    const viewport = page.getViewport({ scale: Math.min(2, fitWidth / unscaledWidth) });
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    if (renderTask) renderTask.cancel(); // a fast prev/next click can outrun the previous page's still-in-flight render
    renderTask = page.render({ canvasContext: canvas.getContext("2d"), viewport });
    try {
      await renderTask.promise;
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") throw err;
    }
  }

  prevBtn.onclick = () => {
    if (pageNum > 1) { pageNum -= 1; renderPage(); }
  };
  nextBtn.onclick = () => {
    if (pageNum < doc.numPages) { pageNum += 1; renderPage(); }
  };

  await renderPage();
  return doc;
}
