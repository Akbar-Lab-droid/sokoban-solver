// Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// One program answers a whole set of 5 Sokoban levels in one run. Each level
// is a hallway with one to four small rooms off it; a box never leaves its
// room, so every room is solved on its own with a push-optimal A* search and
// the room solutions are joined with hallway walks between the doors.
//
// The search is a push-based A*: a state is the player's square and the
// boxes' squares, a step costs one push, and the estimate is the cheapest
// matching of boxes to goals over precomputed box-travel distances. Dead
// squares (a box that can never reach a goal) and frozen 2x2 blocks are
// pruned. The work is bounded by expansion caps, never by the clock, so two
// runs write the same bytes.
//
// Node 22, no dependencies, no network. Reads level.txt under
// MAKEFUN_INPUT_DIR (default /input) and writes solution.txt under
// MAKEFUN_OUTPUT_DIR (default /output).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed direction order everywhere, so the output is deterministic.
// 0 = up, 1 = down, 2 = left, 3 = right; opposite of d is d ^ 1.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const CH = ['u', 'd', 'l', 'r'];

// Expansion caps per room search. A* first, then a greedy best-first
// fallback that trades optimality for a solution rather than none.
const ASTAR_CAP = 300000;
const GREEDY_CAP = 200000;

// ---------------------------------------------------------------------------
// Level parsing
// ---------------------------------------------------------------------------

interface Level {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall (or outside the rows' text)
  goal: Uint8Array; // 1 = goal
  box: Uint8Array; // 1 = box
  player: number; // cell index
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const box = new Uint8Array(w * h);
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') box[i] = 1;
      if (ch === '@' || ch === '+') player = i;
    }
  });
  return { w, h, wall, goal, box, player };
}

// ---------------------------------------------------------------------------
// Decomposition: hallway row + rooms
// ---------------------------------------------------------------------------

interface Room {
  cells: number[]; // global cell indices of the room (sorted)
  boxes: number[]; // global cell indices of the room's boxes
  goals: number[]; // global cell indices of the room's goals
  door: number; // global index of the door cell (in the room, by the hallway)
  entry: number; // global index of the hallway cell by the door
}

function decompose(level: Level): { hallwayRow: number; rooms: Room[]; stray: boolean } {
  const { w, h, wall, goal, box, player } = level;
  const hallwayRow = Math.floor(player / w);
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  let stray = false;
  for (let i = 0; i < w * h; i++) {
    if (wall[i] || seen[i]) continue;
    const y = Math.floor(i / w);
    if (y === hallwayRow) continue;
    const stack = [i];
    seen[i] = 1;
    const cells: number[] = [];
    while (stack.length > 0) {
      const c = stack.pop() as number;
      cells.push(c);
      const cx = c % w;
      const cy = Math.floor(c / w);
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d];
        const ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (wall[n] || seen[n] || ny === hallwayRow) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    cells.sort((a, b) => a - b);
    const boxes = cells.filter((c) => box[c]);
    const goals = cells.filter((c) => goal[c]);
    if (boxes.length === 0 && goals.length === 0) continue;
    // The door is the room cell by the hallway row; the entry is the
    // hallway cell next to it. A room has exactly one door.
    let door = -1;
    for (const c of cells) {
      const cy = Math.floor(c / w);
      if (Math.abs(cy - hallwayRow) === 1 && !wall[hallwayRow * w + (c % w)]) {
        door = c;
        break;
      }
    }
    if (door === -1) {
      // A pocket with boxes but no way to the hallway: unsolvable as built.
      if (boxes.length > 0) stray = true;
      continue;
    }
    const entry = hallwayRow * w + (door % w);
    rooms.push({ cells, boxes, goals, door, entry });
  }
  // A box or goal sitting in the hallway row itself is outside every room.
  for (let x = 0; x < w; x++) {
    const c = hallwayRow * w + x;
    if (box[c] || goal[c]) stray = true;
  }
  return { hallwayRow, rooms, stray };
}

// ---------------------------------------------------------------------------
// A region to search: walkable cells, box cells, goals, start.
// A room region is the room's cells plus its entry cell (the player may
// stand there, a box may never be pushed there). A whole-level region is
// every floor cell, used only when a level does not decompose.
// ---------------------------------------------------------------------------

