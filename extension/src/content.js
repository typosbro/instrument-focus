/* Stems for YouTube — content script.
 *
 * Owns:
 *   - the small injected panel (UI),
 *   - the page video element (mute / play / pause / currentTime),
 *   - the Web Audio graph that plays the six separated stems in sync.
 *
 * It does NOT fetch, decode, separate or store anything: the extension-origin
 * iframe host does that (page CSP blocks chrome-extension workers here), and
 * the WebGPU worker does the model runs.
 */
(function () {
  "use strict";

  var SR = 44100;
  var STEMS = ["drums", "bass", "other", "vocals", "guitar", "piano"];
  var LABELS = ["Drums", "Bass", "Other", "Vocals", "Guitar", "Piano"];
  var SLICE_SEC = 15;            // host cache chunk size
  var LOOKAHEAD_SEC = 18;        // keep this much audio scheduled
  var LEAD_SEC = 0.08;           // schedule audio slightly in the future
  var DRIFT_LIMIT = 0.09;        // re-anchor above this
  var EMPH_FEATURED = 9;
  var EMPH_OTHERS = -6;
  var PEAK_CEIL = 0.891;         // -1 dBFS
  // PUBLIC CONSTANT, NOT A SECRET: YouTube web client key, shipped in every
  // youtube.com page as /youtubei/v1/player?key=... It grants no private access.
  var INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  var VISIONOS_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

  var hostEl = null, hostReady = false, hostQueue = [];
  var mounted = false, mountedFor = null;
  var rafId = 0, tickTimer = 0, uiTimer = 0;
  var adObserver = null;

  var S = {
    phase: "idle",            // idle | preparing | engine | separating | ready | playing | stopped | error
    videoId: null, title: "",
    cached: false, meta: null, stats: null, timings: null,
    busy: false, progress: null, statusText: "", error: null,
    gpu: null, gpuError: null, adapter: null,
    ctx: null, master: null, analyser: null, anaBuf: null, stemGain: [],
    anchor: null, schedEnd: null, sources: [], sliceCache: new Map(), pending: new Map(),
    reqSeq: 0, reanchors: 0, drift: 0, maxDrift: 0, lastDriftAt: 0,
    playing: false, wasPlaying: false, startAt: 0,
    wasMuted: false, mutedByUs: false, adActive: false,
    gains: [0, 0, 0, 0, 0, 0], focus: null, masterTrim: 1,
    masterRms: 0, masterPeak: 0,
    engineInfo: null, cacheUsage: null, cacheQuota: null,
    startedAt: 0, readyAt: 0, lastUI: 0, reanchoring: false,
    buffering: false, lastClock: -1, lastClockChange: 0, lastReanchorAt: 0,
    awaitingSlice: false, settleTimer: 0, reanchorLog: [],
    partial: false, chunkReady: null, gap: false, lastPriorityAt: 0,
  };

  /* ------------------------------------------------------------------ utils */
  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function dbToLin(d) { return Math.pow(10, d / 20); }
  function linToDb(v) { return 20 * Math.log(Math.max(v, 1e-9)) / Math.LN10; }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function stopEv(e) { e.stopPropagation(); }

  function log() {
    try { console.log.apply(console, ["[stems]"].concat([].slice.call(arguments))); } catch (e) {}
  }

  /* --------------------------------------------------------------- page/video */
  function video() { return document.querySelector("video.html5-main-video") || document.querySelector("video"); }
  function player() { return document.querySelector("#movie_player"); }
  function videoIdFromUrl() {
    try { return new URL(location.href).searchParams.get("v"); } catch (e) { return null; }
  }
  function isWatchPage() { return /^\/watch\/?$/.test(location.pathname) && !!videoIdFromUrl(); }
  function isAd() { var p = player(); return !!(p && p.classList && p.classList.contains("ad-showing")); }
  function pageTitle() {
    var t = document.title || "";
    return t.replace(/\s*-\s*YouTube\s*$/, "");
  }
  function muteVideo() {
    var v = video(); if (!v) return;
    if (!S.mutedByUs) { S.wasMuted = v.muted; S.mutedByUs = true; }
    v.muted = true;
  }
  function unmuteVideoIfOurs() {
    var v = video(); if (!v) return;
    if (S.mutedByUs) { v.muted = S.wasMuted; S.mutedByUs = false; }
  }

  /* ------------------------------------------------------------------- h ost */
  function ensureHost() {
    if (hostEl) return;
    hostEl = document.createElement("iframe");
    hostEl.id = "stems-host-frame";
    hostEl.setAttribute("aria-hidden", "true");
    hostEl.style.cssText = "position:fixed;width:0;height:0;border:0;left:-9999px;top:0;visibility:hidden";
    hostEl.src = chrome.runtime.getURL("src/host.html");
    document.documentElement.appendChild(hostEl);
    setTimeout(function () {
      if (!hostReady) { S.error = "extension host frame did not start"; setPhase("error"); }
    }, 6000);
  }
  function hostSend(msg) {
    if (!hostEl || !hostReady) { hostQueue.push(msg); return; }
    try { hostEl.contentWindow.postMessage(Object.assign({ __stemsCmd: true }, msg), "*"); }
    catch (e) { log("postMessage failed", e); }
  }
  window.addEventListener("message", function (ev) {
    var m = ev.data;
    if (!m || !m.__stemsHost) return;
    if (!hostEl || ev.source !== hostEl.contentWindow) return;
    onHost(m);
  });
  function onHost(m) {
    if (m.type === "need-audio") { provideAudioSource(m.videoId, m.reqId); return; }
    if (m.type === "host-ready") {
      hostReady = true;
      for (var i = 0; i < hostQueue.length; i++) hostSend(hostQueue[i]);
      hostQueue = [];
      hostSend({ type: "stats" });
      if (isWatchPage()) hostSend({ type: "cache-status", videoId: videoIdFromUrl() });
      return;
    }
    if (m.type === "log") { log("host:", m.msg); return; }
    if (m.type === "cache-status") {
      if (m.videoId !== S.videoId) return;
      S.cached = !!m.cached;
      if (m.meta) S.pendingMeta = m.meta;
      updateUI();
      return;
    }
    if (m.type === "status") { onStatus(m); return; }
    if (m.type === "partial-start") { onPartialStart(m); return; }
    if (m.type === "chunk-ready") { onChunkReady(m); return; }
    if (m.type === "ready") { onReady(m); return; }
    if (m.type === "slice") { onSlice(m); return; }
    if (m.type === "slice-error") {
      var p = S.pending.get(m.reqId);
      if (p) {
        S.pending.delete(m.reqId);
        S.pending.delete("idx:" + p.idx);
        p.reject(new Error(m.message));
      }
      return;
    }
    if (m.type === "error") {
      S.error = m.message;
      setPhase("error");
      S.busy = false;
      unmuteVideoIfOurs();
      resumeIfWasPlaying();
      log("ERROR", m.stage, m.message);
      updateUI();
      return;
    }
    if (m.type === "stats-result") {
      S.cacheUsage = m.usage; S.cacheQuota = m.quota;
      return;
    }
  }

  function onStatus(m) {
    if (m.stage === "cache-check") { S.statusText = "Checking cache"; }
    else if (m.stage === "fetching") {
      S.phase = "preparing";
      S.statusText = m.msg || "Fetching audio";
      if (m.pct) S.statusText = "Downloading audio " + Math.round(m.pct * 100) + "%";
    } else if (m.stage === "decoding") {
      S.phase = "preparing"; S.statusText = "Decoding audio";
    } else if (m.stage === "engine") {
      S.phase = "engine";
      S.statusText = m.msg || "Starting WebGPU";
      if (m.adapter) S.adapter = m.adapter;
    } else if (m.stage === "separating") {
      S.phase = "separating";
      if (m.progress) {
        S.progress = m.progress;
        var pr = m.progress;
        var base = (S.partial ? (S.gap ? "Original audio until stems catch up · " : "Stems live · separating ahead ") : "Separating ") +
          pr.done + "/" + pr.total;
        if (pr.etaMs != null) base += " · ETA " + fmtTime(pr.etaMs / 1000);
        base += " · RTF " + (pr.rtf || 0).toFixed(2);
        S.statusText = base;
      } else {
        S.statusText = "Separating (7.8 s windows)";
      }
    } else if (m.stage === "cancelled") {
      S.statusText = "Cancelled"; S.busy = false;
      setPhase(S.meta ? "stopped" : "idle");
      unmuteVideoIfOurs();
    } else if (m.stage === "error") {
      S.error = m.message || "host error"; setPhase("error"); S.busy = false;
    }
    updateUI();
  }

  /* Just-in-time start: the worker has the song and will deliver chunks nearest
     the playhead first. Build the mixer now; tick() plays stems wherever a chunk
     is ready and leaves the original video audio on everywhere else. */
  function onPartialStart(m) {
    S.meta = m.meta;
    S.meta.blockPeaks = new Float32Array(STEMS.length * m.meta.blockCount);
    S.partial = true;
    S.chunkReady = new Uint8Array(m.meta.chunkCount);
    S.gap = false;
    S.stats = null;
    S.sliceCache.clear();
    S.pending.clear();
    ensureAudio();
    buildMixer();
    applyGains(true);
    S.statusText = "Separating at the playhead · original audio for now";
    updateUI();
  }

  function onChunkReady(m) {
    if (!S.partial || !S.meta || m.videoId !== S.meta.videoId) return;
    S.chunkReady[m.chunk] = 1;
    // The peak-safe trim is a max over blocks, so it only ever comes down as
    // chunks land; it never jumps up mid-song.
    var bp = S.meta.blockPeaks, bc = S.meta.blockCount;
    for (var s = 0; s < STEMS.length; s++) {
      var src = m.blockPeaks[s] || [];
      for (var k = 0; k < src.length; k++) {
        var at = s * bc + m.blockStart + k;
        if (src[k] > bp[at]) bp[at] = src[k];
      }
    }
    applyGains(false);
    tick();
  }

  function playheadChunk() {
    var v = video();
    var idx = Math.floor((v ? v.currentTime : 0) * SR / chunkFrames());
    return clamp(idx, 0, S.meta.chunkCount - 1);
  }

  function sendPriority(force) {
    var v = video();
    if (!v) return;
    var now = performance.now();
    if (!force && now - S.lastPriorityAt < 1000) return;
    S.lastPriorityAt = now;
    hostSend({ type: "priority", sec: v.currentTime });
  }

  function onReady(m) {
    var wasPartial = S.partial;
    S.partial = false; S.chunkReady = null; S.gap = false;
    S.meta = m.meta;
    S.stats = m.stats || {
      stemRms: m.meta.stemRms, stemPeak: m.meta.stemPeak,
      corrMin: m.meta.corrMin, corrMax: m.meta.corrMax,
    };
    S.timings = m.timings || S.timings;
    S.cached = !!m.cached;
    S.busy = false;
    S.readyAt = performance.now();
    S.progress = null;
    S.error = null;
    if (wasPartial) {
      // Already playing from partial chunks; only the final stats change.
      applyGains(false);
      setPhase(S.sources.length ? "playing" : "ready");
      S.statusText = "Separated · 6 stems · cached for replays";
      updateUI();
      return;
    }
    ensureAudio();
    buildMixer();
    applyGains(true);
    ensureSliceForTime(S.wasPlaying ? (video() ? video().currentTime : S.startAt) : S.startAt);
    setPhase("ready");
    S.statusText = m.cached ? "Loaded from cache · 6 stems" : "Separated · 6 stems";
    if (isAd()) {
      S.statusText = "Ready · waiting for the ad to end";
    } else if (S.wasPlaying) {
      var v = video();
      muteVideo();
      if (v) {
        var pl = v.play();
        if (pl && pl.catch) pl.catch(function () {});
      }
      setTimeout(function () { if (!isAd()) reanchor("ready"); }, 120);
    }
    updateUI();
  }

  /* --------------------------------------------------------------- Web Audio */
  function ensureAudio() {
    if (S.ctx) {
      if (S.ctx.state === "suspended") S.ctx.resume();
      return;
    }
    var C = window.AudioContext || window.webkitAudioContext;
    try { S.ctx = new C({ sampleRate: SR, latencyHint: "playback" }); }
    catch (e) { S.ctx = new C(); }
    S.master = S.ctx.createGain();
    S.master.gain.value = 1;
    S.analyser = S.ctx.createAnalyser();
    S.analyser.fftSize = 2048;
    S.anaBuf = new Float32Array(S.analyser.fftSize);
    S.master.connect(S.analyser);
    S.analyser.connect(S.ctx.destination);
    S.stemGain = [];
    for (var i = 0; i < STEMS.length; i++) {
      var g = S.ctx.createGain();
      g.gain.value = dbToLin(S.gains[i]) * S.masterTrim;
      g.connect(S.master);
      S.stemGain.push(g);
    }
    if (S.ctx.state === "suspended") S.ctx.resume();
  }

  function buildMixer() {
    var m = $("stems-mixer");
    if (!m) return;
    m.hidden = false;
    syncFaderUI();
  }

  function effectiveGain(i) { return S.gains[i]; }

  function applyGains(instant) {
    if (!S.ctx) return;
    var t = S.ctx.currentTime;
    var bound = 0;
    var bp = S.meta && S.meta.blockPeaks;
    var bc = S.meta && S.meta.blockCount;
    if (bp && bc) {
      // Sum of per-stem 250 ms peak envelopes is a strict upper bound on the
      // mixed peak, and far tighter than summing whole-song peaks.
      for (var b = 0; b < bc; b++) {
        var sum = 0;
        for (var q = 0; q < STEMS.length; q++) {
          var g = Math.abs(dbToLin(S.gains[q]));
          if (g > 0) sum += g * (bp[q * bc + b] || 0);
        }
        if (sum > bound) bound = sum;
      }
    } else {
      var peaks = (S.stats && S.stats.stemPeak) || [];
      for (var q2 = 0; q2 < STEMS.length; q2++) bound += Math.abs(dbToLin(S.gains[q2])) * (peaks[q2] || 0);
    }
    for (var i = 0; i < STEMS.length; i++) {
      if (S.stemGain[i]) {
        if (instant) S.stemGain[i].gain.value = dbToLin(S.gains[i]);
        else S.stemGain[i].gain.setTargetAtTime(dbToLin(S.gains[i]), t, 0.02);
      }
    }
    var trim = bound > PEAK_CEIL ? PEAK_CEIL / bound : 1;
    S.masterTrim = trim;
    if (S.master) {
      if (instant) S.master.gain.value = trim;
      else S.master.gain.setTargetAtTime(trim, t, 0.03);
    }
    var trimDb = linToDb(trim);
    var peakLine = $("stems-peak");
    if (peakLine) peakLine.textContent = trim < 0.9999
      ? "peak-safe master " + trimDb.toFixed(1) + " dB (worst-case bound)"
      : "peak-safe master 0.0 dB";
  }

  function setEmphasis(idx) {
    S.focus = idx;
    for (var i = 0; i < STEMS.length; i++) S.gains[i] = (i === idx) ? EMPH_FEATURED : EMPH_OTHERS;
    syncFaderUI();
    applyGains(false);
    updateUI();
  }
  function setFlat() {
    S.focus = null;
    for (var i = 0; i < STEMS.length; i++) S.gains[i] = 0;
    syncFaderUI();
    applyGains(false);
    updateUI();
  }
  function setFader(i, db) {
    S.gains[i] = db;
    if (S.focus != null && (i === S.focus ? db !== EMPH_FEATURED : db !== EMPH_OTHERS)) S.focus = null;
    syncFaderUI();
    applyGains(false);
    updateUI();
  }

  /* ----------------------------------------------------------- slice loading */
  function chunkFrames() { return (S.meta && S.meta.chunkFrames) || SLICE_SEC * SR; }
  function duration() { return (S.meta && S.meta.duration) || 0; }

  function ensureSliceForTime(mediaSec) {
    if (!S.meta) return;
    var idx = Math.floor(Math.max(0, mediaSec) * SR / chunkFrames());
    ensureSlice(idx);
  }

  function ensureSlice(idx) {
    if (!S.meta) return Promise.reject(new Error("no song"));
    if (idx < 0 || idx >= S.meta.chunkCount) return Promise.resolve(null);
    if (S.partial && !S.chunkReady[idx]) return Promise.resolve(null);
    if (S.sliceCache.has(idx)) return Promise.resolve(S.sliceCache.get(idx));
    if (S.pending.has("idx:" + idx)) return S.pending.get("idx:" + idx).promise;
    var reqId = ++S.reqSeq;
    var start = idx * chunkFrames();
    var count = Math.min(chunkFrames(), S.meta.length - start);
    var resolveFn, rejectFn;
    var promise = new Promise(function (res, rej) { resolveFn = res; rejectFn = rej; });
    S.pending.set(reqId, { idx: idx, resolve: resolveFn, reject: rejectFn });
    S.pending.set("idx:" + idx, { promise: promise });
    hostSend({ type: "slice", reqId: reqId, startFrame: start, count: count });
    return promise;
  }

  function onSlice(m) {
    var p = S.pending.get(m.reqId);
    if (!p) return;
    S.pending.delete(m.reqId);
    S.pending.delete("idx:" + p.idx);
    if (!m.frames || !m.data || !m.data.length) { p.resolve(null); return; }
    var entry = {
      idx: p.idx, frames: m.frames, scale: m.scale || 4,
      data: m.data.map(function (b) { return new Int16Array(b); }),
      buffers: null, lastUsed: Date.now(),
    };
    S.sliceCache.set(p.idx, entry);
    // Keep the cache bounded; scheduled sources keep their own AudioBuffers.
    var cf = chunkFrames();
    var vv = video();
    var curIdx = Math.floor((vv ? vv.currentTime : 0) * SR / cf);
    var endIdx = S.schedEnd ? Math.floor(S.schedEnd.media * SR / cf) : curIdx;
    var keys = Array.from(S.sliceCache.keys()).sort(function (a, b) { return a - b; });
    while (keys.length > 5) {
      var k = keys.shift();
      if (k >= curIdx - 1 && k <= endIdx + 1) continue;
      S.sliceCache.delete(k);
    }
    p.resolve(entry);
    if (!S.awaitingSlice) pump();
  }

  function buildBuffers(entry) {
    if (entry.buffers) return entry.buffers;
    var scale = (S.meta && S.meta.storeScale) || 4;
    var conv = scale / 32767;
    var bufs = [];
    var n = entry.frames;
    for (var s = 0; s < STEMS.length; s++) {
      var ab = S.ctx.createBuffer(2, n, SR);
      var L = ab.getChannelData(0), R = ab.getChannelData(1);
      var src = entry.data[s];
      for (var i = 0; i < n; i++) {
        L[i] = src[2 * i] * conv;
        R[i] = src[2 * i + 1] * conv;
      }
      bufs.push(ab);
    }
    entry.buffers = bufs;
    return bufs;
  }

  /* -------------------------------------------------------------- scheduling */
  function stopSources() {
    var list = S.sources;
    S.sources = [];
    for (var i = 0; i < list.length; i++) {
      try { list[i].src.stop(); } catch (e) {}
      try { list[i].src.disconnect(); } catch (e) {}
    }
    S.schedEnd = null;
    S.anchor = null;
    S.awaitingSlice = false;
  }

  function reanchor(reason) {
    if (!S.ctx || !S.meta) return;
    var v = video();
    if (!v || v.paused || v.ended) { stopSources(); S.playing = false; return; }
    if (S.reanchoring) return;
    S.reanchoring = true;
    S.lastReanchorAt = performance.now();
    var vv = video();
    S.reanchorLog.push({ t: Date.now() % 100000, r: reason, media: vv ? +vv.currentTime.toFixed(2) : null, drift: +((S.drift || 0) * 1000).toFixed(0) });
    if (S.reanchorLog.length > 30) S.reanchorLog.shift();
    try {
      stopSources();
      var rate = v.playbackRate || 1;
      var now = S.ctx.currentTime;
      var leadMedia = v.currentTime + (LEAD_SEC * rate);
      S.anchor = { media: leadMedia, ctx: now + LEAD_SEC, rate: rate, reason: reason, at: Date.now() };
      S.schedEnd = { media: leadMedia, ctx: now + LEAD_SEC };
      S.reanchors++;
      S.playing = true;
      pump();
      ensureSliceForTime(leadMedia);
      ensureSliceForTime(leadMedia + LOOKAHEAD_SEC);
      // A second alignment ~0.9 s later removes the "video started late" offset.
      if (reason === "play" || reason === "playing" || reason === "seeked" || reason === "slice-ready" || reason === "ready" || reason === "late" || reason === "ratechange" || reason === "ad-end") {
        clearTimeout(S.settleTimer);
        S.settleTimer = setTimeout(function () {
          var vv = video();
          if (S.meta && !S.buffering && vv && !vv.paused && !vv.ended && !isAd()) reanchor("settle");
        }, 900);
      }
    } finally {
      S.reanchoring = false;
    }
  }

  function pump() {
    if (!S.ctx || !S.meta || !S.anchor || !S.schedEnd) return;
    var v = video();
    if (!v || v.paused || v.ended) return;
    var now = S.ctx.currentTime;
    if (S.schedEnd.ctx < now - 0.02) {
      if (S.sources.length > 0) return; // audio is already scheduled; drift watchdog decides
      var staleIdx = Math.floor(S.schedEnd.media * SR / chunkFrames());
      if (S.sliceCache.has(staleIdx)) { reanchor("late"); return; }
      S.awaitingSlice = true;
      ensureSlice(staleIdx);
      return;
    }
    var guard = 0;
    while (guard++ < 6) {
      var target = Math.min(v.currentTime + LOOKAHEAD_SEC, duration());
      if (S.schedEnd.media >= target - 0.01) break;
      var cf = chunkFrames();
      var idx = Math.floor(S.schedEnd.media * SR / cf);
      var entry = S.sliceCache.get(idx);
      if (!entry) { ensureSlice(idx); break; }
      buildBuffers(entry);
      var sliceStart = idx * cf / SR;
      var offset = Math.max(0, S.schedEnd.media - sliceStart);
      var remaining = Math.min(entry.frames / SR - offset, duration() - S.schedEnd.media);
      if (!(remaining > 0.005)) break;
      var when = S.schedEnd.ctx;
      for (var s = 0; s < STEMS.length; s++) {
        var src = S.ctx.createBufferSource();
        src.buffer = entry.buffers[s];
        src.playbackRate.value = S.anchor.rate;
        src.connect(S.stemGain[s]);
        src.start(when, offset, remaining);
        S.sources.push({ src: src, when: when, end: when + remaining / S.anchor.rate, idx: idx });
      }
      S.schedEnd = { media: S.schedEnd.media + remaining, ctx: when + remaining / S.anchor.rate };
      ensureSliceForTime(S.schedEnd.media + LOOKAHEAD_SEC);
    }
    // Drop ended sources' references.
    if (S.sources.length > 24) {
      var cutoff = now - 1;
      S.sources = S.sources.filter(function (x) {
        if (x.end < cutoff) { try { x.src.disconnect(); } catch (e) {} return false; }
        return true;
      });
    }
  }

  function startPlayback() {
    ensureAudio();
    if (!S.ctx || !S.meta) return;
    if (S.ctx.state === "suspended") S.ctx.resume();
    var v = video();
    if (!v) return;
    reanchor("start");
  }

  /* ------------------------------------------------------------------- tick */
  function analyse() {
    if (!S.analyser || !S.anaBuf) return;
    try {
      S.analyser.getFloatTimeDomainData(S.anaBuf);
      var sum = 0, pk = 0;
      for (var i = 0; i < S.anaBuf.length; i++) {
        var x = S.anaBuf[i];
        sum += x * x;
        var a = x < 0 ? -x : x;
        if (a > pk) pk = a;
      }
      S.masterRms = Math.sqrt(sum / S.anaBuf.length);
      S.masterPeak = pk;
    } catch (e) {}
  }

  function tick() {
    if (!mounted) return;
    var v = video();
    // Before the worker starts, keep it pointed at wherever the video has got to.
    if (S.busy && !S.meta && v && !v.paused) sendPriority(false);
    if (!S.meta || !v) { updateDiag(); return; }
    var nowMs = performance.now();
    if (v.currentTime !== S.lastClock) { S.lastClock = v.currentTime; S.lastClockChange = nowMs; }
    var stuck = !v.paused && !v.ended && v.currentTime === S.lastClock && (nowMs - S.lastClockChange) > 900;
    var notReady = v.readyState < 2 || v.seeking || stuck;
    if (notReady && !v.paused) {
      if (!S.buffering) {
        stopSources();
        S.playing = false;
        S.buffering = true;
        S.statusText = "Video buffering — stems paused";
        updateUI();
      }
      analyse(); updateDiag(); return;
    }
    if (S.buffering) {
      S.buffering = false;
      if (S.meta) S.statusText = "Ready";
      updateUI();
    }
    if (isAd()) {
      if (!S.adActive) {
        S.adActive = true;
        stopSources();
        S.playing = false;
        if (S.mutedByUs) { v.muted = S.wasMuted; S.mutedByUs = false; }
        S.statusText = "Ad playing — stems paused";
        updateUI();
      }
      updateDiag();
      return;
    } else if (S.adActive) {
      S.adActive = false;
      S.statusText = S.meta ? "Ready" : S.statusText;
      muteVideo();
      if (!v.paused) reanchor("ad-end");
      updateUI();
    }
    if (S.partial && !v.ended) {
      if (!S.chunkReady[playheadChunk()]) {
        // Not separated here yet: original audio, and pull the worker to this spot.
        if (!S.gap) {
          S.gap = true;
          stopSources();
          S.playing = false;
          unmuteVideoIfOurs();
        }
        if (!v.paused) sendPriority(false);
        analyse(); updateDiag(); return;
      }
      if (S.gap) {
        S.gap = false;
        muteVideo();
        if (!v.paused) reanchor("slice-ready");
      }
    }
    if (S.meta) muteVideo();
    if (!v || v.ended) {
      stopSources(); S.playing = false;
    } else if (v.paused) {
      if (S.sources.length) stopSources();
      S.playing = false;
    } else {
      if (S.ctx && S.ctx.state === "suspended") S.ctx.resume();
      if (!S.anchor) {
        reanchor("play");
      } else {
        var expected = S.anchor.media + (S.ctx.currentTime - S.anchor.ctx) * S.anchor.rate;
        var drift = v.currentTime - expected;
        S.drift = drift;
        if (Math.abs(drift) > S.maxDrift) S.maxDrift = Math.abs(drift);
        if (Math.abs(drift) > DRIFT_LIMIT && v.readyState >= 2 && !v.seeking && nowMs - S.lastReanchorAt > 400) {
          log("drift", (drift * 1000).toFixed(0), "ms -> re-anchor");
          reanchor("drift");
        }
      }
      if (S.ctx) pump();
      S.playing = S.sources.length > 0;
      if (S.phase === "ready" && S.sources.length) S.phase = "playing";
    }
    analyse();
    updateDiag();
  }

  /* --------------------------------------------------------------------- UI */
  function buildUI() {
    if ($("stems-yt-root")) return;
    var root = el("div"); root.id = "stems-yt-root";
    var pill = el("button", "stems-pill"); pill.id = "stems-toggle"; pill.type = "button";
    pill.title = "Stems — separate this video locally on your GPU";
    pill.innerHTML = "<span class='stems-dot'></span><span>STEMS</span>";

    var panel = el("div", "stems-panel"); panel.id = "stems-panel"; panel.hidden = true;
    var head = el("div", "stems-head");
    var hname = el("div", "stems-name"); hname.textContent = "STEMS";
    var sub = el("span", "stems-sub"); sub.textContent = "local";
    hname.appendChild(sub);
    var minBtn = el("button", "stems-min", "×"); minBtn.type = "button"; minBtn.title = "Minimize";
    head.appendChild(hname); head.appendChild(minBtn);

    var note = el("div", "stems-note");
    note.textContent = "Stems start a few seconds after you press the button and are separated just ahead of the playhead; the original audio fills in until they catch up. Replays come from the cache.";
    var title = el("div", "stems-title"); title.id = "stems-title"; title.textContent = "No song yet";
    var status = el("div", "stems-status"); status.id = "stems-status"; status.textContent = "Checking WebGPU…";
    var barWrap = el("div", "stems-bar"); var bar = el("i"); bar.id = "stems-fill"; barWrap.appendChild(bar);
    var startBtn = el("button", "stems-start", "Separate this song"); startBtn.id = "stems-start"; startBtn.type = "button";
    var cancelBtn = el("button", "stems-link", "cancel"); cancelBtn.id = "stems-cancel"; cancelBtn.type = "button"; cancelBtn.hidden = true;

    var mixer = el("div", "stems-mixer"); mixer.id = "stems-mixer"; mixer.hidden = true;
    var emphLabel = el("div", "stems-label", "EMPHASISE");
    var emph = el("div", "stems-emph"); emph.id = "stems-emph";
    var flatBtn = el("button", "stems-chip", "Flat"); flatBtn.type = "button"; flatBtn.dataset.flat = "1";
    emph.appendChild(flatBtn);
    for (var i = 0; i < STEMS.length; i++) {
      (function (idx) {
        var b = el("button", "stems-chip", LABELS[idx]); b.type = "button";
        b.dataset.stem = String(idx);
        b.addEventListener("click", function () { setEmphasis(idx); });
        emph.appendChild(b);
      })(i);
    }
    flatBtn.addEventListener("click", setFlat);

    var faders = el("div", "stems-faders"); faders.id = "stems-faders";
    for (var j = 0; j < STEMS.length; j++) {
      (function (idx) {
        var row = el("label", "stems-fader-row");
        var lab = el("span", "stems-flab", LABELS[idx]);
        var input = document.createElement("input");
        input.type = "range"; input.min = "-24"; input.max = "12"; input.step = "0.5";
        input.value = "0"; input.dataset.fader = String(idx);
        input.setAttribute("aria-label", LABELS[idx] + " gain");
        var val = el("span", "stems-fval", "0.0");
        input.addEventListener("input", function () { setFader(idx, parseFloat(input.value)); });
        row.appendChild(lab); row.appendChild(input); row.appendChild(val);
        faders.appendChild(row);
      })(j);
    }
    var peakLine = el("div", "stems-peak"); peakLine.id = "stems-peak"; peakLine.textContent = "peak-safe master 0.0 dB";
    var syncLine = el("div", "stems-sync"); syncLine.id = "stems-sync"; syncLine.textContent = "Not started";
    var stopBtn = el("button", "stems-link stems-stop", "Stop & restore video audio"); stopBtn.id = "stems-stop"; stopBtn.type = "button";

    mixer.appendChild(emphLabel); mixer.appendChild(emph);
    mixer.appendChild(el("div", "stems-label", "STEM FADERS (dB)"));
    mixer.appendChild(faders); mixer.appendChild(peakLine);
    mixer.appendChild(syncLine); mixer.appendChild(stopBtn);

    var foot = el("div", "stems-foot", "Local only · model htdemucs_6s (MIT) · no uploads");
    var diag = el("pre", "stems-diag"); diag.id = "stems-diag"; diag.style.display = "none";

    panel.appendChild(head); panel.appendChild(note); panel.appendChild(title);
    panel.appendChild(status); panel.appendChild(barWrap);
    panel.appendChild(startBtn); panel.appendChild(cancelBtn);
    panel.appendChild(mixer); panel.appendChild(foot); panel.appendChild(diag);
    root.appendChild(panel); root.appendChild(pill);
    document.documentElement.appendChild(root);

    pill.addEventListener("click", function () {
      panel.hidden = !panel.hidden;
      root.classList.toggle("open", !panel.hidden);
    });
    minBtn.addEventListener("click", function () {
      panel.hidden = true; root.classList.remove("open");
    });
    startBtn.addEventListener("click", onStart);
    cancelBtn.addEventListener("click", onCancel);
    stopBtn.addEventListener("click", onStop);

    ["pointerdown", "mousedown", "click", "dblclick", "keydown", "keyup", "keypress", "wheel", "touchstart"].forEach(function (evt) {
      root.addEventListener(evt, stopEv, false);
    });
    // But YouTube's keyboard shortcuts listen on document; capture-phase stop above
    // only affects events inside the root. That is what we want.

    updateUI();
  }

  function syncFaderUI() {
    if (!S.gains) return;
    for (var i = 0; i < STEMS.length; i++) {
      var input = document.querySelector('[data-fader="' + i + '"]');
      var val = input && input.parentNode && input.parentNode.querySelector(".stems-fval");
      if (input && document.activeElement !== input) input.value = S.gains[i].toFixed(1);
      if (val) val.textContent = (S.gains[i] > 0 ? "+" : "") + S.gains[i].toFixed(1);
      var chip = document.querySelector('[data-stem="' + i + '"]');
      if (chip) chip.classList.toggle("on", S.focus === i);
    }
    var flat = document.querySelector('[data-flat="1"]');
    if (flat) flat.classList.toggle("on", S.focus === null && S.gains.every(function (g) { return g === 0; }));
  }

  function setPhase(p) {
    S.phase = p;
    updateUI();
  }

  function updateUI() {
    if (!mounted) return;
    var now = performance.now();
    if (now - S.lastUI < 80) return;
    S.lastUI = now;
    var status = $("stems-status"), startBtn = $("stems-start"), fill = $("stems-fill");
    var title = $("stems-title"), sync = $("stems-sync"), cancel = $("stems-cancel");
    if (!status) return;
    var v = video();
    var phase = S.phase;
    if (S.error) status.textContent = "Error: " + S.error;
    else if (S.statusText) status.textContent = S.statusText;
    else status.textContent = phase;
    if (S.gpuError) status.textContent = S.gpuError;

    if (startBtn) {
      var active = S.meta && (S.phase === "ready" || S.phase === "playing");
      var label = "Separate this song";
      if (active) label = "Stems active";
      else if (S.phase === "preparing" || S.phase === "engine" || S.phase === "separating") label = "Working…";
      else if (S.gpuError) label = "WebGPU required";
      else if (S.cached) label = "Load cached stems";
      startBtn.textContent = label;
      startBtn.disabled = !!S.gpuError || S.busy || active || ["preparing", "engine", "separating"].indexOf(S.phase) >= 0;
    }
    if (cancel) cancel.hidden = !S.busy;
    if (fill) {
      var pct = 0;
      if (S.progress && S.progress.total) pct = 100 * S.progress.done / S.progress.total;
      else if (S.phase === "ready" || S.phase === "playing") pct = 100;
      fill.style.width = pct + "%";
    }
    if (title) {
      var t = S.meta && S.meta.title ? S.meta.title : (S.title || pageTitle());
      title.textContent = t || "YouTube video";
      title.title = t || "";
    }
    if (sync) {
      if (S.meta && S.ctx) {
        var driftMs = Math.round((S.drift || 0) * 1000);
        sync.textContent = "sync " + (S.playing ? "●" : "○") + " · drift " + driftMs + " ms · re-anchors " + S.reanchors +
          " · " + S.ctx.state;
        sync.classList.toggle("live", S.playing);
      } else sync.textContent = "Not started";
    }
    var root = $("stems-yt-root");
    if (root) root.classList.toggle("busy", S.busy);
  }

  function updateDiag() {
    var d = $("stems-diag");
    if (!d) return;
    var v = video();
    var info = {
      phase: S.phase, statusText: S.statusText, hostReady: hostReady, videoId: S.videoId, title: S.meta ? S.meta.title : S.title,
      cached: S.cached, busy: S.busy, error: S.error, gpuError: S.gpuError,
      video: v ? {
        currentTime: +v.currentTime.toFixed(3), paused: v.paused, ended: v.ended,
        muted: v.muted, rate: v.playbackRate, readyState: v.readyState,
        buffered: (function () { var a = []; for (var i = 0; i < v.buffered.length; i++) a.push([+v.buffered.start(i).toFixed(1), +v.buffered.end(i).toFixed(1)]); return a; })(),
      } : null,
      buffering: S.buffering,
      partial: S.partial, gap: S.gap,
      chunksReady: S.chunkReady ? S.chunkReady.reduce(function (n, x) { return n + x; }, 0) : null,
      ad: S.adActive,
      ctx: S.ctx ? { state: S.ctx.state, sampleRate: S.ctx.sampleRate, time: +S.ctx.currentTime.toFixed(3) } : null,
      anchor: S.anchor ? { media: +S.anchor.media.toFixed(3), ctx: +S.anchor.ctx.toFixed(3), rate: S.anchor.rate, reason: S.anchor.reason } : null,
      playing: S.playing, sources: S.sources.length,
      driftMs: Math.round((S.drift || 0) * 1000), maxDriftMs: Math.round((S.maxDrift || 0) * 1000),
      reanchors: S.reanchors, reanchorLog: S.reanchorLog.slice(-16),
      masterTrimDb: +linToDb(S.masterTrim).toFixed(2),
      masterRms: +S.masterRms.toFixed(5), masterPeak: +S.masterPeak.toFixed(5),
      stemRms: (S.stats && S.stats.stemRms) || (S.meta && S.meta.stemRms) || null,
      stemPeak: (S.stats && S.stats.stemPeak) || (S.meta && S.meta.stemPeak) || null,
      corrMin: (S.stats && S.stats.corrMin), corrMax: (S.stats && S.stats.corrMax),
      meta: S.meta ? { duration: S.meta.duration, length: S.meta.length, chunkFrames: S.meta.chunkFrames, chunkCount: S.meta.chunkCount, scale: S.meta.storeScale } : null,
      timings: S.timings || null,
      progress: S.progress ? { done: S.progress.done, total: S.progress.total, rtf: S.progress.rtf, etaMs: S.progress.etaMs } : null,
      adapter: S.adapter || (S.meta && S.meta.engine && S.meta.engine.adapter) || null,
      engine: S.meta && S.meta.engine ? { createMs: S.meta.engine.createMs, warmMs: S.meta.engine.warmMs, ort: S.meta.engine.ortVersion } : null,
      cache: { usage: S.cacheUsage, quota: S.cacheQuota },
      gains: S.gains, focus: S.focus,
      sliceCache: Array.from(S.sliceCache.keys()),
      jsHeapMB: (performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null),
      readyInMs: S.readyAt && S.startedAt ? Math.round(S.readyAt - S.startedAt) : null,
    };
    d.textContent = JSON.stringify(info);
  }

  /* ----------------------------------------------------------------- actions */
  function resumeIfWasPlaying() {
    if (!S.wasPlaying) return;
    var v = video();
    if (v && v.paused && !v.ended) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
  }

  /* --------------------------------------------------- page-origin audio lookup
   * Firefox: the host frame's POST /youtubei/v1/player leaves with
   * Origin: moz-extension://<uuid> and Google answers 403 "automated queries".
   * The same POST from this content script runs on the youtube.com page origin
   * and returns 200, so the host asks for the formats on a cache miss. The host
   * still downloads the audio; only the lookup moved here. The page's own
   * ytInitialPlayerResponse is tried first (no network at all), but current
   * WEB responses are SABR-only, so the POST is the usual path.
   */
  function pageWindow() {
    try { return window.wrappedJSObject || window; } catch (e) { return window; }
  }

  function pagePlayerResponse() {
    var out = [];
    try {
      var w = pageWindow();
      if (w.ytInitialPlayerResponse) out.push(w.ytInitialPlayerResponse);
      var cfg = w.ytplayer && w.ytplayer.config && w.ytplayer.config.args;
      if (cfg && cfg.player_response) out.push(JSON.parse(cfg.player_response));
    } catch (e) { log("page player response unavailable", e); }
    return out;
  }

  function pageVisitorData() {
    try {
      var w = pageWindow();
      var v = w.ytcfg && w.ytcfg.data_ && w.ytcfg.data_.VISITOR_DATA;
      if (typeof v === "string" && v) return v;
    } catch (e) {}
    try {
      var html = document.documentElement.innerHTML || "";
      var m = html.match(/"VISITOR_DATA":"([^"]+)"/) || html.match(/"visitorData":"([^"]+)"/);
      if (m) return m[1];
    } catch (e) {}
    return null;
  }

  function audioOnlyFormats(pr, videoId) {
    var out = [];
    if (!pr || !pr.streamingData) return out;
    try {
      var vd = pr.videoDetails || {};
      if (vd.videoId && vd.videoId !== videoId) return out;
      var af = pr.streamingData.adaptiveFormats || [];
      for (var i = 0; i < af.length; i++) {
        var f = af[i];
        if (!f || !/^audio\//.test(String(f.mimeType || "")) || !f.url) continue;
        out.push({
          itag: f.itag, url: String(f.url), mimeType: f.mimeType,
          contentLength: f.contentLength, bitrate: f.bitrate, audioQuality: f.audioQuality,
        });
      }
    } catch (e) { log("could not read adaptive formats", e); }
    return out;
  }

  async function freshVisitorData(videoId) {
    var res = await fetch("https://www.youtube.com/watch?v=" + encodeURIComponent(videoId) + "&hl=en&gl=US", {
      credentials: "omit", cache: "no-store",
    });
    if (!res.ok) throw new Error("watch page HTTP " + res.status);
    var html = await res.text();
    var m = html.match(/"visitorData":"(.*?)"/);
    if (!m) throw new Error("watch page has no visitorData");
    return m[1];
  }

  async function innertubeFromPage(videoId, visitorData) {
    var body = {
      context: { client: {
        clientName: "VISIONOS", clientVersion: "1.02", deviceMake: "Apple",
        deviceModel: "RealityDevice17,1", userAgent: VISIONOS_UA,
        osName: "visionOS", osVersion: "26.5.23O471", hl: "en", gl: "US",
        visitorData: visitorData,
      } },
      videoId: videoId, contentCheckOk: true, racyCheckOk: true,
    };
    // No Origin / Referer: both are forbidden header names and Firefox drops
    // them. Same-origin fetch already carries the page origin and referrer.
    var headers = {
      "Content-Type": "application/json",
      "X-YouTube-Client-Name": "101", "X-YouTube-Client-Version": "1.02",
      "X-Goog-Api-Format-Version": "2",
    };
    if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData;
    var res = await fetch("https://www.youtube.com/youtubei/v1/player?key=" + INNERTUBE_KEY, {
      method: "POST", headers: headers, body: JSON.stringify(body),
      credentials: "omit", cache: "no-store",
    });
    var text = await res.text();
    if (!res.ok) {
      var detail = text ? " — " + text.replace(/\s+/g, " ").slice(0, 160) : "";
      throw new Error("player API HTTP " + res.status + detail);
    }
    try { return JSON.parse(text); } catch (e) { throw new Error("player API returned non-JSON"); }
  }

  async function resolveAudioSource(videoId) {
    var prs = pagePlayerResponse();
    for (var i = 0; i < prs.length; i++) {
      var pageFormats = audioOnlyFormats(prs[i], videoId);
      if (pageFormats.length) {
        var pvd = prs[i].videoDetails || {};
        return {
          source: "page-global", videoId: videoId, formats: pageFormats,
          title: pvd.title || "", duration: Number(pvd.lengthSeconds) || 0,
          visitorData: pageVisitorData(),
        };
      }
    }

    var visitorData = pageVisitorData();
    var lastErr = null;
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0 || !visitorData) visitorData = await freshVisitorData(videoId);
        var pr = await innertubeFromPage(videoId, visitorData);
        var ps = pr.playabilityStatus || {};
        if (ps.status !== "OK") {
          var e1 = new Error("YouTube says " + ps.status + (ps.reason ? ": " + ps.reason : ""));
          e1.needsFreshVisitor = /LOGIN_REQUIRED|not a bot|bot/i.test(String(ps.status) + " " + String(ps.reason || ""));
          throw e1;
        }
        var formats = audioOnlyFormats(pr, videoId);
        if (!formats.length) throw new Error("no audio-only format with a direct URL (SABR-only response)");
        var vd = pr.videoDetails || {};
        return {
          source: "content-post", videoId: videoId, formats: formats, visitorData: visitorData,
          title: vd.title || "", duration: Number(vd.lengthSeconds) || 0,
        };
      } catch (e) {
        lastErr = e;
        if (!e.needsFreshVisitor) throw e;
      }
    }
    throw lastErr || new Error("could not resolve audio formats");
  }

  function provideAudioSource(videoId, reqId) {
    if (videoIdFromUrl() !== videoId) {
      hostSend({ type: "audio-source-failed", videoId: videoId, reqId: reqId, message: "page moved to another video" });
      return;
    }
    S.statusText = "Looking up audio";
    updateUI();
    resolveAudioSource(videoId).then(function (source) {
      log("page-origin audio source:", source.source, source.formats.length + " formats",
        "itags " + source.formats.map(function (f) { return f.itag; }).join(","),
        "visitorData " + (source.visitorData ? "yes" : "no"));
      hostSend({ type: "audio-source", videoId: videoId, reqId: reqId, source: source });
    }).catch(function (e) {
      log("page-origin audio lookup failed:", String(e && e.message || e), e && e.stack);
      hostSend({ type: "audio-source-failed", videoId: videoId, reqId: reqId, message: String(e && e.message || e) });
    });
  }

  function onStart() {
    if (S.busy) return;
    if (S.gpuError) { S.error = S.gpuError; updateUI(); return; }
    var v = video();
    var id = videoIdFromUrl();
    if (!v || !id) { S.error = "No YouTube video found on this page"; setPhase("error"); return; }
    S.error = null;
    S.videoId = id;
    S.title = pageTitle();
    S.startedAt = performance.now();
    S.meta = null; S.stats = null; S.timings = null; S.progress = null; S.cached = false;
    S.sliceCache.clear();
    S.pending.clear();
    S.reanchors = 0; S.drift = 0; S.maxDrift = 0;
    var inAd = isAd();
    S.adStart = inAd;
    S.wasPlaying = inAd ? true : (!v.paused && !v.ended);
    S.startAt = v.currentTime;
    S.busy = true;
    S.partial = false; S.chunkReady = null; S.gap = false;
    S.statusText = inAd ? "Ad playing — separating anyway; stems join when it ends" : "Checking WebGPU…";
    setPhase("preparing");
    // The video keeps playing with its own audio; stems take over chunk by chunk.
    ensureAudio();
    ensureHost();
    hostSend({ type: "prepare", videoId: id, title: S.title, opts: { startSec: v.currentTime } });
    updateUI();
  }

  function onCancel() {
    hostSend({ type: "cancel" });
    if (S.partial) {
      clearTimeout(S.settleTimer);
      stopSources();
      S.meta = null; S.stats = null;
      S.partial = false; S.chunkReady = null; S.gap = false;
      S.sliceCache.clear(); S.pending.clear();
      var mx = $("stems-mixer"); if (mx) mx.hidden = true;
    }
    S.busy = false;
    S.statusText = "Cancelled";
    setPhase("stopped");
    unmuteVideoIfOurs();
    resumeIfWasPlaying();
    updateUI();
  }

  function onStop() {
    clearTimeout(S.settleTimer);
    stopSources();
    S.playing = false;
    S.busy = false;
    S.meta = null; S.stats = null; S.timings = null; S.progress = null;
    S.partial = false; S.chunkReady = null; S.gap = false;
    S.sliceCache.clear(); S.pending.clear();
    var mx = $("stems-mixer"); if (mx) mx.hidden = true;
    S.statusText = "Stopped — video audio restored";
    setPhase("stopped");
    unmuteVideoIfOurs();
    updateUI();
    updateDiag();
  }

  /* --------------------------------------------------------------- lifecycle */
  function mountForCurrentPage() {
    if (!isWatchPage()) {
      var r = $("stems-yt-root");
      if (r) r.remove();
      if (hostEl) { try { hostEl.remove(); } catch (e) {} }
      hostEl = null; hostReady = false; hostQueue = [];
      if (S.ctx) stopSources();
      unmuteVideoIfOurs();
      mounted = false;
      S.phase = "idle"; S.meta = null;
      return;
    }
    if (mounted && mountedFor === videoIdFromUrl()) return;
    mountedFor = videoIdFromUrl();
    S.videoId = mountedFor;
    S.title = pageTitle();
    S.meta = null; S.stats = null; S.phase = "idle"; S.cached = false; S.progress = null;
    S.partial = false; S.chunkReady = null; S.gap = false;
    S.error = null; S.busy = false; S.statusText = "Checking WebGPU…";
    S.sliceCache.clear(); S.pending.clear();
    stopSources();
    unmuteVideoIfOurs();
    S.mutedByUs = false;
    if (!mounted) { buildUI(); mounted = true; }
    ensureHost();
    if (hostReady) hostSend({ type: "cache-status", videoId: S.videoId });
    checkGPU();
    updateUI();
    updateDiag();
  }

  async function checkGPU() {
    if (!navigator.gpu) {
      S.gpuError = "WebGPU is not available in this browser/page. This extension requires WebGPU and does not fall back to WASM (the 258 MB fp32 model OOMs under wasm32).";
      setPhase("error"); updateUI(); return;
    }
    try {
      var a = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!a) { S.gpuError = "No WebGPU adapter (requestAdapter returned null). This extension requires WebGPU."; setPhase("error"); updateUI(); return; }
      if (a.isFallbackAdapter) { S.gpuError = "Only a software WebGPU adapter is available. Refusing to run the 258 MB model on it."; setPhase("error"); updateUI(); return; }
      S.adapter = a.info ? { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device } : {};
      S.gpuError = null;
      if (S.phase === "error") setPhase("idle");
      var adapterBits = [];
      if (S.adapter.vendor) adapterBits.push(S.adapter.vendor);
      if (S.adapter.architecture) adapterBits.push(S.adapter.architecture);
      if (S.adapter.device) adapterBits.push(S.adapter.device);
      S.statusText = "WebGPU ready" + (adapterBits.length ? " · " + adapterBits.join(" ") : "");
    } catch (e) {
      S.gpuError = "WebGPU adapter check failed: " + String(e && e.message || e);
      setPhase("error");
    }
    updateUI();
  }

  function watchVideoEvents() {
    var listeners = {
      play: function () { if (S.meta && !S.gap) { muteVideo(); if (!isAd()) reanchor("play"); } },
      playing: function () { if (S.meta && !isAd()) reanchor("playing"); },
      pause: function () { stopSources(); S.playing = false; updateDiag(); },
      waiting: function () {
        if (!S.meta || isAd()) return;
        stopSources(); S.playing = false; S.buffering = true;
        S.statusText = "Video buffering — stems paused"; updateUI();
      },
      seeking: function () { stopSources(); S.playing = false; },
      seeked: function () {
        if (S.partial) sendPriority(true);
        if (S.meta && !video().paused && !isAd()) reanchor("seeked");
      },
      ratechange: function () { if (S.meta && !isAd()) reanchor("ratechange"); },
      ended: function () { stopSources(); S.playing = false; },
      volumechange: function () {
        var v = video();
        if (S.meta && S.mutedByUs && v && !v.muted && !isAd()) v.muted = true;
      },
      durationchange: function () { updateUI(); },
    };
    ["play", "playing", "pause", "waiting", "seeking", "seeked", "ratechange", "ended", "volumechange", "durationchange"].forEach(function (n) {
      document.addEventListener(n, function (e) {
        if (!S.meta) return;
        if (e.target && e.target.tagName === "VIDEO") listeners[n]();
      }, true);
    });
  }

  function watchAds() {
    var p = player();
    if (!p) return;
    if (adObserver) adObserver.disconnect();
    adObserver = new MutationObserver(function () {
      if (isAd() && !S.adActive) {
        S.adActive = true;
        stopSources();
        S.playing = false;
        var v = video();
        if (S.mutedByUs && v) { v.muted = S.wasMuted; S.mutedByUs = false; }
        S.statusText = "Ad playing — stems paused";
        updateUI();
      } else if (!isAd() && S.adActive) {
        S.adActive = false;
        if (S.meta) {
          muteVideo();
          S.statusText = "Ready";
          var v2 = video();
          if (v2 && !v2.paused) reanchor("ad-end");
          updateUI();
        }
      }
    });
    adObserver.observe(p, { attributes: true, attributeFilter: ["class"] });
  }

  function init() {
    watchVideoEvents();
    clearInterval(tickTimer);
    tickTimer = setInterval(tick, 200);
    clearInterval(uiTimer);
    uiTimer = setInterval(updateUI, 500);
    function route() {
      if (isWatchPage()) {
        var changed = mountedFor !== videoIdFromUrl();
        mountForCurrentPage();
        if (changed) setTimeout(watchAds, 800);
      } else {
        mountForCurrentPage();
      }
    }
    route();
    setTimeout(watchAds, 1500);
    setInterval(route, 1500);
    document.addEventListener("yt-navigate-finish", function () {
      setTimeout(function () { route(); setTimeout(watchAds, 500); }, 300);
    });
    window.addEventListener("popstate", function () { setTimeout(route, 300); });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && S.meta && video() && !video().paused) tick();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();