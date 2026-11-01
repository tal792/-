// Exact route optimisation with integer linear programming (HiGHS solver, runs in the browser).
// Model: asymmetric TSP as a cycle start → stops → end → start (the end→start arc is fixed, cost 0),
// assignment constraints + subtour-elimination cuts added lazily until the solution is one tour.
// When it finishes, the order is PROVEN optimal for the travel-time matrix.

const v = (i, j) => `x_${i}_${j}`;

export async function solveExact(m, getHighs, { timeMs = 12000 } = {}) {
  const N = m.length, last = N - 1, t0 = Date.now();
  const arcs = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (i === j) continue;
    if (i === last && j !== 0) continue;     // end node only returns to start
    if (j === 0 && i !== last) continue;     // start is entered only from end
    if (i === 0 && j === last && N > 2) continue;
    arcs.push([i, j]);
  }
  const cost = (i, j) => (i === last && j === 0 ? 0 : Math.round(m[i][j] * 10) / 10);
  const head = ['Minimize', ' obj: ' + arcs.map(([i, j]) => `${cost(i, j)} ${v(i, j)}`).join(' + '), 'Subject To'];
  const rows = [];
  for (let i = 0; i < N; i++) {
    rows.push(` o${i}: ` + arcs.filter(a => a[0] === i).map(a => v(...a)).join(' + ') + ' = 1');
    rows.push(` i${i}: ` + arcs.filter(a => a[1] === i).map(a => v(...a)).join(' + ') + ' = 1');
  }
  const tail = ['Bounds', ` ${v(last, 0)} = 1`, 'Binary', ' ' + arcs.map(a => v(...a)).join(' '), 'End'];

  let bound = 0, cuts = 0;
  for (let round = 0; round < 200; round++) {
    const left = timeMs - (Date.now() - t0);
    if (left <= 200) return { optimal: false, bound };
    const highs = await getHighs();
    const res = highs.solve([...head, ...rows, ...tail].join('\n'), { time_limit: left / 1000, mip_rel_gap: 0 });
    if (res.Status !== 'Optimal') return { optimal: false, bound };
    bound = Math.max(bound, res.ObjectiveValue); // each round is a relaxation → valid lower bound
    const next = new Array(N).fill(-1);
    for (const [i, j] of arcs) if (res.Columns[v(i, j)].Primal > 0.5) next[i] = j;
    // split the solution into cycles
    const seen = new Array(N).fill(false), cycles = [];
    for (let s = 0; s < N; s++) {
      if (seen[s]) continue;
      const cyc = [];
      for (let k = s; !seen[k]; k = next[k]) { seen[k] = true; cyc.push(k); }
      cycles.push(cyc);
    }
    if (cycles.length === 1) {
      const order = [];
      for (let k = next[0]; k !== last; k = next[k]) order.push(k);
      return { optimal: true, order, bound, cuts };
    }
    for (const cyc of cycles) { // subtour elimination: a set S may use at most |S|-1 of its inner arcs
      const set = new Set(cyc), inner = arcs.filter(([i, j]) => set.has(i) && set.has(j));
      rows.push(` c${cuts++}: ` + inner.map(a => v(...a)).join(' + ') + ` <= ${cyc.length - 1}`);
    }
  }
  return { optimal: false, bound };
}