interface Region {
  nWalk: number; // walkable local cells (box cells first, then others)
  nBox: number; // box cells: local indices 0 .. nBox - 1
  gx: Int16Array; // global x per local cell
  gy: Int16Array; // global y per local cell
  nbr: Int16Array; // nWalk * 4: walkable neighbour local index, or -1
  goals: number[]; // local indices of goal cells
  dead: Uint8Array; // per box cell: 1 when a box there can never reach a goal
  dist: number[][]; // dist[g][cell]: box-travel distance from cell to goal g
  blocks: number[][]; // 2x2 blocks: 4 local box-cell indices, -1 = blocked
  startPlayer: number; // local index
  startBoxes: number[]; // local indices, sorted
  entry: number; // local index of the entry cell, or -1
}

function buildRegion(
  level: Level,
  walkCells: number[],
  boxCells: number[],
  goals: number[],
  startPlayer: number,
  startBoxes: number[],
  entry: number,
): Region {
  const { w } = level;
  // Box cells first (local 0..nBox-1), then the other walkable cells.
  const ordered = [...boxCells];
  for (const c of walkCells) if (!boxCells.includes(c)) ordered.push(c);
  const nWalk = ordered.length;
  const nBox = boxCells.length;
  const locOf = new Map<number, number>();
  ordered.forEach((c, i) => locOf.set(c, i));
  const gx = new Int16Array(nWalk);
  const gy = new Int16Array(nWalk);
  ordered.forEach((c, i) => {
    gx[i] = c % w;
    gy[i] = Math.floor(c / w);
  });
  const nbr = new Int16Array(nWalk * 4).fill(-1);
  for (let i = 0; i < nWalk; i++) {
    for (let d = 0; d < 4; d++) {
      const nx = gx[i] + DX[d];
      const ny = gy[i] + DY[d];
      if (nx < 0 || ny < 0 || nx >= w) continue;
      const g = ny * w + nx;
      const j = locOf.get(g);
      if (j !== undefined) nbr[i * 4 + d] = j;
    }
  }
  const goalLocals = goals.map((g) => locOf.get(g) as number);
  const startBoxesLocal = startBoxes.map((b) => locOf.get(b) as number).sort((a, b) => a - b);
  const startPlayerLocal = locOf.get(startPlayer) as number;
  const entryLocal = entry >= 0 ? (locOf.get(entry) as number) : -1;

  // Dead squares: reverse box travel from the goals. A box at c can move to
  // n = nbr[c][d] only when the player can stand at nbr[c][d ^ 1], so going
  // backwards from n, a predecessor c = nbr[n][d ^ 1] is reachable when the
  // stand cell nbr[c][d ^ 1] is walkable. Cells never reached are dead.
  const dead = new Uint8Array(nBox).fill(1);
  const reach = new Uint8Array(nBox);
  const queue: number[] = [];
  for (const g of goalLocals) {
    if (!reach[g]) {
      reach[g] = 1;
      queue.push(g);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const n = queue[q] as number;
    for (let d = 0; d < 4; d++) {
      const c = nbr[n * 4 + (d ^ 1)];
      if (c < 0 || c >= nBox || reach[c]) continue;
      const stand = nbr[c * 4 + (d ^ 1)];
      if (stand < 0) continue;
      reach[c] = 1;
      queue.push(c);
    }
  }
  for (let i = 0; i < nBox; i++) if (reach[i]) dead[i] = 0;

  // Box-travel distances from every goal over box cells.
  const dist: number[][] = [];
  for (const g of goalLocals) {
    const dg = new Array<number>(nBox).fill(Infinity);
    dg[g] = 0;
    const qq = [g];
    for (let qi = 0; qi < qq.length; qi++) {
      const c = qq[qi] as number;
      for (let d = 0; d < 4; d++) {
        const n = nbr[c * 4 + d];
        if (n < 0 || n >= nBox || dg[n] !== Infinity) continue;
        dg[n] = dg[c] + 1;
        qq.push(n);
      }
    }
    dist.push(dg);
  }

  // 2x2 blocks: four cells each a box cell or blocked (wall / entry /
  // outside). A box in such a block cannot move at all, so a block holding
  // a box off its goal is a dead state. The top-left corner ranges over
  // every cell, not just walkable ones, so a block whose corner is a wall
  // is still found.
  const blocks: number[][] = [];
  for (let ty = 0; ty < level.h; ty++) {
    for (let tx = 0; tx < level.w; tx++) {
      const corners = [
        locOf.get(ty * w + tx),
        locOf.get(ty * w + tx + 1),
        locOf.get((ty + 1) * w + tx),
        locOf.get((ty + 1) * w + tx + 1),
      ];
      if (corners.some((c) => c !== undefined && c >= nBox)) continue; // a walkable non-box cell: not frozen
      if (corners.every((c) => c === undefined || (c as number) < nBox)) {
        blocks.push(corners.map((c) => (c === undefined ? -1 : (c as number))));
      }
    }
  }

  return {
    nWalk,
    nBox,
    gx,
    gy,
    nbr,
    goals: goalLocals,
    dead,
    dist,
    blocks,
    startPlayer: startPlayerLocal,
    startBoxes: startBoxesLocal,
    entry: entryLocal,
  };
}

// ---------------------------------------------------------------------------
// Push search over a region
// ---------------------------------------------------------------------------

interface SearchResult {
  pushes: number; // number of pushes in the solution
  moves: string; // full move string (walks + pushes), lowercase
  endPlayer: number; // local index where the player ends
  endBoxes: number[]; // local indices where the boxes end
}

// The heuristic: the cheapest matching of boxes to goals over box-travel
// distances. Every box needs at least its distance in pushes, and one push
// moves one box, so the sum over a matching is a lower bound. Small rooms
// get the exact matching by enumeration; larger sets fall back to the sum
// of each box's nearest goal, which is still a lower bound.
function heuristic(region: Region, boxes: number[]): number {
  const { dist, goals } = region;
  if (boxes.length === 0) return 0;
  if (boxes.length <= 6 && boxes.length === goals.length) {
    // Exact matching: permute goal ordinals (dist is indexed by ordinal).
    const n = boxes.length;
    const perm = goals.map((_, i) => i);
    let best = Infinity;
    const rec = (k: number, acc: number): void => {
      if (acc >= best) return;
      if (k === n) {
        best = acc;
        return;
      }
      for (let i = k; i < n; i++) {
        const t = perm[k] as number;
        perm[k] = perm[i] as number;
        perm[i] = t;
        const d = dist[perm[k] as number]![boxes[k] as number] as number;
        if (d !== Infinity) rec(k + 1, acc + d);
        const t2 = perm[k] as number;
        perm[k] = perm[i] as number;
        perm[i] = t2;
      }
    };
    rec(0, 0);
    return best;
  }
  let s = 0;
  for (const b of boxes) {
    let m = Infinity;
    for (let g = 0; g < goals.length; g++) {
      const d = dist[g]![b] as number;
      if (d < m) m = d;
    }
    if (m === Infinity) return Infinity;
    s += m;
  }
  return s;
}

// True when a box layout can never be solved: a box on a dead square, or a
// frozen 2x2 block holding a box off its goal.
function isDead(region: Region, boxes: number[]): boolean {
  for (const b of boxes) {
    if (region.dead[b]) {
      // A box on a dead square is fine when it sits on a goal.
      if (!region.goals.includes(b)) return true;
    }
  }
  if (region.blocks.length === 0) return false;
  const boxHere = new Uint8Array(region.nBox);
  for (const b of boxes) boxHere[b] = 1;
  for (const block of region.blocks) {
    // A block is frozen only when every box cell in it holds a box: an
    // empty box cell is a way out, not a wall. A frozen block holding a
    // box off its goal is dead.
    let boxCells = 0;
    let occupied = 0;
    let hasOffGoal = false;
    for (const c of block) {
      if (c < 0) continue;
      boxCells++;
      if (boxHere[c]) {
        occupied++;
        if (!region.goals.includes(c)) hasOffGoal = true;
      }
    }
    if (boxCells > 0 && occupied === boxCells && hasOffGoal) return true;
  }
  return false;
}

// The cells the player can reach from `from`, walking on walkable cells
// that hold no box. Returns a bitset over local cells, plus the smallest
// reachable cell (the canonical player position for the state key).
function reachable(region: Region, from: number, boxes: number[]): { set: Uint8Array; min: number } {
  const { nbr, nWalk } = region;
  const boxHere = new Uint8Array(region.nBox);
  for (const b of boxes) boxHere[b] = 1;
  const set = new Uint8Array(nWalk);
  set[from] = 1;
  const queue = [from];
  let min = from;
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q] as number;
    if (c < min) min = c;
    for (let d = 0; d < 4; d++) {
      const n = nbr[c * 4 + d];
      if (n < 0 || set[n]) continue;
      if (n < region.nBox && boxHere[n]) continue;
      set[n] = 1;
      queue.push(n);
    }
  }
  return { set, min };
}

