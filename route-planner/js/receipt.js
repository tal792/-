// Receipt scanning: image → OCR in the browser (Tesseract.js, free; the image never leaves the device)
// → customer name, phone, delivery address, product, delivery date. Results are always shown for review.

const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

import { ISRAEL_LOCALITIES } from './localities.js';
import { matchProduct } from './catalog.js';

// Localities around the store (official spelling) are matched first and more loosely;
// all other localities in Israel are matched more strictly, to avoid false hits on OCR noise.
export const LOCALITIES = ["אילניה", "אכסאל", "אלומות", "אלוני אבא", "אפיקים", "ארבל", "בית זרע", "בית לחם הגלילית", "בית קשת", "בית שאן", "בלפוריה", "גבע", "גבעת אבני", "גדעונה", "גזית", "דבוריה", "דגניה א'", "דגניה ב'", "הזורעים", "חצור הגלילית", "טבריה", "טורעאן", "יבנאל", "יזרעאל", "יפיע", "יקנעם עילית", "כדורי", "כנרת (מושבה)", "כנרת (קבוצה)", "כפר גדעון", "כפר החורש", "כפר חיטים", "כפר יהושע", "כפר יחזקאל", "כפר כמא", "כפר כנא", "כפר מצר", "כפר קיש", "כפר תבור", "כרמיאל", "לביא", "מגדל", "מגדל העמק", "מולדת", "מנחמיה", "מצפה", "מרחביה (מושב)", "מרחביה (קיבוץ)", "משהד", "נהלל", "נוף הגליל", "נצרת", "עיילבון", "עין גב", "עין דור", "עין חרוד (איחוד)", "עין חרוד (מאוחד)", "עין מאהל", "עפולה", "פוריה - כפר עבודה", "פוריה עילית", "צפת", "קצרין", "קרית טבעון", "ראש פינה", "ריינה", "רמת ישי", "שבלי - אום אל-גנם", "שדה אילן", "שדמות דבורה", "שרונה", "תל עדשים"];

let tessReady = null;
function loadTesseract() {
  tessReady ??= new Promise((res, rej) => {
    if (window.Tesseract) return res(window.Tesseract);
    const s = document.createElement('script');
    s.src = TESS; s.onload = () => res(window.Tesseract); s.onerror = () => { tessReady = null; rej(new Error('לא ניתן לטעון את רכיב הסריקה. בדוק חיבור לאינטרנט.')); };
    document.head.appendChild(s);
  });
  return tessReady;
}

let workers = null;
async function getWorkers(onProgress) {
  if (workers) return workers;
  const T = await loadTesseract();
  onProgress?.('טוען רכיב זיהוי טקסט (פעם ראשונה בלבד)…');
  const heb = await T.createWorker('heb');
  await heb.setParameters({ tessedit_pageseg_mode: '4', preserve_interword_spaces: '1' });
  const digits = await T.createWorker('eng');
  await digits.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '0123456789-/.:' });
  return (workers = { heb, digits });
}

