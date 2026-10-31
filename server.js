"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
let INDEX;
try { INDEX = fs.readFileSync(path.join(__dirname, "public", "index.html")); }
catch (e) { console.error("Missing public/index.html. Keep index.html inside a folder named public."); process.exit(1); }

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

/* Only these embed hosts may be loaded into the shared player (blocks a guest from pushing arbitrary sites). */
const ALLOWED_HOSTS = ["vidsrc.to", "embedmaster.link", "vidlink.pro", "vidfast.pro", "vidnest.fun"];
function okUrl(u) {
  try { const x = new URL(u); return x.protocol === "https:" && ALLOWED_HOSTS.some(h => x.hostname === h || x.hostname.endsWith("." + h)); }
  catch (e) { return false; }
}
/* ref = which title this is, so anyone can switch servers: { k:"movie"|"series", id:"tt123", s, e } */
function cleanRef(r) {
  if (!r || typeof r !== "object") return null;
  const id = clean(r.id, 14);
  if (!/^tt\d{1,10}$/.test(id)) return null;
  const n = v => Math.min(9999, Math.max(0, parseInt(v, 10) || 0));
  return r.k === "series" ? { k: "series", id, s: n(r.s), e: n(r.e) } : { k: "movie", id, s: 0, e: 0 };
}

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });

/* code -> { host: ws, guests: Set<ws>, now: {url,name,ref} | null } */
const rooms = new Map();
const MAX_ROOMS = 1000, MAX_GUESTS = 30;

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const everyone = r => [r.host, ...r.guests];
const broadcast = (r, o, except) => everyone(r).forEach(w => { if (w !== except) send(w, o); });
const announceCount = r => broadcast(r, { t: "count", n: 1 + r.guests.size });
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, "").trim().slice(0, n);

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
  ws.room = null; ws.name = "Guest"; ws.isHost = false;
  ws.hits = 0;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", raw => {
    if (++ws.hits > 25) return;
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m !== "object") return;

    if (m.t === "create") {
      if (ws.room) return;
      if (rooms.size >= MAX_ROOMS) return send(ws, { t: "error", msg: "Server is busy." });
      ws.name = clean(m.name, 18) || "Host"; ws.isHost = true;
      const code = genCode();
      const room = { host: ws, guests: new Set(), now: null };
      rooms.set(code, room); ws.room = code;
      return send(ws, { t: "created", code });
    }

    if (m.t === "join") {
      if (ws.room) return;
      const code = clean(m.code, 6).toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: "error", msg: "Room not found." });
      if (room.guests.size >= MAX_GUESTS) return send(ws, { t: "error", msg: "Room is full." });
      ws.name = clean(m.name, 18) || "Guest";
      room.guests.add(ws); ws.room = code;
      send(ws, { t: "joined", code, now: room.now });
      broadcast(room, { t: "sys", text: ws.name + " joined." }, ws);
      return announceCount(room);
    }

    const room = ws.room && rooms.get(ws.room);
    if (!room) return;

    if (m.t === "chat") {
      const text = clean(m.text, 300);
      if (text) broadcast(room, { t: "chat", from: ws.name, text }, ws);
    } else if (m.t === "player" && ws.isHost) {
      const url = clean(m.url, 600), name = clean(m.name, 150), ref = cleanRef(m.ref);
      if (!okUrl(url)) return;
      room.now = { url, name, ref };
      broadcast(room, { t: "player", url, name, ref }, ws);
    } else if (m.t === "req-player" && !ws.isHost) {
      const url = clean(m.url, 600), name = clean(m.name, 150), ref = cleanRef(m.ref);
      if (!okUrl(url)) return;
      send(room.host, { t: "req-player", url, name, ref });
    }
  });

  ws.on("close", () => {
    const room = ws.room && rooms.get(ws.room);
    if (!room) return;
    if (ws.isHost) {
      room.guests.forEach(g => { send(g, { t: "closed" }); g.room = null; });
      rooms.delete(ws.room);
    } else {
      room.guests.delete(ws);
      broadcast(room, { t: "sys", text: ws.name + " left." });
      announceCount(room);
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