// A walk from `from` to `to` over walkable cells avoiding boxes, as a move
// string. Deterministic: fixed direction order, FIFO queue.
function walkTo(region: Region, from: number, to: number, boxes: number[]): string | null {
  if (from === to) return '';
  const { nbr, nWalk } = region;
  const boxHere = new Uint8Array(region.nBox);
  for (const b of boxes) boxHere[b] = 1;
  const prev = new Int16Array(nWalk).fill(-1);
  const prevDir = new Int8Array(nWalk).fill(-1);
  prev[from] = from;
  const queue = [from];
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q] as number;
    for (let d = 0; d < 4; d++) {
      const n = nbr[c * 4 + d];
      if (n < 0 || prev[n] !== -1) continue;
      if (n < region.nBox && boxHere[n]) continue;
      prev[n] = c;
      prevDir[n] = d;
      if (n === to) {
        let moves = '';
        for (let t = n; t !== from; t = prev[t] as number) moves = CH[prevDir[t] as number] + moves;
        return moves;
      }
      queue.push(n);
    }
  }
  return null;
}

// Binary heap ordered by (f, tie, counter): deterministic.
class Heap {
  private a: [number, number, number, number][] = [];
  get size(): number {
    return this.a.length;
  }
  push(f: number, tie: number, counter: number, node: number): void {
    const a = this.a;
    let i = a.length;
    a.push([f, tie, counter, node]);
    while (i > 0) {
      const p = (i - 1) >> 1;
      const x = a[i] as [number, number, number, number];
      const y = a[p] as [number, number, number, number];
      if (x[0] < y[0] || (x[0] === y[0] && (x[1] < y[1] || (x[1] === y[1] && x[2] < y[2])))) {
        a[i] = y;
        a[p] = x;
        i = p;
      } else break;
    }
  }
  pop(): [number, number, number, number] {
    const a = this.a;
    const top = a[0] as [number, number, number, number];
    const last = a.pop() as [number, number, number, number];
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length) {
          const l = a[c] as [number, number, number, number];
          const r = a[c + 1] as [number, number, number, number];
          if (r[0] < l[0] || (r[0] === l[0] && (r[1] < l[1] || (r[1] === l[1] && r[2] < l[2])))) c++;
        }
        const cur = a[i] as [number, number, number, number];
        const ch = a[c] as [number, number, number, number];
        if (ch[0] < cur[0] || (ch[0] === cur[0] && (ch[1] < cur[1] || (ch[1] === cur[1] && ch[2] < cur[2])))) {
          a[i] = ch;
          a[c] = cur;
          i = c;
        } else break;
      }
    }
    return top;
  }
}

