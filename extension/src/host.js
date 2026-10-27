/* Stems for YouTube — extension-origin host frame.
 *
 * This document has the extension origin, so it can:
 *   - fetch youtube.com / googlevideo.com with the manifest host permissions
 *     (the content script cannot: MV3 content-script fetch is page-CORS bound),
 *   - open the extension-origin IndexedDB cache,
 *   - spawn the WebGPU separation module worker (page CSP cannot block it).
 *
 * It never renders UI and never touches the page DOM. The content script talks
 * to it with postMessage; all commands are tagged __stemsCmd and all replies
 * are tagged __stemsHost.
 */
(function () {
  "use strict";

  var DB_NAME = "stems-yt-cache";
  var DB_VER = 1;
  var SR = 44100;
  var STEMS = 6;
  var MAX_SECONDS = 12 * 60;
  // PUBLIC CONSTANT, NOT A SECRET. This is YouTube web client key. It ships inside
  // YouTube own JavaScript and is visible in every browser that opens youtube.com, as the
  // request URL https://www.youtube.com/youtubei/v1/player?key=... which sits in any cache
  // of YouTube pages. It grants no private access, is not a personal credential, and cannot
  // be revoked by anyone except YouTube. Secret-scanner matches here are false positives.
  var INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  var VISIONOS_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

  var dbPromise = null;
  var worker = null;
  var current = null;          // {videoId, meta, source}
  var busy = false;
  var pending = null;          // {videoId, resolve...}
  var visitor = null, visitorAt = 0;
  var abortCtl = null;
  var audioSourcePending = null;
  var priorityFrame = 0;       // latest playhead from the page, in frames

  function send(msg, transfer) {
    if (parent) parent.postMessage(Object.assign({ __stemsHost: true }, msg), "*", transfer || []);
  }
  function log(msg) { send({ type: "log", msg: String(msg) }); }
  function status(stage, extra) { send(Object.assign({ type: "status", stage: stage }, extra || {})); }
  function fail(stage, err) {
    /* SpiderMonkey stacks do not start with "Error: <message>", so showing the
       stack first used to hide the actual reason in Firefox. Report both. */
    var message = String(err && err.message || err || "unknown error");
    var stack = err && err.stack ? String(err.stack) : "";
    if (stack && stack.indexOf(message) === -1) message += "\n" + stack;
    else if (stack) message = stack;
    send({ type: "error", stage: stage, message: message });
  }

  /* ------------------------------------------------------------- IndexedDB */
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains("songs")) db.createObjectStore("songs", { keyPath: "videoId" });
        if (!db.objectStoreNames.contains("stems")) db.createObjectStore("stems", { keyPath: "key" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function reqPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function getMeta(videoId) {
    return openDB().then(function (db) {
      return reqPromise(db.transaction("songs", "readonly").objectStore("songs").get(videoId));
    });
  }

  function stemRange(videoId) {
    return IDBKeyRange.bound(videoId + ":", videoId + ":\uffff");
  }

  async function cacheComplete(meta) {
    var db = await openDB();
    var tx = db.transaction("stems", "readonly");
    var n = await reqPromise(tx.objectStore("stems").count(stemRange(meta.videoId)));
    return n === meta.chunkCount * STEMS;
  }

  async function clearCache(videoId) {
    var db = await openDB();
    var tx = db.transaction(["songs", "stems"], "readwrite");
    tx.objectStore("songs").delete(videoId);
    tx.objectStore("stems").delete(stemRange(videoId));
    await new Promise(function (resolve, reject) {
      tx.oncomplete = resolve;
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error("idb abort")); };
    });
  }

  async function readSlice(startFrame, count) {
    if (!current) throw new Error("no separated song loaded");
    var meta = current.meta;
    var start = Math.max(0, Math.min(meta.length, Math.floor(startFrame)));
    var n = Math.max(0, Math.min(count, meta.length - start));
    if (n <= 0) return { frames: 0, data: [] };
    var chunkFrames = meta.chunkFrames;
    var firstChunk = Math.floor(start / chunkFrames);
    var lastChunk = Math.floor((start + n - 1) / chunkFrames);
    var db = await openDB();
    var tx = db.transaction("stems", "readonly");
    var store = tx.objectStore("stems");
    var out = [];
    for (var s = 0; s < STEMS; s++) out.push(new Int16Array(n * 2));
    for (var ci = firstChunk; ci <= lastChunk; ci++) {
      var recs = [];
      for (var s2 = 0; s2 < STEMS; s2++) {
        recs.push(await reqPromise(store.get(current.videoId + ":" + s2 + ":" + ci)));
      }
      var chunkStart = ci * chunkFrames;
      var from = Math.max(start, chunkStart);
      var to = Math.min(start + n, chunkStart + (recs[0] ? recs[0].frames : 0));
      if (to <= from) continue;
      for (var s3 = 0; s3 < STEMS; s3++) {
        if (!recs[s3]) throw new Error("cache chunk missing " + s3 + ":" + ci);
        var src = new Int16Array(recs[s3].data);
        var dstOff = (from - start) * 2;
        var srcOff = (from - chunkStart) * 2;
        var len = (to - from) * 2;
        out[s3].set(src.subarray(srcOff, srcOff + len), dstOff);
      }
    }
    return { frames: n, data: out };
  }

  /* ------------------------------------------------------------- YouTube */
  async function getVisitor(force) {
    if (!force && visitor && Date.now() - visitorAt < 5 * 60 * 1000) return visitor;
    var res = await fetch("https://www.youtube.com/watch?v=" + encodeURIComponent(currentVideoId) + "&hl=en&gl=US", {
      credentials: "omit", cache: "no-store",
    });
    if (!res.ok) throw new Error("watch page HTTP " + res.status);
    var html = await res.text();
    var m = html.match(/"visitorData":"(.*?)"/);
    visitor = m ? m[1] : null;
    visitorAt = Date.now();
    return visitor;
  }

  var currentVideoId = null;

  /* FIX A: in Firefox the innertube POST is rejected (HTTP 403 "automated
     queries") when it leaves from the moz-extension:// origin. The content
     script asks for this on a cache miss, runs the same request from the
     youtube.com page origin, and returns the adaptive formats here. The audio
     download itself still happens in this frame. */
  function requestAudioSource(videoId) {
    return new Promise(function (resolve, reject) {
      var reqId = "src-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      var timer = setTimeout(function () {
        if (audioSourcePending && audioSourcePending.reqId === reqId) audioSourcePending = null;
        reject(new Error("page-origin audio lookup timed out"));
      }, 60000);
      audioSourcePending = { reqId: reqId, videoId: videoId, resolve: resolve, reject: reject, timer: timer };
      send({ type: "need-audio", videoId: videoId, reqId: reqId });
    });
  }

  function settleAudioSource(reqId, ok, value) {
    var p = audioSourcePending;
    if (!p || p.reqId !== reqId) return;
    audioSourcePending = null;
    clearTimeout(p.timer);
    if (ok) p.resolve(value);
    else p.reject(value instanceof Error ? value : new Error(String(value)));
  }

  async function innertubePlayer(videoId, visitorData) {
    var body = {
      context: { client: {
        clientName: "VISIONOS", clientVersion: "1.02", deviceMake: "Apple",
        deviceModel: "RealityDevice17,1", userAgent: VISIONOS_UA,
        osName: "visionOS", osVersion: "26.5.23O471", hl: "en", gl: "US",
        visitorData: visitorData,
      } },
      videoId: videoId, contentCheckOk: true, racyCheckOk: true,
    };
    var headers = {
      "Content-Type": "application/json", "User-Agent": VISIONOS_UA,
      "X-YouTube-Client-Name": "101", "X-YouTube-Client-Version": "1.02",
      "X-Goog-Api-Format-Version": "2",
      "Origin": "https://www.youtube.com", "Referer": "https://www.youtube.com/",
    };
    if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData;
    var res = await fetch("https://www.youtube.com/youtubei/v1/player?key=" + INNERTUBE_KEY, {
      method: "POST", headers: headers, body: JSON.stringify(body), credentials: "omit",
    });
    if (!res.ok) throw new Error("player API HTTP " + res.status);
    return res.json();
  }

  function pickAudio(pr) {
    var sd = pr.streamingData || {};
    var formats = (sd.adaptiveFormats || []).filter(function (f) {
      return /^audio\//.test(String(f.mimeType || "")) && f.url;
    });
    var pref = [251, 140, 250, 249];
    formats.sort(function (a, b) {
      var ia = pref.indexOf(a.itag), ib = pref.indexOf(b.itag);
      if (ia < 0) ia = 99; if (ib < 0) ib = 99;
      return ia - ib;
    });
    return formats;
  }

  async function fetchBytes(url, label, onProgress) {
    abortCtl = new AbortController();
    var timer = setTimeout(function () { abortCtl.abort(); }, 90000);
    var res, reader, chunks = [], got = 0;
    try {
      res = await fetch(url, {
        credentials: "omit", cache: "no-store", signal: abortCtl.signal,
        headers: { "Range": "bytes=0-" },
      });
      if (!res.ok) throw new Error(label + " HTTP " + res.status);
      reader = res.body.getReader();
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        chunks.push(r.value);
        got += r.value.byteLength;
        if (onProgress) onProgress(got, Number(res.headers.get("content-length") || 0));
      }
    } finally {
      clearTimeout(timer);
    }
    var ab = new Uint8Array(got), off = 0;
    for (var i = 0; i < chunks.length; i++) { ab.set(chunks[i], off); off += chunks[i].byteLength; }
    return ab.buffer;
  }

  async function decodeAudio(ab) {
    var C = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var ctx = new C(2, 1, SR);
    var buf = await ctx.decodeAudioData(ab);
    var n = buf.length;
    var L = new Float32Array(n);
    var R = new Float32Array(n);
    L.set(buf.getChannelData(0));
    R.set(buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0));
    return { L: L, R: R, length: n, sampleRate: buf.sampleRate, duration: buf.duration };
  }

  async function prepareAudio(videoId, title, source) {
    var t0 = performance.now();
    currentVideoId = videoId;

    var pr = null, lastErr = null;
    if (source && source.formats && source.formats.length) {
      /* Formats resolved by content.js on the page origin. playabilityStatus was
         already checked there; keep the shape pickAudio() expects. */
      pr = {
        playabilityStatus: { status: "OK" },
        streamingData: { adaptiveFormats: source.formats },
        videoDetails: { title: source.title || title || "", lengthSeconds: source.duration || 0 },
      };
      log("page-origin audio: " + source.formats.length + " format(s) via " + (source.source || "page"));
    } else {
      status("fetching", { msg: "Looking up audio" });
      for (var attempt = 0; attempt < 2 && !pr; attempt++) {
        try {
          var v = await getVisitor(attempt > 0);
          pr = await innertubePlayer(videoId, v);
        } catch (e) { lastErr = e; }
      }
      if (!pr) throw lastErr || new Error("player lookup failed");
    }
    var ps = pr.playabilityStatus || {};
    if (ps.status !== "OK") throw new Error("YouTube says " + ps.status + (ps.reason ? ": " + ps.reason : ""));
    var formats = pickAudio(pr);
    if (!formats.length) throw new Error("no audio-only format with a direct URL (SABR-only response)");
    status("fetching", { msg: "Downloading audio", duration: Number(pr.videoDetails && pr.videoDetails.lengthSeconds) || 0 });
    var lowest = 99;
    var lastDecodeErr = null;
    for (var fi = 0; fi < formats.length; fi++) {
      var f = formats[fi];
      if (lowest !== 99 && prefRank(f.itag) > lowest) break;
      try {
        var tFetch = performance.now();
        var ab = await fetchBytes(f.url, "audio itag " + f.itag, function (got, total) {
          if (total) status("fetching", { got: got, total: total, pct: got / total });
        });
        var fetchMs = performance.now() - tFetch;
        status("decoding", { bytes: ab.byteLength, fetchMs: fetchMs, itag: f.itag });
        var tDecode = performance.now();
        var audio = await decodeAudio(ab);
        var decodeMs = performance.now() - tDecode;
        if (audio.duration > MAX_SECONDS) throw new Error("audio is longer than " + (MAX_SECONDS / 60) + " minutes");
        status("separating", {
          duration: audio.duration, frames: audio.length, sampleRate: audio.sampleRate,
          itag: f.itag, bytes: ab.byteLength, fetchMs: fetchMs, decodeMs: decodeMs,
          title: title || (pr.videoDetails && pr.videoDetails.title) || "",
        });
        return {
          audio: audio, itag: f.itag, bytes: ab.byteLength,
          fetchMs: fetchMs, decodeMs: decodeMs, lookupMs: 0,
          title: title || (pr.videoDetails && pr.videoDetails.title) || "",
        };
      } catch (e) {
        lastDecodeErr = e;
        if (e && e.name === "AbortError") throw e;
        lowest = prefRank(f.itag);
        log("format " + f.itag + " failed: " + String(e && e.message || e));
      }
    }
    throw lastDecodeErr || new Error("could not fetch a decodable audio format");
  }

  function prefRank(itag) {
    var p = [251, 140, 250, 249].indexOf(itag);
    return p < 0 ? 99 : p;
  }

  /* --------------------------------------------------------------- worker */
  /* The host frame is served as a web-accessible resource, and in some Chrome builds that
     leaves chrome.runtime undefined inside it. Resolve extension paths from location
     instead, so this never depends on extension API bindings being present. */
  var EXT_BASE = new URL('../', location.href).href;
  function extUrl(rel) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        return chrome.runtime.getURL(rel);
      }
    } catch (e) {}
    return EXT_BASE + rel;
  }
  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(extUrl("src/engine.worker.js"), { type: "module" });
    worker.onmessage = function (e) { onWorker(e.data || {}); };
    worker.onerror = function (e) {
      fail("worker", e.message || "worker crashed");
    };
    return worker;
  }

  function onWorker(m) {
    if (m.type === "engine-status") {
      status("engine", { msg: m.msg, adapter: m.adapter, engineMs: m.createMs });
    } else if (m.type === "engine-ready") {
      log("engine ready in " + Math.round(m.info.totalMs) + " ms");
    } else if (m.type === "started") {
      // Partial meta: enough to serve slices for chunks as they land.
      current = { videoId: m.meta.videoId, meta: m.meta, source: "partial" };
      send({ type: "partial-start", meta: m.meta });
    } else if (m.type === "chunk-ready") {
      send({ type: "chunk-ready", videoId: m.videoId, chunk: m.chunk, blockStart: m.blockStart, blockPeaks: m.blockPeaks });
    } else if (m.type === "progress") {
      status("separating", { progress: m });
    } else if (m.type === "ready") {
      finishPrepare(m);
    } else if (m.type === "error") {
      if (/cancelled/.test(String(m.message))) {
        status("cancelled");
      } else {
        fail("separate", m.message);
      }
      busy = false;
    }
  }

  function finishPrepare(m) {
    current = { videoId: m.meta.videoId, meta: m.meta, source: "fresh" };
    busy = false;
    send({ type: "ready", cached: false, meta: m.meta, stats: m.stats, timings: m.timings });
  }

  async function prepare(videoId, title, opts) {
    if (busy) { status("error", { message: "already busy" }); return; }
    busy = true;
    var t0 = performance.now();
    try {
      status("cache-check", {});
      var meta = await getMeta(videoId);
      if (meta && !(opts && opts.force)) {
        var complete = await cacheComplete(meta);
        if (complete) {
          current = { videoId: videoId, meta: meta, source: "cache" };
          busy = false;
          send({
            type: "ready", cached: true, meta: meta,
            stats: { stemRms: meta.stemRms, stemPeak: meta.stemPeak, corrMin: meta.corrMin, corrMax: meta.corrMax },
            timings: { cacheLoadMs: performance.now() - t0, audioSec: meta.duration },
          });
          return;
        }
        log("cache meta present but chunks missing; re-separating");
        await clearCache(videoId);
      }
      status("fetching", { msg: "Looking up audio" });
      priorityFrame = Math.max(0, Math.floor(((opts && opts.startSec) || 0) * SR));
      // Start the engine now so session creation overlaps the audio download.
      ensureWorker().postMessage({ type: "init", vendorUrl: extUrl("vendor/"), modelUrl: extUrl("models/htdemucs_6s_web.onnx") });
      var source = null;
      try {
        source = await requestAudioSource(videoId);
      } catch (e) {
        if (e && /cancelled/.test(String(e.message || e))) throw e;
        log("page-origin audio lookup failed: " + String(e && e.message || e));
      }
      var prep = await prepareAudio(videoId, title, source);
      var audio = prep.audio;
      currentVideoId = videoId;
      var w = ensureWorker();
      busy = true;
      w.postMessage({
        type: "separate",
        videoId: videoId,
        title: prep.title,
        mixL: audio.L, mixR: audio.R, length: audio.length,
        sampleRate: audio.sampleRate,
        startFrame: priorityFrame,
        vendorUrl: extUrl("vendor/"),
        modelUrl: extUrl("models/htdemucs_6s_web.onnx"),
      }, [audio.L.buffer, audio.R.buffer]);
      // The worker posts progress/ready; finishPrepare handles the rest.
    } catch (e) {
      busy = false;
      if (e && /cancelled/.test(String(e.message || e))) { status("cancelled"); return; }
      fail("prepare", e);
    }
  }

  async function cacheStatus(videoId) {
    try {
      var meta = await getMeta(videoId);
      if (!meta) { send({ type: "cache-status", videoId: videoId, cached: false }); return; }
      send({
        type: "cache-status", videoId: videoId, cached: true,
        meta: {
          title: meta.title, duration: meta.duration, length: meta.length,
          chunkCount: meta.chunkCount, createdAt: meta.createdAt,
          stemRms: meta.stemRms, stemPeak: meta.stemPeak,
          corrMin: meta.corrMin, corrMax: meta.corrMax, engine: meta.engine,
        },
      });
    } catch (e) {
      send({ type: "cache-status", videoId: videoId, cached: false, error: String(e) });
    }
  }

  /* -------------------------------------------------------------- commands */
  window.addEventListener("message", function (ev) {
    if (ev.source !== parent) return;
    var m = ev.data || {};
    if (m.__stemsCmd !== true) return;
    if (m.type === "cache-status") {
      cacheStatus(m.videoId);
    } else if (m.type === "prepare") {
      prepare(m.videoId, m.title, m.opts);
    } else if (m.type === "audio-source") {
      settleAudioSource(m.reqId, true, m.source || null);
    } else if (m.type === "audio-source-failed") {
      settleAudioSource(m.reqId, false, new Error(m.message || "page-origin audio lookup failed"));
    } else if (m.type === "priority") {
      priorityFrame = Math.max(0, Math.floor((m.sec || 0) * SR));
      if (worker) worker.postMessage({ type: "priority", frame: priorityFrame });
    } else if (m.type === "slice") {
      readSlice(m.startFrame, m.count).then(function (r) {
        send({
          type: "slice", reqId: m.reqId, startFrame: m.startFrame, frames: r.frames,
          scale: current ? current.meta.storeScale : 4, data: r.data,
        }, r.data.map(function (a) { return a.buffer; }));
      }).catch(function (e) {
        send({ type: "slice-error", reqId: m.reqId, message: String(e && e.message || e) });
      });
    } else if (m.type === "cancel") {
      busy = false;
      if (audioSourcePending) settleAudioSource(audioSourcePending.reqId, false, new Error("cancelled"));
      if (worker) worker.postMessage({ type: "cancel" });
      if (abortCtl) { try { abortCtl.abort(); } catch (e) {} }
      status("cancelled");
    } else if (m.type === "clear-cache") {
      clearCache(m.videoId).then(function () { send({ type: "cleared", videoId: m.videoId }); });
    } else if (m.type === "stats") {
      Promise.all([navigator.storage.estimate(), openDB()]).then(function (r) {
        send({ type: "stats-result", usage: r[0].usage, quota: r[0].quota, hasCurrent: !!current, source: current && current.source });
      }).catch(function () { send({ type: "stats-result", usage: null, quota: null }); });
    }
  });

  send({ type: "host-ready" });
})();
