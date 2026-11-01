// External map services. All free and keyless in this version, so no secrets live in the code.
// To switch to a paid/keyed provider later, route these calls through a small server-side proxy.

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OSRM = 'https://router.project-osrm.org';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, what) {
  try { return await fetch(url); }
  catch { throw new Error(`אין חיבור ל${what}. בדוק את החיבור לאינטרנט ונסה שוב.`); }
}

// ---------- geocoding (OpenStreetMap Nominatim, max 1 request/second, cached) ----------
const CACHE_KEY = 'rp.geoCache.v2';
let cache = {};
try { cache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch {}
let lastCall = 0;

async function query(q) {
  if (q in cache) return cache[q];
  const wait = 1100 - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const url = `${NOMINATIM}?format=jsonv2&limit=1&countrycodes=il&addressdetails=1&accept-language=he&q=${encodeURIComponent(q)}`;
  const res = await get(url, 'שירות איתור הכתובות');
  if (!res.ok) throw new Error('שירות איתור הכתובות לא זמין (' + res.status + ')');
  const [hit] = await res.json();
  let result = null;
  if (hit) {
    const a = hit.address || {};
    // Hebrew house numbers are often missing in OSM, so report how exact the match really is.
    const precision = a.house_number || ['shop', 'amenity', 'building', 'office', 'craft'].includes(hit.category) ? 'house'
      : hit.category === 'highway' ? 'street' : 'area';
    result = { lat: +hit.lat, lon: +hit.lon, label: hit.display_name.split(',').slice(0, 3).join(','), precision };
  }
  cache[q] = result; // negative results are cached too, to respect the free service
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
  return result;
}

// Tries the full address, then the street without house number, then the town only.
export async function geocode(text, defaultCity = '') {
  // the country name only hurts the search (and must never become a 'city' fallback)
  const t = text.trim().replace(/[,\s]*(ישראל|israel)\s*$/i, '').replace(/\s+/g, ' ');
  const parts = t.split(',').map(x => x.trim()).filter(Boolean);
  const city = parts.length > 1 ? parts[parts.length - 1] : defaultCity;
  const street = parts.length > 1 ? parts.slice(0, -1).join(' ') : t;
  const noNum = street.replace(/\s*\d+[א-ת]?\s*$/, '').replace(/^\d+\s+/, '').trim();
  const tries = [t];
  if (city && !t.includes(city)) tries.push(`${t}, ${city}`);
  if (city && noNum && noNum !== street) tries.push(`${noNum}, ${city}`);
  for (const q of [...new Set(tries)]) {
    const r = await query(q);
    if (r) return r;
  }
  if (city) {
    const r = await query(city);
    if (r) return { ...r, precision: 'area' };
  }
  return null;
}

// ---------- routing (OSRM, real road network, car profile) ----------
const coordStr = pts => pts.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join('%3B'); // encoded ';' — accepted by OSRM and safe through strict proxies

async function osrm(path) {
  const res = await get(OSRM + path, 'שירות הניתוב');
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.code !== 'Ok') throw new Error('שירות הניתוב לא זמין כרגע (' + (j.message || res.status) + '). נסה שוב בעוד דקה.');
  return j;
}

// Road travel-time (seconds) and distance (meters) between every pair of points.
export async function travelMatrix(points) {
  if (points.length > 100) throw new Error('עד 98 תחנות במסלול אחד');
  const j = await osrm(`/table/v1/driving/${coordStr(points)}?annotations=duration,distance`);
  const bad = j.durations.findIndex((row, i) => row.some((v, k) => v == null && i !== k));
  if (bad >= 0) throw new Error('UNREACHABLE:' + bad);
  return { durations: j.durations, distances: j.distances };
}

// Full driving route through points in the given order.
export async function drivingRoute(points) {
  const j = await osrm(`/route/v1/driving/${coordStr(points)}?overview=full&geometries=geojson`);
  const r = j.routes[0];
  return { distance: r.distance, duration: r.duration, geometry: r.geometry, legs: r.legs.map(l => ({ distance: l.distance, duration: l.duration })) };
}

// ---------- navigation links ----------
const ll = p => `${p.lat},${p.lon}`;
export const wazeLink = p => `https://waze.com/ul?ll=${ll(p)}&navigate=yes`;
export const gmapsLink = p => `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${ll(p)}`;

// Google Maps links accept a limited number of waypoints (about 9 on phones), so long routes are split.
export function gmapsRouteLinks(points, perLink = 9) {
  const links = [];
  for (let i = 0; i < points.length - 1; i += perLink + 1) {
    const seg = points.slice(i, i + perLink + 2);
    let u = `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${ll(seg[0])}&destination=${ll(seg[seg.length - 1])}`;
    if (seg.length > 2) u += '&waypoints=' + seg.slice(1, -1).map(ll).join('%7C');
    links.push(u);
  }
  return links;
}