// Push search. `greedy` orders the open list by the heuristic alone (fast,
// not optimal); otherwise A* on pushes + heuristic. `requireReturn` only
// accepts goal states from which the player can still reach the entry.
// Returns the push list (each: box cell before the push, direction), or
// null when the cap runs out.
function pushSearch(
  region: Region,
  cap: number,
  greedy: boolean,
  requireReturn: boolean,
): { box: number; dir: number }[] | null {
  const { nbr, nBox } = region;
  const startBoxes = region.startBoxes;
  const startH = heuristic(region, startBoxes);
  if (startH === Infinity || isDead(region, startBoxes)) return null;

  const keyOf = (player: number, boxes: number[]): string => {
    // Local indices fit in 6 bits for rooms; use a string key otherwise.
    if (region.nWalk <= 64) {
      let k = player;
      for (let i = 0; i < boxes.length; i++) k = k * 64 + (boxes[i] as number);
      return 'n' + String(k);
    }
    return 's' + player + ':' + boxes.join(',');
  };

  const nPlayer: number[] = [];
  const nBoxes: number[][] = [];
  const nG: number[] = [];
  const nParent: number[] = [];
  const nPushBox: number[] = [];
  const nPushDir: number[] = [];
  const best = new Map<string, number>();

  const addNode = (player: number, boxes: number[], g: number, parent: number, pb: number, pd: number): number => {
    const t = nPlayer.length;
    nPlayer.push(player);
    nBoxes.push(boxes);
    nG.push(g);
    nParent.push(parent);
    nPushBox.push(pb);
    nPushDir.push(pd);
    return t;
  };

  const startReach = reachable(region, region.startPlayer, startBoxes);
  const root = addNode(startReach.min, startBoxes, 0, -1, -1, -1);
  best.set(keyOf(startReach.min, startBoxes), root);
  const heap = new Heap();
  let counter = 0;
  heap.push(greedy ? startH : startH, greedy ? 0 : 0, counter++, root);

  let expanded = 0;
  while (heap.size > 0) {
    const [, , , s] = heap.pop();
    const player = nPlayer[s] as number;
    const boxes = nBoxes[s] as number;
    const g = nG[s] as number;
    const k = keyOf(player, boxes);
    if (best.get(k) !== s) continue; // a better route to this state exists
    if (expanded >= cap) return null;
    expanded++;

    // Goal: every box on a goal. With the return constraint, the player
    // must also still be able to reach the entry; otherwise keep searching
    // for another end state.
    let solved = true;
    for (const b of boxes) if (!region.goals.includes(b)) { solved = false; break; }
    if (solved) {
      let ok = true;
      if (requireReturn && region.entry >= 0) {
        const r = reachable(region, player, boxes);
        ok = r.set[region.entry] === 1;
      }
      if (ok) return tracePushes(s);
    }

    const r = reachable(region, player, boxes);
    const boxHere = new Uint8Array(nBox);
    for (const b of boxes) boxHere[b] = 1;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi] as number;
      for (let d = 0; d < 4; d++) {
        const stand = nbr[b * 4 + (d ^ 1)];
        if (stand < 0 || !r.set[stand]) continue;
        const beyond = nbr[b * 4 + d];
        if (beyond < 0 || beyond >= nBox || boxHere[beyond]) continue;
        const nb = boxes.slice();
        nb[bi] = beyond;
        nb.sort((x, y) => x - y);
        if (isDead(region, nb)) continue;
        const h = heuristic(region, nb);
        if (h === Infinity) continue;
        const nr = reachable(region, b, nb);
        const nk = keyOf(nr.min, nb);
        const seen = best.get(nk);
        if (seen !== undefined && nG[seen] as number <= g + 1) continue;
        const t = addNode(nr.min, nb, g + 1, s, b, d);
        best.set(nk, t);
        const f = greedy ? h : g + 1 + h;
        const tie = greedy ? g + 1 : -(g + 1);
        heap.push(f, tie, counter++, t);
      }
    }
  }
  return null;

  function tracePushes(s: number): { box: number; dir: number }[] {
    const out: { box: number; dir: number }[] = [];
    for (let t = s; t > 0; t = nParent[t] as number) {
      out.push({ box: nPushBox[t] as number, dir: nPushDir[t] as number });
    }
    out.reverse();
    return out;
  }
}

