// Route-order solver over a travel-time matrix.
// Node 0 = start, nodes 1..n = stops, node n+1 = end (may be same place as start).
// Returns { order: [stop indices 1..n in visiting order], cost, exact }.

export const EXACT_LIMIT = 13; // Held-Karp is exact and fast up to ~13 stops in the browser.

export function solveRoute(m) {
  const n = m.length - 2;
  if (n <= 0) return { order: [], cost: m[0][1] ?? 0, exact: true };
  if (n <= EXACT_LIMIT) return heldKarp(m, n);
  return heuristic(m, n);
}

export function routeCost(m, order) {
  const end = m.length - 1;
  let c = 0, prev = 0;
  for (const j of order) { c += m[prev][j]; prev = j; }
  return c + m[prev][end];
}

// Exact dynamic programming (Held-Karp): guaranteed optimal for the given matrix.
function heldKarp(m, n) {
  const end = n + 1, FULL = 1 << n;
  const dp = new Float64Array(FULL * n).fill(Infinity);
  const parent = new Int8Array(FULL * n).fill(-1);
  for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = m[0][j + 1];
  for (let mask = 1; mask < FULL; mask++) {
    for (let j = 0; j < n; j++) {
      if (!(mask & (1 << j))) continue;
      const cur = dp[mask * n + j];
      if (cur === Infinity) continue;
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue;
        const nm = mask | (1 << k), v = cur + m[j + 1][k + 1];
        if (v < dp[nm * n + k]) { dp[nm * n + k] = v; parent[nm * n + k] = j; }
      }
    }
  }
  let best = Infinity, last = -1;
  for (let j = 0; j < n; j++) {
    const v = dp[(FULL - 1) * n + j] + m[j + 1][end];
    if (v < best) { best = v; last = j; }
  }
  const order = [];
  let mask = FULL - 1;
  while (last !== -1) {
    order.push(last + 1);
    const p = parent[mask * n + last];
    mask &= ~(1 << last);
    last = p;
  }
  order.reverse();
  return { order, cost: best, exact: true };
}

// Large routes: nearest neighbour + 2-opt + Or-opt local search (asymmetric-safe).
function heuristic(m, n) {
  const left = new Set(Array.from({ length: n }, (_, i) => i + 1));
  let order = [], prev = 0;
  while (left.size) {
    let best = -1;
    for (const j of left) if (best < 0 || m[prev][j] < m[prev][best]) best = j;
    order.push(best); left.delete(best); prev = best;
  }
  let cost = routeCost(m, order), improved = true;
  while (improved) {
    improved = false;
    // 2-opt: reverse a segment
    for (let i = 0; i < n - 1; i++) for (let k = i + 1; k < n; k++) {
      const cand = order.slice(0, i).concat(order.slice(i, k + 1).reverse(), order.slice(k + 1));
      const c = routeCost(m, cand);
      if (c < cost - 1e-6) { order = cand; cost = c; improved = true; }
    }
    // Or-opt: move a segment of 1-3 stops elsewhere
    for (let len = 1; len <= 3; len++) for (let i = 0; i + len <= n; i++) {
      const seg = order.slice(i, i + len), rest = order.slice(0, i).concat(order.slice(i + len));
      for (let p = 0; p <= rest.length; p++) {
        if (p === i) continue;
        const cand = rest.slice(0, p).concat(seg, rest.slice(p));
        const c = routeCost(m, cand);
        if (c < cost - 1e-6) { order = cand; cost = c; improved = true; break; }
      }
    }
  }
  return { order, cost, exact: false };
}