// Grayscale + background removal + threshold: makes thermal-paper photos far more readable.
// Finds the receipt (bright, colourless paper) in the photo, so the table/background is cut away.
export function findPaper(img) {
  const W = 200, H = Math.max(1, Math.round(img.height * W / img.width));
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  freeCanvas(c);
  const rows = new Float32Array(H), cols = new Float32Array(W);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    if (mx - mn < 40) {          // colourless = paper (wood/table is coloured)
      if (mn > 120) cols[x]++;     // columns: bright paper
      if (mn > 70) rows[y]++;      // rows: also paper in shadow, so the bottom isn't cut off
    }
  }
  // longest run of rows/columns that are mostly paper (short gaps from shadows/creases are bridged)
  const run = (arr, len) => {
    const lim = Math.max(...arr) * 0.45, maxGap = Math.max(2, Math.round(len * 0.06));
    let best = [0, len - 1], bestL = 0, s = -1, last = -1;
    for (let i = 0; i <= len; i++) {
      if (i < len && arr[i] >= lim) { if (s < 0) s = i; last = i; }
      else if (s >= 0 && (i === len || i - last > maxGap)) {
        if (last - s + 1 > bestL) { bestL = last - s + 1; best = [s, last]; }
        s = -1;
      }
    }
    return best;
  };
  const [y0, y1] = run(rows, H), [x0, x1] = run(cols, W);
  const k = img.width / W, mx = (x1 - x0) * 0.03, my = (y1 - y0) * 0.02;
  const box = { x: Math.max(0, (x0 - mx) * k), y: Math.max(0, (y0 - my) * k) };
  box.w = Math.min(img.width - box.x, (x1 - x0 + 1 + 2 * mx) * k);
  box.h = Math.min(img.height - box.y, (y1 - y0 + 1 + 2 * my) * k);
  // ignore implausible results (paper fills the whole photo, or only a sliver was found)
  if (box.w * box.h < img.width * img.height * 0.12) return { x: 0, y: 0, w: img.width, h: img.height };
  return box;
}

// iOS Safari has a small total budget for canvas memory: every canvas is released right after use,
// otherwise after a few receipts Safari silently hands out blank canvases and nothing is read.
const newCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
export const freeCanvas = c => { if (c) { c.width = 0; c.height = 0; } };
const MAX_SIDE = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent)) ? 2800 : 3200;

// Returns two cleaned black/white versions of the receipt: as printed, and with blue pen ink erased.
export async function preprocess(file) {
  const img = await createImageBitmap(file);
  let c, bgC, pen;
  const temps = [];
  try {
    const box = findPaper(img);
    const scale = Math.min(3, MAX_SIDE / Math.max(box.w, box.h));
    const w = Math.round(box.w * scale), h = Math.round(box.h * scale);
    c = newCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, w, h);
    // blurred background: real blur where supported, otherwise smooth down/up-scaling (iOS Safari)
    bgC = newCanvas(w, h);
    const bctx = bgC.getContext('2d', { willReadFrequently: true });
    bctx.filter = 'blur(25px)';
    if (bctx.filter === 'blur(25px)') bctx.drawImage(c, 0, 0);
    else {
      let src = c, cw = w, ch = h;
      while (cw > w / 16) { // halve step by step for a smooth result
        cw = Math.round(cw / 2); ch = Math.round(ch / 2);
        const t = newCanvas(cw, ch); temps.push(t);
        const tc = t.getContext('2d'); tc.imageSmoothingQuality = 'high'; tc.drawImage(src, 0, 0, cw, ch); src = t;
      }
      bctx.imageSmoothingQuality = 'high'; bctx.drawImage(src, 0, 0, w, h);
    }
    const px = ctx.getImageData(0, 0, w, h), bg = bctx.getImageData(0, 0, w, h).data, d = px.data;
    freeCanvas(bgC); temps.forEach(freeCanvas);
    const penPx = new ImageData(w, h), q = penPx.data;
    const gray = (a, i) => 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    for (let i = 0; i < d.length; i += 4) {
      const ink = gray(bg, i) - gray(d, i) > 18;
      // blue/purple pen (circles, handwriting), compared with the paper around it (photos are often bluish)
      const isPen = (d[i + 2] - d[i]) - (bg[i + 2] - bg[i]) > 30 && d[i + 2] - d[i + 1] > 5;
      const v = ink ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
      q[i] = q[i + 1] = q[i + 2] = ink && !isPen ? 0 : 255; q[i + 3] = 255;
    }
    ctx.putImageData(px, 0, 0);
    pen = newCanvas(w, h);
    pen.getContext('2d').putImageData(penPx, 0, 0);
    return { canvas: c, penCanvas: pen };
  } catch (e) {
    freeCanvas(c); freeCanvas(bgC); freeCanvas(pen); temps.forEach(freeCanvas);
    throw e;
  } finally {
    img.close?.();
  }
}

