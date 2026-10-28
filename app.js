"use strict";
/* global pdfjsLib, PDFLib, JSZip, fontkit, createHarfBuzz, hbjs */

// pdf.js renders pages; pdf-lib writes the edited file; JSZip bundles split output.
const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const $ = (s) => document.querySelector(s);
const LINE_HEIGHT = 1.2;
const BASELINE = 0.9; // first baseline, as a fraction of the font size
// "PDFE Khmer" (bundled Noto Sans Khmer, see styles.css) covers Khmer in every stack, and is the
// same font the export falls back to, so the preview matches the downloaded file.
const FAMILIES = {
  sans: 'Helvetica, Arial, "PDFE Khmer", sans-serif',
  serif: '"Times New Roman", Times, "PDFE Khmer", serif',
  mono: '"Courier New", Courier, "PDFE Khmer", monospace',
};
// Standard PDF fonts used on export, keyed by family then bold/italic.
const STD_FONTS = {
  sans: ["Helvetica", "HelveticaBold", "HelveticaOblique", "HelveticaBoldOblique"],
  serif: ["TimesRoman", "TimesRomanBold", "TimesRomanItalic", "TimesRomanBoldItalic"],
  mono: ["Courier", "CourierBold", "CourierOblique", "CourierBoldOblique"],
};

/*
 * Model
 *  sources: opened files  {id, name, bytes, pdf, proxies[], fields[], values{}}
 *  pages:   current order {id, src (-1 = blank), index, rot (absolute 0/90/180/270), view, annots[]}
 *  Annotations are stored in PDF user-space points, so they survive zoom, rotation and reorder.
 *  Text and images also remember `rot`, the page rotation they were created under, so they
 *  stay upright relative to that orientation.
 */
const state = {
  sources: [],
  pages: [],
  zoom: 1.25,
  tool: "select",
  color: "#d32f2f",
  stroke: 2,
  eraserSize: 12, // pt
  fontSize: 14,
  font: { family: "sans", bold: false, italic: false }, // custom fonts add {family: "custom", name}
  grid: { show: false, snap: false, step: 10 }, // step in millimetres
  selected: null, // {pageId, annotId}
  pageSel: new Set(),
  lastThumb: null,
  current: null,
  images: new Map(), // imgId -> {el, bytes, kind: "png"|"jpg"}
  pendingImage: null,
};
let uid = 1;
const nid = () => uid++;
const history = [];

// ---------- helpers ----------

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}

const pageById = (id) => state.pages.find((p) => p.id === id);
const norm = (deg) => ((deg % 360) + 360) % 360;
// `f` is an optional text style {family, bold, italic}; plain text annotations use sans.
const fontCss = (px, f) => {
  const family =
    f?.family === "custom" ? `"${f.name.replace(/"/g, "")}", ${FAMILIES.sans}` : FAMILIES[f?.family] || FAMILIES.sans;
  return `${f?.italic ? "italic " : ""}${f?.bold ? "bold " : ""}${px}px ${family}`;
};
const dpr = () => window.devicePixelRatio || 1;

// The UMD build doesn't export PageViewport, so it is captured from the first loaded page.
let PageViewport = pdfjsLib.PageViewport;

function viewport(p, scale, rot = p.rot) {
  return new PageViewport({ viewBox: p.view, scale, rotation: rot, offsetX: 0, offsetY: 0 });
}

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function dataUrlBytes(url) {
  return Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0));
}

function download(bytes, name, type = "application/pdf") {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const baseName = () => (state.sources[0]?.name || "document").replace(/\.pdf$/i, "");

const measureCtx = document.createElement("canvas").getContext("2d");
function measureText(a, scale) {
  measureCtx.font = fontCss(a.size * scale, a.font);
  const lines = a.text.split("\n");
  const w = Math.max(...lines.map((l) => measureCtx.measureText(l).width), a.size * scale * 0.5);
  return { lines, w, h: lines.length * a.size * scale * LINE_HEIGHT };
}

// ---------- history ----------

function snapshot() {
  history.push(JSON.stringify(state.pages));
  if (history.length > 80) history.shift();
  updateButtons();
}

function undo() {
  closeEditor(false);
  const s = history.pop();
  if (!s) return;
  const before = structureKey();
  state.pages = JSON.parse(s);
  state.selected = null;
  state.pageSel = new Set([...state.pageSel].filter((id) => pageById(id)));
  if (structureKey() === before) {
    state.pages.forEach((p) => drawOverlay(p.id));
    updateButtons();
  } else {
    rebuild();
  }
}

const structureKey = () => state.pages.map((p) => `${p.id}:${p.rot}`).join(",");

// ---------- loading ----------

async function addFiles(files, replace) {
  const pdfs = [...files].filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  if (!pdfs.length) return toast("Please choose PDF files");
  if (replace) {
    state.sources = [];
    state.pages = [];
    state.pageSel.clear();
    state.selected = null;
    state.current = null;
    history.length = 0;
  } else {
    snapshot();
  }
  for (const file of pdfs) {
    try {
      await addSource(file.name, new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      console.error(e);
      toast(`Could not open ${file.name}: ${e.message}`, 5000);
    }
  }
  if (!state.current && state.pages.length) state.current = state.pages[0].id;
  rebuild();
  if (!replace) toast(`Merged ${pdfs.length} file(s) — ${state.pages.length} pages total`);
}

async function addSource(name, bytes) {
  // pdf.js detaches the buffer it receives, so give it a copy and keep the original for pdf-lib
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const src = { id: state.sources.length, name, bytes, pdf, proxies: [], fields: [], values: {} };
  state.sources.push(src);
  for (let i = 0; i < pdf.numPages; i++) {
    const pg = await pdf.getPage(i + 1);
    src.proxies[i] = pg;
    PageViewport ??= pg.getViewport({ scale: 1 }).constructor;
    state.pages.push({ id: nid(), src: src.id, index: i, rot: norm(pg.rotate), view: [...pg.view], annots: [] });
  }
  await loadFields(src);
}

async function loadFields(src) {
  try {
    const doc = await PDFDocument.load(src.bytes, { ignoreEncryption: true });
    src.fields = doc.getForm().getFields().map(describeField).filter(Boolean);
  } catch (e) {
    console.warn("Could not read form fields", e);
    src.fields = [];
  }
  for (const f of src.fields) src.values[f.name] = f.value;
}

function describeField(f) {
  const name = f.getName();
  if (f instanceof PDFLib.PDFTextField)
    return { name, kind: "text", value: f.getText() || "", multiline: f.isMultiline() };
  if (f instanceof PDFLib.PDFCheckBox) return { name, kind: "check", value: f.isChecked() };
  if (f instanceof PDFLib.PDFDropdown || f instanceof PDFLib.PDFOptionList)
    return { name, kind: "select", options: f.getOptions(), value: f.getSelected()[0] || "" };
  if (f instanceof PDFLib.PDFRadioGroup)
    return { name, kind: "radio", options: f.getOptions(), value: f.getSelected() || "" };
  return null; // push buttons and signature fields are not editable here
}

// ---------- viewer ----------

const views = new Map(); // page id -> {wrap, pc, ov, rendered, task}
let observer;

function rebuild() {
  closeEditor(true);
  buildViewer();
  buildThumbs();
  renderForms();
  updateButtons();
}

function buildViewer() {
  const viewer = $("#viewer");
  viewer.querySelectorAll(".page-wrap").forEach((n) => n.remove());
  for (const v of views.values()) v.task?.cancel();
  views.clear();
  observer?.disconnect();
  $("#empty").hidden = state.pages.length > 0;
  observer = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && renderPage(Number(e.target.dataset.id))),
    { root: viewer, rootMargin: "800px 0px" }
  );
  const r = dpr();
  state.pages.forEach((p, i) => {
    const vp = viewport(p, state.zoom);
    const wrap = document.createElement("div");
    wrap.className = "page-wrap";
    wrap.dataset.id = p.id;
    wrap.style.width = `${vp.width}px`;
    wrap.style.height = `${vp.height}px`;
    const pc = document.createElement("canvas");
    pc.className = "pdf";
    const ov = document.createElement("canvas");
    ov.className = "ov";
    for (const c of [pc, ov]) {
      c.width = Math.floor(vp.width * r);
      c.height = Math.floor(vp.height * r);
      c.style.width = `${vp.width}px`;
      c.style.height = `${vp.height}px`;
    }
    const num = document.createElement("div");
    num.className = "page-num";
    num.textContent = `${i + 1} / ${state.pages.length}`;
    wrap.append(pc, ov, num);
    viewer.append(wrap);
    views.set(p.id, { wrap, pc, ov, rendered: false, task: null });
    attachPointer(ov, p.id);
    drawOverlay(p.id);
    observer.observe(wrap);
  });
}

async function renderPage(id) {
  const v = views.get(id);
  const p = pageById(id);
  if (!v || !p || v.rendered) return;
  v.rendered = true;
  const ctx = v.pc.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, v.pc.width, v.pc.height);
  if (p.src < 0) return;
  try {
    // a page whose original text was edited renders from its copy without that text
    const proxy = pageOverrides.get(id)?.proxy || state.sources[p.src].proxies[p.index];
    v.task = proxy.render({
      canvasContext: ctx,
      viewport: viewport(p, state.zoom * dpr()),
    });
    await v.task.promise;
    runsFor(p); // fonts are resolved now, so text runs can report their real font names
  } catch (e) {
    if (e?.name !== "RenderingCancelledException") console.error(e);
  }
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 6;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6];

// `anchor` ({clientX, clientY}) keeps the point under the cursor in place; otherwise the
// current page stays at the top.
function setZoom(z, anchor) {
  const viewer = $("#viewer");
  z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 1000) / 1000));
  if (z === state.zoom) return;
  let keep = null;
  if (anchor) {
    for (const [id, v] of views) {
      const r = v.wrap.getBoundingClientRect();
      if (anchor.clientY >= r.top - 17 && anchor.clientY <= r.bottom + 17) {
        keep = { id, fx: (anchor.clientX - r.left) / r.width, fy: (anchor.clientY - r.top) / r.height };
        break;
      }
    }
  }
  const page = state.current;
  state.zoom = z;
  updateZoomLabel();
  closeEditor(true);
  buildViewer();
  const v = keep && views.get(keep.id);
  if (v) {
    const r = v.wrap.getBoundingClientRect();
    viewer.scrollLeft += r.left + keep.fx * r.width - anchor.clientX;
    viewer.scrollTop += r.top + keep.fy * r.height - anchor.clientY;
  } else if (page) {
    scrollToPage(page, "instant");
  }
}

// Next preset step in or out, so repeated clicks land on round percentages.
function zoomStep(dir, anchor) {
  const z = state.zoom;
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001);
  setZoom(next ?? z, anchor);
}

function updateZoomLabel() {
  const sel = $("#zoomLabel");
  const pct = `${Math.round(state.zoom * 100)}%`;
  let opt = [...sel.options].find((o) => o.dataset.custom);
  if (!opt) {
    opt = new Option("", "custom");
    opt.dataset.custom = "1";
    opt.hidden = true;
    sel.prepend(opt);
  }
  opt.textContent = pct;
  sel.value = "custom";
}

function fitWidth() {
  const p = pageById(state.current) || state.pages[0];
  if (!p) return;
  const avail = $("#viewer").clientWidth - 56;
  setZoom(avail / viewport(p, 1).width);
}

function fitPage() {
  const p = pageById(state.current) || state.pages[0];
  if (!p) return;
  const viewer = $("#viewer");
  const vp1 = viewport(p, 1);
  setZoom(Math.min((viewer.clientWidth - 56) / vp1.width, (viewer.clientHeight - 64) / vp1.height));
}

// ---------- grid ----------

const MM = 72 / 25.4; // points per millimetre
const gridStepPx = () => state.grid.step * MM * state.zoom;

// Rounds a view point to the nearest grid intersection when snapping is on.
function snapPoint([x, y]) {
  if (!state.grid.show || !state.grid.snap) return [x, y];
  const s = gridStepPx();
  return [Math.round(x / s) * s, Math.round(y / s) * s];
}

