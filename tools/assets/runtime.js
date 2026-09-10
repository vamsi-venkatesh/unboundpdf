"use strict";
/* UnboundPDF shared execution runtime — P1 §1 skeleton (step 3 of the §8 sequence).
 *
 * WHAT THIS IS: one lifecycle for heavy tool work — truthful phases, real cancellation,
 * a cleanup ledger that runs on ALL exits (ok / failed / cancelled), and an operation
 * receipt. It CONSUMES the existing PDFTK panels (progressPanel / errorPanel / humanError)
 * and replaces nothing, so a tool that has not adopted it is byte-for-byte unaffected.
 *
 * ZERO TOOLS ARE ADOPTED IN THIS FILE'S STEP. all-tools.js and editor.js are untouched;
 * adoption of the ~18 loops is step 5.
 *
 * LOADING ORDER (wiring is step 5's scope — NOT done here): this script must load AFTER
 * pdf-engine.js and BEFORE tools/all-tools.js / tools/editor.js, i.e. a
 *   <script src="/tools/assets/runtime.js?v=${ASSET_V}" defer></script>
 * line inserted between scripts/gen_pdf_toolkit.mjs:733 (pdf-engine) and :734-736
 * (all-tools / editor). `defer` preserves document order, so the global exists before any
 * tool body runs. It is NOT added by this step — no generator is edited here.
 *
 * Style follows every other asset in this tree: plain script, IIFE over `global`, "use strict",
 * `var`, function statements, DOM via PDFTK helpers, never innerHTML, no build step, no ESM.
 */