const rectOf = (b, padRatio = 0.25) => {
  const pad = Math.round((b.y1 - b.y0) * padRatio);
  return { left: Math.max(0, b.x0 - pad), top: Math.max(0, b.y0 - pad), width: b.x1 - b.x0 + 2 * pad, height: b.y1 - b.y0 + 2 * pad };
};

// Re-reads a small spot (phone, house number) as one line of digits, enlarged to a fixed text height.
async function readDigitsAt(digits, canvas, bbox, padRatio = 0.3, scale = 0, psm = '7') {
  const r = rectOf(bbox, padRatio), k = scale || Math.min(4, Math.max(1, 70 / Math.max(1, bbox.y1 - bbox.y0)));
  const tmp = newCanvas(Math.round(r.width * k), Math.round(r.height * k));
  try {
    const t = tmp.getContext('2d');
    t.fillStyle = '#fff'; t.fillRect(0, 0, tmp.width, tmp.height);
    t.imageSmoothingQuality = 'high';
    t.drawImage(canvas, r.left, r.top, r.width, r.height, 0, 0, tmp.width, tmp.height);
    await digits.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await digits.recognize(tmp);
    return data.text.replace(/\s/g, '');
  } finally {
    await digits.setParameters({ tessedit_pageseg_mode: '6' });
    freeCanvas(tmp);
  }
}

export async function scanReceipt(file, onProgress, knownTowns = []) {
  const { heb, digits } = await getWorkers(onProgress);
  const { canvas, penCanvas } = await preprocess(file);
  try {
    const { data: h } = await heb.recognize(canvas);
    if ((h.text.match(/[א-ת]/g) || []).length < 40)
      throw new Error('לא הצלחתי לקרוא את החשבונית. צלם שוב מקרוב, ישר מלמעלה ובתאורה טובה, כך שהחשבונית תמלא את רוב התמונה.');
    const { data: n } = await digits.recognize(canvas);
    const r = parseReceipt(h, n.text, knownTowns);

    // Phone: read several ways and take a vote (single reads of a digit or two are often wrong)
    const to = h.lines.findIndex(l => /לכבו|לכבי/.test(l.text));
    // customer phones are mobiles (05X/07X); the store's own landline and dates must never match
    const phonesIn = t => (t.match(/0[57]\d-?\s?\d{7}(?=\D|$|0[57]\d)/g) || []).map(p => p.replace(/\D/g, ''));
    const fmt = p => p.replace(/^(05\d|07\d)(\d{7})$/, '$1-$2').replace(/^(0\d)(\d{7})$/, '$1-$2');
    const votes = new Map(), add = (list, w) => list.forEach((p, i) => votes.set(p, (votes.get(p) || 0) + w * (i === 0 ? 1 : 0.6)));
    add(phonesIn(n.text), 1);
    // locate the phone line: a digits-pass line that holds a phone number, else a Hebrew-pass line with 8+ digits
    const dLine = n.lines.find(l => phonesIn(l.text).length);
    const hLine = h.lines.find((l, i) => i > to && (l.text.match(/\d/g) || []).length >= 8 && !/\d{2}\/\d{2}|\.\d\d/.test(l.text));
    const box = dLine?.bbox || hLine?.bbox;
    if (hLine) add(phonesIn(hLine.text), 0.5);
    if (box) for (const [cv, k, psm] of [[canvas, 2, '7'], [canvas, 2, '6'], [canvas, 1.5, '7'], [penCanvas, 2, '7'], [penCanvas, 2, '6']])
      add(phonesIn(await readDigitsAt(digits, cv, box, 0.3, k, psm)), 1);   // pen-free copy: handwriting near the phone
    const ranked = [...votes.entries()].sort((x, y) => y[1] - x[1]);
    if (ranked.length) {
      const main = fmt(ranked[0][0]);
      r.note = r.note.replace(/(^| · )טלפון נוסף [\d-]+/g, '').replace(/^ · /, '');
      r.phone = main;
      // a second, different number seen by more than one read = the customer's second phone
      const second = ranked.find(([p, v]) => p !== ranked[0][0] && v >= 1.2 && [...p].filter((d, i) => d !== ranked[0][0][i]).length > 2);
      if (second) r.note = [r.note, 'טלפון נוסף ' + fmt(second[0])].filter(Boolean).join(' · ');
    }

    // Products are often circled in pen: re-read only the items area from the pen-free copy
    const top = h.lines[to], pay = h.lines.find(l => /אשראי|מזומן|מסוף/.test(l.text));
    if (pay) {
      const y0 = top ? top.bbox.y1 : 0, y1 = pay.bbox.y0;
      if (y1 - y0 > 40) {
        const { data: p } = await heb.recognize(penCanvas, { rectangle: { left: 0, top: y0, width: penCanvas.width, height: y1 - y0 } });
        r.product = productsFrom(p.lines.map(l => l.text)) || r.product;
      }
    }
    // Hebrew OCR often misreads house numbers: re-read just that spot with the digits recognizer
    for (const c of r.cands) {
      if (!c.numBox) continue;
      const m = (await readDigitsAt(digits, canvas, c.numBox, 0.25)).match(/\d{1,4}/);
      if (m) c.num = m[0];
    }
    return finishAddress(r);
  } finally {
    freeCanvas(canvas); freeCanvas(penCanvas);
  }
}

