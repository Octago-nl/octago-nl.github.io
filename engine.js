/* ============================================================================
 * Octagonal — engine.js   (the canonical-origin Cartridge runtime)
 * ----------------------------------------------------------------------------
 * INSERT COIN. One engine. One origin. One deploy upgrades the whole catalog.
 *
 * This is the shared synthwave runtime every Cartridge boots against
 * (engine/README.md, engine/CARTRIDGE.md, ARCHITECTURE.md §1/§4/§9). Games do
 * NOT fork it in — they load THIS file from one canonical origin, version-pinned
 * + SRI-verified (channels.json), so flipping a channel pointer updates every
 * game at once. Game-specific code (the mechanic) lives in the game repo's
 * game.js and calls OCTAGO.boot(...).
 *
 * What lives here (shared, so it improves for all N games at once):
 *   1. Synthwave canvas GAME LOOP (deterministic fixed-timestep) + octagon
 *      ARCADE-CABINET UI SHELL (chrome, HUD, playfield).
 *   2. FEATURE-FLAG config loader (per-game flags.json — the A/B substrate) that
 *      hosts the monetization slots (ad / affiliate / insert-coin / arcade-pass).
 *   3. The cross-game META-LAYER (the moat): anonymous oct_pid, cross-catalog
 *      Tokens/Tickets balance, XP, quests, high-score wall, and the
 *      "Continue? -> next game" cross-promo interstitial.
 *   4. Imports + inits the ~2KB beacon (beacon.js) and stamps the resolved
 *      engine version so engine_version_adoption is measurable.
 *
 * No build step. Classic-script + global (window.OCTAGO); guarded module.exports
 * tail keeps `node --check`/tooling happy. Vanilla JS, no frameworks, no deps.
 * ==========================================================================*/
