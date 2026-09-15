const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, game: 'Battle 701' }));
app.use((_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
const GAME_MS = 10 * 60 * 1000;
const MAX_PLAYERS = 16;
const BOT_COUNT = 5;
const PLAYER_HP = 100;
const BOT_HP = 20;
const DAMAGE = 10;
const BOT_DAMAGE = 10;
const BOT_SPEED = 3.2;
const PLAYER_SPEED = 8.2;
const PLAYER_RUN_SPEED = 12.5;

const WORLD = { minX: -94, maxX: 94, minZ: -94, maxZ: 94 };

// This is the same style/layout as the first Battle/Rolet map:
// many houses, a cross-shaped road and a forest of trees.
const HOUSES = [];
for (let x = -80; x <= 80; x += 40) {
  for (let z = -80; z <= 80; z += 40) {
    if (Math.abs(x) < 45 && Math.abs(z) < 45) continue;
    HOUSES.push({ x, z, w: 18, d: 15 });
  }
}

// Fixed tree positions so client and server always agree on collision.
const TREES = [
  [-88,-86,1.0],[-64,-88,.9],[-40,-88,1.15],[40,-88,1.0],[64,-86,.9],[88,-88,1.05],
  [-88,-64,.85],[-70,-60,1.0],[70,-62,.9],[88,-60,1.05],
  [-90,-25,1.0],[-72,-18,.9],[72,-18,1.0],[90,-25,.9],
  [-90,25,.95],[-72,18,1.0],[72,18,.9],[90,28,1.05],
  [-88,60,1.05],[-70,64,.9],[70,62,1.0],[88,64,.9],
  [-88,88,1.0],[-64,86,.9],[-40,88,1.05],[40,88,1.0],[64,88,.9],[88,86,1.05],
  [-30,-86,.8],[30,-86,.85],[-30,86,.85],[30,86,.8]
].map(([x,z,s]) => ({ x, z, r: 2.65 * s }));

const SPAWNS = [
  [-84, -74], [84, -74], [-84, 74], [84, 74],
  [-58, -78], [58, -78], [-58, 78], [58, 78],
  [-78, 0], [78, 0], [0, -82], [0, 82],
  [-38, -72], [38, -72], [-38, 72], [38, 72]
];

const rooms = new Map();
const socketRoom = new Map();
let botSerial = 0;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function dist2(a, b) { const dx = a.x - b.x, dz = a.z - b.z; return dx * dx + dz * dz; }
function rand(a, b) { return a + Math.random() * (b - a); }
function roomOf(socket) { const c = socketRoom.get(socket.id); return c ? rooms.get(c) : null; }

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = '';
    for (let i = 0; i < 5; i++) c += chars[(Math.random() * chars.length) | 0];
  } while (rooms.has(c));
  return c;
}

