// Runs the optimisation off the main thread so the screen stays responsive.
// 1) fast result (exact DP up to 13 stops, otherwise iterated local search + lower bound)
// 2) for larger routes: exact integer programming (HiGHS) to PROVE optimality or improve the order.
import { solveRoute, routeCost } from './solver.js';
import { solveExact } from './exact.js';

const HIGHS = 'https://cdn.jsdelivr.net/npm/highs@1.8.0';
let highs = null;
async function getHighs() {
  if (!highs) {
    const mod = await import(HIGHS + '/+esm');
    highs = await mod.default({ locateFile: f => `${HIGHS}/build/${f}` });
  }
  return highs;
}

self.onmessage = async ({ data: { m } }) => {
  const quick = solveRoute(m, { timeMs: 1200 });
  self.postMessage({ type: 'quick', ...quick });
  if (quick.proven) return self.postMessage({ type: 'final', ...quick });
  try {
    const ex = await solveExact(m, getHighs, { timeMs: 15000 });
    if (ex.optimal) {
      const cost = routeCost(m, ex.order);
      const better = cost < quick.cost - 0.5;
      return self.postMessage({ type: 'final', order: better ? ex.order : quick.order, cost: Math.min(cost, quick.cost), bound: Math.min(cost, quick.cost), proven: true });
    }
    self.postMessage({ type: 'final', ...quick, bound: Math.max(quick.bound, ex.bound) });
  } catch {
    self.postMessage({ type: 'final', ...quick }); // solver could not load (offline?) – keep the guaranteed-gap result
  }
};
