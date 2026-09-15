const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* =========================================================
   GAME SETTINGS
========================================================= */

const MAP_LIMIT = 48;

const PLAYER_MAX_HP = 100;
const PLAYER_DAMAGE = 10;

const BOT_COUNT = 5;
const BOT_MAX_HP = 20;
const BOT_DAMAGE = 10;

const BOT_ATTACK_RANGE = 2.4;
const BOT_ATTACK_INTERVAL = 2000;

const GAME_TIME = 10 * 60 * 1000;
const PLAYER_RESPAWN_TIME = 2500;
const BOT_RESPAWN_TIME = 3000;

const PLAYER_REGEN_INTERVAL = 10000;
const PLAYER_REGEN_AMOUNT = 5;

/* =========================================================
   WORLD COLLISION DATA
   Client and server use the same basic collision layout.
========================================================= */

const BOXES = [
  { x: 0, z: 0, w: 10, d: 2.5 },
  { x: -18, z: -8, w: 3, d: 15 },
  { x: 18, z: -8, w: 3, d: 15 },

  { x: -18, z: 12, w: 14, d: 3 },
  { x: 18, z: 12, w: 14, d: 3 },

  { x: -10, z: -25, w: 18, d: 3 },
  { x: 12, z: -25, w: 12, d: 3 },

  { x: -28, z: 25, w: 16, d: 3 },
  { x: 25, z: 25, w: 16, d: 3 },

  { x: -32, z: -2, w: 3, d: 12 },
  { x: 32, z: 4, w: 3, d: 18 }
];

const TREES = [
  { x: -35, z: -35, r: 1.6 },
  { x: -25, z: -30, r: 1.5 },
  { x: -14, z: -38, r: 1.7 },
  { x: 0, z: -35, r: 1.6 },
  { x: 15, z: -37, r: 1.7 },
  { x: 28, z: -32, r: 1.5 },
  { x: 38, z: -22, r: 1.6 },

  { x: -38, z: -12, r: 1.5 },
  { x: 38, z: -8, r: 1.5 },

  { x: -38, z: 12, r: 1.7 },
  { x: 38, z: 15, r: 1.7 },

  { x: -35, z: 35, r: 1.6 },
  { x: -20, z: 38, r: 1.5 },
  { x: -5, z: 34, r: 1.7 },
  { x: 10, z: 38, r: 1.5 },
  { x: 25, z: 35, r: 1.6 },
  { x: 38, z: 34, r: 1.5 }
];

/* =========================================================
   ROOMS
========================================================= */

const rooms = new Map();

function makeRoomCode() {
  let code;

  do {
    code = Math.random()
      .toString(36)
      .substring(2, 7)
      .toUpperCase();
  } while (rooms.has(code));

  return code;
}

/* =========================================================
   HELPERS
========================================================= */

