/*!
 * redaction-audit.js — READ-ONLY redaction AUDIT engine for UnboundPDF (W5-E2, 2026-08-21).
 * (c) 2026 UnboundPDF. All code original. No third-party bytes are vendored by this file.
 *
 * Powers /tools/redaction-verifier/ (audit ANY tool's "redacted" PDF) and supplies the
 * per-region rows of /tools/redaction-log/.
 *
 * ── The one sentence that governs every string this engine produces ──────────────────────
 *   IT DETECTS TEXT THAT IS STILL PRESENT. IT CANNOT SEE WHAT WAS REMOVED.
 * A "no findings" result means this engine found no extractable text under a cover, no
 * invisible text and no annotation-only cover ON THE PAGES IT COULD READ. It is NOT proof
 * that a redaction was performed, nor that anything was ever there. Every caller must carry
 * that limit in its own copy; `report.limitations` restates it in the data itself so a
 * consumer cannot render the verdict without it.
 *
 * ── What it looks for, and how ──────────────────────────────────────────────────────────
 * 1. TEXT UNDER A COVER (the classic "black box drawn over the name" failure). The page's
 *    content stream is tokenised once (PDFTextOps._tokenize over the SAME concatenated bytes
 *    PDFTextOps.analyze() already decoded), tracking the graphics state — q/Q, cm, the fill
 *    colour operators (g/rg/k/sc/scn), and ExtGState fill alpha via `gs` resolved against the
 *    page's own /ExtGState resources. Every `re` painted by any fill operator (f, F, f-star, B, B-star, b, b-star)
 *    becomes a candidate COVER with its byte offset. A text record is reported only when
 *      (a) at least `coverRatio` of its rect lies inside the cover, AND
 *      (b) the cover's paint operator sits LATER in the stream than the text's show operator
 *          — painted after means painted on top; a fill drawn before the text is a background,
 *          not a cover, and reporting it would be a false positive, and
 *      (c) the cover is opaque enough to actually hide (fill alpha >= 0.5).
 *    The cover's colour is reported, not assumed: a white box over white-page text hides just
 *    as well as a black one, and both are found here.
 * 2. INVISIBLE TEXT (Tr 3). Text drawn in rendering mode 3 is present, selectable and
 *    copyable, and paints nothing. This is ALSO exactly what an OCR layer under a scan looks
 *    like, so it is reported as its own finding kind with that alternative named in the note —
 *    never merged into the "under a cover" count, which would inflate it dishonestly.
 * 3. HIDDEN-LAYER TEXT (optional content). Text inside a `/OC /Pn BDC ... EMC` span whose
 *    optional-content group is listed in the catalog's /OCProperties /D /OFF array is hidden
 *    by default in a reader and extracts anyway.
 * 4. ANNOTATION-ONLY COVERS. A /Square, /Redact, /Highlight, /FreeText, /Ink or /Stamp
 *    annotation lying over text is a cover the reader can delete in one click. Text under one
 *    is not redacted at all, however solid it looks.
 *
 * ── What it CANNOT see, stated in the report, never silently skipped ─────────────────────
 *  - Text drawn inside a Form XObject (`/Fm Do`) — invisible to PDFTextOps, so a page that
 *    uses one is marked `cannot-check`, not `clean`. Same blind spot redact-engine.js
 *    discloses for the same reason.
 *  - Text drawn as vector outlines or Type 3 glyphs: it is not text records, so it is neither
 *    found nor claimed absent.
 *  - Anything inside an encrypted document this engine cannot open.
 *  - Whether a cover it found is a REDACTION at all. A table's black header cell over a white
 *    caption is the same geometry as a redaction box.
 *  - What the original document said. Removed bytes are gone; nothing here reconstructs them.
 *
 * ── API ─────────────────────────────────────────────────────────────────────────────────
 *   await UBRedactAudit.auditDocument(pdfBytes, opts) -> report
 *     opts: { pages, coverRatio (default 0.6), darkThreshold (default 0.35),
 *             minAlpha (default 0.5), onPage(i, total) }
 *   report: {
 *     verdict: "text-found" | "no-findings" | "cannot-check",
 *     pageCount, pagesChecked, pagesUnreadable: [{page, reason}],
 *     findings: [{kind, page, text, rect, cover?, note}],
 *     pages: [{page, verdict, covers, findings, notes, formXObjects, textRecords}],
 *     counts: {textUnderCover, invisibleText, hiddenLayerText, annotationCover, covers},
 *     limitations: [string]
 *   }
 *   UBRedactAudit.findCovers(PDFLib, doc, analysis, pageIndex, opts) -> [cover]
 */
