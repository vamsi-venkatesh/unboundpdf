/* ══ ocr-prep.js — RUNG 4: the OCR PRE-PASS ══════════════════════════════════════════════
 *
 *  WHAT THIS IS. Three switchable steps applied to the raster that goes INTO Tesseract, and
 *  to nothing else. The page the user looks at, and the page bytes we save, never see any of
 *  it — that is the same QUALITY LAW the ocr-pdf tool already states in all-tools.js
 *  ("the output carries the ORIGINAL pages untouched — the canvas render is only Tesseract's
 *  input"). Better recognition means better word boxes, which is what rungs 2 and 3 spend
 *  on the erase rectangle and the replacement glyphs, so this is upstream of both.
 *
 *  WHY IT IS A SEPARATE PLAIN SCRIPT. It has exactly ONE call site today — the ocr-pdf tool
 *  in all-tools.js. It lives in its own file rather than inside that tool because the
 *  editor's scan path (editor.js) runs the same pre-pass by hand and could adopt this one
 *  instead; that wiring is a separate unit of work and has NOT been done, so nothing below
 *  should be read as describing the editor's current behaviour. It is loaded lazily through
 *  T.loadScript, exactly the way tesseract.min.js is, so no page pays for it until an OCR
 *  actually starts, and the service worker's cache-first rule for /tools/assets/…?v=N
 *  gives it the same offline life as every other asset.
 *
 *  THE THREE STEPS (each individually switchable via window.__ocrPrep):
 *
 *    1. upscale   The OCR raster used to be a flat 2x page render = 72*2 = 144 dpi, whatever
 *                 the scan actually was. That threw resolution away on every scan above
 *                 144 ppi: scan-3p is a 200-ppi image, the book fixture is 451 ppi. The fix
 *                 is NOT to resample a 144-dpi bitmap (that invents nothing) — it is to ask
 *                 pdf.js for a bigger viewport, so the extra pixels come from the embedded
 *                 image itself and only become interpolation past the source's own ppi.
 *                 Capped by the canvas AREA budget and by the runtime's low-memory plan.
 *
 *    2. binarize  A Sauvola local-threshold field, computed on a DOWNSCALED analysis pass
 *                 (a full-resolution integral image is ~70 MB per plane on a 300-dpi letter
 *                 page — not something to allocate on a phone) and bilinearly sampled back
 *                 onto the full-resolution raster. Applied only when the page's illumination
 *                 is measurably UNEVEN — see illumSpread(), and see the defaults note below
 *                 for what the ungated version costs.
 *
 *    3. deskew    The deskew tool's own projection-variance estimator, run on the OCR input
 *                 only. Word boxes come back through `unmap()`.
 *
 *  MEASURED, NOT ASSUMED. `_qa/bench_ocrprep.mjs` runs the real tool page over 10 fixtures
 *  x 6 configurations and reports character accuracy against ground truth, wall time and
 *  peak RSS; `_qa/test_ocrprep.mjs` is the gate suite. The DEFAULTS below are set from that
 *  table, and a step that did not earn what it was expected to earn says so in numbers.
 *
 *  DEFAULTS AS SHIPPED, and the measurement that set each one (full table in the header of
 *  _qa/test_ocrprep.mjs; 10 fixtures x 6 configurations, character accuracy in points):
 *
 *    upscale  ON      +0.58 scan-3p (200 ppi), +1.24 shadow, +0.11 at 72 dpi, 0.00 on five
 *                     others. One negative: -0.79 on a 6-deg-skewed page read WITHOUT
 *                     deskew — more resolution makes an uncorrected slant worse. Deskew
 *                     ships on, and with both on that row is +4.62, so the combination is
 *                     never negative. Costs 0.3-1.2 s per page (+20-40% wall).
 *
 *    deskew   ON      +4.62 at 6 deg. EXACTLY 0.00 at 2 deg, where it correctly detected and
 *                     applied the rotation — Tesseract's own internal deskew already had
 *                     that case. Never negative, no measurable time cost, and on a straight
 *                     page the estimator returns 0 and nothing is rotated at all.
 *
 *    binarize ON, GATED on measured uneven illumination (illumSpread >= 25 levels).
 *                     Gated: +3.95 on the shadow fixture, 0.00 on all nine others.
 *                     UNGATED, the same step costs -5.30 at 72 dpi (it throws away the
 *                     antialiasing that is carrying an 11-px glyph), -1.13 at 6 deg skew,
 *                     -0.34, -0.11 and -0.05 elsewhere. The gate is not decoration: it is
 *                     the difference between a step that only helps and a step that mostly
 *                     hurts. A FLAT contrast squeeze needs no help at all — Tesseract's Otsu
 *                     inverts it for free, measured at 0.00 — which is why the gate looks
 *                     for the SPREAD of the lighting and not for low contrast.
 */
