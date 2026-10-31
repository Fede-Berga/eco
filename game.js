'use strict';

// ============================================================================
// ECO — an echolocation game.
//
// You are a small creature lost in a pitch-black cave. Pressing SPACE emits a
// sound wave (a "ping") that expands outward as a ring; where the wavefront
// touches a wall, that piece of wall lights up for a few seconds, then fades.
// You navigate by memory of what you glimpsed. Somewhere in the cave there is
// an exit: when a ping reaches it you hear a chime, panned left/right and
// louder the closer you are — sound itself is your compass.
//
// From level 2 onward a predator roams the cave. It is blind too, but it
// hears: every ping you emit gives away your position, and it comes looking.
// Pings reveal it only as a snapshot — by the time you see it, it has moved.
//
// Systems overview:
//   - Cave generation: cellular automata + flood fill (largest region kept).
//   - Ping: N rays raycast on the grid (DDA); each ray stores where it will
//     hit, and the hit is revealed only when the expanding ring reaches it.
//   - Reveal marks: short-lived glowing segments/dots, drawn additively.
//   - Predator AI: BFS pathfinding on the grid; wanders when idle, hunts the
//     origin of the last sound it heard.
//   - Audio: WebAudio oscillators synthesized on the fly (no asset files).
// ============================================================================

// --- Tunables ---------------------------------------------------------------
const TILE = 26;              // world pixels per grid cell
const PLAYER_RADIUS = 7;
const PLAYER_SPEED = 135;     // px/s
const PING_COOLDOWN = 0.8;    // seconds between pings
const PING_RAYS = 540;        // rays cast per ping
const WAVE_SPEED = 330;       // px/s, wavefront expansion speed
const PING_MAX_R = 460;       // px, max wave radius
const MARK_LIFE = 4.5;        // seconds a revealed wall stays visible
const EXIT_MARK_LIFE = 6.5;
const PREDATOR_MARK_LIFE = 1.8;
const BUMP_MARK_LIFE = 2.0;
const PREDATOR_RADIUS = 11;
const HEARTBEAT_RANGE = 320;  // px, you hear the predator's heartbeat inside this
const FOOTSTEP_RANGE = 140;   // px, the predator hears you *moving* inside this
const HUNT_ARRIVAL = 40;      // px, "close enough" to a heard sound — deliberately
                              // larger than the kill radius, so freezing saves you
const EXIT_REACH = TILE * 0.6;
const MAX_MARKS = 5000;

const LEVELS = [
  { cols: 40, rows: 30, predator: null,
    hint: 'SPAZIO per il ping · trova l’uscita' },
  { cols: 48, rows: 34, predator: { huntSpeed: 105, hearing: 900 },
    hint: 'Qualcosa ti ascolta…' },
  { cols: 56, rows: 40, predator: { huntSpeed: 130, hearing: 1300 },
    hint: 'Non farti sentire.' },
];

const COLORS = {
  wall: 'rgba(150, 214, 255, ',   // pale cyan (alpha appended)
  exit: 'rgba(255, 210, 120, ',   // warm gold
  predator: 'rgba(255, 92, 92, ', // red
  player: '#e8f6ff',
};

// --- Small helpers ----------------------------------------------------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

// ============================================================================
// Cave generation
// ============================================================================
// Cellular automata: start from random noise, then repeatedly turn each cell
// into wall if enough of its neighbours are walls. This clumps the noise into
// organic cave shapes. We then keep only the largest connected open region.

function generateCave(cols, rows) {
  for (let attempt = 0; attempt < 60; attempt++) {
    let cells = new Uint8Array(cols * rows); // 1 = wall, 0 = open
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const border = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
        cells[y * cols + x] = border || Math.random() < 0.44 ? 1 : 0;
      }
    }

    for (let iter = 0; iter < 5; iter++) {
      const next = new Uint8Array(cells);
      for (let y = 1; y < rows - 1; y++) {
        for (let x = 1; x < cols - 1; x++) {
          let walls = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++)
              walls += cells[(y + dy) * cols + (x + dx)];
          next[y * cols + x] = walls >= 5 ? 1 : 0;
        }
      }
      cells = next;
    }

    // Keep only the largest open region; fill the rest with wall.
    const region = new Int32Array(cols * rows).fill(-1);
    let bestId = -1, bestSize = 0, id = 0;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] === 1 || region[i] !== -1) continue;
      let size = 0;
      const queue = [i];
      region[i] = id;
      while (queue.length) {
        const c = queue.pop();
        size++;
        const cx = c % cols, cy = (c / cols) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy, n = ny * cols + nx;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          if (cells[n] === 0 && region[n] === -1) { region[n] = id; queue.push(n); }
        }
      }
      if (size > bestSize) { bestSize = size; bestId = id; }
      id++;
    }
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] === 0 && region[i] !== bestId) cells[i] = 1;
    }

    // Reject degenerate caves (too small to be interesting).
    if (bestSize < cols * rows * 0.28) continue;

    // Start and exit: the two ends of the cave's "diameter", found with a
    // double BFS (farthest cell from an arbitrary cell, then farthest from
    // that). Guarantees the longest possible walk.
    const firstOpen = cells.indexOf(0);
    const distA = bfsDistances(cells, cols, rows, firstOpen);
    const a = farthestCell(distA);
    const distFromA = bfsDistances(cells, cols, rows, a);
    const b = farthestCell(distFromA);

    return {
      cols, rows, cells,
      startCell: a, exitCell: b,
      distFromStart: distFromA,
    };
  }
  throw new Error('cave generation failed after 60 attempts');
}