function drawGrid(ctx, w, h) {
  let s = gridStepPx();
  let every = 5; // a stronger line every 5 steps
  while (s < 6) {
    // too dense to read at this zoom: show every 5th line only
    s *= 5;
    every = 1;
  }
  ctx.save();
  ctx.lineWidth = 1;
  for (let i = 0, x = 0; x <= w; i++, x = i * s) {
    ctx.strokeStyle = i % every ? "rgba(37, 99, 235, 0.13)" : "rgba(37, 99, 235, 0.32)";
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, h);
    ctx.stroke();
  }
  for (let i = 0, y = 0; y <= h; i++, y = i * s) {
    ctx.strokeStyle = i % every ? "rgba(37, 99, 235, 0.13)" : "rgba(37, 99, 235, 0.32)";
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(w, Math.round(y) + 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function setGrid(change) {
  Object.assign(state.grid, change);
  try {
    localStorage.setItem("pdfe.grid", JSON.stringify(state.grid));
  } catch {
    // storage unavailable (private mode); the setting just won't be remembered
  }
  $("#btnGrid").classList.toggle("active", state.grid.show);
  $("#gridSnap").classList.toggle("active", state.grid.snap);
  $("#gridSnap").disabled = $("#gridStep").disabled = !state.grid.show;
  $("#gridStep").value = String(state.grid.step);
  redrawAll();
}

function scrollToPage(id, behavior = "smooth") {
  views.get(id)?.wrap.scrollIntoView({ behavior, block: "start" });
}

function setCurrent(id) {
  if (state.current === id) return;
  state.current = id;
  document.querySelectorAll(".thumb").forEach((t) => t.classList.toggle("current", Number(t.dataset.id) === id));
  document.querySelector(`.thumb[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
}

$("#viewer").addEventListener("scroll", () => {
  if (setCurrent.raf) return;
  setCurrent.raf = requestAnimationFrame(() => {
    setCurrent.raf = 0;
    const viewer = $("#viewer");
    const mid = viewer.getBoundingClientRect().top + viewer.clientHeight / 3;
    for (const [id, v] of views) {
      const r = v.wrap.getBoundingClientRect();
      if (r.top <= mid && r.bottom + 34 >= mid) return setCurrent(id);
    }
  });
});

// ---------- annotation geometry & drawing ----------

function rectBox(a, vp) {
  const [ax, ay] = vp.convertToViewportPoint(a.x0, a.y0);
  const [bx, by] = vp.convertToViewportPoint(a.x1, a.y1);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

// Axis-aligned view-space bounds of an annotation.
function annotBox(a, p, vp) {
  if (a.type === "ink") {
    const pts = a.pts.map((pt) => vp.convertToViewportPoint(...pt));
    const pad = (a.width * vp.scale) / 2 + 2;
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const x = Math.min(...xs) - pad;
    const y = Math.min(...ys) - pad;
    return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
  }
  if (a.type === "text") {
    const { w, h } = measureText(a, vp.scale);
    const [x, y] = vp.convertToViewportPoint(a.x, a.y);
    const t = (norm(p.rot - a.rot) * Math.PI) / 180;
    const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([cx, cy]) => [
      x + cx * Math.cos(t) - cy * Math.sin(t),
      y + cx * Math.sin(t) + cy * Math.cos(t),
    ]);
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  return rectBox(a, vp);
}

function drawAnnot(ctx, a, p, vp) {
  if (a.cover) {
    // replaced original text: paint over it with the sampled background color
    const b = rectBox(a.cover, vp);
    ctx.fillStyle = a.cover.color;
    ctx.fillRect(b.x, b.y, b.w, b.h);
  }
  if (editor?.a?.id === a.id) return; // hidden while its text editor is open
  ctx.save();
  switch (a.type) {
    case "ink": {
      ctx.strokeStyle = ctx.fillStyle = a.color;
      ctx.lineWidth = a.width * vp.scale;
      ctx.lineCap = ctx.lineJoin = "round";
      const pts = a.pts.map((pt) => vp.convertToViewportPoint(...pt));
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0][0], pts[0][1], ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      break;
    }
    case "highlight": {
      const b = rectBox(a, vp);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = a.color;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      break;
    }
    case "area": {
      const b = rectBox(a, vp);
      ctx.strokeStyle = "#2563eb";
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      break;
    }
    case "rect": {
      const b = rectBox(a, vp);
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width * vp.scale;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      break;
    }
    case "text": {
      const [x, y] = vp.convertToViewportPoint(a.x, a.y);
      ctx.translate(x, y);
      ctx.rotate((norm(p.rot - a.rot) * Math.PI) / 180);
      if (a.font?.family === "custom") ensureFontFaces(a.font.name); // redraws once loaded
      ctx.font = fontCss(a.size * vp.scale, a.font);
      ctx.fillStyle = a.color;
      a.text.split("\n").forEach((ln, i) => ctx.fillText(ln, 0, a.size * vp.scale * (BASELINE + LINE_HEIGHT * i)));
      break;
    }
    case "image": {
      const img = state.images.get(a.imgId)?.el;
      if (!img) break;
      const b = rectBox(a, vp);
      const delta = norm(p.rot - a.rot);
      ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
      ctx.rotate((delta * Math.PI) / 180);
      const [w, h] = delta % 180 ? [b.h, b.w] : [b.w, b.h];
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      break;
    }
  }
  ctx.restore();
}

function drawOverlay(id) {
  const v = views.get(id);
  const p = pageById(id);
  if (!v || !p) return;
  const ctx = v.ov.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, v.ov.width, v.ov.height);
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  const vp = viewport(p, state.zoom);
  if (state.grid.show) drawGrid(ctx, vp.width, vp.height);
  for (const a of p.annots) drawAnnot(ctx, a, p, vp);
  if (draft?.pageId === id) drawAnnot(ctx, draft.annot, p, vp);
  if (editor?.isNew && editor.p.id === id) drawAnnot(ctx, editor.a, p, vp); // its cover, while typing
  if (hoverRun?.pageId === id && !editor) {
    const b = rectBox(hoverRun.run, vp);
    ctx.strokeStyle = "#2563eb";
    ctx.fillStyle = "rgba(37, 99, 235, 0.08)";
    ctx.lineWidth = 1;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  }
  const sel = state.selected;
  const a = sel?.pageId === id && p.annots.find((x) => x.id === sel.annotId);
  if (a) {
    const b = annotBox(a, p, vp);
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
    ctx.setLineDash([]);
    if (a.type === "image") {
      ctx.fillStyle = "#2563eb";
      ctx.fillRect(b.x + b.w - 4, b.y + b.h - 4, 9, 9);
    }
  }
  checkRemovals(p); // keep the rendered page in step with which original text is removed
}

const redrawAll = () => state.pages.forEach((p) => drawOverlay(p.id));

function hitTest(p, vp, [x, y]) {
  for (let i = p.annots.length - 1; i >= 0; i--) {
    const b = annotBox(p.annots[i], p, vp);
    if (x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 4 && y <= b.y + b.h + 4) return p.annots[i];
  }
  return null;
}

// Returns a copy of `a` moved by (dx, dy) view pixels.
function shifted(a, vp, dx, dy) {
  const f = (pt) => {
    const [x, y] = vp.convertToViewportPoint(...pt);
    return vp.convertToPdfPoint(x + dx, y + dy);
  };
  if (a.type === "ink") return { pts: a.pts.map(f) };
  if (a.type === "text") {
    const [x, y] = f([a.x, a.y]);
    return { x, y };
  }
  const [x0, y0] = f([a.x0, a.y0]);
  const [x1, y1] = f([a.x1, a.y1]);
  return { x0, y0, x1, y1 };
}

function setRectFromView(a, vp, x, y, w, h) {
  const [x0, y0] = vp.convertToPdfPoint(x, y);
  const [x1, y1] = vp.convertToPdfPoint(x + w, y + h);
  Object.assign(a, { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
}

// ---------- pointer interaction ----------

const capture = (e) => {
  try {
    e.target.setPointerCapture(e.pointerId);
  } catch {
    // synthetic or already-released pointers can't be captured; dragging still works inside the page
  }
};

let draft = null; // shape being drawn: {pageId, annot}
let drag = null; // annotation being moved / resized

function select(sel) {
  const prev = state.selected;
  state.selected = sel;
  select.propSnap = false;
  if (prev) drawOverlay(prev.pageId);
  if (sel) {
    drawOverlay(sel.pageId);
    const a = pageById(sel.pageId)?.annots.find((x) => x.id === sel.annotId);
    if (a?.color) $("#color").value = a.color;
    if (a?.size) $("#fontSize").value = a.size;
    if (a?.width) $("#stroke").value = a.width;
    if (a?.type === "text") syncFontControls(a.font);
  }
}

function attachPointer(ov, id) {
  ov.addEventListener("pointerdown", (e) => onDown(e, id));
  ov.addEventListener("pointermove", (e) => onMove(e, id));
  ov.addEventListener("pointerup", (e) => onUp(e, id));
  ov.addEventListener("pointercancel", (e) => onUp(e, id));
  ov.addEventListener("dblclick", (e) => {
    const p = pageById(id);
    const a = hitTest(p, viewport(p, state.zoom), [e.offsetX, e.offsetY]);
    if (a?.type === "text" && state.tool !== "text") openTextEditor(p, a, { caretAt: [e.offsetX, e.offsetY] });
  });
}

function onDown(e, id) {
  if (e.button !== 0) return;
  const p = pageById(id);
  const vp = viewport(p, state.zoom);
  const pt = [e.offsetX, e.offsetY];
  setCurrent(id);
  if (state.pendingImage) return placeImage(p, vp, pt);

  if (state.tool === "select") {
    const a = hitTest(p, vp, pt);
    if (!a) return select(null);
    select({ pageId: id, annotId: a.id });
    const box = annotBox(a, p, vp);
    const onHandle = a.type === "image" && Math.abs(pt[0] - (box.x + box.w)) < 10 && Math.abs(pt[1] - (box.y + box.h)) < 10;
    snapshot();
    drag = { id, a, orig: structuredClone(a), start: pt, box, mode: onHandle ? "resize" : "move", moved: false };
    capture(e);
    return;
  }

  if (state.tool === "text") {
    e.preventDefault(); // keep focus on the editor we are about to open
    const a = hitTest(p, vp, pt);
    return a?.type === "text"
      ? openTextEditor(p, a, { caretAt: pt })
      : openTextEditor(p, newTextAt(p, snapPoint(pt)), { isNew: true });
  }

  if (state.tool === "edittext") {
    e.preventDefault();
    const a = hitTest(p, vp, pt);
    if (a?.type === "text") return openTextEditor(p, a, { caretAt: pt });
    const run = runAt(p, vp, pt);
    if (run) return openTextEditor(p, replacementFor(p, run), { isNew: true, caretAt: pt });
    if (p.src >= 0 && runCache.get(`${p.src}:${p.index}`) === null)
      return toast("Still reading this page's text — try again in a moment.");
    // No real text here (a picture, a scan, or text drawn as shapes): drag a box over the words to
    // type new text there. The picture itself is never covered.
    capture(e);
    const [x, y] = vp.convertToPdfPoint(...snapPoint(pt));
    draft = { pageId: id, annot: { type: "area", id: nid(), x0: x, y0: y, x1: x, y1: y } };
    if (!runsFor(p).length)
      toast("This page is a picture, so its words can't be edited directly. Drag a box to type new text; use the Eraser to remove old letters yourself.", 6000);
    return;
  }

  capture(e);
  const freehand = state.tool === "draw" || state.tool === "erase";
  const P = vp.convertToPdfPoint(...(freehand ? pt : snapPoint(pt)));
  const base = { id: nid(), color: state.color, width: state.stroke };
  if (state.tool === "erase") {
    // the eraser paints with the paper's own colour, taken from where each stroke starts
    Object.assign(base, { color: pixelColor(id, pt), width: state.eraserSize, erase: true });
  }
  draft = freehand
    ? { pageId: id, annot: { ...base, type: "ink", pts: [P] } }
    : { pageId: id, annot: { ...base, type: state.tool, x0: P[0], y0: P[1], x1: P[0], y1: P[1] } };
}

// Colour of the rendered page at a view point (white if the page hasn't painted yet).
function pixelColor(id, [x, y]) {
  const v = views.get(id);
  if (!v?.rendered) return "#ffffff";
  const r = dpr();
  const [R, G, B] = v.pc.getContext("2d").getImageData(Math.floor(x * r), Math.floor(y * r), 1, 1).data;
  return `#${[R, G, B].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function onMove(e, id) {
  const p = pageById(id);
  if (!p) return;
  const vp = viewport(p, state.zoom);
  const pt = [e.offsetX, e.offsetY];
  if (drag?.id === id) {
    const dx = pt[0] - drag.start[0];
    const dy = pt[1] - drag.start[1];
    if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
    if (drag.mode === "move") {
      // with snapping, the item's top-left corner lands on grid intersections
      const [sx, sy] = snapPoint([drag.box.x + dx, drag.box.y + dy]);
      Object.assign(drag.a, shifted(drag.orig, vp, sx - drag.box.x, sy - drag.box.y));
    } else {
      const [right] = snapPoint([drag.box.x + drag.box.w + dx, 0]);
      const w = Math.max(12, right - drag.box.x); // images keep their aspect ratio
      setRectFromView(drag.a, vp, drag.box.x, drag.box.y, w, (w * drag.box.h) / drag.box.w);
    }
    return drawOverlay(id);
  }
  if (draft?.pageId === id) {
    if (draft.annot.type === "ink") draft.annot.pts.push(vp.convertToPdfPoint(...pt));
    else [draft.annot.x1, draft.annot.y1] = vp.convertToPdfPoint(...snapPoint(pt));
    return drawOverlay(id);
  }
  if (state.tool === "select" && !state.pendingImage) {
    const a = hitTest(p, vp, pt);
    let cursor = a ? "move" : "default";
    if (a?.type === "image") {
      const b = annotBox(a, p, vp);
      if (Math.abs(pt[0] - (b.x + b.w)) < 10 && Math.abs(pt[1] - (b.y + b.h)) < 10) cursor = "nwse-resize";
    }
    e.target.style.cursor = cursor;
  } else if (state.tool === "edittext" && !editor) {
    const run = hitTest(p, vp, pt) ? null : runAt(p, vp, pt);
    if (run !== hoverRun?.run) {
      const prev = hoverRun?.pageId;
      hoverRun = run ? { pageId: id, run } : null;
      if (prev && prev !== id) drawOverlay(prev);
      drawOverlay(id);
    }
  } else {
    e.target.style.cursor = "";
  }
}

function onUp(e, id) {
  if (drag) {
    if (!drag.moved) history.pop();
    drag = null;
    return updateButtons();
  }
  if (draft?.pageId !== id) return;
  const p = pageById(id);
  const a = draft.annot;
  if (a.type === "area") {
    draft = null;
    const b = rectBox(a, viewport(p, state.zoom));
    if (b.w < 6 || b.h < 6) return drawOverlay(id);
    return openTextEditor(p, areaReplacement(p, a, b), { isNew: true, area: true });
  }
  draft = null;
  const b = annotBox(a, p, viewport(p, state.zoom));
  const tiny = a.type !== "ink" && (b.w < 3 || b.h < 3);
  if (!tiny) {
    snapshot();
    p.annots.push(a);
  }
  drawOverlay(id);
}

// ---------- text editing ----------

let editor = null; // {p, a, ta, isNew, original, cancel}

// Edits `a` in place. With `isNew`, `a` is not on the page yet and is added on commit:
// either a fresh text box or a replacement for existing PDF text (which carries a `cover`).
function openTextEditor(p, a, { isNew = false, area = false, caretAt = null } = {}) {
  closeEditor(true);
  const v = views.get(p.id);
  const vp = viewport(p, state.zoom);
  const [x, y] = vp.convertToViewportPoint(a.x, a.y);
  const zoomed = a.size * state.zoom;
  const ta = document.createElement("textarea");
  ta.className = "text-editor";
  ta.value = a.text;
  ta.spellcheck = false;
  ta.style.font = fontCss(zoomed, a.font);
  Object.assign(ta.style, {
    left: `${x}px`,
    top: `${y}px`,
    lineHeight: String(LINE_HEIGHT),
    color: a.color,
    transform: `rotate(${norm(p.rot - a.rot)}deg)`,
    transformOrigin: "0 0",
  });
  // Clicking existing PDF text only makes it editable: the original stays on the page exactly as
  // it was (the editor's own text is invisible, only its caret shows) until the first real change.
  const untouched = isNew && !!a.removes;
  if (untouched) {
    ta.style.color = "transparent";
    ta.style.caretColor = a.color || "#000";
  }
  const fit = () => {
    measureCtx.font = fontCss(zoomed, a.font);
    const lines = ta.value.split("\n");
    ta.style.width = `${Math.max(...lines.map((l) => measureCtx.measureText(l).width)) + zoomed}px`;
    ta.style.height = `${lines.length * zoomed * LINE_HEIGHT + 4}px`;
  };
  ta.addEventListener("input", fit);
  ta.addEventListener("input", () => {
    if (!editor || editor.dirty || ta.value === editor.original) return;
    editor.dirty = true; // first real edit: now the original is taken out and the new text shown
    ta.style.color = a.color;
    drawOverlay(p.id);
  });
  ta.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      ta.blur();
    } else if (ev.key === "Escape") {
      editor.cancel = true;
      ta.blur();
    }
  });
  ta.addEventListener("blur", () => closeEditor(!editor?.cancel));
  editor = { p, a, ta, isNew, area, original: a.text, cancel: false, dirty: !untouched };
  hoverRun = null;
  v.wrap.append(ta);
  fit();
  drawOverlay(p.id);
  // Nothing is selected, so typing never wipes the text: the caret goes where the user clicked
  // (or to the end) and they delete or change characters themselves.
  const caret = caretAt ? caretIndex(a, p, caretAt, [x, y]) : ta.value.length;
  setTimeout(() => {
    ta.focus();
    ta.setSelectionRange(caret, caret);
  }, 0);
}

