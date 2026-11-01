// Route-order solver over a travel-time matrix m (seconds, may be asymmetric).
// Node 0 = start, nodes 1..n = stops, node n+1 = end (may be the same place as start).
// Returns { order, cost, bound, proven }:
//   order  – stop indices (1..n) in visiting order
//   bound  – mathematical lower bound: no order can be faster than this
//   proven – true when the order is guaranteed optimal (exact DP, or cost reached the bound)

export const EXACT_LIMIT = 13;

export function routeCost(m, order) {
  const end = m.length - 1;
  let c = 0, prev = 0;
  for (const j of order) { c += m[prev][j]; prev = j; }
  return c + m[prev][end];
}

export function solveRoute(m, { timeMs = 1500, seed = 12345 } = {}) {
  const n = m.length - 2;
  if (n <= 0) { const c = m[0][m.length - 1] || 0; return { order: [], cost: c, bound: c, proven: true }; }
  if (n <= EXACT_LIMIT) { const r = heldKarp(m, n); return { ...r, bound: r.cost, proven: true }; }
  const bound = lowerBound(m);
  const r = iteratedLocalSearch(m, n, timeMs, seed, bound);
  return { ...r, bound, proven: r.cost - bound < 0.5 };
}

// ---------- exact: Held-Karp dynamic programming ----------
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
  return { order: order.reverse(), cost: best };
}

// ---------- lower bound: Held-Karp 1-tree relaxation with subgradient optimisation ----------
// Relaxations used (each can only lower the value, so the result is a valid bound):
//  * direction ignored: edge weight = min(m[i][j], m[j][i])
//  * the start→end path becomes a cycle by forcing a zero-cost edge end–start
//  * the cycle constraint is relaxed to a "1-tree", tightened with node penalties (Lagrangian)
export function lowerBound(m, iterations = 600) {
  const N = m.length, last = N - 1, BIG = 1e7;
  const c = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => Math.min(m[i][j], m[j][i])));
  c[0][last] = c[last][0] = -BIG; // forces this edge into every tree we compute
  const pi = new Float64Array(N), deg = new Int32Array(N);
  const key = new Float64Array(N), from = new Int32Array(N), inTree = new Uint8Array(N);
  let best = -Infinity, lambda = 2, stall = 0;
  const ub = ilsUpperForBound(m) - BIG;
  for (let it = 0; it < iterations; it++) {
    deg.fill(0); inTree.fill(0);
    // Prim's MST on nodes 1..N-1
    let total = 0;
    key.fill(Infinity); key[1] = 0; from[1] = -1;
    for (let k = 1; k < N; k++) {
      let u = -1;
      for (let v = 1; v < N; v++) if (!inTree[v] && (u < 0 || key[v] < key[u])) u = v;
      inTree[u] = 1; total += key[u];
      if (from[u] >= 0) { deg[u]++; deg[from[u]]++; }
      for (let v = 1; v < N; v++) {
        if (inTree[v]) continue;
        const w = c[u][v] + pi[u] + pi[v];
        if (w < key[v]) { key[v] = w; from[v] = u; }
      }
    }
    // node 0 joins with its two cheapest edges
    let a = -1, b = -1;
    for (let v = 1; v < N; v++) {
      const w = c[0][v] + pi[0] + pi[v];
      if (a < 0 || w < c[0][a] + pi[0] + pi[a]) { b = a; a = v; }
      else if (b < 0 || w < c[0][b] + pi[0] + pi[b]) b = v;
    }
    total += c[0][a] + pi[0] + pi[a] + c[0][b] + pi[0] + pi[b];
    deg[0] = 2; deg[a]++; deg[b]++;
    let piSum = 0; for (let v = 0; v < N; v++) piSum += pi[v];
    const L = total - 2 * piSum;
    if (L > best + 1e-6) { best = L; stall = 0; } else if (++stall >= Math.max(10, N / 2)) { lambda /= 2; stall = 0; }
    let norm = 0; for (let v = 0; v < N; v++) norm += (deg[v] - 2) ** 2;
    if (norm === 0 || lambda < 1e-4) break; // a 1-tree that is a tour: bound is exact
    const step = lambda * Math.max(1, ub - L) / norm;
    for (let v = 0; v < N; v++) pi[v] += step * (deg[v] - 2);
  }
  return Math.max(0, best + BIG);
}

// quick upper bound used only for the subgradient step size
function ilsUpperForBound(m) {
  const n = m.length - 2;
  return routeCost(m, localSearch(m, nearestNeighbour(m, n)));
}

// ---------- heuristic: Iterated Local Search (2-opt + Or-opt, double-bridge kicks) ----------
function nearestNeighbour(m, n) {
  const left = new Set(Array.from({ length: n }, (_, i) => i + 1));
  const order = [];
  let prev = 0;
  while (left.size) {
    let best = -1;
    for (const j of left) if (best < 0 || m[prev][j] < m[prev][best]) best = j;
    order.push(best); left.delete(best); prev = best;
  }
  return order;
}

function localSearch(m, order) {
  const n = order.length;
  let cost = routeCost(m, order), improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < n - 1; i++) for (let k = i + 1; k < n; k++) {
      const cand = order.slice(0, i).concat(order.slice(i, k + 1).reverse(), order.slice(k + 1));
      const c = routeCost(m, cand);
      if (c < cost - 1e-6) { order = cand; cost = c; improved = true; }
    }
    for (let len = 1; len <= 3; len++) for (let i = 0; i + len <= n; i++) {
      const seg = order.slice(i, i + len), rest = order.slice(0, i).concat(order.slice(i + len));
      for (const s of len > 1 ? [seg, seg.slice().reverse()] : [seg]) {
        for (let p = 0; p <= rest.length; p++) {
          if (p === i && s === seg) continue;
          const cand = rest.slice(0, p).concat(s, rest.slice(p));
          const c = routeCost(m, cand);
          if (c < cost - 1e-6) { order = cand; cost = c; improved = true; break; }
        }
        if (improved) break;
      }
    }
  }
  return order;
}

function rng(seed) { // mulberry32 – deterministic, so the same input gives the same route
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function kick(order, rand) {
  const n = order.length;
  if (n < 8) { // small: swap two random stops
    const o = order.slice(), i = Math.floor(rand() * n), j = Math.floor(rand() * n);
    [o[i], o[j]] = [o[j], o[i]]; return o;
  }
  const cuts = [0, 0, 0].map(() => 1 + Math.floor(rand() * (n - 1))).sort((a, b) => a - b);
  const [p, q, r] = cuts;
  return order.slice(0, p).concat(order.slice(q, r), order.slice(p, q), order.slice(r)); // double bridge
}

function iteratedLocalSearch(m, n, timeMs, seed, bound) {
  const rand = rng(seed), t0 = Date.now();
  let cur = localSearch(m, nearestNeighbour(m, n)), curCost = routeCost(m, cur);
  let best = cur, bestCost = curCost, sinceBest = 0, iterations = 0;
  while (Date.now() - t0 < timeMs && bestCost - bound >= 0.5) {
    const cand = localSearch(m, kick(cur, rand)), c = routeCost(m, cand);
    iterations++;
    if (c <= curCost + 1e-6) { cur = cand; curCost = c; }
    if (c < bestCost - 1e-6) { best = cand; bestCost = c; sinceBest = 0; }
    else if (++sinceBest > 60) { cur = best; curCost = bestCost; sinceBest = 0; }
  }
  return { order: best, cost: bestCost, iterations };
}