// Turn a push list into the full move string by walking between pushes.
function pushesToMoves(region: Region, pushes: { box: number; dir: number }[]): SearchResult | null {
  let player = region.startPlayer;
  let boxes = region.startBoxes.slice();
  let moves = '';
  for (const p of pushes) {
    const stand = region.nbr[p.box * 4 + (p.dir ^ 1)];
    const walk = walkTo(region, player, stand, boxes);
    if (walk === null) return null;
    moves += walk + CH[p.dir];
    player = p.box;
    const at = boxes.indexOf(p.box);
    boxes[at] = region.nbr[p.box * 4 + p.dir] as number;
    boxes.sort((a, b) => a - b);
  }
  return { pushes: pushes.length, moves, endPlayer: player, endBoxes: boxes };
}

// Solve one region: A* first, greedy fallback, each bounded by caps.
function solveRegion(region: Region, requireReturn: boolean): SearchResult | null {
  const tries: { cap: number; greedy: boolean }[] = [
    { cap: ASTAR_CAP, greedy: false },
    { cap: GREEDY_CAP, greedy: true },
  ];
  for (const t of tries) {
    const pushes = pushSearch(region, t.cap, t.greedy, requireReturn);
    if (pushes === null) continue;
    const res = pushesToMoves(region, pushes);
    if (res !== null) return res;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Solving one level: rooms + hallway walks
// ---------------------------------------------------------------------------

// Replay moves on a level the way the checker does. Returns the push count
// when the replay is legal and solves the level, or -1 otherwise.
function replay(level: Level, moves: string): number {
  const { w, wall, goal } = level;
  const box = new Uint8Array(level.box);
  let player = level.player;
  let pushes = 0;
  for (const ch of moves) {
    const d = CH.indexOf(ch.toLowerCase());
    if (d < 0) return -1;
    const dd = DY[d] * w + DX[d];
    const next = player + dd;
    if (wall[next]) return -1;
    if (box[next]) {
      const beyond = next + dd;
      if (wall[beyond] || box[beyond]) return -1;
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    player = next;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !goal[i]) return -1;
  return pushes;
}

// A walk over the hallway row (plus the cell the walk starts from) as a
// move string, or null when there is no path.
function hallwayWalk(level: Level, from: number, to: number): string | null {
  const { w, h, wall } = level;
  const hallwayRow = Math.floor(level.player / w);
  if (from === to) return '';
  const prev = new Int16Array(w * h).fill(-1);
  const prevDir = new Int8Array(w * h).fill(-1);
  prev[from] = from;
  const queue = [from];
  const passable = (c: number): boolean => {
    if (c === from) return true;
    return Math.floor(c / w) === hallwayRow && !wall[c];
  };
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q] as number;
    const cx = c % w;
    const cy = Math.floor(c / w);
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (prev[n] !== -1 || !passable(n)) continue;
      prev[n] = c;
      prevDir[n] = d;
      if (n === to) {
        let moves = '';
        for (let t = n; t !== from; t = prev[t] as number) moves = CH[prevDir[t] as number] + moves;
        return moves;
      }
      queue.push(n);
    }
  }
  return null;
}