// Character offset in `a.text` nearest to view point `pt`, given the text's view anchor.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function caretIndex(a, p, pt, [ax, ay]) {
  const t = (-norm(p.rot - a.rot) * Math.PI) / 180; // undo the text's on-screen rotation
  const [dx, dy] = [pt[0] - ax, pt[1] - ay];
  const lx = dx * Math.cos(t) - dy * Math.sin(t);
  const ly = dx * Math.sin(t) + dy * Math.cos(t);
  const lines = a.text.split("\n");
  const lineH = a.size * state.zoom * LINE_HEIGHT;
  const li = Math.min(lines.length - 1, Math.max(0, Math.floor(ly / lineH)));
  let offset = lines.slice(0, li).reduce((n, l) => n + l.length + 1, 0);
  measureCtx.font = fontCss(a.size * state.zoom, a.font);
  // walk whole clusters so the caret never lands inside a Khmer consonant cluster
  let best = offset;
  let bestDist = Math.abs(lx);
  for (const { segment, index } of graphemes.segment(lines[li])) {
    const end = index + segment.length;
    const dist = Math.abs(lx - measureCtx.measureText(lines[li].slice(0, end)).width);
    if (dist < bestDist) [best, bestDist] = [offset + end, dist];
  }
  return best;
}

function newTextAt(p, pt) {
  const [x, y] = viewport(p, state.zoom).convertToPdfPoint(...pt);
  const font = { ...state.font };
  return { type: "text", id: nid(), x, y, rot: p.rot, text: "", size: state.fontSize, color: state.color, font };
}

function closeEditor(save) {
  if (!editor) return;
  const { p, a, ta, isNew, area, original } = editor;
  editor = null;
  ta.remove();
  const text = ta.value.replace(/\s+$/, "");
  // Replaced PDF text keeps its cover even when emptied, which erases the original.
  // A dragged area is kept even when left empty: covering the old words is the edit.
  if (save && pageById(p.id) && text !== original) {
    snapshot();
    if (text || a.cover || a.removes) {
      a.text = text;
      if (a.center && text) {
        // keep replacement text centred where the old words were
        const vp1 = viewport(p, 1, a.rot);
        const [, ay] = vp1.convertToViewportPoint(a.x, a.y);
        const [cx] = vp1.convertToViewportPoint(...a.center);
        [a.x, a.y] = vp1.convertToPdfPoint(cx - measureText(a, 1).w / 2, ay);
      }
      if (isNew) p.annots.push(a);
      if (text) setTimeout(() => select({ pageId: p.id, annotId: a.id })); // so font/color tweaks apply to it
    } else if (!isNew) {
      p.annots = p.annots.filter((q) => q !== a);
    }
  }
  drawOverlay(p.id);
}

// ---------- existing PDF text ----------

let hoverRun = null; // {pageId, run} under the cursor while the Edit text tool is active
const runCache = new Map(); // "src:index" -> text runs, or null while loading

// Lines of existing text on a page, as PDF user-space boxes. Loads on first use.
function runsFor(p) {
  if (p.src < 0) return [];
  const key = `${p.src}:${p.index}`;
  if (!runCache.has(key)) {
    runCache.set(key, null);
    loadRuns(state.sources[p.src].proxies[p.index])
      .then((runs) => runCache.set(key, runs))
      .catch((e) => {
        console.error(e);
        runCache.set(key, []);
      });
  }
  return runCache.get(key) || [];
}

// Legacy (pre-Unicode) Khmer fonts such as Limon or ABC store Latin letters that the font draws
// as Khmer. Returns the converter's encoding type for a PDF font name, or null.
function legacyEncoding(fontName) {
  const name = fontName.replace(/^[A-Z]{6}\+/, ""); // drop the subset tag, e.g. "OOAJHF+"
  const K = window.KhmerConverter;
  if (K) {
    // PDF names drop spaces ("LimonS6"); the converter knows "Limon S6"
    for (const n of [name, name.replace(/^([A-Za-z]+?)([A-Z]\d+)$/, "$1 $2")]) {
      if (K.isConvertible(n)) return K.typeForFontName(n);
    }
  }
  if (/limon/i.test(name)) return "limon";
  if (/^abc[\s_-]/i.test(name)) return "abc";
  return null;
}

// Real font names by pdf.js font id. Fonts are only resolved once the page's operator list is
// built, which is also what rendering does, so this costs little extra.
async function pageFonts(proxy, ids) {
  await proxy.getOperatorList();
  const out = {};
  for (const id of ids) {
    let name = "";
    try {
      name = proxy.commonObjs.get(id)?.name || "";
    } catch {
      // not a loaded font object
    }
    out[id] = { name, legacy: legacyEncoding(name) };
  }
  return out;
}

async function loadRuns(proxy) {
  const tc = await proxy.getTextContent();
  const fonts = await pageFonts(proxy, Object.keys(tc.styles));
  // Legacy Khmer often splits one word across a font and its subset/CID twin (e.g. subscripts),
  // so pieces in the same legacy encoding count as the same style.
  const styleKey = (id) => (fonts[id]?.legacy ? `legacy:${fonts[id].legacy}` : id);
  const runs = [];
  let cur = null;
  for (const it of tc.items) {
    if (!it.transform || !it.str) {
      if (it.hasEOL) cur = null;
      continue;
    }
    const [a, b, c, d, e, f] = it.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b);
    if (!size || a <= 0 || Math.abs(b) > 0.01 * a) {
      cur = null; // only horizontal text can be edited
      continue;
    }
    // pdf.js often splits a line into words or glyph runs; merge neighbours with the same style
    const gap = cur ? e - cur.end : 0;
    const sameLine =
      cur &&
      styleKey(it.fontName) === styleKey(cur.fontName) &&
      Math.abs(f - cur.base) < size * 0.3 &&
      Math.abs(size - cur.size) < 0.5 &&
      gap > -size * 0.5 &&
      gap < size * 0.8;
    if (sameLine) {
      if (gap > size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += " ";
      cur.text += it.str;
      cur.end = Math.max(cur.end, e + it.width);
    } else {
      cur = {
        text: it.str,
        x: e,
        base: f,
        end: e + it.width,
        size,
        fontName: it.fontName,
        realName: fonts[it.fontName]?.name || "",
        legacy: fonts[it.fontName]?.legacy || null,
        styles: tc.styles,
      };
      runs.push(cur);
    }
    if (it.hasEOL) cur = null;
  }
  return runs
    .map((r) => ({ ...r, text: r.text.replace(/\s+$/, "") }))
    .filter((r) => r.text)
    .map((r) => {
      // Legacy Khmer fonts hang subscripts and vowels further outside the reported box
      const [px, below, above] = r.legacy ? [r.size * 0.08, 0.42, 0.95] : [0.5, 0.26, 0.86];
      return { ...r, x0: r.x - px, x1: r.end + px, y0: r.base - r.size * below, y1: r.base + r.size * above };
    });
}

function runAt(p, vp, [x, y]) {
  return runsFor(p).find((r) => {
    const b = rectBox(r, vp);
    return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  });
}

function fontStyle(run) {
  const name = run.realName; // e.g. "ABCDEF+Arial-BoldMT"
  const generic = run.styles[run.fontName]?.fontFamily || "";
  let family = "sans";
  if (/mono|courier|consol/i.test(`${name} ${generic}`)) family = "mono";
  else if (/times|georgia|garamond|roman|cambria|minion|serif/i.test(name) ? !/sans/i.test(name) : generic === "serif")
    family = "serif";
  return { family, bold: /bold|black|heavy|semibold|demi/i.test(name), italic: /italic|oblique/i.test(name) };
}

