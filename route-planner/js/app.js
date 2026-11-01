import { geocode, travelMatrix, drivingRoute, wazeLink, gmapsLink, gmapsRouteLinks } from './services.js';
import { solveRoute, routeCost } from './solver.js';

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
let S = load(KEY, null) || { start: { text: '', geo: null }, end: { text: '', geo: null }, roundTrip: true, city: '', service: 0, stops: [], result: null };
const persist = () => save(KEY, S);
let busy = false;

// ---------- helpers ----------
const fmtKm = m => (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' ק"מ';
function fmtTime(sec) {
  const min = Math.round(sec / 60), h = Math.floor(min / 60);
  return h ? `${h} ש' ${min % 60} דק'` : `${min} דק'`;
}
function setStatus(msg, error = false) { $('status').textContent = msg || ''; $('status').classList.toggle('error', error); }
function parseLine(line) {
  const [addr, ...name] = line.split('|');
  return { id: uid(), text: addr.trim(), name: name.join('|').trim(), geo: null };
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

// ---------- main calculation ----------
async function calculate() {
  if (busy) return;
  if (!S.start.text.trim()) return setStatus('נא להזין נקודת התחלה', true);
  if (!S.roundTrip && !S.end.text.trim()) return setStatus('נא להזין נקודת סיום', true);
  if (!S.stops.length) return setStatus('נא להוסיף לפחות תחנה אחת', true);
  busy = true; $('calc').disabled = true;
  try {
    const places = [S.start, ...(S.roundTrip ? [] : [S.end]), ...S.stops];
    const todo = places.filter(p => !p.geo);
    for (let i = 0; i < todo.length; i++) {
      setStatus(`מאתר כתובות… ${i + 1}/${todo.length}`);
      await locate(todo[i]);
      renderStops(); drawMap();
    }
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
    setStatus('מחשב סדר תחנות אופטימלי…');
    const { order, cost, exact } = solveRoute(mtx.durations);
    const inputCost = routeCost(mtx.durations, S.stops.map((_, i) => i + 1));
    S.stops = order.map(i => S.stops[i - 1]);
    await routeCurrentOrder(exact ? 'exact' : 'heuristic');
    S.result.saved = Math.max(0, inputCost - cost);
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
  $('city').value = S.city; $('service').value = S.service;
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
    exact: '✔ סדר אופטימלי — חושב במדויק לפי זמני נסיעה בכבישים',
    heuristic: '✔ סדר ממוטב לפי זמני נסיעה בכבישים (חישוב מקורב — מעל 13 תחנות)',
    manual: '✋ סדר ידני — לא ממוטב. לחץ "חשב מסלול" לסדר אופטימלי',
  }[r.method];
  $('summary').innerHTML = `
    <div class="totals"><span>🛣️ ${fmtKm(r.distance)}</span><span>⏱️ ${fmtTime(r.duration)}</span>
    ${stopTime ? `<span>כולל עצירות: ${fmtTime(r.duration + stopTime)}</span>` : ''}</div>
    <div class="method ${r.method === 'manual' ? 'manual' : ''}">${method}</div>
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
      : s.geo ? `<div class="sub">${esc(s.geo.precision === 'manual' ? '📍 מיקום שנקבע ידנית' : s.geo.label)}</div>${PRECISION_WARN[s.geo.precision] || ''}`
      : '<div class="sub">טרם אותרה</div>';
    return `<li data-i="${i}" class="${s.done ? 'done' : ''}">
      <div class="num">${i + 1}</div>
      <div class="body">
        <div class="title">${esc(s.name || s.text)}</div>
        ${s.name ? `<div class="sub">${esc(s.text)}</div>` : ''}
        ${geoInfo}
        ${leg ? `<div class="leg">↤ ${fmtTime(leg.duration)} · ${fmtKm(leg.distance)} מהתחנה הקודמת</div>` : ''}
        <div class="acts">
          ${s.geo ? `<a class="btn" target="_blank" rel="noopener" href="${wazeLink(s.geo)}">Waze</a>
                     <a class="btn secondary" target="_blank" rel="noopener" href="${gmapsLink(s.geo)}">Google</a>` : ''}
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
    + (next ? `<a class="btn secondary" target="_blank" rel="noopener" href="${wazeLink(next.geo)}">🚗 Waze לתחנה הבאה: ${esc(next.name || next.text)}</a>` : '<p class="muted">כל התחנות בוצעו ✔</p>');
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
      invalidate('מיקום תחנה עודכן — לחץ "חשב מסלול" לחישוב מחדש'); render();
    });
    bounds.push([s.geo.lat, s.geo.lon]);
  });
  if (S.result?.geometry) L.geoJSON(S.result.geometry, { style: { color: '#0f5c8c', weight: 5, opacity: .75 } }).addTo(layer);
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
}

// ---------- events ----------
function bindPlace(id, key) {
  $(id).addEventListener('change', () => {
    const t = $(id).value.trim();
    if (t === S[key].text) return;
    S[key] = { text: t, geo: null }; invalidate(); render();
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
  invalidate(); render();
});
$('pasteAdd').addEventListener('click', () => {
  const lines = $('paste').value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return;
  S.stops.push(...lines.map(parseLine)); $('paste').value = ''; $('pasteBox').open = false;
  invalidate(); render(); setStatus(`נוספו ${lines.length} תחנות`);
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
        <input type="text" class="e-name" value="${esc(s.name)}" placeholder="שם החנות (לא חובה)">
        <div class="acts"><button data-a="saveEdit">שמור</button><button class="secondary" data-a="cancelEdit">ביטול</button></div></div>`);
      btn.disabled = true; body.querySelector('.e-addr').focus();
      break;
    }
    case 'cancelEdit': renderStops(); break;
    case 'saveEdit': {
      const addr = li.querySelector('.e-addr').value.trim(), name = li.querySelector('.e-name').value.trim();
      if (!addr) return;
      if (addr !== s.text) { s.text = addr; s.geo = null; s.failed = false; invalidate(); }
      s.name = name; persist(); render();
      break;
    }
  }
});

$('calc').addEventListener('click', calculate);
$('clearAll').addEventListener('click', () => {
  if (!confirm('למחוק את כל התחנות?')) return;
  S.stops = []; S.result = null; S.banner = ''; persist(); render();
});

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
  const blob = new Blob([JSON.stringify(load(SAVED, []), null, 1)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'routes-backup.json' });
  a.click(); URL.revokeObjectURL(a.href);
});
$('importFile').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const incoming = JSON.parse(await f.text());
    if (!Array.isArray(incoming) || !incoming.every(r => r.name && r.data?.stops)) throw 0;
    const list = load(SAVED, []), names = new Set(list.map(r => r.name));
    incoming.forEach(r => { if (!names.has(r.name)) list.push(r); });
    save(SAVED, list); renderSaved();
  } catch { alert('הקובץ אינו גיבוי מסלולים תקין'); }
  e.target.value = '';
});

render();
