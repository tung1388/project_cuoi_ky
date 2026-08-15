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
// Feels like the browser's native PDF viewer - one continuous scroll
// through the whole document - but doesn't render everything up front:
// every page gets an empty placeholder (sized from page 1's dimensions,
// so the scrollbar reflects the true document length immediately), and
// an IntersectionObserver renders a page's actual canvas only once it's
// within PRELOAD_MARGIN_PX of the viewport, evicting it back to a
// placeholder once it scrolls back out - bounded memory regardless of
// document length. Handing the whole decrypted PDF to a native <iframe>
// viewer instead (the previous approach) meant the browser had to lay
// out every page up front, which was the actual cause of the tab
// freezing on large PDFs, not network/decrypt speed.
// =====================================================================

const PDF_JS_VERSION = "6.2.108";
const PDF_JS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDF_JS_VERSION}/build/`;
const PRELOAD_MARGIN_PX = 1200; // how far outside the viewport to render/evict pages - big enough that fast scrolling rarely outruns it

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
 * Renders a continuous-scroll PDF viewer for `bytes` (raw decrypted PDF)
 * into `container`. Returns the opened pdf.js document so the caller can
 * clean it up (`doc.destroy()`) once the preview is dismissed - same
 * idea as sqlitePreview's returned Database, just for pdf.js's parsed
 * state.
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
  prevBtn.textContent = "◀";
  prevBtn.title = "Previous page";
  const pageInput = document.createElement("input");
  pageInput.type = "number";
  pageInput.min = "1";
  pageInput.max = String(doc.numPages);
  pageInput.className = "pdf-page-input";
  const totalLabel = document.createElement("span");
  totalLabel.className = "hint";
  totalLabel.textContent = `/ ${doc.numPages}`;
  const nextBtn = document.createElement("button");
  nextBtn.className = "secondary";
  nextBtn.textContent = "▶";
  nextBtn.title = "Next page";
  toolbar.append(tocToggleBtn, prevBtn, pageInput, totalLabel, nextBtn);

  const body = document.createElement("div");
  body.className = "pdf-body";
  const tocPanel = document.createElement("div");
  tocPanel.className = "pdf-toc hidden";
  const pagesContainer = document.createElement("div");
  pagesContainer.className = "pdf-pages";
  body.append(tocPanel, pagesContainer);

  wrap.append(toolbar, body);
  container.appendChild(wrap);

  // Most documents use one page size throughout - page 1's dimensions
  // become every placeholder's reserved aspect ratio, so the scrollbar
  // already reflects the true document length before anything else
  // renders. A page that turns out a different size just corrects its
  // own placeholder once it actually renders (see ensureRendered).
  const firstPage = await doc.getPage(1);
  const firstViewport = firstPage.getViewport({ scale: 1 });
  const placeholderRatio = `${firstViewport.width} / ${firstViewport.height}`;

  const pageStates = []; // { p, pageWrap, rendered, renderPromise }
  const frag = document.createDocumentFragment();
  for (let p = 1; p <= doc.numPages; p += 1) {
    const pageWrap = document.createElement("div");
    pageWrap.className = "pdf-page";
    pageWrap.dataset.page = String(p);
    pageWrap.style.aspectRatio = placeholderRatio;
    frag.appendChild(pageWrap);
    pageStates.push({ p, pageWrap, rendered: false, renderPromise: null });
  }
  pagesContainer.appendChild(frag);

  async function ensureRendered(state) {
    if (state.rendered || state.renderPromise) return state.renderPromise;
    state.renderPromise = (async () => {
      const page = await doc.getPage(state.p);
      const unscaledWidth = page.getViewport({ scale: 1 }).width;
      const fitWidth = pagesContainer.clientWidth || 640;
      const viewport = page.getViewport({ scale: Math.min(2, fitWidth / unscaledWidth) });
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-canvas";
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      try {
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      } catch (err) {
        if (err?.name !== "RenderingCancelledException") throw err;
        return; // cancelled by an evict() that raced this render - leave the placeholder as-is
      }
      state.pageWrap.style.aspectRatio = ""; // now sized by the real canvas, not the page-1 estimate
      state.pageWrap.innerHTML = "";
      state.pageWrap.appendChild(canvas);
      state.rendered = true;
    })().finally(() => {
      state.renderPromise = null;
    });
    return state.renderPromise;
  }

  function evict(state) {
    if (!state.rendered) return;
    state.rendered = false;
    state.pageWrap.innerHTML = "";
    state.pageWrap.style.aspectRatio = placeholderRatio;
  }

  const preloadObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const state = pageStates[Number(entry.target.dataset.page) - 1];
        if (entry.isIntersecting) ensureRendered(state).catch(() => {}); // a single failed page shouldn't break the whole scroller
        else evict(state);
      }
    },
    { root: pagesContainer, rootMargin: `${PRELOAD_MARGIN_PX}px 0px` }
  );
  for (const state of pageStates) preloadObserver.observe(state.pageWrap);

  // Separate, finer-grained observer just for "what page is the user
  // looking at" (the page-number field) - the preload observer's wide
  // rootMargin makes it unsuitable for that (it'd report a page as
  // "current" over a thousand pixels before it's actually on screen). 21
  // evenly-spaced thresholds fire on every ~5% visibility change; a
  // single higher threshold (e.g. 0.5) can fail to ever fire at all for
  // a page taller than the scroll container, since it may never reach
  // that ratio no matter how it's scrolled.
  const FINE_THRESHOLDS = Array.from({ length: 21 }, (_, i) => i / 20);
  const currentPageObserver = new IntersectionObserver(
    (entries) => {
      let best = null;
      for (const e of entries) {
        if (e.isIntersecting && (!best || e.intersectionRatio > best.intersectionRatio)) best = e;
      }
      if (best && document.activeElement !== pageInput) {
        pageInput.value = best.target.dataset.page;
      }
    },
    { root: pagesContainer, threshold: FINE_THRESHOLDS }
  );
  for (const state of pageStates) currentPageObserver.observe(state.pageWrap);

  function scrollToPage(p) {
    const clamped = Math.max(1, Math.min(p, doc.numPages));
    pageStates[clamped - 1]?.pageWrap.scrollIntoView({ block: "start" });
  }

  prevBtn.onclick = () => scrollToPage(Number(pageInput.value || 1) - 1);
  nextBtn.onclick = () => scrollToPage(Number(pageInput.value || 1) + 1);
  pageInput.addEventListener("change", () => {
    const n = parseInt(pageInput.value, 10);
    if (Number.isFinite(n)) scrollToPage(n);
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
      scrollToPage(pageNum);
      tocPanel.classList.add("hidden");
    }));
    tocToggleBtn.onclick = () => tocPanel.classList.toggle("hidden");
  }

  pageInput.value = 1;
  return doc;
}
