/* ============================================================================
 * Octagonal — retro-visual.js   (the shared 8/16-bit console-generation module)
 * ----------------------------------------------------------------------------
 * cr-retro-visual-gen-0006. Loads alongside engine.js / beacon.js / arcade-
 * controls.js from the SAME canonical origin, version-pinned + SRI-verified
 * (channels.json). ALL primitives here are additive/procedural — ZERO new
 * binary/texture/sampled-audio assets — so any Cartridge that calls into this
 * module stays inside the hard gates (asset weight <=900KB, Lighthouse>=0.9).
 *
 * Games do NOT fork this in. One origin, one file, one deploy upgrades every
 * cartridge that opts in (engine/README.md, CARTRIDGE.md, ARCHITECTURE.md §1).
 * This file is 100% additive: it does not touch engine.js/beacon.js globals,
 * does not require them, and a game that never loads it is unaffected.
 *
 * Three console-generation "looks", all HOUSE-ANCHORED to the existing
 * synthwave palette (cyan/magenta/gold on void black, octagon DNA) — the
 * generation changes fidelity/technique, never the palette identity:
 *   - Commodore 64  : fixed ~16-swatch quantization palette, ordered dither,
 *                     chunky non-antialiased pixels, SID 3-voice chiptune.
 *   - Amiga 500     : 32-64 swatch graduated ramps, copper-style stepped
 *                     gradients, multi-layer parallax, sprite "bobs".
 *   - Sega Genesis  : bold saturated palette, deep 2-5 layer parallax,
 *                     sprite-atlas + frame-cycle animation, punchy FM stabs.
 *
 * No deps, no build step. Classic-script + global (window.OCTAGO_RETRO); a
 * guarded module.exports tail keeps `node --check` / tooling happy.
 *
 * PUBLIC API (window.OCTAGO_RETRO)
 *   .version                                     -- module version string
 *   .palette.get(name)                            -> hex[]  ("c64"|"amiga"|"genesis")
 *   .palette.nearest(hex, name)                   -> hex    (nearest swatch in that ramp)
 *   .palette.shade(hex, t)                        -> hex    (lighten/darken -1..1)
 *   .parallax.create({layers:[{speed,tileWidth,draw(ctx,x,y,w,h)}]})
 *       -> { addLayer, setLayerSpeed, scroll(dx), reset, render(ctx,w,h), world }
 *   .sprite.createAtlas({cell, palette, clips:{name:[frameOps,...]}})
 *       -> { frameCount(name), cellSize, draw(ctx,name,i,x,y,w,h,flip) }
 *   .sprite.createAnimator(atlas, {clip, fps, loop})
 *       -> { update(dtSec), setClip(name,opts), draw(ctx,x,y,w,h,flip), frame() }
 *   .pixel.createChunkyBuffer(w, h, scale)         -> { canvas, ctx, width, height, blit(destCtx,...) }
 *   .pixel.bayerMatrix(size)                       -> number[][]  (2|4|8, normalized 0..1)
 *   .pixel.ditherQuantize(ctx, x, y, w, h, opts)    -- in-place ordered-dither + palette quantize
 *   .gradient.copper(ctx, x, y, w, h, stops, opts)  -- cached stepped/interpolated vertical gradient
 *   .audio.sid3(ctx, dest)                          -> { square, triangle, noise, filterSweep }
 *   .audio.fmStab(ctx, dest)                        -> { stab(freq, opts) }
 * ==========================================================================*/
