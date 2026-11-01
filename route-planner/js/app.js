import { geocode, travelMatrix, drivingRoute, wazeLink, gmapsLink, gmapsRouteLinks } from './services.js';
import { solveRoute, routeCost } from './solver.js';
import { scanReceipt, normalizeStreet } from './receipt.js';

// Optimisation runs in a Web Worker: a fast answer first, then (for >13 stops) an exact proof.
function runSolver(m, onQuick) {
  return new Promise(resolve => {
    let w;
    try { w = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' }); }
    catch { const r = solveRoute(m); onQuick(r); return resolve(r); }
    w.onmessage = ({ data }) => {
      if (data.type === 'quick') onQuick(data);
      else { w.terminate(); resolve(data); }
    };
    w.onerror = () => { w.terminate(); const r = solveRoute(m); onQuick(r); resolve(r); };
    w.postMessage({ m });
  });
}

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ---------- state ----------
// place = { text, geo: {lat, lon, label, precision: 'house'|'street'|'area'|'manual'} | null, failed?: bool }
// stop  = place + { id, name, done? }
// result = { method: 'exact'|'heuristic'|'manual', distance, duration, legs, geometry, saved? } | null
const KEY = 'rp.current.v2';
let S = load(KEY, null) || { start: { text: '', geo: null }, end: { text: '', geo: null }, roundTrip: true, city: '', service: 0, startTime: '08:00', stops: [], result: null };
S.startTime ??= '08:00';
if (!S.start.text && !S.stops.length) S.start = { text: 'הלחי 3, כפר תבור', geo: null };
const persist = () => save(KEY, S);
let busy = false;

// ---------- helpers ----------
const fmtKm = m => (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' ק"מ';
function fmtTime(sec) {
  const min = Math.round(sec / 60), h = Math.floor(min / 60);
  return h ? `${h} ש' ${min % 60} דק'` : `${min} דק'`;
}
function setStatus(msg, error = false) { $('status').textContent = msg || ''; $('status').classList.toggle('error', error); }
// Phone numbers anywhere in the text: 050-1234567 / 0501234567 / 04-9692535 / +972...
const PHONE_RE = /(?:\+?972[-\s]?|0)(?:5\d|7\d|[2-4689])[-\s]?\d{3}[-\s]?\d{4}/;
export function normPhone(p) {
  const d = (p || '').replace(/\D/g, '').replace(/^972/, '0');
  return d.length >= 9 ? d.replace(/^(05\d|07\d|0\d)(\d{7})$/, '$1-$2') : '';
}
const intlPhone = p => '972' + p.replace(/\D/g, '').replace(/^0/, '');

// "address | name | phone | note", or columns pasted from Excel (tab-separated, any order)
function parseLine(line) {
  let cols = line.includes('|') ? line.split('|') : line.includes('\t') ? line.split('\t') : [line];
  cols = cols.map(c => c.trim()).filter(Boolean);
  let phone = '';
  cols = cols.map(c => {
    const m = c.match(PHONE_RE);
    if (m && !phone) { phone = normPhone(m[0]); c = c.replace(m[0], '').replace(/^[\s,\-]+|[\s,\-]+$/g, ''); }
    return c;
  }).filter(Boolean);
  let k = 0;
  if (!line.includes('|') && cols.length > 1) { // Excel: pick the address column
    const pick = test => { const hits = cols.filter(test); return hits.length === 1 ? cols.indexOf(hits[0]) : -1; };
    k = pick(c => c.includes(','));
    if (k < 0) k = pick(c => /\d/.test(c));
    if (k < 0) k = 0;
  }
  const rest = cols.filter((_, i) => i !== k);
  const text = normalizeStreet(cols[k] || '').replace(/^,\s*/, '');
  const known = phone && customers[phone.replace(/\D/g, '')];
  return { id: uid(), text, name: rest[0] || known?.name || '', phone, note: rest.slice(1).join(' · ') || known?.note || '',
    geo: known?.geo && known.text === text ? known.geo : null };
}
function clockAt(offsetSec) {
  const [h, m] = (S.startTime || '08:00').split(':').map(Number);
  const t = new Date(2000, 0, 1, h, m, 0); t.setSeconds(t.getSeconds() + offsetSec);
  return t.toTimeString().slice(0, 5);
}
// seconds from departure until arriving at stop i (driving + service time at earlier stops)
function arrivalOffset(i) {
  const legs = S.result?.legs; if (!legs) return null;
  let t = 0; for (let k = 0; k <= i; k++) t += legs[k].duration;
  return t + S.service * 60 * i;
}
function invalidate(msg = 'הרשימה השתנתה — לחץ "חשב מסלול" לחישוב מחדש') {
  if (S.result) { S.result = null; S.banner = msg; }
  persist();
}
const endPlace = () => (S.roundTrip ? S.start : S.end);

// ---------- geocoding ----------
async function locate(place) {
  if (place.geo) return true;
  const g = await geocode(place.text, S.city);
  place.geo = g; place.failed = !g;
  return !!g;
}

// Addresses are located in the background as soon as they are added, so "calculate" is fast.
let geoRun = null;
const allPlaces = () => [S.start, ...(S.roundTrip ? [] : [S.end]), ...S.stops];
function geocodeAll() {
  geoRun ??= (async () => {
    try {
      let p;
      while ((p = allPlaces().find(x => x.text && !x.geo && !x.failed))) {
        const left = allPlaces().filter(x => x.text && !x.geo && !x.failed).length;
        if (!busy) setStatus(`מאתר כתובות ברקע… נותרו ${left}`);
        await locate(p);
        persist(); renderStops(); drawMap();
      }
      if (!busy) setStatus('');
    } catch (e) { setStatus(e.message, true); throw e; }
    finally { geoRun = null; }
  })();
  return geoRun;
}

// ---------- main calculation ----------
async function calculate() {
  if (busy) return;
  if (!S.start.text.trim()) return setStatus('נא להזין נקודת התחלה', true);
  if (!S.roundTrip && !S.end.text.trim()) return setStatus('נא להזין נקודת סיום', true);
  if (!S.stops.length) return setStatus('נא להוסיף לפחות תחנה אחת', true);
  busy = true; $('calc').disabled = true;
  try {
    S.start.failed = false; if (!S.roundTrip) S.end.failed = false;
    const todo = allPlaces().filter(p => !p.geo && !p.failed).length;
    if (todo) setStatus(`מאתר ${todo} כתובות…`);
    await geocodeAll();
    if (!S.start.geo) throw new Error('נקודת ההתחלה לא אותרה. נסה לכתוב רחוב, מספר ועיר.');
    if (!endPlace().geo) throw new Error('נקודת הסיום לא אותרה.');
    const failed = S.stops.filter(s => !s.geo).length;
    if (failed) throw new Error(`${failed} כתובות לא אותרו (מסומנות באדום). תקן או מחק אותן ונסה שוב.`);

    setStatus('מחשב זמני נסיעה בכבישים…');
    const pts = [S.start.geo, ...S.stops.map(s => s.geo), endPlace().geo];
    let mtx;
    try { mtx = await travelMatrix(pts); } catch (e) {
      const m = /^UNREACHABLE:(\d+)/.exec(e.message);
      if (!m) throw e;
      const i = +m[1];
      throw new Error(i === 0 || i === pts.length - 1 ? 'לא נמצאה דרך נסיעה לנקודת ההתחלה/סיום.' : `לא נמצאה דרך נסיעה לתחנה "${S.stops[i - 1].text}". גרור את הסיכה לכביש קרוב.`);
    }
    setStatus(S.stops.length > 13 ? `מחשב סדר אופטימלי ל-${S.stops.length} תחנות…` : 'מחשב סדר תחנות אופטימלי…');
    const inputCost = routeCost(mtx.durations, S.stops.map((_, i) => i + 1));
    const original = S.stops.slice();
    let quickApplied = null;
    const final = await runSolver(mtx.durations, async quick => {
      if (quick.proven) return; // the final message follows immediately
      S.stops = quick.order.map(i => original[i - 1]);
      quickApplied = routeCurrentOrder('verifying').then(() => {
        Object.assign(S.result, { saved: Math.max(0, inputCost - quick.cost), cost: quick.cost, bound: quick.bound });
        render(); setStatus('מאמת שזה באמת המסלול הקצר ביותר (חישוב מדויק)…');
      });
    });
    if (quickApplied) await quickApplied.catch(() => {});
    const sameOrder = S.result && final.order.every((k, i) => S.stops[i] === original[k - 1]);
    S.stops = final.order.map(i => original[i - 1]);
    if (!sameOrder || !S.result) await routeCurrentOrder('verifying');
    Object.assign(S.result, { method: final.proven ? 'exact' : 'heuristic', saved: Math.max(0, inputCost - final.cost), cost: final.cost, bound: final.bound });
    persist(); render();
    setStatus('');
  } catch (e) {
    setStatus(e.message || 'שגיאה', true);
  } finally {
    busy = false; $('calc').disabled = false;
  }
}

// Totals + road geometry for the current order (used after optimizing and after manual reordering).
async function routeCurrentOrder(method) {
  const r = await drivingRoute([S.start.geo, ...S.stops.map(s => s.geo), endPlace().geo]);
  S.result = { method, ...r };
  S.banner = '';
}

async function manualReorder(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= S.stops.length || busy) return;
  [S.stops[i], S.stops[j]] = [S.stops[j], S.stops[i]];
  if (!S.result) { persist(); return render(); }
  busy = true;
  try { setStatus('מעדכן זמני נסיעה…'); await routeCurrentOrder('manual'); setStatus(''); }
  catch (e) { S.result = null; S.banner = ''; setStatus(e.message, true); }
  busy = false; persist(); render();
}

// ---------- rendering ----------
function render() {
  $('start').value = S.start.text; $('end').value = S.end.text;
  $('roundTrip').checked = S.roundTrip; $('endWrap').hidden = S.roundTrip;
  $('city').value = S.city; $('service').value = S.service; $('startTime').value = S.startTime;
  renderStops(); renderSummary(); drawMap(); renderNav();
}

function renderSummary() {
  const r = S.result;
  $('banner').hidden = !(S.banner && !r);
  $('banner').textContent = S.banner || '';
  $('summary').hidden = !r;
  if (!r) return;
  const stopTime = S.service * 60 * S.stops.length;
  const method = {
    exact: '✔ סדר אופטימלי — מוכח מתמטית שאין סדר מהיר יותר (לפי זמני נסיעה בכבישים)',
    verifying: '⏳ סדר ממוטב — מאמת אופטימליות…',
    heuristic: `✔ סדר ממוטב לפי זמני נסיעה בכבישים. מוכח שגם הסדר הטוב ביותר האפשרי לא יחסוך יותר מ-${fmtTime(Math.max(60, (r.cost || 0) - (r.bound || 0)))}`,
    manual: '✋ סדר ידני — לא ממוטב. לחץ "חשב מסלול" לסדר אופטימלי',
  }[r.method];
  $('summary').innerHTML = `
    <div class="totals"><span>🛣️ ${fmtKm(r.distance)}</span><span>⏱️ ${fmtTime(r.duration)}</span>
    ${stopTime ? `<span>כולל עצירות: ${fmtTime(r.duration + stopTime)}</span>` : ''}</div>
    <div class="note">יציאה ${esc(S.startTime)} · ${S.roundTrip ? 'חזרה' : 'סיום'} משוער ~${clockAt(r.duration + stopTime)}</div>
    <div class="method ${r.method === 'manual' || r.method === 'verifying' ? 'manual' : ''}">${method}</div>
    ${r.saved > 60 && r.method !== 'manual' ? `<div class="note">חיסכון של כ-${fmtTime(r.saved)} לעומת הסדר שהוזן</div>` : ''}
    <div class="note">זמן משוער ללא עומסי תנועה בזמן אמת${S.roundTrip ? ' · כולל חזרה להתחלה' : ''}</div>`;
}

const PRECISION_WARN = {
  street: '<div class="warn">⚠ אותר הרחוב בלבד (ללא מספר בית). לדיוק — גרור את הסיכה במפה</div>',
  area: '<div class="warn">⚠ אותר היישוב בלבד! גרור את הסיכה למיקום המדויק או תקן את הכתובת</div>',
};
function renderStops() {
  const r = S.result;
  $('count').textContent = S.stops.length;
  $('empty').hidden = S.stops.length > 0;
  $('stops').classList.toggle('routed', !!r);
  $('stops').innerHTML = S.stops.map((s, i) => {
    const leg = r?.legs?.[i];
    const geoInfo = s.failed ? '<div class="err">⚠ הכתובת לא אותרה — ערוך אותה</div>'
      : s.geo ? `<div class="sub">${esc({ manual: '📍 מיקום שנקבע ידנית', gps: '📍 מיקום מדויק שנשמר במסירה' }[s.geo.precision] || s.geo.label)}</div>${PRECISION_WARN[s.geo.precision] || ''}`
      : '<div class="sub">טרם אותרה</div>';
    return `<li data-i="${i}" class="${s.done ? 'done' : ''}">
      <div class="num">${i + 1}</div>
      <div class="body">
        <div class="title">${esc(s.name || s.text)}</div>
        ${s.name ? `<div class="sub">${esc(s.text)}</div>` : ''}
        ${s.note ? `<div class="stop-note">📝 ${esc(s.note)}</div>` : ''}
        ${geoInfo}
        ${leg ? `<div class="leg">🕐 ~${clockAt(arrivalOffset(i))} · ${fmtTime(leg.duration)} · ${fmtKm(leg.distance)} מהתחנה הקודמת</div>` : ''}
        <div class="acts">
          ${s.geo ? `<a class="btn" target="_blank" rel="noopener" href="${wazeLink(s.geo)}">Waze</a>
                     <a class="btn secondary" target="_blank" rel="noopener" href="${gmapsLink(s.geo)}">Google</a>` : ''}
          ${s.phone ? `<a class="btn secondary" href="tel:${s.phone.replace(/\D/g, '')}">📞 ${esc(s.phone)}</a>
                       <a class="btn secondary" target="_blank" rel="noopener" href="${customerWa(s, i)}" aria-label="וואטסאפ ללקוח">💬</a>` : ''}
          ${r ? `<button class="secondary" data-a="done">${s.done ? 'בטל ✔' : '✔ בוצע'}</button>` : ''}
          <button class="ghost" data-a="up" aria-label="הזז למעלה">▲</button>
          <button class="ghost" data-a="down" aria-label="הזז למטה">▼</button>
          <button class="ghost" data-a="edit">✏️ ערוך</button>
          <button class="ghost" data-a="del" aria-label="מחק">🗑</button>
        </div>
      </div></li>`;
  }).join('');
}

function renderNav() {
  const r = S.result;
  $('navCard').hidden = !S.stops.length;
  if (!r) { $('navLinks').innerHTML = '<p class="muted">חשב מסלול כדי לקבל קישורי ניווט לכל הקו.</p>'; return; }
  const pts = [S.start.geo, ...S.stops.map(s => s.geo), endPlace().geo];
  const links = gmapsRouteLinks(pts);
  const next = S.stops.find(s => !s.done);
  $('navLinks').innerHTML = links.map((u, i) =>
    `<a class="btn" target="_blank" rel="noopener" href="${u}">🗺️ כל הקו ב-Google Maps${links.length > 1 ? ` — חלק ${i + 1} מתוך ${links.length}` : ''}</a>`).join('')
    + (next ? `<a class="btn secondary" target="_blank" rel="noopener" href="${wazeLink(next.geo)}">🚗 Waze לתחנה הבאה: ${esc(next.name || next.text)}</a>` : '<p class="muted">כל התחנות בוצעו ✔</p>')
    + `<button id="driveBtn" class="primary">🚚 מצב נהיגה — תחנה אחר תחנה</button>
       <a class="btn secondary" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(shareText())}">📤 שלח את הקו לנהג בוואטסאפ</a>`;
  $('driveBtn').onclick = openDrive;
}

// WhatsApp to the customer: "your delivery is on the way", with the estimated arrival time
function customerWa(s, i) {
  const first = (s.name || '').split(' ')[0];
  const eta = S.result ? ` הגעה משוערת בסביבות ${clockAt(arrivalOffset(i))}.` : '';
  return `https://wa.me/${intlPhone(s.phone)}?text=${encodeURIComponent(`שלום${first ? ' ' + first : ''}, המשלוח שלך בדרך אליך 🚚${eta}`)}`;
}

function shareText() {
  const lines = S.stops.map((s, i) => `${i + 1}. ${s.name ? s.name + ' — ' : ''}${s.text} (~${clockAt(arrivalOffset(i))})${s.phone ? '\n📞 ' + s.phone : ''}${s.note ? '\n📝 ' + s.note : ''}\n${wazeLink(s.geo)}`);
  return `🚚 קו חלוקה · יציאה ${S.startTime} מ${S.start.text}\n${fmtKm(S.result.distance)} · ${fmtTime(S.result.duration)} נסיעה\n\n${lines.join('\n')}`;
}

// ---------- driving mode: one big card per stop ----------
function openDrive() { $('drive').hidden = false; document.body.style.overflow = 'hidden'; renderDrive(); }
function closeDrive() { $('drive').hidden = true; document.body.style.overflow = ''; render(); }
function renderDrive() {
  const i = S.stops.findIndex(s => !s.done), n = S.stops.length, doneCount = S.stops.filter(s => s.done).length;
  const box = $('driveBody');
  if (i < 0) {
    box.innerHTML = `<div class="d-big">🎉 כל ${n} התחנות בוצעו!</div>
      <a class="btn d-nav" target="_blank" rel="noopener" href="${wazeLink(endPlace().geo)}">Waze ל${S.roundTrip ? 'חזרה' : 'נקודת הסיום'}</a>
      <button class="secondary" data-d="back">⟵ חזרה לתחנה הקודמת</button>`;
  } else {
    const s = S.stops[i];
    box.innerHTML = `<div class="d-progress"><span style="width:${doneCount / n * 100}%"></span></div>
      <div class="d-count">תחנה ${i + 1} מתוך ${n} · הגעה משוערת ~${clockAt(arrivalOffset(i))}</div>
      <div class="d-big">${esc(s.name || s.text)}</div>
      ${s.name ? `<div class="d-addr">${esc(s.text)}</div>` : ''}
      ${s.note ? `<div class="d-note">📝 ${esc(s.note)}</div>` : ''}
      ${s.geo.precision === 'street' || s.geo.precision === 'area' ? '<div class="warn">⚠ מיקום משוער. כשתגיע ללקוח לחץ "📍 שמור מיקום", ובפעם הבאה הניווט יגיע בדיוק לדלת</div>' : ''}
      <a class="btn d-nav" target="_blank" rel="noopener" href="${wazeLink(s.geo)}">🚗 נווט עם Waze</a>
      <a class="btn secondary" target="_blank" rel="noopener" href="${gmapsLink(s.geo)}">נווט עם Google Maps</a>
      ${s.phone ? `<div class="d-row"><a class="btn secondary" href="tel:${s.phone.replace(/\D/g, '')}">📞 התקשר ${esc(s.phone)}</a>
        <a class="btn secondary" target="_blank" rel="noopener" href="${customerWa(s, i)}">💬 שלח "אני בדרך"</a></div>` : ''}
      ${s.phone ? `<button class="secondary" data-d="gps">${s.geo.precision === 'gps' ? '📍 עדכן מיקום מדויק ללקוח' : '📍 אני אצל הלקוח — שמור מיקום'}</button>` : ''}
      <div id="gpsMsg" class="muted small"></div>
      <button class="d-done" data-d="done">✔ בוצע — לתחנה הבאה</button>
      ${doneCount ? '<button class="ghost" data-d="back">⟵ בטל את הסימון האחרון</button>' : ''}`;
  }
}

function saveGps(s) {
  if (!s || !navigator.geolocation) return;
  $('gpsMsg').textContent = 'מאתר את המיקום שלך…';
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    if (accuracy > 150) { $('gpsMsg').textContent = `המיקום לא מספיק מדויק (±${Math.round(accuracy)} מ'). נסה שוב בעוד רגע, בחוץ.`; return; }
    s.geo = { lat, lon, label: 'מיקום מהמסירה', precision: 'gps' };
    rememberCustomer(s); persist(); renderDrive();
    $('gpsMsg').textContent = `✔ נשמר (±${Math.round(accuracy)} מ'). בפעם הבאה הניווט ללקוח הזה יגיע לכאן.`;
  }, err => { $('gpsMsg').textContent = err.code === 1 ? 'צריך לאשר גישה למיקום בדפדפן.' : 'לא ניתן לאתר מיקום כרגע.'; },
  { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}

// ---------- map ----------
let map, layer;
function drawMap() {
  if (!window.L) return;
  if (!map) {
    map = L.map('map', { zoomControl: true }).setView([31.6, 34.9], 7);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    layer = L.layerGroup().addTo(map);
  }
  layer.clearLayers();
  const pin = (t, cls) => L.divIcon({ className: '', html: `<div class="pin ${cls}">${t}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
  const bounds = [];
  const base = (p, t) => { if (p.geo) { L.marker([p.geo.lat, p.geo.lon], { icon: pin(t, 'base') }).bindPopup(esc(p.text)).addTo(layer); bounds.push([p.geo.lat, p.geo.lon]); } };
  base(S.start, S.roundTrip ? '🏠' : 'א');
  if (!S.roundTrip) base(S.end, 'ס');
  S.stops.forEach((s, i) => {
    if (!s.geo) return;
    const m = L.marker([s.geo.lat, s.geo.lon], { icon: pin(i + 1, S.result ? '' : 'pending'), draggable: true })
      .bindPopup(`<b>${i + 1}. ${esc(s.name || s.text)}</b>`).addTo(layer);
    m.on('dragend', () => {
      const { lat, lng } = m.getLatLng();
      s.geo = { lat, lon: lng, label: 'מיקום ידני', precision: 'manual' };
      rememberCustomer(s);
      invalidate('מיקום תחנה עודכן — לחץ "חשב מסלול" לחישוב מחדש'); render();
    });
    bounds.push([s.geo.lat, s.geo.lon]);
  });
  if (S.result?.geometry) L.geoJSON(S.result.geometry, { style: { color: '#0f5c8c', weight: 5, opacity: .75 } }).addTo(layer);
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
}

// ---------- events ----------
$('driveClose').addEventListener('click', closeDrive);
$('driveBody').addEventListener('click', e => {
  const a = e.target.closest('[data-d]')?.dataset.d; if (!a) return;
  if (a === 'done') { const s = S.stops.find(x => !x.done); if (s) s.done = true; }
  if (a === 'back') { const done = S.stops.filter(x => x.done); if (done.length) done[done.length - 1].done = false; }
  if (a === 'gps') return saveGps(S.stops.find(x => !x.done));
  persist(); renderDrive();
});
$('startTime').addEventListener('change', e => { S.startTime = e.target.value || '08:00'; persist(); render(); });
function bindPlace(id, key) {
  $(id).addEventListener('change', () => {
    const t = $(id).value.trim();
    if (t === S[key].text) return;
    S[key] = { text: t, geo: null }; invalidate(); render(); geocodeAll().catch(() => {});
  });
}
bindPlace('start', 'start'); bindPlace('end', 'end');
$('roundTrip').addEventListener('change', e => { S.roundTrip = e.target.checked; invalidate(); render(); });
$('city').addEventListener('change', e => { S.city = e.target.value.trim(); persist(); });
$('service').addEventListener('change', e => { S.service = Math.max(0, +e.target.value || 0); persist(); renderSummary(); });

$('addForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('addInput').value.trim();
  if (!v) return;
  S.stops.push(parseLine(v)); $('addInput').value = '';
  invalidate(); render(); geocodeAll().catch(() => {});
});
$('pasteAdd').addEventListener('click', () => {
  const lines = $('paste').value.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return;
  S.stops.push(...lines.map(parseLine)); $('paste').value = ''; $('manualBox').open = false;
  invalidate(); render(); geocodeAll().catch(() => {});
});

$('stops').addEventListener('click', e => {
  const btn = e.target.closest('button[data-a]'); if (!btn) return;
  const li = btn.closest('li'), i = +li.dataset.i, s = S.stops[i];
  switch (btn.dataset.a) {
    case 'del': S.stops.splice(i, 1); invalidate(); render(); break;
    case 'up': manualReorder(i, -1); break;
    case 'down': manualReorder(i, 1); break;
    case 'done': s.done = !s.done; persist(); renderStops(); renderNav(); break;
    case 'edit': {
      const body = li.querySelector('.body');
      body.insertAdjacentHTML('beforeend', `<div class="edit">
        <input type="text" class="e-addr" value="${esc(s.text)}" placeholder="כתובת">
        <input type="text" class="e-name" value="${esc(s.name)}" placeholder="שם הלקוח / החנות">
        <input type="tel" class="e-phone" value="${esc(s.phone || '')}" placeholder="טלפון" inputmode="tel">
        <input type="text" class="e-note" value="${esc(s.note || '')}" placeholder="הערה לשליח (קוד כניסה, הוראות)">
        <div class="acts"><button data-a="saveEdit">שמור</button><button class="secondary" data-a="cancelEdit">ביטול</button></div></div>`);
      btn.disabled = true; body.querySelector('.e-addr').focus();
      break;
    }
    case 'cancelEdit': renderStops(); break;
    case 'saveEdit': {
      const addr = li.querySelector('.e-addr').value.trim(), name = li.querySelector('.e-name').value.trim();
      if (!addr) return;
      if (addr !== s.text) { s.text = addr; s.geo = null; s.failed = false; invalidate(); }
      s.name = name; s.phone = normPhone(li.querySelector('.e-phone').value) || li.querySelector('.e-phone').value.trim();
      s.note = li.querySelector('.e-note').value.trim();
      rememberCustomer(s);
      persist(); render(); geocodeAll().catch(() => {});
      break;
    }
  }
});

$('calc').addEventListener('click', calculate);
$('clearAll').addEventListener('click', () => {
  if (!confirm('למחוק את כל התחנות?')) return;
  S.stops = []; S.result = null; S.banner = ''; persist(); render();
});

// ---------- customer memory (by phone) ----------
// The phone is read reliably from receipts, so it is the key: after a customer is confirmed once,
// the next receipt fills in the verified name/address and the exact delivery location.
const CUST = 'rp.customers.v1';
let customers = load(CUST, {});
const phoneKey = p => (p || '').replace(/\D/g, '');
const EXACT = ['gps', 'manual', 'house'];
function rememberCustomer(s) {
  const k = phoneKey(s.phone); if (k.length < 9) return;
  const prev = customers[k] || {};
  customers[k] = { name: s.name || prev.name || '', text: s.text || prev.text || '', note: s.note || prev.note || '',
    geo: s.geo && ['gps', 'manual'].includes(s.geo.precision) ? s.geo : prev.geo || null, updated: Date.now() };
  save(CUST, customers);
}
const knownCustomer = phone => customers[phoneKey(phone)] || null;

// ---------- receipt scanning ----------
const knownTowns = () => [...new Set(S.stops.map(s => s.text.split(',').pop().trim()).filter(t => t && !/\d/.test(t)))];
let scanned = [];
$('scanInput').addEventListener('change', async e => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  scanned = files.map(f => ({ url: URL.createObjectURL(f), status: 'pending' }));
  renderScan(); $('scanDlg').showModal();
  for (let i = 0; i < files.length; i++) {
    scanned[i].status = 'working'; renderScan(`סורק חשבונית ${i + 1} מתוך ${files.length}…`);
    try {
      const r = await scanReceipt(files[i], msg => renderScan(msg), knownTowns());
      const known = knownCustomer(r.phone);
      Object.assign(scanned[i], r, { status: 'done' },
        known ? { name: known.name || r.name, address: known.text || r.address, note: r.note || known.note || '', geo: known.geo, known: true, cityMatched: true } : {});
    } catch (err) { Object.assign(scanned[i], { status: 'error', error: err.message }); }
    renderScan();
  }
  renderScan('בדוק את הפרטים מול התמונה, תקן אם צריך, ולחץ "הוסף לקו".');
});
function renderScan(msg) {
  if (msg !== undefined) $('scanStatus').textContent = msg;
  $('scanList').innerHTML = scanned.map((r, i) => `<li data-i="${i}" class="scan-item ${r.added ? 'added' : ''}">
    <a href="${r.url}" target="_blank" rel="noopener"><img src="${r.url}" alt="חשבונית ${i + 1}"></a>
    <div class="scan-fields">
      ${r.status === 'pending' ? '<div class="muted">ממתין…</div>' : r.status === 'working' ? '<div class="muted">⏳ סורק…</div>'
      : r.status === 'error' ? `<div class="err">${esc(r.error)}</div>` : r.added ? '<div class="ok">✔ נוסף לקו</div>' : `
      ${r.known ? `<div class="ok">⭐ לקוח מוכר — פרטים שמורים${r.geo ? ' + מיקום מדויק' : ''}</div>` : ''}
      <label>שם<input type="text" data-f="name" value="${esc(r.name)}"></label>
      <label>טלפון ${r.phone ? '' : '<span class="warn">⚠ לא זוהה</span>'}<input type="tel" data-f="phone" value="${esc(r.phone)}" inputmode="tel"></label>
      <label>כתובת ${!r.cityMatched ? '<span class="warn">⚠ בדוק</span>' : r.streetOfficial ? '<span class="ok small">✔ רחוב רשמי</span>' : ''}<input type="text" data-f="address" value="${esc(r.address)}"></label>
      <label>הערה לשליח<input type="text" data-f="note" value="${esc(r.note || '')}" placeholder="קוד כניסה, הוראות הגעה…"></label>
      ${r.date ? `<div class="muted small">תאריך משלוח: ${esc(r.date)}</div>` : ''}
      <button data-s="add">➕ הוסף לקו</button>`}
    </div></li>`).join('');
}
$('scanList').addEventListener('input', e => {
  const f = e.target.dataset.f; if (!f) return;
  scanned[+e.target.closest('li').dataset.i][f] = e.target.value;
});
function addScanned(list) {
  const ok = list.filter(r => r.status === 'done' && !r.added && r.address.trim());
  for (const r of ok) {
    const text = normalizeStreet(r.address).replace(/^,\s*/, '');
    const known = knownCustomer(r.phone);
    const stop = { id: uid(), text, name: r.name.trim(), phone: normPhone(r.phone) || r.phone.trim(), note: (r.note || '').trim(),
      geo: known?.geo && known.text === text ? known.geo : null }; // saved location only if the address wasn't changed
    S.stops.push(stop); rememberCustomer(stop);
    r.added = true;
  }
  if (ok.length) { invalidate(); render(); geocodeAll().catch(() => {}); }
  renderScan(list.some(r => r.status === 'done' && !r.added) ? 'לחשבוניות שנשארו חסרה כתובת — השלם אותה.' : `נוספו ${ok.length} משלוחים לקו ✔`);
}
$('scanList').addEventListener('click', e => {
  if (e.target.dataset.s === 'add') addScanned([scanned[+e.target.closest('li').dataset.i]]);
});
$('scanAddAll').addEventListener('click', () => addScanned(scanned));

// ---------- saved routes ----------
const SAVED = 'rp.saved.v1';
function renderSaved() {
  const list = load(SAVED, []);
  $('savedList').innerHTML = list.length ? list.map((r, i) => `<li data-i="${i}">
      <div class="body"><div class="title">${esc(r.name)}</div>
      <div class="sub">${r.data.stops.length} תחנות · ${new Date(r.savedAt).toLocaleDateString('he-IL')}</div></div>
      <button data-a="load">טען</button><button class="ghost" data-a="del" aria-label="מחק">🗑</button></li>`).join('')
    : '<li class="muted">אין עדיין מסלולים שמורים.</li>';
}
$('openSaved').addEventListener('click', () => { renderSaved(); $('savedDlg').showModal(); });
$('saveRoute').addEventListener('click', () => {
  const name = prompt('שם המסלול:', `קו ${new Date().toLocaleDateString('he-IL')}`);
  if (!name) return;
  const list = load(SAVED, []);
  const data = JSON.parse(JSON.stringify(S));
  data.stops.forEach(s => delete s.done);
  const existing = list.findIndex(r => r.name === name);
  const entry = { name, savedAt: Date.now(), data };
  if (existing >= 0) { if (!confirm('קיים מסלול בשם הזה. להחליף?')) return; list[existing] = entry; } else list.unshift(entry);
  save(SAVED, list); setStatus(`המסלול "${name}" נשמר`);
});
$('savedList').addEventListener('click', e => {
  const btn = e.target.closest('button[data-a]'); if (!btn) return;
  const list = load(SAVED, []), i = +btn.closest('li').dataset.i;
  if (btn.dataset.a === 'load') {
    if (S.stops.length && !confirm('לטעון את המסלול? הרשימה הנוכחית תוחלף.')) return;
    S = JSON.parse(JSON.stringify(list[i].data)); persist(); render(); $('savedDlg').close();
    setStatus(`נטען: ${list[i].name}`);
  } else if (confirm(`למחוק את "${list[i].name}"?`)) { list.splice(i, 1); save(SAVED, list); renderSaved(); }
});
$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ routes: load(SAVED, []), customers }, null, 1)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'routes-backup.json' });
  a.click(); URL.revokeObjectURL(a.href);
});
$('importFile').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const raw = JSON.parse(await f.text());
    const incoming = Array.isArray(raw) ? raw : raw.routes || [];
    if (!incoming.every(r => r.name && r.data?.stops)) throw 0;
    if (raw.customers) { customers = { ...raw.customers, ...customers }; save(CUST, customers); }
    const list = load(SAVED, []), names = new Set(list.map(r => r.name));
    incoming.forEach(r => { if (!names.has(r.name)) list.push(r); });
    save(SAVED, list); renderSaved();
  } catch { alert('הקובץ אינו גיבוי מסלולים תקין'); }
  e.target.value = '';
});

render();