// Background and text colors of a run, sampled from the rendered page.
function sampleColors(p, box) {
  const v = views.get(p.id);
  const fallback = { bg: "#ffffff", fg: "#000000" };
  if (!v?.rendered) return fallback;
  const r = dpr();
  const b = rectBox(box, viewport(p, state.zoom));
  const x = Math.max(0, Math.floor((b.x - 2) * r));
  const y = Math.max(0, Math.floor((b.y - 2) * r));
  const w = Math.min(v.pc.width - x, Math.ceil((b.w + 4) * r));
  const h = Math.min(v.pc.height - y, Math.ceil((b.h + 4) * r));
  if (w < 3 || h < 3) return fallback;
  const d = v.pc.getContext("2d").getImageData(x, y, w, h).data;
  const px = (i, j) => [d[(j * w + i) * 4], d[(j * w + i) * 4 + 1], d[(j * w + i) * 4 + 2]];
  const edge = [];
  for (let i = 0; i < w; i++) edge.push(px(i, 0), px(i, h - 1));
  for (let j = 0; j < h; j++) edge.push(px(0, j), px(w - 1, j));
  const median = (k) => edge.map((c) => c[k]).sort((m, n) => m - n)[edge.length >> 1];
  const bg = [median(0), median(1), median(2)];
  // Text color: the most common clearly-non-background color. Counting (rather than taking the
  // single most different pixel) keeps thin frame lines or nearby map features from winning.
  const buckets = new Map();
  for (let j = 1; j < h - 1; j++)
    for (let i = 1; i < w - 1; i++) {
      const c = px(i, j);
      const dist = Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
      if (dist < 120) continue; // background or anti-aliased edges
      const key = (c[0] >> 5) * 64 + (c[1] >> 5) * 8 + (c[2] >> 5);
      const e = buckets.get(key) || { n: 0, best: c, bestDist: -1 };
      e.n++;
      if (dist > e.bestDist) [e.best, e.bestDist] = [c, dist]; // the solid core, not edge blends
      buckets.set(key, e);
    }
  const top = [...buckets.values()].sort((m, n) => n.n - m.n)[0];
  const hex = (c) => `#${c.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  return { bg: hex(bg), fg: top ? hex(top.best) : "#000000" };
}

// A text annotation for editing `run`. Until the user changes it, the original stays on the page
// untouched; once changed, the original words are taken out of the page's content (nothing is
// painted over them, so map lines and colours behind stay) and the annotation draws the new text.
function replacementFor(p, run) {
  const vp0 = viewport(p, 1, 0); // original text runs along user-space x, i.e. rotation 0
  const [bx, by] = vp0.convertToViewportPoint(run.x, run.base);
  const [x, y] = vp0.convertToPdfPoint(bx, by - run.size * BASELINE);
  const { fg } = sampleColors(p, run);
  const a = {
    type: "text",
    id: nid(),
    x,
    y,
    rot: 0,
    text: run.text,
    size: Math.round(run.size * 100) / 100,
    color: fg,
    font: fontStyle(run),
    removes: { x0: run.x0, x1: run.x1, base: run.base, size: run.size },
  };
  if (run.legacy) toUnicodeKhmer(a, run);
  else {
    // match the original's width, so the caret lands between the right letters and the edited
    // text keeps the same length on the page
    const natural = measureText(a, 1).w;
    const target = run.end - run.x;
    if (natural > 0 && target > 0) a.size = Math.round(a.size * Math.min(1.25, Math.max(0.8, target / natural)) * 10) / 10;
  }
  // the size may have changed: re-anchor so the new text sits on the original baseline
  [a.x, a.y] = vp0.convertToPdfPoint(bx, by - a.size * BASELINE);
  return a;
}

// ---------- removing original text from page content ----------
//
// Finds the text-showing operators (Tj, TJ, ', ") whose glyphs make up a run, by replaying the
// page's text positioning with the fonts' real widths, and swaps each for an invisible spacer
// ([-n] TJ) of the same advance, so everything after it on the line stays exactly where it was.
// Text inside Form XObjects (common in exported maps) is handled the same way.

const PDF_WS = new Set([0, 9, 10, 12, 13, 32]);
const PDF_DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

// Calls onOp(op, operands, start, end) for every operator in a content stream (bytes).
function parseContent(b, onOp) {
  const n = b.length;
  let i = 0;
  const skipWs = () => {
    while (i < n) {
      if (PDF_WS.has(b[i])) i++;
      else if (b[i] === 37) while (i < n && b[i] !== 10 && b[i] !== 13) i++;
      else break;
    }
  };
  const readToken = () => {
    const c = b[i];
    if (c === 40) {
      // literal string, with nesting and escapes
      const out = [];
      let depth = 1;
      i++;
      while (i < n && depth) {
        let ch = b[i++];
        if (ch === 92) {
          const e = b[i++];
          const map = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
          if (map[e] !== undefined) out.push(map[e]);
          else if (e >= 48 && e <= 55) {
            let v = e - 48;
            for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + (b[i++] - 48);
            out.push(v & 255);
          } else if (e === 13) {
            if (b[i] === 10) i++;
          } else if (e !== 10) out.push(e);
          continue;
        }
        if (ch === 40) depth++;
        else if (ch === 41 && !--depth) break;
        out.push(ch);
      }
      return { t: "str", v: out };
    }
    if (c === 60 && b[i + 1] === 60) return (i += 2), { t: "<<" };
    if (c === 62 && b[i + 1] === 62) return (i += 2), { t: ">>" };
    if (c === 60) {
      let hex = "";
      i++;
      while (i < n && b[i] !== 62) {
        if (!PDF_WS.has(b[i])) hex += String.fromCharCode(b[i]);
        i++;
      }
      i++;
      if (hex.length % 2) hex += "0";
      const out = [];
      for (let k = 0; k < hex.length; k += 2) out.push(parseInt(hex.slice(k, k + 2), 16));
      return { t: "str", v: out };
    }
    if (c === 91 || c === 93 || c === 123 || c === 125) return i++, { t: String.fromCharCode(c) };
    let s = i;
    if (c === 47) i++;
    while (i < n && !PDF_WS.has(b[i]) && !PDF_DELIM.has(b[i])) i++;
    if (i === s) i++; // stray delimiter
    const word = String.fromCharCode(...b.subarray(c === 47 ? s + 1 : s, i));
    if (c === 47) return { t: "name", v: word.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) };
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: "num", v: parseFloat(word) };
    return { t: "op", v: word };
  };
  const readValue = (tok) => {
    if (tok.t === "[") {
      const arr = [];
      for (;;) {
        skipWs();
        if (i >= n) return arr;
        const t = readToken();
        if (t.t === "]") return arr;
        arr.push(readValue(t));
      }
    }
    if (tok.t === "<<") {
      const dict = {};
      for (;;) {
        skipWs();
        if (i >= n) return dict;
        const k = readToken();
        if (k.t === ">>") return dict;
        skipWs();
        dict[k.v] = readValue(readToken());
      }
    }
    return tok.t === "op" ? tok.v : tok.v; // true/false/null come through as words
  };
  let stack = [];
  let start = -1;
  for (;;) {
    skipWs();
    if (i >= n) break;
    const s = i;
    const tok = readToken();
    if (tok.t === "op" && !["true", "false", "null"].includes(tok.v)) {
      if (tok.v === "BI") {
        // inline image: skip its binary data up to a whitespace-delimited EI
        while (i < n) {
          skipWs();
          const t = readToken();
          if (t.t === "op" && t.v === "ID") break;
        }
        i++;
        while (i < n && !(b[i] === 69 && b[i + 1] === 73 && PDF_WS.has(b[i - 1]) && (i + 2 >= n || PDF_WS.has(b[i + 2])))) i++;
        i += 2;
        stack = [];
        start = -1;
        continue;
      }
      onOp(tok.v, stack, start < 0 ? s : start, i);
      stack = [];
      start = -1;
    } else {
      if (start < 0) start = s;
      stack.push(readValue(tok));
    }
  }
}

const matMul = (m, k) => [
  m[0] * k[0] + m[1] * k[2],
  m[0] * k[1] + m[1] * k[3],
  m[2] * k[0] + m[3] * k[2],
  m[2] * k[1] + m[3] * k[3],
  m[4] * k[0] + m[5] * k[2] + k[4],
  m[4] * k[1] + m[5] * k[3] + k[5],
];

// Glyph widths (text-space units per 1 unit of font size) for a font resource.
function fontMetrics(resources, name) {
  const { PDFName, PDFDict, PDFArray, PDFNumber } = PDFLib;
  const num = (o) => (o instanceof PDFNumber ? o.asNumber() : undefined);
  const font = resources?.lookup(PDFName.of("Font"))?.lookup?.(PDFName.of(name));
  const fallback = { twoByte: false, width: () => 0.5 };
  if (!(font instanceof PDFDict)) return fallback;
  const subtype = font.get(PDFName.of("Subtype"))?.toString();
  if (subtype === "/Type0") {
    const desc = font.lookup(PDFName.of("DescendantFonts"));
    const cid = desc instanceof PDFArray ? desc.lookup(0) : null;
    if (!(cid instanceof PDFDict)) return { twoByte: true, width: () => 1 };
    const dw = num(cid.lookup(PDFName.of("DW"))) ?? 1000;
    const widths = new Map();
    const W = cid.lookup(PDFName.of("W"));
    if (W instanceof PDFArray) {
      const items = W.asArray().map((o) => cid.context.lookup(o));
      for (let k = 0; k < items.length; ) {
        const first = num(items[k]);
        if (items[k + 1] instanceof PDFArray) {
          items[k + 1].asArray().forEach((w, j) => widths.set(first + j, num(cid.context.lookup(w)) ?? dw));
          k += 2;
        } else {
          const last = num(items[k + 1]);
          const w = num(items[k + 2]) ?? dw;
          for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, w);
          k += 3;
        }
      }
    }
    return { twoByte: true, width: (code) => (widths.get(code) ?? dw) / 1000 };
  }
  const first = num(font.lookup(PDFName.of("FirstChar"))) ?? 0;
  const Wd = font.lookup(PDFName.of("Widths"));
  const list = Wd instanceof PDFArray ? Wd.asArray().map((o) => num(font.context.lookup(o)) ?? 0) : null;
  const fm = font.lookup(PDFName.of("FontMatrix"));
  const scale = fm instanceof PDFArray ? num(fm.lookup(0)) ?? 0.001 : 0.001; // Type3 glyph space
  const missing = num(font.lookup(PDFName.of("FontDescriptor"))?.lookup?.(PDFName.of("MissingWidth"))) ?? 500;
  if (!list) {
    // The standard 14 fonts may omit Widths; use their built-in metrics (WinAnsi codes).
    const base = font.get(PDFName.of("BaseFont"))?.decodeText?.().replace(/^[A-Z]{6}\+/, "");
    if (!Object.values(StandardFonts).includes(base)) return fallback;
    const std = PDFLib.StandardFontEmbedder.for(base);
    const cache = new Map();
    return {
      twoByte: false,
      width: (code) => {
        if (!cache.has(code)) {
          let w = 0.5;
          try {
            w = std.widthOfTextAtSize(String.fromCharCode(code), 1);
          } catch {
            // code outside the font's encoding
          }
          cache.set(code, w);
        }
        return cache.get(code);
      },
    };
  }
  return { twoByte: false, width: (code) => (list[code - first] ?? missing) * scale };
}

// Rewrites one content stream; returns {bytes, removed[]} (removed count per run).
function stripRunsFromContent(doc, bytes, resources, ctm0, runs, depth) {
  const { PDFName, PDFRawStream, PDFDict } = PDFLib;
  const removed = runs.map(() => 0);
  const edits = []; // [start, end, replacement]
  const fonts = new Map();
  let gs = { ctm: ctm0, font: null, size: 0, Tc: 0, Tw: 0, Th: 1, TL: 0 };
  const stack = [];
  let Tm = [1, 0, 0, 1, 0, 0];
  let Tlm = Tm;
  const metrics = (name) => {
    if (!fonts.has(name)) fonts.set(name, fontMetrics(resources, name));
    return fonts.get(name);
  };
  const nextLine = () => {
    Tlm = matMul([1, 0, 0, 1, 0, -gs.TL], Tlm);
    Tm = Tlm;
  };
  const hex = (bytes) => `<${[...bytes].map((x) => x.toString(16).padStart(2, "0")).join("")}>`;
  // Shows a string/TJ array. Glyphs whose origin falls inside a run are dropped, each replaced by
  // a spacer of exactly its advance, so a command that also draws neighbouring words (e.g. a date
  // line with blanks) keeps those words where they were.
  const show = (items, start, end, prefix) => {
    const m = matMul(Tm, gs.ctm);
    const [ox, oy] = [m[4], m[5]];
    const scaleX = Math.hypot(m[0], m[1]);
    const size = gs.size * Math.hypot(m[2], m[3]);
    const horizontal = Math.abs(m[1]) < 0.01 * Math.abs(m[0]) && m[0] > 0;
    // runs this command's baseline and size could belong to
    const candidates = horizontal
      ? runs
          .map((r, k) => [r, k])
          .filter(([r]) => Math.abs(oy - r.base) <= r.size * 0.35 && Math.abs(size - r.size) <= r.size * 0.35)
      : [];
    const f = gs.font ? metrics(gs.font) : { twoByte: false, width: () => 0.5 };
    const toNum = (adv) => (gs.size && gs.Th ? (-adv * 1000) / (gs.size * gs.Th) : 0);
    const out = []; // rebuilt TJ elements: byte arrays and numbers
    let tx = 0;
    let dropped = 0;
    for (const it of items) {
      if (typeof it === "number") {
        out.push(it);
        tx += (-it / 1000) * gs.size * gs.Th;
        continue;
      }
      let keep = [];
      for (let k = 0; k < it.length; k += f.twoByte ? 2 : 1) {
        const code = f.twoByte ? (it[k] << 8) | (it[k + 1] ?? 0) : it[k];
        const adv = (f.width(code) * gs.size + gs.Tc + (!f.twoByte && code === 32 ? gs.Tw : 0)) * gs.Th;
        const gx = ox + tx * scaleX;
        const hit = candidates.find(([r]) => gx >= r.x0 - r.size * 0.15 && gx < r.x1 - r.size * 0.05);
        if (hit) {
          removed[hit[1]]++;
          dropped++;
          if (keep.length) out.push(keep), (keep = []);
          out.push(toNum(adv));
        } else {
          keep.push(...it.subarray?.(k, k + (f.twoByte ? 2 : 1)) ?? it.slice(k, k + (f.twoByte ? 2 : 1)));
        }
        tx += adv;
      }
      if (keep.length) out.push(keep);
    }
    if (dropped) {
      const body = out.map((e) => (typeof e === "number" ? e.toFixed(3) : hex(e))).join(" ");
      edits.push([start, end, `${prefix}[${body}] TJ`]);
    }
    Tm = matMul([1, 0, 0, 1, tx, 0], Tm);
  };
  parseContent(bytes, (op, a, start, end) => {
    switch (op) {
      case "q":
        stack.push({ ...gs });
        break;
      case "Q":
        if (stack.length) gs = stack.pop();
        break;
      case "cm":
        if (a.length === 6) gs.ctm = matMul(a, gs.ctm);
        break;
      case "BT":
        Tm = Tlm = [1, 0, 0, 1, 0, 0];
        break;
      case "Tf":
        [gs.font, gs.size] = [a[0], a[1]];
        break;
      case "Tc":
        gs.Tc = a[0];
        break;
      case "Tw":
        gs.Tw = a[0];
        break;
      case "Tz":
        gs.Th = a[0] / 100;
        break;
      case "TL":
        gs.TL = a[0];
        break;
      case "Td":
        Tlm = matMul([1, 0, 0, 1, a[0], a[1]], Tlm);
        Tm = Tlm;
        break;
      case "TD":
        gs.TL = -a[1];
        Tlm = matMul([1, 0, 0, 1, a[0], a[1]], Tlm);
        Tm = Tlm;
        break;
      case "Tm":
        Tm = Tlm = a.slice(0, 6);
        break;
      case "T*":
        nextLine();
        break;
      case "Tj":
        show([a[0] || []], start, end, "");
        break;
      case "TJ":
        show((a[0] || []).map((x) => (Array.isArray(x) ? x : Number(x))), start, end, "");
        break;
      case "'":
        nextLine();
        show([a[0] || []], start, end, "T* ");
        break;
      case '"':
        gs.Tw = a[0];
        gs.Tc = a[1];
        nextLine();
        show([a[2] || []], start, end, `${a[0]} Tw ${a[1]} Tc T* `);
        break;
      case "Do": {
        if (depth > 6) break;
        const xobjs = resources?.lookup(PDFName.of("XObject"));
        const ref = xobjs?.get?.(PDFName.of(a[0]));
        const form = ref && doc.context.lookup(ref);
        if (!(form instanceof PDFRawStream) || form.dict.get(PDFName.of("Subtype"))?.toString() !== "/Form") break;
        const mtx = form.dict.lookup(PDFName.of("Matrix"));
        const fm = mtx ? mtx.asArray().map((o) => doc.context.lookup(o).asNumber()) : [1, 0, 0, 1, 0, 0];
        const res = form.dict.lookup(PDFName.of("Resources"));
        const sub = stripRunsFromContent(
          doc,
          PDFLib.decodePDFRawStream(form).decode(),
          res instanceof PDFDict ? res : resources,
          matMul(fm, gs.ctm),
          runs,
          depth + 1
        );
        sub.removed.forEach((c, k) => (removed[k] += c));
        if (sub.removed.some(Boolean)) replaceStream(doc, ref, form, sub.bytes);
        break;
      }
    }
  });
  if (!edits.length) return { bytes, removed };
  const parts = [];
  let at = 0;
  for (const [s, e, rep] of edits.sort((x, y) => x[0] - y[0])) {
    parts.push(bytes.subarray(at, s), new TextEncoder().encode(rep));
    at = e;
  }
  parts.push(bytes.subarray(at));
  const out = new Uint8Array(parts.reduce((len, p) => len + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return { bytes: out, removed };
}

// Replaces a stream object's data, keeping its dictionary entries except the encoding ones.
function replaceStream(doc, ref, old, bytes) {
  const { PDFName } = PDFLib;
  const keep = {};
  for (const [k, v] of old.dict.entries()) {
    if (!["/Filter", "/DecodeParms", "/Length"].includes(k.toString())) keep[k.decodeText()] = v;
  }
  doc.context.assign(ref, doc.context.flateStream(bytes, keep));
}

// Removes the given runs ({x0, x1, base, size} in user space) from a page of `doc`.
// Returns how many text operators were removed for each run.
function removeTextRuns(doc, page, runs) {
  const { PDFName, PDFArray, PDFRawStream } = PDFLib;
  const node = page.node;
  const contents = node.get(PDFName.of("Contents"));
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  const streams = refs.map((r) => doc.context.lookup(r)).filter((s) => s instanceof PDFRawStream);
  if (!streams.length) return runs.map(() => 0);
  const joined = streams.map((s) => PDFLib.decodePDFRawStream(s).decode());
  const all = new Uint8Array(joined.reduce((n, b) => n + b.length + 1, 0));
  let o = 0;
  for (const b of joined) {
    all.set(b, o);
    all[o + b.length] = 10; // streams are concatenated with whitespace between them
    o += b.length + 1;
  }
  const { bytes, removed } = stripRunsFromContent(doc, all, node.Resources(), [1, 0, 0, 1, 0, 0], runs, 0);
  if (bytes !== all) node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(bytes)));
  return removed;
}

// Preview: a page with removed runs is re-rendered from a one-page copy without that text.
const sourceLibs = new Map(); // src id -> Promise<PDFDocument>
const pageOverrides = new Map(); // page id -> {key, proxy}

function removalsFor(p) {
  const list = p.annots.filter((a) => a.removes);
  // the text being edited is only taken out once the user has actually changed it
  if (editor?.p.id === p.id && editor.dirty && editor.a.removes && !list.includes(editor.a)) list.push(editor.a);
  return list;
}

function checkRemovals(p) {
  if (!p || p.src < 0) return;
  const annots = removalsFor(p);
  const key = annots.map((a) => `${a.removes.x0.toFixed(1)}:${a.removes.base.toFixed(1)}`).sort().join("|");
  if ((pageOverrides.get(p.id)?.key ?? "") === key) return;
  const entry = { key, proxy: null };
  pageOverrides.set(p.id, entry);
  (async () => {
    if (annots.length) {
      if (!sourceLibs.has(p.src))
        sourceLibs.set(p.src, PDFDocument.load(state.sources[p.src].bytes, { ignoreEncryption: true }));
      const lib = await sourceLibs.get(p.src);
      const out = await PDFDocument.create();
      const [pg] = await out.copyPages(lib, [p.index]);
      out.addPage(pg);
      const removed = removeTextRuns(out, pg, annots.map((a) => a.removes));
      // Never paint a patch over clicked text: if a word can't be found in the content (e.g. text
      // inside a form field), it stays and the user is told.
      if (annots.some((a, k) => !removed[k]))
        toast("Part of the original text couldn't be taken out here, so it stays under your edit.", 5000);
      if (!removed.some(Boolean)) return pageOverrides.get(p.id) === entry && pageOverrides.delete(p.id), drawOverlay(p.id);
      const doc = await pdfjsLib.getDocument({ data: await out.save() }).promise;
      entry.proxy = await doc.getPage(1);
    }
    if (pageOverrides.get(p.id) !== entry) return; // superseded by a newer change
    await rerenderPage(p.id);
  })().catch((e) => console.error("Text removal failed", e));
}

// Re-renders a page into a fresh canvas (so it never collides with a render in progress).
async function rerenderPage(id) {
  const v = views.get(id);
  const p = pageById(id);
  if (!v || !p) return;
  const proxy = pageOverrides.get(id)?.proxy || state.sources[p.src].proxies[p.index];
  const c = document.createElement("canvas");
  Object.assign(c, { width: v.pc.width, height: v.pc.height, className: "pdf" });
  c.style.cssText = v.pc.style.cssText;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  await proxy.render({ canvasContext: ctx, viewport: viewport(p, state.zoom * dpr()) }).promise;
  if (views.get(id) !== v) return; // the viewer was rebuilt meanwhile
  v.task?.cancel();
  v.pc.replaceWith(c);
  v.pc = c;
  v.rendered = true;
}

// View-space bounds of everything inside box `b` that differs clearly from the background.
function inkBox(p, b, bgHex) {
  const v = views.get(p.id);
  if (!v?.rendered) return null;
  const r = dpr();
  const x = Math.max(0, Math.floor(b.x * r));
  const y = Math.max(0, Math.floor(b.y * r));
  const w = Math.min(v.pc.width - x, Math.ceil(b.w * r));
  const h = Math.min(v.pc.height - y, Math.ceil(b.h * r));
  if (w < 2 || h < 2) return null;
  const d = v.pc.getContext("2d").getImageData(x, y, w, h).data;
  const bg = [1, 3, 5].map((i) => parseInt(bgHex.slice(i, i + 2), 16));
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = (j * w + i) * 4;
      if (Math.abs(d[k] - bg[0]) + Math.abs(d[k + 1] - bg[1]) + Math.abs(d[k + 2] - bg[2]) > 120) {
        x0 = Math.min(x0, i);
        y0 = Math.min(y0, j);
        x1 = Math.max(x1, i);
        y1 = Math.max(y1, j);
      }
    }
  if (x1 < 0) return null;
  return { x: (x + x0) / r, y: (y + y0) / r, w: (x1 - x0 + 1) / r, h: (y1 - y0 + 1) / r };
}

// New text for a box dragged over words that aren't real text (images, scans, outlines), sized,
// coloured and centred from the old words' ink. Nothing is painted over the picture.
function areaReplacement(p, area, b) {
  const vp = viewport(p, state.zoom);
  const cover = {};
  setRectFromView(cover, vp, b.x, b.y, b.w, b.h);
  const { bg, fg } = sampleColors(p, cover);
  // Size and place the new text from the old words' ink, not the loosely dragged box.
  const ink = inkBox(p, b, bg) || b;
  // Khmer ink (top vowels to subscripts) spans about 1.2 font sizes
  const size = Math.max(4, Math.round((ink.h / state.zoom / 1.2) * 10) / 10);
  const lineH = size * state.zoom * LINE_HEIGHT;
  const [x, y] = vp.convertToPdfPoint(ink.x, ink.y + ink.h / 2 - lineH / 2);
  return {
    center: vp.convertToPdfPoint(ink.x + ink.w / 2, ink.y + ink.h / 2), // re-centred here on commit
    type: "text",
    id: area.id,
    x,
    y,
    rot: p.rot,
    text: "",
    size,
    color: fg,
    font: { ...state.font },
    // No cover: the picture is left exactly as it is. Old letters are removed only if the user
    // brushes them away with the Eraser.
  };
}

// Legacy-font text is edited and saved as Unicode Khmer: the PDF's embedded legacy font is only a
// subset of the letters already used, so new words can't be written back in it.
function toUnicodeKhmer(a, run) {
  const legacyText = run.text
    .replace(/μ/g, "µ") // some PDFs map Limon's µ (a subscript) to Greek mu
    .replace(/[-]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xf000)); // symbol-font codes
  try {
    a.text = window.KhmerConverter.convertLegacyToUnicode(legacyText, run.legacy);
  } catch (e) {
    console.warn(e);
    toast("Couldn't convert this legacy Khmer text — the KhmerConverter library didn't load.", 5000);
    return;
  }
  // Use the font picked in the toolbar if it's a computer font, else the bundled Khmer font.
  // Limon R-series fonts are the heavy heading style, so default those to bold.
  a.font =
    state.font.family === "custom"
      ? { ...state.font }
      : { family: "sans", bold: /limon\s*r/i.test(run.realName.replace(/^[A-Z]{6}\+/, "")), italic: false };
  // Unicode Khmer fonts are drawn larger than Limon at the same point size; fit the original width.
  const natural = measureText(a, 1).w;
  const target = run.x1 - run.x0;
  if (natural > 0) a.size = Math.round(a.size * Math.min(1.3, Math.max(0.5, target / natural)) * 10) / 10;
}

// ---------- images & signatures ----------

async function loadImage(url) {
  const el = new Image();
  el.src = url;
  await el.decode();
  return el;
}

async function addImageFile(file) {
  const url = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  let el = await loadImage(url);
  let kind = file.type === "image/jpeg" ? "jpg" : "png";
  let bytes = dataUrlBytes(url);
  if (file.type !== "image/jpeg" && file.type !== "image/png") {
    // pdf-lib only embeds PNG/JPEG, so re-encode anything else
    const c = Object.assign(document.createElement("canvas"), { width: el.naturalWidth, height: el.naturalHeight });
    c.getContext("2d").drawImage(el, 0, 0);
    const png = c.toDataURL("image/png");
    bytes = dataUrlBytes(png);
    el = await loadImage(png);
    kind = "png";
  }
  startPlacing({ el, bytes, kind }, Math.min(el.naturalWidth * 0.75, 300));
}

function startPlacing(img, widthPt) {
  const imgId = nid();
  state.images.set(imgId, img);
  state.pendingImage = { imgId, widthPt };
  $("#viewer").classList.add("placing");
  toast("Click on a page to place it (Esc to cancel)");
}

function placeImage(p, vp, [cx, cy]) {
  const { imgId, widthPt } = state.pendingImage;
  const { el } = state.images.get(imgId);
  const w = widthPt * vp.scale;
  const h = (w * el.naturalHeight) / el.naturalWidth;
  const a = { type: "image", id: nid(), imgId, rot: p.rot };
  const [x, y] = snapPoint([cx - w / 2, cy - h / 2]);
  setRectFromView(a, vp, x, y, w, h);
  snapshot();
  p.annots.push(a);
  cancelPlacing();
  setTool("select");
  select({ pageId: p.id, annotId: a.id });
}

function cancelPlacing() {
  state.pendingImage = null;
  $("#viewer").classList.remove("placing");
}

const signPad = $("#signPad");
const signCtx = signPad.getContext("2d");
let signing = null;

function openSignature() {
  signCtx.clearRect(0, 0, signPad.width, signPad.height);
  $("#signDlg").showModal();
}

function padPoint(e) {
  const r = signPad.getBoundingClientRect();
  return [((e.clientX - r.left) * signPad.width) / r.width, ((e.clientY - r.top) * signPad.height) / r.height];
}
signPad.addEventListener("pointerdown", (e) => {
  signPad.setPointerCapture(e.pointerId);
  signing = padPoint(e);
  Object.assign(signCtx, { lineWidth: 3, lineCap: "round", lineJoin: "round", strokeStyle: state.color === "#ffe600" ? "#000" : state.color });
});
signPad.addEventListener("pointermove", (e) => {
  if (!signing) return;
  const q = padPoint(e);
  signCtx.beginPath();
  signCtx.moveTo(...signing);
  signCtx.lineTo(...q);
  signCtx.stroke();
  signing = q;
});
signPad.addEventListener("pointerup", () => (signing = null));
$("#signClear").addEventListener("click", () => signCtx.clearRect(0, 0, signPad.width, signPad.height));

$("#signDlg").addEventListener("close", async () => {
  if ($("#signDlg").returnValue !== "ok") return;
  // crop to the inked area so the placed image hugs the signature
  const { data, width, height } = signCtx.getImageData(0, 0, signPad.width, signPad.height);
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 10) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  if (x1 < 0) return toast("The signature pad was empty");
  const pad = 6;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  const c = Object.assign(document.createElement("canvas"), { width: Math.min(width, x1 + pad) - x0, height: Math.min(height, y1 + pad) - y0 });
  c.getContext("2d").drawImage(signPad, -x0, -y0);
  const url = c.toDataURL("image/png");
  startPlacing({ el: await loadImage(url), bytes: dataUrlBytes(url), kind: "png" }, 150);
});

// ---------- thumbnails & page operations ----------

const thumbCache = new Map();
let dragThumb = null;

function thumbImage(p) {
  const key = `${p.src}:${p.index}:${p.rot}:${p.view.join(",")}`;
  if (!thumbCache.has(key)) {
    thumbCache.set(
      key,
      (async () => {
        const vp = viewport(p, 240 / viewport(p, 1).width);
        const c = Object.assign(document.createElement("canvas"), { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        if (p.src >= 0) await state.sources[p.src].proxies[p.index].render({ canvasContext: ctx, viewport: vp }).promise;
        return c.toDataURL("image/jpeg", 0.8);
      })()
    );
  }
  return thumbCache.get(key);
}

function buildThumbs() {
  const box = $("#thumbs");
  box.innerHTML = "";
  state.pages.forEach((p, i) => {
    const t = document.createElement("div");
    t.className = "thumb";
    t.draggable = true;
    t.dataset.id = p.id;
    t.classList.toggle("sel", state.pageSel.has(p.id));
    t.classList.toggle("current", state.current === p.id);
    const img = document.createElement("img");
    const vp = viewport(p, 1);
    img.style.aspectRatio = `${vp.width} / ${vp.height}`;
    img.alt = `Page ${i + 1}`;
    thumbImage(p).then((url) => (img.src = url)).catch(console.error);
    const n = document.createElement("span");
    n.textContent = i + 1;
    t.append(img, n);
    t.addEventListener("click", (e) => onThumbClick(e, p.id, i));
    t.addEventListener("dragstart", (e) => {
      dragThumb = p.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(p.id));
      t.classList.add("dragging");
    });
    t.addEventListener("dragend", () => {
      dragThumb = null;
      document.querySelectorAll(".thumb").forEach((n) => n.classList.remove("dragging", "drop-before", "drop-after"));
    });
    t.addEventListener("dragover", (e) => {
      if (dragThumb == null) return;
      e.preventDefault();
      const r = t.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      t.classList.toggle("drop-after", after);
      t.classList.toggle("drop-before", !after);
    });
    t.addEventListener("dragleave", () => t.classList.remove("drop-before", "drop-after"));
    t.addEventListener("drop", (e) => {
      if (dragThumb == null) return;
      e.preventDefault();
      e.stopPropagation();
      const after = t.classList.contains("drop-after");
      const moving = dragThumb;
      if (moving === p.id) return;
      snapshot();
      const item = pageById(moving);
      state.pages = state.pages.filter((q) => q.id !== moving);
      const at = state.pages.findIndex((q) => q.id === p.id) + (after ? 1 : 0);
      state.pages.splice(at, 0, item);
      rebuild();
    });
    box.append(t);
  });
  $("#selHint").textContent = state.pageSel.size
    ? `${state.pageSel.size} page(s) selected`
    : "Click to select · Ctrl/Shift-click for more · drag to reorder";
}

function onThumbClick(e, id, i) {
  if (e.shiftKey && state.lastThumb != null) {
    const from = state.pages.findIndex((p) => p.id === state.lastThumb);
    const [a, b] = [Math.min(from, i), Math.max(from, i)];
    state.pages.slice(a, b + 1).forEach((p) => state.pageSel.add(p.id));
  } else if (e.ctrlKey || e.metaKey) {
    state.pageSel.has(id) ? state.pageSel.delete(id) : state.pageSel.add(id);
    state.lastThumb = id;
  } else {
    state.pageSel = new Set([id]);
    state.lastThumb = id;
    scrollToPage(id);
  }
  setCurrent(id);
  document.querySelectorAll(".thumb").forEach((t) => t.classList.toggle("sel", state.pageSel.has(Number(t.dataset.id))));
  $("#selHint").textContent = `${state.pageSel.size} page(s) selected`;
}

// Selected pages in document order, falling back to the current page.
function targetPages() {
  const sel = state.pages.filter((p) => state.pageSel.has(p.id));
  if (sel.length) return sel;
  const cur = pageById(state.current);
  return cur ? [cur] : [];
}

function rotatePages(delta) {
  const pages = targetPages();
  if (!pages.length) return;
  snapshot();
  pages.forEach((p) => (p.rot = norm(p.rot + delta)));
  rebuild();
}

function deletePages() {
  const pages = targetPages();
  if (!pages.length) return;
  if (pages.length === state.pages.length && !confirm("Delete every page?")) return;
  snapshot();
  const ids = new Set(pages.map((p) => p.id));
  const idx = state.pages.findIndex((p) => ids.has(p.id));
  state.pages = state.pages.filter((p) => !ids.has(p.id));
  state.pageSel.clear();
  state.current = state.pages[Math.min(idx, state.pages.length - 1)]?.id ?? null;
  rebuild();
}

function duplicatePages() {
  const pages = targetPages();
  if (!pages.length) return;
  snapshot();
  for (const p of [...pages].reverse()) {
    const copy = structuredClone(p);
    copy.id = nid();
    copy.annots.forEach((a) => (a.id = nid()));
    state.pages.splice(state.pages.indexOf(p) + 1, 0, copy);
  }
  rebuild();
}

function insertBlank() {
  const cur = pageById(state.current);
  const [x0, y0, x1, y1] = cur ? cur.view : [0, 0, 595.28, 841.89]; // A4 if nothing open
  snapshot();
  const blank = { id: nid(), src: -1, index: 0, rot: cur?.rot ?? 0, view: [0, 0, x1 - x0, y1 - y0], annots: [] };
  state.pages.splice(cur ? state.pages.indexOf(cur) + 1 : state.pages.length, 0, blank);
  state.current = blank.id;
  rebuild();
  scrollToPage(blank.id);
}

// ---------- forms ----------

function renderForms() {
  const body = $("#formsBody");
  body.innerHTML = "";
  const srcs = state.sources.filter((s) => s.fields.length && state.pages.some((p) => p.src === s.id));
  $("#btnForms").textContent = srcs.length ? `Forms (${srcs.reduce((n, s) => n + s.fields.length, 0)})` : "Forms";
  if (!srcs.length) {
    body.innerHTML = '<p class="muted">No fillable form fields in the open PDFs.</p>';
    return;
  }
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = "Values are written into the downloaded file (the form is flattened). The preview shows the original values.";
  body.append(note);
  for (const s of srcs) {
    const h = document.createElement("h3");
    h.textContent = s.name;
    body.append(h);
    for (const f of s.fields) body.append(fieldInput(s, f));
  }
}

function fieldInput(s, f) {
  const row = document.createElement("label");
  row.className = "field-row";
  const name = document.createElement("span");
  name.textContent = f.name;
  let input;
  if (f.kind === "check") {
    row.classList.add("check");
    input = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!s.values[f.name] });
    input.addEventListener("change", () => (s.values[f.name] = input.checked));
    row.append(input, name);
    return row;
  }
  if (f.kind === "select" || f.kind === "radio") {
    input = document.createElement("select");
    for (const o of ["", ...f.options]) input.append(new Option(o || "—", o));
    input.value = s.values[f.name] || "";
  } else {
    input = document.createElement(f.multiline ? "textarea" : "input");
    if (!f.multiline) input.type = "text";
    input.className = "field";
    input.value = s.values[f.name] || "";
  }
  input.addEventListener("input", () => (s.values[f.name] = input.value));
  row.append(name, input);
  return row;
}

// ---------- export ----------

// Text-field values that need shaping (Khmer…) can't go through pdf-lib's field appearances,
// so the field is left empty and the value is drawn as shaped text inside each widget.
function fieldTextAnnots(lib, field, value) {
  const pages = lib.getPages();
  const da = field.acroField.getDefaultAppearance?.() || "";
  const daSize = Number(da.match(/([\d.]+)\s+Tf/)?.[1]) || 0;
  const multiline = field.isMultiline();
  const out = [];
  for (const w of field.acroField.getWidgets()) {
    const ref = lib.context.getObjectRef(w.dict);
    const pageIndex = pages.findIndex((pg) => pg.ref === w.P() || pg.node.Annots()?.asArray().includes(ref));
    if (pageIndex < 0) continue;
    const r = w.getRectangle();
    const size = daSize || Math.min(12, r.height * 0.62);
    const baseline = multiline ? r.y + r.height - 2 - size * BASELINE : r.y + (r.height - size) / 2 + size * 0.22;
    out.push({
      pageIndex,
      annot: { type: "text", id: nid(), x: r.x + 2, y: baseline + size * BASELINE, rot: 0, text: value, size, color: "#000000" },
    });
  }
  return out;
}

async function prepareSource(src, warnings) {
  const lib = await PDFDocument.load(src.bytes, { ignoreEncryption: true });
  const fieldText = new Map(); // page index -> extra text annotations
  if (!src.fields.length) return { lib, fieldText };
  const form = lib.getForm();
  let changed = false;
  for (const f of src.fields) {
    const v = src.values[f.name];
    if (v === f.value) continue;
    changed = true;
    try {
      if (f.kind === "text" && NEEDS_SHAPING.test(v || "")) {
        const field = form.getTextField(f.name);
        for (const { pageIndex, annot } of fieldTextAnnots(lib, field, v)) {
          if (!fieldText.has(pageIndex)) fieldText.set(pageIndex, []);
          fieldText.get(pageIndex).push(annot);
        }
        field.setText(undefined);
      } else if (f.kind === "text") form.getTextField(f.name).setText(v || undefined);
      else if (f.kind === "check") v ? form.getCheckBox(f.name).check() : form.getCheckBox(f.name).uncheck();
      else if (f.kind === "radio") v ? form.getRadioGroup(f.name).select(v) : form.getRadioGroup(f.name).clear();
      else {
        const fld = form.getField(f.name);
        v ? fld.select(v) : fld.clear();
      }
    } catch (e) {
      warnings.add(`Field "${f.name}": ${e.message}`);
    }
  }
  // Fields don't survive page copying, so bake them into the page content.
  try {
    form.flatten({ updateFieldAppearances: changed });
  } catch (e) {
    warnings.add(`Could not flatten the form: ${e.message}`);
  }
  return { lib, fieldText };
}

function drawRotatedImage(page, image, r, rot) {
  const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1);
  const y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
  const W = x1 - x0, H = y1 - y0;
  // pdf-lib rotates counter-clockwise around (x, y); pick the corner that keeps the image in r
  const o = {
    0: { x: x0, y: y0, width: W, height: H },
    90: { x: x1, y: y0, width: H, height: W },
    180: { x: x1, y: y1, width: W, height: H },
    270: { x: x0, y: y1, width: H, height: W },
  }[rot];
  page.drawImage(image, { ...o, rotate: degrees(rot) });
}

function rasterizeText(a) {
  const k = 4; // render at 4x so the embedded image stays crisp
  const { lines, w, h } = measureText(a, 1);
  const c = Object.assign(document.createElement("canvas"), { width: Math.ceil(w * k), height: Math.ceil(h * k) });
  const ctx = c.getContext("2d");
  ctx.scale(k, k);
  ctx.font = fontCss(a.size, a.font);
  ctx.fillStyle = a.color;
  lines.forEach((ln, i) => ctx.fillText(ln, 0, a.size * (BASELINE + LINE_HEIGHT * i)));
  return { bytes: dataUrlBytes(c.toDataURL("image/png")), w, h };
}

// `kit` holds the per-document helpers: {fonts, shaper, warnings}.
async function drawAnnotPdf(out, page, p, a, kit, imgCache) {
  const color = a.color ? hexRgb(a.color) : undefined;
  if (a.type === "ink") {
    const [first] = a.pts;
    if (a.pts.length === 1) page.drawCircle({ x: first[0], y: first[1], size: a.width / 2, color });
    for (let i = 1; i < a.pts.length; i++) {
      page.drawLine({
        start: { x: a.pts[i - 1][0], y: a.pts[i - 1][1] },
        end: { x: a.pts[i][0], y: a.pts[i][1] },
        thickness: a.width,
        color,
        lineCap: LineCapStyle.Round,
      });
    }
  } else if (a.type === "rect" || a.type === "highlight") {
    const box = { x: Math.min(a.x0, a.x1), y: Math.min(a.y0, a.y1), width: Math.abs(a.x1 - a.x0), height: Math.abs(a.y1 - a.y0) };
    page.drawRectangle(a.type === "highlight" ? { ...box, color, opacity: 0.35 } : { ...box, borderColor: color, borderWidth: a.width });
  } else if (a.type === "image") {
    if (!imgCache.has(a.imgId)) {
      const rec = state.images.get(a.imgId);
      imgCache.set(a.imgId, rec.kind === "jpg" ? await out.embedJpg(rec.bytes) : await out.embedPng(rec.bytes));
    }
    drawRotatedImage(page, imgCache.get(a.imgId), a, a.rot);
  } else if (a.type === "text") {
    if (a.cover) {
      const c = a.cover;
      page.drawRectangle({ x: c.x0, y: c.y0, width: c.x1 - c.x0, height: c.y1 - c.y0, color: hexRgb(c.color) });
    }
    if (!a.text) return;
    const lines = a.text.split("\n");
    const vp1 = viewport(p, 1, a.rot);
    const [ax, ay] = vp1.convertToViewportPoint(a.x, a.y);
    const baseline = (i) => ay + a.size * (BASELINE + LINE_HEIGHT * i);
    const font = await kit.fonts(a.font);
    if (font && canEncode(font, a.text)) {
      lines.forEach((ln, i) => {
        const [x, y] = vp1.convertToPdfPoint(ax, baseline(i));
        page.drawText(ln, { x, y, size: a.size, font, color, rotate: degrees(a.rot) });
      });
      return;
    }
    if (NEEDS_SHAPING.test(a.text)) {
      try {
        const layouts = await Promise.all(lines.map((ln, i) => kit.shaper.layout(ln, a, [ax, baseline(i)])));
        if (layouts.every(Boolean)) {
          const toPdf = (x, y) => vp1.convertToPdfPoint(x, y);
          layouts.forEach((l) => kit.shaper.paint(page, l, a, color, toPdf));
          return;
        }
      } catch (e) {
        console.error(e);
        kit.warnings.add("Complex-script shaping failed, so some text was saved as an image");
      }
    }
    // Text the font can't write as real PDF text is embedded as a sharp image, drawn with the
    // browser's text engine (which shapes complex scripts correctly).
    const { bytes, w, h } = rasterizeText(a);
    const [x0, y0] = vp1.convertToPdfPoint(ax, ay);
    const [x1, y1] = vp1.convertToPdfPoint(ax + w, ay + h);
    drawRotatedImage(page, await out.embedPng(bytes), { x0, y0, x1, y1 }, a.rot);
  }
}

// ---------- complex-script shaping (Khmer, Thai, Indic, Arabic…) ----------
//
// pdf-lib writes glyphs without shaping, so these scripts would come out with broken letter
// order and misplaced subscripts/vowels. Instead HarfBuzz (the engine browsers use) shapes the
// text, and each glyph is placed at its exact position with an embedded copy of the font. Every
// shaped run is tagged with /ActualText so copy, paste and search return the real Unicode text.

const SHAPED_CHARS = "\\u0590-\\u08ff\\u0900-\\u0dff\\u0e00-\\u0fff\\u1000-\\u109f\\u1780-\\u17ff\\u19e0-\\u19ff\\ua980-\\uaadf";
const NEEDS_SHAPING = new RegExp(`[${SHAPED_CHARS}]`);
// Runs to shape, including the zero-width characters Khmer uses between words and in clusters.
const SHAPED_RUN = new RegExp(`([${SHAPED_CHARS}\\u200b-\\u200d\\u25cc]+)`);
const KHMER_FONT_FILES = ["fonts/NotoSansKhmer-Regular.ttf", "fonts/NotoSansKhmer-Bold.ttf"];

let hbReady = null;
const harfbuzz = () => (hbReady ??= createHarfBuzz().then(hbjs));

const fileBytes = new Map();
function fetchBytes(url) {
  if (!fileBytes.has(url)) {
    fileBytes.set(
      url,
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((b) => new Uint8Array(b))
    );
  }
  return fileBytes.get(url);
}

const hbFonts = new Map(); // font bytes -> {hb, font, upem}
async function shapeText(bytes, text) {
  if (!hbFonts.has(bytes)) {
    const hb = await harfbuzz();
    const face = hb.createFace(hb.createBlob(bytes), 0);
    hbFonts.set(bytes, { hb, font: hb.createFont(face), upem: face.upem });
  }
  const { hb, font, upem } = hbFonts.get(bytes);
  const buf = hb.createBuffer();
  try {
    buf.addText(text);
    buf.guessSegmentProperties();
    hb.shape(font, buf);
    return { glyphs: buf.json(), upem };
  } finally {
    buf.destroy();
  }
}

const utf16Hex = (s) => [...Array(s.length).keys()].map((i) => s.charCodeAt(i).toString(16).padStart(4, "0")).join("");

// Font for the invisible text layer: the font file embedded as Type0/Identity-H, with every
// character written as its plain (unshaped) cmap glyph, so ToUnicode maps glyph -> character
// one to one and copy/search return exactly the typed text.
function textLayerFont(out, bytes) {
  const ctx = out.context;
  const fk = fontkit.create(bytes);
  const scale = 1000 / fk.unitsPerEm;
  const name = (fk.postscriptName || "TextLayerFont").replace(/[^A-Za-z0-9-]/g, "");
  const ref = ctx.nextRef();
  const used = new Map(); // gid -> character

  return {
    name,
    ref,
    fk,
    // Glyph string for `text` plus its natural width per point of font size.
    encode(text) {
      let hex = "";
      let width = 0;
      for (const ch of text) {
        const g = fk.glyphForCodePoint(ch.codePointAt(0));
        if (!g.id) continue; // e.g. a zero-width space the font lacks
        if (!used.has(g.id)) used.set(g.id, ch);
        hex += g.id.toString(16).padStart(4, "0");
        width += g.advanceWidth / fk.unitsPerEm;
      }
      return { hex, width };
    },
    finish() {
      const { PDFString } = PDFLib;
      const gids = [...used.keys()].sort((m, n) => m - n);
      const entries = gids.map((gid) => `<${gid.toString(16).padStart(4, "0")}> <${utf16Hex(used.get(gid))}>`);
      const blocks = [];
      for (let i = 0; i < entries.length; i += 100)
        blocks.push(`${Math.min(100, entries.length - i)} beginbfchar\n${entries.slice(i, i + 100).join("\n")}\nendbfchar`);
      const cmap = [
        "/CIDInit /ProcSet findresource begin",
        "12 dict begin",
        "begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /Adobe-Identity-UCS def",
        "/CMapType 2 def",
        "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange",
        ...blocks,
        "endcmap",
        "CMapName currentdict /CMap defineresource pop",
        "end",
        "end",
      ].join("\n");
      const bbox = fk.bbox;
      const descriptor = ctx.register(
        ctx.obj({
          Type: "FontDescriptor",
          FontName: name,
          Flags: 4,
          FontBBox: [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY].map((n) => Math.round(n * scale)),
          ItalicAngle: fk.italicAngle || 0,
          Ascent: Math.round(fk.ascent * scale),
          Descent: Math.round(fk.descent * scale),
          CapHeight: Math.round((fk.capHeight || fk.ascent) * scale),
          StemV: 80,
          FontFile2: ctx.register(ctx.flateStream(bytes, { Length1: bytes.length })),
        })
      );
      const cidFont = ctx.register(
        ctx.obj({
          Type: "Font",
          Subtype: "CIDFontType2",
          BaseFont: name,
          CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 },
          FontDescriptor: descriptor,
          W: gids.flatMap((gid) => [gid, [Math.round(fk.getGlyph(gid).advanceWidth * scale)]]),
          CIDToGIDMap: "Identity",
        })
      );
      ctx.assign(
        ref,
        ctx.obj({
          Type: "Font",
          Subtype: "Type0",
          BaseFont: name,
          Encoding: "Identity-H",
          DescendantFonts: [cidFont],
          ToUnicode: ctx.register(ctx.flateStream(cmap)),
        })
      );
    },
  };
}

// Path operators filling the outline of each shaped glyph (view positions mapped by toPdf).
function glyphOutlineOps(fk, glyphs, size, rot, toPdf) {
  const { moveTo, lineTo, appendBezierCurve, closePath } = PDFLib;
  const k = size / fk.unitsPerEm;
  const t = (rot * Math.PI) / 180;
  const [c, s] = [Math.cos(t), Math.sin(t)];
  const ops = [];
  for (const g of glyphs) {
    const [ox, oy] = toPdf(g.x, g.y);
    const P = (u, v) => [ox + (u * c - v * s) * k, oy + (u * s + v * c) * k];
    let cur = [0, 0];
    let start = [0, 0];
    for (const { command, args } of fk.getGlyph(g.gid).path.commands) {
      if (command === "moveTo") {
        cur = start = args;
        ops.push(moveTo(...P(...args)));
      } else if (command === "lineTo") {
        cur = args;
        ops.push(lineTo(...P(...args)));
      } else if (command === "quadraticCurveTo") {
        const [qx, qy, x, y] = args; // TrueType quadratic -> equivalent cubic
        const c1 = [cur[0] + (2 / 3) * (qx - cur[0]), cur[1] + (2 / 3) * (qy - cur[1])];
        const c2 = [x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y)];
        ops.push(appendBezierCurve(...P(...c1), ...P(...c2), ...P(x, y)));
        cur = [x, y];
      } else if (command === "bezierCurveTo") {
        ops.push(appendBezierCurve(...P(args[0], args[1]), ...P(args[2], args[3]), ...P(args[4], args[5])));
        cur = [args[4], args[5]];
      } else if (command === "closePath") {
        ops.push(closePath());
        cur = start;
      }
    }
  }
  return ops;
}

// Shaped text is written in two layers, the way OCR'd PDFs work:
//  - visible: each HarfBuzz-positioned glyph filled as a vector outline, so subscripts, split
//    vowels and ligatures look exactly right in every viewer;
//  - invisible: the same text in logical order, stretched over the same span, so selecting,
//    copying and searching return the real Unicode text (PDF font maps can't describe Khmer
//    ligatures and reordered vowels, so text-only output always copies garbled).
function createShaper(out, fonts) {
  const layers = new Map(); // font bytes -> textLayerFont
  const layerFont = (bytes) => {
    if (!layers.has(bytes)) layers.set(bytes, textLayerFont(out, bytes));
    return layers.get(bytes);
  };

  // The chosen computer font if it covers the run, else the bundled Noto Sans Khmer.
  async function fontFileFor(f, run) {
    if (f?.family === "custom") {
      const bytes = await customFontBytes(f).catch(() => null);
      if (bytes && (await shapeText(bytes, run)).glyphs.every((g) => g.g !== 0)) return bytes;
    }
    return fetchBytes(KHMER_FONT_FILES[f?.bold ? 1 : 0]);
  }

  return {
    // Writes the font objects; call once after all text is painted.
    finish: () => layers.forEach((f) => f.finish()),

    // Positions a line starting at `origin` (view coords, y down). Null if part of it can't be
    // written as text.
    async layout(line, a, [x, y]) {
      const parts = [];
      let pen = x;
      for (const [i, run] of line.split(SHAPED_RUN).entries()) {
        if (!run) continue;
        if (i % 2) {
          const bytes = await fontFileFor(a.font, run);
          const { glyphs, upem } = await shapeText(bytes, run);
          const k = a.size / upem;
          const startX = pen;
          const placed = glyphs.map((g) => {
            const at = { gid: g.g, x: pen + g.dx * k, y: y - g.dy * k };
            pen += g.ax * k;
            return at;
          });
          parts.push({ layer: layerFont(bytes), text: run, glyphs: placed, x: startX, y, width: pen - startX });
        } else {
          const font = await fonts(a.font);
          if (!font || !canEncode(font, run)) return null;
          parts.push({ font, text: run, x: pen, y });
          pen += font.widthOfTextAtSize(run, a.size);
        }
      }
      return parts;
    },

    paint(page, parts, a, color, toPdf) {
      const { PDFOperator, PDFOperatorNames: Op, PDFNumber, PDFHexString } = PDFLib;
      const t = (a.rot * Math.PI) / 180;
      const [c, s] = [Math.cos(t), Math.sin(t)];
      for (const part of parts) {
        if (!part.glyphs) {
          const [x, y] = toPdf(part.x, part.y);
          page.drawText(part.text, { x, y, size: a.size, font: part.font, color, rotate: degrees(a.rot) });
          continue;
        }
        const ops = [
          PDFLib.pushGraphicsState(),
          PDFLib.setFillingColor(color),
          ...glyphOutlineOps(part.layer.fk, part.glyphs, a.size, a.rot, toPdf),
          PDFLib.fill(),
        ];
        const { hex, width } = part.layer.encode(part.text);
        if (hex) {
          const [x, y] = toPdf(part.x, part.y);
          ops.push(
            PDFLib.beginText(),
            PDFLib.setFontAndSize(page.node.newFontDictionary(part.layer.name, part.layer.ref), a.size),
            PDFLib.setTextRenderingMode(PDFLib.TextRenderingMode.Invisible),
            PDFLib.setCharacterSqueeze(width ? (part.width / (width * a.size)) * 100 : 100),
            PDFOperator.of(Op.SetTextMatrix, [c, s, -s, c, x, y].map((n) => PDFNumber.of(n))),
            PDFLib.showText(PDFHexString.of(hex)),
            PDFLib.endText()
          );
        }
        ops.push(PDFLib.popGraphicsState());
        page.pushOperators(...ops);
      }
    },
  };
}


function canEncode(font, text) {
  if (NEEDS_SHAPING.test(text)) return false;
  const glyphs = font.embedder?.font; // a fontkit font for embedded custom fonts
  try {
    if (typeof glyphs?.hasGlyphForCodePoint === "function") return [...text.replace(/\s/g, "")].every((ch) => glyphs.hasGlyphForCodePoint(ch.codePointAt(0)));
    font.encodeText(text);
    return true;
  } catch {
    return false;
  }
}

// Returns (style) => PDFFont | null, embedding each font once per output document.
function fontLoader(out, warnings) {
  const cache = new Map();
  return (f = {}) => {
    const idx = (f.bold ? 1 : 0) + (f.italic ? 2 : 0);
    const key = f.family === "custom" ? `c:${f.name}:${idx}` : `s:${f.family || "sans"}:${idx}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        (async () => {
          if (f.family !== "custom") return out.embedFont(StandardFonts[STD_FONTS[f.family || "sans"][idx]]);
          try {
            const bytes = await customFontBytes(f);
            if (!bytes) throw new Error("font file not available");
            out.registerFontkit(fontkit);
            return await out.embedFont(bytes, { subset: true });
          } catch (e) {
            console.warn(e);
            warnings.add(`Font "${f.name}" couldn't be embedded, so its text was saved as an image`);
            return null;
          }
        })()
      );
    }
    return cache.get(key);
  };
}