function distance(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;

  return Math.sqrt(dx * dx + dz * dz);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomSpawn() {
  for (let i = 0; i < 100; i++) {
    const p = {
      x: Math.random() * 80 - 40,
      z: Math.random() * 80 - 40
    };

    if (!isBlocked(p.x, p.z, 0.9)) {
      return p;
    }
  }

  return {
    x: 0,
    z: 20
  };
}

/* =========================================================
   COLLISION
   Based on the obstacle collision concept used in Shooter 701.
========================================================= */

function circleIntersectsBox(px, pz, radius, box) {
  const closestX = clamp(px, box.x - box.w / 2, box.x + box.w / 2);
  const closestZ = clamp(pz, box.z - box.d / 2, box.z + box.d / 2);

  const dx = px - closestX;
  const dz = pz - closestZ;

  return dx * dx + dz * dz < radius * radius;
}

function circleIntersectsTree(px, pz, radius, tree) {
  const dx = px - tree.x;
  const dz = pz - tree.z;

  const r = radius + tree.r;

  return dx * dx + dz * dz < r * r;
}

function isBlocked(x, z, radius = 0.6) {
  if (
    x < -MAP_LIMIT + radius ||
    x > MAP_LIMIT - radius ||
    z < -MAP_LIMIT + radius ||
    z > MAP_LIMIT - radius
  ) {
    return true;
  }

  for (const box of BOXES) {
    if (circleIntersectsBox(x, z, radius, box)) {
      return true;
    }
  }

  for (const tree of TREES) {
    if (circleIntersectsTree(x, z, radius, tree)) {
      return true;
    }
  }

  return false;
}

/* =========================================================
   LINE OF SIGHT
   Used to stop bullets from passing through walls and trees.
========================================================= */

function segmentIntersectsBox(ax, az, bx, bz, box) {
  const minX = box.x - box.w / 2;
  const maxX = box.x + box.w / 2;
  const minZ = box.z - box.d / 2;
  const maxZ = box.z + box.d / 2;

  const dx = bx - ax;
  const dz = bz - az;

  let tmin = 0;
  let tmax = 1;

  if (Math.abs(dx) < 0.000001) {
    if (ax < minX || ax > maxX) {
      return false;
    }
  } else {
    const tx1 = (minX - ax) / dx;
    const tx2 = (maxX - ax) / dx;

    const low = Math.min(tx1, tx2);
    const high = Math.max(tx1, tx2);

    tmin = Math.max(tmin, low);
    tmax = Math.min(tmax, high);

    if (tmin > tmax) {
      return false;
    }
  }

  if (Math.abs(dz) < 0.000001) {
    if (az < minZ || az > maxZ) {
      return false;
    }
  } else {
    const tz1 = (minZ - az) / dz;
    const tz2 = (maxZ - az) / dz;

    const low = Math.min(tz1, tz2);
    const high = Math.max(tz1, tz2);

    tmin = Math.max(tmin, low);
    tmax = Math.min(tmax, high);

    if (tmin > tmax) {
      return false;
    }
  }

  return true;
}

function segmentIntersectsCircle(ax, az, bx, bz, circle) {
  const dx = bx - ax;
  const dz = bz - az;

  const lengthSq = dx * dx + dz * dz;

  if (lengthSq < 0.000001) {
    const cx = ax - circle.x;
    const cz = az - circle.z;

    return cx * cx + cz * cz <= circle.r * circle.r;
  }

  let t =
    ((circle.x - ax) * dx +
      (circle.z - az) * dz) /
    lengthSq;

  t = clamp(t, 0, 1);

  const closestX = ax + dx * t;
  const closestZ = az + dz * t;

  const distX = closestX - circle.x;
  const distZ = closestZ - circle.z;

  return (
    distX * distX +
    distZ * distZ <= circle.r * circle.r
  );
}

function lineBlocked(a, b) {
  for (const box of BOXES) {
    if (
      segmentIntersectsBox(
        a.x,
        a.z,
        b.x,
        b.z,
        box
      )
    ) {
      return true;
    }
  }

  for (const tree of TREES) {
    if (
      segmentIntersectsCircle(
        a.x,
        a.z,
        b.x,
        b.z,
        tree
      )
    ) {
      return true;
    }
  }

  return false;
}

/* =========================================================
   ROOM STATE
========================================================= */

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    x: player.x,
    y: player.y,
    z: player.z,
    rotationY: player.rotationY,
    hp: player.hp,
    maxHp: PLAYER_MAX_HP,
    kills: player.kills,
    dead: player.dead,
    host: player.host
  };
}

