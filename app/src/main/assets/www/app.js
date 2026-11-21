// 모아노트 — 화면(웹) 부분.
// - 노트는 WebView 의 IndexedDB 에 저장 (앱 전용 공간, 인터넷 없음). 쪽 배경 그림·썸네일은 Blob 으로 따로 저장.
// - 노트 = 쪽 목록. 쪽 = 크기 + 배경(무지·줄·모눈·점 또는 가져온 문서의 쪽 그림) + 획(펜·형광펜) + 글자 상자.
// - 가져오기: PDF(pdf.js), HWP·HWPX(rhwp 엔진), 사진 → 쪽마다 그림으로 그려 배경으로 씀 → 그 위에 펜으로 씀.
// - 내보내기: 쪽마다 배경+획+글자를 그림으로 그려 PDF 로 묶음 → 저장하거나 다른 앱(카톡·메일·삼성 노트)으로 보냄.
const $ = (id) => document.getElementById(id);
const host = window.MoaHost || null; // 안드로이드 앱이 넣어 주는 다리(MainActivity.kt). 브라우저에서는 없음
const PAGE_W = 794, PAGE_H = 1123;   // A4, 96dpi px
const BG_W = 1588;                   // 가져온 쪽 그림의 가로 픽셀 (쪽 너비의 2배, 약 192dpi)

