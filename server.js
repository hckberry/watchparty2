"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const INDEX = fs.readFileSync(path.join(__dirname, "public", "index.html"));
/* Only these embed hosts can be played. Keep in sync with SERVERS in public/index.html. */
const ALLOWED_HOSTS = new Set(["vidsrc.to", "embedmaster.link", "vidlink.pro", "vidfast.pro", "www.2embed.cc", "vidnest.fun"]);

const server = http.createServer((req, res) => {
  const p = (req.url || "/").split("?")[0];
  if (p === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (p === "/" || p === "/index.html") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff"
    });
    return res.end(INDEX);
  }
  res.writeHead(404); res.end("Not found");
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });

/* code -> { host: ws|null, guests: Set<ws>, now: {url,name,meta,startedAt}|null,
             pos: {sec,at,playing}|null, token, hostTimer, guestsPick } */
const rooms = new Map();
const MAX_ROOMS = 1000, MAX_GUESTS = 30, HOST_GRACE_MS = 60000;

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const everyone = r => [r.host, ...r.guests].filter(Boolean);
const broadcast = (r, o, except) => everyone(r).forEach(w => { if (w !== except) send(w, o); });
const announce = r => broadcast(r, { t: "people", list: everyone(r).map(w => ({ name: w.name, host: w === r.host })) });
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, "").trim().slice(0, n);

function validUrl(u) {
  try { const x = new URL(u); return x.protocol === "https:" && ALLOWED_HOSTS.has(x.hostname); }
  catch (e) { return false; }
}
function cleanMeta(m) {
  if (!m || typeof m !== "object" || (m.kind !== "movie" && m.kind !== "series")) return null;
  const id = String(m.id || "");
  if (!/^tt\d{1,10}$/.test(id)) return null;
  return { kind: m.kind, id, s: Math.min(parseInt(m.s, 10) || 0, 999), e: Math.min(parseInt(m.e, 10) || 0, 9999) };
}

/* The room clock: where the show should be right now.
   exact = the host's player reported its real position recently; otherwise it is an estimate. */
function roomPos(r) {
  if (!r.now) return null;
  let sec, exact = false, playing = true;
  if (r.pos) {
    const age = Date.now() - r.pos.at;
    playing = r.pos.playing;
    sec = r.pos.sec + (playing ? age / 1000 : 0);
    exact = !(playing && age > 15000);
  } else sec = (Date.now() - r.now.startedAt) / 1000;
  return { url: r.now.url, name: r.now.name, meta: r.now.meta, sec: Math.max(0, Math.round(sec)), exact, playing };
}

function closeRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimeout(room.hostTimer);
  room.guests.forEach(g => { send(g, { t: "closed" }); g.room = null; });
  rooms.delete(code);
}

function genCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    let c = "";
    for (let i = 0; i < 6; i++) c += A[Math.floor(Math.random() * A.length)];
    if (!rooms.has(c)) return c;
  }
}