// BFS over open cells (4-neighbour). Returns an Int32Array of distances in
// cells, -1 where unreachable.
function bfsDistances(cells, cols, rows, from) {
  const distMap = new Int32Array(cells.length).fill(-1);
  distMap[from] = 0;
  const queue = [from];
  let head = 0;
  while (head < queue.length) {
    const c = queue[head++];
    const cx = c % cols, cy = (c / cols) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const n = ny * cols + nx;
      if (cells[n] === 0 && distMap[n] === -1) {
        distMap[n] = distMap[c] + 1;
        queue.push(n);
      }
    }
  }
  return distMap;
}

function farthestCell(distMap) {
  let best = 0, bestD = -1;
  for (let i = 0; i < distMap.length; i++) {
    if (distMap[i] > bestD) { bestD = distMap[i]; best = i; }
  }
  return best;
}

function cellCenter(map, cell) {
  return {
    x: (cell % map.cols) * TILE + TILE / 2,
    y: ((cell / map.cols) | 0) * TILE + TILE / 2,
  };
}

// ============================================================================
// Grid queries
// ============================================================================

function isWall(map, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= map.cols || cy >= map.rows) return true;
  return map.cells[cy * map.cols + cx] === 1;
}

// DDA raycast: walk the grid cell by cell along the ray and return the
// distance (in px) to the first wall, or Infinity if none within maxDist.
function raycast(map, x, y, dx, dy, maxDist) {
  let cx = Math.floor(x / TILE), cy = Math.floor(y / TILE);
  if (isWall(map, cx, cy)) return 0;
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(TILE / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(TILE / dy) : Infinity;
  let tMaxX = dx !== 0 ? ((cx + (dx > 0 ? 1 : 0)) * TILE - x) / dx : Infinity;
  let tMaxY = dy !== 0 ? ((cy + (dy > 0 ? 1 : 0)) * TILE - y) / dy : Infinity;
  let t = 0;
  while (t <= maxDist) {
    if (tMaxX < tMaxY) { t = tMaxX; tMaxX += tDeltaX; cx += stepX; }
    else { t = tMaxY; tMaxY += tDeltaY; cy += stepY; }
    if (isWall(map, cx, cy)) return t;
  }
  return Infinity;
}

// True if a straight line from (ax,ay) to (bx,by) is not blocked by walls.
function lineOfSight(map, ax, ay, bx, by) {
  const d = dist(ax, ay, bx, by);
  if (d < 1) return true;
  return raycast(map, ax, ay, (bx - ax) / d, (by - ay) / d, d) >= d;
}

// Circle vs. wall-grid collision. Returns the contact point or null.
function circleHitsWalls(map, x, y, r) {
  const minCx = Math.floor((x - r) / TILE), maxCx = Math.floor((x + r) / TILE);
  const minCy = Math.floor((y - r) / TILE), maxCy = Math.floor((y + r) / TILE);
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      if (!isWall(map, cx, cy)) continue;
      const nx = clamp(x, cx * TILE, (cx + 1) * TILE);
      const ny = clamp(y, cy * TILE, (cy + 1) * TILE);
      const ddx = x - nx, ddy = y - ny;
      if (ddx * ddx + ddy * ddy < r * r) return { x: nx, y: ny };
    }
  }
  return null;
}

