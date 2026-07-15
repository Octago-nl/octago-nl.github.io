/* ============================================================================
 * Octagonal — arcade-controls.js   (the reusable on-screen arcade control deck)
 * ----------------------------------------------------------------------------
 * A shared, net-new Cartridge capability: a realistic on-screen arcade cabinet
 * control deck that EVERY game reuses. Renders metallic hardware (glossy ball-top
 * joystick with a live nub, knurled rotary knob, concave LED buttons, drag
 * trackball) below the play stage and drives them from BOTH pointer/touch and
 * physical keyboard — with independent pointerId tracking so multitouch works
 * (hold a direction AND press fire at once). Active controls visually highlight
 * so desktop players see the deck respond to the keyboard.
 *
 * No deps, no build step. Classic-script + global (window.ArcadeControls); a
 * guarded module.exports tail keeps `node --check` / tooling happy.
 *
 * API
 *   var deck = ArcadeControls.mount({ mount: HTMLElement, layout: [...], theme:"synthwave" });
 *   var s = deck.state();          // snapshot of every control, keyed by id
 *   deck.frameEnd();               // clear per-frame edges + reset spinner/trackball deltas
 *   deck.destroy();                // tear down listeners + DOM
 *
 * layout: array of control specs. Each: { id, type, side, keys, ... }
 *   type "joystick" { dirs:4|8 }        -> state { x,y, up,down,left,right, justPressed:{...} }
 *   type "dpad"                         -> a 4-way joystick (styling variant)
 *   type "button"  { keys:['Space',...],label } -> state { down, justPressed, justReleased }
 *   type "spinner" { keys:{ccw,cw} }    -> state { delta, angle }   delta = signed rad THIS frame
 *   type "trackball"                    -> state { dx, dy }         movement THIS frame
 *   side: 'left' | 'right' | 'center'   (deck zone placement; default 'center')
 *   keys: joystick/dpad -> { up:[...], down:[...], left:[...], right:[...] }
 *         button        -> ['Space','KeyZ']
 *         spinner       -> { ccw:['ArrowLeft'], cw:['ArrowRight'] }
 *         trackball     -> { up,down,left,right } (optional keyboard nudge)
 * ==========================================================================*/