wss.on("connection", ws => {
  ws.isAlive = true;
  ws.room = null; ws.name = "Guest"; ws.isHost = false; ws.cid = "";
  ws.hits = 0;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", raw => {
    if (++ws.hits > 25) return;
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m !== "object") return;

    if (m.t === "ping") return send(ws, { t: "pong" });

    if (m.t === "create") {
      if (ws.room) return;
      if (rooms.size >= MAX_ROOMS) return send(ws, { t: "error", msg: "Server is busy." });
      ws.name = clean(m.name, 18) || "Host"; ws.isHost = true;
      const code = genCode(), token = crypto.randomBytes(12).toString("hex");
      const room = { host: ws, guests: new Set(), now: null, pos: null, token, hostTimer: null, guestsPick: true };
      rooms.set(code, room); ws.room = code;
      send(ws, { t: "created", code, token });
      return announce(room);
    }

    if (m.t === "resume") {
      if (ws.room) return;
      const code = clean(m.code, 6).toUpperCase();
      const room = rooms.get(code);
      if (!room || room.token !== String(m.token || "")) return send(ws, { t: "error", msg: "Room not found." });
      clearTimeout(room.hostTimer); room.hostTimer = null;
      const old = room.host;
      if (old && old !== ws) { old.room = null; old.isHost = false; old.terminate(); }
      ws.name = clean(m.name, 18) || "Host"; ws.isHost = true; ws.room = code; room.host = ws;
      send(ws, { t: "resumed", code, guestsPick: room.guestsPick });
      broadcast(room, { t: "sys", text: ws.name + " is back." }, ws);
      return announce(room);
    }

    if (m.t === "join") {
      if (ws.room) return;
      const code = clean(m.code, 6).toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: "error", msg: "Room not found." });
      const cid = clean(m.cid, 24);
      /* A reconnecting guest replaces its own stale socket instead of showing up twice. */
      if (cid) room.guests.forEach(g => { if (g.cid === cid) { room.guests.delete(g); g.room = null; g.terminate(); } });
      if (room.guests.size >= MAX_GUESTS) return send(ws, { t: "error", msg: "Room is full." });
      ws.name = clean(m.name, 18) || "Guest"; ws.cid = cid;
      room.guests.add(ws); ws.room = code;
      const p = roomPos(room);
      send(ws, { t: "joined", code, guestsPick: room.guestsPick,
                 now: room.now ? { url: room.now.url, name: room.now.name, meta: room.now.meta } : null,
                 sec: p ? p.sec : 0, exact: p ? p.exact : false });
      if (!m.rejoin) broadcast(room, { t: "sys", text: ws.name + " joined." }, ws);
      return announce(room);
    }

    const room = ws.room && rooms.get(ws.room);
    if (!room) return;

    if (m.t === "chat") {
      const text = clean(m.text, 300);
      if (text) broadcast(room, { t: "chat", from: ws.name, text }, ws);
    } else if (m.t === "play") {
      if (!ws.isHost && !room.guestsPick) return send(ws, { t: "sys", text: "Only the host can pick what plays right now." });
      const url = clean(m.url, 600), name = clean(m.name, 150);
      if (!name || !validUrl(url)) return;
      room.now = { url, name, meta: cleanMeta(m.meta), startedAt: Date.now() }; room.pos = null;
      broadcast(room, { t: "player", url, name, meta: room.now.meta, by: ws.name });
    } else if (m.t === "setting" && ws.isHost) {
      room.guestsPick = !!m.guestsPick;
      broadcast(room, { t: "settings", guestsPick: room.guestsPick });
    } else if (m.t === "pos" && ws.isHost) {
      const sec = Number(m.sec);
      if (!room.now || !isFinite(sec) || sec < 0 || sec > 86400) return;
      room.pos = { sec, at: Date.now(), playing: m.playing !== false };
    } else if (m.t === "sync") {
      const p = roomPos(room);
      send(ws, p ? Object.assign({ t: "sync" }, p) : { t: "sync", url: null });
    } else if (m.t === "sync-all" && ws.isHost) {
      const p = roomPos(room);
      if (!p) return;
      /* If the host's real position is known the host is the reference and stays put;
         otherwise everyone (host too) reloads to the same spot. */
      broadcast(room, Object.assign({ t: "sync", push: true }, p), p.exact ? ws : null);
      send(ws, { t: "synced-all", n: room.guests.size });
    } else if (m.t === "bye" && ws.isHost) {
      closeRoom(ws.room);
    }
  });

  ws.on("close", () => {
    const room = ws.room && rooms.get(ws.room);
    if (!room) return;
    if (ws.isHost) {
      if (room.host !== ws) return;
      /* Give the host a minute to reconnect (phone sleep, wifi blip) before closing the room. */
      room.host = null;
      broadcast(room, { t: "sys", text: "Host lost connection. Waiting up to a minute for them to come back…" });
      announce(room);
      const code = ws.room;
      room.hostTimer = setTimeout(() => closeRoom(code), HOST_GRACE_MS);
    } else {
      if (!room.guests.delete(ws)) return;
      broadcast(room, { t: "sys", text: ws.name + " left." });
      announce(room);
    }
  });
  ws.on("error", () => {});
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.hits = 0; ws.ping();
  });
}, 30000);
setInterval(() => wss.clients.forEach(ws => { ws.hits = 0; }), 5000);

server.listen(PORT, () => console.log("Watch Party listening on " + PORT));