// ---------- 공통 ----------
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function busy(on, text) { $('busy').hidden = !on; if (text) $('busyText').textContent = text; }
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmtDate(ms) {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return `오늘 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}
function bytesToBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
/**
 * 손가락을 떼는 순간 반응하는 버튼. 손가락으로 그린 직후에는 브라우저가 click 을 한동안 보내지 않는 경우가 있어서
 * (그리기 → 바로 도구 바꾸기가 안 먹힘) pointerup 으로 처리하고, 뒤따르는 같은 자리 click 은 버림. 마우스는 click.
 */
let lastTap = { t: 0, x: 0, y: 0 };
function onTap(el, fn) {
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;
    const r = el.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    lastTap = { t: performance.now(), x: e.clientX, y: e.clientY };
    fn(e);
  });
  el.addEventListener('click', (e) => { if (performance.now() - lastTap.t < 700) return; fn(e); });
}
document.addEventListener('click', (e) => {
  if (performance.now() - lastTap.t < 700 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24) { e.stopPropagation(); e.preventDefault(); }
}, true);
const canvasBlob = (c, type = 'image/jpeg', q = 0.88) => new Promise((res) => c.toBlob(res, type, q));

// ---------- 저장소 (IndexedDB) ----------
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('moanote', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('notes', { keyPath: 'id' });
      d.createObjectStore('folders', { keyPath: 'id' });
      d.createObjectStore('blobs', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const dbAll = (s) => tx(s, 'readonly', (o) => o.getAll());
const dbGet = (s, k) => tx(s, 'readonly', (o) => o.get(k));
const dbPut = (s, v) => tx(s, 'readwrite', (o) => o.put(v));
const dbDel = (s, k) => tx(s, 'readwrite', (o) => o.delete(k));
async function putBlob(blob) { const id = uid(); await dbPut('blobs', { id, blob }); return id; }
const blobCache = new Map(); // blob id → {url, img?}
async function blobUrl(id) {
  if (!id) return null;
  if (blobCache.has(id)) return blobCache.get(id).url;
  const r = await dbGet('blobs', id);
  if (!r) return null;
  const url = URL.createObjectURL(r.blob);
  blobCache.set(id, { url });
  return url;
}
async function blobImage(id) {
  const c = blobCache.get(id);
  if (c && c.img) return c.img;
  const url = await blobUrl(id);
  if (!url) return null;
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  blobCache.get(id).img = img;
  return img;
}

// ---------- 첫 화면: 노트 목록 ----------
const H = { notes: [], folders: [], folder: 'all', query: '' };

async function loadHome() {
  [H.notes, H.folders] = await Promise.all([dbAll('notes'), dbAll('folders')]);
  H.folders.sort((a, b) => a.created - b.created);
  renderFolders(); renderGrid();
}
function renderFolders() {
  const el = $('folders');
  const chip = (id, name) => `<button class="chip${H.folder === id ? ' on' : ''}" data-f="${esc(id)}">${esc(name)}</button>`;
  el.innerHTML = chip('all', '전체') + H.folders.map((f) => chip(f.id, f.name)).join('') + '<button class="chip add" data-f="+">＋ 폴더</button>';
}
$('folders').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  if (b.dataset.f === '+') {
    const name = await ask({ title: '새 폴더 이름', value: '' });
    if (!name) return;
    const f = { id: uid(), name: name.trim(), created: Date.now() };
    await dbPut('folders', f); H.folders.push(f); H.folder = f.id;
  } else H.folder = b.dataset.f;
  renderFolders(); renderGrid();
});
// 폴더 칩을 길게 누르면 이름 바꾸기·지우기
longPress($('folders'), '[data-f]', async (b) => {
  const f = H.folders.find((x) => x.id === b.dataset.f);
  if (!f) return;
  const name = await ask({ title: `폴더 "${f.name}" 이름 바꾸기 (비우면 폴더 지우기)`, value: f.name });
  if (name === null) return;
  if (!name.trim()) {
    for (const n of H.notes.filter((x) => x.folderId === f.id)) { n.folderId = null; await dbPut('notes', n); }
    await dbDel('folders', f.id); H.folders = H.folders.filter((x) => x !== f); H.folder = 'all';
    toast('폴더를 지웠어요 (안의 노트는 "전체"에 남아요)');
  } else { f.name = name.trim(); await dbPut('folders', f); }
  renderFolders(); renderGrid();
});

$('search').addEventListener('input', () => { H.query = $('search').value.trim().toLowerCase(); renderGrid(); });

const KIND = { hwp: 'HWP', pdf: 'PDF', image: '사진' };
async function renderGrid() {
  const q = H.query;
  const list = H.notes
    .filter((n) => H.folder === 'all' || n.folderId === H.folder)
    .filter((n) => !q || (n.title || '').toLowerCase().includes(q) || (n.searchText || '').toLowerCase().includes(q))
    .sort((a, b) => b.modified - a.modified);
  $('emptyHome').hidden = list.length > 0 || !!q || H.notes.length > 0;
  const grid = $('grid');
  grid.innerHTML = list.map((n) => `<button class="card" data-id="${n.id}"><div class="thumb" data-thumb="${n.thumb || ''}">${KIND[n.kind] ? `<span class="kind">${KIND[n.kind]}</span>` : ''}</div>
    <div class="name">${esc(n.title || '제목 없음')}</div><div class="date">${fmtDate(n.modified)} · ${n.pages.length}쪽</div></button>`).join('')
    || (q ? '<p class="muted" style="grid-column:1/-1;text-align:center">찾는 노트가 없어요</p>' : '');
  for (const t of grid.querySelectorAll('.thumb[data-thumb]')) {
    const id = t.dataset.thumb;
    if (id) blobUrl(id).then((u) => { if (u) t.style.backgroundImage = `url("${u}")`; });
  }
}
$('grid').addEventListener('click', (e) => {
  const c = e.target.closest('.card');
  if (c && !c.dataset.longed) openNote(c.dataset.id);
  if (c) delete c.dataset.longed;
});
longPress($('grid'), '.card', (c) => { c.dataset.longed = '1'; openNoteMenu(H.notes.find((n) => n.id === c.dataset.id)); });

/** 길게 누르기 (550ms) */
function longPress(root, sel, fn) {
  let t = 0, sx = 0, sy = 0;
  root.addEventListener('pointerdown', (e) => {
    const el = e.target.closest(sel);
    if (!el) return;
    sx = e.clientX; sy = e.clientY;
    t = setTimeout(() => { t = 0; fn(el); }, 550);
  });
  const cancel = () => { if (t) { clearTimeout(t); t = 0; } };
  root.addEventListener('pointerup', cancel);
  root.addEventListener('pointercancel', cancel);
  root.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
  root.addEventListener('contextmenu', (e) => { if (e.target.closest(sel)) e.preventDefault(); });
}

// ---------- 새 노트 ----------
$('fab').onclick = () => { $('newSheet').hidden = false; };
$('newSheet').addEventListener('click', async (e) => {
  const sheet = $('newSheet');
  const b = e.target.closest('button');
  if (e.target === sheet || (b && b.dataset.c === 'cancel')) { sheet.hidden = true; return; }
  if (!b) return;
  if (b.dataset.tpl) { sheet.hidden = true; const n = await createNote(b.dataset.tpl); openNote(n.id); }
  if (b.dataset.c === 'import') { sheet.hidden = true; importFiles(); }
});
const TPL_NAME = { blank: '무지', lined: '줄 노트', grid: '모눈', dots: '점' };
function blankPage(tpl) { return { id: uid(), w: PAGE_W, h: PAGE_H, bg: { t: tpl || 'blank' }, strokes: [], texts: [] }; }
async function createNote(tpl, extra = {}) {
  const now = Date.now();
  const n = { id: uid(), title: `${TPL_NAME[tpl] || '노트'} ${fmtDate(now)}`, folderId: H.folder !== 'all' ? H.folder : null,
    created: now, modified: now, kind: 'note', tpl: tpl || 'blank', pages: [blankPage(tpl)], thumb: null, searchText: '', ...extra };
  await dbPut('notes', n);
  H.notes.push(n);
  return n;
}

// ---------- 가져오기 (HWP·PDF·사진 → 노트) ----------
function importFiles() {
  if (host) host.importFile(); else $('fileInput').click();
}
$('fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  let last = null;
  for (const f of files) last = await importBytes(new Uint8Array(await f.arrayBuffer()), f.name, f.type) || last;
  if (last) openNote(last.id);
});

function detectKind(bytes, name, mime) {
  const ext = (/\.([^.]+)$/.exec(name || '') || [])[1]?.toLowerCase() || '';
  const head = String.fromCharCode(...bytes.subarray(0, 8));
  if (head.startsWith('%PDF') || ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === 'hwp' || ext === 'hwpx' || /hwp/i.test(mime || '')) return 'hwp';
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'hwp'; // HWP 5.0 (OLE)
  if (head.startsWith('PK') && ext !== 'zip') return 'hwp';                                            // HWPX (ZIP)
  if (/^image\//.test(mime || '') || /^(jpe?g|png|webp|gif|heic|bmp)$/.test(ext)) return 'image';
  if ((bytes[0] === 0xff && bytes[1] === 0xd8) || head.startsWith('\x89PNG')) return 'image';
  return '';
}

/** 파일 하나를 새 노트로 가져옴. 성공하면 노트, 아니면 null */
async function importBytes(bytes, name, mime) {
  const kind = detectKind(bytes, name, mime);
  const title = (name || '문서').replace(/\.[^.]+$/, '');
  if (!kind) { toast(`가져올 수 없는 파일이에요: ${name}`, 4000); return null; }
  busy(true, `${name} 가져오는 중…`);
  try {
    let pages;
    if (kind === 'pdf') pages = await pdfPages(bytes, name);
    else if (kind === 'hwp') pages = await hwpPages(bytes, name);
    else pages = [await imagePage(bytes, mime)];
    if (!pages.length) throw new Error('쪽이 없어요');
    const n = await createNote('blank', { title, kind, pages, source: name });
    await saveNote(n, true);
    toast(`${pages.length}쪽을 가져왔어요 · 펜으로 써 보세요`);
    return n;
  } catch (e) {
    toast(`가져오지 못했어요 (${name}): ${String(e.message || e)}`, 5000);
    return null;
  } finally {
    busy(false);
  }
}

async function pageFromCanvas(c, wPage) {
  const blob = await canvasBlob(c, 'image/jpeg', 0.86);
  const id = await putBlob(blob);
  const w = wPage || PAGE_W;
  return { id: uid(), w, h: Math.round(w * c.height / c.width), bg: { t: 'img', blob: id }, strokes: [], texts: [] };
}

let pdfjs = null;
async function loadPdfJs() {
  if (!pdfjs) {
    pdfjs = await import('./pdfjs/pdf.min.js');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.min.js', import.meta.url).href;
  }
  return pdfjs;
}
async function pdfPages(bytes, name) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({
    data: bytes, cMapUrl: new URL('./pdfjs/cmaps/', import.meta.url).href, cMapPacked: true,
    standardFontDataUrl: new URL('./pdfjs/standard_fonts/', import.meta.url).href, isEvalSupported: false,
  }).promise;
  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      busy(true, `${name} 가져오는 중… ${i} / ${doc.numPages}`);
      const pg = await doc.getPage(i);
      const v1 = pg.getViewport({ scale: 1 });
      const vp = pg.getViewport({ scale: BG_W / v1.width });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: g, viewport: vp }).promise;
      pages.push(await pageFromCanvas(c));
      pg.cleanup();
    }
  } finally { doc.destroy(); }
  return pages;
}

let rhwp = null;
async function loadRhwp() {
  if (!rhwp) {
    let mctx = null, mfont = '';
    globalThis.measureTextWidth = (font, text) => {
      if (!mctx) mctx = document.createElement('canvas').getContext('2d');
      if (font !== mfont) { mctx.font = font; mfont = font; }
      return mctx.measureText(text).width;
    };
    const m = await import('./engine/rhwp.js');
    await m.default({ module_or_path: new URL('./engine/rhwp_bg.wasm', import.meta.url) });
    rhwp = m;
  }
  return rhwp;
}
async function svgToCanvas(svg, w, h, k) {
  svg = svg.replace(/<svg\b([^>]*)>/, (m, a) => `<svg${a.replace(/\s(width|height)="[^"]*"/g, '')} width="${w}" height="${h}">`);
  if (!/xmlns=/.test(svg.slice(0, 300))) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('쪽을 그리지 못했어요')); img.src = url; });
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
async function hwpPages(bytes, name) {
  const m = await loadRhwp();
  const doc = new m.HwpDocument(bytes);
  const n = doc.pageCount();
  const pages = [];
  for (let i = 0; i < n; i++) {
    busy(true, `${name} 가져오는 중… ${i + 1} / ${n}`);
    let w = PAGE_W, h = PAGE_H;
    try { const info = JSON.parse(doc.getPageInfo(i)); w = info.width; h = info.height; } catch { /* 기본 A4 */ }
    const c = await svgToCanvas(doc.renderPageSvg(i), w, h, BG_W / w);
    pages.push(await pageFromCanvas(c));
  }
  try { doc.free(); } catch { /* 무시 */ }
  return pages;
}
async function imagePage(bytes, mime) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime || 'image/*' }));
  const k = Math.min(1, BG_W / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return pageFromCanvas(c);
}