function publicBot(bot) {
  return {
    id: bot.id,
    x: bot.x,
    y: 0,
    z: bot.z,
    rotationY: bot.rotationY,
    hp: bot.hp,
    maxHp: BOT_MAX_HP,
    dead: bot.dead
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit("roomState", {
    code: room.code,
    hostId: room.hostId,
    players: [...room.players.values()].map(publicPlayer),
    bots: room.bots.map(publicBot),
    gameStarted: room.gameStarted
  });
}

/* =========================================================
   BOT CREATION
========================================================= */

let botCounter = 0;

function createBot() {
  const p = randomSpawn();

  return {
    id: "bot_" + (++botCounter),
    x: p.x,
    y: 0,
    z: p.z,
    rotationY: 0,

    hp: BOT_MAX_HP,
    dead: false,

    targetId: null,
    attackTimer: 0,

    speed: 1.2 + Math.random() * 0.5,

    wanderX: Math.random() * 2 - 1,
    wanderZ: Math.random() * 2 - 1,
    wanderTimer: 0,

    walkCycle: Math.random() * Math.PI * 2
  };
}

function createBots(room) {
  room.bots = [];

  for (let i = 0; i < BOT_COUNT; i++) {
    room.bots.push(createBot());
  }
}

/* =========================================================
   BOT TARGET
========================================================= */

function findNearestPlayer(room, bot) {
  let nearest = null;
  let nearestDistance = Infinity;

  for (const player of room.players.values()) {
    if (player.dead) continue;

    const d = distance(bot, player);

    if (d < nearestDistance && d < 35) {
      const from = {
        x: bot.x,
        z: bot.z
      };

      const to = {
        x: player.x,
        z: player.z
      };

      if (!lineBlocked(from, to)) {
        nearest = player;
        nearestDistance = d;
      }
    }
  }

  return nearest;
}

/* =========================================================
   BOT MOVEMENT
   Same idea as Shooter 701:
   probe ahead, stop at solid geometry, then try another direction.
========================================================= */

function tryBotMove(bot, dx, dz, amount) {
  const len = Math.sqrt(dx * dx + dz * dz);

  if (len < 0.0001) {
    return false;
  }

  dx /= len;
  dz /= len;

  const nextX = bot.x + dx * amount;
  const nextZ = bot.z + dz * amount;

  if (isBlocked(nextX, nextZ, 0.7)) {
    return false;
  }

  bot.x = nextX;
  bot.z = nextZ;

  bot.rotationY = Math.atan2(dx, dz);

  bot.walkCycle += 0.35;

  return true;
}

function updateBot(room, bot, dt) {
  if (bot.dead) return;

  const target = findNearestPlayer(room, bot);

  bot.targetId = target ? target.id : null;

  let dx = 0;
  let dz = 0;

  if (target) {
    dx = target.x - bot.x;
    dz = target.z - bot.z;

    const d = Math.sqrt(dx * dx + dz * dz);

    if (d > BOT_ATTACK_RANGE + 0.4) {
      const moved = tryBotMove(
        bot,
        dx,
        dz,
        bot.speed * dt
      );

      if (!moved) {
        // Sidestep around obstacle.
        const sideX = -dz;
        const sideZ = dx;

        if (
          !tryBotMove(
            bot,
            sideX,
            sideZ,
            bot.speed * dt
          )
        ) {
          tryBotMove(
            bot,
            -sideX,
            -sideZ,
            bot.speed * dt
          );
        }
      }
    }

    bot.attackTimer -= dt * 1000;

    if (
      d <= BOT_ATTACK_RANGE &&
      bot.attackTimer <= 0
    ) {
      const from = {
        x: bot.x,
        z: bot.z
      };

      const to = {
        x: target.x,
        z: target.z
      };

      if (!lineBlocked(from, to)) {
        bot.attackTimer = BOT_ATTACK_INTERVAL;

        target.hp = Math.max(
          0,
          target.hp - BOT_DAMAGE
        );

        io.to(room.code).emit("botShot", {
          botId: bot.id,
          start: {
            x: bot.x,
            y: 1.5,
            z: bot.z
          },
          end: {
            x: target.x,
            y: 1.4,
            z: target.z
          }
        });

        if (target.hp <= 0) {
          killPlayer(room, target, bot.id);
        }
      }
    }
  } else {
    // Wander when there is no visible player.
    bot.wanderTimer -= dt;

    if (bot.wanderTimer <= 0) {
      const angle = Math.random() * Math.PI * 2;

      bot.wanderX = Math.sin(angle);
      bot.wanderZ = Math.cos(angle);

      bot.wanderTimer =
        1500 + Math.random() * 3000;
    }

    if (
      !tryBotMove(
        bot,
        bot.wanderX,
        bot.wanderZ,
        bot.speed * dt * 0.55
      )
    ) {
      bot.wanderTimer = 0;
    }
  }
}

/* =========================================================
   PLAYER KILL / RESPAWN
========================================================= */

function killPlayer(room, player, killerId) {
  if (player.dead) return;

  player.dead = true;
  player.hp = 0;

  if (killerId && room.players.has(killerId)) {
    const killer = room.players.get(killerId);

    if (!killer.dead) {
      killer.kills++;
    }
  }

  io.to(room.code).emit("playerKilled", {
    victimId: player.id,
    killerId
  });

  setTimeout(() => {
    if (!room.players.has(player.id)) {
      return;
    }

    const spawn = randomSpawn();

    player.x = spawn.x;
    player.z = spawn.z;
    player.y = 1.8;

    player.hp = PLAYER_MAX_HP;
    player.dead = false;

    io.to(room.code).emit("playerRespawn", {
      id: player.id,
      x: player.x,
      y: player.y,
      z: player.z,
      hp: player.hp
    });

    broadcastRoom(room);
  }, PLAYER_RESPAWN_TIME);
}

/* =========================================================
   BOT DEATH / RESPAWN
========================================================= */

function killBot(room, bot, killerId) {
  if (bot.dead) return;

  bot.dead = true;
  bot.hp = 0;

  if (killerId && room.players.has(killerId)) {
    const killer = room.players.get(killerId);

    if (!killer.dead) {
      killer.kills++;
    }
  }

  io.to(room.code).emit("botKilled", {
    botId: bot.id,
    killerId
  });

  setTimeout(() => {
    if (!rooms.has(room.code)) {
      return;
    }

    const spawn = randomSpawn();

    bot.x = spawn.x;
    bot.z = spawn.z;
    bot.hp = BOT_MAX_HP;
    bot.dead = false;
    bot.targetId = null;
    bot.attackTimer = 0;

    io.to(room.code).emit("botRespawn", publicBot(bot));

    broadcastRoom(room);
  }, BOT_RESPAWN_TIME);
}

/* =========================================================
   PLAYER SHOOTING
   Server validates obstacle collision and target.
========================================================= */

function handlePlayerShoot(room, shooter, data) {
  if (!room.gameStarted) return;
  if (!shooter || shooter.dead) return;

  if (!data || !data.direction) return;

  const dx = Number(data.direction.x);
  const dy = Number(data.direction.y || 0);
  const dz = Number(data.direction.z);

  if (
    !Number.isFinite(dx) ||
    !Number.isFinite(dy) ||
    !Number.isFinite(dz)
  ) {
    return;
  }

  const length =
    Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (length < 0.0001) return;

  const dir = {
    x: dx / length,
    y: dy / length,
    z: dz / length
  };

  const start = {
    x: shooter.x,
    y: 1.55,
    z: shooter.z
  };

  const MAX_DISTANCE = 120;

  let target = null;
  let targetDistance = MAX_DISTANCE;

  // Check players.
  for (const player of room.players.values()) {
    if (player.id === shooter.id) continue;
    if (player.dead) continue;

    const vx = player.x - start.x;
    const vy = 1.4 - start.y;
    const vz = player.z - start.z;

    const along =
      vx * dir.x +
      vy * dir.y +
      vz * dir.z;

    if (along <= 0 || along >= targetDistance) {
      continue;
    }

    const closestX = start.x + dir.x * along;
    const closestY = start.y + dir.y * along;
    const closestZ = start.z + dir.z * along;

    const offX = player.x - closestX;
    const offY = 1.4 - closestY;
    const offZ = player.z - closestZ;

    const radius = 0.8;

    if (
      offX * offX +
        offY * offY +
        offZ * offZ <=
      radius * radius
    ) {
      const end = {
        x: player.x,
        z: player.z
      };

      if (
        !lineBlocked(
          {
            x: start.x,
            z: start.z
          },
          end
        )
      ) {
        target = player;
        targetDistance = along;
      }
    }
  }

  // Check bots.
  for (const bot of room.bots) {
    if (bot.dead) continue;

    const vx = bot.x - start.x;
    const vy = 1.2 - start.y;
    const vz = bot.z - start.z;

    const along =
      vx * dir.x +
      vy * dir.y +
      vz * dir.z;

    if (along <= 0 || along >= targetDistance) {
      continue;
    }

    const closestX = start.x + dir.x * along;
    const closestY = start.y + dir.y * along;
    const closestZ = start.z + dir.z * along;

    const offX = bot.x - closestX;
    const offY = 1.2 - closestY;
    const offZ = bot.z - closestZ;

    const radius = 0.8;

    if (
      offX * offX +
        offY * offY +
        offZ * offZ <=
      radius * radius
    ) {
      if (
        !lineBlocked(
          {
            x: start.x,
            z: start.z
          },
          {
            x: bot.x,
            z: bot.z
          }
        )
      ) {
        target = bot;
        targetDistance = along;
      }
    }
  }

  const end = {
    x: start.x + dir.x * targetDistance,
    y: start.y + dir.y * targetDistance,
    z: start.z + dir.z * targetDistance
  };

  io.to(room.code).emit("shot", {
    shooterId: shooter.id,
    start,
    end
  });

  if (!target) {
    return;
  }

  if (target.id && target.id.startsWith("bot_")) {
    target.hp = Math.max(
      0,
      target.hp - PLAYER_DAMAGE
    );

    io.to(room.code).emit("botHit", {
      botId: target.id,
      hp: target.hp,
      shooterId: shooter.id
    });

    if (target.hp <= 0) {
      killBot(room, target, shooter.id);
    }
  } else {
    target.hp = Math.max(
      0,
      target.hp - PLAYER_DAMAGE
    );

    io.to(room.code).emit("playerHit", {
      playerId: target.id,
      hp: target.hp,
      shooterId: shooter.id
    });

    if (target.hp <= 0) {
      killPlayer(room, target, shooter.id);
    }
  }

  broadcastRoom(room);
}

/* =========================================================
   GAME LOOP
========================================================= */

function startRoomGame(room) {
  if (room.gameStarted) return;

  room.gameStarted = true;
  room.startTime = Date.now();

  for (const player of room.players.values()) {
    const p = randomSpawn();

    player.x = p.x;
    player.y = 1.8;
    player.z = p.z;

    player.hp = PLAYER_MAX_HP;
    player.kills = 0;
    player.dead = false;
  }

  createBots(room);

  io.to(room.code).emit("gameStarted", {
    duration: GAME_TIME
  });

  broadcastRoom(room);

  room.gameTimer = setTimeout(() => {
    endRoomGame(room);
  }, GAME_TIME);
}

function endRoomGame(room) {
  if (!room.gameStarted) return;

  room.gameStarted = false;

  if (room.gameTimer) {
    clearTimeout(room.gameTimer);
    room.gameTimer = null;
  }

  let winner = null;

  for (const player of room.players.values()) {
    if (
      !winner ||
      player.kills > winner.kills
    ) {
      winner = player;
    }
  }

  io.to(room.code).emit("gameOver", {
    winner: winner
      ? {
          id: winner.id,
          name: winner.name,
          kills: winner.kills
        }
      : null
  });

  broadcastRoom(room);
}

/* =========================================================
   SOCKET.IO
========================================================= */

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  socket.on("createRoom", data => {
    const name =
      String(data?.name || "Player")
        .trim()
        .substring(0, 20);

    const code = makeRoomCode();

    const room = {
      code,
      hostId: socket.id,

      players: new Map(),
      bots: [],

      gameStarted: false,
      startTime: 0,
      gameTimer: null,
      loopTimer: null
    };

    room.players.set(socket.id, {
      id: socket.id,
      name,

      x: 0,
      y: 1.8,
      z: 20,

      rotationY: Math.PI,

      hp: PLAYER_MAX_HP,
      kills: 0,

      dead: false,
      host: true,

      regenTimer: PLAYER_REGEN_INTERVAL
    });

    rooms.set(code, room);

    socket.join(code);
    socket.data.roomCode = code;

    socket.emit("roomCreated", {
      code
    });

    broadcastRoom(room);
  });

  socket.on("joinRoom", data => {
    const name =
      String(data?.name || "Player")
        .trim()
        .substring(0, 20);

    const code =
      String(data?.code || "")
        .trim()
        .toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      socket.emit("roomError", {
        message: "اتاق پیدا نشد"
      });

      return;
    }

    if (room.gameStarted) {
      socket.emit("roomError", {
        message: "بازی این اتاق شروع شده است"
      });

      return;
    }

    if (room.players.size >= 16) {
      socket.emit("roomError", {
        message: "اتاق پر است"
      });

      return;
    }

    room.players.set(socket.id, {
      id: socket.id,
      name,

      x: 0,
      y: 1.8,
      z: 20,

      rotationY: Math.PI,

      hp: PLAYER_MAX_HP,
      kills: 0,

      dead: false,
      host: false,

      regenTimer: PLAYER_REGEN_INTERVAL
    });

    socket.join(code);
    socket.data.roomCode = code;

    socket.emit("roomJoined", {
      code
    });

    broadcastRoom(room);
  });

  socket.on("startGame", () => {
    const code = socket.data.roomCode;

    if (!code) return;

    const room = rooms.get(code);

    if (!room) return;

    if (room.hostId !== socket.id) {
      return;
    }

    if (room.players.size < 1) {
      return;
    }

    startRoomGame(room);
  });

  socket.on("playerUpdate", data => {
    const code = socket.data.roomCode;

    if (!code) return;

    const room = rooms.get(code);

    if (!room || !room.gameStarted) return;

    const player = room.players.get(socket.id);

    if (!player || player.dead) return;

    const x = Number(data?.x);
    const y = Number(data?.y);
    const z = Number(data?.z);
    const rotationY =
      Number(data?.rotationY);

    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z)
    ) {
      return;
    }

    // Prevent clients from teleporting through obstacles.
    const oldPosition = {
      x: player.x,
      z: player.z
    };

    const newPosition = {
      x: clamp(x, -MAP_LIMIT, MAP_LIMIT),
      z: clamp(z, -MAP_LIMIT, MAP_LIMIT)
    };

    const movementDistance =
      distance(oldPosition, newPosition);

    // Normal player movement per update should be small.
    if (movementDistance > 2.5) {
      return;
    }

    if (
      !isBlocked(
        newPosition.x,
        newPosition.z,
        0.55
      )
    ) {
      player.x = newPosition.x;
      player.z = newPosition.z;
    }

    player.y = clamp(y, 0.5, 5);

    if (Number.isFinite(rotationY)) {
      player.rotationY = rotationY;
    }

    socket.to(code).emit("playerUpdate", {
      id: player.id,
      x: player.x,
      y: player.y,
      z: player.z,
      rotationY: player.rotationY,
      hp: player.hp,
      kills: player.kills,
      dead: player.dead
    });
  });

  socket.on("shoot", data => {
    const code = socket.data.roomCode;

    if (!code) return;

    const room = rooms.get(code);

    if (!room) return;

    const shooter = room.players.get(socket.id);

    if (!shooter) return;

    handlePlayerShoot(
      room,
      shooter,
      data
    );
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    const code = socket.data.roomCode;

    if (!code) return;

    const room = rooms.get(code);

    if (!room) return;

    room.players.delete(socket.id);

    if (room.hostId === socket.id) {
      const remaining = [
        ...room.players.values()
      ];

      if (remaining.length > 0) {
        const randomIndex =
          Math.floor(
            Math.random() * remaining.length
          );

        const newHost =
          remaining[randomIndex];

        room.hostId = newHost.id;

        for (const player of remaining) {
          player.host =
            player.id === newHost.id;
        }

        io.to(room.code).emit(
          "hostChanged",
          {
            hostId: newHost.id
          }
        );
      }
    }

    if (room.players.size === 0) {
      if (room.gameTimer) {
        clearTimeout(room.gameTimer);
      }

      rooms.delete(room.code);
      return;
    }

    broadcastRoom(room);
  });
});

