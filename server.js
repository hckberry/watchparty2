"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const axios = require("axios");

const PORT = process.env.PORT || 3000;
const INDEX = fs.readFileSync(path.join(__dirname, "public", "index.html"));

// Browser-like headers to try and bypass Cloudflare's datacenter IP blocks
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1"
};

const server = http.createServer(async (req, res) => {
  const p = (req.url || "/").split("?")[0];
  if (p === "/healthz") { res.writeHead(200); return res.end("ok"); }
  
  if (p === "/api/scrape") {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const imdbId = urlObj.searchParams.get("imdb");
    if (!imdbId) { res.writeHead(400); return res.end("Missing imdb param"); }
    
    try {
      // 1. Fetch embed page from vidsrc-embed.ru
      const embedUrl = `https://vidsrc-embed.ru/embed/movie/${imdbId}`;
      const embedRes = await axios.get(embedUrl, { headers: BROWSER_HEADERS, timeout: 10000 });
      
      // 2. Extract iframe URL from cloudnestra.com
      const iframeMatch = embedRes.data.match(/<iframe[^>]+src="([^"]+)"/i);
      if (!iframeMatch) throw new Error("No iframe found on embed page. Cloudflare might be blocking.");
      let iframeUrl = iframeMatch[1];
      if (iframeUrl.startsWith("//")) iframeUrl = "https:" + iframeUrl;
      
      // 3. Fetch the iframe page to extract prorcp hash
      const iframeRes = await axios.get(iframeUrl, { 
        headers: { ...BROWSER_HEADERS, "Referer": embedUrl }, 
        timeout: 10000 
      });
      
      const prorcpMatch = iframeRes.data.match(/(?:prorcp|hash)\s*=\s*["']([^"']+)["']/i) || 
                          iframeRes.data.match(/src\s*=\s*["']([^"']*prorcp[^"']*)["']/i);
      
      if (!prorcpMatch) throw new Error("Could not find prorcp hash in iframe source.");
      
      // 4. Fetch the final M3U8 from the prorcp endpoint
      let prorcpEndpoint = prorcpMatch[1];
      if (prorcpEndpoint.startsWith("/")) prorcpEndpoint = "https://cloudnestra.com" + prorcpEndpoint;
      if (prorcpEndpoint.startsWith("//")) prorcpEndpoint = "https:" + prorcpEndpoint;
      
      const m3u8Res = await axios.get(prorcpEndpoint, { 
        headers: { ...BROWSER_HEADERS, "Referer": iframeUrl }, 
        timeout: 10000 
      });
      
      // Extract the raw .m3u8 URL from the JSON/JS response
      const m3u8Match = JSON.stringify(m3u8Res.data).match(/https?:\/\/[^"']+?\.m3u8[^"']*/i);
      if (!m3u8Match) throw new Error("Could not extract final M3U8 URL.");
      
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ links: [m3u8Match[0]] }));
      
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ 
        error: "Scrape Failed: " + e.message,
        hint: "Render's IP is likely being blocked by Cloudflare. Try a direct .m3u8 link instead."
      }));
    }
  }

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

const rooms = new Map();
const MAX_ROOMS = 1000, MAX_GUESTS = 30, HOST_GRACE_MS = 60000;

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const everyone = r => [r.host, ...r.guests].filter(Boolean);
const broadcast = (r, o, except) => everyone(r).forEach(w => { if (w !== except) send(w, o); });
const announce = r => broadcast(r, { t: "people", list: everyone(r).map(w => ({ name: w.name, host: w === r.host })) });
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, "").trim().slice(0, n);

function validUrl(u) {
  try { 
    const x = new URL(u); 
    if (x.protocol !== "https:") return false;
    if (/\.(m3u8|mp4)(\?|$)/i.test(u)) return true;
    return true; 
  }
  catch (e) { return false; }
}

function cleanMeta(m) {
  if (!m || typeof m !== "object" || (m.kind !== "movie" && m.kind !== "series")) return null;
  const id = String(m.id || "");
  if (!/^tt\d{1,10}$/.test(id)) return null;
  return { kind: m.kind, id, s: Math.min(parseInt(m.s, 10) || 0, 999), e: Math.min(parseInt(m.e, 10) || 0, 9999) };
}

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
      const url = clean(m.url, 1000), name = clean(m.name, 150);
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