// ---------- 쪽 그리기 (화면·썸네일·PDF 공통) ----------
function drawTemplate(g, t, w, h) {
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.save();
  if (t === 'lined') {
    g.strokeStyle = '#c7d2fe'; g.lineWidth = 1;
    for (let y = 96; y < h - 40; y += 32) { g.beginPath(); g.moveTo(40, y + 0.5); g.lineTo(w - 40, y + 0.5); g.stroke(); }
  } else if (t === 'grid') {
    g.strokeStyle = '#e0e7ff'; g.lineWidth = 1;
    for (let x = 22; x < w; x += 25) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); g.stroke(); }
    for (let y = 22; y < h; y += 25) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(w, y + 0.5); g.stroke(); }
  } else if (t === 'dots') {
    g.fillStyle = '#a5b4fc';
    for (let y = 22; y < h; y += 25) for (let x = 22; x < w; x += 25) { g.beginPath(); g.arc(x, y, 1.3, 0, Math.PI * 2); g.fill(); }
  }
  g.restore();
}
/** 획 하나: 펜은 필압에 따라 굵기가 바뀌고, 형광펜은 반투명 고정 굵기 */
function drawStroke(g, s) {
  const p = s.pts;
  if (!p.length) return;
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = s.color; g.fillStyle = s.color;
  if (s.tool === 'hl') {
    g.globalAlpha = 0.35; g.lineWidth = s.width;
    g.beginPath(); g.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) g.lineTo(p[i][0], p[i][1]);
    if (p.length === 1) g.lineTo(p[0][0] + 0.1, p[0][1]);
    g.stroke();
  } else if (p.length === 1) {
    g.beginPath(); g.arc(p[0][0], p[0][1], widthAt(s, p[0][2]) / 2, 0, Math.PI * 2); g.fill();
  } else {
    for (let i = 1; i < p.length; i++) {
      g.lineWidth = widthAt(s, (p[i - 1][2] + p[i][2]) / 2);
      g.beginPath(); g.moveTo(p[i - 1][0], p[i - 1][1]); g.lineTo(p[i][0], p[i][1]); g.stroke();
    }
  }
  g.restore();
}
const widthAt = (s, pr) => s.width * (0.35 + 1.0 * (pr == null ? 0.5 : pr));
function drawText(g, t) {
  g.save();
  g.fillStyle = t.color || '#111827';
  g.font = `${t.size}px "Noto Sans KR", sans-serif`;
  g.textBaseline = 'top';
  const lh = t.size * 1.35, maxW = Math.max(40, t.w || 9999);
  let y = t.y + 2;
  for (const para of String(t.text).split('\n')) {
    let line = '';
    for (const ch of para) {
      if (line && g.measureText(line + ch).width > maxW) { g.fillText(line, t.x + 4, y); y += lh; line = ch; } else line += ch;
    }
    g.fillText(line, t.x + 4, y); y += lh;
  }
  g.restore();
}
/** 쪽 하나를 캔버스에 (배경 포함 여부, 배율) */
async function renderPageTo(page, k, withInk = true) {
  const c = document.createElement('canvas');
  c.width = Math.round(page.w * k); c.height = Math.round(page.h * k);
  const g = c.getContext('2d');
  g.setTransform(k, 0, 0, k, 0, 0);
  if (page.bg.t === 'img') {
    g.fillStyle = '#fff'; g.fillRect(0, 0, page.w, page.h);
    const img = await blobImage(page.bg.blob);
    if (img) g.drawImage(img, 0, 0, page.w, page.h);
  } else drawTemplate(g, page.bg.t, page.w, page.h);
  if (withInk) { for (const s of page.strokes) drawStroke(g, s); for (const t of page.texts) drawText(g, t); }
  return c;
}