// Axis-separated movement: try X and Y independently so blocking one axis
// still lets the other slide along the wall.
function moveActor(map, actor, dx, dy) {
  let bumped = null;
  if (dx !== 0) {
    const hit = circleHitsWalls(map, actor.x + dx, actor.y, actor.r);
    if (!hit) actor.x += dx; else bumped = hit;
  }
  if (dy !== 0) {
    const hit = circleHitsWalls(map, actor.x, actor.y + dy, actor.r);
    if (!hit) actor.y += dy; else bumped = hit;
  }
  return bumped;
}

// BFS path from one cell to another. Returns an array of cell-center points
// (excluding the start cell), or an empty array if unreachable.
function findPath(map, fromCell, toCell) {
  if (fromCell === toCell) return [];
  const cameFrom = new Int32Array(map.cells.length).fill(-1);
  cameFrom[fromCell] = fromCell;
  const queue = [fromCell];
  let head = 0;
  while (head < queue.length) {
    const c = queue[head++];
    if (c === toCell) break;
    const cx = c % map.cols, cy = (c / map.cols) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.cols || ny >= map.rows) continue;
      const n = ny * map.cols + nx;
      if (map.cells[n] === 0 && cameFrom[n] === -1) {
        cameFrom[n] = c;
        queue.push(n);
      }
    }
  }
  if (cameFrom[toCell] === -1) return [];
  const path = [];
  for (let c = toCell; c !== fromCell; c = cameFrom[c]) {
    path.push(cellCenter(map, c));
  }
  path.reverse();
  return path;
}

// ============================================================================
// Audio — everything synthesized with plain oscillators.
// ============================================================================

const AudioSys = {
  ctx: null,

  // Browsers only allow audio after a user gesture; we call this on keydown.
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },

  // One enveloped oscillator: frequency glides f0 -> f1 over dur seconds.
  blip(f0, f1, dur, vol, type = 'sine', pan = 0, delay = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    let out = gain;
    if (this.ctx.createStereoPanner && pan !== 0) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.setValueAtTime(clamp(pan, -1, 1), t);
      gain.connect(panner);
      out = panner;
    }
    out.connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  },

  ping() { this.blip(760, 180, 0.4, 0.22); },
  exitChime(vol, pan) {
    this.blip(1240, 1240, 0.25, vol, 'triangle', pan);
    this.blip(1860, 1860, 0.35, vol * 0.6, 'triangle', pan, 0.09);
  },
  heartbeat(vol) { this.blip(70, 40, 0.22, vol); },
  growl(vol, pan) { this.blip(95, 55, 0.6, vol, 'sawtooth', pan); },
  death() {
    this.blip(300, 55, 0.7, 0.4, 'square');
    this.blip(150, 40, 0.9, 0.3, 'sawtooth', 0, 0.1);
  },
  levelClear() {
    [523, 659, 784].forEach((f, i) => this.blip(f, f, 0.35, 0.2, 'triangle', 0, i * 0.13));
  },
  win() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => this.blip(f, f, 0.5, 0.2, 'triangle', 0, i * 0.15));
  },
};

// ============================================================================
// Game state
// ============================================================================

const game = {
  state: 'title', // title | playing | dead | clear | won
  stateT: 0,      // seconds spent in current state
  level: 0,
  deaths: 0,
  time: 0,        // total time spent in 'playing', for the win screen
  map: null,
  player: null,
  predator: null,
  pings: [],
  marks: [],
  exit: null,     // {x, y}
  pulse: 0,       // red vignette intensity (heartbeat)
  hintT: 0,       // seconds the level hint has been shown
  rArmedUntil: 0, // R pressed once: second press before this time regenerates
};

function startLevel(index) {
  const spec = LEVELS[index];
  game.level = index;
  game.map = generateCave(spec.cols, spec.rows);
  const start = cellCenter(game.map, game.map.startCell);
  game.player = {
    x: start.x, y: start.y, r: PLAYER_RADIUS,
    cooldown: 0, lastBump: 0, moving: false,
  };
  game.exit = cellCenter(game.map, game.map.exitCell);
  game.pings = [];
  game.marks = [];
  game.hintT = 0;
  game.rArmedUntil = 0;
  game.predator = spec.predator ? spawnPredator(spec.predator) : null;
  setState('playing');
}

function setState(s) {
  game.state = s;
  game.stateT = 0;
}

