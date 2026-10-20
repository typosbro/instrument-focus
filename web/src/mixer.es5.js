(function () {
"use strict";

/* ---------------------------------------------------------------------------
   A7 - one self-contained page. The manifest and every live stem are baked
   into this file: no network calls of any kind, no external URL, no worker.
   Audio arrives as base64 MP3, is turned into bytes with atob and handed to
   decodeAudioData; nothing touches the network.

   The JS is deliberately ES5 (var, function, string concat, callback
   decodeAudioData) so Safari on macOS can run it from file://.
   --------------------------------------------------------------------------- */

var MANIFEST = __MANIFEST_JSON__;
var STEM_B64 = __STEM_JSON__;

var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
var dbToLin = function (d) { return Math.pow(10, d / 20); };
var linToDb = function (v) { return 20 * Math.log(Math.max(v, 1e-9)) / Math.LN10; };
var el = function (id) { return document.getElementById(id); };
var RAMP = 0.055;
var PALETTE = [[255,179,107],[255,219,175],[150,214,188],[150,192,214],
               [198,170,220],[210,140,130],[170,210,140],[230,200,130]];

var MAN = null, T0 = 0, DUR = 6;
var STEMS = [], INFO = {}, LIVE = {}, COLORS = {}, PRESETS = {}, PRESET_ORDER = [], LIVE_LIST = [];
var S = { gains: {}, preset: null, mute: {}, solo: {}, nSolo: 0, focus: null,
          monitor: 0, playing: false, t: 0, audio: false, trim: 0 };
var ACTX = null, MASTER = null, LIM = null, ANA = null, ANABUF = null;
var BUFS = {}, SRC = {}, GN = {}, SHA = {};
var startedAt = 0, offset = 0;
var ENV = {}, WAVE = {}, UI = {};
var BLOCKED = false, ARMED = false;

/* ------------------------------------------------------------------ state -- */
function liveCount() {
  var n = 0;
  for (var i = 0; i < STEMS.length; i++) if (LIVE[STEMS[i]]) n++;
  return n;
}
function copyGains(g) {
  var out = {};
  for (var i = 0; i < STEMS.length; i++) {
    var n = STEMS[i];
    out[n] = (g[n] == null) ? 0 : g[n];
  }
  return out;
}
function copyObj(o) {
  var out = {};
  for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
  return out;
}

function applyManifest(m) {
  MAN = m; T0 = m.window.start; DUR = m.window.dur;
  var stems = m.stems.slice();
  /* live strips first, dead strips parked at the right end */
  stems.sort(function (a, b) {
    if (a.present === b.present) return 0;
    return a.present ? -1 : 1;
  });
  for (var i = 0; i < stems.length; i++) {
    var s = stems[i];
    STEMS.push(s.id); INFO[s.id] = s; LIVE[s.id] = !!s.present;
    COLORS[s.id] = s.present ? PALETTE[i % PALETTE.length] : [120, 130, 140];
    if (s.present) {
      if (s.solo_gain_db == null) s.solo_gain_db = 0;
      LIVE_LIST.push(s.id);
    }
  }
  for (i = 0; i < m.presets.length; i++) {
    var p = m.presets[i];
    PRESETS[p.id] = p;
    PRESET_ORDER.push(p.id);
  }
  var first = PRESETS.balanced ? "balanced" : PRESET_ORDER[0];
  /* the hero preset is the first featured one, not the flat one */
  for (i = 0; i < PRESET_ORDER.length; i++) {
    if (PRESETS[PRESET_ORDER[i]].featured) { first = PRESET_ORDER[i]; break; }
  }
  S.preset = first;
  S.gains = copyGains(PRESETS[first].gains);
  S.trim = PRESETS[first].trim_db;
  S.focus = LIVE_LIST.length ? LIVE_LIST[0] : STEMS[0];
}

function refreshFound() {
  var live = liveCount(), dead = STEMS.length - live;
  el("found").innerHTML = "FOUND <b>" + live + " / " + STEMS.length + "</b> STEMS";
  var hf = el("hintFound");
  if (hf) hf.textContent = dead
    ? dead + " STEM" + (dead === 1 ? "" : "S") + " CARRY NO SIGNAL"
    : "ALL STEMS CARRY SIGNAL";
}

/* --------------------------------------------------------------------- UI -- */
function buildUI() {
  el("songLine").textContent = MAN.song + "  \u00b7  " + T0.toFixed(1) + " \u2013 " +
    (T0 + DUR).toFixed(1) + " s";
  var sc = el("scrub");
  sc.setAttribute("aria-valuemin", T0.toFixed(1));
  sc.setAttribute("aria-valuemax", (T0 + DUR).toFixed(1));
  sc.setAttribute("aria-valuenow", (T0 + 0.4).toFixed(1));
  document.title = "Instrument Focus Mixer \u00b7 " + MAN.song;
  var loopSpan = document.querySelector(".loop span");
  if (loopSpan) loopSpan.textContent = "LOOP " + DUR.toFixed(1);

  var bank = el("bank");
  bank.style.setProperty("--n", STEMS.length);
  bank.innerHTML = "";

  var TICKS = [[12,"+12",1],[6,"+6",0],[0,"0",1],[-6,"-6",0],[-12,"-12",1],
               [-24,"-24",1],[-36,"-36",0],[-48,"-48",1],[-60,"-60",0]];
  var ticks = "";
  for (var t = 0; t < TICKS.length; t++) {
    var top = ((12 - TICKS[t][0]) / 72 * 100);
    ticks += '<i class="' + (TICKS[t][2] ? "major" : "") + '" style="top:' + top + '%"></i>';
    if (TICKS[t][1]) ticks += '<b style="top:' + top + '%">' + TICKS[t][1] + "</b>";
  }
  var segHtml = "";
  for (var q = 0; q < 45; q++) segHtml += "<i></i>";

  for (var si = 0; si < STEMS.length; si++) {
    (function (n) {
      var s = INFO[n];
      var ch = document.createElement("div");
      ch.className = "ch" + (LIVE[n] ? "" : " dead");
      ch.setAttribute("data-stem", n);
      ch.innerHTML =
        '<div class="ch-glow"></div><div class="ch-led"></div>' +
        '<div class="ch-head"><div class="ch-name">' + s.label + "</div>" +
          '<div class="ch-sub">' + (LIVE[n] ? "SONG RMS " + s.rms_db.toFixed(1) + " dB"
                                           : "NO SIGNAL IN SOURCE") + "</div></div>" +
        '<div class="ch-body">' +
          '<div class="meter">' + segHtml + '<div class="peak"></div></div>' +
          '<div class="fader" role="slider" tabindex="0" aria-label="' + s.label + ' gain" ' +
            'aria-valuemin="-60" aria-valuemax="12" aria-valuenow="0" aria-valuetext="0 dB">' +
            '<div class="slot"></div><div class="cap"><span></span></div>' +
            '<div class="ticks">' + ticks + "</div>" +
          "</div>" +
        "</div>" +
        '<div class="readout"><b>+0.0</b><i>dB</i></div>' +
        '<div class="ch-btns">' +
          '<button class="mbtn mute" data-act="mute" title="mute">M</button>' +
          '<button class="sbtn solo" data-act="solo" title="solo">S</button>' +
        "</div>";
      bank.appendChild(ch);

      var segs = ch.querySelectorAll(".meter i"), arr = [];
      for (var k = 0; k < segs.length; k++) arr.push(segs[k]);
      UI[n] = {
        ch: ch, name: ch.querySelector(".ch-name"),
        segs: arr,
        peak: ch.querySelector(".meter .peak"),
        cap: ch.querySelector(".cap"), fader: ch.querySelector(".fader"),
        val: ch.querySelector(".readout b"),
        mb: ch.querySelector(".mbtn"), sb: ch.querySelector(".sbtn")
      };
      if (!LIVE[n]) { UI[n].mb.disabled = true; UI[n].sb.disabled = true; }
      var inlay = ch.querySelector(".cap span");
      if (inlay) inlay.style.background = "rgb(" + COLORS[n].join(",") + ")";
      ch.addEventListener("pointerdown", function () { S.focus = n; paintPreset(); });
      bindFader(n);
      UI[n].mb.addEventListener("click", function () { toggleMute(n); });
      UI[n].sb.addEventListener("click", function () { toggleSolo(n); });
    })(STEMS[si]);
  }

  var wrap = el("presets");
  wrap.className = PRESET_ORDER.length > 5 ? "presets tight" : "presets";
  wrap.innerHTML = "";
  for (var pi = 0; pi < PRESET_ORDER.length; pi++) {
    (function (id) {
      var p = PRESETS[id];
      var b = document.createElement("button");
      b.className = "preset";
      b.setAttribute("data-p", id);
      b.innerHTML = '<i class="led"></i><b>' + p.label + "</b><em>" +
        (p.featured ? "+" + MAN.emphasis.featured_db.toFixed(0) + " / " +
          MAN.emphasis.others_db.toFixed(0) : "FLAT \u00b7 0") + "</em>";
      b.addEventListener("click", function () { setPreset(id, false); });
      wrap.appendChild(b);
    })(PRESET_ORDER[pi]);
  }

  el("hint").innerHTML =
    "1\u2013" + STEMS.length + " SOLO &nbsp;\u00b7&nbsp; SHIFT+1\u2013" + STEMS.length +
    " MUTE &nbsp;\u00b7&nbsp; ALT+1\u2013" + PRESET_ORDER.length +
    " PRESET &nbsp;\u00b7&nbsp; [ ] CYCLE &nbsp;\u00b7&nbsp; M / S &nbsp;\u00b7&nbsp; SPACE &nbsp;\u00b7&nbsp; " +
    "<b id='hintFound'></b>";
  refreshFound();
}

/* ------------------------------------------------------------------ audio -- */
function masterDb() { return S.nSolo ? 0 : S.trim; }
function effGain(n) {
  if (!LIVE[n]) return -60;
  if (S.nSolo) return S.solo[n] ? (INFO[n].solo_gain_db || 0) : -60;
  if (S.mute[n]) return -60;
  return S.gains[n];
}

function showNotice(a, b) {
  var n = el("notice");
  n.innerHTML = a + (b ? "<br>" + b : "");
  n.className = "notice show";
}
function hideNotice() { el("notice").className = "notice"; }

function initAudio() {
  var C = window.AudioContext || window.webkitAudioContext;
  if (!C) {
    showNotice("NO WEB AUDIO", "THIS BROWSER CANNOT PLAY AUDIO");
    return;
  }
  try { ACTX = new C(); }
  catch (e) {
    showNotice("AUDIO UNAVAILABLE", "THE AUDIO CONTEXT COULD NOT START");
    return;
  }
  /* Safety only: the preset trims are now peak-clamped in the builder, so a
     normal preset lands below this threshold and the compressor does nothing.
     It exists for manual fader moves and the monitor knob, not as the fix. */
  LIM = ACTX.createDynamicsCompressor();
  LIM.threshold.value = MAN.emphasis.limiter_ceiling_dbtp;
  LIM.knee.value = 0; LIM.ratio.value = 20;
  LIM.attack.value = 0.002; LIM.release.value = 0.10;
  MASTER = ACTX.createGain();
  MASTER.gain.value = dbToLin(masterDb()) * dbToLin(S.monitor);
  MASTER.connect(LIM);
  LIM.connect(ACTX.destination);
  try {
    ANA = ACTX.createAnalyser();
    ANA.fftSize = 2048;
    ANABUF = new Float32Array(ANA.fftSize);
    MASTER.connect(ANA);
  } catch (e2) { ANA = null; }
  decodeStems(0);
}

function decodeStems(i) {
  if (i >= LIVE_LIST.length) { audioReady(); return; }
  var n = LIVE_LIST[i];
  showNotice("DECODING STEM " + (i + 1) + " OF " + LIVE_LIST.length,
             INFO[n].label + " \u00b7 " + DUR.toFixed(1) + " s");
  setTimeout(function () {
    decodeOne(n, function () { decodeStems(i + 1); });
  }, 30);
}

function decodeOne(n, done) {
  var payload = STEM_B64[n];
  var bytes;
  try {
    if (!payload || !payload.length) throw new Error("no payload");
    var s = payload.join("");
    STEM_B64[n] = null;
    var bin = atob(s);
    var len = bin.length;
    var u8 = new Uint8Array(len);
    for (var i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
    bytes = u8;
  } catch (e) {
    failStem(n, e); done(); return;
  }
  var settled = false;
  function ok(buf) {
    if (settled) return; settled = true;
    if (!buf || !buf.length) { failStem(n, new Error("empty buffer")); done(); return; }
    onDecoded(n, buf);
    done();
  }
  function bad(err) {
    if (settled) return; settled = true;
    failStem(n, err); done();
  }
  try {
    var p = ACTX.decodeAudioData(bytes.buffer, ok, bad);
    if (p && p.then) p.then(ok, bad);
  } catch (e2) { bad(e2); }
}

function onDecoded(n, buf) {
  BUFS[n] = buf;
  GN[n] = ACTX.createGain();
  GN[n].gain.value = dbToLin(effGain(n));
  GN[n].connect(MASTER);
  ENV[n] = envelope(buf);
  WAVE[n] = waveShape(buf, 1200);
}

function failStem(n, err) {
  if (window.console && console.warn) console.warn("stem failed:", n, err);
  LIVE[n] = false;
  if (UI[n]) {
    UI[n].ch.className = "ch dead";
    UI[n].mb.disabled = true; UI[n].sb.disabled = true;
    UI[n].val.textContent = "\u2014";
    UI[n].cap.style.top = "100%";
  }
  delete S.solo[n]; delete S.mute[n];
  S.nSolo = countSolo();
  refreshFound();
}

function audioReady() {
  S.audio = true;
  hideNotice();
  el("pwrLed").className = "led-dot on";
  applyGains(true);
  window.__ready = true;
  tryStart();
}

function tryResume() {
  if (!ACTX || !ACTX.resume) return;
  try {
    var p = ACTX.resume();
    if (p && p.then) p.then(checkRunning, checkRunning);
  } catch (e) {}
}

function tryStart() {
  if (!ACTX) return;
  if (ACTX.state === "running") { startPlayback(0); return; }
  tryResume();
  setTimeout(checkRunning, 300);
}

function checkRunning() {
  if (!ACTX) return;
  if (ACTX.state === "running") {
    BLOCKED = false;
    el("tap").className = "tap";
    if (el("play").className.indexOf("playing") < 0) el("play").className = "play";
    if (S.audio && !S.playing) startPlayback(S.t || 0);
  } else {
    BLOCKED = true;
    el("tap").className = "tap show";
    if (!S.playing) el("play").className = "play blocked";
    armGesture();
  }
}

function armGesture() {
  if (ARMED) return;
  ARMED = true;
  var go = function (e) {
    var t = e.target;
    if (t && t.closest && t.closest("#play")) return;
    ARMED = false;
    document.removeEventListener("pointerdown", go, false);
    tryResume();
    setTimeout(checkRunning, 120);
  };
  document.addEventListener("pointerdown", go, false);
}

/* 120 fps peak / rms envelopes plus a 44 ms release ballistic for the LEDs */
function envelope(buf) {
  var fps = 120, n = Math.round(DUR * fps), step = buf.sampleRate / fps;
  var chs = [], c;
  for (c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  var peak = new Float32Array(n), rms = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var a = Math.floor(i * step);
    var b = Math.min(buf.length, Math.max(a + 1, Math.floor((i + 1) * step)));
    var p = 0, s = 0, cnt = 0;
    for (c = 0; c < chs.length; c++) {
      var d = chs[c];
      for (var j = a; j < b; j++) {
        var v = Math.abs(d[j]); if (v > p) p = v;
        s += d[j] * d[j]; cnt++;
      }
    }
    peak[i] = p; rms[i] = Math.sqrt(s / Math.max(cnt, 1));
  }
  var ball = new Float32Array(n), pkh = new Float32Array(n);
  var m = 0, ph = 0;
  for (i = 0; i < n; i++) {
    m = Math.max(peak[i], m * 0.952); ball[i] = m;
    ph = Math.max(peak[i], ph * 0.9965); pkh[i] = ph;
  }
  return { peak: peak, rms: rms, ball: ball, pkh: pkh };
}

function waveShape(buf, cols) {
  var chs = [], c;
  for (c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  var lo = new Float32Array(cols), hi = new Float32Array(cols);
  var per = buf.length / cols, mx = 0;
  for (c = 0; c < cols; c++) {
    var a = Math.floor(c * per);
    var b = Math.min(buf.length, Math.max(a + 1, Math.floor((c + 1) * per)));
    var l = 0, h = 0;
    for (var k = 0; k < chs.length; k++) {
      var d = chs[k];
      for (var j = a; j < b; j++) {
        var v = d[j]; if (v < l) l = v; if (v > h) h = v;
      }
    }
    lo[c] = l; hi[c] = h;
    mx = Math.max(mx, Math.abs(l), Math.abs(h));
  }
  return { lo: lo, hi: hi, cols: cols, max: mx };
}

function stopSources() {
  for (var i = 0; i < STEMS.length; i++) {
    var n = STEMS[i];
    if (SRC[n]) {
      try { SRC[n].stop(); } catch (e) {}
      try { SRC[n].disconnect(); } catch (e2) {}
      SRC[n] = null;
    }
  }
}

function startPlayback(from) {
  if (!S.audio || !ACTX) return;
  if (ACTX.state !== "running") {
    tryResume();
    setTimeout(function () {
      if (ACTX && ACTX.state === "running") startPlayback(from);
    }, 90);
    return;
  }
  stopSources();
  var now = ACTX.currentTime;
  for (var i = 0; i < STEMS.length; i++) {
    var n = STEMS[i];
    if (!LIVE[n] || !BUFS[n]) continue;
    var s = ACTX.createBufferSource();
    s.buffer = BUFS[n];
    s.loop = true; s.loopStart = 0; s.loopEnd = DUR;
    s.connect(GN[n]);
    s.start(now, from % DUR);
    SRC[n] = s;
  }
  startedAt = now; offset = from; S.playing = true;
  el("play").className = "play playing";
  el("tap").className = "tap";
}

function pausePlayback() {
  S.t = transportT();
  stopSources();
  S.playing = false;
  el("play").className = "play";
}

function transportT() {
  if (!S.playing || !ACTX) return S.t;
  return (offset + (ACTX.currentTime - startedAt)) % DUR;
}

/* --------------------------------------------------------------- visuals -- */
var canvasScope = el("scope");
var SC = null;
var DPR = 2;

function fitCanvas(cv) {
  var w = cv.clientWidth, h = cv.clientHeight;
  cv.width = Math.round(w * DPR); cv.height = Math.round(h * DPR);
  var ctx = cv.getContext("2d");
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  return { ctx: ctx, w: w, h: h };
}

function featured() {
  if (S.preset && PRESETS[S.preset]) return PRESETS[S.preset].featured || null;
  var best = null, bg = 0.5;
  for (var i = 0; i < STEMS.length; i++) {
    var n = STEMS[i];
    if (LIVE[n] && S.gains[n] > bg) { bg = S.gains[n]; best = n; }
  }
  return best;
}

function drawScope(t) {
  if (!SC) return;
  var ctx = SC.ctx, w = SC.w, h = SC.h;
  ctx.clearRect(0, 0, w, h);
  var bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "#06120d"); bg.addColorStop(1, "#040a07");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  var glow = ctx.createRadialGradient(w * 0.45, h * 0.22, 8, w * 0.45, h * 0.22, h);
  glow.addColorStop(0, "rgba(70,150,115,.10)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);

  var X0 = 64, X1 = w - 9, TOP = 26, N = STEMS.length;
  var GAP = 3.2, LH = Math.max(12, Math.min(52, (h - 42) / N - GAP));
  var xOf = function (tt) { return X0 + (tt / DUR) * (X1 - X0); };
  var feat = featured();
  var aud = null;
  if (S.nSolo) { for (var q in S.solo) { if (S.solo[q]) { aud = q; break; } } }

  /* the manifest has no tempo map, so the only honest grid is time */
  var sub = DUR > 12 ? 2 : 0.5;
  for (var tt = 0; tt <= DUR + 1e-9; tt += sub) {
    var x = xOf(tt);
    var whole = Math.abs(tt - Math.round(tt)) < 1e-6;
    ctx.strokeStyle = whole ? "rgba(120,200,160,.17)" : "rgba(120,200,160,.055)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, TOP - 2);
    ctx.lineTo(Math.round(x) + 0.5, h - 14); ctx.stroke();
  }

  for (var i = 0; i < STEMS.length; i++) {
    var n = STEMS[i];
    var y0 = TOP + i * (LH + GAP);
    var mid = y0 + LH / 2, amp = LH * 0.42;
    var col = COLORS[n] || [160, 200, 180];
    var hot = aud ? n === aud : n === feat;
    var dead = !LIVE[n];
    var soloed = !!S.solo[n];
    var dim = dead || (S.nSolo && !soloed) || !!S.mute[n];

    ctx.fillStyle = hot ? "rgba(255,184,104,.075)" : "rgba(255,255,255,.016)";
    ctx.fillRect(X0 - 4, y0, X1 - X0 + 8, LH);
    if (hot) {
      var lg = ctx.createLinearGradient(X0 - 4, 0, X1 + 4, 0);
      lg.addColorStop(0, "rgba(255,184,104,.14)");
      lg.addColorStop(0.55, "rgba(255,176,96,.05)");
      lg.addColorStop(1, "rgba(255,176,96,.015)");
      ctx.fillStyle = lg; ctx.fillRect(X0 - 4, y0, X1 - X0 + 8, LH);
      ctx.fillStyle = "rgba(255,196,128,.8)";
      ctx.fillRect(X0 - 4, y0, 2, LH);
    }
    ctx.strokeStyle = "rgba(140,210,175,.09)";
    ctx.beginPath(); ctx.moveTo(X0 - 4, y0 + LH + 0.5);
    ctx.lineTo(X1 + 4, y0 + LH + 0.5); ctx.stroke();

    var fs = Math.max(5.6, Math.min(6.8, LH * 0.19));
    ctx.font = "600 " + fs.toFixed(1) + "px var(--mono)";
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    ctx.fillStyle = dead ? "rgba(255,120,100,.55)" : hot ? "rgba(255,214,160,.95)" : "rgba(160,215,185,.55)";
    ctx.fillText(INFO[n].label, 6, y0 + Math.min(LH - 4, fs + 4));
    if (LH > 26) {
      var e = ENV[n];
      var dB = null;
      if (e) {
        var idx = Math.min(e.peak.length - 1, Math.max(0, Math.round(t * 120)));
        dB = linToDb(e.peak[idx]);
      }
      ctx.font = "500 5.2px var(--mono)";
      ctx.fillStyle = dead ? "rgba(255,110,95,.42)" : dB == null ? "rgba(160,215,185,.25)" : "rgba(160,215,185,.42)";
      ctx.fillText(dead ? "\u2014" : (dB == null ? "" : (dB > -60 ? (dB.toFixed(1) + " dB") : "\u2014")), 6, y0 + fs + 11);
    }

    if (dead) {
      ctx.strokeStyle = "rgba(255,110,95,.22)"; ctx.setLineDash([2, 5]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X0, mid + 0.5); ctx.lineTo(X1, mid + 0.5); ctx.stroke();
      ctx.setLineDash([]);
      if (LH > 22) {
        ctx.font = "500 5.3px var(--mono)"; ctx.textAlign = "right";
        ctx.fillStyle = "rgba(255,110,95,.40)";
        ctx.fillText("NO SIGNAL IN SOURCE", X1 - 2, y0 + 10);
      }
      continue;
    }

    var wv = WAVE[n];
    if (wv) {
      var k = 0.92 / (wv.max || 1);
      var a = (hot ? 0.95 : 0.58) * (dim ? 0.22 : 1);
      ctx.beginPath();
      for (var c = 0; c < wv.cols; c++) {
        var xx = X0 + (c / wv.cols) * (X1 - X0);
        ctx.lineTo(xx, mid - wv.hi[c] * k * amp);
      }
      for (c = wv.cols - 1; c >= 0; c--) {
        xx = X0 + (c / wv.cols) * (X1 - X0);
        ctx.lineTo(xx, mid - wv.lo[c] * k * amp);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(" + col.join(",") + "," + a + ")";
      ctx.fill();
      if (hot) {
        ctx.strokeStyle = "rgba(255,236,208,.50)"; ctx.lineWidth = 0.7;
        ctx.beginPath();
        for (c = 0; c < wv.cols; c++) {
          xx = X0 + (c / wv.cols) * (X1 - X0);
          ctx.lineTo(xx, mid - wv.hi[c] * k * amp);
        }
        ctx.stroke();
      }
    }
    if (soloed) {
      ctx.strokeStyle = "rgba(255,200,140,.30)"; ctx.lineWidth = 1;
      ctx.strokeRect(X0 - 4.5, y0 + 0.5, X1 - X0 + 9, LH - 1);
    }
  }

  var px = xOf(t);
  var shade = ctx.createLinearGradient(X0, 0, px, 0);
  shade.addColorStop(0, "rgba(255,190,120,.025)");
  shade.addColorStop(1, "rgba(255,190,120,.07)");
  ctx.fillStyle = shade;
  ctx.fillRect(X0, TOP - 2, Math.max(0, px - X0), h - TOP - 12);
  ctx.save();
  ctx.shadowColor = "rgba(255,185,110,.85)"; ctx.shadowBlur = 9;
  ctx.fillStyle = "rgba(255,232,196,.95)";
  ctx.fillRect(px, TOP - 3, 1.3, h - TOP - 11);
  ctx.restore();
  ctx.fillStyle = "rgba(255,226,180,.95)";
  ctx.beginPath();
  ctx.moveTo(px - 3.5, TOP - 4); ctx.lineTo(px + 3.5, TOP - 4);
  ctx.lineTo(px, TOP + 1); ctx.closePath(); ctx.fill();

  ctx.font = "500 7px var(--mono)"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(150,210,180,.42)";
  ctx.fillText(T0.toFixed(3) + " \u2014 " + (T0 + DUR).toFixed(3) + " s", 8, 13);
  ctx.textAlign = "right"; ctx.fillStyle = "rgba(255,190,120,.58)";
  ctx.fillText("LOOP \u00b7 " + DUR.toFixed(1) + " s", w - 8, 13);
  ctx.textAlign = "center"; ctx.fillStyle = "rgba(150,210,180,.38)";
  for (var gi = 0; gi <= 6; gi++) {
    var gtt = gi * DUR / 6;
    ctx.fillText((T0 + gtt).toFixed(0), xOf(Math.min(gtt, DUR)), h - 3);
  }
  ctx.textAlign = "left";
}

/* ------------------------------------------------------------------- UI -- */
function gainPos(db) { return (12 - db) / 72; }
function fmtU(v) { return (v > 0 ? "+" : v < 0 ? "\u2212" : "") + Math.abs(v).toFixed(1); }

function paintGain(n) {
  var g = S.gains[n], ui = UI[n];
  if (!ui) return;
  ui.cap.style.top = (LIVE[n] ? gainPos(g) * 100 : 100) + "%";
  ui.val.textContent = LIVE[n] ? fmtU(g) : "\u2014";
  ui.fader.setAttribute("aria-valuenow", g.toFixed(1));
  ui.fader.setAttribute("aria-valuetext", g.toFixed(1) + " dB");
  ui.mb.classList.toggle("on", !!S.mute[n]);
  ui.sb.classList.toggle("on", !!S.solo[n]);
}

function paintPreset() {
  var feat = null;
  if (S.nSolo === 1) { for (var q in S.solo) if (S.solo[q]) feat = q; }
  else if (!S.nSolo) feat = featured();

  for (var i = 0; i < STEMS.length; i++) {
    var n = STEMS[i], ui = UI[n];
    if (!ui) continue;
    ui.ch.classList.toggle("featured", n === feat);
    ui.ch.classList.toggle("muted", !!S.mute[n]);
    ui.ch.classList.toggle("soloed", !!S.solo[n]);
    paintGain(n);
  }
  var pbtns = document.querySelectorAll(".preset");
  for (i = 0; i < pbtns.length; i++)
    pbtns[i].classList.toggle("active", pbtns[i].getAttribute("data-p") === S.preset);

  var lcd = el("focusName"), line = el("focusLine"), led = el("focusLed");
  var sole = [];
  for (q in S.solo) if (S.solo[q]) sole.push(q);
  if (sole.length) {
    lcd.textContent = sole.length === 1 ? "SOLO \u00b7 " + INFO[sole[0]].label : "SOLO \u00b7 " + sole.length + " STEMS";
    line.innerHTML = sole.length === 1
      ? "AUDITION AT \u221218 LUFS &nbsp;\u00b7&nbsp; FADERS BYPASSED &nbsp;\u00b7&nbsp; PEAK SAFE"
      : "MULTIPLE STEMS AUDITIONED &nbsp;\u00b7&nbsp; FADERS BYPASSED";
    led.classList.add("on");
  } else if (S.preset && PRESETS[S.preset]) {
    var p = PRESETS[S.preset];
    var shownLufs = (p.lufs == null) ? MAN.target_lufs : p.lufs;
    lcd.textContent = p.featured ? INFO[p.featured].label : "BALANCED";
    var lineHtml = p.featured
      ? "FEATURED " + fmtU(MAN.emphasis.featured_db) + " dB &nbsp;\u00b7&nbsp; OTHERS " +
        fmtU(MAN.emphasis.others_db) + " dB"
      : "ALL STEMS 0.0 dB &nbsp;\u00b7&nbsp; NO EMPHASIS";
    if (p.peak_limited) {
      /* The -16 LUFS trim was too hot for the -1 dBFS ceiling.  Say so, and
         show the lower loudness this preset actually lands at. */
      lineHtml += " &nbsp;\u00b7&nbsp; PEAK-LIMITED " + fmtU(shownLufs) + " LUFS";
    } else if (p.featured) {
      lineHtml += " &nbsp;\u00b7&nbsp; " +
        (MAN.emphasis.featured_db - MAN.emphasis.others_db).toFixed(1) + " dB MARGIN";
    } else {
      lineHtml += " &nbsp;\u00b7&nbsp; " + fmtU(shownLufs) + " LUFS";
    }
    line.innerHTML = lineHtml;
    led.classList.toggle("on", !!p.featured);
  } else {
    lcd.textContent = feat ? INFO[feat].label : "CUSTOM";
    line.innerHTML = "MANUAL BALANCE &nbsp;\u00b7&nbsp; NO PRESET &nbsp;\u00b7&nbsp; " +
      (feat ? "TOP STRIP IS LIT" : "NO STRIP ABOVE 0 dB");
    led.classList.toggle("on", !!feat);
  }
  document.body.classList.toggle("soloing", S.nSolo > 0);
  el("lufsVal").textContent = S.nSolo ? "AUD" : S.preset
    ? fmtU(PRESETS[S.preset].lufs == null ? MAN.target_lufs : PRESETS[S.preset].lufs)
    : "\u2014";
}

function paintMeters(t) {
  for (var i = 0; i < STEMS.length; i++) {
    var n = STEMS[i];
    if (!LIVE[n]) continue;
    var ui = UI[n], e = ENV[n];
    if (!e || !ui) continue;
    if (S.mute[n] || (S.nSolo && !S.solo[n])) {
      for (var z = 0; z < ui.segs.length; z++) {
        var sg = ui.segs[z];
        if (sg._on) { sg._on = false; sg.className = ""; }
      }
      ui.peak.classList.remove("on"); continue;
    }
    var idx = Math.min(e.ball.length - 1, Math.max(0, Math.round(t * 120)));
    var g = S.nSolo ? (INFO[n].solo_gain_db || 0) : S.gains[n];
    var db = linToDb(e.ball[idx]) + g + masterDb();
    var lit = Math.round(clamp((db + 48) / 54, 0, 1) * ui.segs.length);
    for (var k = 0; k < ui.segs.length; k++) {
      var seg = ui.segs[k];
      var on = k < lit;
      if (seg._on !== on) {
        seg._on = on;
        seg.className = on ? ("on" + (k >= 30 && k < 40 ? " hi" : "") + (k >= 40 ? " pk" : "")) : "";
      }
    }
    ui.peak.classList.toggle("on", linToDb(e.pkh[idx]) + g + masterDb() > -2.5);
  }
}

function paintTransport(t) {
  el("clock").textContent = (T0 + t).toFixed(3);
  var pct = (t / DUR) * 100;
  el("fill").style.width = pct + "%";
  el("thumb").style.left = pct + "%";
  el("scrub").setAttribute("aria-valuenow", (T0 + t).toFixed(2));
}

function frame() {
  var t = transportT();
  paintMeters(t); paintTransport(t); drawScope(t);
  requestAnimationFrame(frame);
}

function renderAt(t) {
  S.t = clamp(t, 0, DUR);
  paintPreset(); paintMeters(S.t); paintTransport(S.t); drawScope(S.t);
}

/* ---------------------------------------------------------------- events -- */
function rampParam(p, v, instant) {
  if (!p || !ACTX) return;
  var now = ACTX.currentTime;
  p.cancelScheduledValues(now);
  p.setValueAtTime(p.value, now);
  p.linearRampToValueAtTime(v, now + (instant ? 0.001 : RAMP));
}

function applyGains(instant) {
  for (var i = 0; i < STEMS.length; i++) {
    var n = STEMS[i];
    if (GN[n]) rampParam(GN[n].gain, dbToLin(effGain(n)), instant);
  }
  if (MASTER) rampParam(MASTER.gain, dbToLin(masterDb()) * dbToLin(S.monitor), instant);
}

function setGain(n, db, instant) {
  if (!LIVE[n]) return;
  S.gains[n] = clamp(Math.round(db * 10) / 10, -60, 12);
  S.preset = null;
  paintPreset();
  if (GN[n]) rampParam(GN[n].gain, dbToLin(effGain(n)), instant);
}

function setPreset(name, instant) {
  var p = PRESETS[name];
  if (!p) return;
  S.preset = name;
  S.gains = copyGains(p.gains);
  S.trim = p.trim_db;
  S.mute = {}; S.solo = {}; S.nSolo = 0;
  paintPreset(); applyGains(instant);
}

function countSolo() {
  var c = 0;
  for (var k in S.solo) if (S.solo[k]) c++;
  return c;
}

function toggleMute(n) {
  if (!LIVE[n]) return;
  if (S.mute[n]) delete S.mute[n]; else S.mute[n] = true;
  paintPreset();
  if (GN[n]) rampParam(GN[n].gain, dbToLin(effGain(n)), false);
}

function toggleSolo(n) {
  if (!LIVE[n]) return;
  if (S.solo[n]) delete S.solo[n]; else S.solo[n] = true;
  S.nSolo = countSolo();
  S.focus = n;
  paintPreset(); applyGains(false);
}

function cyclePreset(dir) {
  if (!PRESET_ORDER.length) return;
  var i = PRESET_ORDER.indexOf(S.preset);
  i = (i + dir + PRESET_ORDER.length) % PRESET_ORDER.length;
  setPreset(PRESET_ORDER[i], false);
}

function bindDrag(elm, onMove) {
  var active = false;
  var down = function (e) {
    active = true;
    try { elm.setPointerCapture(e.pointerId); } catch (err) {}
    onMove(e);
    e.preventDefault();
  };
  var move = function (e) { if (active) onMove(e); };
  var up = function (e) {
    active = false;
    try { elm.releasePointerCapture(e.pointerId); } catch (err) {}
  };
  elm.addEventListener("pointerdown", down);
  elm.addEventListener("pointermove", move);
  elm.addEventListener("pointerup", up);
  elm.addEventListener("pointercancel", up);
}

function bindFader(n) {
  var f = UI[n].fader;
  bindDrag(f, function (e) {
    if (!LIVE[n] || S.nSolo) return;
    S.focus = n;
    var r = f.getBoundingClientRect();
    var p = clamp((e.clientY - r.top) / r.height, 0, 1);
    setGain(n, 12 - p * 72, false);
  });
  f.addEventListener("keydown", function (e) {
    if (!LIVE[n] || S.nSolo) return;
    var step = e.shiftKey ? 3 : 0.5;
    var d = 0;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") d = step;
    if (e.key === "ArrowDown" || e.key === "ArrowLeft") d = -step;
    if (e.key === "PageUp") d = 6;
    if (e.key === "PageDown") d = -6;
    if (e.key === "Home") { S.focus = n; setGain(n, 12, false); e.preventDefault(); return; }
    if (e.key === "End") { S.focus = n; setGain(n, -60, false); e.preventDefault(); return; }
    if (d) { S.focus = n; setGain(n, S.gains[n] + d, false); e.preventDefault(); }
  });
}

el("play").addEventListener("click", function () {
  if (!S.audio) return;
  if (S.playing) pausePlayback();
  else { tryResume(); startPlayback(S.t || 0); }
});

function seek(t) {
  S.t = clamp(t, 0, DUR - 0.001);
  if (S.playing) startPlayback(S.t);
  renderAt(S.t);
}

var scrub = el("scrub");
bindDrag(scrub, function (e) {
  var r = scrub.getBoundingClientRect();
  seek(clamp((e.clientX - r.left) / r.width, 0, 1) * DUR);
});
scrub.addEventListener("keydown", function (e) {
  if (e.key === "ArrowRight") { seek(S.t + 0.1); e.preventDefault(); }
  if (e.key === "ArrowLeft") { seek(S.t - 0.1); e.preventDefault(); }
});

document.addEventListener("keydown", function (e) {
  var tag = (document.activeElement && document.activeElement.tagName) || "";
  if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
  if (e.ctrlKey || e.metaKey) return;
  if (e.code === "Space" || e.key === " ") {
    e.preventDefault();
    if (!S.audio) return;
    if (S.playing) pausePlayback();
    else { tryResume(); startPlayback(S.t || 0); }
    return;
  }
  var m = /^Digit([1-9])$/.exec(e.code || "");
  if (m) {
    var idx = parseInt(m[1], 10);
    if (e.altKey) {
      if (idx <= PRESET_ORDER.length) setPreset(PRESET_ORDER[idx - 1], false);
    } else if (idx <= STEMS.length) {
      var n = STEMS[idx - 1];
      if (e.shiftKey) toggleMute(n); else toggleSolo(n);
    }
    e.preventDefault(); return;
  }
  var k = (e.key || "").toLowerCase();
  if (k === "m") { toggleMute(S.focus); e.preventDefault(); }
  else if (k === "s") { toggleSolo(S.focus); e.preventDefault(); }
  else if (k === "b" && PRESETS.balanced) { setPreset("balanced", false); e.preventDefault(); }
  else if (e.key === "[") { cyclePreset(-1); e.preventDefault(); }
  else if (e.key === "]") { cyclePreset(1); e.preventDefault(); }
  else if (e.key === "Escape" || e.key === "0") {
    S.mute = {}; S.solo = {}; S.nSolo = 0;
    paintPreset(); applyGains(false); e.preventDefault();
  }
});

var knob = el("knob");
function paintMaster() {
  var a = -150 + ((S.monitor + 18) / 24) * 300;
  el("knobPtr").style.transform = "rotate(" + a + "deg)";
  el("masterVal").textContent = fmtU(S.monitor);
  if (MASTER && ACTX) rampParam(MASTER.gain, dbToLin(masterDb()) * dbToLin(S.monitor), true);
}
bindDrag(knob, function (e) {
  var r = knob.getBoundingClientRect();
  var p = clamp((e.clientY - r.top) / r.height, 0, 1);
  S.monitor = clamp(6 - p * 24, -18, 6);
  S.monitor = Math.round(S.monitor * 2) / 2;
  paintMaster();
});
knob.addEventListener("keydown", function (e) {
  if (e.key === "ArrowUp") { S.monitor = clamp(S.monitor + 0.5, -18, 6); paintMaster(); e.preventDefault(); }
  if (e.key === "ArrowDown") { S.monitor = clamp(S.monitor - 0.5, -18, 6); paintMaster(); e.preventDefault(); }
});

function fitScene() {
  var s = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
  document.documentElement.style.setProperty("--s", s);
}
window.addEventListener("resize", fitScene);

/* ------------------------------------------------------------------ boot -- */
window.__ready = false;
applyManifest(MANIFEST);
buildUI();
fitScene();
SC = fitCanvas(canvasScope);
paintMaster();
setPreset(S.preset, true);
renderAt(0);
requestAnimationFrame(frame);
initAudio();

/* ------------------------------------------------- verification handles -- */
window.__state = function () {
  return { t: S.t, preset: S.preset, gains: copyObj(S.gains), solo: copyObj(S.solo),
           mute: copyObj(S.mute), trim: S.trim, master: masterDb(), audio: S.audio,
           playing: S.playing, live: (function () {
             var a = []; for (var i = 0; i < STEMS.length; i++) if (LIVE[STEMS[i]]) a.push(STEMS[i]); return a;
           })(), dead: (function () {
             var a = []; for (var i = 0; i < STEMS.length; i++) if (!LIVE[STEMS[i]]) a.push(STEMS[i]); return a;
           })() };
};
window.__debugAudio = function () {
  var stems = {}, eff = {}, dur = {};
  for (var i = 0; i < STEMS.length; i++) {
    var n = STEMS[i];
    stems[n] = GN[n] ? GN[n].gain.value : null;
    eff[n] = effGain(n);
    dur[n] = BUFS[n] ? BUFS[n].duration : null;
  }
  return { ctx: ACTX ? ACTX.state : null, master: MASTER ? MASTER.gain.value : null,
           trim: S.trim, lim: LIM ? LIM.reduction : null,
           stems: stems, eff: eff, dur: dur };
};
window.__level = function () {
  if (!ANA) return null;
  ANA.getFloatTimeDomainData(ANABUF);
  var pk = 0, sum = 0;
  for (var i = 0; i < ANABUF.length; i++) {
    var v = ANABUF[i];
    if (Math.abs(v) > pk) pk = Math.abs(v);
    sum += v * v;
  }
  return { peak: pk, rms: Math.sqrt(sum / ANABUF.length), ctx: ACTX ? ACTX.state : null };
};
/* Verification handle: scan the whole decoded MP3 mix for one preset exactly
   as the page sums it (stem gains, then the preset trim), before the safety
   compressor.  If peak_db <= the limiter threshold, no gain reduction is
   possible.  This is a full-song scan, not a sampled meter. */
window.__mixStats = function (pid) {
  var p = PRESETS[pid || S.preset];
  if (!p) return null;
  var trim = dbToLin(p.trim_db);
  var gains = {}, data = {}, n, i, c, k;
  for (i = 0; i < STEMS.length; i++) {
    n = STEMS[i];
    gains[n] = LIVE[n] ? dbToLin(p.gains[n] == null ? 0 : p.gains[n]) * trim : 0;
  }
  var frames = 0, maxCh = 0;
  for (i = 0; i < STEMS.length; i++) {
    n = STEMS[i];
    if (!BUFS[n]) continue;
    data[n] = [];
    for (c = 0; c < BUFS[n].numberOfChannels; c++) data[n].push(BUFS[n].getChannelData(c));
    if (BUFS[n].length > frames) frames = BUFS[n].length;
    if (BUFS[n].numberOfChannels > maxCh) maxCh = BUFS[n].numberOfChannels;
  }
  if (!frames) return null;
  var rows = [];
  for (c = 0; c < maxCh; c++) {
    var row = [];
    for (k = 0; k < STEMS.length; k++) {
      n = STEMS[k];
      if (data[n] && c < data[n].length) row.push({ d: data[n][c], g: gains[n] });
    }
    rows.push(row);
  }
  var peak = 0, sum = 0, cnt = 0;
  for (c = 0; c < rows.length; c++) {
    var rr = rows[c];
    for (i = 0; i < frames; i++) {
      var s = 0;
      for (k = 0; k < rr.length; k++) s += rr[k].d[i] * rr[k].g;
      var a = s < 0 ? -s : s;
      if (a > peak) peak = a;
      sum += s * s; cnt++;
    }
  }
  var peakDb = linToDb(peak);
  return {
    preset: p.id, trim_db: p.trim_db, peak: peak, peak_db: peakDb,
    rms_db: 10 * Math.log(Math.max(sum / Math.max(cnt, 1), 1e-12)) / Math.LN10,
    frames: frames, samples: cnt,
    limiter_threshold_dbtp: MAN.emphasis.limiter_ceiling_dbtp,
    limiter_would_engage: peakDb > MAN.emphasis.limiter_ceiling_dbtp
  };
};
window.__limiterInfo = function () {
  /* DynamicsCompressorNode.reduction is a plain read-only number (dB), not an
     AudioParam.  Reading .value here would silently return undefined. */
  return LIM ? { threshold: LIM.threshold.value, knee: LIM.knee.value,
                 ratio: LIM.ratio.value, reduction: LIM.reduction } : null;
};
window.__setPreset = function (n) { setPreset(n, true); };
window.__seek = function (t) { seek(clamp(t, 0, DUR - 0.001)); };
window.__setSolo = function (n) {
  S.solo = {}; if (n) S.solo[n] = true; S.nSolo = countSolo();
  paintPreset(); applyGains(true);
};
window.__manifest = function () { return MAN; };
/* Test-only: force the state Safari imposes (paused + suspended context) so the
   real click-to-start path can be exercised in headless Chrome, which allows
   autoplay. It calls the page's own pause/suspend/checkRunning functions. */
window.__testBlocked = function () {
  if (S.playing) pausePlayback();
  if (ACTX && ACTX.suspend) { try { ACTX.suspend(); } catch (e) {} }
  checkRunning();
};
})();