// ---------- 노트 편집 ----------
const E = {
  note: null, tool: 'pen', penOnly: false, scale: 1, els: [], undo: [], redo: [],
  style: { pen: { color: '#111827', width: 2.4 }, hl: { color: '#facc15', width: 18 }, eraser: { width: 14 } },
  pointers: new Map(), pan: null, saveTimer: 0, thumbTimer: 0, penHinted: false,
};
try { E.penOnly = localStorage.getItem('moa.penOnly') === '1'; Object.assign(E.style, JSON.parse(localStorage.getItem('moa.style') || '{}')); } catch { /* 처음 */ }

const PALETTE = {
  pen: { colors: ['#111827', '#1d4ed8', '#dc2626', '#16a34a', '#9333ea', '#ea580c'], widths: [1.4, 2.4, 4] },
  hl: { colors: ['#facc15', '#4ade80', '#f472b6', '#60a5fa'], widths: [12, 18, 28] },
  eraser: { colors: [], widths: [8, 14, 28] },
};

async function openNote(id) {
  const n = H.notes.find((x) => x.id === id) || await dbGet('notes', id);
  if (!n) { toast('노트를 찾지 못했어요'); return; }
  E.note = n; E.undo = []; E.redo = [];
  $('noteTitle').value = n.title || '';
  $('home').hidden = true; $('editor').hidden = false;
  document.body.dataset.screen = 'editor';
  setTool('pen'); // 노트를 열면 늘 펜부터
  document.body.classList.toggle('penOnly', E.penOnly);
  $('penOnly').setAttribute('aria-pressed', String(E.penOnly));
  updateUndo();
  buildPages();
  $('pages').scrollTop = 0;
}
async function closeNote() {
  if (!E.note) return;
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  await flushSave();
  pageObserver.disconnect();
  $('pages').innerHTML = ''; E.els = [];
  E.note = null;
  $('editor').hidden = true; $('home').hidden = false;
  document.body.dataset.screen = 'home';
  renderGrid();
}
onTap($('back'), closeNote);
$('noteTitle').addEventListener('input', () => { if (E.note) { E.note.title = $('noteTitle').value; scheduleSave(); } });

function computeScale() {
  const maxW = Math.max(...E.note.pages.map((p) => p.w));
  return Math.min(2, Math.max(0.3, ($('pages').clientWidth - 20) / maxW));
}
const pageObserver = new IntersectionObserver((entries) => {
  for (const en of entries) {
    const i = +en.target.dataset.i;
    if (en.isIntersecting) drawPageEl(i); else releasePageEl(i);
  }
}, { root: $('pages'), rootMargin: '600px 0px' });

