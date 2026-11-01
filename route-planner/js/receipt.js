// Receipt scanning: image → OCR in the browser (Tesseract.js, free; the image never leaves the device)
// → customer name, phone, delivery address, product, delivery date. Results are always shown for review.

const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

// Localities around the store, used to fix OCR mistakes in town names. Towns the user types are added too.
export const LOCALITIES = [
  'כפר תבור', 'כפר קיש', 'ארבל', 'יבנאל', 'כנרת', 'מצפה', 'שדה אילן', 'אילניה', 'כפר כמא', 'דבוריה', 'שבלי',
  'גבעת אבני', 'הזורעים', 'פוריה עילית', 'פוריה כפר עבודה', 'טבריה', 'כדורי', 'בית קשת', 'מגדל', 'כפר חיטים',
  'לביא', 'שרונה', 'עין דור', 'כפר מצר', 'שדמות דבורה', 'מולדת', 'גזית', 'תל עדשים', 'מרחביה', 'בלפוריה',
  'כפר גדעון', 'עין חרוד', 'עפולה', 'נצרת', 'נוף הגליל', 'מגדל העמק', 'כפר כנא', 'ריינה', 'משהד', 'עין מאהל',
  'טורעאן', 'עילבון', 'בית שאן', 'נהלל', 'כפר יהושע', 'רמת ישי', 'קריית טבעון', 'יקנעם עילית', 'כרמיאל',
  'צפת', 'ראש פינה', 'חצור הגלילית', 'קצרין', 'עין גב', 'דגניה א', 'דגניה ב', 'אלומות', 'בית זרע', 'אפיקים',
  'מנחמיה', 'יזרעאל', 'גבע', 'גדעונה', 'כפר יחזקאל', 'אכסאל', 'יפיע', 'כפר החורש', 'אלוני אבא', 'בית לחם הגלילית',
];

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
export async function preprocess(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(2.5, 4000 / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  // blurred background: real blur where supported, otherwise smooth down/up-scaling (iOS Safari)
  const bgC = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const bctx = bgC.getContext('2d', { willReadFrequently: true });
  bctx.filter = 'blur(25px)';
  if (bctx.filter === 'blur(25px)') bctx.drawImage(c, 0, 0);
  else {
    let src = c, cw = w, ch = h;
    while (cw > w / 16) { // halve step by step for a smooth result
      cw = Math.round(cw / 2); ch = Math.round(ch / 2);
      const t = Object.assign(document.createElement('canvas'), { width: cw, height: ch });
      const tc = t.getContext('2d'); tc.imageSmoothingQuality = 'high'; tc.drawImage(src, 0, 0, cw, ch); src = t;
    }
    bctx.imageSmoothingQuality = 'high'; bctx.drawImage(src, 0, 0, w, h);
  }
  const px = ctx.getImageData(0, 0, w, h), bg = bctx.getImageData(0, 0, w, h).data, d = px.data;
  const gray = (a, i) => 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
  for (let i = 0; i < d.length; i += 4) {
    const v = gray(bg, i) - gray(d, i) > 18 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(px, 0, 0);
  return c;
}

export async function scanReceipt(file, onProgress, knownTowns = []) {
  const { heb, digits } = await getWorkers(onProgress);
  const canvas = await preprocess(file);
  const [{ data: h }, { data: n }] = [await heb.recognize(canvas), await digits.recognize(canvas)];
  return parseReceipt(h.text, n.text, knownTowns);
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

// Find a known locality inside an OCR line (tolerates missing spaces and 1–2 wrong letters).
export function matchLocality(line, extra = []) {
  const s = strip(line);
  if (!s) return null;
  const ws = line.split(/[^\u05D0-\u05EA]+/).filter(w => w.length >= 2);
  const windows = new Set([s]);
  for (let i = 0; i < ws.length; i++) for (let k = 1; k <= 3 && i + k <= ws.length; k++) windows.add(ws.slice(i, i + k).join(''));
  const locs = [...new Set([...extra, ...LOCALITIES])];
  for (const loc of locs) if (s.includes(strip(loc)) && strip(loc).length >= 3) return loc;
  let best = null, bestD = Infinity;
  for (const loc of locs) {
    const L = strip(loc), tol = L.length >= 4 ? Math.max(1, Math.floor(L.length * 0.25)) : 0;
    for (const w of windows) {
      const d = lev(w, L);
      if (d <= tol && d < bestD) { best = loc; bestD = d; }
    }
  }
  return best;
}

// "לא נבחר רחוב" (no street selected) and "בית 3" (house 3) → clean "street number"
export function normalizeStreet(s) {
  return s.replace(/ל?א?\s*נבחר\s*רחוב/g, '').replace(/(^|\s)בית\s*(\d)/g, '$1$2').replace(/(\D)(\d)/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

export function parseReceipt(hebText, digitText, knownTowns = []) {
  const lines = hebText.split('\n').map(clean).filter(l => hebCount(l) >= 2 || /\d{3}/.test(l));
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
  const product = items >= 0 ? trimEdges(words(lines[items + 1])).join(' ') : '';

  // address: town (fuzzy-matched) + the street line just above it.
  // Prefer the "נתונים למשלוח" (delivery details) section, else the customer block under the name.
  const tail = l => /פידבק|מקבוצת|ח\.?\s?פ/.test(l);
  const deliv = lines.findIndex((l, i) => /נתונים/.test(l) && i > items);
  const block = (from, to2) => { const out = []; for (let i = from; i < Math.min(to2, lines.length) && !tail(lines[i]); i++) out.push(lines[i]); return out; };
  const blocks = [];
  if (deliv >= 0) blocks.push(block(deliv + 1, deliv + 9));
  if (to >= 0) blocks.push(block(to + 2, items > to ? items : to + 5));
  let city = '', street = '';
  for (const bl of blocks) {
    const ti = bl.findIndex(l => matchLocality(l, knownTowns));
    if (ti < 0) continue;
    city = matchLocality(bl[ti], knownTowns);
    for (let j = ti - 1; j >= 0; j--) {
      if (NO_STREET.test(bl[j])) break;          // "לא נבחר רחוב" = no street
      const ws = words(bl[j].replace(/\d{2}\/\d{2}\/\d{2,4}/g, '').replace(/(^|\s)בית\s*(?=\d)/g, ' '));
      while (ws.length && /^\d/.test(ws[0])) ws.shift(); // leading numbers are noise
      if (ws.some(w => !/^\d/.test(w))) { street = ws.slice(0, 4).join(' '); break; }
    }
    break;
  }
  const address = [normalizeStreet(street), city].filter(Boolean).join(', ');

  return { name, phone, address, product, date, cityMatched: !!city };
}
