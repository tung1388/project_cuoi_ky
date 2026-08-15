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
// Renders a WINDOW of WINDOW_SIZE pages at a time onto stacked <canvas>
// elements, scrollable within that window - not the whole document at
// once (handing everything to the browser's native <iframe> PDF viewer
// meant it had to lay out every page up front, which was the actual
// cause of the tab freezing on large PDFs, not network/decrypt speed),
// and not strictly one page at a time either (loses the "scroll through
// a few pages" feel of a normal viewer). Prev/Next page through windows
// of pages; a page-number field and a table-of-contents panel (from the
// PDF's own outline, when it has one) both jump straight to a page,
// which re-centers the window there.
// =====================================================================

const PDF_JS_VERSION = "6.2.108";
const PDF_JS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDF_JS_VERSION}/build/`;
const WINDOW_SIZE = 10;

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

// Builds a <ul> of clickable table-of-contents entries from pdf.js's
// getOutline() result (a tree of {title, dest, items}), recursing into
// nested sections. `dest` is either a named destination (string, needs
// doc.getDestination() to resolve) or already an explicit destination
// array - both end with a page *reference*, not a page number, hence
// getPageIndex() to turn that into one.
function buildTocList(items, doc, onJump) {
  const ul = document.createElement("ul");
  ul.className = "pdf-toc-list";
  for (const item of items) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = item.title || "(untitled)";
    link.onclick = async (e) => {
      e.preventDefault();
      const pageNum = await resolveDestPage(doc, item.dest);
      if (pageNum) onJump(pageNum);
    };
    li.appendChild(link);
    if (item.items?.length) li.appendChild(buildTocList(item.items, doc, onJump));
    ul.appendChild(li);
  }
  return ul;
}

async function resolveDestPage(doc, dest) {
  try {
    const explicitDest = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!explicitDest) return null;
    return (await doc.getPageIndex(explicitDest[0])) + 1;
  } catch {
    return null; // a malformed/broken outline entry shouldn't take down the whole TOC
  }
}

/**
 * Renders a windowed, scrollable PDF viewer for `bytes` (raw decrypted
 * PDF) into `container`. Returns the opened pdf.js document so the
 * caller can clean it up (`doc.destroy()`) once the preview is dismissed
 * - same idea as sqlitePreview's returned Database, just for pdf.js's
 * parsed state.
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
  const tocToggleBtn = document.createElement("button");
  tocToggleBtn.className = "secondary hidden";
  tocToggleBtn.textContent = "Contents";
  const prevBtn = document.createElement("button");
  prevBtn.className = "secondary";
  prevBtn.textContent = `◀ ${WINDOW_SIZE}`;
  const pageInput = document.createElement("input");
  pageInput.type = "number";
  pageInput.min = "1";
  pageInput.className = "pdf-page-input";
  const totalLabel = document.createElement("span");
  totalLabel.className = "hint";
  totalLabel.textContent = `/ ${doc.numPages}`;
  const nextBtn = document.createElement("button");
  nextBtn.className = "secondary";
  nextBtn.textContent = `${WINDOW_SIZE} ▶`;
  const rangeLabel = document.createElement("span");
  rangeLabel.className = "hint";
  toolbar.append(tocToggleBtn, prevBtn, pageInput, totalLabel, nextBtn, rangeLabel);

  const body = document.createElement("div");
  body.className = "pdf-body";
  const tocPanel = document.createElement("div");
  tocPanel.className = "pdf-toc hidden";
  const pagesContainer = document.createElement("div");
  pagesContainer.className = "pdf-pages";
  body.append(tocPanel, pagesContainer);

  wrap.append(toolbar, body);
  container.appendChild(wrap);

  let windowStart = 1;
  let renderGeneration = 0; // bumped on every window change - lets an in-flight render notice it's stale and stop early
  let currentPageObserver = null;

  async function renderWindow(requestedStart) {
    const gen = ++renderGeneration;
    const maxStart = Math.max(1, doc.numPages - WINDOW_SIZE + 1);
    windowStart = Math.max(1, Math.min(requestedStart, maxStart));
    const endPage = Math.min(doc.numPages, windowStart + WINDOW_SIZE - 1);

    pageInput.value = windowStart;
    prevBtn.disabled = windowStart <= 1;
    nextBtn.disabled = endPage >= doc.numPages;
    rangeLabel.textContent = `(pages ${windowStart}–${endPage})`;

    currentPageObserver?.disconnect();
    pagesContainer.innerHTML = '<p class="hint">Loading pages…</p>';
    const frag = document.createDocumentFragment();
    const pageEls = [];
    for (let p = windowStart; p <= endPage; p += 1) {
      const pageWrap = document.createElement("div");
      pageWrap.className = "pdf-page";
      pageWrap.dataset.page = String(p);
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-canvas";
      pageWrap.appendChild(canvas);
      frag.appendChild(pageWrap);
      pageEls.push({ p, canvas, pageWrap });
    }
    pagesContainer.innerHTML = "";
    pagesContainer.appendChild(frag);
    pagesContainer.scrollTop = 0;

    // Tracks whichever page is most visible while scrolling within the
    // window and reflects it in the page field - the closest thing to
    // "the page number" a windowed (not fully virtualized) view can give
    // without re-fetching on every scroll tick.
    currentPageObserver = new IntersectionObserver(
      (observerEntries) => {
        let best = null;
        for (const e of observerEntries) {
          if (e.isIntersecting && (!best || e.intersectionRatio > best.intersectionRatio)) best = e;
        }
        if (best && document.activeElement !== pageInput) {
          pageInput.value = best.target.dataset.page;
        }
      },
      { root: pagesContainer, threshold: [0.5] }
    );

    for (const { p, canvas, pageWrap } of pageEls) {
      if (gen !== renderGeneration) return; // a newer window request superseded this one
      currentPageObserver.observe(pageWrap);
      const page = await doc.getPage(p);
      const unscaledWidth = page.getViewport({ scale: 1 }).width;
      const fitWidth = pagesContainer.clientWidth || 640;
      const viewport = page.getViewport({ scale: Math.min(2, fitWidth / unscaledWidth) });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      try {
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      } catch (err) {
        if (err?.name !== "RenderingCancelledException") throw err;
      }
    }
  }

  prevBtn.onclick = () => renderWindow(windowStart - WINDOW_SIZE);
  nextBtn.onclick = () => renderWindow(windowStart + WINDOW_SIZE);
  pageInput.addEventListener("change", () => {
    const n = parseInt(pageInput.value, 10);
    if (Number.isFinite(n)) renderWindow(n);
  });

  let outline = null;
  try {
    outline = await doc.getOutline();
  } catch {
    outline = null; // a PDF with a broken/unsupported outline just skips the TOC panel
  }
  if (outline && outline.length) {
    tocToggleBtn.classList.remove("hidden");
    tocPanel.appendChild(buildTocList(outline, doc, (pageNum) => {
      renderWindow(pageNum);
      tocPanel.classList.add("hidden");
    }));
    tocToggleBtn.onclick = () => tocPanel.classList.toggle("hidden");
  }

  await renderWindow(1);
  return doc;
}