async function buildPdf(pages) {
  closeEditor(true);
  const out = await PDFDocument.create();
  const libs = new Map();
  const imgCache = new Map();
  const warnings = new Set();
  out.registerFontkit(fontkit);
  const fonts = fontLoader(out, warnings);
  const kit = { fonts, shaper: createShaper(out, fonts), warnings };
  for (const p of pages) {
    let page;
    let extra = [];
    if (p.src < 0) {
      page = out.addPage([p.view[2] - p.view[0], p.view[3] - p.view[1]]);
    } else {
      if (!libs.has(p.src)) libs.set(p.src, await prepareSource(state.sources[p.src], warnings));
      const { lib, fieldText } = libs.get(p.src);
      [page] = await out.copyPages(lib, [p.index]);
      out.addPage(page);
      extra = fieldText.get(p.index) || [];
      // take edited original text out of the page itself (no cover painted over it)
      const edited = p.annots.filter((a) => a.removes);
      if (edited.length) removeTextRuns(out, page, edited.map((a) => a.removes));
    }
    page.setRotation(degrees(p.rot));
    for (const a of [...extra, ...p.annots]) await drawAnnotPdf(out, page, p, a, kit, imgCache);
  }
  kit.shaper.finish();
  if (warnings.size) toast([...warnings].join(" · "), 7000);
  return out.save();
}