function circleHitsHouse(p, r, h) {
  const cx = clamp(p.x, h.x - h.w / 2, h.x + h.w / 2);
  const cz = clamp(p.z, h.z - h.d / 2, h.z + h.d / 2);
  const dx = p.x - cx, dz = p.z - cz;
  return dx * dx + dz * dz < r * r;
}
function blocked(p, r = .65) {
  if (p.x < WORLD.minX + r || p.x > WORLD.maxX - r || p.z < WORLD.minZ + r || p.z > WORLD.maxZ - r) return true;
  // Roads are open. Houses are solid.
  for (const h of HOUSES) if (circleHitsHouse(p, r, h)) return true;
  for (const t of TREES) {
    const rr = r + t.r;
    if (dist2(p, t) < rr * rr) return true;
  }
  return false;
}
function segmentAABB(a, b, h, pad = 0) {
  const minX = h.x - h.w / 2 - pad, maxX = h.x + h.w / 2 + pad;
  const minZ = h.z - h.d / 2 - pad, maxZ = h.z + h.d / 2 + pad;
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [s, d, mn, mx] of [[a.x, dx, minX, maxX], [a.z, dz, minZ, maxZ]]) {
    if (Math.abs(d) < 1e-9) { if (s < mn || s > mx) return false; }
    else {
      let q0 = (mn - s) / d, q1 = (mx - s) / d;
      if (q0 > q1) [q0, q1] = [q1, q0];
      t0 = Math.max(t0, q0); t1 = Math.min(t1, q1);
      if (t0 > t1) return false;
    }
  }
  return true;
}
function segmentCircle(a, b, c, r) {
  const vx = b.x - a.x, vz = b.z - a.z;
  const wx = c.x - a.x, wz = c.z - a.z;
  const vv = vx * vx + vz * vz;
  const t = vv ? clamp((wx * vx + wz * vz) / vv, 0, 1) : 0;
  const dx = a.x + vx * t - c.x, dz = a.z + vz * t - c.z;
  return dx * dx + dz * dz <= r * r;
}
function lineBlocked(a, b, pad = .1) {
  for (const h of HOUSES) if (segmentAABB(a, b, h, pad)) return true;
  for (const t of TREES) if (segmentCircle(a, b, t, t.r + pad)) return true;
  return false;
}

function freeSpawn() {
  for (let i = 0; i < 500; i++) {
    const s = SPAWNS[(Math.random() * SPAWNS.length) | 0];
    const p = { x: s[0] + rand(-3, 3), z: s[1] + rand(-3, 3) };
    if (blocked(p, .9)) continue;
    let near = false;
    for (const room of rooms.values()) {
      for (const pl of room.players.values()) if (dist2(p, pl) < 10 * 10) near = true;
    }
    if (!near) return p;
  }
  return { x: 0, z: 0 };
}

