const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const GAME_SECONDS = 600;
const MAX_PLAYERS = 16;
const BOT_COUNT = 5;

const SPAWNS = [
  [-65,2,-65], [65,2,-65], [-65,2,65], [65,2,65],
  [0,2,-75], [0,2,75], [-75,2,0], [75,2,0],
  [-35,2,-75], [35,2,-75], [-35,2,75], [35,2,75],
  [-75,2,-35], [-75,2,35], [75,2,-35], [75,2,35]
];

const WORLD = { minX:-95, maxX:95, minZ:-95, maxZ:95 };

function code() {
  let c;
  do c = Math.random().toString(36).slice(2,7).toUpperCase();
  while (rooms.has(c));
  return c;
}
function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }
function dist(a,b){ return Math.hypot(a.x-b.x,a.z-b.z); }

function makeBot(i) {
  const p = SPAWNS[(i+4)%SPAWNS.length];
  return {
    id:`bot-${i}`, name:`زامبی ${i+1}`, bot:true,
    x:p[0], y:p[1], z:p[2], rot:0, hp:20, kills:0,
    target:null, attackAt:0, wanderAt:0, wx:p[0], wz:p[2],
    phase:Math.random()*Math.PI*2
  };
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    timeLeft: room.started ? Math.max(0, Math.ceil((room.endsAt-Date.now())/1000)) : GAME_SECONDS,
    players: [...room.players.values()].map(p=>({
      id:p.id,name:p.name,x:p.x,y:p.y,z:p.z,rot:p.rot,hp:p.hp,kills:p.kills,dead:p.dead,bot:false
    })),
    bots: room.bots.map(b=>({
      id:b.id,name:b.name,x:b.x,y:b.y,z:b.z,rot:b.rot,hp:b.hp,kills:b.kills,bot:true,phase:b.phase
    }))
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit("roomState", publicRoom(room));
}

function chooseHost(room) {
  const first = [...room.players.values()][0];
  room.hostId = first ? first.id : null;
}

function randomSpawn() {
  return SPAWNS[Math.floor(Math.random()*SPAWNS.length)];
}

function respawnPlayer(p) {
  const s = randomSpawn();
  p.x=s[0]; p.y=s[1]; p.z=s[2];
  p.hp=100; p.dead=false; p.kills=0; p.respawnAt=0;
}

function resetBot(b) {
  const s = randomSpawn();
  b.x=s[0]; b.y=s[1]; b.z=s[2];
  b.hp=20; b.target=null; b.attackAt=0;
}

function finish(room) {
  if (!room.started) return;
  room.started=false;
  room.finished=true;
  let all = [...room.players.values()].map(p=>({id:p.id,name:p.name,kills:p.kills}));
  all.sort((a,b)=>b.kills-a.kills);
  const winner = all[0] || null;
  io.to(room.code).emit("gameOver", { winner, standings: all });
  setTimeout(()=>{
    if (!rooms.has(room.code)) return;
    room.finished=false;
    room.bots.forEach(resetBot);
    room.players.forEach(p=>{ p.hp=100; p.dead=false; p.kills=0; respawnPlayer(p); });
    broadcastRoom(room);
  }, 6000);
}

