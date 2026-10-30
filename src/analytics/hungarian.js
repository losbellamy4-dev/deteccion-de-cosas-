/**
 * hungarian.js — Asignación óptima de mínimo coste (algoritmo húngaro /
 * Kuhn-Munkres con potenciales, O(n²·m)).
 *
 * El Tracker lo usa para emparejar "pistas existentes" con "detecciones del
 * frame actual". Frente a un emparejamiento voraz (greedy), el húngaro evita
 * que una pista robe la detección de otra cuando dos personas se cruzan, lo que
 * se traduce directamente en IDs más estables.
 *
 * @param {number[][]} cost Matriz n×m de costes FINITOS (usar un número grande,
 *   p. ej. 1e6, para emparejamientos prohibidos y descartarlos después).
 * @returns {number[]} Para cada fila i, índice de columna asignada o -1.
 */
export function hungarian(cost) {
  const n = cost.length;
  if (n === 0) return [];
  const m = cost[0].length;
  if (m === 0) return new Array(n).fill(-1);

  // El algoritmo requiere n ≤ m: si hay más filas que columnas, se resuelve
  // la traspuesta y se invierte el resultado.
  if (n > m) {
    const t = Array.from({ length: m }, (_, j) => Array.from({ length: n }, (_, i) => cost[i][j]));
    const colToRow = hungarian(t);
    const res = new Array(n).fill(-1);
    colToRow.forEach((i, j) => { if (i >= 0) res[i] = j; });
    return res;
  }

  // Implementación clásica con índices desde 1 (la fila/columna 0 es ficticia).
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1);   // p[j] = fila asignada a la columna j
  const way = new Int32Array(m + 1);
  const minv = new Float64Array(m + 1);
  const used = new Uint8Array(m + 1);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    minv.fill(Infinity);
    used.fill(0);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      const row = cost[i0 - 1];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = row[j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else { minv[j] -= delta; }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    // Reconstruye la cadena de aumento.
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const assign = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j] > 0) assign[p[j] - 1] = j - 1;
  return assign;
}