function newPlayer(socket, name) {
  const p = { id: socket.id, name: String(name || 'بازیکن').trim().slice(0, 18) || 'بازیکن', x: 0, z: 0, rot: 0, hp: PLAYER_HP, kills: 0, dead: false, respawnAt: 0, lastShot: 0, lastInput: Date.now(), lastRegen: Date.now() };
  return p;
}
function newBot() {
  return { id: `bot-${++botSerial}`, name: `زامبی ${botSerial}`, x: 0, z: 0, rot: 0, hp: BOT_HP, dead: false, attackAt: 0, wanderAt: 0, wx: 0, wz: 0, phase: Math.random() * Math.PI * 2 };
}
function respawnPlayer(p) {
  const s = freeSpawn();
  p.x = s.x; p.z = s.z; p.rot = Math.random() * Math.PI * 2; p.hp = PLAYER_HP; p.dead = false; p.respawnAt = 0; p.lastRegen = Date.now();
}
function respawnBot(b) {
  const s = freeSpawn();
  b.x = s.x; b.z = s.z; b.rot = Math.random() * Math.PI * 2; b.hp = BOT_HP; b.dead = false; b.attackAt = Date.now() + 800; b.wanderAt = Date.now() + rand(700, 1800); b.wx = s.x; b.wz = s.z;
}
function makeRoom(socket, name) {
  const r = { code: makeCode(), hostId: socket.id, started: false, ending: false, startedAt: 0, endsAt: 0, players: new Map(), bots: [] };
  r.players.set(socket.id, newPlayer(socket, name));
  r.bots = Array.from({ length: BOT_COUNT }, newBot);
  r.bots.forEach(respawnBot);
  rooms.set(r.code, r); socketRoom.set(socket.id, r.code); socket.join(r.code);
  return r;
}
function publicRoom(r) {
  return {
    code: r.code,
    hostId: r.hostId,
    started: r.started,
    timeLeft: r.started ? Math.max(0, Math.ceil((r.endsAt - Date.now()) / 1000)) : 600,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, x: p.x, z: p.z, rot: p.rot, hp: p.hp, kills: p.kills, dead: p.dead, bot: false })),
    bots: r.bots.map(b => ({ id: b.id, name: b.name, x: b.x, z: b.z, rot: b.rot, hp: b.hp, dead: b.dead, bot: true, phase: b.phase }))
  };
}
function broadcast(r) { io.to(r.code).emit('roomState', publicRoom(r)); }
function chooseHost(r) { const first = r.players.values().next().value; r.hostId = first ? first.id : null; }
function moveEntity(e, dx, dz, radius) {
  const nx = { x: e.x + dx, z: e.z };
  if (!blocked(nx, radius)) e.x = nx.x;
  const nz = { x: e.x, z: e.z + dz };
  if (!blocked(nz, radius)) e.z = nz.z;
}
function rayCircle(o, dx, dz, c, r) {
  const ox = o.x - c.x, oz = o.z - c.z;
  const b = 2 * (ox * dx + oz * dz), cc = ox * ox + oz * oz - r * r, disc = b * b - 4 * cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc), t1 = (-b - s) / 2, t2 = (-b + s) / 2;
  if (t1 >= 0) return t1; if (t2 >= 0) return t2; return null;
}
function rayBox(o, dx, dz, h) {
  const minX = h.x - h.w / 2, maxX = h.x + h.w / 2, minZ = h.z - h.d / 2, maxZ = h.z + h.d / 2;
  let tmin = 0, tmax = Infinity;
  for (const [s, d, mn, mx] of [[o.x, dx, minX, maxX], [o.z, dz, minZ, maxZ]]) {
    if (Math.abs(d) < 1e-9) { if (s < mn || s > mx) return null; }
    else { let a = (mn - s) / d, c = (mx - s) / d; if (a > c) [a, c] = [c, a]; tmin = Math.max(tmin, a); tmax = Math.min(tmax, c); if (tmin > tmax) return null; }
  }
  return tmin >= 0 ? tmin : null;
}
function shotEnd(r, shooter, dx, dz) {
  const max = 120, origin = { x: shooter.x, z: shooter.z }, far = { x: origin.x + dx * max, z: origin.z + dz * max };
  let worldT = max;
  for (const h of HOUSES) { const t = rayBox(origin, dx, dz, h); if (t !== null) worldT = Math.min(worldT, t); }
  for (const t of TREES) { const q = rayCircle(origin, dx, dz, t, t.r); if (q !== null) worldT = Math.min(worldT, q); }
  let nearest = worldT, target = null;
  for (const p of r.players.values()) {
    if (p.id === shooter.id || p.dead) continue;
    const t = rayCircle(origin, dx, dz, { x: p.x, z: p.z }, .72);
    if (t !== null && t < nearest) { nearest = t; target = p; }
  }
  for (const b of r.bots) {
    if (b.dead) continue;
    const t = rayCircle(origin, dx, dz, { x: b.x, z: b.z }, .78);
    if (t !== null && t < nearest) { nearest = t; target = b; }
  }
  return { origin, end: { x: origin.x + dx * nearest, z: origin.z + dz * nearest }, target };
}
function killPlayer(r, killer, victim) {
  victim.hp = 0; victim.dead = true; victim.respawnAt = Date.now() + 1500; killer.kills++;
  io.to(victim.id).emit('youDied', { killer: killer.name });
  io.to(r.code).emit('killEvent', { killerId: killer.id, victimId: victim.id, killerName: killer.name, victimName: victim.name, killerKills: killer.kills });
}
function damagePlayer(r, killer, victim) {
  if (victim.dead) return;
  victim.hp = Math.max(0, victim.hp - DAMAGE);
  io.to(r.code).emit('hit', { targetId: victim.id, hp: victim.hp, shooterId: killer.id });
  if (victim.hp <= 0) killPlayer(r, killer, victim);
}
function damageBot(r, killer, bot) {
  if (bot.dead) return;
  bot.hp = Math.max(0, bot.hp - DAMAGE);
  io.to(r.code).emit('botHit', { targetId: bot.id, hp: bot.hp, shooterId: killer.id });
  if (bot.hp <= 0) {
    bot.dead = true; killer.kills++;
    io.to(r.code).emit('botKilled', { botId: bot.id, killerId: killer.id, killerKills: killer.kills });
    setTimeout(() => { if (rooms.has(r.code) && r.started && !r.ending) respawnBot(bot); }, 900);
  }
}