interface RoomSolution {
  room: Room;
  region: Region;
  result: SearchResult;
  returnable: boolean;
}

// Solve one room (as its own region) and tell whether the player can walk
// back out to the entry afterwards.
function solveOneRoom(level: Level, room: Room, requireReturn: boolean): RoomSolution | null {
  const region = buildRegion(level, room.cells.concat([room.entry]), room.cells, room.goals, room.entry, room.boxes, room.entry);
  const result = solveRegion(region, requireReturn);
  if (result === null) return null;
  // Can the player walk back to the entry from where the solution ends?
  let returnable = true;
  if (!requireReturn) {
    const back = walkTo(region, result.endPlayer, region.entry, result.endBoxes);
    returnable = back !== null;
  }
  return { room, region, result, returnable };
}

// Solve a whole level. Returns the move string, or '' when unsolved.
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const { hallwayRow, rooms, stray } = decompose(level);
  const allBoxes = level.box.reduce((a, b) => a + b, 0);
  if (allBoxes === 0) return '';
  if (stray || rooms.length === 0) {
    // Does not decompose: solve the whole level as one region.
    const floor: number[] = [];
    const boxes: number[] = [];
    const goals: number[] = [];
    for (let i = 0; i < level.w * level.h; i++) {
      if (level.wall[i]) continue;
      floor.push(i);
      if (level.box[i]) boxes.push(i);
      if (level.goal[i]) goals.push(i);
    }
    const region = buildRegion(level, floor, floor, goals, level.player, boxes, -1);
    const res = solveRegion(region, false);
    if (res === null) return '';
    return replay(level, res.moves) >= 0 ? res.moves : '';
  }

  // Solve every room on its own, without the return constraint first.
  const solved: RoomSolution[] = [];
  for (const room of rooms) {
    const s = solveOneRoom(level, room, false);
    if (s === null) return '';
    solved.push(s);
  }
  // A room whose player cannot get back out must be solved again with the
  // return constraint, so it can go first; a room that still cannot return
  // has to be last.
  for (const s of solved) {
    if (!s.returnable) {
      const retry = solveOneRoom(level, s.room, true);
      if (retry !== null) {
        s.region = retry.region;
        s.result = retry.result;
        s.returnable = true;
      }
    }
  }

  // Try room orders: returnable rooms first (by entry column, then door
  // row), then the rest. Every order is verified by replaying the whole
  // move string, so a wrong order costs nothing but time.
  const orders: RoomSolution[][] = [];
  const preferred = solved.slice().sort((a, b) => {
    const ra = a.returnable ? 0 : 1;
    const rb = b.returnable ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (a.room.entry % level.w !== b.room.entry % level.w) return (a.room.entry % level.w) - (b.room.entry % level.w);
    return a.room.door - b.room.door;
  });
  orders.push(preferred);
  if (solved.length > 1 && solved.length <= 4) {
    // All other orders, in lexicographic order of room index.
    const idx = solved.map((_, i) => i);
    const permute = (arr: number[], start: number): void => {
      if (start === arr.length) {
        const order = arr.map((i) => solved[i] as RoomSolution);
        if (order !== preferred && !orders.some((o) => o.every((s, j) => s === order[j]))) orders.push(order);
        return;
      }
      for (let i = start; i < arr.length; i++) {
        const t = arr[start] as number;
        arr[start] = arr[i] as number;
        arr[i] = t;
        permute(arr, start + 1);
        const t2 = arr[start] as number;
        arr[start] = arr[i] as number;
        arr[i] = t2;
      }
    };
    permute(idx, 0);
  }

  for (const order of orders) {
    const moves = assemble(level, order);
    if (moves !== null && replay(level, moves) >= 0) return moves;
  }
  return '';
}