// ---------- parsing ----------
const clean = l => l.replace(/[^א-ת0-9 ,'"׳״.\-/]/g, ' ').replace(/\s+/g, ' ').trim();
const hebCount = l => (l.match(/[א-ת]/g) || []).length;
const strip = s => s.replace(/[\s'"׳״.\-]/g, '');

function lev(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return dp[b.length];
}

// Find a locality inside an OCR line (tolerates missing spaces and wrong letters).
const windowsOf = line => {
  const ws = line.split(/[^\u05D0-\u05EA]+/).filter(w => w.length >= 2), out = new Set([strip(line)]);
  for (let i = 0; i < ws.length; i++) for (let k = 1; k <= 4 && i + k <= ws.length; k++) out.add(ws.slice(i, i + k).join(''));
  return [...out];
};
const LOCAL_SET = new Set(LOCALITIES);
export function matchLocality(line, extra = []) {
  const s = strip(line);
  if (!s) return null;
  const wins = windowsOf(line);
  const tiers = [[...new Set([...extra, ...LOCALITIES])], ISRAEL_LOCALITIES.filter(n => !LOCAL_SET.has(n))];
  for (const [t, locs] of tiers.entries()) {
    let best = null, bestD = Infinity;
    for (const loc of locs) {
      const L = strip(loc.replace(/\s*\(.*?\)/, ''));   // "כנרת (מושבה)" → "כנרת"
      if (L.length < 3) continue;
      if (wins.includes(L)) return loc;
      const tol = t === 0 ? (L.length >= 4 ? Math.max(1, Math.floor(L.length * 0.25)) : s.length <= L.length + 1 ? 1 : 0) : (L.length >= 6 ? 1 : 0);
      if (!tol) continue;
      for (const w of wins) {
        if (Math.abs(w.length - L.length) > tol) continue;
        const d = lev(w, L);
        if (d <= tol && d < bestD) { best = loc; bestD = d; }
      }
    }
    if (best) return best;
  }
  return null;
}

// Official street names per locality (data.gov.il, free), cached on the device.
const STREETS_KEY = 'rp.streets.v1';
export async function getStreets(city) {
  let all = {};
  try { all = JSON.parse(localStorage.getItem(STREETS_KEY)) || {}; } catch {}
  if (all[city]) return all[city];
  try {
    const url = 'https://data.gov.il/api/3/action/datastore_search?resource_id=9ad3862c-8391-4b2f-84a4-2d4c68625f4b&limit=3000&fields=%D7%A9%D7%9D_%D7%A8%D7%97%D7%95%D7%91&filters='
      + encodeURIComponent(JSON.stringify({ 'שם_ישוב': city }));
    const j = await (await fetch(url)).json();
    const list = [...new Set(j.result.records.map(r => r['שם_רחוב'].trim().replace(/\s+/g, ' ')).filter(n => n && n !== city))];
    all[city] = list;
    try { localStorage.setItem(STREETS_KEY, JSON.stringify(all)); } catch {}
    return list;
  } catch { return []; }
}

// Closest official street to the OCR words ("השיוף" → "השיזף", "מיר" → "זמיר").
export function matchStreet(words, streets) {
  if (!words.length || !streets.length) return null;
  const wins = [];
  for (let i = 0; i < words.length; i++) for (let k = 1; k <= 3 && i + k <= words.length; k++) wins.push(words.slice(i, i + k).join(''));
  let best = null, bestD = Infinity;
  for (const st of streets) {
    const forms = [strip(st), strip(st.replace(/^(ה|רחוב |שד(רות|')? )/, ''))];
    for (const F of forms) {
      if (F.length < 2) continue;
      const tol = F.length >= 7 ? 2 : F.length >= 4 ? 1 : 0;
      for (const w of wins) {
        const d = lev(w, F);
        if (d <= tol && (d < bestD || d === bestD && st.length > (best || '').length)) { best = st; bestD = d; }
      }
    }
  }
  return best;
}

// "לא נבחר רחוב" (no street selected) and "בית 3" (house 3) → clean "street number"
export function normalizeStreet(s) {
  return s.replace(/ל?א?\s*נבחר\s*רחוב/g, '').replace(/(^|\s)בית\s*(\d)/g, '$1$2').replace(/(\D)(\d)/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

// Products: item lines (not gifts/shipping/discounts) matched to the store catalog.
// Garbled OCR text is never shown – an unmatched product is simply left empty.
export function productsFrom(lines) {
  const found = [];
  for (const raw of lines) {
    const l = clean(raw);
    if (/אשראי|מזומן|מסוף|נקודות/.test(l)) break;
    if (/מתנה|משלוח|הנח|לקוח/.test(l) || hebCount(l) < 5) continue;
    const p = matchProduct(l);
    if (p && !found.includes(p)) found.push(p);
  }
  return found.join(' · ');
}

// hebOcr: Tesseract result ({ lines: [{ text, words: [{ text, bbox }] }] }) or plain text
export function parseReceipt(hebOcr, digitText, knownTowns = []) {
  const src = typeof hebOcr === 'string' ? hebOcr.split('\n').map(text => ({ text, words: [] })) : hebOcr.lines;
  const kept = src.map(l => ({ text: clean(l.text.replace(/([א-ת])(\d)/g, '$1 $2').replace(/(\d)([א-ת])/g, '$1 $2')), words: l.words || [] }))
    .filter(l => hebCount(l.text) >= 2 || /\d{3}/.test(l.text));
  const lines = kept.map(l => l.text);
  const find = re => lines.findIndex(l => re.test(l));

  // phone: prefer mobile numbers from the digits-only pass
  const flat = digitText.replace(/\s+/g, ' ');
  const phones = flat.match(/0(5\d|7\d)-?\s?\d{7}/g) || flat.match(/0[2-9]-?\s?\d{7}/g) || [];
  const phone = (phones[0] || '').replace(/\s/g, '').replace(/^(\d{3})(\d{7})$/, '$1-$2');
  const dates = flat.match(/\b\d{2}\/\d{2}\/\d{2}(?!\d)/g) || [];
  const date = dates[dates.length - 1] || '';

  // OCR noise filter: keep Hebrew words of 2+ letters and short numbers only
  const words = l => (l || '').split(/[^א-ת0-9"׳״']+/)
    .map(t => t.replace(/^["׳״']+|["׳״']+$/g, ''))   // quotes are valid only inside a word (ת"א)
    .filter(t => (/^[א-ת]+(["׳״'][א-ת]+)?$/.test(t) && t.length >= 2) || /^\d{1,4}$/.test(t));
  const trimEdges = ws => { while (ws.length > 2 && ws[0].length <= 2) ws.shift(); while (ws.length > 2 && ws[ws.length - 1].length <= 2) ws.pop(); return ws; };
  const NO_STREET = /נבחר|בחר\s*רחוב/;

  // customer name: the line after "לכבוד"
  const to = find(/לכבו|לכבי/);
  const name = to >= 0 ? trimEdges(words(lines[to + 1]).filter(w => !/\d/.test(w))).join(' ') : '';

  // product: the line after the items header ("שם פריט")
  const items = find(/פריט|כמו?ת|מחיר/);
  const product = productsFrom(lines.slice(Math.max(0, to + 1)));

  // Box of the house number in a line: the digit word next to the street name and of similar size
  // (lines can also catch tiny vertical print from the paper's edge, which must be ignored).
  const numBoxOf = (idx, streetWord) => {
    const ws = kept[idx]?.words || [];
    const si = ws.findIndex(w => streetWord && w.text.replace(/[^א-ת]/g, '').includes(streetWord.slice(0, 3)));
    if (si < 0) return null;
    const sb = ws[si].bbox, sh = sb.y1 - sb.y0;
    let best = null, bestD = Infinity;
    ws.forEach((w, i) => {
      if (!/\d/.test(w.text) || /\d{2}\/\d{2}/.test(w.text)) return;
      const b = w.bbox, h = b.y1 - b.y0, gap = Math.max(0, sb.x0 - b.x1, b.x0 - sb.x1);
      if (h < sh * 0.6 || h > sh * 1.7 || gap > sh * 6) return;
      const d = Math.abs(i - si) * 1000 + gap;
      if (d < bestD) { bestD = d; best = w; }
    });
    if (!best) { // digits misread as letters ("44" → "וו"): take the short word right after the street name
      for (const i of [si + 1, si + 2, si - 1, si - 2]) {
        const w = ws[i]; if (!w || /בית/.test(w.text)) continue;
        const b = w.bbox, h = b.y1 - b.y0, gap = Math.max(0, sb.x0 - b.x1, b.x0 - sb.x1);
        if (w.text.replace(/[^א-ת0-9]/g, '').length <= 3 && h >= sh * 0.6 && h <= sh * 1.7 && gap <= sh * 3) return b;
      }
      return null;
    }
    const t = best.text.replace(/[^א-ת0-9]/g, ''), digs = (t.match(/\d/g) || []).length;
    if (!t || digs === t.length) return best.bbox;
    const frac = Math.min(1, (digs + 0.5) / t.length), b = best.bbox;  // RTL: the number sits at the left end
    return { x0: b.x0, y0: b.y0, x1: Math.round(b.x0 + (b.x1 - b.x0) * frac), y1: b.y1 };
  };

  // second phone (some receipts list two)
  const phone2 = (phones.find(p => p.replace(/\D/g, '') !== phone.replace(/\D/g, '')) || '').replace(/\s/g, '').replace(/^(\d{3})(\d{7})$/, '$1-$2');

  // address: town (fuzzy-matched, searched from the bottom of a block) + the street line above it.
  // A receipt prints the address twice: under the customer's name and in "נתונים למשלוח" (delivery
  // details). Both copies are read and cross-checked.
  const NAV = /[נג][יו]תוב|ניתו?ב:/;                       // "ניתוב" (often read as "גיתוב")
  const END = /דבק|קבוצת|ח\.?\s?פ\b/;                    // store footer ("פידבק", "מקבוצת")
  const tail = l => END.test(l) || NAV.test(l);
  const deliv = lines.findIndex((l, i) => /[נג]תונים|ל[מנ]ש?לו[חת]/.test(l) && i > items);
  const block = (from, to2) => { const out = []; for (let i = from; i < Math.min(to2, lines.length) && !tail(lines[i]); i++) out.push(i); return out; };
  const blocks = [];
  if (deliv >= 0) blocks.push(block(deliv + 1, deliv + 9));
  if (to >= 0) blocks.push(block(to + 2, items > to ? items : to + 6));
  const notes = [], cands = [];
  let city = '', noStreet = false;
  for (const bl of blocks) {
    let ti = -1, c = null;
    for (let i = bl.length - 1; i >= 0 && !c; i--) if ((c = matchLocality(lines[bl[i]], knownTowns))) ti = i;
    if (!c) continue;
    city ||= c;
    for (let j = ti - 1; j >= 0; j--) {
      const raw = lines[bl[j]].replace(/\d{2}\/\d{2}\/\d{2,4}/g, '');
      if (/^\s*רחוב\s*$/.test(raw)) { noStreet = true; break; }
      if (NO_STREET.test(raw)) { noStreet = true; break; }          // "לא נבחר רחוב" = no street
      if (/כניסה|קומה|דירה/.test(raw)) { const w = words(raw).join(' '); if (w && !notes.includes(w)) notes.push(w); continue; }
      const ws = words(raw.replace(/(^|\s)בית\s*(?=\d)/g, ' '));
      while (ws.length && /^\d/.test(ws[0])) ws.shift();            // leading numbers are noise
      if (ws.some(w => !/^\d/.test(w))) {
        const num = ws.find(w => /^\d{1,4}$/.test(w)) || '';
        const sw = ws.filter(w => !/^\d/.test(w)).slice(0, 4);
        cands.push({ words: sw, num, numBox: numBoxOf(bl[j], sw[0]) });
        break;
      }
    }
  }

  // delivery notes ("ניתוב:"): gate codes, directions – essential for the driver
  const nav = lines.findIndex((l, i) => NAV.test(l) && i > items);
  if (nav >= 0) for (let i = nav + 1; i < lines.length && i <= nav + 4 && !END.test(lines[i]); i++) {
    const ws = words(lines[i]);
    while (ws.length > 1 && /^\d$/.test(ws[ws.length - 1])) ws.pop();  // stray digit from the paper edge
    const w = ws.join(' ');
    if (w) notes.push(w);
  }
  if (phone2) notes.push('טלפון נוסף ' + phone2);

  return { name, phone, product, date, city, noStreet: noStreet && !cands.length, cands: cands.map(({ numBox, ...c }) => ({ ...c, numBox })), digitText: flat,
    note: notes.join(' · '), cityMatched: !!city, address: composeAddress(city, cands, []) };
}

// Picks the street (corrected to an official name when possible) and the house number.
export function composeAddress(city, cands, streets, digitText = '') {
  if (!cands.length) return city;
  const fixed = cands.map(c => ({ ...c, official: matchStreet(c.words, streets) }));
  const pick = fixed.find(c => c.official) || fixed[0];
  const street = pick.official || pick.words.join(' ');
  // house number: both copies agree → take it; otherwise prefer one also seen by the digits pass
  const nums = fixed.map(c => c.num).filter(Boolean);
  let num = nums.find((n, i) => nums.indexOf(n) !== i) || '';
  if (!num) num = nums.find(n => new RegExp(`(^|\\D)${n}(\\D|$)`).test(digitText)) || pick.num || nums[0] || '';
  return [normalizeStreet(`${street} ${num}`), city].filter(Boolean).join(', ');
}

export async function finishAddress(r) {
  if (!r.city || !r.cands.length) return r;
  const streets = await getStreets(r.city);
  const address = composeAddress(r.city, r.cands, streets, r.digitText);
  return { ...r, address, streetOfficial: r.cands.some(c => matchStreet(c.words, streets)) };
}