// Place the predator in an open cell far from the player (at least 60% of the
// cave's diameter away), so it never spawns on top of you.
function spawnPredator(spec) {
  const d = game.map.distFromStart;
  let maxD = 0;
  for (let i = 0; i < d.length; i++) maxD = Math.max(maxD, d[i]);
  const threshold = maxD * 0.6;
  const candidates = [];
  for (let i = 0; i < d.length; i++) {
    if (d[i] >= threshold && i !== game.map.exitCell) candidates.push(i);
  }
  const cell = candidates[(Math.random() * candidates.length) | 0];
  const pos = cellCenter(game.map, cell);
  return {
    x: pos.x, y: pos.y, r: PREDATOR_RADIUS,
    huntSpeed: spec.huntSpeed, hearing: spec.hearing,
    wanderSpeed: 42,
    state: 'idle', // idle | hunt | sniff
    huntX: 0, huntY: 0, huntT: 0, sniffT: 0,
    wanderTarget: null,
    path: [], repathT: 0,
    nextGrowl: 4 + Math.random() * 5,
  };
}

// ============================================================================
// Pings
// ============================================================================

function emitPing(x, y) {
  const rays = new Array(PING_RAYS);
  for (let i = 0; i < PING_RAYS; i++) {
    const angle = (i / PING_RAYS) * Math.PI * 2;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const hitDist = raycast(game.map, x, y, dx, dy, PING_MAX_R);
    rays[i] = { dx, dy, angle, hitDist, done: false };
  }
  const exitDist = dist(x, y, game.exit.x, game.exit.y);
  game.pings.push({
    x, y, t0: performance.now() / 1000,
    rays,
    exitDist: exitDist <= PING_MAX_R ? exitDist : Infinity,
    exitDone: false,
    predDone: false,
  });
  AudioSys.ping();

  // The predator hears the ping through walls (sound carries).
  const p = game.predator;
  if (p && dist(x, y, p.x, p.y) <= p.hearing) {
    p.state = 'hunt';
    p.huntX = x; p.huntY = y;
    p.huntT = 8;
    p.repathT = 0; // force immediate repath
  }
}

function addMark(kind, x, y, angle) {
  game.marks.push({ kind, x, y, angle, born: performance.now() / 1000 });
  if (game.marks.length > MAX_MARKS) game.marks.splice(0, game.marks.length - MAX_MARKS);
}

function updatePings(now) {
  const p = game.predator;
  for (const ping of game.pings) {
    const r = (now - ping.t0) * WAVE_SPEED;

    // Reveal each wall hit the moment the wavefront reaches it.
    for (const ray of ping.rays) {
      if (!ray.done && ray.hitDist <= r && ray.hitDist <= PING_MAX_R) {
        ray.done = true;
        addMark('wall',
          ping.x + ray.dx * ray.hitDist,
          ping.y + ray.dy * ray.hitDist,
          ray.angle + Math.PI / 2);
      }
    }

    // The wave crossing the exit: always an audible chime (louder and panned
    // toward it), visible gold mark only with line of sight.
    if (!ping.exitDone && ping.exitDist <= r) {
      ping.exitDone = true;
      const vol = 0.08 + 0.4 * (1 - ping.exitDist / PING_MAX_R);
      const pan = clamp((game.exit.x - game.player.x) / 400, -1, 1);
      AudioSys.exitChime(vol, pan);
      if (lineOfSight(game.map, ping.x, ping.y, game.exit.x, game.exit.y)) {
        addMark('exit', game.exit.x, game.exit.y, 0);
      }
    }

    // The wave crossing the predator: a red snapshot of where it *was*.
    if (p && !ping.predDone) {
      const dp = dist(ping.x, ping.y, p.x, p.y);
      if (dp <= r && dp <= PING_MAX_R) {
        ping.predDone = true;
        if (lineOfSight(game.map, ping.x, ping.y, p.x, p.y)) {
          addMark('predator', p.x, p.y, 0);
        }
      }
    }
  }
  game.pings = game.pings.filter(ping => (now - ping.t0) * WAVE_SPEED <= PING_MAX_R);
}

// ============================================================================
// Update
// ============================================================================

const keys = new Set();