/* =========================================================
   SERVER GAME LOOP
========================================================= */

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    if (!room.gameStarted) continue;

    const dt = 0.05;

    for (const player of room.players.values()) {
      if (player.dead) continue;

      if (
        !player.regenTimer ||
        player.regenTimer <= 0
      ) {
        if (player.hp < PLAYER_MAX_HP) {
          player.hp = Math.min(
            PLAYER_MAX_HP,
            player.hp + PLAYER_REGEN_AMOUNT
          );

          io.to(player.id).emit(
            "playerRegen",
            {
              hp: player.hp
            }
          );
        }

        player.regenTimer =
          PLAYER_REGEN_INTERVAL;
      } else {
        player.regenTimer -= 50;
      }
    }

    for (const bot of room.bots) {
      updateBot(room, bot, dt);
    }

    // Send synchronized bot/player state.
    io.to(room.code).emit(
      "worldUpdate",
      {
        players: [...room.players.values()]
          .map(publicPlayer),

        bots: room.bots.map(publicBot),

        remaining:
          Math.max(
            0,
            GAME_TIME -
              (now - room.startTime)
          )
      }
    );
  }
}, 50);

/* =========================================================
   START SERVER
========================================================= */

server.listen(PORT, () => {
  console.log(
    `Rolet server running on port ${PORT}`
  );
}); 