function buildPages() {
  const box = $('pages');
  pageObserver.disconnect();
  box.innerHTML = ''; E.els = [];
  E.scale = computeScale();
  E.note.pages.forEach((pg, i) => {
    const el = document.createElement('div');
    el.className = 'page'; el.dataset.i = String(i);
    el.style.width = `${pg.w * E.scale}px`; el.style.height = `${pg.h * E.scale}px`;
    el.innerHTML = `<canvas class="bg"></canvas><canvas class="ink"></canvas><div class="pno">${i + 1} / ${E.note.pages.length}</div>`;
    const ink = el.querySelector('.ink');
    ink.addEventListener('pointerdown', onDown); ink.addEventListener('pointermove', onMove);
    ink.addEventListener('pointerup', onUp); ink.addEventListener('pointercancel', onUp);
    box.appendChild(el);
    E.els.push({ el, bg: el.querySelector('.bg'), ink, drawn: false });
    for (const t of pg.texts) addTextEl(i, t);
    pageObserver.observe(el);
  });
  const add = document.createElement('button');
  add.className = 'addPage'; add.textContent = '＋ 빈 쪽 추가';
  onTap(add, () => addPage());
  box.appendChild(add);
}
function canvasK() { return Math.min(E.scale * (window.devicePixelRatio || 1), 3); }
async function drawPageEl(i) {
  const pe = E.els[i], pg = E.note.pages[i];
  if (!pe) return;
  const k = canvasK();
  for (const c of [pe.bg, pe.ink]) { c.width = Math.round(pg.w * k); c.height = Math.round(pg.h * k); }
  const g = pe.bg.getContext('2d');
  g.setTransform(k, 0, 0, k, 0, 0);
  if (pg.bg.t === 'img') {
    g.fillStyle = '#fff'; g.fillRect(0, 0, pg.w, pg.h);
    const img = await blobImage(pg.bg.blob);
    if (img && E.els[i] === pe) g.drawImage(img, 0, 0, pg.w, pg.h);
  } else drawTemplate(g, pg.bg.t, pg.w, pg.h);
  redrawInk(i);
  pe.drawn = true;
}
function releasePageEl(i) {
  const pe = E.els[i];
  if (!pe || !pe.drawn) return;
  pe.bg.width = 0; pe.ink.width = 0; pe.drawn = false; // 멀리 있는 쪽은 메모리를 놓아 줌
}
function redrawInk(i) {
  const pe = E.els[i], pg = E.note.pages[i];
  if (!pe || !pe.ink.width) return;
  const k = pe.ink.width / pg.w;
  const g = pe.ink.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, pe.ink.width, pe.ink.height);
  g.setTransform(k, 0, 0, k, 0, 0);
  for (const s of pg.strokes) drawStroke(g, s);
}
window.addEventListener('resize', () => {
  if (!E.note) return;
  const s = computeScale();
  if (Math.abs(s - E.scale) > 0.01) { const y = $('pages').scrollTop / E.scale; buildPages(); $('pages').scrollTop = y * E.scale; }
});

