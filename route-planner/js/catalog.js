// Store product catalog. OCR of product names is poor, so a scanned product line is matched to the
// closest catalog entry instead of being shown as garbled text. Products the user types are added
// automatically (saved on the device), so the catalog grows by itself. Edit this list freely.
export const CATALOG = [
  'קוויקר גזע גדול 20 ק"ג',
  'נאטורה וויילד כלב סלמון טונה והודו 12 ק"ג',
  'נאטורה וויילד כלב לייט עוף ברווז הודו 12 ק"ג',
  'נאטורה וויילד חתול סנסיטיב פסיון ועוף 2 ק"ג',
  'בונסיבו חתול כבש ואורז 15 ק"ג',
  'בון אפטיט חתול קיטן עוף ואורז 12 ק"ג',
  'בון אפטיט כלב סניור עוף ואורז 12 ק"ג',
  'אדוונס חתול בוגר 15 ק"ג',
  'חול גאטו לוונדר 10 ליטר',
  'חול גאטו לוונדר 18 ליטר',
  'חול טראקט בייבי פאודר 10 ק"ג',
  'חטיף פודיס מקלות ברווז 80 גרם',
  'מזרן רביצה פרוותי 80 ס"מ',
];

const KEY = 'rp.catalog.v1';
export function loadCatalog() {
  let mine = [];
  try { mine = JSON.parse(localStorage.getItem(KEY)) || []; } catch {}
  return [...new Set([...mine, ...CATALOG])];
}
export function learnProduct(name) {
  const n = (name || '').trim();
  if (!n || n.length < 4) return;
  for (const p of n.split(/\s*·\s*/)) {
    if (loadCatalog().includes(p)) continue;
    let mine = [];
    try { mine = JSON.parse(localStorage.getItem(KEY)) || []; } catch {}
    mine.unshift(p);
    try { localStorage.setItem(KEY, JSON.stringify(mine.slice(0, 500))); } catch {}
  }
}

// Similarity of two strings by shared letter pairs (robust to OCR letter swaps and glued words).
const norm = s => s.replace(/ק"ג|קילוגר[םמ]?|קילו/g, 'קג').replace(/[^א-ת0-9]/g, '')
  .replace(/[ךםןףץ]/g, c => ({ ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' }[c]));
const pairs = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const p = s.slice(i, i + 2); m.set(p, (m.get(p) || 0) + 1); } return m; };
export function similarity(a, b) {
  const A = pairs(norm(a)), B = pairs(norm(b));
  let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  for (const [p, v] of A) inter += Math.min(v, B.get(p) || 0);
  return na + nb ? (2 * inter) / (na + nb) : 0;
}

// Best catalog entry for an OCR line, or null when nothing is convincingly close.
export function matchProduct(line, catalog = loadCatalog()) {
  let best = null, score = 0, second = 0;
  for (const p of catalog) {
    const s = similarity(line, p);
    if (s > score) { second = score; score = s; best = p; } else if (s > second) second = s;
  }
  return score >= 0.33 && score - second >= 0.04 ? best : null;
}