(function (global) {

  /* PDFTK is resolved lazily, not at load time: this file may legitimately load before
     pdf-engine.js has finished defining window.PDFTK (defer order guarantees execution
     order, but the node unit harness loads this file standalone with a stub). */
  function T() { return global.PDFTK || null; }

  var HAS_DOM = typeof document !== "undefined" && !!document.createElement;
  var RESOLVED = Promise.resolve();

  /* ── Cancellation labels (§4.2 — the five, verbatim in meaning) ───────────────────────
     `resumable` exists in the table only to be REFUSED: the directive forbids claiming
     resumability where the library requires a full restart, and pdf-lib requires it. A
     descriptor that declares it is rejected rather than silently downgraded, so the claim
     cannot re-enter the product by accident. */
  var CANCEL = {
    ITEM: {
      id: "item",
      registry: "supported",
      text: "You can stop this — it stops within the current item."
    },
    PAGE: {
      id: "page",
      registry: "after-current-page",
      text: "You can stop this — it stops after the current page finishes."
    },
    REBUILD_FINAL: {
      id: "rebuild-final",
      registry: "none-during-final-rebuild",
      text: "This cannot be stopped during the final rebuild."
    },
    RESTART: {
      id: "restart",
      registry: "restart-required",
      text: "Stopping discards the work — there is no resume; you would start again."
    },
    RESUMABLE: {
      id: "resumable",
      registry: "resumable",
      text: "",
      refuse: true          // never assignable — see comment above
    }
  };

  /* The phase whose name marks the uninterruptible tail. §4.2: compress/balanced cancels at
     image granularity, but the trailing pdf-lib save() is one non-yielding pass, so the UI
     label must switch the moment that phase starts. The runtime does it from the phase name
     rather than from 18 hand edits. */
  var FINAL_REBUILD_RE = /rebuild|saving|serialis|serializ/i;

  /* ── Op classes (§3.2) ────────────────────────────────────────────────────────────────
     KEPT for the cancel-label lookup and for §7's registry provenance trail. The `ratio`
     column is HISTORICAL AND DEAD: Addendum A falsified `input × ratio` outright (it
     over-predicts 9.2× at 400 MB and would refuse a job that completes in 108 s). No
     decision anywhere reads it. BANDS below is what the estimator consults. */
  var CLASSES = {
    "raster-export": { peakRssMB: 2219, inputMB: 39.76, ratio: 55, perPageMB: 7.8, cancel: CANCEL.ITEM },
    "editor":        { peakRssMB: 1705, inputMB: 39.76, ratio: 43, perPageMB: 17.2, cancel: CANCEL.ITEM },
    "ocr":           { peakRssMB: 1669, inputMB: 39.76, ratio: 42, perPageMB: null, cancel: CANCEL.PAGE },
    "requant":       { peakRssMB: 941,  inputMB: 118.99, ratio: 8, perPageMB: null, cancel: CANCEL.ITEM },
    "multi-doc":     { peakRssMB: 767,  inputMB: 40.22, ratio: 19, perPageMB: null, cancel: CANCEL.ITEM },
    "structural":    { peakRssMB: 688,  inputMB: 2.31,  ratio: null, perPageMB: 0.688, cancel: CANCEL.REBUILD_FINAL }
  };
  var CLASS_PROVENANCE = "desktop-chromium-2026-08-13";
  var CLASS_CALIBRATED = false;   // real-device MEMORY bands still do not exist — see BANDS

  /* ══════════════════════════════════════════════════════════════════════════════════════
     STEP 7 — DEVICE-AWARE PRE-FLIGHT (P1 §3, as amended by Addendum A)

     Addendum A item 1 replaced the multiplication model with a per-op WORKING-SET BAND, and
     item 2 made real devices the only source of a low-memory verdict. Everything below obeys
     both. Three separate tables, because they have three different evidential statuses:

       BANDS     — measured peak-RSS floors/ceilings. DESKTOP ONLY. Never shown to a user.
       PROVEN    — the largest input a class has been OBSERVED to complete, per device class.
                   The mobile rows are the founder's two real phones. This is what decides.
       RATES     — measured seconds-per-page / seconds-per-MB. Drives TIME wording only.

     What is deliberately absent: any mobile memory band. Neither phone was instrumented, so
     no memory number exists for them and none is invented. A device outside PROVEN gets an
     honest UNKNOWN, never a fabricated verdict. ══════════════════════════════════════════ */

  /* Measured working sets. `hi` is the observed ceiling, `lo` the observed floor; the spread
     is real (pdf-to-jpg measured 1807/1954/2219/2721 MB on UNCHANGED input). `postStep4`
     records the step-4 batched-pipeline remeasurement where one exists. These numbers exist
     to be reported in the registry and to keep the estimator honest about its own precision.
     THEY ARE NEVER RENDERED INTO USER-VISIBLE TEXT — §3.4 and directive §6 forbid it. */
  var BANDS = {
    "raster-export": {
      loMB: 1807, hiMB: 2721, postStep4: { loMB: 534, hiMB: 582, note: "scan-100p after the batched render→encode→release pipeline; 534 MB is the intake floor (bytes + pdf.js parse), 582 MB the export peak" },
      sizeSensitivity: "none detectable 40→400 MB",
      provenance: "desktop-chromium-2026-08-13", calibrated: false, source: "oom-matrix-results.md §3 + step-4 remeasurement"
    },
    "editor": {
      loMB: 1347, hiMB: 2074, postStep4: null,
      sizeSensitivity: "none detectable 40→400 MB",
      provenance: "desktop-chromium-2026-08-13", calibrated: false, source: "oom-matrix-results.md §3; step-8 A/B confirmed peak is set at LOAD, not at save"
    },
    "ocr": {
      loMB: 1279, hiMB: 1669, postStep4: null,
      sizeSensitivity: "none detectable (100 pp vs 300 pp)",
      provenance: "desktop-chromium-2026-08-13", calibrated: false, source: "oom-matrix-results.md §3"
    },
    "requant": {
      loMB: 720, hiMB: 1359, postStep4: null,
      sizeSensitivity: "weak, sub-linear",
      provenance: "desktop-chromium-2026-08-13", calibrated: false, source: "oom-matrix-results.md §3"
    },
    "multi-doc": {
      loMB: 767, hiMB: 2143, postStep4: null,
      sizeSensitivity: "present: 40 MB→767 MB, 635 MB→2143 MB",
      provenance: "desktop-chromium-2026-08-13", calibrated: false, source: "oom-matrix-results.md §3"
    },
    "structural": {
      loMB: 688, hiMB: 721, postStep4: null,
      sizeSensitivity: "none: bounded by the 200-thumbnail cap, not by page count",
      provenance: "desktop-chromium-2026-08-13", calibrated: false, source: "oom-matrix-results.md §3"
    }
  };

  /* The observed-completion envelope. `pages`/`mb` are the LARGEST input measured to finish —
     not a limit, a floor under our knowledge. Anything at or below is proven; anything above
     is unmeasured, which is a different statement from "too big".

     `sizeDriven:false` is not a convenience — it is a measurement. `structural` cost 721 MB
     at 3000 pages and 688 MB at 1000, from a 6.9 MB file: the class is bounded by the
     200-thumbnail cap, not by bytes. Comparing a 40 MB scan against that 6.9 MB fixture would
     manufacture a warning out of a number that was never about size.

     The `mb` figures are the fixtures' own measured sizes, rounded UP at the second decimal
     so that the fixture which proved the envelope is inside it (scan-100p is 39.7601 MB).

     EVERY ENTRY IS A LIST OF OBSERVED RUNS, and an input is inside the envelope only when a
     SINGLE run covers both its dimensions. This is not bookkeeping pedantry: the first draft
     of this table stored one rectangle per class, and for the editor that rectangle was
     composed from two different fixtures — scan-100p's 40 MB crossed with text-1000p's 1000
     pages — so it silently asserted that the phones had completed a 40 MB / 1000-page
     document that neither of them ever opened. A convex hull of separate runs is not a run.
     One row per fixture, ANDed within a row and ORed across rows, is the only shape that
     cannot invent an observation. */
  var PROVEN = {
    desktop: {
      "raster-export": [{ pages: 1000, mb: 396.72, sizeDriven: true, fixture: "scan-1000p" }],
      "editor":        [{ pages: 1000, mb: 396.72, sizeDriven: true, fixture: "scan-1000p" }],
      "requant":       [{ pages: 1000, mb: 396.72, sizeDriven: true, fixture: "scan-1000p" }],
      "multi-doc":     [{ pages: 1600, mb: 634.60, sizeDriven: true, fixture: "600p+1000p merge" }],
      /* structural was measured page-driven, not size-driven (721 MB at 3000 pages from a
         6.9 MB file), so its row carries no size dimension to compare against. */
      "structural":    [{ pages: 3000, mb: null,   sizeDriven: false, fixture: "text-3000p" }],
      "ocr":           [{ pages: 300,  mb: 118.99, sizeDriven: true, fixture: "scan-300p" }]
    },
    /* REAL DEVICES ONLY. iPhone 14 / Safari and a Mi phone / Chrome, both driven by the
       founder against the live origin on 2026-08-13. Both COMPLETED compress at 119 MB /
       300 pages with no crash and no reload — so a pre-flight that warns below this envelope
       on a modern phone is manufacturing fear, and the tests forbid it. */
    mobile: {
      "requant":       [{ pages: 300, mb: 118.99, sizeDriven: true, fixture: "scan-300p" }],
      "raster-export": [{ pages: 100, mb: 39.77,  sizeDriven: true, fixture: "scan-100p" }],
      /* TWO runs, not one rectangle. Both phones opened scan-100p (40 MB, 100 pages) and both
         opened text-1000p (2.3 MB, 1000 pages) — with the scroll degradation CAUTIONS records.
         Neither ever opened a document that was BOTH 40 MB and 1000 pages, and this table must
         not claim they did. */
      "editor":        [{ pages: 100,  mb: 39.77, sizeDriven: true, fixture: "scan-100p" },
                        { pages: 1000, mb: 2.32,  sizeDriven: true, fixture: "text-1000p" }]
      /* ocr, multi-doc, structural: NO mobile run exists. Absent on purpose — an absent row
         yields UNKNOWN, and UNKNOWN is the honest answer. */
    }
  };

  /* Real-device evidence rows, kept as data so the registry and the tests read the same
     source the wording does. */
  var DEVICE_EVIDENCE = [
    { device: "iphone-14", browser: "safari", op: "editor",        fixture: "scan-100p",  pages: 100,  mb: 39.76,  outcome: "complete", seconds: [10, 20],  note: "page 1 visible; no crash", source: "device-results-iphone-20260813.md" },
    { device: "iphone-14", browser: "safari", op: "requant",       fixture: "scan-100p",  pages: 100,  mb: 39.76,  outcome: "complete", seconds: null,      note: "fast; no memory-kill banner", source: "device-results-iphone-20260813.md" },
    { device: "iphone-14", browser: "safari", op: "requant",       fixture: "scan-300p",  pages: 300,  mb: 118.99, outcome: "complete", seconds: [30, 40],  note: "no white flash, no reload", source: "device-results-iphone-20260813.md" },
    { device: "iphone-14", browser: "safari", op: "raster-export", fixture: "scan-100p",  pages: 100,  mb: 39.76,  outcome: "complete", seconds: [10, 20],  note: "ZIP download landed", source: "device-results-iphone-20260813.md" },
    { device: "iphone-14", browser: "safari", op: "editor",        fixture: "text-1000p", pages: 1000, mb: 2.31,   outcome: "complete-degraded", seconds: null, note: "page 1 visible; scrolling janky", source: "device-results-iphone-20260813.md" },
    { device: "mi-generic", browser: "chrome", op: "editor",        fixture: "scan-100p",  pages: 100,  mb: 39.76,  outcome: "complete", seconds: [30, 40],  note: "scroll okay", source: "device-results-mi-20260813.md" },
    { device: "mi-generic", browser: "chrome", op: "requant",       fixture: "scan-100p",  pages: 100,  mb: 39.76,  outcome: "complete", seconds: [40, 60],  note: "load fast", source: "device-results-mi-20260813.md" },
    { device: "mi-generic", browser: "chrome", op: "requant",       fixture: "scan-300p",  pages: 300,  mb: 118.99, outcome: "complete", seconds: [60, 100], note: "no crash/reload", source: "device-results-mi-20260813.md" },
    /* seconds is NULL, not [60,120]. The report says "images <60s, conversion <60s" — that is
       an upper bound of two sub-steps and NO lower bound whatsoever; the true floor could be
       5 s. Writing 60 as the low end would put a minimum nobody measured into an evidence
       table, which is the failure mode this table exists to prevent. The ceiling is real and
       is carried separately. */
    { device: "mi-generic", browser: "chrome", op: "raster-export", fixture: "scan-100p",  pages: 100,  mb: 39.76,  outcome: "complete", seconds: null, secondsUpperBound: 120, note: "images <60s + conversion <60s: an upper bound on two sub-steps, not a stopwatch; no lower bound was observed", source: "device-results-mi-20260813.md" },
    { device: "mi-generic", browser: "chrome", op: "editor",        fixture: "text-1000p", pages: 1000, mb: 2.31,   outcome: "complete-degraded", seconds: [10, 20], note: "loaded; scroll slow on v133", source: "device-results-mi-20260813.md" }
  ];

  /* Seconds per page and per MB, both ends of the measured spread. Estimation is
     max(pageTerm, sizeTerm) — Addendum A kept the size and page terms alive as TIME
     predictors precisely because they behave there, even though they do not predict memory.
     A null row means NOTHING WAS MEASURED and no time sentence is produced. */
  var RATES = {
    desktop: {
      "raster-export": { sPerPage: [0.074, 0.108], sPerMB: [0.180, 0.272], provenance: "desktop-chromium-2026-08-13 (scan-1000p: 396.7 MB / 1000 pp in 107.9 s)" },
      "editor":        { sPerPage: [0.073, 0.090], sPerMB: [0.120, 0.185], provenance: "desktop-chromium-2026-08-13 (editor build ~13.6 pages/s; scan-1000p 73.4 s)" },
      "requant":       { sPerPage: [0.071, 0.086], sPerMB: [0.120, 0.179], provenance: "desktop-chromium-2026-08-13 (scan-1000p: 70.9 s)" },
      "ocr":           { sPerPage: [1.489, 1.489], sPerMB: [3.754, 3.754], provenance: "desktop-chromium-2026-08-13 (scan-300p: 446.7 s)" },
      "multi-doc":     { sPerPage: [0.003, 0.004], sPerMB: [0.008, 0.009], provenance: "desktop-chromium-2026-08-13 (1600 pp / 634.6 MB in 5.3 s)" },
      "structural":    null   /* organize-pdf timing was never isolated from fixture setup */
    },
    /* Derived from the founder's two phones. The lo end is the iPhone 14, the hi end the Mi;
       the Mi's raster-export row is a coarse "<60s + <60s" upper bound and is labelled as one
       wherever it is used. Every mobile expectation is emitted as a RANGE for this reason. */
    mobile: {
      /* Every `lo` is the FASTEST figure an actual device produced, not a padded-up guess:
         iPhone 14 did scan-100p in 10 s (0.10 s/page, 0.25 s/MB) for both raster-export and
         the editor, and scan-300p in 30 s (0.10 s/page, 0.25 s/MB) for compress. Rounding the
         floor upward "to be safe" invents a minimum, exactly as the Mi seconds row did. */
      "raster-export": { sPerPage: [0.10, 1.20], sPerMB: [0.25, 3.00], provenance: "real devices 2026-08-13 (iPhone 14 10–20 s on scan-100p; the upper end is the Mi's coarse <60s+<60s bound, not a stopwatch)" },
      "editor":        { sPerPage: [0.10, 0.40], sPerMB: [0.25, 1.00], provenance: "real devices 2026-08-13 (iPhone 14 10–20 s, Mi 30–40 s on scan-100p)" },
      "requant":       { sPerPage: [0.10, 0.34], sPerMB: [0.25, 0.84], provenance: "real devices 2026-08-13 (iPhone 14 30–40 s, Mi 60–100 s on scan-300p)" },
      "ocr":           null,   /* never run on a phone */
      "multi-doc":     null,   /* never run on a phone */
      "structural":    null    /* never run on a phone */
    }
  };

  /* Comfort cautions — observed degradation that is NOT a failure and must not become a
     refusal. The editor loaded 1000 pages on BOTH phones; it scrolled badly on both. */
  var CAUTIONS = {
    mobile: {
      "editor": [
        { overPages: 300, id: "editor-mobile-scroll",
          text: "On a phone, a document this long opens but scrolls slowly. It works — it is just not comfortable.",
          source: "device-results-iphone-20260813.md test E + device-results-mi-20260813.md test E" }
      ]
    },
    desktop: {}
  };

  /* HARD CAPS — structural limits READ OFF THE CODE, not memory guesses. This is the only
     trigger for "unsupported safely", because nothing in the whole measured matrix ever
     failed for memory. buildZip (pdf-engine.js:231-266) writes a ZIP32 container: the EOCD
     entry count is a uint16 and every size/offset field is a uint32. Those are format facts,
     provable by reading the writer, and they are counts and byte-container limits — not
     claims about this device's memory. */
  var HARD_CAPS = {
    "raster-export": {
      maxEntries: 65535,
      why: "the ZIP file this build writes stores its file count in a 16-bit field, so it cannot hold more than 65,535 images",
      source: "pdf-engine.js buildZip — ZIP32 EOCD, uint16 entry count"
    }
  };
  /* Projected archive bytes per page, measured: the JPEG ZIP came out at exactly 0.1834
     MB/page at 300, 600 AND 1000 pages. Used to CAUTION about the uint32 4 GiB container
     ceiling — a caution, not a refusal, because the constant is a fixture measurement. */
  var ZIP_MB_PER_PAGE = 0.1834;
  var ZIP32_MAX_BYTES = 4294967295;

  /* Tools that accept an explicit page range today, so "selected pages" is a real offer
     rather than an instruction the UI cannot honour. Verified by the T.parseRanges call
     sites in tools/all-tools.js. */
  var RANGE_TOOLS = {
    "split-pdf": true, "rotate-pdf": true, "split-by-bookmarks": true,
    "pdf-to-jpg": true, "add-page-numbers": true
  };

  /* Execution shapes. These are SHAPES, not memory claims: how many pages between yields,
     how wide the page cache band is, whether previews are built. */
  var SHAPES = {
    standard: {
      batch: 8,               // pdf-to-jpg derives YIELD_EVERY = batch/2 → 4
      pageCache: 3,           // editor EVICT_N
      thumbBand: { render: "300px 0px", release: "900px 0px" },
      maxCanvasArea: 16e6,
      previews: true
    },
    lowMemory: {
      batch: 4,               // → YIELD_EVERY 2. §3.3 wrote "2"; the consumer halves it, and
                              // yielding on every single page is a bigger behavioural change
                              // than any measurement supports. 4→2 is what step 7 ships.
      pageCache: 1,
      thumbBand: { render: "0px 0px", release: "300px 0px" },
      maxCanvasArea: 4e6,
      previews: false
    }
  };

  /* ── Cancelled ───────────────────────────────────────────────────────────────────────── */
  function Cancelled(at) {
    var e = new Error("Cancelled" + (at ? " during " + at : ""));
    e.name = "Cancelled";
    e.__ubrCancelled = true;      // cross-realm safe; instanceof is not
    e.at = at || null;
    return e;
  }
  Cancelled.is = function (e) { return !!(e && e.__ubrCancelled === true); };

  /* ── Cleanup ledger ──────────────────────────────────────────────────────────────────
     Disposal is by duck type, LIFO, each entry in its own try/catch: a cleanup failure must
     never overwrite the run's real outcome. Covers the resource kinds §4.3 names — canvases,
     ImageBitmaps, object URLs, pdf.js documents, workers, large arrays. `hold` is the only
     way in and returns its argument, so it wraps an expression without restructuring code. */
  function disposeOne(entry) {
    var x = entry.value, kind = entry.kind;
    if (typeof kind === "function") { kind(x); return; }          // caller-supplied disposer
    if (x == null) return;
    if (typeof x === "string") {                                   // an object URL
      if (/^blob:/.test(x) && typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(x);
      return;
    }
    if (kind === "pdflib") return;                                 // parsed graph: drop the ref only
    if (typeof x.terminate === "function") { x.terminate(); return; }   // Worker, Tesseract worker
    if (typeof x.destroy === "function") { x.destroy(); return; }       // PDFDocumentProxy (0 destroys today)
    if (typeof x.close === "function") { x.close(); return; }           // ImageBitmap
    if (typeof x.getContext === "function" || (typeof x.width === "number" && typeof x.height === "number" && "getContext" in x)) {
      x.width = 0; x.height = 0; return;                                // canvas: zero the backing store
    }
    if (typeof x.width === "number" && typeof x.height === "number") { x.width = 0; x.height = 0; return; }
    if (Array.isArray(x)) { x.length = 0; return; }                     // large arrays of parts
  }

  function makeLedger() {
    var entries = [];
    var released = false;
    return {
      hold: function (value, kind) { entries.push({ value: value, kind: kind }); return value; },
      size: function () { return entries.length; },
      releasedOnce: function () { return released; },
      releaseAll: function () {
        released = true;
        var errs = 0;
        for (var i = entries.length - 1; i >= 0; i--) {
          try { disposeOne(entries[i]); } catch (e) { errs++; }
        }
        entries.length = 0;       // idempotent: a second releaseAll() is a no-op
        return errs;
      }
    };
  }

  /* ── Device profile ───────────────────────────────────────────────────────────────────
     `override` exists so the test suite can simulate a device without a browser: every
     signal this function reads is injectable and nothing else is consulted.

     THE HONESTY RULE, encoded here rather than in prose: `known` is true only when the
     device sits inside a class we have real evidence for. deviceMemory is absent on Safari
     and Firefox entirely, so an iPhone reports nothing — and an iPhone 14 (proven to finish
     119 MB / 300 pages) is indistinguishable from an iPhone 6. We therefore do NOT guess a
     phone's age. We report `known:false` and let the caller offer, never impose. */
  function deviceProfile(override) {
    var o = override || {};
    var n = (typeof navigator !== "undefined") ? navigator : null;
    var dm = ("deviceMemory" in o) ? o.deviceMemory
           : (n && typeof n.deviceMemory === "number") ? n.deviceMemory : null;
    var ua = ("userAgent" in o) ? String(o.userAgent || "") : (n && n.userAgent) ? String(n.userAgent) : "";
    var mobile;
    if ("mobile" in o) mobile = !!o.mobile;
    else if (/Android|iPhone|iPad|iPod|Mobile Safari|Windows Phone/i.test(ua)) mobile = true;
    else if (typeof matchMedia === "function") { try { mobile = matchMedia("(max-width: 820px), (pointer: coarse)").matches; } catch (e) { mobile = false; } }
    else mobile = false;
    var cls = mobile ? "mobile" : "desktop";
    /* A reported deviceMemory of 2 GB or less is the ONE low-memory signal that exists, and
       it is a signal we have no band for — it selects low-memory shapes and an honest
       "we have not measured this" verdict, never a number. */
    var lowSignal = (typeof dm === "number" && dm > 0 && dm <= 2);
    /* Evidence covers desktop (the whole matrix) and modern phones (two real handsets).
       A phone reporting ≤2 GB is outside that evidence; a phone reporting nothing is
       UNKNOWN rather than assumed-bad, because assuming bad is exactly the scare-warning
       the real-device results forbid. */
    var known = (cls === "desktop") ? true : (typeof dm === "number" && dm >= 4);
    return {
      "class": cls, mobile: mobile, deviceMemory: dm,
      hardwareConcurrency: ("hardwareConcurrency" in o) ? o.hardwareConcurrency
        : (n && typeof n.hardwareConcurrency === "number") ? n.hardwareConcurrency : null,
      lowMemorySignal: lowSignal,
      known: known && !lowSignal
    };
  }

  function deviceHints(override) {
    var p = deviceProfile(override);
    return {
      deviceMemory: p.deviceMemory,
      hardwareConcurrency: p.hardwareConcurrency,
      deviceClass: p["class"],
      deviceKnown: p.known,
      provenance: CLASS_PROVENANCE,
      calibrated: CLASS_CALIBRATED
    };
  }

  /* ── The estimator: max(pageTerm, sizeTerm), TIME ONLY ───────────────────────────────
     Addendum A killed the multiplication for memory and kept it for time, where the
     measurements actually support it: output and wall clock were exactly linear across a
     10× input range. Returns null — not a number — when no rate was measured for this
     (device class, op) pair. A null propagates all the way to "no time sentence". */
  function estimateSeconds(opClass, pages, mb, deviceClass) {
    var tbl = RATES[deviceClass] || null;
    var r = tbl ? tbl[opClass] : null;
    if (!r) return null;
    var p = Number(pages) || 0, m = Number(mb) || 0;
    var lo = Math.max(p * r.sPerPage[0], m * r.sPerMB[0]);
    var hi = Math.max(p * r.sPerPage[1], m * r.sPerMB[1]);
    if (!(hi > 0)) return null;
    return { loSec: lo, hiSec: hi, provenance: r.provenance };
  }

  /* Coarse content type. A REAL structural scan (first pages' /XObject dicts, no pixel
     decode) is done by the caller where a parsed document is already in hand and passed in
     as input.type / input.imageHeavy; this fallback derives a label from bytes-per-page and
     SAYS SO, because a guess presented as a scan is a lie about provenance.
     Calibration points: scan-100p 417 KB/page (scanned), mixed-500p 209 KB/page (mixed),
     text-1000p 2.4 KB/page (text). */
  function contentType(input) {
    var i = input || {};
    if (i.type) return { label: i.type, scanned: !!i.scanned, imageHeavy: !!i.imageHeavy, detected: "structural-scan" };
    if (typeof i.imageHeavy === "boolean") {
      return { label: i.imageHeavy ? "mostly scanned images" : "mostly text", scanned: !!i.scanned, imageHeavy: i.imageHeavy, detected: "structural-scan" };
    }
    var pages = Number(i.pages) || 0, size = Number(i.size) || 0;
    if (!pages || !size) return { label: "unknown content", scanned: false, imageHeavy: false, detected: "none" };
    var kbPerPage = (size / 1024) / pages;
    var label = (kbPerPage > 150) ? "mostly scanned images" : (kbPerPage < 20) ? "mostly text" : "mixed text and images";
    return { label: label, scanned: kbPerPage > 150, imageHeavy: kbPerPage > 150, detected: "estimated from file size" };
  }

  /* ── Pre-flight ───────────────────────────────────────────────────────────────────────
     Returns a PLAN. Every field that is a verdict carries the evidence that produced it, and
     any verdict without evidence is literally the string "unknown".

     DECISION ORDER (each rule names the measurement behind it):
       0. structural hard cap exceeded            → unsupported-safely   [ZIP32 uint16 count]
       1. explicit force (a user choosing)        → that mode
       2. deviceMemory ≤ 2 GB                     → low-memory + UNKNOWN memory verdict
       3. within PROVEN[deviceClass][op]          → standard, NO warning  [real devices]
       4. beyond PROVEN but device is a desktop   → standard + "unmeasured" note (nothing in
                                                    the whole matrix ever failed — a warning
                                                    here would be invented)
       5. mobile, beyond mobile-PROVEN, within desktop-PROVEN → low-memory (+ selected-pages
                                                    offer where the tool has a range input)
       6. mobile, beyond desktop-PROVEN too       → desktop-recommended (still runnable)
     UNKNOWN devices (Safari/Firefox phones) take the same path as known phones but never
     receive a memory verdict — `memory.verdict` stays "unknown" and the wording says so. */
  /** Does ONE observed run cover both dimensions of (pages, mb)? Returns the covering run so
      the caller can name it, or null. The AND is inside a single run and the OR is across
      runs — never the other way round, which is how a hull gets mistaken for an observation.
      A `sizeDriven:false` run ignores mb, because the class it describes was measured to. */
  function coveringRun(runs, pages, mb) {
    if (!runs) return null;
    var list = runs.length ? runs : [runs];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r.pages != null && pages > r.pages) continue;
      if (r.sizeDriven && r.mb != null && mb > r.mb) continue;
      return r;
    }
    return null;
  }

  function preflight(input, opClass, opts) {
    opts = opts || {};
    var i = input || {};
    var dev = deviceProfile(opts.device);
    var dc = dev["class"];
    var pages = Number(i.pages) || 0;
    var mb = (Number(i.size) || 0) / (1024 * 1024);
    var type = contentType(i);
    var proven = (PROVEN[dc] && opClass) ? PROVEN[dc][opClass] : null;
    var band = opClass ? BANDS[opClass] : null;
    var cap = opClass ? HARD_CAPS[opClass] : null;
    var rangeTool = !!(opts.tool && RANGE_TOOLS[opts.tool]);

    var mode = "standard";
    var reason = "";
    var cautions = [];
    var memory = { verdict: "unknown", band: null, provenance: null, why: "no memory band has ever been measured on this device class" };

    /* 0 — the only refusal we can prove. */
    var capped = false;
    if (cap && cap.maxEntries && pages > cap.maxEntries) {
      mode = "unsupported-safely"; capped = true;
      reason = cap.why;
    }

    /* Projected ZIP container ceiling — a caution, because the MB/page constant is a fixture
       measurement rather than a format fact. */
    if (!capped && opClass === "raster-export" && pages > 0 &&
        pages * ZIP_MB_PER_PAGE * 1024 * 1024 > ZIP32_MAX_BYTES) {
      cautions.push({ id: "zip32-size", text: "A ZIP this large may not open in every unzip program. Exporting in two or three page ranges avoids it.", source: "pdf-engine.js buildZip ZIP32 uint32 fields + measured 0.1834 MB/page" });
    }

    if (!capped) {
      var provenRun = coveringRun(proven, pages, mb);
      var withinProven = !!provenRun;
      var withinDesktopProven = !!coveringRun(PROVEN.desktop[opClass], pages, mb);

      /* A 2 GB device is outside every band we hold, INCLUDING the desktop one — that band
         came off a 16 GB M4. A low-memory signal therefore suppresses the desktop verdict
         rather than inheriting it. */
      if (dc === "desktop" && band && !dev.lowMemorySignal) {
        memory = { verdict: withinProven ? "within-measured-envelope" : "beyond-measured-envelope",
                   band: { loMB: band.loMB, hiMB: band.hiMB }, provenance: band.provenance,
                   why: withinProven ? "a desktop run of this class at this size completed and was instrumented"
                                     : "larger than anything this class was measured on; nothing failed at the sizes that were" };
      } else if (dc === "mobile" && withinProven && !dev.lowMemorySignal) {
        memory = { verdict: "within-observed-envelope", band: null, provenance: "real devices 2026-08-13",
                   /* Names the single run that covers BOTH dimensions, so the claim can be
                      traced back to a fixture rather than to a rectangle. */
                   why: "both real phones completed this class on " + provenRun.fixture + ", which covers this file's size and page count",
                   coveredBy: provenRun.fixture };
      }

      if (dev.lowMemorySignal) {
        mode = "low-memory";
        reason = "this browser reports a small memory budget, and we have never measured a device like it";
      } else if (withinProven) {
        mode = "standard";
        reason = (dc === "mobile" ? "both real phones completed this operation on " : "this operation was measured completing on ") +
                 provenRun.fixture + ", a single run covering this file's size AND page count";
      } else if (dc === "desktop") {
        mode = "standard";
        reason = "larger than anything we measured — but no desktop run of any size has failed, so there is nothing honest to warn about";
        cautions.push({ id: "beyond-measured", text: "This is larger than any file we have tested. It should run; we cannot promise how long it takes.", source: "oom-matrix-results.md §1 — 20 of 20 runs completed, no failure at any size tested" });
      } else if (withinDesktopProven) {
        mode = rangeTool ? "selected-pages" : "low-memory";
        reason = "beyond what our two test phones ran, still well inside what desktop browsers handled";
      } else {
        mode = "desktop-recommended";
        reason = "beyond every measurement we have, on any device";
      }
    }

    /* Comfort cautions, evidence-backed, never mode-changing. */
    var cl = (CAUTIONS[dc] && opClass) ? CAUTIONS[dc][opClass] : null;
    if (cl && !capped) {
      for (var c = 0; c < cl.length; c++) {
        if (pages > cl[c].overPages) cautions.push({ id: cl[c].id, text: cl[c].text, source: cl[c].source });
      }
    }

    if (opts.force === "low-memory") { mode = "low-memory"; reason = "you chose low-memory mode"; }
    else if (opts.force === "standard" && !capped) { mode = "standard"; reason = "you chose standard mode"; }

    var shape = (mode === "low-memory" || mode === "selected-pages") ? SHAPES.lowMemory : SHAPES.standard;
    var time = capped ? null : estimateSeconds(opClass, pages, mb, dc);

    /* PRECAUTION vs VERDICT — the distinction the wording turns on. A careful shape chosen
       because we have NO evidence is a statement about US; any sentence characterising the
       document as taxing is a claim about the FILE, and we have no measurement supporting one.
       Saying the second when we mean the first is the manufactured fear the real-device
       results exist to prevent. */
    var precaution = (mode === "low-memory" || mode === "selected-pages") &&
                     memory.verdict === "unknown" && !dev.lowMemorySignal && !opts.force;

    return {
      mode: mode,
      precaution: precaution,
      /* Which mode the USER picked, if any. The wording reads this so a chosen mode is
         reported as a choice rather than as a verdict about the document. */
      chosen: (opts.force === "low-memory" || opts.force === "standard") ? opts.force : null,
      lowMemorySignal: dev.lowMemorySignal,
      stub: false,
      /* `calibrated` means: a MEMORY band exists for THIS device class. It is true only for
         desktop, and it is what keeps step 12's registry honest. */
      calibrated: (dc === "desktop" && !!band),
      reason: reason,
      opClass: opClass || null,
      tool: opts.tool || null,
      device: dev,
      memory: memory,
      time: time,
      type: type,
      cautions: cautions,
      offers: {
        /* Not offered where it is already in force: selected-pages carries the low-memory
           shape, so a button promising it would do nothing and read as a broken control. */
        lowMemory: (mode !== "low-memory" && mode !== "selected-pages" && mode !== "unsupported-safely"),
        standard: (mode === "low-memory" && !dev.lowMemorySignal),
        selectedPages: (rangeTool && mode !== "standard"),
        desktop: (mode === "desktop-recommended" || mode === "unsupported-safely")
      },
      blocked: (mode === "unsupported-safely"),
      // execution shape — read by step 4/6 code paths
      batch: shape.batch,
      pageCache: shape.pageCache,
      thumbBand: shape.thumbBand,
      maxCanvasArea: shape.maxCanvasArea,
      previews: shape.previews,
      input: input || null
    };
  }

  /* ── Wording (§3.4 / directive §6, §11) ───────────────────────────────────────────────
     THE LAW THIS CODE ENFORCES: no memory quantity reaches a user. Not "needs 2 GB", not
     "uses about 500 MB", not a device-model claim, not a "works up to N pages" number that
     no run produced. The ONLY byte quantity any of this emits is the FILE'S OWN SIZE, and it
     lives in `facts` — a separate field from `prose` precisely so the test suite can hold
     prose to a zero-quantity rule without also banning the file's own size, which directive
     §11 requires on the pre-processing panel.

     Time expectations appear only where estimateSeconds returned something, and the device
     class that produced the rate travels with them as a title attribute — provenance belongs
     in a tooltip, not in scare copy. */
  var MODE_TEXT = {
    "standard": "Runs normally on this device. Your file stays on your device.",
    /* §3.4's original draft of this line opened by calling the document taxing for the
       browser. DELETED, not routed around — the directive forbids exactly that claim, it
       blames the FILE for a mode WE chose, and it was reachable in one click: the panel's own
       "Use low-memory mode" button sets opts.force, which cleared `precaution` and fell
       through to here, on documents the desktop matrix completed. Rather than add a fourth
       branch in front of a forbidden sentence, the sentence is gone, and test_preflight.mjs
       greps this file to keep it gone. Every low-memory wording now names WHY the mode is on
       and never characterises the document. */
    "low-memory": "Low-memory mode is on: pages are processed in smaller batches and previews are reduced. It will take a little longer.",
    "selected-pages": "You can run this on a page range instead of the whole document — and run it more than once. Low-memory mode is on either way.",
    "desktop-recommended": "This is larger than anything we have tested on a phone for this operation. A desktop browser will do it comfortably. You can still try — your original file is never modified.",
    "unsupported-safely": "This operation cannot produce a valid file at this size, so we are stopping before it starts. Your file has not been changed."
  };
  /* Two honest variants of the same mode. Which one is shown depends on WHY we chose it —
     an absence of evidence and a device telling us it is small are different facts. */
  var LOW_MEM_PRECAUTION = "We have not tested this operation on a phone with a document this size, so low-memory mode is on as a precaution: smaller batches and fewer previews. A little slower, nothing else changes.";
  var LOW_MEM_SIGNAL = "This browser reports a small memory budget, and we have never measured a device like it. Low-memory mode is on: smaller batches and fewer previews. It will take longer.";
  var SELECTED_PRECAUTION = "We have not tested this operation on a phone with a document this size. You can run it on a page range instead of the whole document — as many times as you like. Low-memory mode is on either way.";
  /* The user pressed the button. The honest sentence states the fact and the consequence —
     it does not turn their choice into a judgement about their file. */
  var LOW_MEM_CHOSEN = "You chose low-memory mode: pages are processed in smaller batches and previews are reduced. A little slower, nothing else changes.";
  var UNKNOWN_TEXT = "We have not measured a device like this one, so we cannot promise how it will go. Your original file is never modified, and you can switch to low-memory mode.";
  var PRIVACY_TEXT = "Everything happens on your device. Nothing is uploaded.";

  function fmtDuration(sec) {
    if (sec < 45) return Math.max(5, Math.round(sec / 5) * 5) + " seconds";
    if (sec < 90) return "about a minute";
    if (sec < 3600) return Math.round(sec / 60) + " minutes";
    return Math.round(sec / 360) / 10 + " hours";
  }
  function timeSentence(plan) {
    if (!plan.time) return null;
    var lo = fmtDuration(plan.time.loSec), hi = fmtDuration(plan.time.hiSec);
    return "On the devices we measured, this takes " + (lo === hi ? "about " + lo : lo + " to " + hi) + ".";
  }

  /** The pre-processing panel (directive §11 "Before"): size, pages, detected type, chosen
      mode, privacy. Returns { el, facts, prose } — `prose` is every user-visible sentence
      EXCEPT the file-facts line, and is what the no-memory-quantity test reads. */
  function preflightText(plan) {
    var i = plan.input || {};
    var t = T();
    var sizeStr = (t && t.fmtBytes) ? t.fmtBytes(i.size || 0) : Math.round(((i.size || 0) / 1048576) * 10) / 10 + " MB";
    var pagesStr = (t && t.pluralPages) ? t.pluralPages(i.pages || 0) : (i.pages || 0) + " pages";
    var facts = sizeStr + " · " + pagesStr + " · " + plan.type.label;
    var prose = [];
    var lead = MODE_TEXT[plan.mode] || MODE_TEXT.standard;
    if (plan.mode === "low-memory") {
      /* Order matters: a user's own choice is reported as a choice even on a device that
         also signals, because "you chose this" is the fact nearest to what just happened. */
      lead = plan.chosen === "low-memory" ? LOW_MEM_CHOSEN
           : plan.lowMemorySignal ? LOW_MEM_SIGNAL
           : plan.precaution ? LOW_MEM_PRECAUTION
           : MODE_TEXT["low-memory"];
    } else if (plan.mode === "selected-pages" && plan.precaution) {
      lead = SELECTED_PRECAUTION;
    }
    prose.push(lead);
    if (plan.mode === "unsupported-safely" && plan.reason) prose.push("The limit is not this device: " + plan.reason + ".");
    /* The unknown-device sentence, but only where the lead has not already made the point —
       saying "we have not measured a device like this" twice in three lines reads as a script
       that lost its place, which is how honest copy gets skimmed past. */
    var leadCarriesUnknown = (lead === LOW_MEM_SIGNAL || lead === LOW_MEM_PRECAUTION || lead === SELECTED_PRECAUTION || lead === LOW_MEM_CHOSEN);
    if (!plan.device.known && plan.mode !== "unsupported-safely" && !leadCarriesUnknown) prose.push(UNKNOWN_TEXT);
    for (var c = 0; c < plan.cautions.length; c++) prose.push(plan.cautions[c].text);
    var ts = timeSentence(plan);
    if (ts) prose.push(ts);
    prose.push(PRIVACY_TEXT);
    return { facts: facts, prose: prose, timeProvenance: plan.time ? plan.time.provenance : null };
  }

  /** DOM for the above. `onMode(mode)` is called when the user picks a different mode. */
  function preflightPanel(plan, onMode) {
    if (!HAS_DOM) return null;
    var t = T();
    if (!t || !t.el) return null;
    var txt = preflightText(plan);
    var box = t.el("div", "ubr-preflight msg" + (plan.blocked ? " warn" : ""));
    box.setAttribute("data-mode", plan.mode);
    /* `.msg` is `display:flex` with `align-items:flex-start` and NO direction, i.e. a ROW.
       Dropping stacked <p>s into it is precisely the bug the founder photographed on his
       iPhone on 2026-08-13 — the cancel hint squeezed into a one-word-per-line sliver. The
       column direction is forced here, inline, for the same reason extendPanel() does it:
       theme.css has no ubr rules and this step edits no stylesheet. */
    if (box.style) {
      box.style.flexDirection = "column";
      box.style.alignItems = "stretch";
      box.style.gap = "6px";
      if (!plan.blocked) {
        box.style.background = "var(--surface-2, #F6F6F4)";
        box.style.border = "1px solid var(--line, #E4E4E1)";
      }
    }
    var f = t.el("p", "ubr-pf-facts", txt.facts);
    if (f.style) { f.style.fontWeight = "600"; f.style.margin = "0"; }
    box.appendChild(f);
    for (var i = 0; i < txt.prose.length; i++) {
      var p = t.el("p", "ubr-pf-line", txt.prose[i]);
      if (p.style) { p.style.margin = "0"; p.style.fontWeight = "400"; p.style.opacity = "0.85"; }
      /* Provenance in a title attribute — where a curious user can find it and a worried one
         is not confronted by it. */
      if (txt.timeProvenance && i === txt.prose.length - 2) p.setAttribute("title", "Measured: " + txt.timeProvenance);
      box.appendChild(p);
    }
    if (typeof onMode === "function") {
      var row = t.el("div", "ubr-pf-acts");
      if (row.style) { row.style.marginTop = "4px"; }
      if (plan.offers.lowMemory) {
        var b1 = t.btn ? t.btn("Use low-memory mode", "btn sm") : null;
        if (b1) { b1.type = "button"; b1.onclick = function () { onMode("low-memory"); }; row.appendChild(b1); }
      }
      if (plan.offers.standard) {
        var b2 = t.btn ? t.btn("Use standard mode", "btn sm") : null;
        if (b2) { b2.type = "button"; b2.onclick = function () { onMode("standard"); }; row.appendChild(b2); }
      }
      if (row.children && row.children.length) box.appendChild(row);
    }
    return box;
  }

  /* ── The page plan ────────────────────────────────────────────────────────────────────
     One plan per loaded document, so the config screen (thumbnails), the editor (page cache,
     canvas budget) and the run (batching) all obey the SAME decision instead of three
     independent guesses. Cleared when the page's documents are released. */
  var pagePlanRef = null;
  function setPagePlan(plan) { pagePlanRef = plan || null; return pagePlanRef; }
  function pagePlan(opClass) {
    if (!pagePlanRef) return null;
    if (opClass && pagePlanRef.opClass && pagePlanRef.opClass !== opClass) return null;
    return pagePlanRef;
  }

  /* ── Failure classification ──────────────────────────────────────────────────────────
     CONTRACT RESOLUTION: §1.2 asks the runtime to classify via "an extended humanError()"
     with a new `allocation` branch — and §8 step 2 has ALREADY landed that branch, plus an
     exported isAllocationError() predicate, in pdf-engine.js. So the runtime does NOT carry
     a second copy of that wording: it classifies for its OWN receipt only, defers the
     predicate to T.isAllocationError when present, and hands every user-facing sentence to
     T.humanError. The local regexes are the fallback for a realm without PDFTK (the node
     unit harness) — if they ever disagree with the engine, the engine wins. */
  function classify(e) {
    var s = String((e && e.name) || "") + " " + String((e && e.message) || e || "");
    var t = T();
    if (Cancelled.is(e)) return "cancelled";
    if (t && typeof t.isAllocationError === "function") { if (t.isAllocationError(e)) return "allocation"; }
    else if (/allocation failed|out of memory|Array buffer allocation|failed to allocate|cannot allocate/i.test(s)) return "allocation";
    if (/render timed out|timed out/i.test(s)) return "render-timeout";
    if (/encrypt|password/i.test(s)) return "encrypted";
    if (/Failed to parse PDF|Invalid PDF|Expected instance of PDFDict|damaged/i.test(s)) return "damaged";
    if (/detached ArrayBuffer/i.test(s)) return "detached";
    return "unknown";
  }

  /* The failure panel: which phase failed · the original is untouched (always true — no tool
     writes to its input) · what stopping means for this op. The "safer retry" offer and the
     desktop recommendation from §1.2 are DELIBERATELY ABSENT: both are mode decisions, and
     modes are uncalibrated until §8 step 7. Never "Something went wrong".
     The wording comes from T.humanError; the runtime only adds the phase context and, where
     the engine has not already said it, the original-is-safe sentence (the step-2 allocation
     branch says it itself — saying it twice would read as a script that lost its place). */
  function failureNode(e, kind, phase, cancelLabel) {
    var t = T();
    var wrap = (t && t.el) ? t.el("span") : (HAS_DOM ? document.createElement("span") : null);
    if (!wrap) return null;
    function say(s) { wrap.appendChild(document.createTextNode(s)); }
    if (t && t.humanError) {
      wrap.appendChild(t.humanError(e, phase ? "While " + phase.toLowerCase() : null));
      if (kind !== "allocation") say(" Your original file has not been changed.");
    } else {
      say((phase ? "While " + phase.toLowerCase() + ": " : "") + String((e && e.message) || e) +
          " Your original file has not been changed.");
    }
    if (cancelLabel && cancelLabel.text) say(" " + cancelLabel.text);
    return wrap;
  }

  /* ── The extended progress panel (§4.1) ───────────────────────────────────────────────
     progressPanel() exposes only { el, set(pct,text), done() }. The runtime does not fork it:
     it APPENDS a cancel button and a label line to the existing wrap, once per panel, and
     drives the text through the existing set(). No CSS file is edited in this step, so the
     button uses the existing "btn sm" classes; a dedicated .work-cancel rule lands with the
     step-5 adoption, alongside the indeterminate-bar keyframe used by pulse(). */
  function extendPanel(prog, onCancel) {
    if (!prog || !prog.el) return null;
    var t = T();
    if (prog.__ubr) {                       // already extended — reuse it
      prog.__ubr.wire(onCancel);
      return prog.__ubr;
    }
    if (!t || !t.el) return null;
    var btn = (t.btn ? t.btn("Stop", "btn sm ubr-cancel") : t.el("button", "btn sm ubr-cancel", "Stop"));
    if (btn && btn.setAttribute) btn.setAttribute("type", "button");
    var note = t.el("span", "ubr-note", "");
    /* The note must own a full row. As a plain span in the progress flex row it gets squeezed
       into the leftover sliver — on a 390px iPhone that rendered one word per line down the
       right edge (founder screenshot, 2026-08-13). flex-basis:100% + wrap forces it onto its
       own line under the bar at every width; inline styles because theme.css has no ubr rules. */
    if (prog.el.style) prog.el.style.flexWrap = "wrap";
    if (note.style) {
      note.style.flexBasis = "100%";
      note.style.width = "100%";
      note.style.marginTop = "6px";
      note.style.fontSize = "13px";
      note.style.opacity = "0.75";
    }
    prog.el.appendChild(btn);
    prog.el.appendChild(note);
    var handler = null;
    if (btn.addEventListener) {
      btn.addEventListener("click", function () { if (handler) handler(); });
    }
    var api = {
      btn: btn,
      note: note,
      wire: function (fn) { handler = fn; },
      /* §4.3: where cancellation is impossible the button is DISABLED WITH THE REASON SHOWN,
         never hidden — a control that vanishes reads as a bug, a disabled one with a reason
         is an honest statement about the library. */
      label: function (cancelLabel, disabled, override) {
        note.textContent = override || (cancelLabel ? cancelLabel.text : "");
        btn.disabled = !!disabled;
        btn.hidden = false;
      },
      show: function (on) { btn.hidden = !on; if (!on) note.textContent = ""; }
    };
    api.wire(onCancel);
    prog.__ubr = api;
    return api;
  }

  /* ── State: one run per page (§1.2 mutex) ────────────────────────────────────────────── */
  var current = null;
  var pageLedger = makeLedger();     // survives past a run: window-parked refs (§2.7)

  function active() { return current; }

  /* §2.7's page-level release. Only the runtime's OWN page ledger is emptied here; nulling
     __wbResult / __wbOpenPreview / __wbPreviewState.pdf belongs to the wb.restart + openEditor
     edits in step 6 and is not done from this file. */
  function releasePage() { setPagePlan(null); return pageLedger.releaseAll(); }

  function run(descriptor) {
    var d = descriptor || {};
    if (!d.tool || !d.op || typeof d.body !== "function") {
      return Promise.reject(new Error("UnboundRun.run: tool, op and body are required"));
    }
    if (d.cancel && d.cancel.refuse) {
      return Promise.reject(new Error("UnboundRun.run: '" + d.cancel.id + "' is not an assignable label — nothing here resumes"));
    }
    /* One run per page. §1.2 says a run on a busy page REJECTS immediately (this is the one
       rejection; every actual run outcome — ok, failed, cancelled — RESOLVES with a Result,
       which is what the §1.3 sketch's .then(r => r.status === "ok") requires). */
    if (current) return Promise.reject(new Error("UnboundRun.run: a run is already in flight on this page"));

    var ui = d.ui || {};
    var prog = ui.prog || null;
    var err = ui.err || null;
    var label = d.cancel || (CLASSES[d.op] && CLASSES[d.op].cancel) || CANCEL.RESTART;
    /* The page plan wins over a fresh estimate: it is the one the user was SHOWN, and may
       carry a mode they chose by hand. A fresh preflight() only runs when no document-level
       plan exists (a tool that has not adopted the panel, or a stale cached page). */
    var plan = d.plan || pagePlan(d.op) || preflight(d.input, d.op, { tool: d.tool });
    var ledger = makeLedger();
    var ac = (typeof AbortController !== "undefined") ? new AbortController() : null;

    var t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    var receipt = {
      tool: d.tool, op: d.op, mode: plan.mode, pages: (d.input && d.input.pages) || null,
      bytesIn: (d.input && d.input.size) || null, bytesOut: null, ms: 0,
      phasesSeen: [], cancelledAt: null, outcome: null, deviceHints: deviceHints()
    };

    var cancelled = false;
    var cancelAt = null;
    var settled = false;
    var lastPct = 0;                 // the last HONEST percentage, from a counter only
    var phaseName = null;
    var inFinalRebuild = false;
    var panel = null;

    function setText(pct, text) { if (prog && prog.set) prog.set(pct, text); }

    function markPhase(name) {
      phaseName = name;
      if (receipt.phasesSeen[receipt.phasesSeen.length - 1] !== name) receipt.phasesSeen.push(name);
      if (FINAL_REBUILD_RE.test(name) && !inFinalRebuild) {
        inFinalRebuild = true;
        if (panel) panel.label(CANCEL.REBUILD_FINAL, true);   // disabled + reason, per §4.3
      }
    }

    function doCancel() {
      if (cancelled || settled) return;       // double-cancel and cancel-after-complete: no-ops
      if (inFinalRebuild) return;             // the button is disabled anyway; belt and braces
      cancelled = true;
      cancelAt = phaseName;
      if (ac) { try { ac.abort(); } catch (e) {} }
      if (panel) panel.label(null, true, "Stopping…");
    }

    /* ── ctx: the only surface tool code touches ──────────────────────────────────────
       PROGRESS LAW (§1.2): there is NO set(pct) here and there must never be one. A
       percentage is producible ONLY by step(i, n) from a real counter; everything else is
       phase text or an indeterminate pulse. That is what structurally deletes the 15 fake
       fixed percentages — a tool cannot express one through this API. */
    var ctx = {
      signal: ac ? ac.signal : null,
      plan: plan,

      phase: function (name) {
        markPhase(String(name));
        /* Text only. The bar keeps the last counter-derived width — carrying an honest
           number forward is not the same as inventing one, and the existing panel API
           requires a pct argument on every set(). The indeterminate treatment belongs to
           pulse(). */
        setText(lastPct, String(name) + "…");
      },

      step: function (i, n, label2) {
        var total = Number(n) || 0;
        var at = Number(i) || 0;
        if (total > 0) lastPct = Math.max(0, Math.min(100, Math.round((at / total) * 100)));
        var text = (label2 ? String(label2) + " " : "") + at + (total > 0 ? " of " + total : "");
        if (label2) markPhase(String(label2));
        setText(lastPct, text);
      },

      pulse: function (name) {
        markPhase(String(name));
        /* Indeterminate: no number is asserted. Without the step-5 CSS keyframe the bar simply
           holds its last honest width while the text names what is happening. */
        if (prog && prog.el && prog.el.classList) prog.el.classList.add("ubr-pulse");
        setText(lastPct, String(name) + "…");
      },

      /* Throws synchronously when aborted, so both `ctx.check()` and `await ctx.check()`
         (both spellings appear in the §1.3/§1.4 sketches) behave identically. Returns a
         resolved promise otherwise, so the awaited spelling also yields a microtask. */
      check: function () {
        if (cancelled) throw Cancelled(phaseName);
        return RESOLVED;
      },

      hold: function (value, kind) { return ledger.hold(value, kind); },
      releaseAll: function () { return ledger.releaseAll(); },
      note: function (k, v) { receipt[String(k)] = v; return v; }
    };

    if (prog) {
      panel = extendPanel(prog, doCancel);
      if (panel) panel.label(label, label === CANCEL.REBUILD_FINAL);
      if (prog.set) prog.set(0, "Starting…");
    }
    if (err && err.hide) err.hide();

    var unloadGuard = null;
    if (typeof addEventListener === "function") {
      /* §4.3: a guard, NOT resumability, and it must never be described as one. The editor's
         unsaved-edits half of this guard belongs to step 5. */
      unloadGuard = function (ev) { ev.preventDefault(); ev.returnValue = ""; return ""; };
      addEventListener("beforeunload", unloadGuard);
    }

    function finish(status, out, e) {
      settled = true;
      var t1 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      receipt.ms = Math.round(t1 - t0);
      receipt.outcome = status;
      receipt.cancelledAt = (status === "cancelled") ? (cancelAt || phaseName || null) : null;
      if (out && out.bytes && receipt.bytesOut == null) {
        receipt.bytesOut = (out.bytes.length != null) ? out.bytes.length : (out.bytes.size != null ? out.bytes.size : null);
      }
      /* THE LEDGER RUNS ON ALL THREE EXITS — ok, failed and cancelled alike. */
      ledger.releaseAll();
      if (typeof removeEventListener === "function" && unloadGuard) removeEventListener("beforeunload", unloadGuard);
      if (prog) {
        if (prog.el && prog.el.classList) prog.el.classList.remove("ubr-pulse");
        if (panel) panel.show(false);
        if (prog.done) prog.done();
      }
      current = null;
      return receipt;
    }

    var settle;
    var promise = new Promise(function (res) { settle = res; });

    /* The body is invoked in its own async frame so a synchronous throw inside it is a
       rejected promise like any other, and current is set before it can observe it. */
    current = {
      tool: d.tool, op: d.op, cancel: doCancel, label: label,
      cancelled: function () { return cancelled; },
      promise: promise
    };

    Promise.resolve().then(function () { return d.body(ctx); }).then(function (out) {
      out = out || {};
      if (cancelled) {          // body returned without noticing the abort — honour the intent
        finish("cancelled", null, null);
        if (err && err.show) err.show("Stopped. Nothing was saved and your original file is unchanged.");
        settle({ status: "cancelled", bytes: null, receipt: receipt, verdict: null });
        return;
      }
      var verdict = null;
      if (typeof d.verify === "function") {
        try { verdict = d.verify(out, ctx); }
        catch (ve) { verdict = { ok: false, error: String((ve && ve.message) || ve) }; }
      }
      finish("ok", out, null);
      settle({ status: "ok", bytes: out.bytes || null, filename: out.filename || null, receipt: receipt, verdict: verdict });
    }, function (e) {
      if (Cancelled.is(e) || cancelled) {
        finish("cancelled", null, e);
        if (err && err.show) err.show("Stopped. Nothing was saved and your original file is unchanged.");
        settle({ status: "cancelled", bytes: null, receipt: receipt, verdict: null });
        return;
      }
      var kind = classify(e);
      receipt.failure = kind;
      receipt.failedPhase = phaseName;
      var node = failureNode(e, kind, phaseName, label);
      finish("failed", null, e);
      if (err) {
        if (node && err.show) err.show(node);
        else if (err.showError) err.showError(e);
      }
      if (typeof console !== "undefined" && console.error) console.error("[UnboundRun " + d.tool + "]", e);
      settle({ status: "failed", bytes: null, receipt: receipt, verdict: null, error: e, failure: kind });
    });

    return promise;
  }

  global.UnboundRun = {
    run: run,
    preflight: preflight,
    preflightText: preflightText,
    preflightPanel: preflightPanel,
    setPagePlan: setPagePlan,
    pagePlan: pagePlan,
    deviceProfile: deviceProfile,
    deviceHints: deviceHints,
    estimateSeconds: estimateSeconds,
    contentType: contentType,
    /* Evidence, exported so the registry, the tests and the wording all read ONE source. */
    bands: BANDS,
    proven: PROVEN,
    rates: RATES,
    deviceEvidence: DEVICE_EVIDENCE,
    hardCaps: HARD_CAPS,
    rangeTools: RANGE_TOOLS,
    shapes: SHAPES,
    classes: CLASSES,
    classProvenance: CLASS_PROVENANCE,
    classCalibrated: CLASS_CALIBRATED,
    active: active,
    releasePage: releasePage,
    holdPage: function (v, k) { return pageLedger.hold(v, k); },
    CANCEL: CANCEL,
    Cancelled: Cancelled,
    classify: classify,
    version: 2
  };

})(typeof window !== "undefined" ? window : globalThis);
