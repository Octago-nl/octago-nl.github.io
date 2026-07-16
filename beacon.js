/* ============================================================================
 * Octagonal — beacon.js   (the ~2KB Cartridge telemetry beacon)
 * ----------------------------------------------------------------------------
 * INSERT COIN. Ships INSIDE the shared engine (amortized across the catalog),
 * so every game emits the SAME canonical vocabulary and any newly added field
 * lights up everywhere at once (ARCHITECTURE.md §5, CARTRIDGE.md §3).
 *
 * Contract (non-negotiable):
 *   - POST batches to the ONE external collector (window.OCTAGO_COLLECTOR,
 *     scripts/collector/worker.js). NEVER writes telemetry to a repo — a browser
 *     physically cannot commit to git, so there is NO beacon-to-repo fallback.
 *   - Resilience = a localStorage RING BUFFER + retry with exponential backoff.
 *     Batches flush on a timer and last-gasp on visibilitychange/pagehide.
 *   - CLIENT-SIDE SAMPLING above a per-bucket volume threshold (deterministic by
 *     event_id hash — no RNG); the collector's returned sample_rate is honored too.
 *   - ts is SERVER-STAMPED at the collector; the client sends NONE it trusts.
 *   - Emits EXACTLY the 17-event vocabulary in signals/schema.json, envelope:
 *       { event_id, source:"beacon", entity, event, value, unit,
 *         dims:{ geo, device, variant, referrer, player } }
 *     (+ dims.slug for slug-entity events — the collector shards on it and
 *      whitelists exactly these dims; anything else is stripped server-side.)
 *   - Money is NEVER trusted from here: purchase/tip/coin_insert are reconciled
 *     against Stripe/Ko-fi and are rejected on the browser channel by the
 *     collector. We still expose the names (vocabulary is exact) but the engine
 *     drives the checkout FUNNEL via `checkout_step`, not money events.
 *
 * No build step. Classic-script + global (window.OCTAGO_BEACON); a guarded
 * module.exports tail keeps `node --check` / tooling happy. No frameworks.
 * ==========================================================================*/