(function (root) {
  "use strict";

  var VERSION = "v1.0.0";
  var STYLE_ID = "octago-arcade-controls-css";
  var DEAD = 0.28;                 // joystick boolean deadzone
  var KEY_SPIN_RATE = 3.4;         // rad/sec for keyboard-held spinner
  var KEY_BALL_RATE = 520;         // px/sec for keyboard-held trackball
  var KEY_ANALOG = 1;              // keyboard drives full-deflection nub

  function reducedMotion() {
    try { return !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches); }
    catch (_) { return false; }
  }

  /* ---- one-time stylesheet (metallic bezel + synthwave hardware) -------- */
  var CSS = [
    ".oac{--cy:#20e6ff;--mg:#ff2fb9;--ink:#0b0420;--ink2:#160a3a;--txt:#e9e6ff;",
    "  display:flex;gap:14px;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;",
    "  width:100%;padding:14px 16px 16px;border-radius:16px;",
    "  background:linear-gradient(180deg,#241147 0%,#160a3a 55%,#0b0420 100%);",
    "  border:2px solid rgba(32,230,255,.30);color:var(--txt);",
    "  box-shadow:0 0 26px rgba(255,47,185,.20),inset 0 2px 0 rgba(255,255,255,.08),inset 0 -18px 30px rgba(0,0,0,.55);",
    "  font-family:'Chakra Petch',ui-monospace,Menlo,Consolas,monospace;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}",
    ".oac-zone{display:flex;gap:16px;align-items:flex-end;justify-content:center;flex:1 1 auto}",
    ".oac-zone.left{justify-content:flex-start}.oac-zone.right{justify-content:flex-end}.oac-zone.center{justify-content:center}",
    ".oac-ctl{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px}",
    ".oac-cap{font-size:10px;letter-spacing:.14em;color:#8f86c9;text-transform:uppercase;text-align:center}",
    /* joystick */
    ".oac-stick{position:relative;width:104px;height:104px;border-radius:50%;",
    "  background:radial-gradient(circle at 38% 32%,#2b1a55,#120833 70%,#080219);",
    "  border:3px solid rgba(32,230,255,.28);box-shadow:inset 0 6px 16px rgba(0,0,0,.7),0 3px 8px rgba(0,0,0,.5),0 0 14px rgba(32,230,255,.10)}",
    ".oac-stick .gate{position:absolute;inset:16px;border-radius:50%;border:1px dashed rgba(143,134,201,.22)}",
    ".oac-stick .nub{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;",
    "  background:radial-gradient(circle at 36% 30%,#ff8fe4 0%,var(--mg) 46%,#a01274 100%);",
    "  box-shadow:0 4px 10px rgba(0,0,0,.6),inset 0 3px 6px rgba(255,255,255,.45),0 0 16px rgba(255,47,185,.5);",
    "  transition:box-shadow .12s ease}",
    ".oac-stick.dpad{border-radius:14px}.oac-stick.dpad .nub{border-radius:10px}",
    ".oac-stick.active{border-color:var(--cy);box-shadow:inset 0 6px 16px rgba(0,0,0,.7),0 0 20px rgba(32,230,255,.5)}",
    ".oac-stick .arrow{position:absolute;color:rgba(32,230,255,.35);font-size:13px;line-height:1}",
    ".oac-stick .a-u{top:5px;left:50%;transform:translateX(-50%)}.oac-stick .a-d{bottom:5px;left:50%;transform:translateX(-50%)}",
    ".oac-stick .a-l{left:6px;top:50%;transform:translateY(-50%)}.oac-stick .a-r{right:6px;top:50%;transform:translateY(-50%)}",
    ".oac-stick .arrow.lit{color:var(--cy);text-shadow:0 0 8px var(--cy)}",
    /* button */
    ".oac-btn{position:relative;width:78px;height:78px;border-radius:50%;cursor:pointer;",
    "  background:radial-gradient(circle at 40% 34%,#3a1f5f,#180a3c 72%);",
    "  border:3px solid rgba(32,230,255,.30);color:var(--txt);font:inherit;font-weight:700;letter-spacing:.06em;font-size:12px;",
    "  box-shadow:inset 0 -6px 12px rgba(0,0,0,.6),inset 0 5px 10px rgba(255,255,255,.10),0 3px 7px rgba(0,0,0,.5);",
    "  display:flex;align-items:center;justify-content:center;text-align:center;transition:transform .06s ease,box-shadow .12s ease}",
    ".oac-btn .led{position:absolute;inset:12px;border-radius:50%;",
    "  background:radial-gradient(circle at 42% 36%,rgba(255,140,228,.65),rgba(255,47,185,.18) 60%,transparent 72%);opacity:.55;transition:opacity .1s ease}",
    ".oac-btn .lbl{position:relative;z-index:1;text-shadow:0 1px 2px rgba(0,0,0,.6)}",
    ".oac-btn.active{transform:translateY(2px);border-color:var(--mg);box-shadow:inset 0 4px 12px rgba(0,0,0,.8),0 0 22px rgba(255,47,185,.7)}",
    ".oac-btn.active .led{opacity:1}",
    /* spinner / knob */
    ".oac-knob{position:relative;width:96px;height:96px;border-radius:50%;cursor:grab;touch-action:none;",
    "  background:conic-gradient(from 0deg,#2a1850,#3d2570,#2a1850,#3d2570,#2a1850,#3d2570,#2a1850,#3d2570,#2a1850);",
    "  border:3px solid rgba(32,230,255,.28);",
    "  box-shadow:inset 0 0 14px rgba(0,0,0,.7),0 3px 8px rgba(0,0,0,.5),0 0 12px rgba(32,230,255,.10)}",
    ".oac-knob .hub{position:absolute;inset:20px;border-radius:50%;background:radial-gradient(circle at 38% 32%,#4a2c7d,#1b0d3f 74%);box-shadow:inset 0 3px 8px rgba(255,255,255,.15),inset 0 -6px 12px rgba(0,0,0,.6)}",
    ".oac-knob .mark{position:absolute;left:50%;top:8px;width:5px;height:26px;margin-left:-2.5px;border-radius:3px;background:var(--cy);box-shadow:0 0 10px var(--cy);transform-origin:50% 40px}",
    ".oac-knob.active{cursor:grabbing;border-color:var(--cy);box-shadow:inset 0 0 14px rgba(0,0,0,.7),0 0 20px rgba(32,230,255,.55)}",
    /* trackball */
    ".oac-ball{position:relative;width:104px;height:104px;border-radius:50%;cursor:grab;touch-action:none;overflow:hidden;",
    "  background:radial-gradient(circle at 38% 30%,#4d2e86 0%,#2a1852 46%,#0e0530 82%);",
    "  border:3px solid rgba(255,47,185,.28);box-shadow:inset 0 8px 18px rgba(0,0,0,.55),inset 0 -6px 14px rgba(0,0,0,.6),0 3px 8px rgba(0,0,0,.5)}",
    ".oac-ball .sheen{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 34% 26%,rgba(255,255,255,.28),transparent 42%)}",
    ".oac-ball.active{cursor:grabbing;border-color:var(--cy);box-shadow:inset 0 8px 18px rgba(0,0,0,.55),0 0 20px rgba(32,230,255,.5)}",
    "@media (max-width:520px){.oac{gap:8px;padding:12px 10px}.oac-stick,.oac-ball{width:88px;height:88px}.oac-knob{width:82px;height:82px}.oac-btn{width:66px;height:66px}}",
    "@media (prefers-reduced-motion: reduce){.oac *{transition:none!important}}"
  ].join("");

  function injectCss(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    var st = doc.createElement("style");
    st.id = STYLE_ID; st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }

  /* ---- helpers ---------------------------------------------------------- */
  function el(doc, tag, cls) { var e = doc.createElement(tag); if (cls) e.className = cls; return e; }
  function arr(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  // Match a KeyboardEvent against a key spec entry (accepts e.code OR e.key, case-insensitive).
  function keyHit(spec, e) {
    for (var i = 0; i < spec.length; i++) {
      var k = spec[i];
      if (k === e.code || k === e.key) return true;
      if (typeof k === "string" && typeof e.key === "string" &&
          k.length === 1 && k.toLowerCase() === e.key.toLowerCase()) return true;
    }
    return false;
  }

  /* ---- controller ------------------------------------------------------- */
  function mount(opts) {
    opts = opts || {};
    var mountEl = opts.mount;
    if (!mountEl || !mountEl.ownerDocument) throw new Error("ArcadeControls.mount: opts.mount must be an element");
    var doc = mountEl.ownerDocument;
    injectCss(doc);
    var reduce = reducedMotion();
    var layout = arr(opts.layout);

    var deck = el(doc, "div", "oac");
    deck.setAttribute("role", "group");
    deck.setAttribute("aria-label", "arcade controls");
    var zones = { left: el(doc, "div", "oac-zone left"), center: el(doc, "div", "oac-zone center"), right: el(doc, "div", "oac-zone right") };
    deck.appendChild(zones.left); deck.appendChild(zones.center); deck.appendChild(zones.right);

    var controls = {};   // id -> internal control record
    var order = [];

    layout.forEach(function (spec) {
      if (!spec || !spec.id) return;
      var c = buildControl(doc, spec, reduce);
      if (!c) return;
      controls[spec.id] = c; order.push(c);
      try { c.root.setAttribute("data-oac-id", spec.id); } catch (_) {}  // lets a game find/skin one control
      var zone = zones[spec.side] || zones.center;
      zone.appendChild(c.root);
    });

    mountEl.appendChild(deck);

    /* ---- keyboard (mirrored to virtual controls) ------------------------ */
    function onKeyDown(e) {
      if (e.repeat) return;
      var used = false;
      for (var i = 0; i < order.length; i++) if (order[i].keydown(e)) used = true;
      if (used) { /* let games preventDefault at their layer if desired */ }
    }
    function onKeyUp(e) {
      for (var i = 0; i < order.length; i++) order[i].keyup(e);
    }
    root.addEventListener("keydown", onKeyDown);
    root.addEventListener("keyup", onKeyUp);
    // release everything if focus/visibility is lost (avoid stuck keys)
    function releaseAll() { for (var i = 0; i < order.length; i++) order[i].blur(); }
    root.addEventListener("blur", releaseAll);
    try { doc.addEventListener("visibilitychange", function () { if (doc.visibilityState === "hidden") releaseAll(); }); } catch (_) {}

    /* ---- internal rAF ticker: accumulate keyboard-held spinner/trackball & */
    /*      refresh visual highlight so the deck responds to the keyboard.    */
    var raf = 0, lastT = 0, alive = true;
    function tick(now) {
      if (!alive) return;
      var dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0;
      lastT = now;
      for (var i = 0; i < order.length; i++) order[i].tick(dt);
      raf = root.requestAnimationFrame ? root.requestAnimationFrame(tick) : 0;
    }
    if (root.requestAnimationFrame) raf = root.requestAnimationFrame(tick);

    return {
      version: VERSION,
      el: deck,
      state: function () {
        var out = {};
        for (var i = 0; i < order.length; i++) out[order[i].id] = order[i].snapshot();
        return out;
      },
      get: function (id) { return controls[id] ? controls[id].snapshot() : null; },
      frameEnd: function () { for (var i = 0; i < order.length; i++) order[i].frameEnd(); },
      destroy: function () {
        alive = false;
        try { if (raf && root.cancelAnimationFrame) root.cancelAnimationFrame(raf); } catch (_) {}
        root.removeEventListener("keydown", onKeyDown);
        root.removeEventListener("keyup", onKeyUp);
        root.removeEventListener("blur", releaseAll);
        for (var i = 0; i < order.length; i++) order[i].destroy();
        if (deck.parentNode) deck.parentNode.removeChild(deck);
      }
    };
  }

  /* ---- control factory -------------------------------------------------- */
  function buildControl(doc, spec, reduce) {
    var t = spec.type === "dpad" ? "joystick" : spec.type;
    switch (t) {
      case "joystick": return joystick(doc, spec, reduce);
      case "button":   return button(doc, spec, reduce);
      case "spinner":  return spinner(doc, spec, reduce);
      case "trackball":return trackball(doc, spec, reduce);
      default: return null;
    }
  }

  function withCaption(doc, root, label) {
    if (!label) return;
    var cap = el(doc, "div", "oac-cap"); cap.textContent = label; root.appendChild(cap);
  }

  /* ---- JOYSTICK / DPAD -------------------------------------------------- */
  function joystick(doc, spec, reduce) {
    var isDpad = spec.type === "dpad";
    var dirs = spec.dirs === 8 ? 8 : 4;
    var keys = spec.keys || {};
    var kmap = {
      up: arr(keys.up).length ? arr(keys.up) : ["ArrowUp", "KeyW"],
      down: arr(keys.down).length ? arr(keys.down) : ["ArrowDown", "KeyS"],
      left: arr(keys.left).length ? arr(keys.left) : ["ArrowLeft", "KeyA"],
      right: arr(keys.right).length ? arr(keys.right) : ["ArrowRight", "KeyD"]
    };

    var root = el(doc, "div", "oac-ctl");
    var stick = el(doc, "div", "oac-stick" + (isDpad ? " dpad" : ""));
    stick.setAttribute("role", "group");
    stick.setAttribute("aria-label", spec.label || (isDpad ? "direction pad" : "joystick"));
    stick.setAttribute("tabindex", "0");
    stick.appendChild(el(doc, "div", "gate"));
    var arrows = {};
    ["u", "d", "l", "r"].forEach(function (a) { var e = el(doc, "div", "arrow a-" + a); e.textContent = ({ u: "▲", d: "▼", l: "◀", r: "▶" })[a]; stick.appendChild(e); arrows[a] = e; });
    var nub = el(doc, "div", "nub"); stick.appendChild(nub);
    root.appendChild(stick);
    withCaption(doc, root, spec.label);

    // pointer (touch) input
    var pointerId = null, cx = 0, cy = 0, rad = 1;
    var px = 0, py = 0;     // pointer-derived nub [-1,1]
    var kx = 0, ky = 0;     // keyboard-derived nub [-1,1]
    var held = { up: false, down: false, left: false, right: false };   // keyboard-held per dir
    var prevBool = { up: false, down: false, left: false, right: false };
    var justPressed = { up: false, down: false, left: false, right: false };

    function pointerActive() { return pointerId !== null; }
    function measure() { var r = stick.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; rad = r.width / 2; }
    function setFromPointer(e) {
      var dx = (e.clientX - cx) / rad, dy = (e.clientY - cy) / rad;
      var m = Math.sqrt(dx * dx + dy * dy);
      if (m > 1) { dx /= m; dy /= m; }
      px = dx; py = dy;
    }
    function onDown(e) {
      if (pointerId !== null) return;
      pointerId = e.pointerId; measure();
      try { stick.setPointerCapture(e.pointerId); } catch (_) {}
      setFromPointer(e); e.preventDefault();
    }
    function onMove(e) { if (e.pointerId !== pointerId) return; setFromPointer(e); e.preventDefault(); }
    function onUp(e) {
      if (e.pointerId !== pointerId) return;
      pointerId = null; px = 0; py = 0;
      try { stick.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    stick.addEventListener("pointerdown", onDown);
    stick.addEventListener("pointermove", onMove);
    stick.addEventListener("pointerup", onUp);
    stick.addEventListener("pointercancel", onUp);

    function recompute() {
      // effective nub = pointer if active else keyboard
      var x = pointerActive() ? px : kx;
      var y = pointerActive() ? py : ky;
      // booleans
      var b = { up: false, down: false, left: false, right: false };
      if (dirs === 8) {
        b.up = y < -DEAD; b.down = y > DEAD; b.left = x < -DEAD; b.right = x > DEAD;
      } else {
        if (Math.abs(x) >= Math.abs(y)) { if (Math.abs(x) > DEAD) { b.left = x < 0; b.right = x > 0; } }
        else { if (Math.abs(y) > DEAD) { b.up = y < 0; b.down = y > 0; } }
      }
      // edges
      ["up", "down", "left", "right"].forEach(function (d) {
        if (b[d] && !prevBool[d]) justPressed[d] = true;
        prevBool[d] = b[d];
      });
      return { x: x, y: y, b: b };
    }

    function render(x, y, b) {
      var mx = clamp(x, -1, 1) * (rad ? Math.min(28, rad * 0.34) : 24);
      var my = clamp(y, -1, 1) * (rad ? Math.min(28, rad * 0.34) : 24);
      nub.style.transform = "translate(" + mx.toFixed(1) + "px," + my.toFixed(1) + "px)";
      var on = b.up || b.down || b.left || b.right;
      stick.classList.toggle("active", on);
      arrows.u.classList.toggle("lit", b.up); arrows.d.classList.toggle("lit", b.down);
      arrows.l.classList.toggle("lit", b.left); arrows.r.classList.toggle("lit", b.right);
    }

    var cur = { x: 0, y: 0, up: false, down: false, left: false, right: false };
    function tick() {
      if (!rad) measure();
      var r = recompute();
      cur.x = r.x; cur.y = r.y; cur.up = r.b.up; cur.down = r.b.down; cur.left = r.b.left; cur.right = r.b.right;
      render(r.x, r.y, r.b);
    }

    return {
      id: spec.id, root: root,
      keydown: function (e) {
        var used = false;
        ["up", "down", "left", "right"].forEach(function (d) {
          if (keyHit(kmap[d], e)) { held[d] = true; used = true; }
        });
        if (used) { kx = (held.right ? 1 : 0) - (held.left ? 1 : 0); ky = (held.down ? 1 : 0) - (held.up ? 1 : 0); kx *= KEY_ANALOG; ky *= KEY_ANALOG; }
        return used;
      },
      keyup: function (e) {
        ["up", "down", "left", "right"].forEach(function (d) { if (keyHit(kmap[d], e)) held[d] = false; });
        kx = (held.right ? 1 : 0) - (held.left ? 1 : 0); ky = (held.down ? 1 : 0) - (held.up ? 1 : 0);
      },
      blur: function () { held.up = held.down = held.left = held.right = false; kx = 0; ky = 0; },
      tick: tick,
      snapshot: function () {
        return { x: cur.x, y: cur.y, up: cur.up, down: cur.down, left: cur.left, right: cur.right,
          justPressed: { up: justPressed.up, down: justPressed.down, left: justPressed.left, right: justPressed.right } };
      },
      frameEnd: function () { justPressed.up = justPressed.down = justPressed.left = justPressed.right = false; },
      destroy: function () {
        stick.removeEventListener("pointerdown", onDown); stick.removeEventListener("pointermove", onMove);
        stick.removeEventListener("pointerup", onUp); stick.removeEventListener("pointercancel", onUp);
      }
    };
  }

  /* ---- BUTTON ----------------------------------------------------------- */
  function button(doc, spec, reduce) {
    var keys = arr(spec.keys).length ? arr(spec.keys) : ["Space"];
    var root = el(doc, "div", "oac-ctl");
    var btn = el(doc, "button", "oac-btn");
    btn.type = "button";
    btn.setAttribute("aria-label", spec.ariaLabel || spec.label || spec.id);
    btn.appendChild(el(doc, "div", "led"));
    var lbl = el(doc, "div", "lbl"); lbl.textContent = spec.label || "●"; btn.appendChild(lbl);
    root.appendChild(btn);
    if (spec.sub) withCaption(doc, root, spec.sub);

    var pointers = {};        // pointerId -> true (multiple fingers/mouse)
    var keyDown = false;
    var down = false, prev = false;
    var justPressed = false, justReleased = false;

    function refresh() {
      var d = keyDown || Object.keys(pointers).length > 0;
      down = d;
      if (down && !prev) justPressed = true;
      if (!down && prev) justReleased = true;
      prev = down;
      btn.classList.toggle("active", down);
    }
    function onDown(e) { pointers[e.pointerId] = true; try { btn.setPointerCapture(e.pointerId); } catch (_) {} refresh(); e.preventDefault(); }
    function onUp(e) { delete pointers[e.pointerId]; try { btn.releasePointerCapture(e.pointerId); } catch (_) {} refresh(); }
    btn.addEventListener("pointerdown", onDown);
    btn.addEventListener("pointerup", onUp);
    btn.addEventListener("pointercancel", onUp);
    btn.addEventListener("pointerleave", function (e) { /* capture keeps it; leave is a no-op while pressed */ });
    // prevent the synthetic click from double-firing anything
    btn.addEventListener("click", function (e) { e.preventDefault(); });

    return {
      id: spec.id, root: root,
      keydown: function (e) { if (keyHit(keys, e)) { keyDown = true; refresh(); return true; } return false; },
      keyup: function (e) { if (keyHit(keys, e)) { keyDown = false; refresh(); } },
      blur: function () { keyDown = false; pointers = {}; refresh(); },
      tick: function () { refresh(); },
      snapshot: function () { return { down: down, justPressed: justPressed, justReleased: justReleased }; },
      frameEnd: function () { justPressed = false; justReleased = false; },
      destroy: function () {
        btn.removeEventListener("pointerdown", onDown); btn.removeEventListener("pointerup", onUp);
        btn.removeEventListener("pointercancel", onUp);
      }
    };
  }

  /* ---- SPINNER (rotary knob) -------------------------------------------- */
  function spinner(doc, spec, reduce) {
    var keys = spec.keys || {};
    var ccw = arr(keys.ccw).length ? arr(keys.ccw) : ["ArrowLeft", "KeyA"];
    var cw = arr(keys.cw).length ? arr(keys.cw) : ["ArrowRight", "KeyD"];

    var root = el(doc, "div", "oac-ctl");
    var knob = el(doc, "div", "oac-knob");
    knob.setAttribute("role", "slider");
    knob.setAttribute("aria-label", spec.label || "rotary knob");
    // role="slider" requires the value attributes (Lighthouse aria-required-attr). The knob
    // is an endless rotary, so we expose its angle mapped onto a 0-360 dial.
    knob.setAttribute("aria-valuemin", "0");
    knob.setAttribute("aria-valuemax", "360");
    knob.setAttribute("aria-valuenow", "0");
    knob.setAttribute("tabindex", "0");
    knob.appendChild(el(doc, "div", "hub"));
    var mark = el(doc, "div", "mark"); knob.appendChild(mark);
    root.appendChild(knob);
    withCaption(doc, root, spec.label);

    var pointerId = null, cx = 0, cy = 0, lastAng = 0;
    var angle = 0;            // absolute knob angle (rad), for the mark + state
    var deltaAccum = 0;       // signed rad accumulated since last frameEnd
    var keyDir = 0;           // -1 ccw / +1 cw held via keyboard

    function measure() { var r = knob.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
    function angOf(e) { return Math.atan2(e.clientY - cy, e.clientX - cx); }
    function onDown(e) {
      if (pointerId !== null) return;
      pointerId = e.pointerId; measure(); lastAng = angOf(e);
      try { knob.setPointerCapture(e.pointerId); } catch (_) {}
      knob.classList.add("active"); e.preventDefault();
    }
    function onMove(e) {
      if (e.pointerId !== pointerId) return;
      var a = angOf(e); var d = a - lastAng;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      lastAng = a; deltaAccum += d; angle += d;
      updateMark(); e.preventDefault();
    }
    function onUp(e) {
      if (e.pointerId !== pointerId) return;
      pointerId = null; knob.classList.toggle("active", keyDir !== 0);
      try { knob.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    knob.addEventListener("pointerdown", onDown);
    knob.addEventListener("pointermove", onMove);
    knob.addEventListener("pointerup", onUp);
    knob.addEventListener("pointercancel", onUp);
    function updateMark() {
      mark.style.transform = "rotate(" + angle.toFixed(3) + "rad)";
      // keep the slider value in sync with the dial for assistive tech
      var deg = ((angle * 180 / Math.PI) % 360 + 360) % 360;
      knob.setAttribute("aria-valuenow", String(Math.round(deg)));
    }

    return {
      id: spec.id, root: root,
      keydown: function (e) {
        if (keyHit(ccw, e)) { keyDir = -1; knob.classList.add("active"); return true; }
        if (keyHit(cw, e)) { keyDir = 1; knob.classList.add("active"); return true; }
        return false;
      },
      keyup: function (e) {
        if (keyHit(ccw, e) && keyDir < 0) keyDir = 0;
        else if (keyHit(cw, e) && keyDir > 0) keyDir = 0;
        if (keyDir === 0 && pointerId === null) knob.classList.remove("active");
      },
      blur: function () { keyDir = 0; pointerId = null; knob.classList.remove("active"); },
      tick: function (dt) {
        if (keyDir !== 0 && dt > 0) { var d = keyDir * KEY_SPIN_RATE * dt; deltaAccum += d; angle += d; updateMark(); }
      },
      snapshot: function () { return { delta: deltaAccum, angle: angle }; },
      frameEnd: function () { deltaAccum = 0; },
      destroy: function () {
        knob.removeEventListener("pointerdown", onDown); knob.removeEventListener("pointermove", onMove);
        knob.removeEventListener("pointerup", onUp); knob.removeEventListener("pointercancel", onUp);
      }
    };
  }

  /* ---- TRACKBALL -------------------------------------------------------- */
  function trackball(doc, spec, reduce) {
    var keys = spec.keys || {};
    var kmap = { up: arr(keys.up), down: arr(keys.down), left: arr(keys.left), right: arr(keys.right) };

    var root = el(doc, "div", "oac-ctl");
    var ball = el(doc, "div", "oac-ball");
    ball.setAttribute("role", "group");
    ball.setAttribute("aria-label", spec.label || "trackball");
    ball.appendChild(el(doc, "div", "sheen"));
    root.appendChild(ball);
    withCaption(doc, root, spec.label);

    var pointerId = null, lastX = 0, lastY = 0;
    var dx = 0, dy = 0;       // px accumulated since last frameEnd
    var held = { up: false, down: false, left: false, right: false };

    function onDown(e) {
      if (pointerId !== null) return;
      pointerId = e.pointerId; lastX = e.clientX; lastY = e.clientY;
      try { ball.setPointerCapture(e.pointerId); } catch (_) {}
      ball.classList.add("active"); e.preventDefault();
    }
    function onMove(e) {
      if (e.pointerId !== pointerId) return;
      dx += e.clientX - lastX; dy += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY; e.preventDefault();
    }
    function onUp(e) {
      if (e.pointerId !== pointerId) return;
      pointerId = null; ball.classList.toggle("active", held.up || held.down || held.left || held.right);
      try { ball.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    ball.addEventListener("pointerdown", onDown);
    ball.addEventListener("pointermove", onMove);
    ball.addEventListener("pointerup", onUp);
    ball.addEventListener("pointercancel", onUp);

    return {
      id: spec.id, root: root,
      keydown: function (e) {
        var used = false;
        ["up", "down", "left", "right"].forEach(function (d) { if (kmap[d].length && keyHit(kmap[d], e)) { held[d] = true; used = true; } });
        if (used) ball.classList.add("active");
        return used;
      },
      keyup: function (e) {
        ["up", "down", "left", "right"].forEach(function (d) { if (kmap[d].length && keyHit(kmap[d], e)) held[d] = false; });
        if (!(held.up || held.down || held.left || held.right) && pointerId === null) ball.classList.remove("active");
      },
      blur: function () { held.up = held.down = held.left = held.right = false; pointerId = null; ball.classList.remove("active"); },
      tick: function (dt) {
        if (dt > 0) {
          var kx = (held.right ? 1 : 0) - (held.left ? 1 : 0);
          var ky = (held.down ? 1 : 0) - (held.up ? 1 : 0);
          if (kx) dx += kx * KEY_BALL_RATE * dt;
          if (ky) dy += ky * KEY_BALL_RATE * dt;
        }
      },
      snapshot: function () { return { dx: dx, dy: dy }; },
      frameEnd: function () { dx = 0; dy = 0; },
      destroy: function () {
        ball.removeEventListener("pointerdown", onDown); ball.removeEventListener("pointermove", onMove);
        ball.removeEventListener("pointerup", onUp); ball.removeEventListener("pointercancel", onUp);
      }
    };
  }

  var API = { mount: mount, version: VERSION };
  root.ArcadeControls = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof self !== "undefined" ? self : this);
