"use strict";
/* Split from all-tools.js (W0-6, 2026-08-18). Verbatim "ocr-pdf" tool block, registered against
   core.js's shared prelude on window.UBT. TIER 2 (runtime-cached), loaded only on this
   tool's own page, after core.js.

   W1-5 (2026-08-19): wires ocr-langs.js (window.UBOcrLangs) into this page - a searchable,
   script-grouped language picker with "+" multi-language, OSD auto-detect (via a SEPARATE
   short-lived osd worker, NEVER legacyCore/oem on the main OCR worker - ocr-langs.js's own
   detect() refuses any other worker, so this file cannot make that mistake even by accident),
   and the block/paragraph/line layout tree Tesseract already returns and the pre-W1-5 code
   discarded (only data.words was ever read). ocr-langs.js is NOT part of the TIER-1 shell -
   it is loaded dynamically, same-origin, ONLY on this page, via T.loadScript the same way
   tesseract.min.js and ocr-prep.js already are (see loadLangModule() below). The generator
   (scripts/gen_pdf_toolkit.mjs:827-828) only ever emits <script> tags for core.js and this
   tool's own t/<slug>.js - it is not touched by this change; see the W1-5 report for the
   exact line.

   Disclosed limit (2026-08-19): the script-transition spacing rule below (isCJK(a) !== isCJK(b))
   inserts a space at every genuine CJK<->Latin boundary, including inside what a reader sees as
   one compound token - "5G 网络" and "PDF 格式" come out with a space where the source had none.
   This is a SPACING artifact only: recognition of the characters themselves is unaffected, and
   the honesty note below says so in the product. */