io.on('connection', socket => {
  socket.on('createRoom', ({ name } = {}) => {
    if (roomOf(socket)) return;
    const r = makeRoom(socket, name);
    socket.emit('joined', { code: r.code, host: true });
    broadcast(r);
  });

  socket.on('joinRoom', ({ name, roomCode } = {}) => {
    if (roomOf(socket)) return socket.emit('errorMessage', 'ابتدا از اتاق فعلی خارج شو.');
    const code = String(roomCode || '').trim().toUpperCase();
    const r = rooms.get(code);
    if (!r) return socket.emit('errorMessage', 'اتاقی با این کد پیدا نشد.');
    if (r.started) return socket.emit('errorMessage', 'بازی این اتاق شروع شده است.');
    if (r.players.size >= MAX_PLAYERS) return socket.emit('errorMessage', 'ظرفیت اتاق پر است.');
    r.players.set(socket.id, newPlayer(socket, name));
    socketRoom.set(socket.id, code); socket.join(code);
    socket.emit('joined', { code, host: r.hostId === socket.id });
    broadcast(r);
  });

  socket.on('startGame', () => {
    const r = roomOf(socket);
    if (!r || r.hostId !== socket.id || r.started || r.players.size < 1) return;
    r.started = true; r.ending = false; r.startedAt = Date.now(); r.endsAt = r.startedAt + GAME_MS;
    for (const p of r.players.values()) { p.kills = 0; p.dead = false; respawnPlayer(p); }
    r.bots.forEach(respawnBot);
    io.to(r.code).emit('gameStarted', publicRoom(r));
    broadcast(r);
  });

  socket.on('move', (data = {}) => {
    const r = roomOf(socket); if (!r || !r.started || r.ending) return;
    const p = r.players.get(socket.id); if (!p || p.dead) return;
    const now = Date.now();
    const dt = Math.min(.12, Math.max(.01, (now - p.lastInput) / 1000)); p.lastInput = now;
    let x = Number(data.x) || 0, z = Number(data.z) || 0;
    const len = Math.hypot(x, z); if (len > 1) { x /= len; z /= len; }
    const speed = (data.sprint ? PLAYER_RUN_SPEED : PLAYER_SPEED) * dt;
    moveEntity(p, x * speed, z * speed, .7);
    p.rot = Number.isFinite(Number(data.rot)) ? Number(data.rot) : p.rot;
  });

  socket.on('shoot', (data = {}) => {
    const r = roomOf(socket); if (!r || !r.started || r.ending) return;
    const shooter = r.players.get(socket.id); if (!shooter || shooter.dead) return;
    const now = Date.now(); if (now - shooter.lastShot < 140) return; shooter.lastShot = now;
    let dx = Number(data.dx), dz = Number(data.dz);
    const len = Math.hypot(dx, dz); if (!Number.isFinite(len) || len < .001) return;
    dx /= len; dz /= len;
    const result = shotEnd(r, shooter, dx, dz);
    if (result.target) {
      if (result.target.bot) damageBot(r, shooter, result.target); else damagePlayer(r, shooter, result.target);
    }
    io.to(r.code).emit('shotFx', { shooterId: shooter.id, origin: { x: result.origin.x, y: 1.55, z: result.origin.z }, end: { x: result.end.x, y: 1.55, z: result.end.z }, hitId: result.target?.id || null });
  });

  socket.on('leaveRoom', () => socket.disconnect(true));
  socket.on('disconnect', () => {
    const code = socketRoom.get(socket.id), r = code ? rooms.get(code) : null;
    socketRoom.delete(socket.id);
    if (!r) return;
    r.players.delete(socket.id);
    if (r.hostId === socket.id) chooseHost(r);
    if (r.players.size === 0) { rooms.delete(code); return; }
    broadcast(r);
  });
});