function update(dt, now) {
  game.stateT += dt;

  if (game.state === 'dead') {
    if (game.stateT > 1.4) respawn();
    return;
  }
  if (game.state === 'clear') {
    if (game.stateT > 1.8) {
      if (game.level + 1 < LEVELS.length) startLevel(game.level + 1);
      else setState('won');
    }
    return;
  }
  if (game.state !== 'playing') return;

  game.time += dt;
  game.hintT += dt;

  // --- Player movement ---
  const pl = game.player;
  let mx = 0, my = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) my -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) my += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
  pl.moving = mx !== 0 || my !== 0;
  if (pl.moving) {
    const len = Math.hypot(mx, my);
    const bump = moveActor(game.map, pl,
      (mx / len) * PLAYER_SPEED * dt,
      (my / len) * PLAYER_SPEED * dt);
    // Touching a wall reveals the contact point — a tactile sense.
    if (bump && now - pl.lastBump > 0.09) {
      pl.lastBump = now;
      addMark('bump', bump.x, bump.y, 0);
    }
  }
  pl.cooldown = Math.max(0, pl.cooldown - dt);

  updatePings(now);
  if (game.predator) {
    updatePredator(dt, now);
    if (game.state !== 'playing') return; // caught this very frame
  }

  // --- Exit reached? ---
  if (dist(pl.x, pl.y, game.exit.x, game.exit.y) < EXIT_REACH) {
    setState('clear');
    if (game.level + 1 < LEVELS.length) AudioSys.levelClear();
    else AudioSys.win();
  }

  game.pulse = Math.max(0, game.pulse - dt * 2.5);
}

function updatePredator(dt, now) {
  const p = game.predator;
  const pl = game.player;
  const dToPlayer = dist(p.x, p.y, pl.x, pl.y);

  // It hears footsteps at close range: continuously refreshed hunt target.
  const heardNow = pl.moving && dToPlayer < FOOTSTEP_RANGE;
  if (heardNow) {
    p.state = 'hunt';
    p.huntX = pl.x; p.huntY = pl.y;
    p.huntT = Math.max(p.huntT, 2.5);
  }

  if (p.state === 'hunt') {
    p.huntT -= dt;
    // Reached where the sound came from (and the trail is cold): stop and
    // sniff around instead of lunging. Standing still is what saves you.
    if (p.huntT <= 0 || (!heardNow && dist(p.x, p.y, p.huntX, p.huntY) < HUNT_ARRIVAL)) {
      p.state = 'sniff';
      p.sniffT = 1.2;
      p.path = [];
    }
  }

  if (p.state === 'sniff') {
    p.sniffT -= dt;
    if (p.sniffT <= 0) {
      p.state = 'idle';
      p.wanderTarget = null;
      p.path = [];
    }
  }

  if (p.state === 'idle') {
    if (!p.wanderTarget || dist(p.x, p.y, p.wanderTarget.x, p.wanderTarget.y) < 18) {
      // Pick a random open cell to amble toward.
      let cell;
      do {
        cell = (Math.random() * game.map.cells.length) | 0;
      } while (game.map.cells[cell] === 1);
      p.wanderTarget = cellCenter(game.map, cell);
      p.repathT = 0;
    }
  }

  if (p.state !== 'sniff') {
    // Recompute the BFS path periodically (targets move, corridors twist).
    p.repathT -= dt;
    if (p.repathT <= 0) {
      p.repathT = 0.4;
      const target = p.state === 'hunt' ? { x: p.huntX, y: p.huntY } : p.wanderTarget;
      const fromCell = Math.floor(p.y / TILE) * game.map.cols + Math.floor(p.x / TILE);
      const toCell = Math.floor(target.y / TILE) * game.map.cols + Math.floor(target.x / TILE);
      p.path = findPath(game.map, fromCell, toCell);
    }

    // Follow the path; when BFS has no waypoints left (the target sits in the
    // predator's own cell), close the remaining gap in a straight line.
    while (p.path.length && dist(p.x, p.y, p.path[0].x, p.path[0].y) < 6) p.path.shift();
    const target = p.path.length ? p.path[0]
      : p.state === 'hunt' ? { x: p.huntX, y: p.huntY } : p.wanderTarget;
    const d = dist(p.x, p.y, target.x, target.y);
    if (d > 2) {
      const speed = p.state === 'hunt' ? p.huntSpeed : p.wanderSpeed;
      moveActor(game.map, p, ((target.x - p.x) / d) * speed * dt, ((target.y - p.y) / d) * speed * dt);
    }
  }

  // Heartbeat: the closer it is, the faster and louder your own heart.
  if (dToPlayer < HEARTBEAT_RANGE) {
    const closeness = 1 - dToPlayer / HEARTBEAT_RANGE; // 0..1
    const interval = 1.1 - closeness * 0.65;
    if (!p.lastBeat || now - p.lastBeat > interval) {
      p.lastBeat = now;
      AudioSys.heartbeat(0.1 + closeness * 0.35);
      game.pulse = 0.25 + closeness * 0.5;
    }
  }

  // Occasional growl, panned toward where it actually is.
  p.nextGrowl -= dt;
  if (p.nextGrowl <= 0) {
    p.nextGrowl = 5 + Math.random() * 5;
    if (dToPlayer < 800) {
      AudioSys.growl(0.05 + 0.25 * (1 - dToPlayer / 800),
        clamp((p.x - pl.x) / 400, -1, 1));
    }
  }

  // Caught!
  if (dToPlayer < p.r + pl.r) {
    game.deaths++;
    AudioSys.death();
    game.pulse = 1;
    setState('dead');
  }
}

