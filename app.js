(() => {
"use strict";
const CFG = window.MEETING_CONFIG || {};
const ROOM = CFG.ROOM || "class";
const NAMESPACE = CFG.NAMESPACE || "meetingapp";
const APP_NAME = CFG.APP_NAME || "My Meeting App";
// Teachers: each has their own passcode hash (and optionally the rooms they may host).
// The old single HOST_PASSCODE_HASH setting still works as an unnamed teacher.
const TEACHERS = (Array.isArray(CFG.TEACHERS) ? CFG.TEACHERS : [])
  .map((t) => {
    t = t || {};
    // "rooms" (or "room") given in ANY form means restricted: a list, one text, or [] (= no rooms). Only leaving it out (or "*") allows every room.
    const raw = t.rooms !== undefined ? t.rooms : t.room;
    const rooms = raw === undefined || raw === null || raw === "*" ? null : Array.isArray(raw) ? raw.map(String) : [String(raw)];
    return { name: String(t.name || "").trim().slice(0, 40), hash: String(t.hash || "").trim().toLowerCase(), rooms };
  })
  .filter((t) => t.hash);
if (CFG.HOST_PASSCODE_HASH && !TEACHERS.some((t) => t.hash === String(CFG.HOST_PASSCODE_HASH).trim().toLowerCase())) TEACHERS.push({ name: "", hash: String(CFG.HOST_PASSCODE_HASH).trim().toLowerCase(), rooms: null });
const EXTRA_ICE_SERVERS = Array.isArray(CFG.EXTRA_ICE_SERVERS) ? CFG.EXTRA_ICE_SERVERS : [];
const PUBLIC_URL = CFG.PUBLIC_URL || "";
const LOGO = CFG.LOGO || "🎓";
const NAME_PARTS = (Array.isArray(CFG.NAME_PARTS) ? CFG.NAME_PARTS : [])
  .map((p) => ({ text: String((p && p.text) || ""), color: /^#[0-9a-f]{3,8}$/i.test((p && p.color) || "") || /^[a-z]{3,20}$/i.test((p && p.color) || "") ? p.color : "" }))
  .filter((p) => p.text);
const BRAND = /^#[0-9a-f]{3,8}$/i.test(CFG.BRAND_COLOR || "") ? CFG.BRAND_COLOR : "#1a73e8";
const TEACHER_LABEL = String(CFG.TEACHER_LABEL || "").slice(0, 40);
const DEFAULT_HASH = "8eb2961d9750214f76ff37133422ee3f48100588caa32566007a6d33bea8b5fc";
const DEFAULT_ROOM = "SampleAppWorseParkingsCutOpenly";
// Person-cutout model used for background blur / replacement (loaded only when someone turns an effect on)
const SEG_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/";

async function sha256Hex(text) {
  if (!(window.crypto && crypto.subtle)) throw new Error("no-crypto");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10);
const cl = (o) => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const SVGNS = "http://www.w3.org/2000/svg";
function icon(name, cls) {
  const s = document.createElementNS(SVGNS, "svg"); s.setAttribute("class", "ic" + (cls ? " " + cls : ""));
  const u = document.createElementNS(SVGNS, "use"); u.setAttribute("href", "#i-" + name); s.append(u); return s;
}
function setIcon(btn, name) { const u = btn.querySelector("use"); if (u) u.setAttribute("href", "#i-" + name); }
const loadScript = (src) => new Promise((res, rej) => {
  const s = document.createElement("script"); s.src = src; s.crossOrigin = "anonymous";
  s.onload = res; s.onerror = () => rej(new Error("Could not load " + src)); document.head.append(s);
});
const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("image")); i.src = src; });
// a timer that keeps running in background tabs (plain setInterval is throttled to 1/sec there)
function ticker(fn, ms) {
  try {
    const w = new Worker(URL.createObjectURL(new Blob([`setInterval(function(){postMessage(0)},${Math.round(ms)})`], { type: "text/javascript" })));
    w.onmessage = fn; return () => w.terminate();
  } catch (e) { const t = setInterval(fn, ms); return () => clearInterval(t); }
}

window.addEventListener("load", () => {
  /* =====================  VIDEO CALL (WebRTC, browser to browser)  ===================== */
  const params = new URLSearchParams(location.search);
  const cleanId = (x) => String(x || "").replace(/[^A-Za-z0-9_-]/g, "").replace(/[-_]{2,}/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 60);
  const ROOM_ID = cleanId(params.get("room")) || cleanId(ROOM) || "class";
  const HOST_PEER = `${NAMESPACE}-${ROOM_ID}-host`;
  const ROLE_PARAM = params.get("role");
  const PEER_OPTS = { debug: 1, config: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:global.stun.twilio.com:3478" }, ...EXTRA_ICE_SERVERS] } };
  let myId = null, myName = "Guest", peer = null, localStream = null, rawCam = null, camTrack = null, screenStream = null;
  let hasCam = false, camOn = true;
  let leaving = false, ended = false, entering = false;
  const peers = new Map();   // peer id -> { name, conn, call }   (teacher: every student; student: only the teacher)
  const calls = new Set();
  const tiles = new Map();

  let teacherName = TEACHER_LABEL || "Teacher";   // what students see on the teacher's video tile
  const attendance = [];                          // { id, name, joined, left }
  const rejected = new Set();                     // removed students (blocked for this session)
  const turnedAway = new Set();                   // turned away while the class was locked
  const blocked = (id) => rejected.has(id) || turnedAway.has(id);
  let locked = false, chatOn = true, handUp = false;

  /* ---- branding ---- */
  function setLogo(el, logo) {
    el.textContent = ""; el.classList.remove("hasImg");
    if (/^(https?:|data:)/i.test(logo) || /\.(png|jpe?g|svg|webp|gif|ico)(\?.*)?$/i.test(logo)) {
      const img = document.createElement("img"); img.src = logo; img.alt = ""; el.append(img); el.classList.add("hasImg");
    } else el.textContent = logo;
  }
  document.documentElement.style.setProperty("--brand", BRAND);
  document.title = APP_NAME;
  function setName(el) {
    el.textContent = "";
    if (!NAME_PARTS.length) { el.textContent = APP_NAME; return; }
    NAME_PARTS.forEach((p, i) => {
      if (i) el.append(" ");
      const s = document.createElement("span"); s.textContent = p.text; if (p.color) s.style.color = p.color; el.append(s);
    });
  }
  ["appName", "endedName", "pjName"].forEach((id) => setName($(id)));
  $("pjTag").textContent = CFG.TAGLINE || "";
  $("pjWelcome").textContent = CFG.WELCOME_TEXT || "";
  $("pjFoot").textContent = CFG.FOOTER_TEXT || "";
  $("pjVer").textContent = "v4 · files loaded OK";
  ["brandLogo", "pjLogo", "endedLogo"].forEach((id) => setLogo($(id), LOGO));
  (() => {
    const l = document.createElement("link"); l.rel = "icon";
    l.href = /^(https?:|data:)/i.test(LOGO) || /\.(png|jpe?g|svg|webp|gif|ico)(\?.*)?$/i.test(LOGO)
      ? LOGO : "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${LOGO}</text></svg>`);
    document.head.append(l);
  })();

  /* ---- small helpers: toast, beep, download ---- */
  function toast(text, opts) {
    opts = opts || {};
    const d = document.createElement("div"); d.className = "toast" + (opts.type ? " " + opts.type : "");
    const sp = document.createElement("span"); sp.textContent = text; d.append(sp);
    const x = document.createElement("button"); x.type = "button"; x.textContent = "✕"; x.setAttribute("aria-label", "Dismiss"); x.onclick = () => d.remove(); d.append(x);
    $("toasts").append(d);
    if (opts.ms !== 0) setTimeout(() => d.remove(), opts.ms || 5000);
    return d;
  }
  // a slim warning line under the top bar (stays until dismissed, never covers the board)
  function banner(text) {
    const d = document.createElement("div"); d.className = "warnline";
    const s = document.createElement("span"); s.textContent = text; d.append(s);
    const x = document.createElement("button"); x.type = "button"; x.setAttribute("aria-label", "Dismiss"); x.append(icon("x")); x.onclick = () => d.remove(); d.append(x);
    $("warns").append(d);
  }
  let actx = null;
  function beep() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = 880; g.gain.value = 0.05;
      o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.15);
    } catch (e) { /* ignore */ }
  }
  function saveBlob(blob, name) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  const netBad = (b) => { $("netPill").classList.toggle("bad", !!b); $("netLbl").textContent = b ? "Reconnecting…" : "Connected"; };

  /* ---- popovers (background picker, board menu, tool flyouts) ---- */
  function placeAbove(panel, anchor) {
    panel.classList.add("show");
    const r = anchor.getBoundingClientRect(), pw = panel.offsetWidth, ph = panel.offsetHeight;
    panel.style.left = clamp(r.left + r.width / 2 - pw / 2, 10, Math.max(10, innerWidth - pw - 10)) + "px";
    let top = r.top - ph - 12; if (top < 10) top = Math.min(r.bottom + 12, Math.max(10, innerHeight - ph - 10));
    panel.style.top = top + "px";
  }
  function placeBelow(panel, anchor) {
    panel.classList.add("show");
    const r = anchor.getBoundingClientRect(), pw = panel.offsetWidth;
    panel.style.left = clamp(r.right - pw, 10, Math.max(10, innerWidth - pw - 10)) + "px";
    panel.style.top = r.bottom + 8 + "px";
  }
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => { $(b.dataset.close).classList.remove("show"); syncPanelBtns(); }));
  function syncPanelBtns() {
    $("permBtn").classList.toggle("active", $("permPanel").classList.contains("show"));
    $("shareBtn").classList.toggle("active", $("sharePanel").classList.contains("show"));
  }

  function setStatus(t) { const el = $("vstatus"); el.textContent = t || ""; el.style.display = t ? "block" : "none"; }
  function ensureTile(id, name, self) {
    let t = tiles.get(id);
    if (!t) {
      const d = document.createElement("div"); d.className = "tile" + (self ? " self" : "");
      const v = document.createElement("video"); v.autoplay = true; v.playsInline = true; if (self) v.muted = true;
      const n = document.createElement("span"); n.className = "nm";
      d.append(v, n); $("vgrid").append(d); t = { d, v, n }; tiles.set(id, t); updGrid();
    }
    if (name) t.n.textContent = name + (self ? " (you)" : "");
    return t;
  }
  function dropTile(id) { const t = tiles.get(id); if (t) { t.d.remove(); tiles.delete(id); updGrid(); } }
  function updGrid() { $("vgrid").classList.toggle("multi", tiles.size > 1); }   // several people: neat 16:9 tiles

  /* ---- camera / microphone ---- */
  function blackTrack() { const c = document.createElement("canvas"); c.width = c.height = 16; c.getContext("2d").fillRect(0, 0, 16, 16); return c.captureStream(5).getVideoTracks()[0]; }
  function silentTrack() { try { const ac = new (window.AudioContext || window.webkitAudioContext)(); return ac.createMediaStreamDestination().stream.getAudioTracks()[0]; } catch (e) { return null; } }
  async function getLocalMedia() {
    let st = null; const md = navigator.mediaDevices;
    if (md && md.getUserMedia) {
      try { st = await md.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 } }, audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch (e1) {
        try { st = await md.getUserMedia({ audio: true }); }
        catch (e2) { try { st = await md.getUserMedia({ video: true }); } catch (e3) { st = null; } }
      }
    }
    if (!st) st = new MediaStream();
    hasCam = st.getVideoTracks().length > 0;
    // a call needs one video and one audio track in each direction, even if the camera or microphone is missing
    if (!st.getVideoTracks().length) st.addTrack(blackTrack());
    if (!st.getAudioTracks().length) { const a = silentTrack(); if (a) st.addTrack(a); }
    return st;
  }
  const outVideo = () => (screenStream ? screenStream.getVideoTracks()[0] : camTrack);
  const outStream = () => new MediaStream([outVideo(), ...localStream.getAudioTracks()].filter(Boolean));

  function setMic(on) {
    const t = localStream && localStream.getAudioTracks()[0]; if (!t) return;
    t.enabled = on; $("micBtn").classList.toggle("off", !on); setIcon($("micBtn"), on ? "mic" : "mic-off");
    $("micBtn").setAttribute("aria-pressed", String(!on));
  }
  $("micBtn").onclick = () => { const t = localStream && localStream.getAudioTracks()[0]; if (t) setMic(!t.enabled); };
  function setCam(on) {
    camOn = on; if (rawCam) rawCam.enabled = on; if (fx.track) fx.track.enabled = on;
    $("camBtn").classList.toggle("off", !on); setIcon($("camBtn"), on ? "cam" : "cam-off");
    $("camBtn").setAttribute("aria-pressed", String(!on));
  }
  $("camBtn").onclick = () => {
    if (!hasCam) { toast("No camera was found on this device.", { type: "warn" }); return; }
    setCam(!camOn);
  };
  function setOutVideo(track) {
    calls.forEach((c) => {
      try { const sd = c.peerConnection && c.peerConnection.getSenders().find((x) => x.track && x.track.kind === "video"); if (sd) sd.replaceTrack(track).catch(() => {}); }
      catch (e) { console.warn(e); }
    });
    const t = tiles.get("self");
    if (t) { t.v.srcObject = new MediaStream([track, ...localStream.getAudioTracks()]); t.d.classList.toggle("screen", !!screenStream); }
  }
  // switch which camera picture (plain or with background effect) is sent and shown
  function applyCamTrack(track) { camTrack = track; track.enabled = camOn; if (!screenStream) setOutVideo(track); }
  async function toggleScreen() {
    if (screenStream) { stopScreen(); return; }
    try { screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true }); } catch (e) { screenStream = null; return; }
    const tr = screenStream.getVideoTracks()[0]; tr.onended = stopScreen;
    setOutVideo(tr); $("scrBtn").classList.add("on");
  }
  function stopScreen() {
    if (!screenStream) return;
    const st = screenStream; screenStream = null; st.getTracks().forEach((t) => t.stop());
    setOutVideo(camTrack); $("scrBtn").classList.remove("on");
  }
  $("scrBtn").onclick = toggleScreen;
  if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) $("scrBtn").style.display = "none";

  /* ---- background effects: blur or replace (each person's own camera, on their own device) ---- */
  const BG_KEY = "meeting-bg", BG_CUSTOM_KEY = "meeting-bg-custom";
  const FX_MAX_W = 960;   // effects are processed at up to 960 px wide, which keeps older laptops smooth
  const fx = { avg: 0, frames: 0, nextAt: 0, mode: "none", want: "none", seg: null, segP: null, video: null, canvas: null, ctx: null, track: null, stopTick: null, busy: false, bgSrc: null, small: null, canFilter: false, custom: null, customImg: null, customReady: null, applyOnFrame: false };
  const rnd = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const PRESETS = [
    { id: "study", name: "Study", draw(g, w, h) {
      const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, "#0a1f5c"); gr.addColorStop(1, "#2457d6");
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.fillStyle = "rgba(255,255,255,.09)"; const s = w / 32;
      for (let y = s / 2; y < h; y += s) for (let x = s / 2; x < w; x += s) { g.beginPath(); g.arc(x, y, s * .055, 0, 6.2832); g.fill(); }
    } },
    { id: "sunrise", name: "Sunrise", draw(g, w, h) {
      const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "#ffd9b8"); gr.addColorStop(.55, "#ff9a5c"); gr.addColorStop(1, "#e2400b");
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      const r = g.createRadialGradient(w * .5, h * 1.02, 0, w * .5, h * 1.02, h * .95); r.addColorStop(0, "rgba(255,247,210,.95)"); r.addColorStop(1, "rgba(255,247,210,0)");
      g.fillStyle = r; g.fillRect(0, 0, w, h);
    } },
    { id: "chalk", name: "Chalkboard", draw(g, w, h) {
      const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, "#1c3a30"); gr.addColorStop(1, "#2b5646");
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      const R = rnd(7); g.fillStyle = "rgba(255,255,255,.05)";
      for (let i = 0; i < 260; i++) { g.beginPath(); g.ellipse(R() * w, R() * h, R() * w * .05 + 2, R() * h * .012 + 1, R() * 3, 0, 6.2832); g.fill(); }
      const v = g.createRadialGradient(w / 2, h / 2, h * .3, w / 2, h / 2, w * .75); v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,.4)");
      g.fillStyle = v; g.fillRect(0, 0, w, h);
      g.fillStyle = "#6b4a2b"; g.fillRect(0, h * .94, w, h * .06);
    } },
    { id: "graph", name: "Graph paper", draw(g, w, h) {
      g.fillStyle = "#f5f8fc"; g.fillRect(0, 0, w, h);
      const s = w / 40;
      for (let i = 0, x = 0; x <= w; x += s, i++) { g.strokeStyle = i % 5 ? "rgba(59,130,246,.16)" : "rgba(59,130,246,.34)"; g.lineWidth = i % 5 ? 1 : 1.6; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
      for (let i = 0, y = 0; y <= h; y += s, i++) { g.strokeStyle = i % 5 ? "rgba(59,130,246,.16)" : "rgba(59,130,246,.34)"; g.lineWidth = i % 5 ? 1 : 1.6; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    } },
    { id: "ruled", name: "Notebook", draw(g, w, h) {
      g.fillStyle = "#fbf7ec"; g.fillRect(0, 0, w, h);
      const s = h / 12; g.strokeStyle = "rgba(59,130,246,.3)"; g.lineWidth = 1.4;
      for (let y = s * 1.5; y < h; y += s) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      g.strokeStyle = "rgba(239,68,68,.5)"; g.lineWidth = 2; g.beginPath(); g.moveTo(w * .13, 0); g.lineTo(w * .13, h); g.stroke();
    } },
    { id: "sky", name: "Sky", draw(g, w, h) {
      const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "#4fa3f7"); gr.addColorStop(1, "#dcefff");
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      const R = rnd(21);
      for (let i = 0; i < 7; i++) {
        const cx = R() * w, cy = h * (.15 + R() * .6), rr = w * (.08 + R() * .08);
        const c = g.createRadialGradient(cx, cy, 0, cx, cy, rr); c.addColorStop(0, "rgba(255,255,255,.85)"); c.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = c; g.beginPath(); g.ellipse(cx, cy, rr * 1.7, rr * .8, 0, 0, 6.2832); g.fill();
      }
    } },
  ];
  function makePreset(id, w, h) {
    const p = PRESETS.find((x) => x.id === id) || PRESETS[0];
    const c = document.createElement("canvas"); c.width = w; c.height = h; p.draw(c.getContext("2d"), w, h); return c;
  }
  const saveBg = (m) => { try { localStorage.setItem(BG_KEY, m); } catch (e) { /* ignore */ } };
  try {
    const cu = localStorage.getItem(BG_CUSTOM_KEY);
    if (cu) { fx.custom = cu; fx.customReady = loadImg(cu).then((i) => { fx.customImg = i; }).catch(() => { fx.custom = null; }); }
  } catch (e) { /* ignore */ }

  function drawCover(g, src, w, h) {
    const sw = src.videoWidth || src.naturalWidth || src.width, sh = src.videoHeight || src.naturalHeight || src.height; if (!sw || !sh) return;
    const r = Math.max(w / sw, h / sh), dw = sw * r, dh = sh * r; g.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }
  function softBlur(g, img, w, h, k) {
    const s = fx.small, sw = Math.max(16, Math.round(w / k)), sh = Math.max(9, Math.round(h / k));
    s.width = sw; s.height = sh; const sg = s.getContext("2d"); sg.imageSmoothingQuality = "high"; sg.drawImage(img, 0, 0, sw, sh);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; g.drawImage(s, 0, 0, sw, sh, 0, 0, w, h);
  }
  function onSeg(res) {
    const c = fx.canvas, g = fx.ctx; if (!c || !res || !res.segmentationMask) return;
    const w = c.width, h = c.height;
    g.save(); g.clearRect(0, 0, w, h);
    if (fx.canFilter) g.filter = "blur(2px)";               // soften the edge of the cut-out
    g.drawImage(res.segmentationMask, 0, 0, w, h);
    if (fx.canFilter) g.filter = "none";
    g.globalCompositeOperation = "source-in"; g.drawImage(res.image, 0, 0, w, h);
    g.globalCompositeOperation = "destination-over";
    if (fx.mode === "blur" || fx.mode === "blur-strong") {
      const strong = fx.mode === "blur-strong";
      if (fx.canFilter) { const sc = w / 1280; g.filter = `blur(${(strong ? 20 : 9) * sc}px)`; g.drawImage(res.image, -24, -24, w + 48, h + 48); g.filter = "none"; }
      else softBlur(g, res.image, w, h, strong ? 22 : 10);
    } else if (fx.bgSrc) drawCover(g, fx.bgSrc, w, h);
    else { g.fillStyle = "#101a2e"; g.fillRect(0, 0, w, h); }
    g.restore();
    if (fx.applyOnFrame) { fx.applyOnFrame = false; if (fx.mode !== "none") applyCamTrack(fx.track); }
  }
  function fxTick() {
    if (fx.mode === "none" || fx.busy || !fx.seg || !fx.video || fx.video.readyState < 2 || performance.now() < fx.nextAt) return;
    const v = fx.video;
    if (v.videoWidth) {
      const k = Math.min(1, FX_MAX_W / v.videoWidth), cw = Math.round(v.videoWidth * k), ch = Math.round(v.videoHeight * k);
      if (cw !== fx.canvas.width || ch !== fx.canvas.height) { fx.canvas.width = cw; fx.canvas.height = ch; }
    }
    const t0 = performance.now(); fx.busy = true;
    fx.seg.send({ image: v }).catch(() => {}).then(() => {
      fx.busy = false;
      const dt = performance.now() - t0; fx.avg = fx.avg ? fx.avg * 0.8 + dt * 0.2 : dt;
      fx.nextAt = performance.now() + Math.min(300, dt);            // leave the page time to breathe
      if (++fx.frames > 8 && fx.avg > 450 && fx.mode !== "none") {
        toast("This device is too slow for background effects, so they were turned off.", { type: "warn" });
        setEffect("none");
      }
    });
  }
  function initFxSource() {
    if (fx.video) return;
    const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.autoplay = true;
    v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
    document.body.append(v); v.srcObject = new MediaStream([rawCam]); v.play().catch(() => {});
    const c = document.createElement("canvas"), s = rawCam.getSettings ? rawCam.getSettings() : {};
    const sw = s.width || 1280, sh = s.height || 720, kk = Math.min(1, FX_MAX_W / sw);
    c.width = Math.round(sw * kk); c.height = Math.round(sh * kk);
    fx.video = v; fx.canvas = c; fx.ctx = c.getContext("2d"); fx.canFilter = typeof fx.ctx.filter === "string";
    fx.small = document.createElement("canvas");
    fx.track = c.captureStream(30).getVideoTracks()[0]; fx.track.enabled = camOn;
  }
  function ensureSeg() {
    if (fx.segP) return fx.segP;
    fx.segP = (async () => {
      if (!window.SelfieSegmentation) await loadScript(SEG_BASE + "selfie_segmentation.js");
      const seg = new window.SelfieSegmentation({ locateFile: (f) => SEG_BASE + f });
      seg.setOptions({ modelSelection: 1, selfieMode: false });
      seg.onResults(onSeg);
      await seg.initialize();
      fx.seg = seg;
    })().catch((e) => { fx.segP = null; throw e; });
    return fx.segP;
  }
  function markBg(mode) {
    document.querySelectorAll("#bgGrid .bgt").forEach((b) => { const on = b.dataset.mode === mode; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); });
    $("fxBtn").classList.toggle("on", mode !== "none");
  }
  async function setEffect(mode, auto) {
    if (!hasCam || !rawCam) { if (!auto) toast("No camera was found, so background effects are not available.", { type: "warn" }); return; }
    const prev = fx.mode;
    fx.want = mode; markBg(mode);
    if (mode === "none") {
      if (fx.stopTick) { fx.stopTick(); fx.stopTick = null; }
      fx.mode = "none"; saveBg("none"); applyCamTrack(rawCam); return;
    }
    $("bgPanel").classList.add("loading"); $("bgState").textContent = fx.seg ? "" : "Loading…";
    try {
      initFxSource(); await ensureSeg();
      if (mode.startsWith("preset:")) fx.bgSrc = makePreset(mode.slice(7), 1280, 720);
      else if (mode === "custom") { await fx.customReady; if (!fx.customImg) throw new Error("no image"); fx.bgSrc = fx.customImg; }
      else fx.bgSrc = null;
    } catch (e) {
      console.warn("background effect failed", e);
      $("bgPanel").classList.remove("loading"); $("bgState").textContent = "";
      if (fx.want === mode) { fx.want = prev; markBg(prev); toast(mode === "custom" ? "Could not use that picture." : "Could not load background effects. Check your internet connection and try again.", { type: "bad" }); }
      return;
    }
    $("bgPanel").classList.remove("loading"); $("bgState").textContent = "";
    if (fx.want !== mode) return;                              // the person picked something else meanwhile
    fx.mode = mode; saveBg(mode); fx.avg = 0; fx.frames = 0; fx.nextAt = 0;
    fx.applyOnFrame = camTrack !== fx.track;                   // show it once the first processed frame is ready
    if (!fx.stopTick) fx.stopTick = ticker(fxTick, 1000 / 30);
  }
  function stopFx() {
    if (fx.stopTick) { fx.stopTick(); fx.stopTick = null; }
    fx.mode = "none";
    try { fx.seg && fx.seg.close(); } catch (e) { /* ignore */ }
    try { fx.track && fx.track.stop(); } catch (e) { /* ignore */ }
    if (fx.video) { fx.video.remove(); fx.video = null; }
  }

  function buildBgPanel() {
    const grid = $("bgGrid"); grid.innerHTML = "";
    const base = (mode, label) => { const b = document.createElement("button"); b.type = "button"; b.className = "bgt"; b.dataset.mode = mode; b.title = label; b.setAttribute("aria-label", label); b.setAttribute("aria-pressed", "false"); grid.append(b); return b; };
    const iconTile = (mode, label, ic) => { const b = base(mode, label); b.append(icon(ic)); const s = document.createElement("span"); s.textContent = label; b.append(s); return b; };
    const thumb = (mode, label, el) => { const b = base(mode, label); b.append(el); const s = document.createElement("span"); s.className = "cap"; s.textContent = label; b.append(s); return b; };
    iconTile("none", "None", "ban").onclick = () => setEffect("none");
    iconTile("blur", "Blur", "blur").onclick = () => setEffect("blur");
    iconTile("blur-strong", "More blur", "blur").onclick = () => setEffect("blur-strong");
    PRESETS.forEach((p) => { thumb("preset:" + p.id, p.name, makePreset(p.id, 192, 120)).onclick = () => setEffect("preset:" + p.id); });
    if (fx.custom) { const im = document.createElement("img"); im.src = fx.custom; im.alt = ""; thumb("custom", "Your picture", im).onclick = () => setEffect("custom"); }
    iconTile("upload", "Upload", "plus").onclick = () => $("bgFile").click();
    markBg(fx.mode);
  }
  $("bgFile").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    try {
      const src = URL.createObjectURL(f), img = await loadImg(src); URL.revokeObjectURL(src);
      const r = Math.min(1, 1280 / (img.naturalWidth || 1280)), c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * r); c.height = Math.round(img.naturalHeight * r); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL("image/jpeg", 0.86);
      fx.custom = url; fx.customImg = await loadImg(url); fx.customReady = Promise.resolve();
      try { localStorage.setItem(BG_CUSTOM_KEY, url); } catch (err) { toast("Your picture works now, but it is too big to remember for next time.", { ms: 5000 }); }
      buildBgPanel(); setEffect("custom");
    } catch (err) { toast("Could not open that picture.", { type: "bad" }); }
  };
  $("fxBtn").onclick = () => {
    const p = $("bgPanel");
    if (p.classList.contains("show")) { p.classList.remove("show"); return; }
    buildBgPanel(); placeAbove(p, $("fxBtn"));
  };
  function restoreEffect() {
    let saved = "none"; try { saved = localStorage.getItem(BG_KEY) || "none"; } catch (e) { /* ignore */ }
    if (saved !== "none" && hasCam) setEffect(saved, true);
  }

  /* ---- teacher (the hub: every student connects to this browser) ---- */
  function startHost() {
    let tries = 0, ready = false;
    const open = () => {
      if (leaving) return;
      setStatus("Starting class…");
      peer = new Peer(HOST_PEER, PEER_OPTS);
      peer.on("open", (id) => {
        netBad(false); myId = id; hostId = id; recalc();
        if (ready) return; ready = true;
        setStatus("Class is live. Use Invite to share the link with students.");
        setTimeout(() => { if ($("vstatus").textContent.startsWith("Class is live")) setStatus(""); }, 9000);
      });
      peer.on("connection", onStudentConn);
      peer.on("call", onStudentCall);
      peer.on("disconnected", () => { netBad(true); if (!leaving && peer && !peer.destroyed) { try { peer.reconnect(); } catch (e) { /* ignore */ } } });
      peer.on("error", (err) => {
        if (err.type === "unavailable-id") {
          if (++tries > 20) { setStatus("This class is already open in another tab or device. Close it, then reload this page."); return; }
          setStatus(`Room busy (an old session may still be closing)… retry ${tries}/20`);
          try { peer.destroy(); } catch (e) { /* ignore */ }
          setTimeout(open, 3000);
        } else if (err.type === "peer-unavailable") { /* a student left early */ }
        else if (["network", "server-error", "socket-error", "socket-closed"].includes(err.type)) setStatus("Cannot reach the connection service. Check your internet…");
        else console.warn("peer error", err);
      });
    };
    open();
  }
  function uniqueName(n, id) {
    const used = new Set(); peers.forEach((p, k) => { if (k !== id && p.name) used.add(p.name.toLowerCase()); });
    if (!used.has(n.toLowerCase())) return n;
    let i = 2; while (used.has(`${n} (${i})`.toLowerCase())) i++;
    return `${n} (${i})`;
  }
  function onStudentConn(conn) {
    const id = conn.peer;
    const wasKnown = attendance.some((a) => a.id === id);
    if (rejected.has(id) || (locked && !wasKnown)) {
      if (!rejected.has(id)) turnedAway.add(id);
      conn.on("open", () => {
        try { conn.send("wb:" + JSON.stringify({ t: "kick", reason: rejected.has(id) ? "removed" : "locked" })); } catch (e) { /* ignore */ }
        setTimeout(() => { try { conn.close(); } catch (e) { /* ignore */ } }, 600);
      });
      return;
    }
    conn.on("open", () => {
      const p = peers.get(id) || {}; p.conn = conn;
      p.name = uniqueName(String((conn.metadata && conn.metadata.name) || "Student").trim().slice(0, 40) || "Student", id); peers.set(id, p);
      let a = attendance.find((x) => x.id === id);
      if (a) a.left = null; else { a = { id, name: p.name, joined: new Date(), left: null }; attendance.push(a); addSys(`${p.name} joined`); }
      p.att = a;
      ensureTile(id, p.name);
      bcast({ t: "hello", name: teacherName, chat: chatOn, rec: !!recorder }, [id]);
      sendPerm([id]);
      if (gridStyle !== "dots") bcast({ t: "grid", v: gridStyle }, [id]);
      if ($("showAll").checked) bcast({ t: "mode", m: main.dataset.mode }, [id]);
      sendState(id); refreshPerm();
    });
    conn.on("data", (d) => onData(id, d));
    const gone = () => { const p = peers.get(id); if (p && p.conn === conn) dropStudent(id); };
    conn.on("close", gone); conn.on("error", gone);
  }
  function onStudentCall(call) {
    const id = call.peer;
    if (blocked(id)) { try { call.close(); } catch (e) { /* ignore */ } return; }
    const p = peers.get(id) || {}; p.call = call; peers.set(id, p);
    calls.add(call);
    call.answer(outStream());
    call.on("stream", (st) => { const q = peers.get(id) || {}; ensureTile(id, q.name || (call.metadata && call.metadata.name) || "Student").v.srcObject = st; });
    call.on("close", () => calls.delete(call)); call.on("error", () => calls.delete(call));
  }
  function dropStudent(id) {
    const p = peers.get(id); if (!p) return;
    peers.delete(id);
    try { p.call && p.call.close(); } catch (e) { /* ignore */ }
    try { p.conn && p.conn.close(); } catch (e) { /* ignore */ }
    if (p.att) p.att.left = new Date();
    if (!ended) addSys(`${p.name || "A student"} left`);
    dropTile(id); allowed.delete(id); sendPerm(); updateHandBadge(); refreshPerm();
  }
  function lowerHand(id) {
    const p = peers.get(id); if (!p) return;
    p.hand = false; setHandMark(id, false); bcast({ t: "lowerhand" }, [id]); updateHandBadge(); refreshPerm();
  }
  function setHandMark(id, on) {
    const t = tiles.get(id); if (!t) return;
    let h = t.d.querySelector(".hand");
    if (on && !h) { h = document.createElement("div"); h.className = "hand"; h.append(icon("hand")); t.d.append(h); }
    else if (!on && h) h.remove();
  }
  function updateHandBadge() {
    let n = 0; peers.forEach((p) => { if (p.hand) n++; });
    const b = $("handBadge"); b.textContent = String(n); b.title = n === 1 ? "1 raised hand" : `${n} raised hands`; b.style.display = n ? "inline-grid" : "none";
  }

  /* ---- student ---- */
  function startGuest() {
    peer = new Peer(undefined, PEER_OPTS);
    let timer = null;
    const waitMsg = "Waiting for the teacher to start the class…";
    const schedule = (msg, ms) => { if (leaving) return; setStatus(msg); clearTimeout(timer); timer = setTimeout(connectHost, ms || 3000); };
    const linked = (conn) => {
      hostId = HOST_PEER; peers.set(HOST_PEER, { conn, name: teacherName }); setStatus(""); recalc();
      if (handUp) setTimeout(() => bcast({ t: "hand", up: true }), 600);
      const call = peer.call(HOST_PEER, outStream(), { metadata: { name: myName } });
      peers.get(HOST_PEER).call = call; calls.add(call);
      call.on("stream", (st) => { ensureTile(HOST_PEER, teacherName).v.srcObject = st; });
      call.on("close", () => calls.delete(call));
    };
    const lost = () => {
      const p = peers.get(HOST_PEER); peers.delete(HOST_PEER);
      try { p && p.call && p.call.close(); } catch (e) { /* ignore */ }
      calls.clear(); dropTile(HOST_PEER); hostId = null; recalc();
      schedule("The teacher disconnected. Waiting to reconnect…");
    };
    const connectHost = () => {
      if (leaving || !peer || peer.destroyed) return;
      if (peer.disconnected) { try { peer.reconnect(); } catch (e) { /* ignore */ } }
      setStatus("Connecting to the teacher…");
      const conn = peer.connect(HOST_PEER, { reliable: true, metadata: { name: myName } });
      let opened = false;
      conn.on("open", () => { opened = true; clearTimeout(timer); linked(conn); });
      conn.on("data", (d) => onData(HOST_PEER, d));
      conn.on("close", () => { if (opened) { const p = peers.get(HOST_PEER); if (p && p.conn === conn) lost(); } });
      conn.on("error", () => {});
      clearTimeout(timer);
      timer = setTimeout(() => { if (!opened) { try { conn.close(); } catch (e) { /* ignore */ } schedule(waitMsg); } }, 10000);
    };
    peer.on("open", (id) => { netBad(false); const first = !myId; myId = id; recalc(); if (first) connectHost(); });
    peer.on("disconnected", () => { netBad(true); if (!leaving && peer && !peer.destroyed) { try { peer.reconnect(); } catch (e) { /* ignore */ } } });
    peer.on("error", (err) => {
      if (err.type === "peer-unavailable") schedule(waitMsg);
      else if (["network", "server-error", "socket-error", "socket-closed"].includes(err.type)) setStatus("Cannot reach the connection service. Check your internet…");
      else console.warn("peer error", err);
    });
  }

  /* ---- leaving ---- */
  function showEnded(msg) {
    if (ended) return;
    if (isHost) { finishRecording(); const n = new Date(); attendance.forEach((a) => { if (!a.left) a.left = n; }); }
    ended = true; leaving = true;
    $("endedMsg").textContent = msg || "The class has ended. Thanks for joining!";
    try { wl && wl.release(); } catch (e) { /* ignore */ }
    try { peer && peer.destroy(); } catch (e) { /* ignore */ }
    try { stopFx(); } catch (e) { /* ignore */ }
    try { localStream && localStream.getTracks().forEach((t) => t.stop()); screenStream && screenStream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    $("ended").classList.add("show");
  }
  $("leaveBtn").onclick = () => {
    if (!confirm(isHost ? "End the class for everyone?" : "Leave the class?")) return;
    if (isHost) {
      bcast({ t: "end" });
      if (attendance.length && confirm("Download the attendance list before ending?")) downloadAttendance();
      setTimeout(() => showEnded(), 400);
    } else showEnded();
  };
  $("rejoin").addEventListener("click", () => location.reload());

  /* ---- class clock ---- */
  function startClock() {
    const t0 = Date.now(), el = $("clock"); el.hidden = false;
    const p2 = (n) => String(n).padStart(2, "0");
    const tick = () => { const s = Math.floor((Date.now() - t0) / 1000), h = Math.floor(s / 3600); el.textContent = (h ? h + ":" : "") + p2(Math.floor((s % 3600) / 60)) + ":" + p2(s % 60); };
    tick(); setInterval(tick, 1000);
  }

  /* ---- join screen ---- */
  let teacherMode = false;
  const pjMsg = (t) => { $("pjMsg").textContent = t || ""; };
  try { $("pjUser").value = localStorage.getItem("meeting-name") || ""; } catch (e) { /* ignore */ }
  function setTeacherMode(on) {
    teacherMode = on;
    $("pjTeacherRow").style.display = on ? "" : "none";
    $("pjTeacher").textContent = on ? "Start class" : "Teacher login";
    $("pjTeacher").classList.toggle("primary", on); $("pjStudent").classList.toggle("primary", !on);
    const named = TEACHERS.length && TEACHERS.every((t) => t.name);
    $("pjUser").parentElement.style.display = on && named ? "none" : "";
    if (on) $("pjPass").focus();
  }
  if (ROLE_PARAM === "student") $("pjTeacher").style.display = "none";
  if (ROLE_PARAM === "teacher") { $("pjStudent").style.display = "none"; setTeacherMode(true); }
  let fails = 0, lockUntil = 0;
  async function enter(asHost) {
    if (entering) return;
    let who = null;   // the teacher whose passcode matched
    if (typeof Peer === "undefined") { pjMsg("Could not load the connection library. Check your internet and reload."); return; }
    if (asHost) {
      const wait = Math.ceil((lockUntil - Date.now()) / 1000);
      if (wait > 0) { pjMsg(`Too many wrong attempts. Try again in ${wait}s.`); return; }
      let h = "";
      try { h = await sha256Hex($("pjPass").value); }
      catch (e) { pjMsg("Passcode check needs HTTPS (GitHub Pages) or localhost."); return; }
      const hits = TEACHERS.filter((t) => t.hash === h);
      if (hits.length > 1) { pjMsg("Two teachers have the same passcode. Ask the owner to give each teacher a different one."); return; }
      who = hits[0] || null;
      if (!who) {
        fails++; if (fails >= 3) lockUntil = Date.now() + Math.min(300, (fails - 2) * 15) * 1000;
        pjMsg("Wrong passcode"); return;
      }
      fails = 0;
      if (who.rooms && !who.rooms.some((r) => cleanId(r).toLowerCase() === ROOM_ID.toLowerCase())) {
        pjMsg("This passcode is not allowed to host this class room."); return;
      }
    }
    const nm = (asHost && who && who.name) || $("pjUser").value.trim() || (asHost ? "Teacher" : "");
    if (!nm) { pjMsg("Please enter your name"); return; }
    entering = true; myName = nm; pjMsg("");
    try { localStorage.setItem("meeting-name", nm); } catch (e) { /* ignore */ }
    $("pjStudent").disabled = $("pjTeacher").disabled = true;
    localStream = await getLocalMedia(); rawCam = localStream.getVideoTracks()[0]; camTrack = rawCam;
    $("prejoin").style.display = "none";
    if (!asHost) { $("vwrap").classList.add("guest"); $("handBtn").style.display = ""; }
    $("fxBtn").style.display = hasCam ? "" : "none";
    keepAwake(); startClock();
    ensureTile("self", myName, true).v.srcObject = localStream;
    if (asHost) {
      isHost = true; teacherName = (who && who.name) || TEACHER_LABEL || myName;
      $("recBtn").style.display = "";
      if (TEACHERS.some((t) => t.hash === DEFAULT_HASH)) banner("A teacher is still using the default passcode (change-me-123). Replace its hash in config.js before real classes.");
      toast(`Logged in as ${teacherName}`, { ms: 3000 });
      if (ROOM_ID === cleanId(DEFAULT_ROOM)) banner("Change ROOM and NAMESPACE in config.js so your class link is unique and hard to guess.");
      $("shareBtn").style.display = ""; $("permBtn").style.display = ""; $("showAllWrap").style.display = "";
      recalc(); startHost();
    } else startGuest();
    restoreEffect();
  }
  $("pjTeacher").onclick = () => { if (!teacherMode) setTeacherMode(true); else enter(true); };
  $("pjStudent").onclick = () => { if (teacherMode) setTeacherMode(false); enter(false); };
  [$("pjUser"), $("pjPass")].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") (teacherMode ? $("pjTeacher") : $("pjStudent")).click(); }));

  /* =====================  LAYOUT  ===================== */
  const main = $("main"), stage = $("stage"), vwrap = $("vwrap");
  function setMode(m, remote) {
    main.dataset.mode = m;
    if (isHost && !remote && $("showAll").checked) bcast({ t: "mode", m });
    document.querySelectorAll("#top [data-mode]").forEach((b) => { const on = b.dataset.mode === m; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); });
    if (m === "board" && !vwrap.dataset.placed) {
      const r = stage.getBoundingClientRect();
      vwrap.style.setProperty("--fx", Math.max(8, r.width - 340 - 16) + "px");
      vwrap.style.setProperty("--fy", $("docbar").offsetHeight + 14 + "px");   // just below the page bar, top right
      vwrap.dataset.placed = "1";
    }
    setTimeout(() => { resizeCanvas(); }, 30);
  }
  document.querySelectorAll("#top [data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("vSplit").addEventListener("click", () => setMode("split"));

  // divider between video and whiteboard (split mode)
  (() => {
    const s = $("split"); let drag = false;
    s.addEventListener("pointerdown", (e) => { drag = true; s.setPointerCapture(e.pointerId); });
    s.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const r = stage.getBoundingClientRect();
      stage.style.setProperty("--vw", clamp(e.clientX - r.left, 260, r.width - 360) + "px");
      vwrap.style.setProperty("--vw", clamp(e.clientX - r.left, 260, r.width - 360) + "px");
    });
    const end = () => { drag = false; };
    s.addEventListener("pointerup", end); s.addEventListener("pointercancel", end);
  })();

  // floating video window: drag + resize (whiteboard mode)
  (() => {
    const bar = $("vbar"), grip = $("vgrip");
    let mode = null, off = [0, 0];
    const num = (v, d) => parseFloat(vwrap.style.getPropertyValue(v)) || d;
    bar.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      mode = "move"; bar.setPointerCapture(e.pointerId);
      off = [e.clientX - num("--fx", 20), e.clientY - num("--fy", 20)];
    });
    grip.addEventListener("pointerdown", (e) => { mode = "size"; grip.setPointerCapture(e.pointerId); e.stopPropagation(); });
    const move = (e) => {
      if (!mode) return;
      const r = stage.getBoundingClientRect();
      if (mode === "move") {
        const w = num("--fw", 340), h = num("--fh", 250);
        vwrap.style.setProperty("--fx", clamp(e.clientX - off[0] - 0, 0, r.width - w) + "px");
        vwrap.style.setProperty("--fy", clamp(e.clientY - off[1] - 0, 0, r.height - h) + "px");
      } else {
        const x = num("--fx", 20), y = num("--fy", 20);
        vwrap.style.setProperty("--fw", clamp(e.clientX - r.left - x, 240, r.width - x) + "px");
        vwrap.style.setProperty("--fh", clamp(e.clientY - r.top - y, 170, r.height - y) + "px");
      }
    };
    const end = () => { mode = null; };
    [bar, grip].forEach((el) => { el.addEventListener("pointermove", move); el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end); });
  })();

  /* =====================  CHAT  ===================== */
  const chatLog = $("chatLog"), badge = $("badge");
  let unread = 0;
  function addChat(who, text, mine) {
    const d = document.createElement("div"); d.className = "msg" + (mine ? " mine" : "");
    const h = document.createElement("div"); h.className = "mh";
    h.textContent = `${who} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    const b = document.createElement("div"); b.textContent = text;
    d.append(h, b); chatLog.append(d); chatLog.scrollTop = chatLog.scrollHeight;
  }
  function toggleChat() {
    const open = main.classList.toggle("chat-open");
    $("chatBtn").classList.toggle("active", open);
    if (open) { unread = 0; badge.style.display = "none"; $("chatInput").focus(); }
    setTimeout(resizeCanvas, 30);
  }
  $("chatBtn").addEventListener("click", toggleChat);
  $("chatClose").addEventListener("click", toggleChat);
  function addSys(text) {
    const d = document.createElement("div"); d.className = "msg sys"; d.textContent = text;
    chatLog.append(d); chatLog.scrollTop = chatLog.scrollHeight;
  }
  function chatEnabled(on) {
    chatOn = on; const off = !on && !isHost;
    $("chatInput").disabled = off; $("chatSend").disabled = off;
    $("chatInput").placeholder = off ? "Chat is turned off by the teacher" : "Type a message…";
  }
  function setHand(up, fromHost) {
    handUp = up; $("handBtn").classList.toggle("on", up);
    $("handBtn").setAttribute("aria-pressed", String(up));
    if (!fromHost) bcast({ t: "hand", up });
    else toast("The teacher lowered your hand.");
  }
  $("handBtn").onclick = () => setHand(!handUp);
  function showRec(on) {
    $("recBadge").style.display = on ? "" : "none";
    if (on && !isHost) toast("🔴 This class is being recorded.", { type: "warn" });
  }
  $("chatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!chatOn && !isHost) return;
    const t = $("chatInput").value.trim(); if (!t) return;
    $("chatInput").value = "";
    bcast({ t: "chat", who: myName, text: t });
    addChat("You", t, true);
  });
  function incomingChat(m) {
    addChat(String(m.who || "Guest").slice(0, 40), String(m.text || "").slice(0, 2000), false);
    if (!main.classList.contains("chat-open")) { unread++; badge.textContent = unread; badge.style.display = "inline-grid"; }
  }

  /* =====================  NETWORK (whiteboard + chat over data channels)  ===================== */
  // Teacher = hub. Students send to the teacher; the teacher checks permissions and forwards to everyone else.
  const queue = [], CH = 12000;
  function targets() { const r = []; peers.forEach((p, id) => { if (p.conn && p.conn.open) r.push(id); }); return r; }
  function sendRaw(id, s) {
    if (s.length <= CH) { queue.push({ id, text: "wb:" + s }); return; }
    const mid = uid(), n = Math.ceil(s.length / CH);
    for (let i = 0; i < n; i++) queue.push({ id, text: `wc:${mid}:${i}:${n}:${s.slice(i * CH, (i + 1) * CH)}` });
  }
  function bcast(obj, to) {
    const list = to || targets(); if (!list.length) return;
    const s = JSON.stringify(obj); list.forEach((id) => sendRaw(id, s));
  }
  function relayRaw(s, except) { targets().forEach((id) => { if (id !== except) sendRaw(id, s); }); }
  setInterval(() => {
    for (let k = 0; k < 12 && queue.length; k++) {
      const m = queue[0], p = peers.get(m.id);
      if (!p || !p.conn || !p.conn.open) { queue.shift(); continue; }
      const dc = p.conn.dataChannel;
      if (dc && dc.bufferedAmount > 1000000) break;
      queue.shift();
      try { p.conn.send(m.text); } catch (err) { console.warn(err); }
    }
  }, 8);
  const asm = {};
  function onData(from, text) {
    if (typeof text !== "string") return;
    let full = null;
    if (text.startsWith("wb:")) full = text.slice(3);
    else if (text.startsWith("wc:")) {
      const parts = text.split(":"); const mid = parts[1], i = +parts[2], n = +parts[3];
      const data = text.slice(`wc:${mid}:${i}:${n}:`.length);
      const k = from + mid; const a = asm[k] || (asm[k] = { n, got: 0, p: [] });
      if (!a.p[i]) { a.p[i] = data; a.got++; }
      if (a.got === n) { delete asm[k]; full = a.p.join(""); }
    }
    if (full === null) return;
    try {
      const m = JSON.parse(full);
      if (!m || typeof m !== "object") return;
      if (isHost) {
        const p = peers.get(from); if (!p || !p.conn) return;
        if (m.t === "chat") {
          const now = Date.now(); p.ct = (p.ct || []).filter((x) => now - x < 5000);
          if (!chatOn || p.ct.length >= 6) return; p.ct.push(now);
          m.who = p.name; m.text = String(m.text || "").slice(0, 2000); if (!m.text.trim()) return;
          full = JSON.stringify(m);
        } else if (m.t === "laser") { m.u = from; full = JSON.stringify(m); }
      }
      onMsg(m, from);
      if (isHost && (m.t === "chat" || (WRITE.includes(m.t) && authorized(from)))) relayRaw(full, from);
    } catch (err) { console.warn("message error", err); }
  }

  /* =====================  WHITEBOARD STATE  ===================== */
  const pages = {};
  const pg = (k) => pages[k] || (pages[k] = { objs: [], bg: null, undo: [], redo: [] });
  let key = "board";
  let pdfDoc = null, pdfId = null, pdfInfo = { n: 1, total: 1 };
  const sentBg = new Set();
  const view = { s: 1, x: 0, y: 0 };
  const S = { tool: "pen", color: "#111111", size: 4, fill: false, dash: false };
  let selId = null, dirty = true, spaceDown = false;
  let gridStyle = "dots";
  const GRIDS = ["dots", "grid", "lines", "plain"];
  const LINEISH = ["line", "arrow", "darrow", "numline"];
  const CLOSED = ["rect", "ellipse", "triangle", "rtri", "diamond", "hexagon", "star"];
  const SHAPE_TOOLS = ["line", "arrow", "darrow", "rect", "ellipse", "triangle", "rtri", "diamond", "hexagon", "star"];
  const MATH_TOOLS = ["numline", "axes"];
  const SHAPES_ALL = [...LINEISH, ...CLOSED, "axes"];

  // ---- host / permissions ----
  const WRITE = ["put", "putn", "pt", "del", "clear", "bg", "page", "laser"];
  let isHost = false, hostId = null, allowAll = false, allowed = new Set(), canDraw = false;
  const authorized = (id) => id === hostId || allowAll || allowed.has(id);
  function recalc() {
    const was = canDraw;
    canDraw = isHost || allowAll || (!!myId && allowed.has(myId));
    $("viewOnly").style.display = canDraw ? "none" : "block";
    $("board").classList.toggle("ro", !canDraw);
    if (!canDraw) setTool("hand"); else if (!was) setTool("pen");
    updUI();
  }
  function sendPerm(to) { bcast({ t: "perm", all: allowAll, ids: Array.from(allowed) }, to); }

  // laser pointer trails (short-lived, shown to everyone)
  const lasers = new Map(), LASER_MS = 700;
  function addLaser(u, k, x, y) {
    const L = lasers.get(u) || { k, pts: [] }; L.k = k; L.pts.push({ x, y, t: performance.now() });
    if (L.pts.length > 48) L.pts.shift(); lasers.set(u, L); dirty = true;
  }

  const cv = $("cv"), ctx = cv.getContext("2d"), wrap = $("cvwrap");
  let dpr = 1;
  function resizeCanvas() {
    const r = wrap.getBoundingClientRect(); dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr));
    dirty = true;
  }
  new ResizeObserver(resizeCanvas).observe(wrap);
  window.addEventListener("resize", resizeCanvas);

  /* ---- object operations (local + broadcast) ---- */
  const find = (id) => pg(key).objs.find((o) => o.id === id);
  function applyPut(k, o) { const p = pg(k); const i = p.objs.findIndex((x) => x.id === o.id); if (i >= 0) p.objs[i] = o; else p.objs.push(o); }
  function applyDel(k, ids) { const p = pg(k); p.objs = p.objs.filter((o) => !ids.includes(o.id)); }
  function applyClear(k) { pg(k).objs = []; }
  function opPut(k, o) { applyPut(k, o); bcast({ t: "put", k, o }); dirty = true; updUI(); }
  function opDel(k, ids) { applyDel(k, ids); bcast({ t: "del", k, ids }); if (ids.includes(selId)) selId = null; dirty = true; updUI(); }
  function opClear(k) { applyClear(k); bcast({ t: "clear", k }); selId = null; dirty = true; updUI(); }
  function pushUndo(k, a) { const p = pg(k); p.undo.push(a); p.redo.length = 0; if (p.undo.length > 200) p.undo.shift(); updUI(); }
  const addAction = (k, o) => ({ undo: () => opDel(k, [o.id]), redo: () => opPut(k, cl(o)) });
  function undo() { const p = pg(key), a = p.undo.pop(); if (!a) return; a.undo(); p.redo.push(a); updUI(); }
  function redo() { const p = pg(key), a = p.redo.pop(); if (!a) return; a.redo(); p.undo.push(a); updUI(); }

  function setBg(k, data, w, h) {
    const img = new Image(); img.onload = () => { dirty = true; }; img.src = data;
    pg(k).bg = { img, data, w, h };
    dirty = true;
  }

  function sendState(id) {
    if (!isHost || !id || id === myId) return;
    const has = Object.keys(pages).some((k) => pages[k].objs.length) || key !== "board";
    if (!has) return;
    const to = [id];
    Object.keys(pages).forEach((k) => {
      const os = pages[k].objs;
      for (let i = 0; i < os.length; i += 40) bcast({ t: "putn", k, os: os.slice(i, i + 40) }, to);
    });
    if ($("share").checked && key !== "board") {
      const b = pg(key).bg; if (b) bcast({ t: "bg", k: key, img: b.data, w: b.w, h: b.h }, to);
    }
    if ($("share").checked) bcast({ t: "page", k: key, n: pdfInfo.n, total: pdfInfo.total }, to);
  }

  const HOSTCMD = ["hello", "kick", "end", "mute", "lowerhand", "chatlock", "rec", "grid"];
  function hostCmd(m) {
    switch (m.t) {
      case "hello": if (m.name) { teacherName = String(m.name).slice(0, 40); ensureTile(HOST_PEER, teacherName); } chatEnabled(m.chat !== false); showRec(!!m.rec); break;
      case "kick": showEnded(m.reason === "locked" ? "This class is locked. Ask your teacher to unlock it, then rejoin." : "You were removed from the class by the teacher."); break;
      case "end": showEnded("The teacher ended the class. Thanks for joining!"); break;
      case "mute": { const t = localStream && localStream.getAudioTracks()[0]; if (t && t.enabled) { setMic(false); toast("The teacher muted your microphone."); } break; }
      case "lowerhand": setHand(false, true); break;
      case "chatlock": chatEnabled(m.on !== false); break;
      case "rec": showRec(!!m.on); break;
      case "grid": setGridStyle(m.v, true); break;
    }
  }
  function onMsg(m, from) {
    if (m.t === "chat") { incomingChat(m); return; }
    if (m.t === "hand") {
      if (!isHost || !from) return; const p = peers.get(from); if (!p) return;
      p.hand = !!m.up; setHandMark(from, p.hand);
      if (p.hand) { toast(`${p.name} raised a hand`); beep(); }
      updateHandBadge(); refreshPerm(); return;
    }
    if (HOSTCMD.includes(m.t)) { if (isHost || (from && from !== hostId)) return; hostCmd(m); return; }
    if (m.t === "perm") { if (from && from !== hostId) return; allowAll = !!m.all; allowed = new Set(m.ids || []); recalc(); return; }
    if (m.t === "mode") { if (from && from !== hostId) return; setMode(m.m, true); return; }
    if (WRITE.includes(m.t) && from && !authorized(from)) return;
    switch (m.t) {
      case "put": applyPut(m.k, m.o); break;
      case "putn": m.os.forEach((o) => applyPut(m.k, o)); break;
      case "pt": { const o = pg(m.k).objs.find((x) => x.id === m.id); if (o && o.pts) o.pts.push(...m.p); break; }
      case "del": applyDel(m.k, m.ids); break;
      case "clear": applyClear(m.k); break;
      case "bg": setBg(m.k, m.img, m.w, m.h); break;
      case "page":
        pdfInfo = { n: m.n || 1, total: m.total || 1 };
        switchPage(m.k, true);
        if (m.k !== "board" && !pg(m.k).bg && from) bcast({ t: "needbg", k: m.k }, [from]);
        break;
      case "needbg": { const b = pg(m.k).bg; if (b && from) bcast({ t: "bg", k: m.k, img: b.data, w: b.w, h: b.h }, [from]); break; }
      case "laser": if (isFinite(m.x) && isFinite(m.y) && m.u !== myId) addLaser(String(m.u || from), m.k, +m.x, +m.y); return;
    }
    dirty = true; updUI();
  }

  /* ---- geometry helpers ---- */
  const distSeg = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = clamp(t, 0, 1);
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  function pointInPoly(x, y, P) {
    let ins = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      if ((P[i][1] > y) !== (P[j][1] > y) && x < ((P[j][0] - P[i][0]) * (y - P[i][1])) / (P[j][1] - P[i][1]) + P[i][0]) ins = !ins;
    }
    return ins;
  }
  function polyPts(o) {
    const x = o.x, y = o.y, w = o.w, h = o.h;
    switch (o.type) {
      case "triangle": return [[x + w / 2, y], [x + w, y + h], [x, y + h]];
      case "rtri": return [[x, y], [x, y + h], [x + w, y + h]];
      case "diamond": return [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]];
      case "hexagon": return [[x + w * 0.25, y], [x + w * 0.75, y], [x + w, y + h / 2], [x + w * 0.75, y + h], [x + w * 0.25, y + h], [x, y + h / 2]];
      case "star": {
        const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2, P = [];
        for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, k = i % 2 ? 0.42 : 1; P.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]); }
        return P;
      }
    }
    return [];
  }
  function bbox(o) {
    if (o.pts) {
      const xs = o.pts.map((p) => p[0]), ys = o.pts.map((p) => p[1]), pad = o.sw / 2;
      return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
    }
    if (o.a) { const pad = o.type === "numline" ? 26 : o.sw / 2; return [Math.min(o.a[0], o.b[0]) - pad, Math.min(o.a[1], o.b[1]) - pad, Math.max(o.a[0], o.b[0]) + pad, Math.max(o.a[1], o.b[1]) + pad]; }
    if (o.type === "text") {
      ctx.save(); ctx.font = `${o.fs}px sans-serif`;
      const lines = o.t.split("\n"), w = Math.max(...lines.map((l) => ctx.measureText(l).width)); ctx.restore();
      return [o.x, o.y, o.x + w, o.y + lines.length * o.fs * 1.25];
    }
    return [o.x, o.y, o.x + o.w, o.y + o.h];
  }
  function hit(o, x, y, tol) {
    const t = tol + (o.sw || 0) / 2;
    switch (o.type) {
      case "pen": case "hl":
        if (o.pts.length === 1) return Math.hypot(x - o.pts[0][0], y - o.pts[0][1]) <= t;
        for (let i = 0; i < o.pts.length - 1; i++) if (distSeg(x, y, o.pts[i][0], o.pts[i][1], o.pts[i + 1][0], o.pts[i + 1][1]) <= t) return true;
        return false;
      case "line": case "arrow": case "darrow": case "numline": return distSeg(x, y, o.a[0], o.a[1], o.b[0], o.b[1]) <= t + (o.type === "numline" ? 6 : 0);
      case "rect": {
        const out = x >= o.x - t && x <= o.x + o.w + t && y >= o.y - t && y <= o.y + o.h + t;
        const inn = x > o.x + t && x < o.x + o.w - t && y > o.y + t && y < o.y + o.h - t;
        return o.f ? out : out && !inn;
      }
      case "ellipse": {
        const rx = Math.max(o.w / 2, 1), ry = Math.max(o.h / 2, 1), d = Math.hypot((x - o.x - rx) / rx, (y - o.y - ry) / ry);
        const e = t / Math.min(rx, ry);
        return o.f ? d <= 1 + e : Math.abs(d - 1) <= e;
      }
      case "triangle": case "rtri": case "diamond": case "hexagon": case "star": {
        const P = polyPts(o);
        if (o.f && pointInPoly(x, y, P)) return true;
        for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; if (distSeg(x, y, a[0], a[1], b[0], b[1]) <= t) return true; }
        return false;
      }
      case "axes": {
        const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
        const onV = Math.abs(x - cx) <= t && y >= o.y - t && y <= o.y + o.h + t;
        const onH = Math.abs(y - cy) <= t && x >= o.x - t && x <= o.x + o.w + t;
        const out = x >= o.x - t && x <= o.x + o.w + t && y >= o.y - t && y <= o.y + o.h + t;
        const inn = x > o.x + t && x < o.x + o.w - t && y > o.y + t && y < o.y + o.h - t;
        return onV || onH || (out && !inn);
      }
      case "text": { const b = bbox(o); return x >= b[0] - tol && x <= b[2] + tol && y >= b[1] - tol && y <= b[3] + tol; }
    }
    return false;
  }
  function findHit(w, tol) { const os = pg(key).objs; for (let i = os.length - 1; i >= 0; i--) if (hit(os[i], w[0], w[1], tol)) return os[i]; return null; }
  function translate(o, dx, dy) {
    const n = cl(o);
    if (n.pts) n.pts = n.pts.map((p) => [p[0] + dx, p[1] + dy]);
    if (n.a) { n.a = [n.a[0] + dx, n.a[1] + dy]; n.b = [n.b[0] + dx, n.b[1] + dy]; }
    if (n.x !== undefined) { n.x += dx; n.y += dy; }
    return n;
  }

  /* ---- rendering ---- */
  function head(x, y, ang, len) {
    ctx.beginPath();
    ctx.moveTo(x - len * Math.cos(ang - 0.45), y - len * Math.sin(ang - 0.45)); ctx.lineTo(x, y);
    ctx.lineTo(x - len * Math.cos(ang + 0.45), y - len * Math.sin(ang + 0.45)); ctx.stroke();
  }
  function drawPoly(P, o) {
    ctx.beginPath(); P.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
    if (o.f) { ctx.globalAlpha = 0.3; ctx.fill(); ctx.globalAlpha = 1; }
    ctx.stroke();
  }
  function drawObj(o) {
    ctx.save();
    ctx.strokeStyle = o.c; ctx.fillStyle = o.c; ctx.lineWidth = o.sw; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (o.d) ctx.setLineDash([o.sw * 2.4, o.sw * 2.4]);
    switch (o.type) {
      case "pen": case "hl": {
        if (o.type === "hl") ctx.globalAlpha = 0.35;
        const p = o.pts;
        if (p.length === 1) { ctx.beginPath(); ctx.arc(p[0][0], p[0][1], o.sw / 2, 0, Math.PI * 2); ctx.fill(); }
        else {
          ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
          for (let i = 1; i < p.length - 1; i++) ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
          ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]); ctx.stroke();
        }
        break;
      }
      case "line": case "arrow": case "darrow": {
        ctx.beginPath(); ctx.moveTo(o.a[0], o.a[1]); ctx.lineTo(o.b[0], o.b[1]); ctx.stroke(); ctx.setLineDash([]);
        const ang = Math.atan2(o.b[1] - o.a[1], o.b[0] - o.a[0]), hl = Math.max(12, o.sw * 4);
        if (o.type !== "line") head(o.b[0], o.b[1], ang, hl);
        if (o.type === "darrow") head(o.a[0], o.a[1], ang + Math.PI, hl);
        break;
      }
      case "numline": {
        const y = o.a[1], xa = Math.min(o.a[0], o.b[0]), xb = Math.max(o.a[0], o.b[0]), st = 40;
        ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke();
        head(xb, y, 0, 11); head(xa, y, Math.PI, 11);
        const n = Math.max(1, Math.floor((xb - xa - 24) / st)), x0 = xa + (xb - xa - n * st) / 2, mid = Math.round(n / 2);
        ctx.font = `600 ${Math.max(12, 10 + o.sw * 1.5)}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "top";
        for (let i = 0; i <= n; i++) {
          const x = x0 + i * st;
          ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8); ctx.stroke();
          ctx.fillText(String(i - mid).replace("-", "\u2212"), x, y + 12);
        }
        break;
      }
      case "rect":
        if (o.f) { ctx.globalAlpha = 0.3; ctx.fillRect(o.x, o.y, o.w, o.h); ctx.globalAlpha = 1; }
        ctx.strokeRect(o.x, o.y, o.w, o.h); break;
      case "ellipse":
        ctx.beginPath(); ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, Math.max(o.w / 2, 0.1), Math.max(o.h / 2, 0.1), 0, 0, Math.PI * 2);
        if (o.f) { ctx.globalAlpha = 0.3; ctx.fill(); ctx.globalAlpha = 1; }
        ctx.stroke(); break;
      case "triangle": case "rtri": case "diamond": case "hexagon": case "star":
        drawPoly(polyPts(o), o);
        if (o.type === "rtri" && o.w > 20 && o.h > 20) {
          const m = Math.min(o.w, o.h, 200) * 0.14; ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(o.x, o.y + o.h - m); ctx.lineTo(o.x + m, o.y + o.h - m); ctx.lineTo(o.x + m, o.y + o.h); ctx.stroke();
        }
        break;
      case "axes": {
        const cx = o.x + o.w / 2, cy = o.y + o.h / 2, st = 40;
        ctx.save(); ctx.globalAlpha = 0.22; ctx.lineWidth = Math.max(1, o.sw / 3); ctx.beginPath();
        for (let gx = cx - Math.floor((cx - o.x) / st) * st; gx <= o.x + o.w + 0.1; gx += st) { ctx.moveTo(gx, o.y); ctx.lineTo(gx, o.y + o.h); }
        for (let gy = cy - Math.floor((cy - o.y) / st) * st; gy <= o.y + o.h + 0.1; gy += st) { ctx.moveTo(o.x, gy); ctx.lineTo(o.x + o.w, gy); }
        ctx.stroke(); ctx.restore();
        ctx.beginPath(); ctx.moveTo(o.x, cy); ctx.lineTo(o.x + o.w, cy); ctx.moveTo(cx, o.y); ctx.lineTo(cx, o.y + o.h); ctx.stroke();
        head(o.x + o.w, cy, 0, 11); head(cx, o.y, -Math.PI / 2, 11);
        if (o.w > 120 && o.h > 120) {
          ctx.font = "600 12px sans-serif";
          ctx.textAlign = "center"; ctx.textBaseline = "top";
          for (let k = 1; cx + k * st < o.x + o.w - 16; k++) ctx.fillText(String(k), cx + k * st, cy + 6);
          for (let k = 1; cx - k * st > o.x + 8; k++) ctx.fillText("\u2212" + k, cx - k * st, cy + 6);
          ctx.textAlign = "right"; ctx.textBaseline = "middle";
          for (let k = 1; cy - k * st > o.y + 16; k++) ctx.fillText(String(k), cx - 7, cy - k * st);
          for (let k = 1; cy + k * st < o.y + o.h - 8; k++) ctx.fillText("\u2212" + k, cx - 7, cy + k * st);
          ctx.textBaseline = "top"; ctx.fillText("0", cx - 7, cy + 6);
          ctx.font = "italic 700 14px serif"; ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.fillText("x", o.x + o.w - 12, cy - 8);
          ctx.textBaseline = "top"; ctx.fillText("y", cx + 10, o.y + 4);
        }
        break;
      }
      case "text":
        ctx.font = `${o.fs}px sans-serif`; ctx.textBaseline = "top";
        o.t.split("\n").forEach((l, i) => ctx.fillText(l, o.x, o.y + i * o.fs * 1.25)); break;
    }
    ctx.restore();
  }
  function drawGrid() {
    const g = 40; if (gridStyle === "plain" || view.s < 0.3) return;
    const x0 = -view.x / view.s, y0 = -view.y / view.s, x1 = x0 + cv.width / dpr / view.s, y1 = y0 + cv.height / dpr / view.s;
    if (gridStyle === "dots") {
      const n = ((x1 - x0) / g) * ((y1 - y0) / g); if (n > 25000) return;
      ctx.fillStyle = "#ced4da"; const r = 1.4 / view.s;
      for (let x = Math.floor(x0 / g) * g; x < x1; x += g) for (let y = Math.floor(y0 / g) * g; y < y1; y += g) ctx.fillRect(x - r / 2, y - r / 2, r, r);
      return;
    }
    ctx.strokeStyle = gridStyle === "grid" ? "#d9e2ee" : "#cddaf2"; ctx.lineWidth = 1 / view.s; ctx.beginPath();
    for (let y = Math.floor(y0 / g) * g; y < y1; y += g) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    if (gridStyle === "grid") for (let x = Math.floor(x0 / g) * g; x < x1; x += g) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    ctx.stroke();
    if (gridStyle === "lines") { ctx.strokeStyle = "rgba(239,68,68,.35)"; ctx.beginPath(); ctx.moveTo(80, y0); ctx.lineTo(80, y1); ctx.stroke(); }
  }
  function drawLasers(now) {
    lasers.forEach((L) => {
      if (L.k !== key || !L.pts.length) return;
      ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
      for (let i = 1; i < L.pts.length; i++) {
        const a = L.pts[i - 1], b = L.pts[i], age = (now - b.t) / LASER_MS; if (age >= 1) continue;
        ctx.globalAlpha = (1 - age) * 0.85; ctx.strokeStyle = "#ff3b30"; ctx.lineWidth = (2 + 5 * (1 - age)) / view.s;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      const h = L.pts[L.pts.length - 1], age = (now - h.t) / LASER_MS;
      if (age < 1) {
        const r = 16 / view.s, gr = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, r);
        gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.25, "rgba(255,59,48,1)"); gr.addColorStop(1, "rgba(255,59,48,0)");
        ctx.globalAlpha = 1 - age * 0.7; ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(h.x, h.y, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    });
  }
  let lastZ = "";
  function render() {
    requestAnimationFrame(render);
    const z = Math.round(view.s * 100) + "%"; if (z !== lastZ) { lastZ = z; $("zLbl").textContent = z; }
    if (lasers.size) {
      const now = performance.now();
      lasers.forEach((L, id) => { L.pts = L.pts.filter((p) => now - p.t < LASER_MS); if (!L.pts.length) lasers.delete(id); });
      dirty = true;
    }
    if (!dirty) return; dirty = false;
    const p = pg(key);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = p.bg ? "#e8ecf2" : "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.x, dpr * view.y);
    if (p.bg && p.bg.img.complete && p.bg.img.naturalWidth) {
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, p.bg.w, p.bg.h);
      ctx.drawImage(p.bg.img, 0, 0, p.bg.w, p.bg.h);
      ctx.strokeStyle = "#adb5bd"; ctx.lineWidth = 1 / view.s; ctx.strokeRect(0, 0, p.bg.w, p.bg.h);
    } else if (!p.bg) drawGrid();
    p.objs.forEach(drawObj);
    if (selId) {
      const o = find(selId);
      if (o) {
        const b = bbox(o), pad = 4 / view.s;
        ctx.save(); ctx.setLineDash([6 / view.s, 4 / view.s]); ctx.strokeStyle = "#1a73e8"; ctx.lineWidth = 1.5 / view.s;
        ctx.strokeRect(b[0] - pad, b[1] - pad, b[2] - b[0] + 2 * pad, b[3] - b[1] + 2 * pad); ctx.restore();
      }
    }
    drawLasers(performance.now());
  }
  requestAnimationFrame(render);

  /* ---- view (zoom / pan / fit) ---- */
  function zoomAt(cx, cy, f) {
    const ns = clamp(view.s * f, 0.1, 8), r = ns / view.s;
    view.x = cx - (cx - view.x) * r; view.y = cy - (cy - view.y) * r; view.s = ns; dirty = true;
  }
  function fitView() {
    const r = wrap.getBoundingClientRect(), b = pg(key).bg;
    if (b) { const s = Math.min((r.width - 40) / b.w, (r.height - 40) / b.h); view.s = s; view.x = (r.width - b.w * s) / 2; view.y = (r.height - b.h * s) / 2; }
    else { view.s = 1; view.x = 0; view.y = 0; }
    dirty = true;
  }
  $("zIn").onclick = () => { const r = wrap.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.25); };
  $("zOut").onclick = () => { const r = wrap.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 0.8); };
  $("zFit").onclick = fitView;
  cv.addEventListener("wheel", (e) => {
    e.preventDefault(); const s = scr(e);
    if (e.ctrlKey || e.metaKey) zoomAt(s[0], s[1], Math.exp(-e.deltaY * (Math.abs(e.deltaY) < 30 ? 0.01 : 0.0025)));
    else if (e.shiftKey) view.x -= e.deltaY;
    else { view.x -= e.deltaX; view.y -= e.deltaY; }
    dirty = true;
  }, { passive: false });

  /* ---- pages / PDF ---- */
  function switchPage(k, fit) {
    commitText(); key = k; selId = null;
    if (fit) fitView();
    dirty = true; updUI();
  }
  function broadcastPage(k) {
    if (!$("share").checked) return;
    const b = pg(k).bg;
    if (k !== "board" && b && !sentBg.has(k)) { bcast({ t: "bg", k, img: b.data, w: b.w, h: b.h }); sentBg.add(k); }
    bcast({ t: "page", k, n: pdfInfo.n, total: pdfInfo.total });
  }
  async function gotoPdfPage(n) {
    if (!pdfDoc) return;
    n = clamp(n, 1, pdfDoc.numPages);
    const k = `pdf${pdfId}:${n}`;
    if (!pg(k).bg) {
      const page = await pdfDoc.getPage(n), v1 = page.getViewport({ scale: 1 });
      const sc = 1200 / v1.width, vp = page.getViewport({ scale: sc });
      const c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      setBg(k, c.toDataURL("image/jpeg", 0.72), 1000, 1000 * v1.height / v1.width);
    }
    pdfInfo = { n, total: pdfDoc.numPages };
    switchPage(k, true); broadcastPage(k);
  }
  $("pdfBtn").onclick = () => $("pdfFile").click();
  $("pdfFile").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    if (typeof pdfjsLib === "undefined") { alert("The PDF library could not be loaded. Check your internet connection."); return; }
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      pdfDoc = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
      pdfId = uid().slice(0, 5); await gotoPdfPage(1);
    } catch (err) { console.error(err); alert("Could not open that PDF."); }
  };
  $("pPrev").onclick = () => gotoPdfPage(pdfInfo.n - 1);
  $("pNext").onclick = () => gotoPdfPage(pdfInfo.n + 1);
  $("pBoard").onclick = () => { switchPage("board", true); broadcastPage("board"); };

  /* ---- board background menu (dots / squares / lines / plain) ---- */
  function markGrid() { document.querySelectorAll("#gridMenu [data-grid]").forEach((b) => { const on = b.dataset.grid === gridStyle; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); }); }
  function setGridStyle(v, remote) {
    if (!GRIDS.includes(v)) return;
    gridStyle = v; dirty = true; markGrid();
    if (isHost && !remote) bcast({ t: "grid", v });
  }
  $("gridBtn").onclick = () => { const m = $("gridMenu"); if (m.classList.contains("show")) { m.classList.remove("show"); return; } markGrid(); placeBelow(m, $("gridBtn")); };
  document.querySelectorAll("#gridMenu [data-grid]").forEach((b) => b.addEventListener("click", () => { setGridStyle(b.dataset.grid); $("gridMenu").classList.remove("show"); }));

  /* ---- toolbar wiring ---- */
  const COLORS = ["#111111", "#e03131", "#f08c00", "#2f9e44", "#1971c2", "#9c36b5", "#868e96", "#ffffff"];
  COLORS.forEach((c) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "sw"; b.style.background = c; b.dataset.c = c; b.title = c; b.setAttribute("aria-label", "Colour " + c);
    b.onclick = () => setColor(c); $("colors").insertBefore(b, $("colorPick"));
  });
  function updSizePrev() { const i = $("sizePrev"), d = clamp(S.size, 2, 24); i.style.width = i.style.height = d + "px"; i.style.background = S.color; }
  function setColor(c) {
    S.color = c; $("colorPick").value = c; updSizePrev();
    document.querySelectorAll(".sw").forEach((b) => b.classList.toggle("active", b.dataset.c === c));
    if (selId) { const o = find(selId); if (o) { const before = cl(o), after = cl(o); after.c = c; if (after.f) after.f = c; opPut(key, after); pushUndo(key, { undo: () => opPut(key, cl(before)), redo: () => opPut(key, cl(after)) }); } }
  }
  $("colorPick").oninput = (e) => setColor(e.target.value);
  $("size").oninput = (e) => { S.size = +e.target.value; $("sizeLbl").textContent = S.size; updSizePrev(); };
  $("fillBtn").onclick = () => { S.fill = !S.fill; $("fillBtn").setAttribute("aria-pressed", String(S.fill)); };
  $("dashBtn").onclick = () => { S.dash = !S.dash; $("dashBtn").setAttribute("aria-pressed", String(S.dash)); };
  $("undoBtn").onclick = undo; $("redoBtn").onclick = redo;
  $("clearBtn").onclick = () => {
    const k = key, old = cl(pg(k).objs); if (!old.length) return;
    if (!confirm("Clear this page for everyone?")) return;
    opClear(k);
    pushUndo(k, { undo: () => old.forEach((o) => opPut(k, cl(o))), redo: () => opClear(k) });
  };
  $("saveBtn").onclick = () => { dirty = true; render1(); const a = document.createElement("a"); a.href = cv.toDataURL("image/png"); a.download = "whiteboard.png"; a.click(); };
  function render1() { /* the animation loop redraws on the next frame; nothing extra needed */ }

  const lastOf = { shapes: "rect", math: "numline" };
  function closeFlies() { $("flyShapes").classList.remove("show"); $("flyMath").classList.remove("show"); }
  function updStyleBar() {
    const t = S.tool, closed = CLOSED.includes(t), lineish = ["line", "arrow", "darrow"].includes(t);
    $("styleBar").hidden = t === "hand" || t === "laser";
    $("colors").hidden = t === "eraser";
    $("sizeWrap").hidden = t === "select";
    $("fillBtn").hidden = !closed; $("dashBtn").hidden = !(closed || lineish);
    document.querySelector('#styleBar [data-for="size"]').hidden = $("sizeWrap").hidden || $("colors").hidden;
    document.querySelector('#styleBar [data-for="toggles"]').hidden = $("fillBtn").hidden && $("dashBtn").hidden;
  }
  function setTool(t) {
    commitText(); S.tool = t; if (t !== "select") selId = null;
    document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
    const inS = SHAPE_TOOLS.includes(t), inM = MATH_TOOLS.includes(t);
    if (inS) { lastOf.shapes = t; setIcon($("grpShapes"), t); }
    if (inM) { lastOf.math = t; setIcon($("grpMath"), t); }
    $("grpShapes").classList.toggle("active", inS); $("grpMath").classList.toggle("active", inM);
    closeFlies();
    cv.style.cursor = { select: "default", hand: "grab", text: "text", eraser: "cell" }[t] || "crosshair";
    updStyleBar(); dirty = true;
  }
  document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  [["grpShapes", "flyShapes", "shapes", SHAPE_TOOLS], ["grpMath", "flyMath", "math", MATH_TOOLS]].forEach(([btn, fly, grp, list]) => {
    $(btn).addEventListener("click", () => {
      const inGroup = list.includes(S.tool), wasOpen = $(fly).classList.contains("show");
      if (!inGroup) setTool(lastOf[grp]);
      if (wasOpen && inGroup) { closeFlies(); return; }
      const f = $(fly); f.classList.add("show");
      const br = $(btn).getBoundingClientRect(), mr = $("bmain").getBoundingClientRect();
      f.style.left = br.right - mr.left + 8 + "px";
      f.style.top = clamp(br.top - mr.top, 0, Math.max(0, mr.height - f.offsetHeight)) + "px";
    });
  });
  // close popovers when clicking elsewhere
  document.addEventListener("pointerdown", (e) => {
    const t = e.target; if (!t || !t.closest) return;
    if (!t.closest("#bgPanel, #fxBtn")) $("bgPanel").classList.remove("show");
    if (!t.closest("#gridMenu, #gridBtn")) $("gridMenu").classList.remove("show");
    if (!t.closest(".fly, .tgrp")) closeFlies();
  }, true);

  function updUI() {
    const p = pg(key);
    $("undoBtn").disabled = !canDraw || !p.undo.length; $("redoBtn").disabled = !canDraw || !p.redo.length;
    $("pLbl").textContent = key === "board" ? "Board" : `Page ${pdfInfo.n} of ${pdfInfo.total}`;
    $("pPrev").disabled = !canDraw || !pdfDoc || pdfInfo.n <= 1;
    $("pNext").disabled = !canDraw || !pdfDoc || pdfInfo.n >= (pdfDoc ? pdfDoc.numPages : 1);
    $("pBoard").disabled = !canDraw || key === "board";
  }

  /* ---- text tool ---- */
  let txt = null;
  function startText(s, w) {
    const el = document.createElement("textarea"), fs = 14 + S.size * 2;
    el.id = "wb-text"; el.style.left = s[0] + "px"; el.style.top = s[1] + "px"; el.style.fontSize = fs * view.s + "px"; el.style.color = S.color;
    wrap.append(el); txt = { el, x: w[0], y: w[1], fs, c: S.color, k: key };
    el.addEventListener("input", () => { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; });
    el.addEventListener("blur", commitText);
    el.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") { el.value = ""; commitText(); }
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) commitText();
    });
    setTimeout(() => el.focus(), 0);
  }
  function commitText() {
    if (!txt) return; const { el, x, y, fs, c, k } = txt; txt = null;
    const v = el.value.replace(/\s+$/, ""); el.remove(); if (!v) return;
    const o = { id: uid(), type: "text", x, y, t: v, c, fs };
    opPut(k, o); pushUndo(k, addAction(k, cl(o)));
  }

  /* ---- pointer interaction ---- */
  let mode = null, cur = null, curKey = null, start = null, panSt = null, moveSt = null, erased = [];
  let penBuf = null, lastPut = 0, lastLaser = 0;
  const scr = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const wor = (s) => [(s[0] - view.x) / view.s, (s[1] - view.y) / view.s];
  function livePut(o, force) { const now = performance.now(); if (force || now - lastPut > 60) { lastPut = now; bcast({ t: "put", k: curKey, o }); } }
  function flushPen() { if (penBuf && penBuf.pts.length) { bcast({ t: "pt", k: penBuf.k, id: penBuf.id, p: penBuf.pts }); penBuf.pts = []; } }
  setInterval(flushPen, 50);
  function sendLaser(w) {
    addLaser(myId || "self", key, w[0], w[1]);
    const now = performance.now(); if (now - lastLaser < 32) return; lastLaser = now;
    bcast({ t: "laser", k: key, x: Math.round(w[0] * 10) / 10, y: Math.round(w[1] * 10) / 10, u: myId });
  }

  function newShape(t, w) {
    const base = { id: uid(), type: t, c: S.color, sw: S.size, d: S.dash && t !== "numline" && t !== "axes" ? 1 : 0 };
    if (LINEISH.includes(t)) return Object.assign(base, { a: [w[0], w[1]], b: [w[0], w[1]] });
    return Object.assign(base, { f: CLOSED.includes(t) && S.fill ? S.color : null, x: w[0], y: w[1], w: 0, h: 0 });
  }
  function setGeom(o, st, w, shift) {
    let dx = w[0] - st[0], dy = w[1] - st[1];
    if (o.a) {
      if (o.type === "numline") dy = 0;
      if (shift) { const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), l = Math.hypot(dx, dy); dx = l * Math.cos(ang); dy = l * Math.sin(ang); }
      o.a = [st[0], st[1]]; o.b = [st[0] + dx, st[1] + dy];
    } else {
      if (shift) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; }
      o.x = Math.min(st[0], st[0] + dx); o.y = Math.min(st[1], st[1] + dy); o.w = Math.abs(dx); o.h = Math.abs(dy);
    }
  }
  function eraseAt(w) {
    const p = pg(curKey), tol = (S.size * 1.5 + 5) / view.s, gone = [];
    for (let i = p.objs.length - 1; i >= 0; i--) if (hit(p.objs[i], w[0], w[1], tol)) gone.push(p.objs[i]);
    if (gone.length) {
      const ids = gone.map((o) => o.id); erased.push(...gone.map(cl));
      applyDel(curKey, ids); bcast({ t: "del", k: curKey, ids }); dirty = true;
    }
  }

  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  cv.addEventListener("pointerdown", (e) => {
    e.preventDefault(); commitText(); cv.setPointerCapture(e.pointerId);
    const s = scr(e), w = wor(s), p = pg(key);
    if (e.button === 1 || e.button === 2 || S.tool === "hand" || spaceDown) { mode = "pan"; panSt = { s, x: view.x, y: view.y }; cv.style.cursor = "grabbing"; return; }
    if (e.button !== 0 || !canDraw) return;
    curKey = key; const t = S.tool;
    if (t === "laser") { sendLaser(w); return; }
    if (t === "pen" || t === "hl") {
      cur = { id: uid(), type: t, c: S.color, sw: t === "hl" ? S.size * 4 : S.size, pts: [w] };
      p.objs.push(cur); mode = "draw"; bcast({ t: "put", k: curKey, o: cur }); penBuf = { k: curKey, id: cur.id, pts: [] };
    } else if (SHAPES_ALL.includes(t)) {
      start = w; cur = newShape(t, w); p.objs.push(cur); mode = "shape";
    } else if (t === "select") {
      const o = findHit(w, 6 / view.s);
      if (o) { selId = o.id; mode = "move"; moveSt = { orig: cl(o), start: w, moved: false }; } else selId = null;
    } else if (t === "eraser") { mode = "erase"; erased = []; eraseAt(w); }
    else if (t === "text") startText(s, w);
    dirty = true;
  });
  cv.addEventListener("pointermove", (e) => {
    if (S.tool === "laser" && canDraw && !mode) { sendLaser(wor(scr(e))); return; }
    if (!mode) return;
    const s = scr(e), w = wor(s);
    if (mode === "pan") { view.x = panSt.x + (s[0] - panSt.s[0]); view.y = panSt.y + (s[1] - panSt.s[1]); }
    else if (mode === "draw") {
      const l = cur.pts[cur.pts.length - 1];
      if (Math.hypot(w[0] - l[0], w[1] - l[1]) >= 1.2 / view.s) { cur.pts.push(w); penBuf.pts.push(w); }
    } else if (mode === "shape") { setGeom(cur, start, w, e.shiftKey); livePut(cur); }
    else if (mode === "move") {
      const dx = w[0] - moveSt.start[0], dy = w[1] - moveSt.start[1];
      if (dx || dy) { moveSt.moved = true; const n = translate(moveSt.orig, dx, dy); applyPut(curKey, n); livePut(n); }
    } else if (mode === "erase") eraseAt(w);
    dirty = true;
  });
  function endPointer() {
    if (!mode) return;
    const k = curKey;
    if (mode === "draw") { flushPen(); bcast({ t: "put", k, o: cur }); pushUndo(k, addAction(k, cl(cur))); }
    else if (mode === "shape") {
      const tiny = cur.a ? Math.hypot(cur.b[0] - cur.a[0], cur.b[1] - cur.a[1]) < 2 / view.s : (cur.w < 2 / view.s && cur.h < 2 / view.s);
      if (tiny) { applyDel(k, [cur.id]); bcast({ t: "del", k, ids: [cur.id] }); }
      else { bcast({ t: "put", k, o: cur }); pushUndo(k, addAction(k, cl(cur))); }
    } else if (mode === "move" && moveSt.moved) {
      const o = find(selId);
      if (o) { const before = moveSt.orig, after = cl(o); bcast({ t: "put", k, o: after }); pushUndo(k, { undo: () => opPut(k, cl(before)), redo: () => opPut(k, cl(after)) }); }
    } else if (mode === "erase" && erased.length) {
      const list = erased.slice();
      pushUndo(k, { undo: () => list.forEach((o) => opPut(k, cl(o))), redo: () => opDel(k, list.map((o) => o.id)) });
    }
    mode = null; cur = null; penBuf = null; setTool(S.tool); dirty = true; updUI();
  }
  cv.addEventListener("pointerup", endPointer);
  cv.addEventListener("pointercancel", endPointer);

  /* ---- keyboard shortcuts ---- */
  const KEYS = { v: "select", h: "hand", k: "laser", p: "pen", m: "hl", e: "eraser", l: "line", a: "arrow", r: "rect", o: "ellipse", t: "text" };
  window.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (e.code === "Space") { spaceDown = true; e.preventDefault(); return; }
    if (!canDraw) { if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "h") setTool("hand"); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && selId) {
      const o = find(selId); if (o) { const k = key, c = cl(o); opDel(k, [c.id]); pushUndo(k, { undo: () => opPut(k, cl(c)), redo: () => opDel(k, [c.id]) }); }
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && KEYS[e.key.toLowerCase()]) setTool(KEYS[e.key.toLowerCase()]);
  });
  window.addEventListener("keyup", (e) => { if (e.code === "Space") spaceDown = false; });

  /* ---- host login + people panel ---- */
  const avColor = (name) => { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 48% 40%)`; };
  const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => (w[0] || "").toUpperCase()).join("") || "?";
  function renderPerm() {
    const box = $("permList"); box.innerHTML = "";
    $("allowAll").checked = allowAll; $("lockClass").checked = locked; $("chatOnChk").checked = chatOn;
    const list = []; peers.forEach((p, id) => { if (p.conn && p.conn.open) list.push({ id, p }); });
    $("pCount").textContent = `${list.length} student${list.length === 1 ? "" : "s"} online`;
    if (!list.length) { const e = document.createElement("div"); e.className = "muted2"; e.style.padding = "14px 0"; e.textContent = "No students have joined yet. Use Invite to share the class link."; box.append(e); return; }
    list.forEach(({ id, p }) => {
      const row = document.createElement("div"); row.className = "prow";
      const av = document.createElement("span"); av.className = "av"; av.textContent = initials(p.name); av.style.background = avColor(p.name); row.append(av);
      const pn = document.createElement("span"); pn.className = "pn"; pn.textContent = p.name || "Student";
      if (p.att) { const sm = document.createElement("small"); sm.textContent = "Joined " + p.att.joined.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); pn.append(sm); }
      row.append(pn);
      const btn = (cls, ic, title, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "ib " + cls; b.title = title; b.setAttribute("aria-label", title); b.append(icon(ic)); b.onclick = fn; return b; };
      if (p.hand) { const h = btn("hd", "hand", "Lower this student's hand", () => lowerHand(id)); h.append(document.createTextNode("Lower")); row.append(h); }
      const canPen = allowAll || allowed.has(id);
      const d = btn(canPen ? "on" : "", "pen", allowAll ? "Everyone can draw" : "Allow this student to draw", () => { if (allowed.has(id)) allowed.delete(id); else allowed.add(id); sendPerm(); renderPerm(); });
      d.disabled = allowAll; d.setAttribute("aria-pressed", String(canPen)); row.append(d);
      row.append(btn("", "mic-off", "Mute this student's microphone", () => { bcast({ t: "mute" }, [id]); toast(`Muted ${p.name}`, { ms: 2000 }); }));
      row.append(btn("danger", "x", "Remove from class", () => removeStudent(id, p.name)));
      box.append(row);
    });
  }
  function removeStudent(id, name) {
    if (!confirm(`Remove ${name || "this student"} from the class?`)) return;
    rejected.add(id); bcast({ t: "kick", reason: "removed" }, [id]);
    setTimeout(() => dropStudent(id), 500);
  }
  $("muteAll").onclick = () => { bcast({ t: "mute" }); toast("Muted all students.", { ms: 2500 }); };
  $("lockClass").onchange = (e) => { locked = e.target.checked; if (!locked) turnedAway.clear(); toast(locked ? "Class locked. No new students can join." : "Class unlocked.", { ms: 2500 }); };
  $("chatOnChk").onchange = (e) => { chatEnabled(e.target.checked); bcast({ t: "chatlock", on: chatOn }); toast(chatOn ? "Student chat is on." : "Student chat is off.", { ms: 2500 }); };
  $("attDl").onclick = () => { if (!attendance.length) { toast("No attendance yet."); return; } downloadAttendance(); };
  const csvCell = (v) => { let t = String(v == null ? "" : v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
  function downloadAttendance() {
    const now = new Date(), fmt = (d) => d.toLocaleString();
    const rows = [[`Class: ${APP_NAME}`], [`Room: ${ROOM_ID}`], [`Teacher: ${teacherName}`], [`Date: ${now.toLocaleDateString()}`], [], ["Name", "Joined", "Left", "Minutes present"]];
    attendance.forEach((a) => rows.push([a.name, fmt(a.joined), a.left ? fmt(a.left) : "(still in class)", Math.round(((a.left || now) - a.joined) / 60000)]));
    const csv = "\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
    saveBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `attendance-${ROOM_ID}-${now.toISOString().slice(0, 10)}.csv`);
  }

  /* ---- recording (teacher) ---- */
  let recorder = null, recDisp = null, recCtx = null, recTimer = null;
  async function startRecording() {
    if (typeof MediaRecorder === "undefined" || !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) { toast("Recording is not supported in this browser. Use desktop Chrome or Edge.", { type: "bad" }); return; }
    toast("In the next window choose “This tab” and tick “Share tab audio” so students' voices are recorded too.", { ms: 7000 });
    try { recDisp = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: true, preferCurrentTab: true, selfBrowserSurface: "include" }); }
    catch (e) { recDisp = null; return; }
    try {
      recCtx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = recCtx.createMediaStreamDestination();
      const da = recDisp.getAudioTracks()[0]; if (da) recCtx.createMediaStreamSource(new MediaStream([da])).connect(dest); else toast("No tab audio was shared, so only your microphone is recorded.", { type: "warn" });
      const mic = localStream.getAudioTracks()[0]; if (mic) recCtx.createMediaStreamSource(new MediaStream([mic])).connect(dest);
      const out = new MediaStream([...recDisp.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
      const chunks = [];
      recorder = new MediaRecorder(out, mime ? { mimeType: mime, videoBitsPerSecond: 1500000 } : { videoBitsPerSecond: 1500000 });
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        const ext = /mp4/.test(recorder.mimeType) ? "mp4" : "webm";
        const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
        try { recDisp && recDisp.getTracks().forEach((t) => t.stop()); recCtx && recCtx.close(); } catch (e) { /* ignore */ }
        clearInterval(recTimer); recorder = null; recDisp = null; recCtx = null;
        $("recBtn").classList.remove("rec"); $("recBtn").querySelector(".lbl").textContent = "Record"; setIcon($("recBtn"), "rec");
        showRec(false); if (!ended) bcast({ t: "rec", on: false });
        if (blob.size) { saveBlob(blob, `class-${ROOM_ID}-${teacherName.replace(/[^A-Za-z0-9]+/g, "").slice(0, 20) || "teacher"}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.${ext}`); toast("Recording saved to your Downloads folder.", { ms: 6000 }); }
      };
      recDisp.getVideoTracks()[0].onended = stopRecording;
      recorder.start(10000);
      const t0 = Date.now();
      const tick = () => { const sec = Math.floor((Date.now() - t0) / 1000); $("recBtn").querySelector(".lbl").textContent = `Stop ${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`; };
      $("recBtn").classList.add("rec"); setIcon($("recBtn"), "stop"); tick(); recTimer = setInterval(tick, 1000);
      showRec(true); bcast({ t: "rec", on: true });
    } catch (e) {
      console.warn(e); toast("Could not start recording.", { type: "bad" });
      try { recDisp && recDisp.getTracks().forEach((t) => t.stop()); } catch (e2) { /* ignore */ } recorder = null; recDisp = null;
    }
  }
  function stopRecording() { if (recorder && recorder.state !== "inactive") recorder.stop(); }
  function finishRecording() { stopRecording(); }
  $("recBtn").onclick = () => (recorder ? stopRecording() : startRecording());

  /* ---- reliability: keep screen awake, warn before closing, network status ---- */
  let wl = null;
  async function keepAwake() { try { if ("wakeLock" in navigator) wl = await navigator.wakeLock.request("screen"); } catch (e) { /* ignore */ } }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !ended && localStream) keepAwake(); });
  window.addEventListener("beforeunload", (e) => { if (isHost && !ended) { e.preventDefault(); e.returnValue = ""; } });
  window.addEventListener("offline", () => { netBad(true); toast("You are offline. Reconnecting when your internet returns…", { type: "bad", ms: 4000 }); });
  window.addEventListener("online", () => {
    netBad(false); toast("Back online.", { ms: 2500 });
    try { if (peer && peer.disconnected && !peer.destroyed) peer.reconnect(); } catch (e) { /* ignore */ }
  });
  function refreshPerm() { $("pBadge").textContent = String(targets().length); if ($("permPanel").classList.contains("show")) renderPerm(); }
  $("allowAll").onchange = (e) => { allowAll = e.target.checked; sendPerm(); renderPerm(); };
  $("permBtn").onclick = () => { $("sharePanel").classList.remove("show"); const pn = $("permPanel"); pn.classList.toggle("show"); if (pn.classList.contains("show")) renderPerm(); syncPanelBtns(); };
  $("showAll").onchange = (e) => { if (e.target.checked) bcast({ t: "mode", m: main.dataset.mode }); };

  /* ---- share class link (teacher only) ---- */
  const SHARE_KEY = "meeting-share-base";
  const isLocalUrl = (u) => /^(file:|https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.))/i.test((u || "").trim());
  const baseUrl = () => PUBLIC_URL || (location.protocol === "file:" ? location.href.split(/[?#]/)[0] : location.origin + location.pathname);
  const makeLink = (base) => `${base.split(/[?#]/)[0]}?room=${encodeURIComponent(ROOM_ID)}&role=student`;
  const shareMsg = (t) => { $("shareMsg").textContent = t; if (t) setTimeout(() => { if ($("shareMsg").textContent === t) $("shareMsg").textContent = ""; }, 2500); };
  const shareText = () => `Join my class${APP_NAME ? " on " + APP_NAME : ""}: ${$("shareUrl").value.trim()}`;
  function updShareWarn() {
    $("shareWarn").classList.toggle("show", isLocalUrl($("shareUrl").value));
    try { localStorage.setItem(SHARE_KEY, $("shareUrl").value.trim().split(/[?#]/)[0]); } catch (err) { /* storage may be unavailable */ }
  }
  function fillShareUrl() {
    let saved = ""; try { saved = localStorage.getItem(SHARE_KEY) || ""; } catch (err) { /* ignore */ }
    const cur = baseUrl();
    $("shareUrl").value = makeLink(PUBLIC_URL || (isLocalUrl(cur) && saved ? saved : cur));
    updShareWarn();
  }
  $("shareBtn").onclick = () => {
    $("permPanel").classList.remove("show");
    const pn = $("sharePanel"); pn.classList.toggle("show"); syncPanelBtns();
    if (!pn.classList.contains("show")) return;
    $("shareNative").style.display = navigator.share ? "" : "none";
    fillShareUrl();
    $("shareUrl").focus(); $("shareUrl").select();
  };
  $("shareUrl").addEventListener("input", updShareWarn);
  $("shareCopy").onclick = async () => {
    const url = $("shareUrl").value.trim();
    if (!url) { shareMsg("Enter a link first"); return; }
    try {
      await navigator.clipboard.writeText(url);
      shareMsg("Link copied");
    } catch (err) {
      $("shareUrl").select();
      let ok = false; try { ok = document.execCommand("copy"); } catch (e2) { /* ignore */ }
      shareMsg(ok ? "Link copied" : "Press Ctrl+C to copy the selected link");
    }
  };
  $("shareNative").onclick = () => {
    const url = $("shareUrl").value.trim();
    if (navigator.share) navigator.share({ title: APP_NAME, text: "Join my class", url }).catch(() => {});
  };
  $("shareWa").onclick = () => window.open("https://wa.me/?text=" + encodeURIComponent(shareText()), "_blank", "noopener");
  $("shareMail").onclick = () => { location.href = "mailto:?subject=" + encodeURIComponent("Class invitation") + "&body=" + encodeURIComponent(shareText()); };

  /* ---- init ---- */
  setColor("#111111"); setTool("pen"); setMode("video"); resizeCanvas(); recalc(); updUI(); markGrid(); updSizePrev();
});
})();