function botCanSeeTarget(bot, target) {
  return !lineBlocked({ x: bot.x, z: bot.z }, { x: target.x, z: target.z }, .15);
}
function updateBots(r, dt, now) {
  for (const b of r.bots) {
    if (b.dead) continue;
    let target = null, best = Infinity;
    for (const p of r.players.values()) {
      if (p.dead) continue;
      const d = dist2(b, p); if (d < best) { best = d; target = p; }
    }
    if (target && best < 42 * 42) {
      const d = Math.sqrt(best) || 1;
      const dx = (target.x - b.x) / d, dz = (target.z - b.z) / d;
      b.rot = Math.atan2(dx, dz);
      if (d > 2.7) {
        const before = { x: b.x, z: b.z };
        moveEntity(b, dx * BOT_SPEED * dt, dz * BOT_SPEED * dt, .75);
        if (before.x === b.x && before.z === b.z) moveEntity(b, -dz * BOT_SPEED * dt, dx * BOT_SPEED * dt, .75);
      } else if (now >= b.attackAt && botCanSeeTarget(b, target)) {
        b.attackAt = now + 2000;
        target.hp = Math.max(0, target.hp - BOT_DAMAGE);
        io.to(r.code).emit('botShot', { botId: b.id, origin: { x: b.x, y: 1.55, z: b.z }, end: { x: target.x, y: 1.55, z: target.z }, targetId: target.id });
        io.to(r.code).emit('hit', { targetId: target.id, hp: target.hp, shooterId: b.id });
        if (target.hp <= 0) { target.dead = true; target.respawnAt = now + 1500; io.to(target.id).emit('youDied', { killer: b.name }); }
      }
    } else {
      if (now >= b.wanderAt || Math.hypot(b.wx - b.x, b.wz - b.z) < 1.5) {
        const s = freeSpawn(); b.wx = s.x; b.wz = s.z; b.wanderAt = now + rand(1200, 3200);
      }
      const dx = b.wx - b.x, dz = b.wz - b.z, d = Math.hypot(dx, dz) || 1;
      b.rot = Math.atan2(dx, dz);
      moveEntity(b, dx / d * BOT_SPEED * .45 * dt, dz / d * BOT_SPEED * .45 * dt, .75);
    }
  }
}

function finish(r) {
  if (!r.started || r.ending) return;
  r.ending = true;
  const standings = [...r.players.values()].map(p => ({ id: p.id, name: p.name, kills: p.kills })).sort((a, b) => b.kills - a.kills);
  const winner = standings[0] || null;
  io.to(r.code).emit('gameOver', { winner, standings });
  setTimeout(() => {
    if (!rooms.has(r.code)) return;
    r.started = false; r.ending = false;
    for (const p of r.players.values()) { p.kills = 0; p.dead = false; p.hp = PLAYER_HP; }
    r.bots.forEach(respawnBot);
    broadcast(r);
  }, 5500);
}

setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (!r.started || r.ending) continue;
    if (now >= r.endsAt) { finish(r); continue; }
    for (const p of r.players.values()) {
      if (p.dead && p.respawnAt && now >= p.respawnAt) respawnPlayer(p);
      if (!p.dead && p.hp < PLAYER_HP && now - p.lastRegen >= 10000) { p.hp = Math.min(PLAYER_HP, p.hp + 5); p.lastRegen = now; }
    }
    updateBots(r, .05, now);
    broadcast(r);
  }
}, 50);

server.listen(PORT, () => console.log(`Battle 701 server listening on ${PORT}`));