// Join room solutions with hallway walks. Returns null when a walk fails.
function assemble(level: Level, order: RoomSolution[]): string | null {
  let moves = '';
  let pos = level.player;
  for (let ri = 0; ri < order.length; ri++) {
    const s = order[ri] as RoomSolution;
    const toEntry = hallwayWalk(level, pos, s.room.entry);
    if (toEntry === null) return null;
    moves += toEntry;
    moves += s.result.moves;
    pos = globalCell(level, s.region, s.result.endPlayer);
    if (ri < order.length - 1) {
      // Walk back out to this room's door, so the next hallway walk can
      // start there. (A room that cannot return was ordered last.)
      const toDoor = walkTo(s.region, s.result.endPlayer, doorLocal(s.region, s.room, level), s.result.endBoxes);
      if (toDoor === null) return null;
      moves += toDoor;
      pos = s.room.door;
    }
  }
  return moves;
}

// The door cell's local index inside a room region.
function doorLocal(region: Region, room: Room, level: Level): number {
  // The door is a room cell; find its local index by global coordinates.
  for (let i = 0; i < region.nBox; i++) {
    if (region.gx[i] === room.door % level.w && region.gy[i] === Math.floor(room.door / level.w)) return i;
  }
  return -1;
}

// A region-local cell index back to a global cell index.
function globalCell(level: Level, region: Region, local: number): number {
  return region.gy[local] * level.w + region.gx[local];
}

// ---------------------------------------------------------------------------
// Main: one run over the whole set
// ---------------------------------------------------------------------------

function main(): void {
  const ids = readdirSync(INPUT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const id of ids) {
    let moves = '';
    try {
      const text = readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8');
      moves = solveLevel(text);
    } catch {
      moves = '';
    }
    mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
    writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
  }
}

main();