(function (global) {
  "use strict";

  var TARGET_DPI = 300;      // what we upscale TOWARD
  var MIN_DPI = 200;         // below this the pre-pass considers the raster starved
  var LOWMEM_TARGET_DPI = 200;
  var PDF_DPI = 72;          // one PDF user-space unit = 1/72 inch, so scale 1 == 72 dpi

  var SKEW_MIN_RAD = 0.007;  // ~0.4 deg — below this the estimate is noise, so do nothing
  var SKEW_MAX_DEG = 5;

  var SAUVOLA_K = 0.20;
  var SAUVOLA_R = 128;
  var ANALYSIS_MAX = 1400;   // long side of the downscaled analysis raster
  var ILLUM_GATE = 25;       // luma-level spread across the page above which the lighting is UNEVEN

  /* Shipping defaults. Overridable per-run (the bench flips them) via
     window.__ocrPrep = { binarize: true, ... } — one flag per step, so every step can be
     measured alone and switched off alone. */
  var DEFAULTS = { upscale: true, binarize: true, deskew: true };

  function switches(over) {
    var s = { upscale: DEFAULTS.upscale, binarize: DEFAULTS.binarize, deskew: DEFAULTS.deskew };
    var g = global.__ocrPrep;
    if (g && typeof g === "object") {
      if (typeof g.upscale === "boolean") s.upscale = g.upscale;
      if (typeof g.binarize === "boolean" || g.binarize === "force") s.binarize = g.binarize;
      if (typeof g.deskew === "boolean") s.deskew = g.deskew;
    }
    if (over && typeof over === "object") {
      if (typeof over.upscale === "boolean") s.upscale = over.upscale;
      if (typeof over.binarize === "boolean" || over.binarize === "force") s.binarize = over.binarize;
      if (typeof over.deskew === "boolean") s.deskew = over.deskew;
    }
    return s;
  }

  /** Is this device/plan one where we must NOT grow the raster?
      The runtime already computes every signal used here; we do not invent a fifth.
        - `plan.mode === "low-memory"`      the careful shape, and the one the user may have
                                            chosen by hand.
        - `plan.mode === "selected-pages"`  ALSO capped, and easy to miss: runtime.js:558 gives
                                            selected-pages the SAME `SHAPES.lowMemory` execution
                                            shape, and runtime.js:591 refuses to offer low-memory
                                            on top of it for exactly that reason. A mode that
                                            already carries the low-memory shape must not have
                                            its raster quadrupled underneath it.
        - `plan.lowMemorySignal`            the one real low-memory signal that exists
                                            (deviceMemory <= 2 GB).
        - `plan.device.mobile`              a phone. */
  function memCapped(plan) {
    if (!plan) return false;
    if (plan.mode === "low-memory" || plan.mode === "selected-pages") return true;
    if (plan.lowMemorySignal) return true;
    if (plan.device && plan.device.mobile) return true;
    return false;
  }

  /** Choose the pdf.js render scale for the OCR raster.
      `baseScale` is what the tool would have used with no pre-pass (2 in ocr-pdf today).
      Returns the scale plus everything needed to say honestly what was done and why. */
  function pickScale(baseScale, opts) {
    var o = opts || {};
    var sw = switches(o.switches);
    var base = +baseScale || 2;
    var out = {
      scale: base, baseScale: base,
      dpi: Math.round(base * PDF_DPI), baseDpi: Math.round(base * PDF_DPI),
      applied: false, capped: false, lowMem: false, reason: null
    };
    if (!sw.upscale) { out.reason = "upscale off"; return out; }
    if (out.baseDpi >= MIN_DPI) { out.reason = "already >= " + MIN_DPI + " dpi"; return out; }

    var low = memCapped(o.plan);
    out.lowMem = low;
    var target = low ? LOWMEM_TARGET_DPI : TARGET_DPI;
    var want = target / PDF_DPI;

    /* The canvas AREA budget is the platform-shaped cap (pdf-engine §2.2: past it mobile
       Safari hands back a SILENTLY BLANK canvas). Reuse it rather than guessing again. */
    var vpW = +o.vpWidth || 0, vpH = +o.vpHeight || 0;   // viewport size at scale 1
    if (vpW > 0 && vpH > 0 && o.clampScaleToArea) {
      var clamped = o.clampScaleToArea(vpW, vpH, want, o.areaBudget);
      if (clamped < want) { out.capped = true; want = clamped; }
    }
    if (want <= base * 1.05) {
      out.reason = out.capped ? "area budget leaves no headroom" : "no headroom";
      return out;
    }
    out.scale = want;
    out.dpi = Math.round(want * PDF_DPI);
    out.applied = true;
    out.reason = (low ? "low-memory plan: " : "") + out.baseDpi + " dpi -> " + out.dpi + " dpi";
    return out;
  }

  /* ── grayscale + Sauvola ───────────────────────────────────────────────────────────── */

  /** Luma plane of a canvas, as a Uint8Array (one byte per pixel). */
  function lumaOf(cv) {
    var w = cv.width, h = cv.height;
    var d = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    var g = new Uint8Array(w * h);
    for (var i = 0, p = 0; p < g.length; p++, i += 4) {
      g[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    }
    return g;
  }

  /** Sauvola threshold field, computed on a downscaled copy.
      Returns { t: Float32Array, w, h } — the field, NOT the image. */
  function sauvolaField(cv) {
    var scale = Math.min(1, ANALYSIS_MAX / Math.max(cv.width, cv.height));
    var aw = Math.max(8, Math.round(cv.width * scale));
    var ah = Math.max(8, Math.round(cv.height * scale));
    var a = document.createElement("canvas");
    a.width = aw; a.height = ah;
    var ax = a.getContext("2d", { willReadFrequently: true });
    ax.drawImage(cv, 0, 0, aw, ah);
    var g = lumaOf(a);
    a.width = 0; a.height = 0;

    /* integral images over the ANALYSIS raster only — (aw+1)*(ah+1) Float64 each, i.e.
       ~16 MB at the 1400-px cap, versus ~540 MB if this ran at 300-dpi full resolution. */
    var iw = aw + 1, ih = ah + 1;
    var s1 = new Float64Array(iw * ih), s2 = new Float64Array(iw * ih);
    for (var y = 0; y < ah; y++) {
      var r1 = 0, r2 = 0;
      for (var x = 0; x < aw; x++) {
        var v = g[y * aw + x];
        r1 += v; r2 += v * v;
        s1[(y + 1) * iw + (x + 1)] = s1[y * iw + (x + 1)] + r1;
        s2[(y + 1) * iw + (x + 1)] = s2[y * iw + (x + 1)] + r2;
      }
    }
    var win = Math.max(7, Math.round(Math.max(aw, ah) / 24)) | 1;
    var rad = (win - 1) >> 1;
    var t = new Float32Array(aw * ah);
    for (var yy = 0; yy < ah; yy++) {
      var y0 = Math.max(0, yy - rad), y1 = Math.min(ah - 1, yy + rad);
      for (var xx = 0; xx < aw; xx++) {
        var x0 = Math.max(0, xx - rad), x1 = Math.min(aw - 1, xx + rad);
        var n = (x1 - x0 + 1) * (y1 - y0 + 1);
        var A = y0 * iw + x0, B = y0 * iw + (x1 + 1), Cc = (y1 + 1) * iw + x0, D = (y1 + 1) * iw + (x1 + 1);
        var sum = s1[D] - s1[B] - s1[Cc] + s1[A];
        var sq = s2[D] - s2[B] - s2[Cc] + s2[A];
        var m = sum / n;
        var varr = sq / n - m * m;
        var sd = varr > 0 ? Math.sqrt(varr) : 0;
        t[yy * aw + xx] = m * (1 + SAUVOLA_K * (sd / SAUVOLA_R - 1));
      }
    }
    return { t: t, w: aw, h: ah };
  }

  /** Apply a threshold field to a canvas, in place, as a hard 0/255 binarization.
      The field is bilinearly sampled, so a 1400-px field drives a 3000-px raster without
      blocking artefacts at the field's own grid. */
  function applyField(cv, field) {
    var w = cv.width, h = cv.height;
    var cx = cv.getContext("2d", { willReadFrequently: true });
    var im = cx.getImageData(0, 0, w, h);
    var d = im.data, t = field.t, fw = field.w, fh = field.h;
    var sx = (fw - 1) / Math.max(1, w - 1), sy = (fh - 1) / Math.max(1, h - 1);
    for (var y = 0; y < h; y++) {
      var fy = y * sy, y0 = fy | 0, y1 = Math.min(fh - 1, y0 + 1), wy = fy - y0;
      for (var x = 0; x < w; x++) {
        var fx = x * sx, x0 = fx | 0, x1 = Math.min(fw - 1, x0 + 1), wx = fx - x0;
        var th = t[y0 * fw + x0] * (1 - wx) * (1 - wy) + t[y0 * fw + x1] * wx * (1 - wy) +
                 t[y1 * fw + x0] * (1 - wx) * wy + t[y1 * fw + x1] * wx * wy;
        var i = (y * w + x) * 4;
        var g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
        var o = g > th ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = o;
      }
    }
    cx.putImageData(im, 0, 0);
  }

  /** How UNEVEN the page's illumination is, in luma levels.
      An 8x8 grid over a downscaled copy; each cell's PAPER level is its 90th-percentile
      luma (the ink is the minority, so a high percentile is the paper); the answer is the
      spread of those 64 paper levels.
      This is the gate on binarization, and it exists because the measurement said so: a
      local threshold is the only thing that recovers an unevenly lit page (+3.95 points on
      the shadow fixture) and it COSTS accuracy everywhere else, worst of all on starved
      resolution (-5.30 points at 72 dpi, where it throws away the antialiasing that is
      carrying the glyph shape). A single global threshold can solve a FLAT contrast squeeze
      — Tesseract's own Otsu step already does, measured: 0.00 change on the flat low-contrast
      fixture — so the thing worth detecting is the spread, not the contrast. */
  function illumSpread(cv) {
    try {
      var W = 96, H = Math.max(8, Math.round(cv.height * (W / cv.width)));
      var c2 = document.createElement("canvas");
      c2.width = W; c2.height = H;
      c2.getContext("2d", { willReadFrequently: true }).drawImage(cv, 0, 0, W, H);
      var g = lumaOf(c2);
      c2.width = 0; c2.height = 0;
      var GX = 8, GY = 8, lo = 255, hi = 0, any = false;
      for (var gy = 0; gy < GY; gy++) {
        for (var gx = 0; gx < GX; gx++) {
          var x0 = Math.floor(gx * W / GX), x1 = Math.floor((gx + 1) * W / GX);
          var y0 = Math.floor(gy * H / GY), y1 = Math.floor((gy + 1) * H / GY);
          var vals = [];
          for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) vals.push(g[y * W + x]);
          if (vals.length < 4) continue;
          vals.sort(function (a, b) { return a - b; });
          var paper = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.9))];
          if (paper < lo) lo = paper;
          if (paper > hi) hi = paper;
          any = true;
        }
      }
      return any ? hi - lo : 0;
    } catch (e) { return 0; }
  }

  /* ── skew ──────────────────────────────────────────────────────────────────────────── */

  /** Estimate small skew by maximising horizontal-projection variance of the ink, on a
      downscaled binarised copy. Returns RADIANS, 0 when the page is straight enough that
      rotating it would cost a resample for nothing.
      This is the deskew tool's estimator (all-tools.js `detectSkewOfPage`) with the same
      search window; it lives here so the OCR pre-pass does not have to instantiate a tool. */
  function estimateSkew(cv) {
    try {
      var W = 320, H = Math.max(8, Math.round(cv.height * (W / cv.width)));
      var c2 = document.createElement("canvas");
      c2.width = W; c2.height = H;
      c2.getContext("2d", { willReadFrequently: true }).drawImage(cv, 0, 0, W, H);
      var g = lumaOf(c2);
      c2.width = 0; c2.height = 0;
      var ink = [];
      for (var p = 0; p < g.length; p++) {
        if (g[p] < 150) ink.push(p);
      }
      if (ink.length < 200) return 0;
      var best = 0, bestV = -1;
      for (var a = -SKEW_MAX_DEG; a <= SKEW_MAX_DEG + 0.001; a += 0.25) {
        var rad = a * Math.PI / 180, s = Math.sin(rad), c = Math.cos(rad);
        var rows = new Float64Array(H + 2 * W);
        var off = W;
        for (var k = 0; k < ink.length; k++) {
          var px = ink[k] % W, py = (ink[k] / W) | 0;
          var yr = Math.round(py * c - px * s) + off;
          if (yr >= 0 && yr < rows.length) rows[yr]++;
        }
        var mean = ink.length / rows.length, v = 0;
        for (var j = 0; j < rows.length; j++) { var dv = rows[j] - mean; v += dv * dv; }
        if (v > bestV) { bestV = v; best = rad; }
      }
      return Math.abs(best) > SKEW_MIN_RAD ? best : 0;
    } catch (e) { return 0; }
  }

  /* ── the pre-pass ──────────────────────────────────────────────────────────────────── */

  /**
   * prepare(canvas, opts) -> {
   *     canvas,      the raster to hand Tesseract (===input when nothing was applied)
   *     owned,       true when `canvas` is OURS to free — the caller must not free the input
   *     skewRad,     the rotation applied to the OCR input (0 when none)
   *     unmap(x,y),  inverse-map an OCR pixel coordinate back to INPUT pixel coordinates
   *     applied,     ["binarize","deskew"] — what actually ran
   *     ms
   *   }
   *
   * The input canvas is NEVER modified. That is not tidiness: on the ocr-pdf fallback path
   * the same raster is re-embedded as the visible page, and a binarised page is not the
   * page the user handed us.
   */
  function prepare(cv, opts) {
    var o = opts || {};
    var sw = switches(o.switches);
    var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
    var applied = [];
    var src = cv, owned = false;

    function ownCopy(from) {
      var c = document.createElement("canvas");
      c.width = from.width; c.height = from.height;
      c.getContext("2d").drawImage(from, 0, 0);
      return c;
    }

    /* GATED. `binarize: true` means "binarize IF the page is unevenly lit"; only
       `binarize: "force"` is unconditional, and that spelling exists for the bench, which
       has to be able to measure the harm on pages the gate would have spared. */
    var spread = -1;
    if (sw.binarize) {
      spread = illumSpread(src);
      var force = sw.binarize === "force";
      if (force || spread >= ILLUM_GATE) {
        var work = ownCopy(src);
        try {
          applyField(work, sauvolaField(work));
          if (owned) { src.width = 0; src.height = 0; }
          src = work; owned = true;
          applied.push(force && spread < ILLUM_GATE ? "binarize(forced)" : "binarize");
        } catch (e) { work.width = 0; work.height = 0; }
      }
    }

    var skew = 0;
    if (sw.deskew) {
      skew = estimateSkew(src);
      if (skew) {
        var rot = document.createElement("canvas");
        rot.width = src.width; rot.height = src.height;
        var rx = rot.getContext("2d");
        rx.fillStyle = "#ffffff";
        rx.fillRect(0, 0, rot.width, rot.height);
        rx.translate(rot.width / 2, rot.height / 2);
        rx.rotate(-skew);
        rx.drawImage(src, -src.width / 2, -src.height / 2);
        if (owned) { src.width = 0; src.height = 0; }
        src = rot; owned = true;
        applied.push("deskew");
      }
    }

    var cw = cv.width, ch = cv.height;
    var t1 = (global.performance && performance.now) ? performance.now() : Date.now();
    return {
      canvas: src,
      owned: owned,
      skewRad: skew,
      applied: applied,
      illumSpread: spread,
      ms: Math.round(t1 - t0),
      /* The rotation was about the raster centre by -skew, so the inverse is +skew about the
         same centre. Identity when nothing was rotated, which keeps the call sites free of
         branches. */
      unmap: function (x, y) {
        if (!skew) return [x, y];
        var dx = x - cw / 2, dy = y - ch / 2;
        var c = Math.cos(skew), s = Math.sin(skew);
        return [cw / 2 + dx * c - dy * s, ch / 2 + dx * s + dy * c];
      },
      release: function () {
        if (owned && src) { src.width = 0; src.height = 0; }
      }
    };
  }

  global.OCRPrep = {
    VERSION: 1,
    DEFAULTS: DEFAULTS,
    TARGET_DPI: TARGET_DPI,
    MIN_DPI: MIN_DPI,
    LOWMEM_TARGET_DPI: LOWMEM_TARGET_DPI,
    switches: switches,
    memCapped: memCapped,
    pickScale: pickScale,
    estimateSkew: estimateSkew,
    prepare: prepare
  };
})(typeof window !== "undefined" ? window : this);