io.on("connection", socket => {
  socket.on("createRoom", ({name}) => {
    name = String(name||"بازیکن").trim().slice(0,20) || "بازیکن";
    const c=code();
    const room={code:c,hostId:socket.id,started:false,finished:false,endsAt:0,players:new Map(),bots:Array.from({length:BOT_COUNT},(_,i)=>makeBot(i))};
    room.players.set(socket.id,{id:socket.id,name,x:0,y:2,z:0,rot:0,hp:100,kills:0,dead:false,respawnAt:0});
    rooms.set(c,room);
    socket.join(c); socket.data.room=c;
    socket.emit("joined",{code:c,host:true});
    broadcastRoom(room);
  });

  socket.on("joinRoom", ({name,roomCode}) => {
    name=String(name||"بازیکن").trim().slice(0,20)||"بازیکن";
    const c=String(roomCode||"").trim().toUpperCase();
    const room=rooms.get(c);
    if(!room) return socket.emit("errorMessage","اتاقی با این کد پیدا نشد.");
    if(room.started) return socket.emit("errorMessage","بازی این اتاق شروع شده است.");
    if(room.players.size>=MAX_PLAYERS) return socket.emit("errorMessage","ظرفیت اتاق پر است.");
    room.players.set(socket.id,{id:socket.id,name,x:0,y:2,z:0,rot:0,hp:100,kills:0,dead:false,respawnAt:0});
    socket.join(c); socket.data.room=c;
    socket.emit("joined",{code:c,host:false});
    broadcastRoom(room);
  });

  socket.on("startGame", () => {
    const room=rooms.get(socket.data.room);
    if(!room || room.hostId!==socket.id || room.started || room.players.size<1) return;
    room.started=true; room.finished=false; room.endsAt=Date.now()+GAME_SECONDS*1000;
    let i=0;
    room.players.forEach(p=>{ const s=SPAWNS[i++%SPAWNS.length]; p.x=s[0];p.y=s[1];p.z=s[2];p.hp=100;p.kills=0;p.dead=false; });
    room.bots.forEach((b,j)=>{const s=SPAWNS[(j+4)%SPAWNS.length];b.x=s[0];b.y=s[1];b.z=s[2];b.hp=20;b.kills=0;});
    io.to(room.code).emit("gameStarted", publicRoom(room));
    broadcastRoom(room);
  });

  socket.on("move", data => {
    const room=rooms.get(socket.data.room); if(!room||!room.started) return;
    const p=room.players.get(socket.id); if(!p||p.dead) return;
    p.x=clamp(Number(data.x)||0,WORLD.minX,WORLD.maxX);
    p.y=2; p.z=clamp(Number(data.z)||0,WORLD.minZ,WORLD.maxZ);
    p.rot=Number(data.rot)||0;
  });

  socket.on("shoot", ({targetId}) => {
    const room=rooms.get(socket.data.room); if(!room||!room.started) return;
    const shooter=room.players.get(socket.id); if(!shooter||shooter.dead) return;
    let target=room.players.get(targetId);
    let isBot=false;
    if(!target){ target=room.bots.find(b=>b.id===targetId); isBot=!!target; }
    if(!target || target.dead || target.hp<=0) return;
    target.hp-=10;
    if(target.hp<=0){
      shooter.kills++;
      if(isBot){
        target.hp=0;
        setTimeout(()=>{ if(rooms.has(room.code)) { resetBot(target); broadcastRoom(room); } }, 700);
      } else {
        target.dead=true; target.respawnAt=Date.now()+1500;
        io.to(target.id).emit("youDied",{killer:shooter.name});
      }
    }
    io.to(room.code).emit("hitConfirmed",{shooterId:socket.id,targetId:target.id});
    broadcastRoom(room);
  });

  socket.on("leaveRoom",()=>socket.disconnect(true));

  socket.on("disconnect",()=>{
    const c=socket.data.room, room=rooms.get(c); if(!room) return;
    room.players.delete(socket.id);
    if(room.hostId===socket.id) chooseHost(room);
    if(room.players.size===0){ rooms.delete(c); return; }
    broadcastRoom(room);
  });
});

setInterval(()=>{
  const now=Date.now();
  for(const room of rooms.values()){
    if(room.started){
      if(now>=room.endsAt){ finish(room); continue; }

      room.players.forEach(p=>{
        if(p.dead && p.respawnAt && now>=p.respawnAt) respawnPlayer(p);
        else if(!p.dead && p.hp<100 && now-p.lastRegen>=10000){
          p.hp=Math.min(100,p.hp+5); p.lastRegen=now;
        }
        if(p.lastRegen===undefined) p.lastRegen=now;
      });

      for(const bot of room.bots){
        if(bot.hp<=0) continue;
        let target=null, best=9999;
        for(const p of room.players.values()){
          if(p.dead) continue;
          const d=dist(bot,p);
          if(d<best){best=d;target=p;}
        }
        if(target && best<30){
          const dx=target.x-bot.x, dz=target.z-bot.z;
          const len=Math.hypot(dx,dz)||1;
          bot.rot=Math.atan2(dx,dz);
          if(best>2.4){
            bot.x=clamp(bot.x+dx/len*0.14,WORLD.minX,WORLD.maxX);
            bot.z=clamp(bot.z+dz/len*0.14,WORLD.minZ,WORLD.maxZ);
          } else if(now>=bot.attackAt){
            target.hp-=10; bot.attackAt=now+2000;
            if(target.hp<=0){
              target.dead=true; target.respawnAt=now+1500;
              io.to(target.id).emit("youDied",{killer:bot.name});
            }
          }
        } else {
          if(now>=bot.wanderAt){
            bot.wanderAt=now+2000;
            bot.wx=clamp(bot.x+(Math.random()-.5)*25,WORLD.minX+4,WORLD.maxX-4);
            bot.wz=clamp(bot.z+(Math.random()-.5)*25,WORLD.minZ+4,WORLD.maxZ-4);
          }
          const dx=bot.wx-bot.x,dz=bot.wz-bot.z,len=Math.hypot(dx,dz)||1;
          bot.rot=Math.atan2(dx,dz);
          bot.x=clamp(bot.x+dx/len*0.07,WORLD.minX,WORLD.maxX);
          bot.z=clamp(bot.z+dz/len*0.07,WORLD.minZ,WORLD.maxZ);
        }
      }
      broadcastRoom(room);
    }
  }
},100);

server.listen(PORT,()=>console.log(`Server running on ${PORT}`));