(function (root) {
  "use strict";

  var VERSION = "v1.0.0";

  // The 17 canonical events — EXACTLY these, no variants (signals/schema.json).
  var VOCAB = {
    play_start: 1, play_end: 1, level: 1, score: 1, share_click: 1,
    coin_insert: 1, tip: 1, ad_impression: 1, ad_click: 1, purchase: 1,
    checkout_step: 1, rewarded_optin: 1, embed_load: 1, xp_earn: 1,
    quest_progress: 1, cross_promo_click: 1, error: 1
  };
  var ENTITY = { slug: 1, site: 1, company: 1, experiment: 1, player: 1 };
  var UNIT = { count: 1, ms: 1, usd: 1, ratio: 1, position: 1 };

  var CFG = {
    collector: "",           // window.OCTAGO_COLLECTOR — the one external collector
    key: "octgnl_pub_live",  // PUBLIC ingest key (routing label, NOT a secret)
    turnstile: "",           // Cloudflare Turnstile token (browser channel proof)
    entity: "slug",          // default entity category
    slug: "",                // game slug (rides in dims.slug — collector shards on it)
    defaultDims: {},         // { variant, geo, ... } engine-supplied
    maxBatch: 50,            // events per POST (collector MAX_BATCH)
    maxBuffer: 200,          // ring-buffer cap; drop-oldest to bound memory
    flushMs: 12000,          // idle flush cadence
    backoffBase: 2000,       // retry backoff base (ms)
    backoffMax: 300000,      // retry backoff ceiling (5 min)
    bucketSec: 300,          // 5-min volume bucket (mirrors collector SHARD_BUCKET_SEC)
    sampleThreshold: 2000,   // events/bucket above which the client self-samples
    sampleFloor: 0.1         // never sample below 10% (trends stay measurable)
  };

  var BUF_KEY = "octago.q";
  var mem = [];              // in-memory fallback when localStorage is unavailable
  var sampleRate = 1;        // last collector-advertised rate (persisted in RAM)
  var volBucket = 0, volCount = 0;
  var backoff = CFG.backoffBase;
  var inflight = false, timer = null, started = false;

  /* ---- storage shim (privacy-mode safe) --------------------------------- */
  function ls() { try { return root.localStorage; } catch (_) { return null; } }
  function readBuf() {
    var s = ls();
    if (!s) return mem.slice();
    try { var v = JSON.parse(s.getItem(BUF_KEY) || "[]"); return Array.isArray(v) ? v : []; }
    catch (_) { return []; }
  }
  function writeBuf(q) {
    if (q.length > CFG.maxBuffer) q = q.slice(q.length - CFG.maxBuffer); // drop oldest
    var s = ls();
    if (!s) { mem = q; return; }
    try { s.setItem(BUF_KEY, JSON.stringify(q)); } catch (_) { mem = q; }
  }

  /* ---- tiny utils ------------------------------------------------------- */
  function uuid() {
    try { if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID(); } catch (_) {}
    var b = new Uint8Array(16);
    try { root.crypto.getRandomValues(b); }
    catch (_) { for (var i = 0; i < 16; i++) b[i] = (i * 2654435761) & 255; } // last-resort, non-crypto
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = []; for (var j = 0; j < 16; j++) h.push((b[j] + 0x100).toString(16).slice(1));
    return h[0] + h[1] + h[2] + h[3] + "-" + h[4] + h[5] + "-" + h[6] + h[7] +
           "-" + h[8] + h[9] + "-" + h[10] + h[11] + h[12] + h[13] + h[14] + h[15];
  }
  // Deterministic [0,1) from a string — same FNV-1a the collector uses so client
  // + server sampling agree on which event_ids survive.
  function hashUnit(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h / 0xffffffff;
  }
  function nowSec() { return Math.floor(Date.now() / 1000); }
  function device() {
    try { if (root.matchMedia && root.matchMedia("(pointer:coarse)").matches) return "mobile"; }
    catch (_) {}
    return "desktop";
  }

  /* ---- envelope --------------------------------------------------------- */
  function envelope(event, opts) {
    opts = opts || {};
    var entity = opts.entity || CFG.entity || "slug";
    if (!ENTITY[entity]) entity = "slug";
    var d = opts.dims || {};
    var dd = CFG.defaultDims || {};
    var dims = {
      geo: d.geo || dd.geo || "",                 // left blank; the collector/CF edge derives geo
      device: d.device || dd.device || device(),
      variant: d.variant || dd.variant || "",
      referrer: d.referrer || dd.referrer || refOnce(),
      player: d.player || dd.player || ""         // oct_pid — engine sets it via defaultDims
    };
    var slug = opts.slug || CFG.slug;
    if (entity === "slug" && slug) dims.slug = String(slug); // collector shards on dims.slug
    var unit = UNIT[opts.unit] ? opts.unit : "count";
    var value = (typeof opts.value === "number" && isFinite(opts.value)) ? opts.value : 1;
    // NOTE: no `ts` — it is server-stamped at the collector; we send none we trust.
    return { event_id: uuid(), source: "beacon", entity: entity, event: event, value: value, unit: unit, dims: dims };
  }
  var _ref;
  function refOnce() {
    if (_ref != null) return _ref;
    try { _ref = (root.document && root.document.referrer) || ""; } catch (_) { _ref = ""; }
    return _ref;
  }

  /* ---- sampling (self-throttle above the volume threshold) -------------- */
  function keep(ev) {
    var b = Math.floor(nowSec() / CFG.bucketSec);
    if (b !== volBucket) { volBucket = b; volCount = 0; }
    volCount++;
    var localRate = 1;
    if (volCount > CFG.sampleThreshold) {
      localRate = Math.max(CFG.sampleFloor, CFG.sampleThreshold / volCount);
    }
    var rate = Math.min(sampleRate, localRate);
    if (rate >= 1) return true;
    return hashUnit(ev.event_id) < rate;
  }

  /* ---- public: emit ----------------------------------------------------- */
  function emit(event, opts) {
    if (!VOCAB[event]) {
      warn("beacon: unknown event dropped: " + event + " (use signals/schema.json vocab or file a Signal Request)");
      return null;
    }
    var ev = envelope(event, opts);
    if (!keep(ev)) return null;      // sampled out at the source
    var q = readBuf(); q.push(ev); writeBuf(q);
    // play_end / error are terminal-ish: nudge a flush soon so we don't lose them.
    if (event === "play_end" || event === "error") flushSoon(250);
    return ev;
  }

  /* ---- transport: batched POST + backoff -------------------------------- */
  function flushSoon(ms) {
    if (timer) { try { clearTimeout(timer); } catch (_) {} }
    timer = setTimeout(function () { timer = null; flush(); }, Math.max(0, ms || 0));
  }

  function flush() {
    if (inflight) return Promise.resolve();
    var q = readBuf();
    if (!q.length) return Promise.resolve();
    if (!CFG.collector) { warn("beacon: no collector configured (window.OCTAGO_COLLECTOR) — buffering"); return Promise.resolve(); }
    try { if (root.navigator && root.navigator.onLine === false) { flushSoon(CFG.flushMs); return Promise.resolve(); } } catch (_) {}

    var sent = q.slice(0, CFG.maxBatch);
    var sentN = sent.length;
    var body = JSON.stringify({ key: CFG.key, turnstile: CFG.turnstile, events: sent });
    inflight = true;

    return fetch(CFG.collector.replace(/\/+$/, "") + "/e", {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json", "x-octagonl-key": CFG.key },
      body: body
    }).then(function (r) {
      inflight = false;
      if (r.status === 202) {
        // Whole SENT window is resolved: accepted are stored, rejected are permanent
        // (bad schema / money-on-browser), sampled/deduped are intentional — retrying
        // any of them is wasteful and would loop. Drop the sent window from the front.
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (j && typeof j.sample_rate === "number") sampleRate = j.sample_rate;
          dropFront(sentN);
          backoff = CFG.backoffBase;                 // healthy — reset
          if (readBuf().length) flushSoon(200);      // drain the rest promptly
          else flushSoon(CFG.flushMs);
        });
      }
      if (r.status === 429 || r.status === 503 || r.status >= 500) {
        // Transient: keep the batch buffered, back off (honor Retry-After on 429).
        var ra = 0; try { ra = parseInt(r.headers.get("retry-after"), 10) * 1000; } catch (_) {}
        retryLater(ra);
        return;
      }
      // 400/401/413 etc: permanent for this batch (per collector status contract).
      warn("beacon: permanent " + r.status + " on batch — dropping " + sentN + " event(s)");
      dropFront(sentN);
      backoff = CFG.backoffBase;
      flushSoon(CFG.flushMs);
    }).catch(function () {
      inflight = false;                              // network error -> transient
      retryLater(0);
    });
  }

  function dropFront(n) {
    var q = readBuf();
    writeBuf(q.slice(n));                             // re-read: buffer may have grown while in flight
  }
  function retryLater(hintMs) {
    backoff = Math.min(CFG.backoffMax, Math.max(backoff * 2, CFG.backoffBase));
    var jitter = (hashUnit(String(Date.now())) * 0.3 + 0.85); // 0.85..1.15, deterministic-ish
    flushSoon(Math.max(hintMs || 0, Math.round(backoff * jitter)));
  }

  // Last-gasp flush on tab hide/unload — sendBeacon survives navigation, but it
  // can't read the response, so we DON'T clear the buffer; the collector dedups
  // on event_id, making the double-send safe (at-least-once).
  function lastGasp() {
    var q = readBuf();
    if (!q.length || !CFG.collector) return;
    var body = JSON.stringify({ key: CFG.key, turnstile: CFG.turnstile, events: q.slice(0, CFG.maxBatch) });
    try {
      if (root.navigator && root.navigator.sendBeacon) {
        var blob = new Blob([body], { type: "application/json" });
        root.navigator.sendBeacon(CFG.collector.replace(/\/+$/, "") + "/e", blob);
        return;
      }
    } catch (_) {}
    try { fetch(CFG.collector.replace(/\/+$/, "") + "/e", { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: body }); } catch (_) {}
  }

  function warn(m) { try { if (root.console && root.console.warn) root.console.warn("[octago] " + m); } catch (_) {} }

  /* ---- public: init ----------------------------------------------------- */
  function init(cfg) {
    cfg = cfg || {};
    for (var k in cfg) if (Object.prototype.hasOwnProperty.call(cfg, k) && cfg[k] != null) CFG[k] = cfg[k];
    if (!CFG.collector) { try { CFG.collector = root.OCTAGO_COLLECTOR || ""; } catch (_) {} }
    if (started) { flushSoon(50); return API; }
    started = true;

    // Flush lifecycle: idle timer + last-gasp on hide/unload (batch per CARTRIDGE §3).
    try {
      if (root.document) {
        root.document.addEventListener("visibilitychange", function () {
          if (root.document.visibilityState === "hidden") lastGasp(); else flushSoon(200);
        });
      }
      root.addEventListener && root.addEventListener("pagehide", lastGasp);
      root.addEventListener && root.addEventListener("online", function () { flushSoon(200); });
    } catch (_) {}

    flushSoon(300); // drain anything buffered from a previous session
    return API;
  }

  var API = { init: init, emit: emit, flush: flush, version: VERSION, VOCAB: VOCAB };
  root.OCTAGO_BEACON = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof self !== "undefined" ? self : this);