async function busy(label, fn) {
  const btns = document.querySelectorAll("button");
  btns.forEach((b) => (b.dataset.wasDisabled = b.disabled, (b.disabled = true)));
  toast(label, 60000);
  try {
    await fn();
    toast("Done");
  } catch (e) {
    console.error(e);
    toast(`Failed: ${e.message}`, 6000);
  } finally {
    btns.forEach((b) => (b.disabled = b.dataset.wasDisabled === "true"));
  }
}

const save = () =>
  state.pages.length && busy("Building PDF…", async () => download(await buildPdf(state.pages), `${baseName()}-edited.pdf`));

function extract() {
  const pages = targetPages();
  if (!pages.length) return;
  busy(`Extracting ${pages.length} page(s)…`, async () => download(await buildPdf(pages), `${baseName()}-pages.pdf`));
}

function parseRanges(text, max) {
  const groups = [];
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`"${part}" is not a page or range`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > max || a > b) throw new Error(`"${part}" is outside 1–${max}`);
    groups.push({ label: m[2] ? `${a}-${b}` : `${a}`, from: a, to: b });
  }
  if (!groups.length) throw new Error("Enter at least one range");
  return groups;
}

$("#splitDlg").addEventListener("close", () => {
  if ($("#splitDlg").returnValue !== "ok") return;
  const mode = document.querySelector('input[name="splitMode"]:checked').value;
  let groups;
  try {
    groups =
      mode === "each"
        ? state.pages.map((_, i) => ({ label: `${i + 1}`, from: i + 1, to: i + 1 }))
        : parseRanges($("#splitRanges").value, state.pages.length);
  } catch (e) {
    return toast(e.message, 4000);
  }
  busy(`Splitting into ${groups.length} file(s)…`, async () => {
    const zip = new JSZip();
    const pad = String(state.pages.length).length;
    for (const g of groups) {
      const bytes = await buildPdf(state.pages.slice(g.from - 1, g.to));
      zip.file(`${baseName()}-p${g.label.replace(/\d+/g, (d) => d.padStart(pad, "0"))}.pdf`, bytes);
    }
    download(await zip.generateAsync({ type: "uint8array" }), `${baseName()}-split.zip`, "application/zip");
  });
});