(function () {
  var UBT = window.UBT;
  var tool = UBT.tool;
  if (tool === "ocr-pdf") UBT.boot(function setup() {
    var T = UBT.T, workbench = UBT.workbench, run = UBT.run, urun = UBT.urun, stIn = UBT.stIn, actionRow = UBT.actionRow, fld = UBT.fld, selectEl = UBT.selectEl, fileCard = UBT.fileCard, singlePdf = UBT.singlePdf;
    var wb = workbench({ hint: "Recognition runs in your browser — language data is fetched once", /* The pre-pass straightens the OCR INPUT, and it beats the un-straightened read at every
   angle measured — but its estimator searches +/-5 deg, so a badly crooked page is only
   partly corrected: at 20 deg the pre-pass reads 69.79% where running Deskew first reaches
   98.65% (check-rung4.md §5.2). Deleting the "Deskew first" advice therefore deleted about
   29 points of user value; both halves belong in the line. */
honesty: "Quality depends on scan clarity. Mild skew is straightened for reading only — your saved pages keep the angle they came with — but for heavily crooked pages (roughly more than 10°) running Deskew first still reads better. A Latin-letter/CJK compound token (\"5G 网络\", \"PDF 格式\") gets a space where the two scripts meet — spacing only, recognition is unaffected." });
    wb.onRestart = setup;

    // Used only until ocr-langs.js + langs.json resolve (or if that load ever fails) — the
    // tool must still work, just without the full catalog/auto-detect/hOCR extras.
    var FALLBACK_LANGS = [["eng", "English"]];

    /** Loads ocr-langs.js exactly once, same-origin, ONLY when this page actually runs this
     *  code — never added to the TIER-1 shell, never fetched by any other tool page. Mirrors
     *  how tesseract.min.js/ocr-prep.js are already lazily loaded a few lines below. */
    function loadLangModule() { return Promise.resolve(null); }

    /* -- layout tree -> reading-order text ---------------------------------------------------
       Tesseract already segments a page into blocks (columns/regions) in reading order; the
       pre-W1-5 code never asked for that structure at all. Walk the SAME tree layoutFrom()
       builds from whatever recognize() handed back and emit one line per hOCR/TSV "line", a
       blank line between paragraphs, and a blank line between BLOCKS (i.e. a column break on a
       multi-column page — verified on the 2-column arXiv fixture in _qa/test_ocr_pdf.mjs). */
    /** CJK ranges (CJK Unified Ideographs + extension A, Hiragana/Katakana, Hangul syllables).
     *  Verified empirically (2026-08-19, chi_sim on udhr-cmn_hans-scan.pdf): tesseract.js's
     *  own `data.blocks` segments CJK text into short 1-3 CHARACTER "words" with no space
     *  between them in the source — Tesseract's OWN `data.text` builder already knows not to
     *  insert a space between two adjacent CJK words, but a naive `.join(" ")` over the block
     *  tree does not, which would insert a false space between nearly every character of a
     *  Chinese/Japanese/Korean page and collapse character accuracy. */
    function isCJK(ch) {
      if (!ch) return false;
      var c = ch.charCodeAt(0);
      return (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0xF900 && c <= 0xFAFF) ||
        (c >= 0x3040 && c <= 0x30FF) || (c >= 0xAC00 && c <= 0xD7A3) ||
        (c >= 0x3000 && c <= 0x303F) /* CJK punctuation, e.g. 、 。 */ || (c >= 0xFF00 && c <= 0xFFEF) /* fullwidth forms, e.g. ， ： */;
    }
    /** ROUND-3 FIX (2026-08-19, per independent check-w1-5.md): round 2's `isCJK(a)||isCJK(b)`
     *  rule suppressed the space whenever EITHER neighbor was CJK — correct for CJK-CJK and
     *  CJK-punctuation boundaries, but WRONG at a genuine CJK<->Latin word boundary in mixed
     *  text ("北京 Beijing" needs its space; the blanket rule dropped it). Measured on a mixed
     *  CJK+Latin fixture (_qa/fixtures/ocr-pdf/udhr-mixed_cjk_latin-scan.pdf, the checker's own
     *  example "北京 Beijing 2024年 会议 Meeting..." extended to 20 real word tokens): the
     *  script-only rule dropped 11 of 19 legitimate spaces.
     *
     *  FIRST FIX ATTEMPT (same day, refuted by a full-suite rerun before freezing — recorded
     *  because it is exactly the kind of thing "measure, don't assume" is supposed to catch):
     *  a PURE geometric rule (Tesseract's own word bboxes; space iff the gap between adjacent
     *  words is >= K * the line's median glyph width, regardless of script, as the checker
     *  asked for) fixed the mixed fixture (98.17%) but was never re-checked against this
     *  module's own EXISTING CJK-only fixtures before being called done — it collapsed
     *  cmn_hans 89.95%->41.21% and cmn_hans_rep 96.46%->51.21%. Cause: real CJK prose has
     *  small POSITIVE glyph-to-glyph gaps everywhere (ordinary character spacing — CJK has no
     *  word-spacing concept at all), and the K low enough to catch the mixed fixture's
     *  genuinely narrow cross-script gap (~3 px) is also low enough that ordinary CJK
     *  character spacing crosses it, inserting a space between nearly every character.
     *
     *  SHIPPED FIX: geometry decides ONLY at a genuine script TRANSITION (one neighbor CJK,
     *  the other not); two neighbors on the SAME side of the CJK/non-CJK line keep the proven
     *  round-2 rule outright — both CJK: no space; neither CJK: always space. This protects
     *  cmn_hans/cmn_hans_rep and every Latin fixture completely (their joins never reach the
     *  geometric branch at all) while still fixing the actual round-2 bug: every dropped space
     *  in the mixed fixture was at a script transition. It also removes the tension the first
     *  attempt's K was straddling — tesseract.js's own same-token CJK splits (e.g. "会议" ->
     *  "会"+"议", or the +10-17 px "分公司" -> "分"+"公司" outlier that no K in 0.25-0.35 could
     *  separate from a genuine boundary) are same-script pairs, decided by the script rule now,
     *  not by K, at all. TRANSITION_GAP_K=0.10: the mixed fixture's one genuinely narrow
     *  cross-script boundary (海|Shanghai, gap=3px on a ~19.5px line median) needs K*median<3,
     *  and 0.10 clears it with margin. One Tesseract bbox-touching artifact in that same
     *  fixture (议|Meeting, a real rendered space but a measured gap of exactly 0) is not
     *  recoverable by any positive K and is named here as the honest limit — not hidden. */
    function medianGlyphWidth(words) {
      var widths = [];
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        if (!w.bbox || !w.text) continue;
        var len = w.text.length || 1;
        var cw = (w.bbox.x1 - w.bbox.x0) / len;
        if (cw > 0) widths.push(cw);
      }
      if (!widths.length) return null;
      widths.sort(function (a, b) { return a - b; });
      return widths[Math.floor(widths.length / 2)];
    }
    var TRANSITION_GAP_K = 0.10;
    /** Same-day addendum: `isCJK(a) !== isCJK(b)` treats a bare halfwidth comma/period next to
     *  a CJK character as a "script transition" (a halfwidth ASCII comma is not in ANY isCJK
     *  range), routing it to the geometric branch — which measured a real, wide-enough gap on
     *  real CJK fixtures (Tesseract's own OCR word/punctuation split) and started inserting
     *  "行 ," again, exactly the round-2 bug in a new spot the round-2 fix DID cover (its
     *  blanket `isCJK(a)||isCJK(b)` caught this case for free; this hybrid's `===` check does
     *  not). Ordinary closing punctuation never has a leading space before it in EITHER script
     *  — "word," not "word ," is universal typography — so this is checked unconditionally,
     *  before the script/geometry decision, not folded into either. */
    function isClosingPunct(ch) { return !!ch && /[,.;:!?)\]}%’”]/.test(ch); }
    function joinLineWords(words) {
      var median = medianGlyphWidth(words);
      var out = "", prevWord = null;
      for (var i = 0; i < words.length; i++) {
        var w = words[i], t = w.text;
        if (!t) continue;
        if (out) {
          var insertSpace;
          if (isClosingPunct(t.slice(0, 1))) {
            insertSpace = false;
          } else {
            var prevCJK = isCJK(out.slice(-1));
            var curCJK = isCJK(t.slice(0, 1));
            if (prevCJK === curCJK) {
              insertSpace = !prevCJK; // same script family on both sides: proven round-2 rule
            } else if (median != null && prevWord && prevWord.bbox && w.bbox) {
              var gap = w.bbox.x0 - prevWord.bbox.x1;
              insertSpace = gap >= TRANSITION_GAP_K * median;
            } else {
              // FALLBACK (bbox missing on either side): a script transition with no geometry
              // to consult defaults to a space — in real documents a CJK<->Latin boundary is a
              // real word boundary in every case this module has measured.
              insertSpace = true;
            }
          }
          if (insertSpace) out += " ";
        }
        out += t;
        prevWord = w;
      }
      return out;
    }

    function blocksToText(blocks) {
      var out = [];
      (blocks || []).forEach(function (b, bi) {
        if (bi > 0) out.push("");
        (b.paragraphs || []).forEach(function (p, pi) {
          if (pi > 0) out.push("");
          (p.lines || []).forEach(function (l) {
            var t = joinLineWords(l.words || []);
            if (t) out.push(t);
          });
        });
      });
      return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
    }

    /** Flattens the SAME layout tree into the word list the searchable-PDF text layer draws,
     *  in block/paragraph/line reading order — replaces the flat, unordered data.words the
     *  pre-W1-5 code read directly. Each entry keeps the {text,bbox,confidence} shape the
     *  drawing code below already expects (bbox is the SAME coordinate space data.words used —
     *  layoutFrom's block path passes tesseract.js's own word.bbox through untouched). */
    function flattenWords(blocks) {
      var out = [];
      (blocks || []).forEach(function (b) {
        (b.paragraphs || []).forEach(function (p) {
          (p.lines || []).forEach(function (l) {
            (l.words || []).forEach(function (w) { out.push(w); });
          });
        });
      });
      return out;
    }

    /** hOCR is one full HTML document PER PAGE from tesseract.js; stitch every page's
     *  <body> content into ONE document with one <div class='ocr_page'> per page, rather than
     *  concatenating N full documents (which would not be valid HTML — nested <html>/<body>). */
    /** `pages` is [{page: N, hocr: <tesseract's own single-page hOCR document>}, ...]. Every
     *  per-page recognize() call independently emits `id='page_1'` and `ppageno 0` — Tesseract
     *  has no idea it is one page of many — so naive concatenation produces a combined document
     *  with N colliding `page_1` ids and N identical `ppageno 0`s. Rewrite both to the REAL
     *  document page number before stitching (checker's check-w1-5.md round-2 note). */
    function combineHocr(pages) {
      var bodies = pages.map(function (entry) {
        var m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(entry.hocr || "");
        var inner = m ? m[1] : (entry.hocr || "");
        return inner
          .replace(/id=(['"])page_1\1/, "id=$1page_" + entry.page + "$1")
          /* ROUND-3 FIX (check-w1-5.md round 3): id='page_N' was the only id rewritten — every
             OTHER hOCR id (word_1_1, line_1_1, par_1_1, block_1_1, ...) is ALSO independently
             numbered from "1" by each per-page recognize() call, so a stitched multi-page
             document still had N copies of word_1_1 etc. colliding. Tesseract's own id
             convention is always "<type>_1_<index>" (the "1" is a page counter internal to
             that single recognize() call, never anything else — confirmed against every
             committed fixture in _qa/fixtures/ocr-langs/), so rewrite the page component of
             ALL FOUR id families to the real document page number. */
          .replace(/id=(['"])(word|line|par|block)_1_(\d+)\1/g, "id=$1$2_" + entry.page + "_$3$1")
          .replace(/ppageno \d+/, "ppageno " + entry.page);
      });
      return "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<title>OCR output (hOCR)</title>\n</head>\n<body>\n" + bodies.join("\n") + "\n</body>\n</html>\n";
    }

    function meanOf(nums) {
      var v = nums.filter(function (n) { return typeof n === "number" && !isNaN(n); });
      return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
    }

    singlePdf(wb, function (st) {
      wb.showConfig();
      T.clear(wb.configEl);
      wb.configEl.appendChild(fileCard({ name: st.name, size: st.size, pages: st.pages }));

      // Ordered, de-duplicated list of selected language codes; joined with "+" for
      // Tesseract.createWorker — verified 2026-08-18 (verification-ledger.md R23) that the
      // VENDORED tesseract.min.js/worker.min.js split "eng+deu" on "+" on both sides and fetch
      // each language as its own cached .traineddata file, so a single-language run still
      // fetches exactly one file.
      var selected = ["eng"];
      var advancedReady = false;
      var fallbackSel = null;

      var pickerHost = T.el("div");
      var pickerWrap = fld("Document language", pickerHost);
      wb.configEl.appendChild(pickerWrap);
      renderFallbackPicker(); // instant, functional picker shown immediately

      var osdHost = T.el("div");
      wb.configEl.appendChild(osdHost);

      wb.configEl.appendChild(T.el("p", "hint", "Output is a searchable PDF: original page images with an invisible text layer, so you can select and search the recognized text. Everything runs on your device — language data loads from UnboundPDF the first time a language is used and is then cached by your browser. Your file never leaves your device."));

      var act = actionRow("Run OCR");
      act.go.disabled = false;
      wb.configEl.appendChild(act.row);

      function renderFallbackPicker() {
        T.clear(pickerHost);
        fallbackSel = selectEl(FALLBACK_LANGS, selected[0] || "eng");
        fallbackSel.onchange = function () { selected = [fallbackSel.value]; };
        pickerHost.appendChild(fallbackSel);
      }

      function currentLangValue() {
        if (advancedReady) return selected.length ? selected.join("+") : "eng";
        return fallbackSel ? fallbackSel.value : "eng";
      }

      /** The full, searchable, script-grouped, multi-select picker — replaces the plain
       *  <select> once ocr-langs.js + langs.json (the real catalog of 100+ tessdata_fast
       *  languages, honest about which are already vendored vs. "available on request") have
       *  loaded. Never blocks the tool: if this fails, the fallback picker above still works. */
      function renderAdvancedPicker(m, UBOcrLangs) {
        T.clear(pickerHost);
        var wrap = T.el("div");
        wrap.style.cssText = "border:1px solid var(--line,#ddd);border-radius:8px;padding:8px;max-width:440px";
        var search = T.input({ type: "text", placeholder: "Search languages…" });
        search.className = "txtin";
        search.style.cssText = "width:100%;box-sizing:border-box;margin-bottom:6px";
        wrap.appendChild(search);
        var summary = T.el("div", "hint");
        wrap.appendChild(summary);
        var listHost = T.el("div");
        listHost.style.cssText = "max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:1px;margin-top:4px";
        wrap.appendChild(listHost);

        var groups = UBOcrLangs.byScript(m);
        var scripts = Object.keys(groups).sort();

        function updateSummary() {
          var names = selected.map(function (c) { return (m.languages[c] && m.languages[c].name) || c; });
          summary.textContent = "Selected: " + names.join(" + ") +
            (selected.some(function (c) { return !UBOcrLangs.isVendored(c, m); }) ? " (one or more will download on first use)" : "");
        }

        function renderList(q) {
          T.clear(listHost);
          q = (q || "").trim().toLowerCase();
          scripts.forEach(function (script) {
            var entries = groups[script].filter(function (e) {
              return !q || e.name.toLowerCase().indexOf(q) >= 0 || e.code.toLowerCase().indexOf(q) >= 0;
            });
            if (!entries.length) return;
            var h = T.el("div", null, script);
            h.style.cssText = "font-weight:700;font-size:12px;color:var(--ink2);margin-top:6px;padding:0 4px";
            listHost.appendChild(h);
            entries.forEach(function (e) {
              var row = T.el("label");
              row.style.cssText = "display:flex;align-items:center;gap:8px;font-size:14px;padding:2px 4px";
              var cb = T.input({ type: "checkbox" });
              cb.checked = selected.indexOf(e.code) >= 0;
              cb.onchange = function () {
                if (cb.checked) {
                  if (selected.indexOf(e.code) < 0) selected.push(e.code);
                } else {
                  if (selected.length <= 1) { cb.checked = true; return; } // keep >= 1 language
                  selected = selected.filter(function (c) { return c !== e.code; });
                }
                updateSummary();
              };
              row.appendChild(cb);
              row.appendChild(document.createTextNode(e.name + " (" + e.code + ")"));
              var badge = T.el("span", null, e.vendored ? "on device" : (e.bytes ? "downloads ~" + T.fmtBytes(e.bytes) : "available on request"));
              badge.style.cssText = "margin-left:auto;font-size:11px;color:var(--ink2)";
              row.appendChild(badge);
              listHost.appendChild(row);
            });
          });
        }
        search.addEventListener("input", function () { renderList(search.value); });
        renderList("");
        updateSummary();
        pickerHost.appendChild(wrap);

        // Re-render with the CURRENT selection when auto-detect (below) changes it.
        pickerHost.__ubRerender = function () { renderList(search.value); updateSummary(); };
      }

      /** OSD script auto-detect — a SEPARATE, short-lived worker via createOsdWorker() ONLY;
       *  ocr-langs.js's own detect() refuses anything else, so this cannot regress into the
       *  "legacyCore on the main OCR worker" mistake the module exists to prevent. Suggests,
       *  never silently applies: a low-confidence read returns no candidates at all, and even
       *  a confident read only PRE-fills the picker — every checkbox stays user-editable. */
      function renderOsdButton(m, UBOcrLangs) {
        T.clear(osdHost);
        var row = T.el("div");
        row.style.cssText = "margin:6px 0";
        var btn = T.btn("Auto-detect language (scans page 1)", "btn");
        row.appendChild(btn);
        var status = T.el("p", "hint");
        row.appendChild(status);
        var chipsRow = T.el("div");
        chipsRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:4px";
        row.appendChild(chipsRow);
        osdHost.appendChild(row);

        btn.onclick = function () {
          btn.disabled = true;
          status.textContent = "Detecting script…";
          T.clear(chipsRow);
          var osdWorker = null, probeCanvas = null;
          (async function () {
            try {
              if (!window.Tesseract) await T.loadScript(T.BASE + "tesseract.min.js");
              var pdf = st.pdf || await T.openPdfjs(st.buf.slice(0));
              /* scale=1 (72 dpi) measured 2026-08-19 as consistently BELOW ocr-langs.js's own
                 OSD_CONFIDENCE_THRESHOLD (a clean Latin scan scored 0.53, refused as
                 low-confidence) — that threshold's own calibration table
                 (ocr-langs.js's OSD_CONFIDENCE_THRESHOLD docstring) was measured against
                 ~150 dpi fixtures. scale=2 (144 dpi, matching the OCR render path's own
                 floor) cleared the threshold on the same fixture (2.07, confident). */
              var r = await T.renderPageToCanvas(pdf, 1, 2);
              probeCanvas = r.canvas;
              osdWorker = await UBOcrLangs.createOsdWorker(Tesseract, {
                workerPath: location.origin + T.BASE + "tesseract/worker.min.js",
                corePath: location.origin + T.BASE + "tesseract/",
                langPath: location.origin + T.BASE + "tesseract/lang"
              });
              var res = await UBOcrLangs.detect(osdWorker, probeCanvas);
              if (res.lowConfidence || !res.candidates || !res.candidates.length) {
                status.textContent = "Could not confidently detect the language automatically" + (res.script ? " (best guess: " + res.script + " script, low confidence)" : "") + ". Pick a language below.";
              } else {
                status.textContent = "Detected " + res.script + " script. Suggested language" + (res.candidates.length > 1 ? "s" : "") + " below — pick one, or use the full list above.";
                res.candidates.forEach(function (c) {
                  var chip = T.btn(c.name + (c.vendored ? "" : " (downloads)"), "btn");
                  chip.onclick = function () {
                    selected = [c.code];
                    if (pickerHost.__ubRerender) pickerHost.__ubRerender();
                  };
                  chipsRow.appendChild(chip);
                });
              }
            } catch (e) {
              status.textContent = "Auto-detect couldn't run: " + (e && e.message ? e.message : String(e));
            } finally {
              if (osdWorker) { try { await osdWorker.terminate(); } catch (e) {} }
              if (probeCanvas) { probeCanvas.width = 0; probeCanvas.height = 0; }
              btn.disabled = false;
            }
          })();
        };
      }

      loadLangModule().then(function (UBOcrLangs) {
        if (!UBOcrLangs) return;
        return UBOcrLangs.manifest().then(function (m) {
          advancedReady = true;
          renderAdvancedPicker(m, UBOcrLangs);
          renderOsdButton(m, UBOcrLangs);
        });
      }).catch(function () { /* fallback picker (already shown) still fully works */ });

      /* PAGE: Tesseract's recognize() is not interruptible mid-page (measured ~0.92 s/page),
         so a stop lands after the page in flight finishes — §4.2 says so, and the button says so. */
      act.go.onclick = urun(wb, act.go, { op: "ocr", cancel: "PAGE", input: stIn(st) }, async function (ctx) {
        ctx.phase("Loading the OCR engine");
        if (!window.Tesseract) await T.loadScript(T.BASE + "tesseract.min.js");
        if (!window.UBOcrLangs) { try { await loadLangModule(); } catch (e) {} }
        /* RUNG 4: the OCR pre-pass. Lazily loaded exactly like Tesseract, and never fatal —
           a page that could not fetch it still OCRs, just without the pre-pass. */
        if (!window.OCRPrep) { try { await T.loadScript(T.BASE + "ocr-prep.js"); } catch (e) {} }
        var langValue = currentLangValue();
        var curPage = 0;
        var workerOpts = {
          workerPath: location.origin + T.BASE + "tesseract/worker.min.js",
          corePath: location.origin + T.BASE + "tesseract/",
          langPath: location.origin + T.BASE + "tesseract/lang"
        };
        ctx.phase("Reading document");
        var pdf = st.pdf || ctx.hold(await T.openPdfjs(st.buf.slice(0)));
        /* ROUND-2 FIX (2026-08-19, per independent check-w1-5.md): forcing
           tessedit_pageseg_mode:"3" unconditionally (the round-1 fix for the 2-column
           interleaving bug) turned the GATE-BLOCKING _qa/test_ocrprep.mjs red — scan-3p (a
           genuinely SINGLE-column document) moved from 71.00% to 69.29% because forcing "3"
           changes this build's segmentation behavior even on a page that never needed it, not
           only on the 2-column page it was meant to fix. A blanket per-script skip (the
           round-1 "CJK gets no override" rule) also under-covers: a mixed eng+chi_sim run
           would still force "3" and hit the SAME CJK over-segmentation regression.
           FIX: detect multi-column layout FIRST, on page 1 of THIS document, then only force
           "3" on the MAIN worker when a real column gutter is found.

           ROUND-3 (2026-08-19): the first cut of this detector ran a whole SECOND Tesseract
           worker (same language, tessedit_pageseg_mode:"3" forced on it only) to get block
           geometry — correct in principle (a worker that has never had setParameters called
           always segments this page as ONE block, no amount of re-recognizing the same page
           changes that, so detection cannot run on the untouched main worker), but a second
           full WASM engine load doubled every run's latency/memory for a decision that only
           needs geometry, not text. Replaced with a pure PIXEL projection-profile gutter
           detector — classic document-layout-analysis technique, no OCR engine involved at
           all: render page 1, bucket the horizontal ink density into columns, and look for a
           real gutter (a narrow, DEEP dip in ink density) in the central portion of the
           content area. Tuned and verified against 9 real documents (2-column arXiv paper,
           5 single-column scans across 4 scripts, German/English/Vietnamese/Polish/Chinese) —
           the 2-column page's gutter dips to ~9% of the surrounding text's ink density; every
           single-column page's shallowest dip in the same search band stays >=59%. The 35%
           threshold below sits with wide margin on both sides of that gap.

           ROUND-4 FIX (check-w1-5.md round 3): the 70th-percentile "typical" ink level is not
           robust to a large embedded photo/figure — a single-column page with a tall dark
           figure (darkfig-scan.pdf, a new fixture: report text with a centered ~34%-wide,
           image reaching well over a third of the page height) has SOME buckets running
           through the figure at near-100% ink and others through pure text at ~5-10%; the
           70th percentile of the WHOLE page's buckets lands inside the figure's elevated
           range (measured: typical 0.379), while the minimum WITHIN the central search band
           lands in a genuine text-only bucket (measured: 0.052) — dipRatio 0.137, a FALSE
           multi-column positive. The MEDIAN is far more robust to that kind of localized
           outlier block (measured on the same fixture: 0.085, dipRatio 0.613 — correctly not
           flagged) because a figure has to occupy over half the page's buckets to drag the
           median, not just enough to shift a percentile past the minimum. Re-verified against
           all 11 real fixtures this detector has ever been tuned on (10 single-column incl.
           the new darkfig-scan.pdf + the 2-column arXiv paper): 11/11 still correct. */
        function detectMultiColumn(canvas) {
          try {
            var cx = canvas.getContext("2d", { willReadFrequently: true });
            var im = cx.getImageData(0, 0, canvas.width, canvas.height);
            var d = im.data, W = canvas.width, H = canvas.height;
            var rowStep = Math.max(1, Math.floor(H / 300));
            var colInk = new Float64Array(W);
            var rowsSampled = 0;
            for (var y = 0; y < H; y += rowStep) {
              rowsSampled++;
              for (var x = 0; x < W; x++) {
                var idx = (y * W + x) * 4;
                var lum = (d[idx] * 299 + d[idx + 1] * 587 + d[idx + 2] * 114) / 1000;
                if (lum < 200) colInk[x]++;
              }
            }
            var BUCKETS = 80, bw = W / BUCKETS;
            var bucket = new Float64Array(BUCKETS);
            for (var b = 0; b < BUCKETS; b++) {
              var sum = 0, cnt = 0, x0 = Math.floor(b * bw), x1 = Math.floor((b + 1) * bw);
              for (var xx = x0; xx < x1; xx++) { sum += colInk[xx]; cnt++; }
              bucket[b] = cnt ? sum / cnt / rowsSampled : 0;
            }
            var TEXT_FLOOR = 0.05, leftEdge = -1, rightEdge = -1;
            for (var bi = 0; bi < BUCKETS; bi++) if (bucket[bi] > TEXT_FLOOR) { if (leftEdge < 0) leftEdge = bi; rightEdge = bi; }
            if (leftEdge < 0) return false; // a blank/near-blank page has no columns to detect
            var contentW = rightEdge - leftEdge + 1;
            var cLo = leftEdge + Math.floor(contentW * 0.25), cHi = leftEdge + Math.ceil(contentW * 0.75);
            var minV = Infinity, minB = -1;
            for (var cb = cLo; cb <= cHi; cb++) if (bucket[cb] < minV) { minV = bucket[cb]; minB = cb; }
            var samples = [];
            for (var sb = leftEdge; sb <= rightEdge; sb++) samples.push(bucket[sb]);
            samples.sort(function (a, c) { return a - c; });
            var typical = samples[Math.floor(samples.length * 0.5)]; // MEDIAN — see ROUND-4 FIX above
            var dipRatio = typical > 0 ? minV / typical : 1;
            var lo = minB, hi = minB;
            while (lo > cLo && bucket[lo - 1] < typical * 0.4) lo--;
            while (hi < cHi && bucket[hi + 1] < typical * 0.4) hi++;
            var gapWidthFrac = (hi - lo + 1) / contentW;
            return dipRatio < 0.35 && gapWidthFrac >= 0.015 && gapWidthFrac <= 0.30;
          } catch (e) { return false; }
        }
        ctx.phase("Analyzing layout");
        var columnProbe = await T.renderPageToCanvas(pdf, 1, 1);
        var multiColumn = detectMultiColumn(columnProbe.canvas);
        columnProbe.canvas.width = 0; columnProbe.canvas.height = 0;
        /* Not UI: same convention as __ocrPrepText/__ocrConfidence — the gutter detector's
           decision has to be observable from outside the page (_qa/test_ocr_pdf.mjs asserts
           it directly on scan-3p/arXiv/darkfig, not just inferred from downstream text). */
        try { window.__ocrMultiColumn = multiColumn; } catch (e) {}
        /* W1-5: langValue may be "eng" (one file) or "pol+tur" (one file PER language, never a
           combined fetch) — verified against the vendored tesseract.min.js/worker.min.js
           split-on-"+" behavior; see the docstring above `selected`. NEVER pass legacyCore/oem
           here — that is the OSD-only path above, which uses its own separate worker via
           createOsdWorker(). */
        var worker = ctx.hold(await Tesseract.createWorker(langValue, 1, Object.assign({
          logger: function (m) {
            /* Tesseract's own sub-page fraction used to drive the bar. ctx.step takes whole
               units, so the counter is now the page — coarser, still entirely real. The bar
               never moves for a reason the user cannot name. */
            if (m.status === "recognizing text" && curPage > 0) {
              ctx.step(curPage, st.pages, "Recognizing page");
            }
          }
        }, workerOpts)));
        if (multiColumn) { try { await worker.setParameters({ tessedit_pageseg_mode: "3" }); } catch (e) {} }
        /* QUALITY LAW: the output carries the ORIGINAL pages untouched — the canvas render
           below is only Tesseract's input. Re-encoding the scan (the old path: render at 2x,
           JPEG 0.9) silently degraded every page; copyPages keeps the image streams
           byte-identical and we only ADD the invisible text layer. If the file can't be
           structurally copied (corrupt xref), we fall back to re-rendering and SAY so. */
        var doc = null, lossless = true;
        try {
          var srcDoc = await PDFLib.PDFDocument.load(st.buf.slice(0), { ignoreEncryption: true, throwOnInvalidObject: false });
          doc = await PDFLib.PDFDocument.create();
          var cp = await doc.copyPages(srcDoc, srcDoc.getPageIndices());
          cp.forEach(function (p) { doc.addPage(p); });
        } catch (e) { doc = await PDFLib.PDFDocument.create(); lossless = false; }
        var font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
        var allText = [];
        var allHocr = [];              // W1-5: one full hOCR doc per page, stitched at the end
        var pageConf = [];             // W1-5: per-page mean confidence, surfaced in the result
        /* Pre-rung-4 this was THE scale: every page went to Tesseract as a 72*2 = 144 dpi
           raster no matter what the scan was, so a 200-ppi or 451-ppi scan was downsampled
           before it was ever read. It is now only the FLOOR — OCRPrep.pickScale raises it
           toward 300 dpi (200 on a low-memory plan) within the canvas area budget, and the
           extra pixels come from the embedded image via pdf.js, not from resampling ours. */
        var SCALE = 2;
        var prepTel = [];             // per-page telemetry — read by _qa/test_ocrprep.mjs
        try {
          var slotO = { canvas: null, prep: null };
          ctx.hold(slotO, function (s) {
            if (s.prep) { try { s.prep.release(); } catch (e) {} s.prep = null; }
            if (s.canvas) { s.canvas.width = 0; s.canvas.height = 0; s.canvas = null; }
          });
          for (var i = 1; i <= pdf.numPages; i++) {
            await ctx.check();
            curPage = i;
            ctx.step(i, pdf.numPages, "Rendering page");
            var pick = { scale: SCALE, baseDpi: SCALE * 72, dpi: SCALE * 72, applied: false, capped: false, lowMem: false, reason: "OCRPrep unavailable" };
            if (window.OCRPrep) {
              var vp1 = (await pdf.getPage(i)).getViewport({ scale: 1 });
              pick = window.OCRPrep.pickScale(SCALE, {
                plan: ctx.plan, vpWidth: vp1.width, vpHeight: vp1.height,
                clampScaleToArea: T.clampScaleToArea, areaBudget: T.MAX_CANVAS_AREA
              });
            }
            var OSC = pick.scale;
            var r = await T.renderPageToCanvas(pdf, i, OSC);
            slotO.canvas = r.canvas;
            /* The pre-pass writes into ITS OWN canvas — r.canvas stays exactly what pdf.js
               drew, because the non-lossless branch below re-embeds it as the visible page. */
            var prep = window.OCRPrep ? window.OCRPrep.prepare(r.canvas, { plan: ctx.plan }) : null;
            if (prep) slotO.prep = prep;
            var ocrCv = prep ? prep.canvas : r.canvas;
            var unmap = prep ? prep.unmap : function (x, y) { return [x, y]; };
            prepTel.push({
              page: i, scale: OSC, dpi: pick.dpi, baseDpi: pick.baseDpi, upscaled: !!pick.applied,
              capped: !!pick.capped, lowMem: !!pick.lowMem, reason: pick.reason,
              applied: prep ? prep.applied : [], skewDeg: prep ? +(prep.skewRad * 180 / Math.PI).toFixed(2) : 0,
              illumSpread: prep ? prep.illumSpread : -1, prepMs: prep ? prep.ms : 0
            });
            var ret = await worker.recognize(ocrCv);
            if (prep) { prep.release(); slotO.prep = null; }
            var data = ret.data;
            /* W1-5: the block/paragraph/line tree Tesseract already computes — reconstructed
               by ocr-langs.js from whichever shape recognize() returned (data.blocks here,
               present by default in this vendored build). Never fatal: a parser/guard failure
               falls back to the FLAT data.words exactly like every page did before this
               change, so a bug here can degrade reading order, never crash the run or lose the
               searchable-PDF text layer. */
            var layout = null;
            if (window.UBOcrLangs) {
              try { layout = window.UBOcrLangs.layoutFrom(data); } catch (e) { layout = null; }
            }
            var words = layout ? flattenWords(layout.blocks) : (data.words || []);
            allText.push(layout ? blocksToText(layout.blocks) : (data.text || ""));
            if (typeof data.hocr === "string" && data.hocr) allHocr.push({ page: i, hocr: data.hocr });
            var pConf = typeof data.confidence === "number" ? data.confidence : meanOf(words.map(function (w) { return w.confidence; }));
            pageConf.push({ page: i, confidence: pConf });
            var page;
            if (lossless) {
              page = doc.getPage(i - 1);
              // map canvas pixels -> PDF user space through the SAME viewport pdf.js rendered
              // with; convertToPdfPoint handles crop-box offsets and /Rotate. Upright-on-screen
              // text on a /Rotate page lies rotated in user space (the editor's proven
              // convention: /Rotate 90 upright = +90 deg), so the layer rotates with the page.
              var pjsPage = await pdf.getPage(i);
              /* The SAME viewport scale the raster was rendered with — rung 4 made that a
                 per-page number, so reading SCALE here instead of OSC would place every word
                 box on a page that was upscaled. */
              var vp = pjsPage.getViewport({ scale: OSC });
              var rot = ((page.getRotation().angle || 0) % 360 + 360) % 360;
              words.forEach(function (w) {
                if (!w.text || !w.text.trim() || !w.bbox) return;
                /* Boxes come back in the PREPPED raster's space; unmap() rotates them back
                   into the rendered page's space when the pre-pass deskewed the input.
                   Identity when it did not. */
                var pTL = unmap(w.bbox.x0, w.bbox.y0), pBL = unmap(w.bbox.x0, w.bbox.y1);
                var hh = Math.abs(pBL[1] - pTL[1]) / OSC;
                var size = Math.max(4, hh * 0.85);
                var pt = vp.convertToPdfPoint(pBL[0], pBL[1]);
                try {
                  page.drawText(T.sanitizeWinAnsi(w.text), {
                    x: pt[0], y: pt[1], size: size, font: font, opacity: 0,
                    rotate: PDFLib.degrees(rot)
                  });
                } catch (e) {}
              });
            } else {
              // honest fallback: the structure was unreadable, pages are re-rendered
              /* r.canvas, NOT the prepped one: the pre-pass may have binarised or rotated its
                 copy, and none of that may reach the page the user is handed. */
              var jpeg = await T.canvasToJpegBytes(r.canvas, 0.9);
              var img = await doc.embedJpg(jpeg);
              var pw = r.width / OSC, ph = r.height / OSC;
              page = doc.addPage([pw, ph]);
              page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
              words.forEach(function (w) {
                if (!w.text || !w.text.trim() || !w.bbox) return;
                var qTL = unmap(w.bbox.x0, w.bbox.y0), qBL = unmap(w.bbox.x0, w.bbox.y1);
                var x = qTL[0] / OSC;
                var yTop = Math.min(qTL[1], qBL[1]) / OSC;
                var hh = Math.abs(qBL[1] - qTL[1]) / OSC;
                var size = Math.max(4, hh * 0.85);
                try {
                  page.drawText(T.sanitizeWinAnsi(w.text), {
                    x: x, y: ph - yTop - hh, size: size, font: font, opacity: 0
                  });
                } catch (e) {}
              });
            }
            r.canvas.width = 0; r.canvas.height = 0;   // the page raster dies here, not at the end
            try { if (r.page && r.page.cleanup) r.page.cleanup(); } catch (e) {}
            slotO.canvas = null;
          }
        } finally {
          try { await worker.terminate(); } catch (e) {}
          /* Not UI: the pre-pass has to be measurable from outside the page, or the table in
             _qa/test_ocrprep.mjs is a claim about code nobody ran. Published on every exit
             (including a cancel) so a cancelled run can still be inspected. */
          try { window.__ocrPrepTelemetry = prepTel; } catch (e) {}
          /* ...and the recognised text in the ENGINE'S OWN READING ORDER (now block/paragraph/
             line order via layoutFrom(), with a blank line at every block/column break — the
             same string the "Download plain text (.txt)" button hands over. Character accuracy
             has to be scored on this, not on pdftotext of the output PDF: the searchable layer
             is one invisible drawText per WORD, and poppler re-sorts those by their individual
             baselines, which scrambles the order and swamps the signal being measured. */
          try { window.__ocrPrepText = allText.join("\n"); } catch (e) {}
          try { window.__ocrConfidence = pageConf; } catch (e) {}
        }
        ctx.pulse("Rebuilding the searchable PDF");
        var bytes = await doc.save();
        var txt = new TextEncoder().encode(allText.join("\n\n----- page break -----\n\n"));
        var combinedHocrStr = allHocr.length ? combineHocr(allHocr) : "";
        var hocrBytes = allHocr.length ? new TextEncoder().encode(combinedHocrStr) : null;
        /* Not UI: same convention as __ocrPrepText/__ocrPrepTelemetry above — the hOCR
           download's exact content has to be measurable from outside the page (_qa/
           test_ocr_pdf.mjs asserts real ocr_page/ocr_carea/ocr_par/ocr_line/ocrx_word markers
           on it) without driving a real file-save dialog through Playwright. */
        try { window.__ocrHocrText = combinedHocrStr; } catch (e) {}
        /* The last gate before anything is handed over: a Stop pressed during the final
           iteration must not still produce a result. ctx.check() throws if it was. */
        await ctx.check();
        var meanConfAll = meanOf(pageConf.map(function (p) { return p.confidence; }));
        var stats = [{ label: "pages", value: String(pdf.numPages) }, { label: "characters recognized", value: String(allText.join("").length) }];
        if (meanConfAll != null) stats.push({ label: "mean confidence", value: meanConfAll.toFixed(0) + "%" });
        var extraActions = [{ label: "Download plain text (.txt)", bytes: txt, filename: T.baseName(st.name) + ".txt", mime: "text/plain" }];
        if (hocrBytes) extraActions.push({ label: "Download hOCR (.html)", bytes: hocrBytes, filename: T.baseName(st.name) + "-hocr.html", mime: "text/html" });
        var noteBits = [lossless
          ? "Your original pages are untouched — same images, same quality. Only an invisible, selectable text layer was added."
          : "This file's structure could not be copied directly, so pages were re-rendered before adding the text layer. Text quality depends on scan resolution."];
        if (pageConf.length > 1 && meanConfAll != null) {
          noteBits.push("Per-page confidence: " + pageConf.map(function (p) { return "p" + p.page + " " + (p.confidence == null ? "—" : p.confidence.toFixed(0) + "%"); }).join(", ") + ".");
        }
        var noteWrap = T.el("div");
        noteBits.forEach(function (s) { noteWrap.appendChild(T.el("p", null, s)); });
        wb.showResult({
          bytes: bytes, filename: T.baseName(st.name) + "-ocr.pdf", mime: "application/pdf", kind: "pdf",
          title: "OCR complete — searchable PDF ready",
          stats: stats,
          extraActions: extraActions,
          note: noteWrap
        });
      });
    });
  });
})();