(function (root) {
  "use strict";

  var VERSION = "v1.0.0";                 // version-pinnable; stamped for adoption
  var SELF = (root.document && root.document.currentScript) || null; // for beacon co-load
  var PALETTE = {                          // synthwave
    bg0: "#0b0420", bg1: "#1a0938", grid: "#ff2fb9", sun0: "#ffcc33",
    sun1: "#ff2a6d", ink: "#f5e6ff", neon: "#31e0ff", neon2: "#b967ff", dim: "#6a4b8a"
  };

  /* ---- tiny DOM/util ---------------------------------------------------- */
  var doc = root.document;
  function el(tag, attrs, css) {
    var n = doc.createElement(tag);
    if (attrs) for (var k in attrs) if (has(attrs, k)) n.setAttribute(k, attrs[k]);
    if (css) n.style.cssText = css;
    return n;
  }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function clamp(lo, hi, x) { return Math.max(lo, Math.min(hi, x)); }
  function warn(m) { try { root.console && root.console.warn("[octago] " + m); } catch (_) {} }
  function fetchJSON(url) {
    return fetch(url, { credentials: "omit", cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  // Deterministic [0,1) — used for stable A/B bucketing (no Math.random for splits).
  function hashUnit(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h / 0xffffffff;
  }

  /* ---- beacon co-load + init ------------------------------------------- */
  // "import/init beacon.js": use it if already on the page (boot loader shipped
  // both), else inject it from the SAME canonical origin as this engine, then init.
  function ensureBeacon() {
    if (root.OCTAGO_BEACON) return Promise.resolve(root.OCTAGO_BEACON);
    return new Promise(function (resolve) {
      var src = "beacon.js";
      try { if (SELF && SELF.src) src = SELF.src.replace(/engine(\.min)?\.js(\?.*)?$/, "beacon$1.js"); } catch (_) {}
      var s = el("script", { src: src, crossorigin: "anonymous" });
      if (SELF && SELF.integrity) { /* SRI for beacon is pinned by the boot loader when co-shipped */ }
      s.async = false;
      s.onload = function () { resolve(root.OCTAGO_BEACON || null); };
      s.onerror = function () { warn("beacon load failed (" + src + "); telemetry disabled"); resolve(null); };
      (doc.head || doc.documentElement).appendChild(s);
    });
  }

  /* ---- META-LAYER: anonymous identity + profile ------------------------ */
  // oct_pid = client-generated UUID in localStorage. NO PII, no login. It is the
  // anonymous key that unifies the catalog (ARCHITECTURE.md §9). Data, never a
  // capability (prompt-injection safe).
  var PID_KEY = "oct_pid";
  var PROFILE_KEY = "oct_profile";
  function store(k, v) { try { root.localStorage.setItem(k, v); } catch (_) {} }
  function load(k) { try { return root.localStorage.getItem(k); } catch (_) { return null; } }
  function uuid() {
    try { if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID(); } catch (_) {}
    var b = new Uint8Array(16);
    try { root.crypto.getRandomValues(b); } catch (_) { for (var i = 0; i < 16; i++) b[i] = (i * 2654435761) & 255; }
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = []; for (var j = 0; j < 16; j++) h.push((b[j] + 0x100).toString(16).slice(1));
    return h[0] + h[1] + h[2] + h[3] + "-" + h[4] + h[5] + "-" + h[6] + h[7] +
           "-" + h[8] + h[9] + "-" + h[10] + h[11] + h[12] + h[13] + h[14] + h[15];
  }
  function pid() {
    var p = load(PID_KEY);
    if (!p) { p = uuid(); store(PID_KEY, p); }
    return p;
  }
  function profile() {
    var p; try { p = JSON.parse(load(PROFILE_KEY) || "null"); } catch (_) { p = null; }
    if (!p || typeof p !== "object") p = {};
    if (typeof p.xp !== "number") p.xp = 0;
    if (typeof p.tokens !== "number") p.tokens = 0;   // soft currency (earned by playing)
    if (typeof p.tickets !== "number") p.tickets = 0; // scarce currency (quests / Arcade Pass)
    if (!p.quests || typeof p.quests !== "object") p.quests = {};
    if (!p.hi || typeof p.hi !== "object") p.hi = {}; // per-slug high-score wall
    return p;
  }
  function saveProfile(p) { store(PROFILE_KEY, JSON.stringify(p)); }

  var Meta = {
    pid: pid,
    profile: function () { return profile(); },
    // Money is NOT this — Tokens/Tickets are soft in-arcade currency; real payment
    // is Stripe/Ko-fi, reconciled server-side (never trusted from the client).
    addTokens: function (n) { var p = profile(); p.tokens = Math.max(0, p.tokens + (n | 0)); saveProfile(p); render.hud(); return p.tokens; },
    addTickets: function (n) { var p = profile(); p.tickets = Math.max(0, p.tickets + (n | 0)); saveProfile(p); render.hud(); return p.tickets; },
    awardXp: function (n) {
      n = Math.max(0, n | 0); if (!n) return profile().xp;
      var p = profile(); p.xp += n; saveProfile(p); render.hud();
      Beacon.emit && Beacon.emit("xp_earn", { value: n, unit: "count" });
      return p.xp;
    },
    // Cross-title daily quests -> Tickets. Feeds PLAYER_PROFILE.quest_completion + META fitness.
    questProgress: function (id, delta, goal) {
      var p = profile(); var q = p.quests[id] || { n: 0, done: false };
      q.n += (delta == null ? 1 : delta | 0);
      var done = goal != null && q.n >= goal && !q.done;
      if (done) { q.done = true; p.tickets += 1; }
      p.quests[id] = q; saveProfile(p);
      Beacon.emit && Beacon.emit("quest_progress", { value: q.n, unit: "count", dims: { variant: State.variant } });
      if (done) render.hud();
      return q;
    },
    highScore: function (slug, score) {
      var p = profile(); var best = p.hi[slug] || 0;
      if (score > best) { p.hi[slug] = score; saveProfile(p); best = score; }
      return best;
    },
    // Arcade Pass entitlement is checked engine-side against a RECONCILED membership
    // record (REVENUE.membership_conversions); the client beacon is never trusted for
    // money. Offline we read a server-synced hint only (default: not a member).
    isPass: function () { try { return !!(root.OCTAGO_ENTITLEMENT && root.OCTAGO_ENTITLEMENT.arcade_pass); } catch (_) { return false; } }
  };

  /* ---- FEATURE-FLAG config loader (the A/B substrate) ------------------ */
  // Reads the per-game config (flags.json in the Cartridge repo shape, a.k.a. the
  // "config.json" of monetization slots + A/B variants — CARTRIDGE.md §2). CRO
  // mutates it live via run-experiment; games never rebuild to change money/UX.
  var DEFAULT_FLAGS = {
    slots: {
      cabinet_banner:   { on: false, network: "adsense", variant: "A" },
      interstitial:     { on: false, cap_per_session: 1, min_play_s: 30 },
      rewarded_video:   { on: false, reward: "tokens:50" },
      affiliate_rail:   { on: false, offers: [] },
      insert_coin_jar:  { on: false, provider: "ko-fi", url: "", sku: "tip" },
      cosmetic_shop:    { on: false, currency: "tokens" },
      arcade_pass_gate: { on: false, provider: "ko-fi", url: "", perks: ["adfree", "sync", "tickets"] }
    },
    experiment: { id: null, variant: "A", split: 0.5 },
    engine_channel: "stable"
  };
  function mergeFlags(base, over) {
    var out = JSON.parse(JSON.stringify(base));
    if (!over || typeof over !== "object") return out;
    if (over.slots) for (var s in over.slots) if (has(over.slots, s)) {
      out.slots[s] = Object.assign(out.slots[s] || {}, over.slots[s]);
    }
    if (over.experiment) out.experiment = Object.assign(out.experiment, over.experiment);
    if (over.engine_channel) out.engine_channel = over.engine_channel;
    return out;
  }
  function loadFlags(opts) {
    // Priority: inline window.OCTAGO_FLAGS > fetched config URL > defaults.
    if (root.OCTAGO_FLAGS) return Promise.resolve(mergeFlags(DEFAULT_FLAGS, root.OCTAGO_FLAGS));
    var url = opts.configUrl || "flags.json";
    return fetchJSON(url)
      .then(function (j) { return mergeFlags(DEFAULT_FLAGS, j); })
      .catch(function () { warn("flags: " + url + " not found; using defaults (all slots off)"); return mergeFlags(DEFAULT_FLAGS, null); });
  }
  // Deterministic experiment bucketing: stable per (pid + experiment id), unless
  // flags pin a variant. Stamped into every beacon event's dims.variant.
  function assignVariant(flags) {
    var exp = flags.experiment || {};
    if (!exp.id) return exp.variant || "A";
    var u = hashUnit(pid() + "|" + exp.id);
    return u < (typeof exp.split === "number" ? exp.split : 0.5) ? "A" : "B";
  }

  /* ---- shared runtime state -------------------------------------------- */
  var State = {
    slug: "", title: "", flags: null, variant: "A", channel: "stable",
    score: 0, level: 1, playStartAt: 0, playEndSent: false, running: false,
    catalog: [], mounted: false
  };
  var Beacon = { emit: function () {} }; // replaced by the real beacon after ensureBeacon()

  /* ---- octagon ARCADE-CABINET shell + synthwave renderer --------------- */
  var UI = { root: null, cabinet: null, canvas: null, ctx: null, hud: null, slots: null, overlay: null, w: 0, h: 0, dpr: 1 };

  function injectCSS() {
    if (doc.getElementById("octago-css")) return;
    var css =
      ".octago-root{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;" +
        "background:radial-gradient(120% 120% at 50% 0%," + PALETTE.bg1 + " 0%," + PALETTE.bg0 + " 70%);" +
        "font-family:'Press Start 2P',ui-monospace,Menlo,monospace;color:" + PALETTE.ink + ";overflow:hidden}" +
      ".octago-cabinet{position:relative;width:min(96vw,900px);aspect-ratio:4/3;max-height:94vh;" +
        "clip-path:polygon(29% 0,71% 0,100% 29%,100% 71%,71% 100%,29% 100%,0 71%,0 29%);" +
        "background:linear-gradient(180deg,#25103f,#120726);" +
        "box-shadow:0 0 0 3px " + PALETTE.neon2 + ",0 0 40px " + PALETTE.neon + "55,inset 0 0 60px #000a;padding:3.2%}" +
      ".octago-screen{position:relative;width:100%;height:100%;border-radius:6px;overflow:hidden;background:#05010f;" +
        "box-shadow:inset 0 0 30px #000,0 0 0 2px " + PALETTE.dim + "}" +
      ".octago-canvas{display:block;width:100%;height:100%;image-rendering:pixelated}" +
      ".octago-hud{position:absolute;top:0;left:0;right:0;display:flex;gap:12px;justify-content:space-between;" +
        "padding:8px 12px;font-size:11px;letter-spacing:1px;text-shadow:0 0 6px " + PALETTE.neon + ";pointer-events:none}" +
      ".octago-hud b{color:" + PALETTE.neon + "}.octago-hud .oct-tk{color:" + PALETTE.sun0 + "}.octago-hud .oct-ti{color:" + PALETTE.neon2 + "}" +
      ".octago-slots{position:absolute;left:0;right:0;bottom:0;display:flex;gap:8px;flex-wrap:wrap;padding:8px;" +
        "justify-content:center;font-size:10px}" +
      ".octago-slot{pointer-events:auto;cursor:pointer;border:1px solid " + PALETTE.dim + ";border-radius:4px;" +
        "padding:6px 10px;background:#1a0b30cc;color:" + PALETTE.ink + ";text-decoration:none}" +
      ".octago-slot:hover{border-color:" + PALETTE.neon + ";box-shadow:0 0 10px " + PALETTE.neon + "77}" +
      ".octago-coin{color:" + PALETTE.sun0 + ";border-color:" + PALETTE.sun1 + "}" +
      ".octago-overlay{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;" +
        "gap:14px;background:#05010fd9;text-align:center;padding:20px;z-index:5}" +
      ".octago-overlay.show{display:flex}" +
      ".octago-btn{pointer-events:auto;cursor:pointer;border:2px solid " + PALETTE.neon + ";background:#12072688;color:" + PALETTE.ink + ";" +
        "font:inherit;font-size:12px;padding:10px 16px;border-radius:6px;text-decoration:none;text-shadow:0 0 6px " + PALETTE.neon + "}" +
      ".octago-btn:hover{background:" + PALETTE.neon2 + "44;box-shadow:0 0 14px " + PALETTE.neon + "}" +
      ".octago-title{font-size:15px;color:" + PALETTE.sun0 + ";text-shadow:0 0 10px " + PALETTE.sun1 + "}" +
      ".octago-brand{position:absolute;bottom:2px;right:8px;font-size:8px;color:" + PALETTE.dim + ";pointer-events:auto}" +
      ".octago-brand a{color:" + PALETTE.dim + ";text-decoration:none}";
    var st = el("style", { id: "octago-css" });
    st.appendChild(doc.createTextNode(css));
    (doc.head || doc.documentElement).appendChild(st);
  }

  function buildShell(mountEl) {
    injectCSS();
    UI.root = el("div", { class: "octago-root" });
    UI.cabinet = el("div", { class: "octago-cabinet" });
    var screen = el("div", { class: "octago-screen" });
    UI.canvas = el("canvas", { class: "octago-canvas" });
    UI.ctx = UI.canvas.getContext("2d");
    UI.hud = el("div", { class: "octago-hud" });
    UI.slots = el("div", { class: "octago-slots" });
    UI.overlay = el("div", { class: "octago-overlay" });
    var brand = el("div", { class: "octago-brand" });
    // "Made with Octagonal" backlink — attribution + the compounding OS-lead loop.
    brand.innerHTML = '<a href="https://octago.nl/?ref=' + encodeURIComponent(State.slug || "engine") +
      '" target="_blank" rel="noopener">▲ Made with Octagonal</a>';
    screen.appendChild(UI.canvas);
    screen.appendChild(UI.hud);
    screen.appendChild(UI.slots);
    screen.appendChild(UI.overlay);
    screen.appendChild(brand);
    UI.cabinet.appendChild(screen);
    UI.root.appendChild(UI.cabinet);
    (mountEl || doc.body).appendChild(UI.root);
    resize();
    root.addEventListener("resize", resize);
  }

  function resize() {
    if (!UI.canvas) return;
    var r = UI.canvas.getBoundingClientRect();
    UI.dpr = clamp(1, 2, root.devicePixelRatio || 1);
    UI.w = Math.max(160, Math.floor(r.width));
    UI.h = Math.max(120, Math.floor(r.height));
    UI.canvas.width = Math.floor(UI.w * UI.dpr);
    UI.canvas.height = Math.floor(UI.h * UI.dpr);
    UI.ctx.setTransform(UI.dpr, 0, 0, UI.dpr, 0, 0);
    if (Game.game && Game.game.onResize) { try { Game.game.onResize(UI.w, UI.h); } catch (e) { reportError(e); } }
  }

  var render = {
    // Synthwave backdrop: gradient sky, glowing sun, receding neon grid.
    background: function (ctx, w, h, t) {
      var g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, PALETTE.bg1); g.addColorStop(1, PALETTE.bg0);
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      var hy = h * 0.52, r = Math.min(w, h) * 0.22, cx = w / 2;
      var sun = ctx.createLinearGradient(0, hy - r, 0, hy + r);
      sun.addColorStop(0, PALETTE.sun0); sun.addColorStop(1, PALETTE.sun1);
      ctx.fillStyle = sun; ctx.beginPath(); ctx.arc(cx, hy, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = PALETTE.grid; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
      var i;
      for (i = 0; i < 10; i++) { var y = hy + r * 0.2 + i * (h - hy) / 10; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      var scroll = ((t || 0) * 0.03) % 40;
      for (i = -10; i <= 10; i++) { var x = cx + i * 40 + scroll; ctx.beginPath(); ctx.moveTo(cx, hy + r * 0.2); ctx.lineTo(x, h); ctx.stroke(); }
      ctx.globalAlpha = 1;
    },
    hud: function () {
      if (!UI.hud) return;
      var p = profile();
      UI.hud.innerHTML =
        "<span>SCORE <b>" + State.score + "</b></span>" +
        "<span>LV <b>" + State.level + "</b> · XP <b>" + p.xp + "</b></span>" +
        '<span class="oct-tk">◎ ' + p.tokens + "</span> " +
        '<span class="oct-ti">✦ ' + p.tickets + "</span>";
    }
  };

  /* ---- monetization slot host (all runtime-flag driven) ---------------- */
  var Slots = {
    interstitialShown: 0,
    mount: function () {
      if (!UI.slots) return;
      UI.slots.innerHTML = "";
      var f = State.flags.slots || {};
      var adfree = Meta.isPass(); // Arcade Pass = ad-free cabinet
      if (f.cabinet_banner && f.cabinet_banner.on && !adfree) this.banner(f.cabinet_banner);
      if (f.affiliate_rail && f.affiliate_rail.on) this.affiliate(f.affiliate_rail);
      if (f.rewarded_video && f.rewarded_video.on) this.rewarded(f.rewarded_video);
      if (f.insert_coin_jar && f.insert_coin_jar.on) this.coin(f.insert_coin_jar);
      if (f.arcade_pass_gate && f.arcade_pass_gate.on && !Meta.isPass()) this.pass(f.arcade_pass_gate);
    },
    banner: function (cfg) {
      var a = el("a", { class: "octago-slot", href: "#", "data-net": cfg.network || "" });
      a.textContent = "[ AD · " + (cfg.network || "banner") + " ]";
      // The real ad network fills this element; we emit the funnel signals.
      Beacon.emit("ad_impression", { entity: "slug", dims: { variant: State.variant } });
      a.addEventListener("click", function (e) { e.preventDefault(); Beacon.emit("ad_click", { dims: { variant: State.variant } }); });
      UI.slots.appendChild(a);
    },
    affiliate: function (cfg) {
      var offers = cfg.offers || [];
      for (var i = 0; i < Math.min(offers.length, 3); i++) {
        var a = el("a", { class: "octago-slot", href: "#", rel: "sponsored nofollow noopener", target: "_blank" });
        a.textContent = "» " + String(offers[i]);
        a.addEventListener("click", function () { Beacon.emit("ad_click", { dims: { variant: State.variant } }); });
        UI.slots.appendChild(a);
      }
    },
    rewarded: function (cfg) {
      var a = el("a", { class: "octago-slot", href: "#" });
      a.textContent = "▶ Watch → " + (cfg.reward || "reward");
      a.addEventListener("click", function (e) {
        e.preventDefault();
        // Rewarded video is OPT-IN only: rewarded_optin precedes the reward (CARTRIDGE §2).
        Beacon.emit("rewarded_optin", { dims: { variant: State.variant } });
        var m = /tokens:(\d+)/.exec(cfg.reward || "");
        if (m) Meta.addTokens(parseInt(m[1], 10));
      });
      UI.slots.appendChild(a);
    },
    // "Insert Coin" jar + Arcade Pass gate open HOSTED CHECKOUT (Ko-fi/Stripe link)
    // — zero server, no card data touches us. The client emits only checkout_step
    // (a funnel event); the actual tip/purchase/membership arrives from the signed
    // Stripe/Ko-fi webhook and is reconciled server-side (money is never trusted here).
    coin: function (cfg) {
      var a = el("a", { class: "octago-slot octago-coin", href: cfg.url || "#", target: "_blank", rel: "noopener" });
      a.textContent = "◎ INSERT COIN";
      a.addEventListener("click", function () { Beacon.emit("checkout_step", { value: 1, dims: { variant: State.variant } }); });
      UI.slots.appendChild(a);
    },
    pass: function (cfg) {
      var a = el("a", { class: "octago-slot", href: cfg.url || "#", target: "_blank", rel: "noopener" });
      a.textContent = "✦ ARCADE PASS";
      a.addEventListener("click", function () { Beacon.emit("checkout_step", { value: 1, dims: { variant: State.variant } }); });
      UI.slots.appendChild(a);
    }
  };

  /* ---- input (keyboard + touch/pointer -> virtual pad) ----------------- */
  var Input = {
    down: {}, prev: {}, pointer: { x: 0, y: 0, down: false }, _bound: false,
    bind: function () {
      if (this._bound) return; this._bound = true; var I = this;
      root.addEventListener("keydown", function (e) { I.down[e.key] = true; if (isGameKey(e.key)) e.preventDefault(); });
      root.addEventListener("keyup", function (e) { I.down[e.key] = false; });
      var c = UI.canvas;
      function pt(e) {
        var r = c.getBoundingClientRect(); var src = (e.touches && e.touches[0]) || e;
        I.pointer.x = ((src.clientX - r.left) / r.width) * UI.w;
        I.pointer.y = ((src.clientY - r.top) / r.height) * UI.h;
      }
      c.addEventListener("pointerdown", function (e) { I.pointer.down = true; pt(e); });
      c.addEventListener("pointermove", function (e) { pt(e); });
      root.addEventListener("pointerup", function () { I.pointer.down = false; });
      c.addEventListener("touchstart", function (e) { I.pointer.down = true; pt(e); e.preventDefault(); }, { passive: false });
      c.addEventListener("touchmove", function (e) { pt(e); e.preventDefault(); }, { passive: false });
    },
    // Snapshot with edge-detection ("justPressed") for a given step.
    snapshot: function () {
      var d = this.down;
      var s = {
        left: !!(d.ArrowLeft || d.a || d.A), right: !!(d.ArrowRight || d.d || d.D),
        up: !!(d.ArrowUp || d.w || d.W), down: !!(d.ArrowDown || d.s || d.S),
        action: !!(d[" "] || d.Enter || d.z || d.Z),
        pointer: { x: this.pointer.x, y: this.pointer.y, down: this.pointer.down },
        justPressed: {}
      };
      var keys = ["left", "right", "up", "down", "action"];
      for (var i = 0; i < keys.length; i++) s.justPressed[keys[i]] = s[keys[i]] && !this.prev[keys[i]];
      this.prev = { left: s.left, right: s.right, up: s.up, down: s.down, action: s.action };
      return s;
    }
  };
  function isGameKey(k) { return k === " " || k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown"; }

  /* ---- juice primitives (screenshake + particles) ---------------------- */
  var Juice = {
    shakeT: 0, shakeAmp: 0, particles: [],
    shake: function (amp, ms) { this.shakeAmp = amp || 6; this.shakeT = ms || 200; },
    burst: function (x, y, n, color) {
      n = n || 12;
      for (var i = 0; i < n; i++) {
        var a = (i / n) * Math.PI * 2;
        this.particles.push({ x: x, y: y, vx: Math.cos(a) * (30 + (i % 5) * 12), vy: Math.sin(a) * (30 + (i % 5) * 12), life: 500, t: 500, c: color || PALETTE.neon });
      }
    },
    step: function (dt) {
      if (this.shakeT > 0) this.shakeT -= dt;
      var p = this.particles, i;
      for (i = p.length - 1; i >= 0; i--) {
        var q = p[i]; q.t -= dt; if (q.t <= 0) { p.splice(i, 1); continue; }
        q.x += q.vx * dt / 1000; q.y += q.vy * dt / 1000; q.vy += 60 * dt / 1000;
      }
    },
    apply: function (ctx) {
      if (this.shakeT > 0) { var a = this.shakeAmp * (this.shakeT / 200); ctx.translate((hashUnit(String(this.shakeT)) - 0.5) * a, (hashUnit(String(this.shakeT + 1)) - 0.5) * a); }
    },
    draw: function (ctx) {
      for (var i = 0; i < this.particles.length; i++) {
        var q = this.particles[i]; ctx.globalAlpha = clamp(0, 1, q.t / q.life);
        ctx.fillStyle = q.c; ctx.fillRect(q.x - 1.5, q.y - 1.5, 3, 3);
      }
      ctx.globalAlpha = 1;
    }
  };

  /* ---- fixed-timestep game loop (deterministic) ------------------------ */
  var STEP = 1000 / 60, MAX_FRAME = 250; // cap to avoid spiral-of-death after a tab stall
  var Game = { game: null, acc: 0, last: 0, raf: 0, t: 0 };

  function tick(now) {
    Game.raf = root.requestAnimationFrame(tick);
    if (!Game.last) Game.last = now;
    var frame = Math.min(MAX_FRAME, now - Game.last); Game.last = now;
    if (!State.running) return;
    Game.acc += frame; Game.t += frame;
    var steps = 0;
    while (Game.acc >= STEP && steps < 8) {           // fixed-timestep sim (bounded)
      var input = Input.snapshot();
      if (Game.game && Game.game.update) { try { Game.game.update(STEP / 1000, input, Engine); } catch (e) { reportError(e); } }
      Juice.step(STEP);
      Game.acc -= STEP; steps++;
    }
    // render (variable — reads the simulated state)
    var ctx = UI.ctx; ctx.save();
    Juice.apply(ctx);
    render.background(ctx, UI.w, UI.h, Game.t);
    if (Game.game && Game.game.render) { try { Game.game.render(ctx, Engine); } catch (e) { reportError(e); } }
    Juice.draw(ctx);
    ctx.restore();
  }

  function reportError(e) {
    warn("game error: " + (e && e.message || e));
    Beacon.emit("error", { value: 1, unit: "count", dims: { variant: State.variant } });
  }

  /* ---- Continue? -> next game cross-promo interstitial ----------------- */
  // On play_end the engine offers a Continue that routes to the next recommended
  // title — recirculating FREE internal traffic at zero CAC (ARCHITECTURE.md §9).
  // The catalog is provided already fitness-ranked (window.OCTAGO_CATALOG / a
  // shared catalog.json on the canonical origin); the engine just skips self.
  function recommendNext() {
    var cat = State.catalog || [];
    for (var i = 0; i < cat.length; i++) if (cat[i] && cat[i].slug && cat[i].slug !== State.slug) return cat[i];
    return null;
  }
  function showContinue() {
    var next = recommendNext();
    UI.overlay.innerHTML = "";
    var t = el("div", { class: "octago-title" }); t.textContent = "GAME OVER · SCORE " + State.score;
    UI.overlay.appendChild(t);
    var again = el("a", { class: "octago-btn", href: "#" }); again.textContent = "↻ PLAY AGAIN";
    again.addEventListener("click", function (e) { e.preventDefault(); Engine.restart(); });
    UI.overlay.appendChild(again);
    // Score-share deep-link (beat-my-score) -> OG score-card, share_click, K-factor.
    var share = el("a", { class: "octago-btn", href: shareLink() }); share.textContent = "↗ BEAT MY SCORE";
    share.addEventListener("click", function () { Beacon.emit("share_click", { dims: { variant: State.variant } }); });
    UI.overlay.appendChild(share);
    if (next) {
      var cont = el("a", { class: "octago-btn", href: gameUrl(next.slug) });
      cont.textContent = "▶ CONTINUE → " + (next.title || next.slug);
      cont.addEventListener("click", function (e) {
        e.preventDefault();
        Beacon.emit("cross_promo_click", { entity: "site", dims: { variant: State.variant, referrer: State.slug } });
        Beacon.flush && Beacon.flush();
        root.location.href = gameUrl(next.slug);
      });
      UI.overlay.appendChild(cont);
    }
    UI.overlay.classList.add("show");
  }
  function gameUrl(slug) { return "https://octago.nl/" + encodeURIComponent(slug); }
  function shareLink() { return gameUrl(State.slug) + "?s=" + State.score + "&p=" + encodeURIComponent(pid()); }

  /* ---- public engine API (games call OCTAGO.boot) ---------------------- */
  var Engine = {
    version: VERSION,
    palette: PALETTE,
    meta: Meta,
    get flags() { return State.flags; },
    get variant() { return State.variant; },
    get score() { return State.score; },
    get level() { return State.level; },
    get input() { return Input; },
    get canvas() { return UI.canvas; },
    get ctx() { return UI.ctx; },
    get width() { return UI.w; },
    get height() { return UI.h; },
    juice: { shake: function (a, m) { Juice.shake(a, m); }, burst: function (x, y, n, c) { Juice.burst(x, y, n, c); } },
    emit: function (event, opts) { return Beacon.emit(event, opts); }, // escape hatch for game-specific dims

    setScore: function (n) {
      n = n | 0; if (n === State.score) return;
      State.score = n; render.hud();
      Beacon.emit("score", { value: n, unit: "count", dims: { variant: State.variant } });
      Meta.highScore(State.slug, n);
    },
    addScore: function (n) { this.setScore(State.score + (n | 0)); Meta.addTokens(Math.max(0, (n | 0) >= 100 ? 1 : 0)); },
    levelUp: function () {
      State.level++; render.hud();
      Beacon.emit("level", { value: State.level, unit: "count", dims: { variant: State.variant } });
      Meta.awardXp(10);
      Juice.shake(5, 180);
    },

    gameOver: function () {
      if (!State.running) return;
      State.running = false;
      endPlay();
      Meta.awardXp(Math.floor(State.score / 50));
      showContinue();
    },
    restart: function () {
      UI.overlay.classList.remove("show");
      State.score = 0; State.level = 1; render.hud();
      Slots.interstitialShown = 0;
      if (Game.game && Game.game.reset) { try { Game.game.reset(Engine); } catch (e) { reportError(e); } }
      startPlay();
      State.running = true;
    }
  };

  function startPlay() {
    State.playStartAt = Date.now(); State.playEndSent = false;
    Beacon.emit("play_start", { dims: { variant: State.variant } });
  }
  function endPlay() {
    if (State.playEndSent) return; State.playEndSent = true;
    var durMs = State.playStartAt ? (Date.now() - State.playStartAt) : 0;
    Beacon.emit("play_end", { value: durMs, unit: "ms", dims: { variant: State.variant } });
    Beacon.flush && Beacon.flush();
  }

  /* ---- boot ------------------------------------------------------------ */
  // The Cartridge's game.js calls this once:
  //   OCTAGO.boot({ slug, title, configUrl, mount, setup(engine){ return game } })
  // where `game` = { update(dt,input,engine), render(ctx,engine), reset?(engine), onResize?(w,h) }.
  function boot(opts) {
    opts = opts || {};
    if (State.mounted) { warn("boot: already booted"); return Promise.resolve(Engine); }
    State.mounted = true;
    State.slug = opts.slug || root.OCTAGO_SLUG || "unknown";
    State.title = opts.title || State.slug;

    return loadFlags(opts).then(function (flags) {
      State.flags = flags;
      State.channel = flags.engine_channel || "stable";
      State.variant = assignVariant(flags);

      buildShell(opts.mount ? doc.querySelector(opts.mount) : null);
      Input.bind();
      render.hud();

      // Catalog for the Continue? cross-promo (already fitness-ranked upstream).
      State.catalog = Array.isArray(root.OCTAGO_CATALOG) ? root.OCTAGO_CATALOG : [];

      return ensureBeacon().then(function (b) {
        if (b) {
          Beacon = b;
          b.init({
            collector: root.OCTAGO_COLLECTOR || "",
            key: root.OCTAGO_KEY || "octgnl_pub_live",
            turnstile: root.OCTAGO_TURNSTILE || "",
            entity: "slug",
            slug: State.slug,
            // engine version rides here for engine_version_adoption; the collector
            // whitelists dims {geo,device,variant,referrer,player,slug} today, so
            // stamping the version end-to-end needs a collector dims extension —
            // filed as a Signal Request (signals/requests.ndjson), CARTRIDGE §3.
            defaultDims: { variant: State.variant, player: pid() }
          });
        }

        // Let the game build its world, then start the loop + play_start.
        if (typeof opts.setup === "function") {
          try { Game.game = opts.setup(Engine) || null; } catch (e) { reportError(e); }
        }
        Slots.mount();
        startPlay();
        State.running = true;
        Game.last = 0; Game.raf = root.requestAnimationFrame(tick);

        // Flush the terminal event when the tab goes away.
        try {
          doc.addEventListener("visibilitychange", function () { if (doc.visibilityState === "hidden") endPlay(); });
          root.addEventListener("pagehide", endPlay);
        } catch (_) {}

        return Engine;
      });
    });
  }

  Engine.boot = boot;
  Engine.loadFlags = loadFlags;       // exposed for QA harness / embed builds
  root.OCTAGO = Engine;
  if (typeof module !== "undefined" && module.exports) module.exports = Engine;
})(typeof self !== "undefined" ? self : this);