// 도구
function setTool(t) {
  E.tool = t;
  document.body.dataset.tool = t;
  for (const b of document.querySelectorAll('#tools [data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
  buildPenBar();
  if (t !== 'text' && document.activeElement && document.activeElement.classList.contains('tbox')) document.activeElement.blur();
}
function buildPenBar() {
  const bar = $('penBar'), t = E.tool;
  if (t === 'text') { bar.innerHTML = '<span class="hint">글자를 넣을 곳을 누르세요 · 쓴 글자를 누르면 고칠 수 있어요</span>'; return; }
  if (t === 'scroll') { bar.innerHTML = '<span class="hint">손가락으로 쪽을 넘겨 보세요 (그려지지 않아요)</span>'; return; }
  const pal = PALETTE[t], st = E.style[t];
  let html = pal.colors.map((c) => `<button class="pc${c === st.color ? ' on' : ''}" style="--c:${c}" data-color="${c}" aria-label="색"></button>`).join('');
  if (pal.colors.length) html += '<span class="vsep"></span>';
  html += pal.widths.map((w) => `<button class="pw${w === st.width ? ' on' : ''}" data-w="${w}" aria-label="굵기"><i style="height:${Math.max(2, Math.min(9, t === 'pen' ? w * 1.6 : w / 3))}px"></i></button>`).join('');
  if (t === 'eraser') html += '<span class="hint">문지른 획이 지워져요</span>';
  bar.innerHTML = html;
}
onTap($('tools'), (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'penOnly') {
    E.penOnly = !E.penOnly;
    try { localStorage.setItem('moa.penOnly', E.penOnly ? '1' : '0'); } catch { /* 무시 */ }
    document.body.classList.toggle('penOnly', E.penOnly);
    b.setAttribute('aria-pressed', String(E.penOnly));
    toast(E.penOnly ? 'S펜으로만 써요 · 손가락은 화면을 넘겨요' : '손가락으로도 써요 · 화면 넘기기는 두 손가락');
    return;
  }
  if (b.dataset.tool) setTool(b.dataset.tool);
});
onTap($('penBar'), (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const st = E.style[E.tool];
  if (b.dataset.color) st.color = b.dataset.color;
  if (b.dataset.w) st.width = +b.dataset.w;
  try { localStorage.setItem('moa.style', JSON.stringify(E.style)); } catch { /* 무시 */ }
  buildPenBar();
});

// 그리기 (펜·형광펜·지우개)
function pt(e, el) {
  const r = el.getBoundingClientRect();
  const pr = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
  return [(e.clientX - r.left) / E.scale, (e.clientY - r.top) / E.scale, Math.round(pr * 100) / 100];
}
function onDown(e) {
  const i = +e.currentTarget.parentNode.dataset.i;
  if (E.tool === 'text') { e.preventDefault(); const [x, y] = pt(e, e.currentTarget); newText(i, x, y); return; }
  if (E.tool === 'scroll') return;
  if (e.pointerType === 'pen' && !E.penOnly && !E.penHinted) { E.penHinted = true; toast('S펜이 감지됐어요 · "S펜만"을 켜면 손바닥이 닿아도 그려지지 않아요', 4000); }
  if (E.penOnly && e.pointerType === 'touch') return; // 손가락은 화면 넘기기
  e.preventDefault();
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
  E.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, page: i, stroke: null, erased: null });
  if (E.pointers.size >= 2) {
    for (const p of E.pointers.values()) if (p.stroke) { const list = E.note.pages[p.page].strokes; const k = list.indexOf(p.stroke); if (k >= 0) list.splice(k, 1); redrawInk(p.page); p.stroke = null; }
    E.pan = mid();
    return;
  }
  const p = E.pointers.get(e.pointerId);
  checkpoint(i);
  if (E.tool === 'eraser') { p.erased = 0; eraseAt(i, pt(e, e.currentTarget)); return; }
  const st = E.style[E.tool];
  p.stroke = { tool: E.tool, color: st.color, width: st.width, pts: [pt(e, e.currentTarget)] };
  E.note.pages[i].strokes.push(p.stroke);
  redrawInk(i);
}
function onMove(e) {
  const p = E.pointers.get(e.pointerId);
  if (!p) return;
  e.preventDefault();
  p.x = e.clientX; p.y = e.clientY;
  if (E.pan) { const m = mid(); $('pages').scrollLeft -= m.x - E.pan.x; $('pages').scrollTop -= m.y - E.pan.y; E.pan = m; return; }
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  if (E.tool === 'eraser' && p.erased != null) { for (const ce of events) eraseAt(p.page, pt(ce, e.currentTarget)); return; }
  if (!p.stroke) return;
  const pe = E.els[p.page];
  const k = pe.ink.width / E.note.pages[p.page].w;
  const g = pe.ink.getContext('2d');
  for (const ce of events) {
    const q = pt(ce, e.currentTarget), last = p.stroke.pts[p.stroke.pts.length - 1];
    if (Math.hypot(q[0] - last[0], q[1] - last[1]) < 0.5) continue;
    p.stroke.pts.push(q);
    if (p.stroke.tool === 'pen') { // 펜은 이어 그리기, 형광펜은 겹침이 진해지지 않게 전체 다시 그림
      g.setTransform(k, 0, 0, k, 0, 0);
      drawStroke(g, { ...p.stroke, pts: [last, q] });
    }
  }
  if (p.stroke.tool !== 'pen') redrawInk(p.page);
}
function onUp(e) {
  const p = E.pointers.get(e.pointerId);
  E.pointers.delete(e.pointerId);
  if (E.pointers.size < 2) E.pan = null;
  if (!p) return;
  if (p.stroke || (p.erased > 0)) scheduleSave();
  else if (p.erased === 0) E.undo.pop(), updateUndo(); // 지운 게 없으면 되돌리기 기록도 뺌
}
function mid() { let x = 0, y = 0; for (const p of E.pointers.values()) { x += p.x; y += p.y; } return { x: x / E.pointers.size, y: y / E.pointers.size }; }
function eraseAt(i, [x, y]) {
  const pg = E.note.pages[i], r = E.style.eraser.width;
  const before = pg.strokes.length;
  pg.strokes = pg.strokes.filter((s) => !s.pts.some((q, k) => {
    const prev = s.pts[k - 1] || q;
    return distSeg(x, y, prev[0], prev[1], q[0], q[1]) < r + (s.tool === 'hl' ? s.width / 2 : 2);
  }));
  if (pg.strokes.length !== before) {
    for (const p of E.pointers.values()) if (p.page === i && p.erased != null) p.erased += before - pg.strokes.length;
    redrawInk(i);
  }
}
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// 글자 상자
function addTextEl(i, t) {
  const el = document.createElement('div');
  el.className = 'tbox'; el.contentEditable = 'true'; el.spellcheck = false;
  el.textContent = t.text;
  el.dataset.id = t.id;
  placeTextEl(el, t, i);
  let snap = null;
  el.addEventListener('focus', () => { snap = clone(E.note.pages[i]); });
  el.addEventListener('input', () => { t.text = el.innerText.replace(/\n$/, ''); t.w = el.offsetWidth / E.scale; scheduleSave(); });
  el.addEventListener('blur', () => {
    const pg = E.note.pages[i];
    if (!t.text.trim()) { pg.texts = pg.texts.filter((x) => x !== t); el.remove(); }
    if (snap && JSON.stringify(snap.texts) !== JSON.stringify(pg.texts)) { E.undo.push({ i, page: snap }); E.redo = []; updateUndo(); scheduleSave(); }
    snap = null;
  });
  E.els[i].el.appendChild(el);
  return el;
}
function placeTextEl(el, t, i) {
  el.style.left = `${t.x * E.scale}px`; el.style.top = `${t.y * E.scale}px`;
  el.style.fontSize = `${t.size * E.scale}px`;
  el.style.maxWidth = `${Math.max(60, (E.note.pages[i].w - t.x - 8) * E.scale)}px`;
}
function newText(i, x, y) {
  const t = { id: uid(), x, y: y - 10, text: '', size: 18, color: E.style.pen.color, w: 0 };
  E.note.pages[i].texts.push(t);
  const el = addTextEl(i, t);
  setTimeout(() => el.focus(), 0);
}

// 되돌리기 (쪽 단위로 바뀌기 전 모습을 기억)
function checkpoint(i) { E.undo.push({ i, page: clone(E.note.pages[i]) }); if (E.undo.length > 80) E.undo.shift(); E.redo = []; updateUndo(); }
function updateUndo() { $('undo').disabled = !E.undo.length; $('redo').disabled = !E.redo.length; }
function swapHistory(from, to) {
  const h = from.pop();
  if (!h) return;
  if (h.pages) { to.push({ pages: clone(E.note.pages) }); E.note.pages = h.pages; buildPages(); }
  else { to.push({ i: h.i, page: clone(E.note.pages[h.i]) }); E.note.pages[h.i] = h.page; refreshPage(h.i); }
  updateUndo(); scheduleSave();
}
function refreshPage(i) {
  const pe = E.els[i];
  if (!pe) return;
  for (const el of pe.el.querySelectorAll('.tbox')) el.remove();
  for (const t of E.note.pages[i].texts) addTextEl(i, t);
  redrawInk(i);
}
onTap($('undo'), () => { if (!$('undo').disabled) swapHistory(E.undo, E.redo); });
onTap($('redo'), () => { if (!$('redo').disabled) swapHistory(E.redo, E.undo); });