function respawn() {
  // Same cave, same knowledge (marks persist) — but the predator is moved
  // far away again and forgets about you.
  const start = cellCenter(game.map, game.map.startCell);
  game.player.x = start.x;
  game.player.y = start.y;
  game.player.cooldown = 0;
  game.pings = [];
  const spec = LEVELS[game.level].predator;
  if (spec) game.predator = spawnPredator(spec);
  setState('playing');
}

// ============================================================================
// Rendering
// ============================================================================

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let viewW = 0, viewH = 0;

let appliedDpr = 0;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  appliedDpr = dpr;
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  canvas.width = viewW * dpr;
  canvas.height = viewH * dpr;
  canvas.style.width = viewW + 'px';
  canvas.style.height = viewH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

function cameraPos() {
  const ww = game.map.cols * TILE, wh = game.map.rows * TILE;
  let cx = game.player.x - viewW / 2;
  let cy = game.player.y - viewH / 2;
  cx = ww <= viewW ? (ww - viewW) / 2 : clamp(cx, 0, ww - viewW);
  cy = wh <= viewH ? (wh - viewH) / 2 : clamp(cy, 0, wh - viewH);
  return { x: cx, y: cy };
}

function markLife(kind) {
  switch (kind) {
    case 'exit': return EXIT_MARK_LIFE;
    case 'predator': return PREDATOR_MARK_LIFE;
    case 'bump': return BUMP_MARK_LIFE;
    default: return MARK_LIFE;
  }
}