(function (root) {
  "use strict";

  var VERSION = "v1.0.0";
  var doc = root.document;

  /* ---- tiny shared utils ------------------------------------------------ */
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function clamp255(x) { return Math.max(0, Math.min(255, x)); }
  function warn(m) { try { root.console && root.console.warn("[octago-retro] " + m); } catch (_) {} }

  // House-anchored brand hex, mirrored from engine.js's PALETTE (kept in sync by
  // eye, not by import, so this file has zero hard dependency on engine.js).
  var HOUSE = {
    void: "#0b0420", bg1: "#1a0938", ink: "#f5e6ff", dim: "#6a4b8a",
    cyan: "#31e0ff", magenta: "#ff2fb9", crimson: "#ff2a6d",
    gold: "#ffcc33", violet: "#b967ff"
  };

  /* ---- color math (hex <-> rgb <-> hsl) --------------------------------- */
  function hexToRgb(hex) {
    var h = String(hex).replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbToHex(r, g, b) {
    function h2(v) { var s = clamp255(Math.round(v)).toString(16); return s.length < 2 ? "0" + s : s; }
    return "#" + h2(r) + h2(g) + h2(b);
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2, d = max - min, h = 0, s = 0;
    if (d !== 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      switch (max) {
        case r: h = 60 * (((g - b) / d) % 6); break;
        case g: h = 60 * ((b - r) / d + 2); break;
        default: h = 60 * ((r - g) / d + 4); break;
      }
    }
    if (h < 0) h += 360;
    return { h: h, s: s, l: l };
  }
  function hexToHsl(hex) { var rgb = hexToRgb(hex); return rgbToHsl(rgb.r, rgb.g, rgb.b); }
  function hslToHex(h, s, l) {
    s = clamp01(s); l = clamp01(l);
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2, r = 0, g = 0, b = 0;
    h = ((h % 360) + 360) % 360;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
  }

  // Graduated ramp anchored on a real house hex: sweeps lightness dark->light
  // through the SAME hue, tapering saturation at the extremes (chroma fades
  // near black/white, the way real console palettes read), and splices the
  // exact house hex back in at its natural lightness step for brand fidelity.
  function ramp(hex, steps) {
    steps = Math.max(2, steps | 0);
    var base = hexToHsl(hex);
    var out = [], i;
    for (i = 0; i < steps; i++) {
      var t = i / (steps - 1);
      var l = 0.06 + t * 0.86;
      var s = base.s * (0.4 + 0.6 * Math.sin(Math.PI * t));
      out.push(hslToHex(base.h, s, l));
    }
    var idx = Math.round(clamp01((base.l - 0.06) / 0.86) * (steps - 1));
    out[Math.max(0, Math.min(steps - 1, idx))] = hex;
    return out;
  }
  // Bold/saturated variant of a house hue — Genesis-tier punch, same hue family.
  function bold(hex) {
    var hsl = hexToHsl(hex);
    return hslToHex(hsl.h, Math.min(1, hsl.s * 1.15 + 0.15), 0.5 + (hsl.l - 0.5) * 0.3);
  }

  /* ---- per-generation palettes (all house-anchored, pure data) ---------- */
  // C64: fixed ~16-swatch palette for hard quantization.
  var PAL_C64 = [HOUSE.void, HOUSE.dim, HOUSE.crimson]
    .concat(ramp(HOUSE.cyan, 4), ramp(HOUSE.magenta, 4), ramp(HOUSE.gold, 4), [HOUSE.ink]);
  // Amiga: 32-64 graduated ramps (4 house hue families x 10 steps = 40).
  var PAL_AMIGA = ramp(HOUSE.cyan, 10).concat(
    ramp(HOUSE.magenta, 10), ramp(HOUSE.gold, 10), ramp(HOUSE.violet, 10)
  );
  // Genesis: bold saturated set — fewer swatches, each pushed to max punch.
  var PAL_GENESIS = [
    HOUSE.void, HOUSE.ink,
    HOUSE.cyan, bold(HOUSE.cyan),
    HOUSE.magenta, bold(HOUSE.magenta),
    HOUSE.crimson, bold(HOUSE.crimson),
    HOUSE.gold, bold(HOUSE.gold),
    HOUSE.violet, bold(HOUSE.violet)
  ];
  // Atari: the existing baseline (engine.js's flat 9-swatch), exposed here too
  // so callers can quantize AGAINST the current-gen look for an A/B compare.
  var PAL_ATARI = [HOUSE.void, HOUSE.bg1, HOUSE.magenta, HOUSE.gold, HOUSE.crimson, HOUSE.ink, HOUSE.cyan, HOUSE.violet, HOUSE.dim];

  var PALETTES = { atari: PAL_ATARI, c64: PAL_C64, amiga: PAL_AMIGA, genesis: PAL_GENESIS };

  function nearestInPalette(rgb, paletteRgb) {
    var best = 0, bestD = Infinity;
    for (var i = 0; i < paletteRgb.length; i++) {
      var p = paletteRgb[i];
      var dr = rgb.r - p.r, dg = rgb.g - p.g, db = rgb.b - p.b;
      var d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  function paletteRgbCache(name) {
    var pal = PALETTES[name] || PALETTES.c64;
    return pal.map(hexToRgb);
  }

  var Palette = {
    names: Object.keys(PALETTES),
    get: function (name) { return (PALETTES[name] || PALETTES.c64).slice(); },
    // Nearest swatch hex in a named (or literal array) palette for a given hex.
    nearest: function (hex, nameOrArr) {
      var pal = Array.isArray(nameOrArr) ? nameOrArr : (PALETTES[nameOrArr] || PALETTES.c64);
      var rgb = hexToRgb(hex);
      var idx = nearestInPalette(rgb, pal.map(hexToRgb));
      return pal[idx];
    },
    // Lighten (t>0) / darken (t<0) a hex color, t in [-1,1], preserving hue.
    shade: function (hex, t) {
      var hsl = hexToHsl(hex);
      return hslToHex(hsl.h, hsl.s, clamp01(hsl.l + (t || 0) * 0.5));
    },
    house: HOUSE
  };

  /* ---- multi-layer parallax (2-5 independently-scrolling bands) -------- */
  // Classic tiled-scroller approach: each layer draws ONE repeating tile;
  // the renderer offsets by (world * layer.speed) mod tileWidth and stamps
  // enough copies to cover the viewport, so far layers (speed<1) crawl and
  // near layers (speed>=1) race past — the single biggest Amiga/Genesis cue.
  function createParallax(opts) {
    opts = opts || {};
    var layers = [];
    var world = 0;
    function addLayer(layer) {
      layer = layer || {};
      layers.push({
        speed: typeof layer.speed === "number" ? layer.speed : 1,
        tileWidth: layer.tileWidth || 128,
        draw: typeof layer.draw === "function" ? layer.draw : function () {}
      });
      return layers.length - 1;
    }
    (opts.layers || []).forEach(addLayer);
    return {
      addLayer: addLayer,
      setLayerSpeed: function (i, s) { if (layers[i]) layers[i].speed = s; },
      layerCount: function () { return layers.length; },
      scroll: function (dx) { world += dx || 0; },
      reset: function () { world = 0; },
      get world() { return world; },
      render: function (ctx, w, h) {
        for (var i = 0; i < layers.length; i++) {
          var L = layers[i];
          var tw = Math.max(1, L.tileWidth);
          var off = ((world * L.speed) % tw + tw) % tw;
          ctx.save();
          ctx.translate(-off, 0);
          var n = Math.ceil((w + off) / tw) + 1;
          for (var k = 0; k < n; k++) {
            try { L.draw(ctx, k * tw, 0, tw, h); } catch (e) { warn("parallax layer " + i + " draw: " + (e && e.message || e)); }
          }
          ctx.restore();
        }
      }
    };
  }

  /* ---- sprite-atlas + frame-cycle animation (palette-indexed, procedural) */
  // Frames are DEFINED as compact shape-op lists (never bitmaps): rect/circle/
  // poly/line, each colored by a palette index (or a literal hex). Each
  // distinct frame is rasterized ONCE into an offscreen canvas cell and
  // cached — after that it's a cheap drawImage blit, same cost profile as a
  // real bitmap atlas, with zero binary asset weight.
  function rasterizeFrame(ops, palette, cw, ch) {
    var c = doc.createElement("canvas");
    c.width = cw; c.height = ch;
    var cx = c.getContext("2d");
    for (var i = 0; i < (ops || []).length; i++) {
      var op = ops[i];
      var color = (typeof op.c === "number") ? (palette[op.c] || "#fff") : (op.c || "#fff");
      cx.fillStyle = color; cx.strokeStyle = color;
      if (op.op === "rect") { cx.fillRect(op.x, op.y, op.w, op.h); }
      else if (op.op === "circle") { cx.beginPath(); cx.arc(op.x, op.y, op.r, 0, Math.PI * 2); cx.fill(); }
      else if (op.op === "poly" && op.pts && op.pts.length) {
        cx.beginPath(); cx.moveTo(op.pts[0][0], op.pts[0][1]);
        for (var j = 1; j < op.pts.length; j++) cx.lineTo(op.pts[j][0], op.pts[j][1]);
        cx.closePath(); cx.fill();
      } else if (op.op === "line") { cx.lineWidth = op.w || 1; cx.beginPath(); cx.moveTo(op.x1, op.y1); cx.lineTo(op.x2, op.y2); cx.stroke(); }
    }
    return c;
  }
  function createSpriteAtlas(spec) {
    spec = spec || {};
    var cellW = (spec.cell && spec.cell.w) || spec.cell || 16;
    var cellH = (spec.cell && spec.cell.h) || spec.cell || 16;
    var palette = Array.isArray(spec.palette) ? spec.palette : Palette.get(spec.palette || "genesis");
    var clips = spec.clips || {};
    var cache = {};
    function frameCanvas(name, i) {
      var frames = clips[name] || [];
      var n = frames.length;
      if (!n) return null;
      var idx = ((i % n) + n) % n;
      var key = name + ":" + idx;
      if (!cache[key]) cache[key] = rasterizeFrame(frames[idx], palette, cellW, cellH);
      return cache[key];
    }
    return {
      cellSize: { w: cellW, h: cellH },
      clipNames: Object.keys(clips),
      frameCount: function (name) { return (clips[name] || []).length; },
      draw: function (ctx, name, i, x, y, w, h, flip) {
        var img = frameCanvas(name, i || 0);
        if (!img) return;
        w = w || cellW; h = h || cellH;
        ctx.save();
        if (flip) { ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(img, 0, 0, w, h); }
        else { ctx.drawImage(img, x, y, w, h); }
        ctx.restore();
      }
    };
  }
  function createAnimator(atlas, opts) {
    opts = opts || {};
    var clip = opts.clip || (atlas.clipNames && atlas.clipNames[0]) || "idle";
    var fps = opts.fps || 8;
    var loop = opts.loop !== false;
    var t = 0, frame = 0, done = false;
    return {
      update: function (dtSec) {
        if (done) return;
        var n = Math.max(1, atlas.frameCount(clip));
        t += dtSec || 0;
        var spf = 1 / Math.max(1, fps);
        while (t >= spf) {
          t -= spf; frame++;
          if (frame >= n) { if (loop) frame = 0; else { frame = n - 1; done = true; break; } }
        }
      },
      setClip: function (name, o) { o = o || {}; if (name !== clip) { clip = name; if (o.resetFrame !== false) frame = 0; done = false; } },
      draw: function (ctx, x, y, w, h, flip) { atlas.draw(ctx, clip, frame, x, y, w, h, flip); },
      frame: function () { return frame; },
      clip: function () { return clip; },
      isDone: function () { return done; }
    };
  }

  /* ---- chunky-pixel offscreen buffer + nearest-neighbor upscale -------- */
  function createChunkyBuffer(w, h, scale) {
    scale = Math.max(1, scale || 4);
    var lw = Math.max(1, Math.round(w / scale)), lh = Math.max(1, Math.round(h / scale));
    var c = doc.createElement("canvas");
    c.width = lw; c.height = lh;
    var cx = c.getContext("2d");
    if ("imageSmoothingEnabled" in cx) cx.imageSmoothingEnabled = false;
    return {
      canvas: c, ctx: cx, width: lw, height: lh, scale: scale,
      clear: function (color) { if (color) { cx.fillStyle = color; cx.fillRect(0, 0, lw, lh); } else cx.clearRect(0, 0, lw, lh); },
      // Nearest-neighbor upscale onto a destination context — this IS the
      // "chunky pixel" cue: draw small, blit big, no smoothing anywhere.
      blit: function (destCtx, dx, dy, dw, dh) {
        var prev = destCtx.imageSmoothingEnabled;
        destCtx.imageSmoothingEnabled = false;
        destCtx.drawImage(c, 0, 0, lw, lh, dx || 0, dy || 0, dw == null ? w : dw, dh == null ? h : dh);
        destCtx.imageSmoothingEnabled = prev;
      }
    };
  }

  /* ---- ordered (Bayer) dither + palette quantize ------------------------ */
  var BAYER = {
    2: [[0, 2], [3, 1]],
    4: [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]],
    8: [ // standard 8x8 Bayer, values 0..63
      [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
      [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
      [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
      [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]
    ]
  };
  function bayerMatrix(size) {
    var m = BAYER[size] || BAYER[4];
    var n = m.length, max = n * n;
    // normalized copy in [0,1) so callers don't need to know the matrix size
    var out = [];
    for (var y = 0; y < n; y++) { out.push([]); for (var x = 0; x < n; x++) out[y].push(m[y][x] / max); }
    return out;
  }
  // In-place: reads the rect, applies ordered dither at the quantization
  // boundary (this is the single biggest "reads as C64" cue), writes it back
  // quantized to the given palette. Apply this to a createChunkyBuffer's ctx
  // BEFORE the nearest-neighbor blit for the full period-correct pipeline.
  function ditherQuantize(ctx, x, y, w, h, opts) {
    opts = opts || {};
    var paletteName = opts.palette || "c64";
    var palette = Array.isArray(paletteName) ? paletteName : Palette.get(paletteName);
    var paletteRgb = palette.map(hexToRgb);
    var matrix = bayerMatrix(opts.matrix || 4);
    var n = matrix.length;
    var amount = typeof opts.amount === "number" ? opts.amount : 48; // dither spread in 0..255 space
    var img = ctx.getImageData(x, y, w, h);
    var data = img.data;
    for (var yy = 0; yy < h; yy++) {
      for (var xx = 0; xx < w; xx++) {
        var idx = (yy * w + xx) * 4;
        var thresh = (matrix[yy % n][xx % n] - 0.5) * amount;
        var rgb = { r: clamp255(data[idx] + thresh), g: clamp255(data[idx + 1] + thresh), b: clamp255(data[idx + 2] + thresh) };
        var ni = nearestInPalette(rgb, paletteRgb);
        data[idx] = paletteRgb[ni].r; data[idx + 1] = paletteRgb[ni].g; data[idx + 2] = paletteRgb[ni].b;
      }
    }
    ctx.putImageData(img, x, y);
  }

  /* ---- copper-style stepped/interpolated vertical gradient (Amiga skies) */
  var _copperCache = {};
  function interpStops(stops, t) {
    stops = stops.slice().sort(function (a, b) { return a.t - b.t; });
    if (t <= stops[0].t) return stops[0].color;
    if (t >= stops[stops.length - 1].t) return stops[stops.length - 1].color;
    for (var i = 0; i < stops.length - 1; i++) {
      var a = stops[i], b = stops[i + 1];
      if (t >= a.t && t <= b.t) {
        var u = (b.t - a.t) === 0 ? 0 : (t - a.t) / (b.t - a.t);
        var ca = hexToRgb(a.color), cb = hexToRgb(b.color);
        return rgbToHex(ca.r + (cb.r - ca.r) * u, ca.g + (cb.g - ca.g) * u, ca.b + (cb.b - ca.b) * u);
      }
    }
    return stops[stops.length - 1].color;
  }
  // Redrawn only when (stops, steps, w, h) change — cached to an offscreen
  // canvas keyed by their signature, then just drawImage'd every frame.
  function copperGradient(ctx, x, y, w, h, stops, opts) {
    opts = opts || {};
    var steps = opts.steps || 16;
    var key = opts.cacheKey || (JSON.stringify(stops) + ":" + steps + ":" + w + ":" + h);
    var cached = _copperCache[key];
    if (!cached) {
      var c = doc.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h);
      var cx = c.getContext("2d");
      for (var i = 0; i < steps; i++) {
        var t0 = i / steps, t1 = (i + 1) / steps;
        cx.fillStyle = interpStops(stops, (t0 + t1) / 2);
        var yy0 = Math.floor(t0 * h), yy1 = Math.ceil(t1 * h);
        cx.fillRect(0, yy0, w, Math.max(1, yy1 - yy0));
      }
      cached = c; _copperCache[key] = cached;
      var keys = Object.keys(_copperCache);
      if (keys.length > 32) delete _copperCache[keys[0]]; // small LRU-ish cap
    }
    ctx.drawImage(cached, x, y);
  }

  /* ---- chip-synth voice presets (added to the existing procedural  ------
   * WebAudio juice-pack style used across the catalog — see e.g.
   * games/facet-breaker/game.js's `Sound` module). NO sampled audio: every
   * voice here is an oscillator/noise-buffer generated at call time. Callers
   * pass their OWN AudioContext + destination gain node (the game's existing
   * master bus), so this slots into a game's Sound module rather than
   * spinning up a second AudioContext. */
  function sid3(ctx, dest) {
    dest = dest || ctx.destination;
    function voice(type, freq, dur, opts) {
      opts = opts || {};
      var t0 = ctx.currentTime, d = dur || 0.15;
      var osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = type; osc.frequency.setValueAtTime(freq, t0);
      if (opts.slideTo != null) { try { osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.slideTo), t0 + d); } catch (_) {} }
      var peak = opts.gain == null ? 0.3 : opts.gain;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      osc.connect(g); g.connect(dest);
      osc.start(t0); osc.stop(t0 + d + 0.02);
      return osc;
    }
    function noise(dur, opts) {
      opts = opts || {};
      var t0 = ctx.currentTime, d = dur || 0.15;
      var n = Math.max(1, Math.floor(ctx.sampleRate * d));
      var buf = ctx.createBuffer(1, n, ctx.sampleRate), data = buf.getChannelData(0);
      for (var i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
      var src = ctx.createBufferSource(); src.buffer = buf;
      var g = ctx.createGain(); g.gain.value = opts.gain == null ? 0.22 : opts.gain;
      src.connect(g); g.connect(dest);
      src.start(t0);
      return src;
    }
    // The SID's signature move: a lowpass filter sweep under a held tone —
    // used for laser zaps, power-ups, "coin" cues in the C64 tier.
    function filterSweep(type, freq, dur, f0, f1, opts) {
      opts = opts || {};
      var t0 = ctx.currentTime, d = dur || 0.3;
      var osc = ctx.createOscillator(), filt = ctx.createBiquadFilter(), g = ctx.createGain();
      osc.type = type || "square"; osc.frequency.setValueAtTime(freq, t0);
      filt.type = "lowpass"; filt.Q.value = opts.q == null ? 6 : opts.q;
      filt.frequency.setValueAtTime(f0, t0);
      try { filt.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + d); } catch (_) {}
      var peak = opts.gain == null ? 0.3 : opts.gain;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      osc.connect(filt); filt.connect(g); g.connect(dest);
      osc.start(t0); osc.stop(t0 + d + 0.02);
      return osc;
    }
    return {
      square: function (freq, dur, opts) { return voice("square", freq, dur, opts); },
      triangle: function (freq, dur, opts) { return voice("triangle", freq, dur, opts); },
      noise: noise,
      filterSweep: filterSweep
    };
  }
  // Punchy 2-op FM stab (YM2612/Genesis-style): a modulator FM's the carrier's
  // frequency for a short, percussive attack — the "brass stab" cue.
  function fmStab(ctx, dest) {
    dest = dest || ctx.destination;
    return {
      stab: function (freq, opts) {
        opts = opts || {};
        var t0 = ctx.currentTime, d = opts.dur || 0.16;
        var modRatio = opts.modRatio == null ? 2 : opts.modRatio;
        var modIndex = opts.modIndex == null ? 220 : opts.modIndex;
        var carrier = ctx.createOscillator(), modulator = ctx.createOscillator();
        var modGain = ctx.createGain(), g = ctx.createGain();
        carrier.type = "sine"; carrier.frequency.setValueAtTime(freq, t0);
        modulator.type = "sine"; modulator.frequency.setValueAtTime(freq * modRatio, t0);
        modGain.gain.setValueAtTime(modIndex, t0);
        modGain.gain.exponentialRampToValueAtTime(1, t0 + d);
        modulator.connect(modGain); modGain.connect(carrier.frequency);
        var peak = opts.gain == null ? 0.35 : opts.gain;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
        carrier.connect(g); g.connect(dest);
        modulator.start(t0); carrier.start(t0);
        modulator.stop(t0 + d + 0.02); carrier.stop(t0 + d + 0.02);
        return carrier;
      }
    };
  }

  /* ---- public API -------------------------------------------------------- */
  var API = {
    version: VERSION,
    palette: Palette,
    parallax: { create: createParallax },
    sprite: { createAtlas: createSpriteAtlas, createAnimator: createAnimator, rasterizeFrame: rasterizeFrame },
    pixel: { createChunkyBuffer: createChunkyBuffer, bayerMatrix: bayerMatrix, ditherQuantize: ditherQuantize },
    gradient: { copper: copperGradient },
    audio: { sid3: sid3, fmStab: fmStab }
  };

  root.OCTAGO_RETRO = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof self !== "undefined" ? self : this);