// 쪽 추가·지우기
function currentPageIndex() {
  const box = $('pages'), mid = box.scrollTop + box.clientHeight / 2;
  let best = 0;
  E.els.forEach((pe, i) => { if (pe.el.offsetTop <= mid) best = i; });
  return best;
}
function addPage() {
  E.undo.push({ pages: clone(E.note.pages) }); E.redo = []; updateUndo();
  const last = E.note.pages[E.note.pages.length - 1];
  const tpl = E.note.kind === 'note' ? (E.note.tpl || 'blank') : 'blank';
  const pg = blankPage(tpl);
  if (last && last.bg.t !== 'img') { pg.w = last.w; pg.h = last.h; }
  E.note.pages.push(pg);
  buildPages(); scheduleSave();
  E.els[E.els.length - 1].el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function deletePage() {
  if (E.note.pages.length <= 1) { toast('마지막 한 쪽은 지울 수 없어요'); return; }
  const i = currentPageIndex();
  E.undo.push({ pages: clone(E.note.pages) }); E.redo = []; updateUndo();
  E.note.pages.splice(i, 1);
  buildPages(); scheduleSave();
  toast(`${i + 1}쪽을 지웠어요 · 되돌리기(↶)로 살릴 수 있어요`);
}

// 저장 (잠깐 멈추면 자동 저장, 썸네일은 조금 더 뒤에)
function scheduleSave() {
  clearTimeout(E.saveTimer);
  E.saveTimer = setTimeout(() => saveNote(E.note), 700);
}
async function flushSave() { if (E.saveTimer) { clearTimeout(E.saveTimer); E.saveTimer = 0; await saveNote(E.note, true); } }
async function saveNote(n, withThumb = false) {
  if (!n) return;
  E.saveTimer = 0;
  n.modified = Date.now();
  n.searchText = n.pages.map((p) => p.texts.map((t) => t.text).join(' ')).join(' ').slice(0, 5000);
  if (withThumb) await makeThumb(n);
  else { clearTimeout(E.thumbTimer); E.thumbTimer = setTimeout(() => makeThumb(n).then(() => dbPut('notes', n)), 2500); }
  await dbPut('notes', n);
  const k = H.notes.findIndex((x) => x.id === n.id);
  if (k >= 0) H.notes[k] = n; else H.notes.push(n);
}
async function makeThumb(n) {
  try {
    const c = await renderPageTo(n.pages[0], 300 / n.pages[0].w);
    const old = n.thumb;
    n.thumb = await putBlob(await canvasBlob(c, 'image/jpeg', 0.8));
    if (old) { await dbDel('blobs', old); const ce = blobCache.get(old); if (ce) { URL.revokeObjectURL(ce.url); blobCache.delete(old); } }
  } catch { /* 썸네일은 없어도 됨 */ }
}

// ---------- 노트 메뉴 (보내기·폴더·지우기) ----------
let menuNote = null;
function openNoteMenu(n) {
  if (!n) return;
  menuNote = n;
  $('noteMenuTitle').textContent = n.title || '노트';
  $('noteMenu').hidden = false;
}
onTap($('noteMenuBtn'), async () => { await flushSave(); openNoteMenu(E.note); });
onTap($('noteMenu'), async (e) => {
  const sheet = $('noteMenu');
  const b = e.target.closest('button');
  if (e.target === sheet || (b && b.dataset.c === 'cancel')) { sheet.hidden = true; return; }
  if (!b) return;
  sheet.hidden = true;
  const n = menuNote;
  switch (b.dataset.c) {
    case 'share': exportPdf(n, 'share'); break;
    case 'savePdf': exportPdf(n, 'save'); break;
    case 'addPage': addPage(); break;
    case 'delPage': deletePage(); break;
    case 'move': {
      const pick = await ask({ title: '어느 폴더로 옮길까요?', list: [{ id: '', name: '폴더 없음 (전체)' }, ...H.folders], value: n.folderId || '' });
      if (pick === null) return;
      n.folderId = pick || null; await dbPut('notes', n); renderGrid();
      toast('옮겼어요');
      break;
    }
    case 'rename': {
      const name = await ask({ title: '노트 이름', value: n.title });
      if (name === null || !name.trim()) return;
      n.title = name.trim(); await dbPut('notes', n); renderGrid();
      break;
    }
    case 'delete': {
      const ok = await ask({ title: `"${n.title}" 노트를 지울까요? 되돌릴 수 없어요.`, confirm: true });
      if (!ok) return;
      for (const p of n.pages) if (p.bg.blob) await dbDel('blobs', p.bg.blob);
      if (n.thumb) await dbDel('blobs', n.thumb);
      await dbDel('notes', n.id);
      H.notes = H.notes.filter((x) => x.id !== n.id);
      if (E.note && E.note.id === n.id) { E.note = null; E.saveTimer && clearTimeout(E.saveTimer); E.saveTimer = 0; await closeNote(); }
      renderGrid();
      toast('노트를 지웠어요');
      break;
    }
    default:
  }
});

/** 묻는 창: 글자 입력(value), 목록에서 고르기(list), 예/아니오(confirm). 취소하면 null */
function ask({ title, value = '', list = null, confirm = false }) {
  return new Promise((resolve) => {
    const sheet = $('askSheet'), input = $('askInput'), lb = $('askList');
    $('askTitle').textContent = title;
    input.hidden = !!list || confirm; input.value = value;
    lb.innerHTML = list ? list.map((f) => `<button data-v="${esc(f.id)}" class="${f.id === value ? 'on' : ''}">${esc(f.name)}</button>`).join('') : '';
    let chosen = value;
    sheet.hidden = false;
    if (!input.hidden) setTimeout(() => { input.focus(); input.select(); }, 50);
    const done = (v) => { sheet.hidden = true; sheet.onclick = null; input.onkeydown = null; resolve(v); };
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value); };
    sheet.onclick = (e) => {
      const b = e.target.closest('button');
      if (e.target === sheet || (b && b.dataset.c === 'cancel')) { done(null); return; }
      if (!b) return;
      if (b.dataset.v != null) { chosen = b.dataset.v; for (const x of lb.children) x.classList.toggle('on', x === b); return; }
      if (b.dataset.c === 'ok') done(confirm ? true : list ? chosen : input.value);
    };
  });
}