function render(now) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, viewW, viewH);

  if (game.state === 'title') { renderTitle(now); return; }
  if (game.state === 'won') { renderWon(); return; }

  const cam = cameraPos();
  ctx.save();
  ctx.translate(-cam.x, -cam.y);
  ctx.globalCompositeOperation = 'lighter';

  // --- Reveal marks (fading memories of what the sound touched) ---
  let w = 0;
  for (let i = 0; i < game.marks.length; i++) {
    const m = game.marks[i];
    const age = now - m.born;
    const life = markLife(m.kind);
    if (age > life) continue;      // expired: drop it (compaction below)
    game.marks[w++] = m;
    const alpha = 1 - age / life;

    if (m.kind === 'wall') {
      ctx.strokeStyle = COLORS.wall + (alpha * 0.85) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(m.x - Math.cos(m.angle) * 3, m.y - Math.sin(m.angle) * 3);
      ctx.lineTo(m.x + Math.cos(m.angle) * 3, m.y + Math.sin(m.angle) * 3);
      ctx.stroke();
    } else if (m.kind === 'bump') {
      ctx.fillStyle = COLORS.wall + (alpha * 0.6) + ')';
      ctx.beginPath();
      ctx.arc(m.x, m.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (m.kind === 'exit') {
      const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, 16);
      g.addColorStop(0, COLORS.exit + (alpha * 0.9) + ')');
      g.addColorStop(1, COLORS.exit + '0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 16, 0, Math.PI * 2);
      ctx.fill();
    } else if (m.kind === 'predator') {
      const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, 14);
      g.addColorStop(0, COLORS.predator + (alpha * 0.95) + ')');
      g.addColorStop(1, COLORS.predator + '0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 14, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  game.marks.length = w;

  // --- Ping wavefronts: a dot per ray that hasn't hit anything yet, so the
  // ring visually gets "absorbed" where it meets walls. ---
  for (const ping of game.pings) {
    const r = (now - ping.t0) * WAVE_SPEED;
    const alpha = 0.5 * (1 - r / PING_MAX_R);
    if (alpha <= 0) continue;
    ctx.fillStyle = COLORS.wall + alpha + ')';
    for (const ray of ping.rays) {
      if (ray.hitDist <= r) continue;
      ctx.fillRect(ping.x + ray.dx * r - 1, ping.y + ray.dy * r - 1, 2, 2);
    }
  }

  // --- Exit shimmer when you're right next to it ---
  const de = dist(game.player.x, game.player.y, game.exit.x, game.exit.y);
  if (de < 70) {
    const a = (1 - de / 70) * 0.8;
    const g = ctx.createRadialGradient(game.exit.x, game.exit.y, 0, game.exit.x, game.exit.y, 22);
    g.addColorStop(0, COLORS.exit + a + ')');
    g.addColorStop(1, COLORS.exit + '0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(game.exit.x, game.exit.y, 22, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- Player: a faint self-glow (you always know where *you* are) ---
  const pl = game.player;
  const breath = 1 + Math.sin(now * 2.2) * 0.08;
  const glow = ctx.createRadialGradient(pl.x, pl.y, 0, pl.x, pl.y, 36);
  glow.addColorStop(0, 'rgba(200, 230, 255, 0.10)');
  glow.addColorStop(1, 'rgba(200, 230, 255, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(pl.x, pl.y, 36, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COLORS.player;
  ctx.beginPath();
  ctx.arc(pl.x, pl.y, pl.r * breath, 0, Math.PI * 2);
  ctx.fill();

  // Ping cooldown: a thin recharge arc around the player.
  if (pl.cooldown > 0) {
    const frac = 1 - pl.cooldown / PING_COOLDOWN;
    ctx.strokeStyle = 'rgba(200, 230, 255, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(pl.x, pl.y, pl.r + 6, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';

  // --- Screen-space overlays ---

  // Permanent soft vignette + red heartbeat pulse.
  const vg = ctx.createRadialGradient(
    viewW / 2, viewH / 2, Math.min(viewW, viewH) * 0.3,
    viewW / 2, viewH / 2, Math.max(viewW, viewH) * 0.7);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, viewW, viewH);

  if (game.pulse > 0) {
    const rg = ctx.createRadialGradient(
      viewW / 2, viewH / 2, Math.min(viewW, viewH) * 0.25,
      viewW / 2, viewH / 2, Math.max(viewW, viewH) * 0.7);
    rg.addColorStop(0, 'rgba(120,0,0,0)');
    rg.addColorStop(1, 'rgba(120,0,0,' + game.pulse * 0.5 + ')');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, viewW, viewH);
  }

  // Death flash + message.
  if (game.state === 'dead') {
    const a = Math.max(0, 0.6 - game.stateT * 0.5);
    ctx.fillStyle = 'rgba(150, 20, 20, ' + a + ')';
    ctx.fillRect(0, 0, viewW, viewH);
    ctx.fillStyle = 'rgba(255, 200, 200, 0.9)';
    ctx.font = '28px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Ti ha trovato.', viewW / 2, viewH / 2);
  }

  if (game.state === 'clear') {
    ctx.fillStyle = 'rgba(255, 220, 150, ' + Math.min(1, game.stateT * 2) + ')';
    ctx.font = '28px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Hai trovato l’uscita.', viewW / 2, viewH / 2);
  }

  // HUD.
  ctx.fillStyle = 'rgba(180, 210, 235, 0.55)';
  ctx.font = '14px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Livello ' + (game.level + 1) + '/' + LEVELS.length, 16, 26);
  if (game.deaths > 0) ctx.fillText('Morti: ' + game.deaths, 16, 46);

  // Level hint, fading out after a few seconds.
  const hintAlpha = clamp(1 - (game.hintT - 5) / 2, 0, 1);
  if (hintAlpha > 0 && game.state === 'playing') {
    ctx.fillStyle = 'rgba(180, 210, 235, ' + hintAlpha * 0.7 + ')';
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(LEVELS[game.level].hint, viewW / 2, viewH - 40);
  }

  // R pressed once: ask for confirmation before wiping the level.
  if (game.state === 'playing' && now < game.rArmedUntil) {
    ctx.fillStyle = 'rgba(255, 210, 120, 0.85)';
    ctx.font = '15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Premi ancora R per rigenerare la caverna (perderai la mappa)',
      viewW / 2, viewH - 66);
  }
}

// Decorative expanding rings for the title screen.
const titleRings = [0, 0.25, 0.5, 0.75];

function renderTitle(now) {
  const cx = viewW / 2, cy = viewH / 2 - 40;
  ctx.globalCompositeOperation = 'lighter';
  for (const phase of titleRings) {
    const t = (now * 0.22 + phase) % 1;
    const r = t * Math.min(viewW, viewH) * 0.45;
    ctx.strokeStyle = COLORS.wall + (0.35 * (1 - t)) + ')';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';

  ctx.textAlign = 'center';
  ctx.fillStyle = '#e8f6ff';
  ctx.font = '300 64px system-ui, sans-serif';
  ctx.fillText('E C O', cx, cy);
  ctx.fillStyle = 'rgba(180, 210, 235, 0.7)';
  ctx.font = '16px system-ui, sans-serif';
  ctx.fillText('un gioco di ecolocalizzazione', cx, cy + 40);
  ctx.font = '15px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(180, 210, 235, 0.55)';
  ctx.fillText('WASD / frecce per muoverti · SPAZIO per il ping', cx, cy + 100);
  ctx.fillText('Trova l’uscita. Ascolta gli echi.', cx, cy + 126);
  ctx.fillStyle = 'rgba(255, 120, 120, 0.5)';
  ctx.fillText('Qualcosa, nel buio, ascolta te.', cx, cy + 152);
  const blink = 0.4 + 0.3 * Math.sin(now * 3);
  ctx.fillStyle = 'rgba(232, 246, 255, ' + blink + ')';
  ctx.fillText('premi un tasto per iniziare', cx, cy + 210);
}

function renderWon() {
  const cx = viewW / 2, cy = viewH / 2;
  const mins = Math.floor(game.time / 60);
  const secs = Math.floor(game.time % 60);
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.exit + '0.95)';
  ctx.font = '300 44px system-ui, sans-serif';
  ctx.fillText('Fuori dal buio.', cx, cy - 40);
  ctx.fillStyle = 'rgba(180, 210, 235, 0.7)';
  ctx.font = '17px system-ui, sans-serif';
  ctx.fillText('Tempo: ' + mins + ':' + String(secs).padStart(2, '0') +
    ' · Morti: ' + game.deaths, cx, cy + 10);
  ctx.fillStyle = 'rgba(232, 246, 255, 0.6)';
  ctx.fillText('premi R per ricominciare', cx, cy + 60);
}

// ============================================================================
// Input & main loop
// ============================================================================

// Normalize a keyboard event to a KeyboardEvent.code-style name, falling back
// to e.key for browsers/synthetic events that don't populate e.code.
const KEY_ALIASES = {
  ' ': 'Space', 'Spacebar': 'Space',
  'w': 'KeyW', 'a': 'KeyA', 's': 'KeyS', 'd': 'KeyD', 'r': 'KeyR',
  'W': 'KeyW', 'A': 'KeyA', 'S': 'KeyS', 'D': 'KeyD', 'R': 'KeyR',
  'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown',
  'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight',
};
const keyCode = (e) => e.code || KEY_ALIASES[e.key] || '';

window.addEventListener('keydown', (e) => {
  // Never fight browser/OS chords (Cmd/Ctrl/Alt combos). macOS also swallows
  // the keyup of a key released while Cmd is held, which would strand it in
  // the pressed set forever.
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const code = keyCode(e);
  const isModifier = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key);

  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) {
    e.preventDefault();
  }
  AudioSys.ensure();

  // Track held keys in every state, so a key pressed during the death or
  // level-clear pause moves you the instant play resumes.
  if (!isModifier) keys.add(code);

  if (game.state === 'title') {
    if (isModifier || e.repeat) return;
    game.deaths = 0;
    game.time = 0;
    startLevel(0);
    return;
  }
  if (game.state === 'won') {
    if (code === 'KeyR' && !e.repeat) setState('title');
    return;
  }
  if (game.state !== 'playing') return;

  if (code === 'Space' && !e.repeat && game.player.cooldown <= 0) {
    game.player.cooldown = PING_COOLDOWN;
    emitPing(game.player.x, game.player.y);
  }
  // R regenerates the current level — it wipes the memorized map, so it asks
  // for a confirming second press.
  if (code === 'KeyR' && !e.repeat) {
    const t = performance.now() / 1000;
    if (t < game.rArmedUntil) startLevel(game.level);
    else game.rArmedUntil = t + 1.5;
  }
});

window.addEventListener('keyup', (e) => {
  // Releasing a modifier may have eaten other keyups (macOS Cmd behavior):
  // reset the whole set to be safe.
  if (e.key === 'Meta' || e.key === 'Control') keys.clear();
  keys.delete(keyCode(e));
});
window.addEventListener('blur', () => keys.clear());

let lastTs = 0;
function frame(ts) {
  // Dragging the window between displays changes devicePixelRatio without
  // firing a resize event; re-apply the backing-store scale when it drifts.
  if ((window.devicePixelRatio || 1) !== appliedDpr) resize();
  const now = ts / 1000;
  const dt = Math.min(0.05, lastTs ? now - lastTs : 0.016);
  lastTs = now;
  update(dt, performance.now() / 1000);
  render(performance.now() / 1000);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