// ---------- toolbar wiring ----------

function setTool(t) {
  closeEditor(true);
  cancelPlacing();
  state.tool = t;
  if (hoverRun) {
    const id = hoverRun.pageId;
    hoverRun = null;
    drawOverlay(id);
  }
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
  $("#viewer").className = `tool-${t}`;
  if (t !== "select") select(null);
  if (t === "highlight" && state.color === "#d32f2f") setColor("#ffe600");
  // the Line box sets the eraser's size while the Eraser is active
  $("#stroke").value = t === "erase" ? state.eraserSize : state.stroke;
  $("#stroke").closest("label").firstChild.textContent = t === "erase" ? "Size " : "Line ";
}

function setColor(c) {
  state.color = c;
  $("#color").value = c;
  applyToSelected("color", c);
}

// Property edits also apply to the selected annotation (one undo step per selection).
function applyToSelected(key, value) {
  const sel = state.selected;
  const a = sel && pageById(sel.pageId)?.annots.find((x) => x.id === sel.annotId);
  const isFont = key === "font" && a?.type === "text";
  if (!a || !(key in a || isFont)) return;
  if (!select.propSnap) {
    snapshot();
    select.propSnap = true;
  }
  a[key] = isFont ? { ...a.font, ...value } : value;
  drawOverlay(sel.pageId);
}