// ---------- PDF 로 내보내기 ----------
function buildPdf(pages) {
  const enc = new TextEncoder();
  const chunks = []; let len = 0; const offs = [];
  const put = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); len += b.length; };
  const obj = (n, body) => { offs[n] = len; put(`${n} 0 obj\n`); for (const b of [].concat(body)) put(b); put('\nendobj\n'); };
  put('%PDF-1.4\n%\n');
  const n = pages.length;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${n} >>`);
  pages.forEach((pg, i) => {
    const po = 3 + i * 3, co = po + 1, io = po + 2;
    const w = pg.ptW.toFixed(2), h = pg.ptH.toFixed(2);
    obj(po, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${io} 0 R >> >> /Contents ${co} 0 R >>`);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(co, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    obj(io, [`<< /Type /XObject /Subtype /Image /Width ${pg.pxW} /Height ${pg.pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.jpeg.length} >>\nstream\n`, pg.jpeg, '\nendstream']);
  });
  const xref = len, total = 3 + n * 3;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let k = 1; k < total; k++) x += `${String(offs[k]).padStart(10, '0')} 00000 n \n`;
  put(x);
  put(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len); let o = 0;
  for (const b of chunks) { out.set(b, o); o += b.length; }
  return out;
}
let savingPdf = false;
async function exportPdf(n, target) {
  if (!n) return;
  if (E.note && E.note.id === n.id) await flushSave();
  const pages = [];
  try {
    for (let i = 0; i < n.pages.length; i++) {
      busy(true, `PDF 만드는 중… ${i + 1} / ${n.pages.length}`);
      const pg = n.pages[i];
      const c = await renderPageTo(pg, BG_W / pg.w);
      pages.push({ jpeg: new Uint8Array(await (await canvasBlob(c, 'image/jpeg', 0.88)).arrayBuffer()), pxW: c.width, pxH: c.height, ptW: pg.w * 0.75, ptH: pg.h * 0.75 });
    }
  } catch (e) { busy(false); toast(`PDF 를 만들지 못했어요: ${String(e.message || e)}`, 4000); return; }
  busy(false);
  const bytes = buildPdf(pages);
  const name = `${(n.title || '노트').replace(/[\\/:*?"<>|]/g, '_')}.pdf`;
  if (host && target === 'share') { host.sharePdf(bytesToBase64(bytes), name); return; }
  if (host) { savingPdf = true; host.saveFile(bytesToBase64(bytes), name, 'application/pdf'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`PDF 를 만들었어요: ${name}`);
}

// ---------- 앱 정보 ----------
$('infoBtn').onclick = () => { $('docText').hidden = true; $('infoSheet').hidden = false; };
$('infoSheet').addEventListener('click', async (e) => {
  const sheet = $('infoSheet');
  const b = e.target.closest('button');
  if (e.target === sheet || (b && b.dataset.c === 'cancel')) { sheet.hidden = true; return; }
  if (b && b.dataset.doc) {
    try { $('docText').textContent = await (await fetch(b.dataset.doc)).text(); } catch { $('docText').textContent = '불러오지 못했어요'; }
    $('docText').hidden = false;
  }
});

// ---------- 안드로이드 앱과 주고받는 함수 ----------
window.moaApp = {
  /** 앱이 고른(또는 다른 앱에서 받은) 파일을 /__doc__/current 로 넣어 두고 부름 */
  async importFromHost(name, mime) {
    let note = null;
    try {
      const res = await fetch('/__doc__/current', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (E.note) await closeNote();
      note = await importBytes(new Uint8Array(await res.arrayBuffer()), name, mime);
    } catch (e) {
      toast(`파일을 읽지 못했어요: ${String(e.message || e)}`, 4000);
    } finally {
      if (host && host.importFinished) host.importFinished();
    }
    if (note) { renderGrid(); openNote(note.id); }
  },
  onSaved(ok, nameOrMsg) {
    savingPdf = false;
    if (ok) toast(`저장했어요: ${nameOrMsg}`);
    else if (nameOrMsg) toast(`저장하지 못했어요: ${nameOrMsg}`, 4000);
  },
  /** 뒤로가기: 열린 창 → 편집 화면 → 앱 닫기 */
  handleBack() {
    for (const id of ['askSheet', 'noteMenu', 'newSheet', 'infoSheet']) if (!$(id).hidden) { if (id === 'askSheet') $(id).click(); else $(id).hidden = true; return; }
    if (E.note) { closeNote(); return; }
    if (H.query) { $('search').value = ''; H.query = ''; renderGrid(); return; }
    if (host) host.exit();
  },
};
window.addEventListener('beforeunload', () => { if (E.note && E.saveTimer) saveNote(E.note); });
document.addEventListener('visibilitychange', () => { if (document.hidden && E.note) flushSave(); });

// ---------- 시작 ----------
(async () => {
  try { await loadHome(); } catch (e) { toast(`노트를 불러오지 못했어요: ${String(e.message || e)}`, 6000); }
  window.moaApp.ready = true;
  if (host && host.onReady) host.onReady();
})();
