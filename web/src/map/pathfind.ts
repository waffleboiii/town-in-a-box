/**
 * A* path finding on the tile grid (8 directions). Used only to draw a believable commute line
 * along streets for car / bus / bike / walking commuters. Metro and RER are drawn as arcs instead.
 */
import { TT } from './terrainTypes';
import type { CommuteMode } from '../types';

export function costTable(mode: CommuteMode): Float32Array {
  const c = new Float32Array(16).fill(2.4);
  const car = mode === 'car' || mode === 'bus';
  c[TT.street] = 1;
  c[TT.plaza] = 1.2;
  c[TT.ring] = car ? 0.55 : 9;
  c[TT.park] = car ? 4 : 1.3;
  c[TT.grass] = car ? 4 : 1.7;
  c[TT.forest] = car ? 6 : 2.2;
  c[TT.water] = 80;
  c[TT.rail] = 7;
  c[TT.outside] = 5;
  return c;
}

class MinHeap {
  private items: number[] = [];
  private prio: number[] = [];
  get size() {
    return this.items.length;
  }
  push(item: number, p: number) {
    this.items.push(item);
    this.prio.push(p);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent] <= this.prio[i]) break;
      [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
      [this.prio[i], this.prio[parent]] = [this.prio[parent], this.prio[i]];
      i = parent;
    }
  }
  pop(): number {
    const top = this.items[0];
    const lastI = this.items.pop()!;
    const lastP = this.prio.pop()!;
    if (this.items.length) {
      this.items[0] = lastI;
      this.prio[0] = lastP;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.prio[l] < this.prio[m]) m = l;
        if (r < this.items.length && this.prio[r] < this.prio[m]) m = r;
        if (m === i) break;
        [this.items[i], this.items[m]] = [this.items[m], this.items[i]];
        [this.prio[i], this.prio[m]] = [this.prio[m], this.prio[i]];
        i = m;
      }
    }
    return top;
  }
}

/** Returns a list of tile coordinates from start to goal (inclusive), or null. */
export function findPath(w: number, h: number, tiles: Uint8Array, cost: Float32Array, sx: number, sy: number, gx: number, gy: number): [number, number][] | null {
  const N = w * h;
  const start = sy * w + sx;
  const goal = gy * w + gx;
  if (start < 0 || goal < 0 || start >= N || goal >= N) return null;
  const g = new Float32Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const heap = new MinHeap();
  const minCost = 0.55;
  const hfun = (i: number) => {
    const x = i % w;
    const y = (i / w) | 0;
    const dx = Math.abs(x - gx);
    const dy = Math.abs(y - gy);
    return minCost * (Math.max(dx, dy) + 0.414 * Math.min(dx, dy));
  };
  g[start] = 0;
  heap.push(start, hfun(start));
  let iter = 0;
  const DX = [1, -1, 0, 0, 1, 1, -1, -1];
  const DY = [0, 0, 1, -1, 1, -1, 1, -1];
  while (heap.size && iter++ < 80000) {
    const cur = heap.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k];
      const ny = cy + DY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (closed[ni]) continue;
      const step = (k < 4 ? 1 : 1.414) * (cost[tiles[ni]] ?? 2.4);
      const ng = g[cur] + step;
      if (ng < g[ni]) {
        g[ni] = ng;
        from[ni] = cur;
        heap.push(ni, ng + hfun(ni));
      }
    }
  }
  if (from[goal] < 0 && goal !== start) return null;
  const out: [number, number][] = [];
  for (let c = goal; c >= 0; c = from[c]) {
    out.push([c % w, (c / w) | 0]);
    if (c === start) break;
  }
  out.reverse();
  return out;
}

/** Remove points that lie on a straight run so the dashed line looks calm. */
export function simplify(path: [number, number][]): [number, number][] {
  if (path.length < 3) return path;
  const out: [number, number][] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const [ax, ay] = out[out.length - 1];
    const [bx, by] = path[i];
    const [cx, cy] = path[i + 1];
    const d1x = Math.sign(bx - ax);
    const d1y = Math.sign(by - ay);
    const d2x = Math.sign(cx - bx);
    const d2y = Math.sign(cy - by);
    if (d1x !== d2x || d1y !== d2y) out.push(path[i]);
  }
  out.push(path[path.length - 1]);
  return out;
}