// ---------- fonts: built-in Khmer library and this computer ----------

// family -> [{bold, italic, url?: built-in file, data?: FontData, bytes?: Uint8Array}]
const fontRegistry = new Map();
const libraryFamilies = []; // built-in families, in manifest order: {name, khmer}
const styleFlags = (s) => ({ bold: /bold|black|heavy|semibold|demi/i.test(s), italic: /italic|oblique/i.test(s) });

function addFace(family, flags, src) {
  if (!fontRegistry.has(family)) fontRegistry.set(family, []);
  fontRegistry.get(family).push({ ...flags, ...src });
}

// Chrome/Edge only: asks permission, then lists every installed font.
async function loadComputerFonts() {
  if (!("queryLocalFonts" in window)) {
    toast("This browser can't list installed fonts. Use Chrome or Edge, or upload a font file.", 5000);
    return;
  }
  try {
    const list = await window.queryLocalFonts();
    for (const fd of list) {
      if (!fontRegistry.get(fd.family)?.some((x) => x.data?.postscriptName === fd.postscriptName))
        addFace(fd.family, styleFlags(fd.style), { data: fd });
    }
    fillFontSelect();
    toast(`${fontRegistry.size} font families loaded from this computer`);
  } catch (e) {
    toast(`Font access was blocked: ${e.message}`, 5000);
  }
}

async function uploadFont(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const family = file.name.replace(/\.(ttf|otf)$/i, "");
  const face = new FontFace(family, bytes);
  await face.load();
  document.fonts.add(face);
  addFace(family, styleFlags(family), { bytes });
  fillFontSelect();
  setFont({ family: "custom", name: family });
}

// Built-in Khmer fonts load on first use. fonts/library holds the freely licensed ones (published
// with the site); fonts/local, if present, holds fonts licensed for personal use only, which are
// kept out of the public repository.
async function loadFontLibrary() {
  for (const dir of ["fonts/library", "fonts/local"]) {
    try {
      const res = await fetch(`${dir}/manifest.json`, { cache: "no-cache" }); // always revalidate
      if (!res.ok) continue;
      for (const fam of await res.json()) {
        libraryFamilies.push({ name: fam.family, khmer: fam.khmer });
        for (const f of fam.faces) addFace(fam.family, { bold: f.bold, italic: f.italic }, { url: `${dir}/${f.file}` });
      }
    } catch (e) {
      console.warn(`Fonts in ${dir} unavailable`, e);
    }
  }
  fillFontSelect();
}

// Registers a built-in family's faces with the page so the preview can draw it.
const facesLoading = new Map(); // family -> Promise
function ensureFontFaces(name) {
  if (!name || facesLoading.has(name)) return facesLoading.get(name);
  const faces = (fontRegistry.get(name) || []).filter((f) => f.url);
  if (!faces.length) return null;
  const done = Promise.all(
    faces.map((f) => {
      const face = new FontFace(name, `url("${encodeURI(f.url)}")`, {
        weight: f.bold ? "700" : "400",
        style: f.italic ? "italic" : "normal",
      });
      document.fonts.add(face);
      return face.load().catch((e) => console.warn(`Font ${name} failed to load`, e));
    })
  );
  facesLoading.set(name, done);
  return done;
}

// The font file for a style, picking the matching bold/italic face when the family has one
// (built-in files first, since they are known to be complete font files).
async function customFontBytes(f) {
  const all = fontRegistry.get(f.name);
  if (!all) return null;
  const faces = [...all.filter((x) => x.url), ...all.filter((x) => !x.url)];
  const face =
    faces.find((x) => x.bold === !!f.bold && x.italic === !!f.italic) ||
    faces.find((x) => !x.bold && !x.italic) ||
    faces[0];
  if (!face.bytes) {
    face.bytes = face.url
      ? await fetchBytes(face.url)
      : new Uint8Array(await (await face.data.blob()).arrayBuffer());
  }
  return face.bytes;
}

const fontValue = (f) => (f?.family === "custom" ? `custom:${f.name}` : f?.family || "sans");

function fillFontSelect() {
  const sel = $("#fontFamily");
  sel.querySelectorAll("optgroup").forEach((g) => g.remove());
  const before = sel.querySelector('[value="__browse"]');
  const library = new Set(libraryFamilies.map((f) => f.name));
  const groups = [
    ["Khmer fonts (built in)", [...library]],
    ["This computer", [...fontRegistry.keys()].filter((n) => !library.has(n))],
  ];
  for (const [label, names] of groups) {
    if (!names.length) continue;
    const group = document.createElement("optgroup");
    group.label = label;
    for (const name of names.sort((a, b) => a.localeCompare(b))) group.append(new Option(name, `custom:${name}`));
    sel.insertBefore(group, before);
  }
  sel.value = fontValue(state.font);
}

function syncFontControls(f) {
  const sel = $("#fontFamily");
  const v = fontValue(f);
  if (f?.family === "custom" && ![...sel.options].some((o) => o.value === v)) {
    sel.insertBefore(new Option(f.name, v), sel.querySelector('[value="__browse"]'));
  }
  if (f?.family === "custom") ensureFontFaces(f.name);
  sel.value = v;
  $("#bold").classList.toggle("active", !!f?.bold);
  $("#italic").classList.toggle("active", !!f?.italic);
}

function setFont(change) {
  state.font = { ...state.font, ...change };
  if (state.font.family !== "custom") delete state.font.name;
  syncFontControls(state.font);
  applyToSelected("font", change.family && change.family !== "custom" ? { ...change, name: undefined } : change);
}

$("#fontFamily").addEventListener("change", async (e) => {
  const v = e.target.value;
  if (v.startsWith("__")) {
    e.target.value = fontValue(state.font);
    if (v === "__browse") return openFontPicker();
    if (v === "__upload") return $("#fileFont").click();
    return loadComputerFonts();
  }
  setFont(v.startsWith("custom:") ? { family: "custom", name: v.slice(7) } : { family: v });
});
$("#fileFont").addEventListener("change", (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (f) uploadFont(f).catch((err) => toast(`Could not load font: ${err.message}`, 5000));
});
// Searchable list of every available font, each previewed in itself (loaded as it scrolls in).
const FONT_SAMPLE = "សួស្តី ព្រះរាជាណាចក្រកម្ពុជា ១២៣ Abc";
let pickerObserver;

function openFontPicker() {
  const list = $("#fontList");
  const library = new Set(libraryFamilies.map((f) => f.name));
  const names = [
    ...[...library].sort((a, b) => a.localeCompare(b)),
    ...[...fontRegistry.keys()].filter((n) => !library.has(n)).sort((a, b) => a.localeCompare(b)),
  ];
  list.innerHTML = "";
  pickerObserver?.disconnect();
  pickerObserver = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        ensureFontFaces(e.target.dataset.name);
        pickerObserver.unobserve(e.target);
      }),
    { root: list, rootMargin: "200px 0px" }
  );
  for (const name of names) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "font-row";
    row.dataset.name = name;
    row.classList.toggle("current", state.font.family === "custom" && state.font.name === name);
    const label = document.createElement("span");
    label.className = "font-name";
    label.textContent = library.has(name) ? name : `${name} · this computer`;
    const sample = document.createElement("span");
    sample.className = "font-sample";
    sample.textContent = FONT_SAMPLE;
    sample.style.fontFamily = `"${name.replace(/"/g, "")}", "PDFE Khmer"`;
    row.append(label, sample);
    row.addEventListener("click", () => {
      setFont({ family: "custom", name });
      $("#fontDlg").close();
    });
    list.append(row);
    pickerObserver.observe(row);
  }
  $("#fontSearch").value = "";
  $("#fontDlg").showModal();
  $("#fontSearch").focus();
  list.querySelector(".current")?.scrollIntoView({ block: "center" });
}

$("#fontSearch").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll(".font-row").forEach((r) => (r.hidden = q && !r.dataset.name.toLowerCase().includes(q)));
});
$("#fontBrowse").addEventListener("click", openFontPicker);

$("#bold").addEventListener("click", () => setFont({ bold: !state.font.bold }));
$("#italic").addEventListener("click", () => setFont({ italic: !state.font.italic }));

function updateButtons() {
  const has = state.pages.length > 0;
  document.querySelectorAll("[data-needs-doc]").forEach((b) => (b.disabled = !has));
  $("#btnUndo").disabled = !history.length;
}

document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
document.querySelectorAll("#swatches button").forEach((b) => b.addEventListener("click", () => setColor(b.dataset.color)));
$("#color").addEventListener("input", (e) => setColor(e.target.value));
$("#stroke").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  if (!(v > 0)) return;
  if (state.tool === "erase") state.eraserSize = v;
  else (state.stroke = v), applyToSelected("width", v);
});
$("#fontSize").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  if (v > 0) (state.fontSize = v), applyToSelected("size", v);
});

$("#btnOpen").addEventListener("click", () => $("#fileOpen").click());
$("#btnAdd").addEventListener("click", () => $("#fileAdd").click());
$("#fileOpen").addEventListener("change", (e) => {
  if (history.length && !confirm("Discard your current edits and open a new file?")) return (e.target.value = "");
  addFiles(e.target.files, true).finally(() => (e.target.value = ""));
});
$("#fileAdd").addEventListener("change", (e) => addFiles(e.target.files, false).finally(() => (e.target.value = "")));
$("#btnImage").addEventListener("click", () => $("#fileImage").click());
$("#fileImage").addEventListener("change", (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (f) addImageFile(f).catch((err) => toast(`Could not load image: ${err.message}`));
});
$("#btnSign").addEventListener("click", openSignature);
$("#zoomIn").addEventListener("click", () => zoomStep(1));
$("#zoomOut").addEventListener("click", () => zoomStep(-1));
$("#zoomFit").addEventListener("click", fitWidth);
$("#zoomLabel").addEventListener("change", (e) => {
  const v = e.target.value;
  if (v === "width") fitWidth();
  else if (v === "page") fitPage();
  else if (v !== "custom") setZoom(Number(v));
  updateZoomLabel();
});

// Ctrl + wheel (and touchpad pinch, which browsers report the same way) zooms around the cursor.
// Wheel ticks are batched so a fast scroll re-renders the pages once, not once per tick.
let wheelZoom = null;
$("#viewer").addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey || !state.pages.length) return;
    e.preventDefault();
    if (!wheelZoom) {
      wheelZoom = { factor: 1, anchor: null };
      setTimeout(() => {
        const { factor, anchor } = wheelZoom;
        wheelZoom = null;
        setZoom(state.zoom * factor, anchor);
      }, 60);
    }
    wheelZoom.factor *= Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.0025);
    wheelZoom.anchor = { clientX: e.clientX, clientY: e.clientY };
  },
  { passive: false }
);

$("#btnGrid").addEventListener("click", () => setGrid({ show: !state.grid.show }));
$("#gridSnap").addEventListener("click", () => setGrid({ snap: !state.grid.snap }));
$("#gridStep").addEventListener("change", (e) => setGrid({ step: Number(e.target.value) }));
$("#btnUndo").addEventListener("click", undo);
$("#btnSave").addEventListener("click", save);
$("#btnSplit").addEventListener("click", () => $("#splitDlg").showModal());
$("#btnForms").addEventListener("click", () => ($("#formsPanel").hidden = !$("#formsPanel").hidden));
$("#closeForms").addEventListener("click", () => ($("#formsPanel").hidden = true));
$("#rotL").addEventListener("click", () => rotatePages(-90));
$("#rotR").addEventListener("click", () => rotatePages(90));
$("#dup").addEventListener("click", duplicatePages);
$("#blank").addEventListener("click", insertBlank);
$("#del").addEventListener("click", deletePages);
$("#extract").addEventListener("click", extract);

document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select") || document.querySelector("dialog[open]")) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === "z") return e.preventDefault(), undo();
  if (mod && k === "s") return e.preventDefault(), save();
  // Ctrl + = / + / − / 0 zoom the document instead of the whole browser page
  if (mod && (k === "=" || k === "+")) return e.preventDefault(), zoomStep(1);
  if (mod && (k === "-" || k === "_")) return e.preventDefault(), zoomStep(-1);
  if (mod && k === "0") return e.preventDefault(), setZoom(1);
  if (!mod && k === "g" && state.pages.length) return setGrid({ show: !state.grid.show });
  if (mod) return;
  if ((e.key === "Delete" || e.key === "Backspace") && state.selected) {
    e.preventDefault();
    const p = pageById(state.selected.pageId);
    snapshot();
    p.annots = p.annots.filter((a) => a.id !== state.selected.annotId);
    state.selected = null;
    return drawOverlay(p.id);
  }
  if (e.key === "Escape") return cancelPlacing(), select(null);
  const tools = { v: "select", t: "text", e: "edittext", d: "draw", h: "highlight", r: "rect", x: "erase" };
  if (tools[k] && state.pages.length) setTool(tools[k]);
});

// Drop PDFs anywhere: onto an empty editor to open, otherwise to merge.
window.addEventListener("dragover", (e) => {
  if (dragThumb != null || !e.dataTransfer.types.includes("Files")) return;
  e.preventDefault();
  $("#viewer").classList.add("drag-over");
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) $("#viewer").classList.remove("drag-over");
});
window.addEventListener("drop", (e) => {
  $("#viewer").classList.remove("drag-over");
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  addFiles(e.dataTransfer.files, state.pages.length === 0);
});
window.addEventListener("beforeunload", (e) => {
  if (history.length) e.preventDefault();
});

setTool("select");
try {
  Object.assign(state.grid, JSON.parse(localStorage.getItem("pdfe.grid") || "{}"));
} catch {
  // no stored grid settings
}
setGrid({});
updateZoomLabel();
updateButtons();

// Redraw once web fonts (bundled Khmer, uploaded fonts) finish loading so the preview is exact.
document.fonts.addEventListener("loadingdone", redrawAll);
// Load the bundled Khmer faces up front so text measured before first use has the right width.
["400", "700"].forEach((w) => document.fonts.load(`${w} 16px "PDFE Khmer"`, "ក").catch(() => {}));
loadFontLibrary();