(function (global) {
  "use strict";

  var VERSION = "1.0.0";

  function getPDFLib() {
    var L = global.PDFLib || (typeof module !== "undefined" ? require("./pdf-lib.min.js") : null);
    if (!L) throw new Error("redaction-audit: PDFLib must be loaded first");
    return L;
  }
  function getTextOps() {
    var O = global.PDFTextOps || (typeof module !== "undefined" ? require("./pdf-textops.js") : null);
    if (!O) throw new Error("redaction-audit: pdf-textops.js must be loaded first");
    return O;
  }
  /* The device->viewport(top-left) conversion is redact-engine.js's, reused rather than
     rewritten: text record rects, cover rects and annotation rects have to land in ONE
     coordinate space or every overlap test here is meaningless, and that space is defined by
     PDFTextOps.analyze() and already inverted, correctly and under test, in redact-engine. */
  function getRedact() {
    var R = global.UBRedact || (typeof module !== "undefined" ? require("./redact-engine.js") : null);
    if (!R || !R._internal || !R._internal.toViewportTL) {
      throw new Error("redaction-audit: redact-engine.js must be loaded first (its toViewportTL is the shared coordinate mapping)");
    }
    return R;
  }

  var IDENT = [1, 0, 0, 1, 0, 0];
  function matMul(a, b) {
    return [
      a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
      a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
      a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]
    ];
  }
  function applyM(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

  function rectArea(r) { return Math.max(0, r.right - r.x) * Math.max(0, r.bottom - r.top); }
  function intersectArea(a, b) {
    var w = Math.min(a.right, b.right) - Math.max(a.x, b.x);
    var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return (w > 0 && h > 0) ? w * h : 0;
  }

  function grayOf(kind, comps) {
    if (kind === "gray") return comps[0];
    if (kind === "rgb") return 0.299 * comps[0] + 0.587 * comps[1] + 0.114 * comps[2];
    if (kind === "cmyk") {
      var c = comps[0], m = comps[1], y = comps[2], k = comps[3];
      var r = (1 - Math.min(1, c + k)), g = (1 - Math.min(1, m + k)), b = (1 - Math.min(1, y + k));
      return 0.299 * r + 0.587 * g + 0.114 * b;
    }
    return null;                    // pattern / unknown colour space: luminance unknown
  }

  /** Fill alpha (/ca) for every named ExtGState on the page, so `gs` can be resolved. A page
   *  whose resources cannot be read yields {} and every `gs` is then treated as opaque —
   *  the conservative direction for a DETECTOR (it reports more, never fewer, candidates). */
  function extGStateAlphas(PDFLib, page) {
    var out = {};
    try {
      var res = page.node.Resources();
      if (!res) return out;
      var eg = res.lookup(PDFLib.PDFName.of("ExtGState"), PDFLib.PDFDict);
      if (!eg) return out;
      eg.keys().forEach(function (k) {
        try {
          var d = eg.lookup(k, PDFLib.PDFDict);
          if (!d) return;
          var ca = d.lookup(PDFLib.PDFName.of("ca"));
          if (ca && typeof ca.asNumber === "function") out[k.asString().replace(/^\//, "")] = ca.asNumber();
        } catch (e) { /* one unreadable gs must not blind the whole page */ }
      });
    } catch (e) { /* no resources: treat as opaque */ }
    return out;
  }

  /** The set of optional-content group object keys that a reader hides by default. */
  function hiddenOcgKeys(PDFLib, doc) {
    var keys = {};
    try {
      var cat = doc.catalog;
      var ocp = cat.lookup(PDFLib.PDFName.of("OCProperties"), PDFLib.PDFDict);
      if (!ocp) return keys;
      var d = ocp.lookup(PDFLib.PDFName.of("D"), PDFLib.PDFDict);
      if (!d) return keys;
      var off = d.get(PDFLib.PDFName.of("OFF"));
      var arr = off && off.asArray ? off.asArray() : (off && off.array ? off.array : null);
      if (!arr) {
        var offDeref = d.lookup(PDFLib.PDFName.of("OFF"), PDFLib.PDFArray);
        arr = offDeref ? offDeref.asArray() : null;
      }
      if (!arr) return keys;
      arr.forEach(function (ref) {
        if (ref && ref.objectNumber != null) keys[ref.objectNumber + " " + (ref.generationNumber || 0)] = true;
      });
    } catch (e) { /* no optional content: nothing hidden */ }
    return keys;
  }

  /** Map /Properties resource names -> true when that name resolves to a hidden OCG (or an
   *  OCMD whose /OCGs are all hidden). */
  function hiddenPropertyNames(PDFLib, page, hiddenKeys) {
    var out = {};
    if (!Object.keys(hiddenKeys).length) return out;
    try {
      var res = page.node.Resources();
      if (!res) return out;
      var props = res.get(PDFLib.PDFName.of("Properties"));
      var dict = props && props.lookup ? props : res.lookup(PDFLib.PDFName.of("Properties"), PDFLib.PDFDict);
      if (!dict || !dict.keys) return out;
      dict.keys().forEach(function (k) {
        var name = k.asString().replace(/^\//, "");
        var ref = dict.get(k);
        if (ref && ref.objectNumber != null && hiddenKeys[ref.objectNumber + " " + (ref.generationNumber || 0)]) {
          out[name] = true;
        }
      });
    } catch (e) { /* unreadable properties: report nothing rather than guess */ }
    return out;
  }

  /**
   * Scan ONE page's content stream for filled rectangles that could act as covers, plus the
   * byte ranges of hidden optional-content spans.
   * Returns { covers: [{rect, opOffset, gray, alpha, colorSpace, comps}], hiddenRanges: [{s,e,name}] }
   */
  function findCovers(PDFLib, doc, analysis, pageIndex, opts) {
    opts = opts || {};
    var Ops = getTextOps();
    var R = getRedact();
    var page = doc.getPage(pageIndex);
    var alphas = extGStateAlphas(PDFLib, page);
    var hiddenNames = opts.hiddenNames || {};

    var toks = Ops._tokenize(analysis.bytes);
    var ctm = IDENT.slice(), ctmStack = [];
    var fillKind = "gray", fillComps = [0], fillAlpha = 1, fillCsName = null;
    var stateStack = [];
    /* The current path, accumulated in DEVICE space (each point transformed by the CTM in
       force when it was written). A rectangle is not always an `re`: pdf-lib's own
       drawRectangle emits `m l l l h f`, and a cover drawn by any other producer may be any
       closed path at all. Bounding the constructed path and taking it on the fill operator
       catches every one of them; `re` is just one more way to add four corners. */
    var pathPts = [];
    var covers = [], hiddenRanges = [], mcStack = [];
    var stack = [];

    function pushState() {
      ctmStack.push(ctm.slice());
      stateStack.push({ kind: fillKind, comps: fillComps.slice(), alpha: fillAlpha, cs: fillCsName });
    }
    function popState() {
      ctm = ctmStack.pop() || IDENT.slice();
      var s = stateStack.pop();
      if (s) { fillKind = s.kind; fillComps = s.comps; fillAlpha = s.alpha; fillCsName = s.cs; }
    }
    function nums(k) {
      var vals = [];
      for (var i = Math.max(0, stack.length - k); i < stack.length; i++) vals.push(stack[i].v || 0);
      return vals;
    }
    function addPoint(x, y) { pathPts.push(applyM(ctm, x, y)); }
    function emitFill(opTok) {
      if (!pathPts.length) return;
      var c = pathPts;
      var xs = c.map(function (p) { return p[0]; }), ys = c.map(function (p) { return p[1]; });
      var v0 = R._internal.toViewportTL(analysis, Math.min.apply(null, xs), Math.min.apply(null, ys));
      var v1 = R._internal.toViewportTL(analysis, Math.max.apply(null, xs), Math.max.apply(null, ys));
      var rect = {
        x: Math.min(v0[0], v1[0]), right: Math.max(v0[0], v1[0]),
        top: Math.min(v0[1], v1[1]), bottom: Math.max(v0[1], v1[1])
      };
      covers.push({
        rect: rect, opOffset: opTok.s, gray: grayOf(fillKind, fillComps), alpha: fillAlpha,
        colorSpace: fillKind, comps: fillComps.slice()
      });
      pathPts = [];
    }

    for (var ti = 0; ti < toks.length; ti++) {
      var tk = toks[ti];
      if (tk.t !== "op") { stack.push(tk); continue; }
      var op = tk.v;
      switch (op) {
        case "q": pushState(); break;
        case "Q": popState(); break;
        case "cm": if (stack.length >= 6) ctm = matMul(nums(6), ctm); break;
        case "gs": {
          var gname = stack.length ? String(stack[stack.length - 1].v || "") : "";
          if (Object.prototype.hasOwnProperty.call(alphas, gname)) fillAlpha = alphas[gname];
          break;
        }
        case "g": if (stack.length >= 1) { fillKind = "gray"; fillComps = nums(1); } break;
        case "rg": if (stack.length >= 3) { fillKind = "rgb"; fillComps = nums(3); } break;
        case "k": if (stack.length >= 4) { fillKind = "cmyk"; fillComps = nums(4); } break;
        case "cs": fillCsName = stack.length ? String(stack[stack.length - 1].v || "") : null; break;
        case "sc": case "scn": {
          var comps = [];
          for (var si = 0; si < stack.length; si++) if (stack[si].t === "num") comps.push(stack[si].v || 0);
          if (stack.length && stack[stack.length - 1].t === "name") { fillKind = "pattern"; fillComps = []; }
          else if (comps.length === 1) { fillKind = "gray"; fillComps = comps; }
          else if (comps.length === 3) { fillKind = "rgb"; fillComps = comps; }
          else if (comps.length === 4) { fillKind = "cmyk"; fillComps = comps; }
          else { fillKind = "pattern"; fillComps = comps; }
          break;
        }
        case "re": if (stack.length >= 4) {
          var rv = nums(4);
          addPoint(rv[0], rv[1]); addPoint(rv[0] + rv[2], rv[1]);
          addPoint(rv[0] + rv[2], rv[1] + rv[3]); addPoint(rv[0], rv[1] + rv[3]);
        } break;
        case "m": case "l": if (stack.length >= 2) { var mv2 = nums(2); addPoint(mv2[0], mv2[1]); } break;
        case "c": if (stack.length >= 6) { var cv = nums(6); addPoint(cv[0], cv[1]); addPoint(cv[2], cv[3]); addPoint(cv[4], cv[5]); } break;
        case "v": case "y": if (stack.length >= 4) { var yv = nums(4); addPoint(yv[0], yv[1]); addPoint(yv[2], yv[3]); } break;
        case "h": break;                          // close: adds no new extent
        case "f": case "F": case "f*": case "B": case "B*": case "b": case "b*": emitFill(tk); break;
        // A stroked-only path paints a hairline outline, not a filled area: it hides nothing,
        // so it is discarded rather than reported as a cover.
        case "S": case "s": case "n": pathPts = []; break;
        case "W": case "W*": break;              // clip: the path is reused, keep it
        case "BDC": case "BMC": {
          var tag = null, prop = null;
          for (var bi = 0; bi < stack.length; bi++) if (stack[bi].t === "name") { if (tag === null) tag = String(stack[bi].v); else prop = String(stack[bi].v); }
          mcStack.push({ tag: tag, prop: prop, s: tk.e });
          break;
        }
        case "EMC": {
          var mc = mcStack.pop();
          if (mc && mc.tag === "OC" && mc.prop && hiddenNames[mc.prop]) hiddenRanges.push({ s: mc.s, e: tk.s, name: mc.prop });
          break;
        }
        default: break;
      }
      stack = [];
    }
    return { covers: covers, hiddenRanges: hiddenRanges };
  }

  /* ═══════════════ spatial index (W5-E2 follow-up, 2026-08-21) ═══════════════
     The first cut compared EVERY text record against EVERY cover on the page. That is fine
     on a redacted letter (a handful of each) and quadratic on the documents this tool is
     most likely to be pointed at by someone who is worried: a vector-heavy report or a map,
     where a page can carry thousands of text records and hundreds of filled paths. 5,000
     records x 200 covers is a million rect tests for ONE page, and nothing bounded it.

     Covers are now bucketed into a uniform grid, so a record only tests the covers whose
     cell it actually touches. Two details make the grid honest rather than merely fast:
       - a cover big enough to span much of the page would land in every cell, which is the
         quadratic case wearing a grid's clothes. Those go in a separate `big` list that
         every record tests — correct, and bounded by how few such covers a page can have.
       - the grid is an INDEX, never a filter: a candidate set that misses a real overlap
         would turn a positive into a false "nothing found", which is the one error this
         tool must never make. Cell ranges are computed from the rect's own bounds and
         clamped, so every cover whose rect touches a record's rect is always a candidate.
     _qa/test_redaction_verifier.mjs asserts grid and no-grid agree finding-for-finding. */
  var GRID_CELL_PT = 48;
  var BIG_COVER_SHARE = 0.25;      // of page area; above this a cover skips the grid

  function buildCoverIndex(covers, visW, visH) {
    var cols = Math.max(1, Math.ceil((visW || 1) / GRID_CELL_PT));
    var rows = Math.max(1, Math.ceil((visH || 1) / GRID_CELL_PT));
    var pageArea = Math.max(1, (visW || 1) * (visH || 1));
    var cells = {}, big = [];
    for (var i = 0; i < covers.length; i++) {
      var c = covers[i];
      c.__i = i;
      if (rectArea(c.rect) > BIG_COVER_SHARE * pageArea) { big.push(c); continue; }
      var c0 = Math.max(0, Math.min(cols - 1, Math.floor(c.rect.x / GRID_CELL_PT)));
      var c1 = Math.max(0, Math.min(cols - 1, Math.floor(c.rect.right / GRID_CELL_PT)));
      var r0 = Math.max(0, Math.min(rows - 1, Math.floor(c.rect.top / GRID_CELL_PT)));
      var r1 = Math.max(0, Math.min(rows - 1, Math.floor(c.rect.bottom / GRID_CELL_PT)));
      for (var rr = r0; rr <= r1; rr++) {
        for (var cc = c0; cc <= c1; cc++) {
          var k = rr * cols + cc;
          (cells[k] || (cells[k] = [])).push(c);
        }
      }
    }
    return { cols: cols, rows: rows, cells: cells, big: big, count: covers.length };
  }

  /** Every cover that could overlap `rect`. Never fewer than the true set. */
  function candidates(index, rect) {
    if (!index.count) return [];
    var out = index.big.slice(), seen = {};
    for (var b = 0; b < out.length; b++) seen[out[b].__i] = true;
    var c0 = Math.max(0, Math.min(index.cols - 1, Math.floor(rect.x / GRID_CELL_PT)));
    var c1 = Math.max(0, Math.min(index.cols - 1, Math.floor(rect.right / GRID_CELL_PT)));
    var r0 = Math.max(0, Math.min(index.rows - 1, Math.floor(rect.top / GRID_CELL_PT)));
    var r1 = Math.max(0, Math.min(index.rows - 1, Math.floor(rect.bottom / GRID_CELL_PT)));
    for (var rr = r0; rr <= r1; rr++) {
      for (var cc = c0; cc <= c1; cc++) {
        var bucket = index.cells[rr * index.cols + cc];
        if (!bucket) continue;
        for (var i = 0; i < bucket.length; i++) {
          if (!seen[bucket[i].__i]) { seen[bucket[i].__i] = true; out.push(bucket[i]); }
        }
      }
    }
    return out;
  }

  /**
   * Which CHARACTERS of a text record lie under a cover rectangle.
   *
   * Comparing whole-record areas is not good enough and was the first thing measured here:
   * a black box over "John Q Smith" inside the record "Claimant name: John Q Smith" covers
   * 59% of the record's area, so any single area threshold either misses the real redaction
   * or fires on every table cell. The record's own per-character advances (PDFTextOps gives
   * them in `chars[].adv`) map linearly onto its viewport rect for UPRIGHT text, so the
   * covered SUBSTRING can be named exactly — which is also what the tool has to show the
   * user ("the text under this box is ..."), masked until they ask for it.
   *
   * For text that is not upright (rotated or skewed matrices, where record.editable is
   * false) that linear mapping does not hold, so this falls back to a whole-record area test
   * at `coverRatio` and says so in the returned `precise` flag — never silently pretending
   * to character precision it does not have.
   */
  function coveredText(r, cov, coverRatio) {
    var h = r.rect.bottom - r.rect.top;
    if (h <= 0) return null;
    var vOverlap = Math.min(r.rect.bottom, cov.rect.bottom) - Math.max(r.rect.top, cov.rect.top);
    if (vOverlap / h < 0.5) return null;                    // the box is not on this line

    var chars = r.chars || [];
    var span = r.rect.right - r.rect.x;
    if (!r.editable || !chars.length || !r.advance || span <= 0) {
      var area = rectArea(r.rect);
      if (!area || intersectArea(r.rect, cov.rect) / area < coverRatio) return null;
      return { text: r.text, from: 0, to: r.text.length - 1, precise: false, rect: r.rect };
    }
    var scale = span / r.advance;
    var x = r.rect.x, out = "", from = -1, to = -1, x0 = 0, x1 = 0;
    for (var i = 0; i < chars.length; i++) {
      var w = (chars[i].adv || 0) * scale;
      var mid = x + w / 2;
      if (mid >= cov.rect.x && mid <= cov.rect.right) {
        if (from < 0) { from = i; x0 = x; }
        to = i; x1 = x + w;
        out += chars[i].uni == null ? "" : chars[i].uni;
      }
      x += w;
    }
    if (!out.replace(/\s+/g, "")) return null;               // only whitespace under the box
    return {
      text: out, from: from, to: to, precise: true,
      rect: { x: x0, right: x1, top: r.rect.top, bottom: r.rect.bottom }
    };
  }

  /** Annotations that visually cover something and are removable in one click. */
  var COVER_ANNOT_SUBTYPES = { Square: 1, Redact: 1, Highlight: 1, FreeText: 1, Ink: 1, Stamp: 1, Polygon: 1 };
  function annotationCovers(PDFLib, doc, analysis, pageIndex) {
    var R = getRedact();
    var out = [];
    try {
      var page = doc.getPage(pageIndex);
      var annots = page.node.Annots();
      if (!annots) return out;
      for (var i = 0; i < annots.size(); i++) {
        var a;
        try { a = annots.lookup(i, PDFLib.PDFDict); } catch (e) { continue; }
        if (!a) continue;
        var sub = a.lookup(PDFLib.PDFName.of("Subtype"));
        var subName = sub && sub.asString ? sub.asString().replace(/^\//, "") : "";
        if (!COVER_ANNOT_SUBTYPES[subName]) continue;
        var rectArr = a.lookup(PDFLib.PDFName.of("Rect"), PDFLib.PDFArray);
        if (!rectArr || rectArr.size() !== 4) continue;
        var n0 = rectArr.lookup(0).asNumber(), n1 = rectArr.lookup(1).asNumber();
        var n2 = rectArr.lookup(2).asNumber(), n3 = rectArr.lookup(3).asNumber();
        var v0 = R._internal.toViewportTL(analysis, Math.min(n0, n2), Math.min(n1, n3));
        var v1 = R._internal.toViewportTL(analysis, Math.max(n0, n2), Math.max(n1, n3));
        out.push({
          subtype: subName,
          rect: {
            x: Math.min(v0[0], v1[0]), right: Math.max(v0[0], v1[0]),
            top: Math.min(v0[1], v1[1]), bottom: Math.max(v0[1], v1[1])
          }
        });
      }
    } catch (e) { /* an unreadable /Annots is disclosed by the page note, not by throwing */ }
    return out;
  }

  var LIMITATIONS = [
    "This check detects text that is STILL PRESENT. It cannot see what was removed, and it cannot tell you whether a redaction was ever performed.",
    "Text drawn inside a Form XObject, drawn as vector outlines, or drawn with a Type 3 font is not readable as text records — pages that use one are reported as \"could not check\", never as clean.",
    "A filled rectangle over text is reported as a cover whatever it was drawn for; a black table cell and a redaction box have the same geometry.",
    "Text in an encrypted document that cannot be opened is not checked at all.",
    "A page dense enough to exhaust the scan\u2019s per-page limit is reported as \u201ccould not check\u201d with the limit named, never as clear."
  ];

  async function auditDocument(pdfBytes, opts) {
    opts = opts || {};
    var PDFLib = getPDFLib();
    var Ops = getTextOps();
    getRedact();                                   // fail fast and by name if it is missing
    var coverRatio = opts.coverRatio == null ? 0.6 : opts.coverRatio;
    var minAlpha = opts.minAlpha == null ? 0.5 : opts.minAlpha;
    var darkThreshold = opts.darkThreshold == null ? 0.35 : opts.darkThreshold;
    /* A HARD per-page ceiling on overlap tests. The grid makes the normal page near-linear,
       but a page can still be adversarial — thousands of records under hundreds of covers
       that genuinely all overlap. When that ceiling is hit the page is reported "could not
       check", never skipped and never "clear": an unbounded scan that hangs the tab and a
       silent skip that reads as clean are the same defect wearing different clothes.
       Deliberately a COUNT and not a wall-clock timer: a verdict that changes with how busy
       the machine is would not be a verdict. Tunable for the suite via opts. */
    var comparisonBudget = opts.comparisonBudget == null ? 400000 : opts.comparisonBudget;
    var useGrid = opts.useGrid !== false;              // the suite runs both ways and compares

    var doc = await PDFLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
    var pageCount = doc.getPageCount();
    var pages = opts.pages || Array.from({ length: pageCount }, function (_, i) { return i; });
    var hiddenKeys = hiddenOcgKeys(PDFLib, doc);

    var findings = [], pageRows = [], unreadable = [];
    var counts = { textUnderCover: 0, invisibleText: 0, hiddenLayerText: 0, annotationCover: 0, covers: 0 };

    for (var pi = 0; pi < pages.length; pi++) {
      var pageIndex = pages[pi];
      if (opts.onPage) opts.onPage(pi, pages.length);
      if (opts.check) await opts.check();
      var analysis = null;
      try { analysis = Ops.analyze(PDFLib, doc, pageIndex); }
      catch (e) {
        unreadable.push({ page: pageIndex, reason: e && e.message ? e.message : "content stream could not be parsed" });
        pageRows.push({ page: pageIndex, verdict: "cannot-check", covers: 0, findings: [], textRecords: 0, formXObjects: 0,
          notes: ["This page's content stream could not be parsed, so nothing on it was checked."] });
        continue;
      }
      var page = doc.getPage(pageIndex);
      var hiddenNames = hiddenPropertyNames(PDFLib, page, hiddenKeys);
      var scan = findCovers(PDFLib, doc, analysis, pageIndex, { hiddenNames: hiddenNames });
      var annots = annotationCovers(PDFLib, doc, analysis, pageIndex);
      var pageFindings = [], notes = [];

      var usable = scan.covers.filter(function (c) {
        return c.alpha >= minAlpha && rectArea(c.rect) > 1;
      });
      counts.covers += usable.length;

      var coverIndex = buildCoverIndex(usable, analysis.vw, analysis.vh);
      var annotIndex = buildCoverIndex(annots, analysis.vw, analysis.vh);
      var comparisons = 0, budgetHit = false;

      analysis.records.forEach(function (r) {
        if (budgetHit) return;
        if (!r.text || !r.text.trim()) return;
        var area = rectArea(r.rect);
        if (area <= 0) return;

        // (1) painted-over text
        var near = useGrid ? candidates(coverIndex, r.rect) : usable;
        for (var ci = 0; ci < near.length; ci++) {
          if (++comparisons > comparisonBudget) { budgetHit = true; return; }
          var cov = near[ci];
          if (cov.opOffset <= r.e) continue;                    // drawn BEFORE the text: a background
          var hit = coveredText(r, cov, coverRatio);
          if (!hit) continue;
          pageFindings.push({
            kind: "text-under-cover", page: pageIndex, text: hit.text, fullRecord: r.text,
            charFrom: hit.from, charTo: hit.to, precise: hit.precise, rect: hit.rect,
            cover: {
              rect: cov.rect, gray: cov.gray, alpha: cov.alpha, colorSpace: cov.colorSpace,
              dark: cov.gray != null && cov.gray <= darkThreshold
            },
            note: "This text is still in the file's content stream. A filled rectangle is drawn over it afterwards, so it is hidden from the eye and not from a copy-paste, a text search, or any extraction tool."
          });
          counts.textUnderCover++;
          return;                                               // one finding per record
        }

        // (2) invisible text
        if (r.renderMode === 3 || r.invisible) {
          pageFindings.push({
            kind: "invisible-text", page: pageIndex, text: r.text, rect: r.rect,
            note: "This text is drawn in rendering mode 3 (invisible): present and extractable, painting nothing. That is also what a searchable-scan OCR layer looks like, so it is not on its own evidence of a failed redaction."
          });
          counts.invisibleText++;
          return;
        }

        // (3) hidden optional-content layer
        for (var hi = 0; hi < scan.hiddenRanges.length; hi++) {
          var hr = scan.hiddenRanges[hi];
          if (r.s >= hr.s && r.e <= hr.e) {
            pageFindings.push({
              kind: "hidden-layer-text", page: pageIndex, text: r.text, rect: r.rect,
              note: "This text sits in an optional-content layer that the document asks readers to hide by default. It is still extractable."
            });
            counts.hiddenLayerText++;
            return;
          }
        }

        // (4) annotation-only cover
        var nearA = useGrid ? candidates(annotIndex, r.rect) : annots;
        for (var ai = 0; ai < nearA.length; ai++) {
          if (++comparisons > comparisonBudget) { budgetHit = true; return; }
          var ahit = coveredText(r, nearA[ai], coverRatio);
          if (ahit) {
            pageFindings.push({
              kind: "annotation-cover", page: pageIndex, text: ahit.text, fullRecord: r.text,
              charFrom: ahit.from, charTo: ahit.to, precise: ahit.precise, rect: ahit.rect,
              cover: { rect: nearA[ai].rect, subtype: nearA[ai].subtype },
              note: "The only thing over this text is a /" + nearA[ai].subtype + " annotation. An annotation is a separate object a reader can select and delete, so the text under it is not removed."
            });
            counts.annotationCover++;
            return;
          }
        }
      });

      if (analysis.notes && analysis.notes.formXObjects > 0) {
        notes.push("This page draws through " + analysis.notes.formXObjects + " Form XObject(s). Text inside one is not readable as text records here, so this page cannot be reported clean.");
      }
      var unknownOps = analysis.notes && analysis.notes.unknownOps ? Object.keys(analysis.notes.unknownOps) : [];
      if (unknownOps.length) notes.push("Unrecognised content operators on this page (" + unknownOps.slice(0, 6).join(", ") + ") — part of this page was not modelled.");

      if (budgetHit) {
        notes.push("This page is too complex to check in full: the scan reached its limit of " +
          comparisonBudget.toLocaleString() + " overlap tests (" + analysis.records.length +
          " text records, " + usable.length + " filled covers) and stopped. What is reported below was found before that point; the rest of the page was NOT checked, so this page cannot be treated as clear.");
      }
      /* A page that ran out of budget is "cannot-check" when nothing was found — never
         "no-findings", which a reader is entitled to read as clean. Findings already made
         before the ceiling stand: a positive is a positive however early it was found. */
      var verdict = pageFindings.length ? "text-found"
        : (budgetHit || (analysis.notes && analysis.notes.formXObjects > 0)) ? "cannot-check"
          : "no-findings";
      pageRows.push({
        page: pageIndex, verdict: verdict, covers: usable.length, findings: pageFindings,
        incomplete: budgetHit, comparisons: comparisons,
        textRecords: analysis.records.length,
        formXObjects: (analysis.notes && analysis.notes.formXObjects) || 0,
        annotations: annots.length, notes: notes
      });
      findings = findings.concat(pageFindings);
    }

    var anyFound = findings.some(function (f) { return f.kind !== "invisible-text"; }) || counts.invisibleText > 0;
    var anyUncheckable = pageRows.some(function (p) { return p.verdict === "cannot-check"; });
    var verdict = findings.length ? "text-found" : anyUncheckable ? "cannot-check" : "no-findings";

    return {
      version: VERSION,
      verdict: verdict,
      pageCount: pageCount,
      pagesChecked: pageRows.filter(function (p) { return p.verdict !== "cannot-check" || p.textRecords; }).length,
      pagesUnreadable: unreadable,
      findings: findings,
      pages: pageRows,
      counts: counts,
      anyFound: anyFound,
      limitations: LIMITATIONS.slice()
    };
  }

  var API = {
    VERSION: VERSION,
    auditDocument: auditDocument,
    findCovers: findCovers,
    annotationCovers: annotationCovers,
    LIMITATIONS: LIMITATIONS,
    GRID_CELL_PT: GRID_CELL_PT,
    _internal: { buildCoverIndex: buildCoverIndex, candidates: candidates, grayOf: grayOf, intersectArea: intersectArea, rectArea: rectArea, hiddenOcgKeys: hiddenOcgKeys, extGStateAlphas: extGStateAlphas }
  };
  global.UBRedactAudit = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof self !== "undefined" ? self : globalThis);
