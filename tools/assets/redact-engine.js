/*!
 * redact-engine.js — TRUE REDACTION engine for UnboundPDF (W1-B).
 * (c) 2026 UnboundPDF. All code original.
 *
 * Wires the engines we already own — never rasterises to remove text:
 *   - pdf-textops.js  : analyze() a page's content stream into text-show RECORDS
 *                       {byte range, font, matrix, rect}; splice() deletes the
 *                       operator bytes outright (TRUE deletion, not a cover).
 *   - pdf-textedit.js : recordsInRect() selects records whose centre falls inside
 *                       a rectangle (viewport/top-left points, same space as the
 *                       editor's overlay boxes).
 *   - jpeg-patch.js + jpeg-requant.js (optional, TIER-2) : MCU-level coefficient
 *                       patch for a JPEG (DCTDecode) image XObject — erases the
 *                       region's pixels without recompressing the rest of the photo.
 *
 * This file is READ-ONLY with respect to pdf-textops.js / pdf-textedit.js — it
 * only calls their exported API (analyze/splice/writeStream/_tokenize/recordsInRect).
 * It does not touch all-tools.js or editor.js (both are mid-split under W0-6).
 *
 * ── History: an independent byte-level check (2026-08-18, see
 *   research/unboundpdf/full-capability/check-w1-b.md) found the text splice itself
 *   correct but SIX ship-blocking leaks around it — every one paired with a report
 *   that said "verified: true". Fixed here, and the fixes are structural, not patches:
 *   1. report.verified is now grounded in a RAW-BYTE scan of the saved output (every
 *      stream inflated, ASCII/UTF-16BE/hex-string needle variants) — never the same
 *      decoder that found the match in the first place, and never true on a no-op.
 *   2. every object this engine unlinks (old content streams, replaced images, removed
 *      annotations + their /AP, the old /Metadata) is swept through a REFERENT-CHECKED
 *      garbage collector — an object is deleted only if no surviving object in the file
 *      still points to it, which is what makes a /Contents stream SHARED by two pages
 *      safe to edit (deleting it unconditionally, as an earlier version of this file
 *      did, corrupted the other page's xref).
 *   3. AcroForm fields: removing a widget's annotation also walks its /Parent chain
 *      clearing /V and dropping /AP wherever present, so the value cannot be read back
 *      via PDFDocument.load(out).getForm().getTextField(...).getText().
 *   4. Form XObjects (`analysis.notes.formXObjects`) now fail the parity gate exactly
 *      like an unrecognised operator — text drawn through a `/Fm Do` is invisible to
 *      pdf-textops, so a page that uses one falls back to the existing raster method
 *      instead of being reported clean while the string is still extractable.
 *   5. sanitize now deletes the /Metadata OBJECT (via the GC sweep), not just the
 *      catalog key, and writes a fresh empty XMP packet; a needle-scrub pass also
 *      clears /Outlines /Title and /StructTreeRoot /ActualText + /Alt when they carry
 *      a redacted string, and every touched page's /Thumb (a raster of the
 *      PRE-redaction page) is dropped outright.
 *
 * ── Round 2 (2026-08-18, same check doc, §1-3): the round-1 fixes were real but the
 *   PROOF had a hole — round 1's report was "verified: true" while a redacted name sat
 *   in plain sight in /Info /Title, in a form field's /DV, and in a Word custom-
 *   properties dict, on default options and even under sanitize:true. Fixed:
 *   6. rawByteVerify's round-1 header claimed it decoded every stream "including
 *      /ObjStm — no special-casing needed", which was FALSE AS WRITTEN: the scan only
 *      ever looked at objects that were STREAMS, silently skipping every plain PDFDict
 *      — which is exactly what /Info, an outline item, a struct element or a form
 *      field's dict IS. (The /ObjStm half of the claim was accidentally true — pdf-lib
 *      expands object streams into plain dicts at load time and deletes the container,
 *      so there is no /ObjStm object left to miss — but the mechanism was misdescribed
 *      and the actual bug, "we never look at non-stream objects at all", was real.)
 *      Fixed by walking EVERY object: streams are still decoded and byte-scanned;
 *      every other object's PDFString/PDFHexString VALUES are collected recursively
 *      (collectStrings) and matched by decoded-text substring. This needs no allow-list
 *      of "where metadata lives" — see rawByteVerify's own comment for the full case.
 *   7. sanitizeDoc no longer allow-lists six Info keys — it enumerates and clears
 *      every key actually present in the Info dict, plus /PieceInfo (Word/Office
 *      producer metadata, catalog-level) and any other non-standard catalog key.
 *   8. clearFormFieldChain now also clears /DV (default value — Acrobat's "Reset Form"
 *      writes /DV back into /V, so leaving it behind is one click from restoring the
 *      redacted value), /TU (tooltip) and /RV (rich-text value).
 *   9. applyRedactions now feeds the ACTUAL TEXT of every spliced record into the
 *      verify/scrub needle list automatically (report.autoVerifyStrings) — the
 *      redactRects UI path (which supplies no needles of its own) now scrubs
 *      /Outlines /StructTreeRoot and gets a real report.verified instead of always
 *      being `null`.
 *   The invariant this module exists to prove: **verified === true implies no needle
 *   survives, in any encoding, anywhere in the saved bytes or any decoded stream or any
 *   decoded object string** — enforced by _qa/test_redact_engine.mjs against an oracle
 *   INDEPENDENT of this file (its own zlib inflate + hand-rolled PDF string tokenizer,
 *   not a call into rawByteVerify — round 1's suite made exactly that mistake).
 *
 * ── Known, DOCUMENTED limitation (not silently missed, not yet fixed) ─────────
 *   Text split across consecutive show operators — e.g. `(Jo) Tj (hn Smi) Tj (th) Tj`
 *   for "John Smith" — is invisible to per-record matching: pdf-textops has no
 *   character-level splice primitive, so redaction can only remove a WHOLE record,
 *   and "John Smith" never exists as one record's text. redactText() runs a
 *   page-concatenation heuristic to DETECT this case (joins every record's text in
 *   stream order and re-tests the pattern against the join) and reports it by name in
 *   report.splitMatches — it does not attempt to redact it. A `TJ` array IS one
 *   record regardless of how many bracketed pieces it holds, so kerned single-`TJ`
 *   text is unaffected; only text broken across separate `Tj`/`'`/`"` operators leaks.
 *
 * ── What "true" means here, precisely ────────────────────────────────────────
 * Text: a record fully removed by splice() is GONE from the content stream. The
 *   black rectangle drawn afterwards is a pure VISUAL mark — nothing is left to
 *   uncover underneath it.
 * Images: only a JPEG (DCTDecode) intersecting a redaction rect, placed with an
 *   axis-aligned (non-rotated/skewed) matrix, is pixel-erased in place. The
 *   PRE-erase image object is then garbage-collected (never left as a recoverable
 *   orphan). Any other codec has no in-tree re-encoder, so that page is named for
 *   the pre-existing whole-page-raster fallback — see report.rasterFallbackPages.
 * Annotations whose /Rect intersects a redaction rect are unlinked from /Annots and
 *   garbage-collected (if nothing else in the file still points to them); their form
 *   field value and appearance stream are cleared even when the annotation itself
 *   must stay registered (still reachable from /AcroForm).
 * Vector-outlined text (glyphs drawn as fill paths), Type3 glyphs, and text inside
 *   a Form XObject are NOT visible to pdf-textops — pages where this applies are
 *   named in report.notRemovable / fail the parity gate, never silently reported clean.
 *
 * ── API ──────────────────────────────────────────────────────────────────────
 *   UBRedact.redactRects(pdfBytes, items, opts) -> {bytes, report}
 *     items: [{ page: 0-based, rect: {x, top, right, bottom} (pt, viewport/top-left,
 *               same convention as PDFTextOps analyze() record.rect) }]
 *   UBRedact.redactText(pdfBytes, { query | regex, caseSensitive, wholeWord, pages }, opts)
 *     -> {bytes, report}
 *   UBRedact.redactPattern(pdfBytes, presetNameOrNames, opts) -> {bytes, report}
 *   UBRedact.presets -> { email, phoneIntl, iban, creditCard, ssn, date } each
 *     { regex, note, validate? }
 *   opts (all optional): { fill: "#000000", mark: true, sanitize: false,
 *     pad: 2, verifyStrings: [...] }
 *   report.verified: true only after a raw-byte scan of the saved output found ZERO
 *     occurrences of every needle, AND nothing was left in notRemovable/rasterFallback
 *     for the pages touched; null when there was nothing to verify (no needles, or a
 *     search/pattern call that matched nothing — a no-op is never reported "verified").
 */
(function (global) {
"use strict";

function getPDFLib() {
  var L = global.PDFLib || (typeof module !== "undefined" ? require("./pdf-lib.min.js") : null);
  if (!L) throw new Error("redact-engine: PDFLib must be loaded first");
  return L;
}
function getTextOps() {
  var O = global.PDFTextOps || (typeof module !== "undefined" ? require("./pdf-textops.js") : null);
  if (!O) throw new Error("redact-engine: pdf-textops.js must be loaded first");
  return O;
}
function getTextEdit() {
  var E = global.PDFTextEdit || (typeof module !== "undefined" ? require("./pdf-textedit.js") : null);
  if (!E) throw new Error("redact-engine: pdf-textedit.js must be loaded first");
  return E;
}
function getJpegPatch() { return global.JPEGPatch || null; }
function getJpegRequant() { return global.JPEGRequant || null; }

/* ═══════════════ small geometry / colour helpers ═══════════════ */
function hexToRgb01(hex) {
  var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || "#000000"));
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}
function rectsOverlap(a, b) {
  return a.x < b.right && a.right > b.x && a.top < b.bottom && a.bottom > b.top;
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

/* Forward + inverse of PDFTextOps' device→viewport(top-left) convention, reimplemented
   here (read-only reuse — pdf-textops.js is not modified) from its own documented cases
   so image/annotation geometry can be compared against record.rect's coordinate space. */
function toViewportTL(analysis, xd, yd) {
  var box = analysis.box, rotate = analysis.rotate, vh = analysis.vh;
  var pdfW = analysis.pdfW, pdfH = analysis.pdfH;
  var x = xd - box.x, y = yd - box.y, vx, vy;
  if (rotate === 90) { vx = y; vy = vh - x; }
  else if (rotate === 180) { vx = pdfW - x; vy = vh - y; }
  else if (rotate === 270) { vx = pdfH - y; vy = vh - (pdfW - x); }
  else { vx = x; vy = y; }
  return [vx, vh - vy]; // [screenX, screenY-top-down]
}
function toDevice(analysis, screenX, screenYTop) {
  var box = analysis.box, rotate = analysis.rotate, vh = analysis.vh;
  var pdfW = analysis.pdfW, pdfH = analysis.pdfH;
  var vx = screenX, vy = vh - screenYTop, x, y;
  if (rotate === 90) { x = vh - vy; y = vx; }
  else if (rotate === 180) { x = pdfW - vx; y = vh - vy; }
  else if (rotate === 270) { y = pdfH - vx; x = pdfW - (vh - vy); }
  else { x = vx; y = vy; }
  return [x + box.x, y + box.y];
}

/* ═══════════════ pattern presets (plain regex — no library, per audit-docops §2.4) ═══════════════ */
function luhnOk(digitsStr) {
  var sum = 0, alt = false;
  for (var i = digitsStr.length - 1; i >= 0; i--) {
    var d = digitsStr.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}
function ibanChecksum(iban) {
  var s = iban.replace(/\s+/g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  var rearr = s.slice(4) + s.slice(0, 4);
  var expanded = "";
  for (var i = 0; i < rearr.length; i++) {
    var c = rearr.charCodeAt(i);
    expanded += (c >= 65 && c <= 90) ? String(c - 55) : rearr[i];
  }
  var rem = 0;
  for (var j = 0; j < expanded.length; j++) rem = (rem * 10 + (expanded.charCodeAt(j) - 48)) % 97;
  return rem === 1;
}
var PATTERNS = {
  email: {
    regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    note: "Standard local@domain.tld shape. False-positive note: catches look-alike strings in code samples or URLs that are not real addresses."
  },
  phoneIntl: {
    // widened 2026-08-18 (checker H5): a single-digit area/trunk code after the country
    // code — e.g. France's "+33 1 42 68 53 00" — was being missed by a \d{2,4} floor.
    regex: /\+\d{1,3}[\s().-]{0,2}\d{1,4}(?:[\s().-]{0,2}\d{2,4}){1,4}/g,
    note: "E.164-ish: a leading '+' country code followed by 6-14 more digits with common separators. False-positive note: can match long non-phone numeric IDs that happen to start with a plausible country code, and misses phone numbers with no '+' prefix."
  },
  iban: {
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    note: "ISO 13616 shape, checksum-validated (mod-97). False-positive note: a small number of non-IBAN alphanumeric codes of the right shape can still pass the checksum by chance (~1/97).",
    validate: ibanChecksum
  },
  creditCard: {
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    note: "13-19 digit run, Luhn-validated. False-positive note: some non-card identifiers (order numbers, some national IDs) are also Luhn-valid; Luhn only rules out most typos and random digit runs, it does not confirm the number is a live card.",
    validate: function (s) { return luhnOk(s.replace(/[ -]/g, "")); }
  },
  ssn: {
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    note: "US SSN shape (###-##-####) ONLY — a purely structural match. False-positive note: HIGH — any other ddd-dd-dddd identifier (some case/reference numbers, some non-US IDs) matches identically; there is no public checksum to validate against, so this preset is a shape filter, not a proof."
  },
  date: {
    regex: /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}\.\d{1,2}\.\d{2,4})\b/g,
    note: "ISO (YYYY-MM-DD), US (M/D/YYYY) and EU (D.M.YYYY) shapes. False-positive note: matches any numeric triple in these shapes, including version numbers, invoice numbers, or ratios that are not dates."
  }
};

/* ═══════════════ image XObject placement scan (own minimal q/Q/cm/Do walk) ═══════════════
   Reuses PDFTextOps._tokenize + analysis.bytes (already-assembled content stream) but does
   its own graphics-state walk, because analyze()'s internal `graphics` array does not carry
   the XObject resource name needed to look the stream back up — read-only reuse, no edit to
   pdf-textops.js. */
function locateImageRegions(PDFLib, doc, analysis, pageIndex) {
  var N = PDFLib.PDFName;
  var page = doc.getPage(pageIndex);
  var res = page.node.Resources();
  var xdict = res ? res.lookup(N.of("XObject")) : null;
  var xobjs = {};
  if (xdict && xdict.keys) {
    xdict.keys().forEach(function (k) {
      var name = String(k).replace(/^\//, "");
      try {
        var xo = xdict.lookup(k);
        var xd = xo && xo.dict ? xo.dict : xo;
        var st = xd && xd.lookup ? String(xd.lookup(N.of("Subtype")) || "") : "";
        xobjs[name] = { name: name, stream: xo, dict: xd, subtype: st.replace(/^\//, ""), ref: xdict.get(k) };
      } catch (e) {}
    });
  }
  var Ops = getTextOps();
  var toks = Ops._tokenize(analysis.bytes);
  var ctm = IDENT.slice(), stack = [];
  var args = [];
  var results = [];
  for (var i = 0; i < toks.length; i++) {
    var tk = toks[i];
    if (tk.t !== "op") { args.push(tk); continue; }
    switch (tk.v) {
      case "q": stack.push(ctm.slice()); break;
      case "Q": ctm = stack.pop() || IDENT.slice(); break;
      case "cm":
        if (args.length >= 6) { ctm = matMul(args.slice(-6).map(function (a) { return a.v || 0; }), ctm); }
        break;
      case "Do": {
        var nm = args.length ? String(args[args.length - 1].v || "") : "";
        var xo = xobjs[nm];
        if (xo && xo.subtype === "Image") {
          var c0 = applyM(ctm, 0, 0), c1 = applyM(ctm, 1, 1), c2 = applyM(ctm, 1, 0), c3 = applyM(ctm, 0, 1);
          var x0 = Math.min(c0[0], c1[0], c2[0], c3[0]), x1 = Math.max(c0[0], c1[0], c2[0], c3[0]);
          var y0 = Math.min(c0[1], c1[1], c2[1], c3[1]), y1 = Math.max(c0[1], c1[1], c2[1], c3[1]);
          var vp0 = toViewportTL(analysis, x0, y0), vp1 = toViewportTL(analysis, x1, y1);
          var axisAligned = Math.abs(ctm[1]) < 1e-6 && Math.abs(ctm[2]) < 1e-6;
          results.push({
            name: nm, xobj: xo,
            devRect: { x0: x0, y0: y0, x1: x1, y1: y1 },
            rect: {
              x: Math.min(vp0[0], vp1[0]), right: Math.max(vp0[0], vp1[0]),
              top: Math.min(vp0[1], vp1[1]), bottom: Math.max(vp0[1], vp1[1])
            },
            axisAligned: axisAligned
          });
        }
        break;
      }
      default: break;
    }
    args = [];
  }
  return results;
}

/** Try to erase the overlapping portion of an image with jpeg-patch (JPEG/DCTDecode only,
 *  axis-aligned placement only). Returns {patchedBytes} | "unsupported-codec" | "unsupported-geometry" | "skipped". */
function tryPatchImage(PDFLib, doc, analysis, ir, boxRectsViewport, fillRgb255) {
  var N = PDFLib.PDFName;
  var dict = ir.xobj.dict;
  var filter = String((dict && dict.lookup) ? (dict.lookup(N.of("Filter")) || "") : "").replace(/[\[\]\/]/g, "");
  var isJpeg = /DCTDecode/.test(filter);
  if (!isJpeg) return "unsupported-codec";
  if (!ir.axisAligned) return "unsupported-geometry";
  var JPEGPatch = getJpegPatch(), JPEGRequant = getJpegRequant();
  if (!JPEGPatch || !JPEGRequant) return "unsupported-codec"; // engines not loaded by caller

  var iw = +String(dict.lookup(N.of("Width"))) || 0;
  var ih = +String(dict.lookup(N.of("Height"))) || 0;
  if (!iw || !ih) return "unsupported-geometry";

  var regions = [];
  boxRectsViewport.forEach(function (rect) {
    if (!rectsOverlap(rect, ir.rect)) return;
    var cx0 = Math.max(rect.x, ir.rect.x), cx1 = Math.min(rect.right, ir.rect.right);
    var cy0 = Math.max(rect.top, ir.rect.top), cy1 = Math.min(rect.bottom, ir.rect.bottom);
    if (cx1 <= cx0 || cy1 <= cy0) return;
    var d0 = toDevice(analysis, cx0, cy0), d1 = toDevice(analysis, cx1, cy1);
    var dxMin = Math.min(d0[0], d1[0]), dxMax = Math.max(d0[0], d1[0]);
    var dyMin = Math.min(d0[1], d1[1]), dyMax = Math.max(d0[1], d1[1]);
    var u0 = (dxMin - ir.devRect.x0) / (ir.devRect.x1 - ir.devRect.x0);
    var u1 = (dxMax - ir.devRect.x0) / (ir.devRect.x1 - ir.devRect.x0);
    var v0 = (dyMin - ir.devRect.y0) / (ir.devRect.y1 - ir.devRect.y0);
    var v1 = (dyMax - ir.devRect.y0) / (ir.devRect.y1 - ir.devRect.y0);
    u0 = Math.max(0, Math.min(1, u0)); u1 = Math.max(0, Math.min(1, u1));
    v0 = Math.max(0, Math.min(1, v0)); v1 = Math.max(0, Math.min(1, v1));
    var px0 = Math.floor(u0 * iw), px1 = Math.ceil(u1 * iw);
    // image row 0 = TOP of the unit square (v=1)
    var py0 = Math.floor((1 - v1) * ih), py1 = Math.ceil((1 - v0) * ih);
    var w = px1 - px0, h = py1 - py0;
    if (w > 0 && h > 0) regions.push({ x: px0, y: py0, w: w, h: h, rgb: fillRgb255 });
  });
  if (!regions.length) return "skipped";
  var patched;
  try { patched = JPEGPatch.patchRegions(ir.xobj.stream.contents, regions); }
  catch (e) { return "unsupported-geometry"; }
  if (!patched) return "unsupported-geometry"; // patcher itself refused (non-standard chroma table, CMYK, etc.)
  return { patchedBytes: patched };
}

/* ═══════════════ referent-checked garbage collector ═══════════════
   This pdf-lib fork's save() serialises every object it has ever registered, with no
   reachability pruning. Any object this engine unlinks (an old /Contents stream, a
   replaced image, a removed annotation + its /AP, the old /Metadata) would otherwise
   survive in the output as a byte-identical, fully recoverable orphan — this was the
   worst finding of the 2026-08-18 check (an "erased" scan's original JPEG recoverable
   byte-for-byte). Deleting unconditionally is not safe either: a /Contents stream (or
   any object) SHARED by two pages must only be deleted once nothing else references it
   — this sweep runs once, after every edit, and checks every surviving object's own
   raw structure for the ref before deleting it. */
function refKey(ref) { return ref.objectNumber + "_" + ref.generationNumber; }
function containsRefAnywhere(PDFLib, node, target, depth) {
  if (node == null || depth > 24) return false;
  if (node instanceof PDFLib.PDFRef) return node.objectNumber === target.objectNumber && node.generationNumber === target.generationNumber;
  if (node instanceof PDFLib.PDFDict) {
    var entries = node.entries();
    for (var i = 0; i < entries.length; i++) if (containsRefAnywhere(PDFLib, entries[i][1], target, depth + 1)) return true;
    return false;
  }
  if (node instanceof PDFLib.PDFArray) {
    for (var j = 0; j < node.size(); j++) if (containsRefAnywhere(PDFLib, node.get(j), target, depth + 1)) return true;
    return false;
  }
  if (node.dict) return containsRefAnywhere(PDFLib, node.dict, target, depth + 1);
  return false;
}
function sweepOrphans(PDFLib, doc, candidates) {
  var uniq = [], seen = {};
  (candidates || []).forEach(function (r) { if (!r || !(r instanceof PDFLib.PDFRef)) return; var k = refKey(r); if (!seen[k]) { seen[k] = 1; uniq.push(r); } });
  if (!uniq.length) return { removed: [], kept: [] };
  var all = doc.context.enumerateIndirectObjects();
  var removed = [], kept = [];
  var rootRef = null;
  try { rootRef = doc.context.trailerInfo.Root; } catch (e) {}
  uniq.forEach(function (target) {
    var referenced = rootRef && rootRef instanceof PDFLib.PDFRef && refKey(rootRef) === refKey(target);
    if (!referenced) {
      for (var i = 0; i < all.length; i++) {
        var ref = all[i][0], obj = all[i][1];
        if (refKey(ref) === refKey(target)) continue; // never counts as its own referent
        if (containsRefAnywhere(PDFLib, obj, target, 0)) { referenced = true; break; }
      }
    }
    if (referenced) { kept.push(target); }
    else {
      try { doc.context.delete(target); removed.push(target); }
      catch (e) { kept.push(target); }
    }
  });
  return { removed: removed, kept: kept };
}

/* ═══════════════ form fields: clear /V, /DV, /TU, /RV + drop /AP up the /Parent chain ═══════════════
   Covers both real-world AcroForm shapes: a "merged" widget that carries /FT and /V on
   itself (the common case — verified against a filled irs-w9-form.pdf fixture), and the
   classic separate-field-with-Kids-widgets shape where /V lives on an ancestor (verified
   against a constructed fixture — see _qa/test_redact_engine.mjs §9b, added 2026-08-18
   round 2 after an independent check found the original W9 fixture never exercised the
   /Parent climb at all, since its widget IS the field).
   /DV (default value) is cleared too — round-2 finding: Acrobat's "Reset Form" writes
   /DV back into /V, so leaving /DV behind is one reader click from restoring the
   redacted value. /TU (tooltip) and /RV (rich-text value, can carry its own copy of the
   text in an XFA-style RTF/XML string) are cleared for the same reason: any field key
   capable of carrying the field's text content is in scope, not just /V.
   Does NOT touch /AcroForm/Fields — the (now valueless) field object is left registered,
   which the GC sweep will correctly keep if anything (the Fields array, a Parent/Kids
   chain) still points to it. Only /AP sub-streams are queued for the GC sweep. */
var FORM_VALUE_KEYS = ["V", "DV", "RV"];
/** Clears /V, /DV, /RV (and drops /TU, /AP) up the /Parent chain. Returns
 *  { touched, values } — `values` is the pre-clear TEXT of every value key found, so the
 *  caller can feed it into the verify/scrub needle list (a form field's secret has no
 *  page text record to auto-derive a needle from otherwise — see applyRedactions). */
function clearFormFieldChain(PDFLib, doc, annotDict, orphanCandidates) {
  var N = PDFLib.PDFName;
  var d = annotDict, guard = 0, touched = false, values = [];
  while (d && guard++ < 10) {
    try {
      FORM_VALUE_KEYS.forEach(function (key) {
        if (d.has && d.has(N.of(key))) {
          try { var old = d.get(N.of(key)); if (old && old.decodeText) values.push(old.decodeText()); else if (old) values.push(String(old)); } catch (e0) {}
          d.set(N.of(key), PDFLib.PDFString.of("")); touched = true;
        }
      });
      if (d.has && d.has(N.of("TU"))) { d.delete(N.of("TU")); touched = true; }
    } catch (e) {}
    try {
      var apRaw = d.get ? d.get(N.of("AP")) : null;
      if (apRaw) {
        try {
          var apObj = apRaw instanceof PDFLib.PDFRef ? doc.context.lookup(apRaw) : apRaw;
          if (apObj && apObj.keys) apObj.keys().forEach(function (k) { var sub = apObj.get(k); if (sub) orphanCandidates.push(sub); });
        } catch (e2) {}
        if (apRaw instanceof PDFLib.PDFRef) orphanCandidates.push(apRaw);
        d.delete(N.of("AP"));
        touched = true;
      }
    } catch (e3) {}
    var parentRaw = null;
    try { parentRaw = d.get ? d.get(N.of("Parent")) : null; } catch (e4) {}
    d = (parentRaw instanceof PDFLib.PDFRef) ? doc.context.lookup(parentRaw) : null;
  }
  return { touched: touched, values: values };
}

/* ═══════════════ annotation removal (+ form field clearing, + GC queueing) ═══════════════ */
function removeAnnotationsInRects(PDFLib, doc, analysis, pageIndex, boxRectsViewport, orphanCandidates) {
  var N = PDFLib.PDFName;
  var page = doc.getPage(pageIndex);
  var annots = page.node.Annots ? page.node.Annots() : null;
  if (!annots || !annots.size) return { removed: 0, fieldsCleared: 0, clearedValues: [] };
  var keep = [], removed = 0, fieldsCleared = 0, clearedValues = [];
  for (var i = 0; i < annots.size(); i++) {
    var a = annots.lookup(i);
    var rawRef = annots.get(i);
    var rectArr = a && a.lookup ? a.lookup(N.of("Rect")) : null;
    var hit = false;
    if (rectArr && rectArr.size && rectArr.size() === 4) {
      var v0 = rectArr.lookup(0).asNumber(), v1 = rectArr.lookup(1).asNumber();
      var v2 = rectArr.lookup(2).asNumber(), v3 = rectArr.lookup(3).asNumber();
      var ax0 = Math.min(v0, v2), ax1 = Math.max(v0, v2), ay0 = Math.min(v1, v3), ay1 = Math.max(v1, v3);
      var s0 = toViewportTL(analysis, ax0, ay0), s1 = toViewportTL(analysis, ax1, ay1);
      var annotRectV = {
        x: Math.min(s0[0], s1[0]), right: Math.max(s0[0], s1[0]),
        top: Math.min(s0[1], s1[1]), bottom: Math.max(s0[1], s1[1])
      };
      hit = boxRectsViewport.some(function (r) { return rectsOverlap(r, annotRectV); });
    }
    if (hit) {
      removed++;
      if (a) {
        var cleared = clearFormFieldChain(PDFLib, doc, a, orphanCandidates);
        if (cleared.touched) fieldsCleared++;
        if (cleared.values.length) clearedValues = clearedValues.concat(cleared.values);
      }
      if (rawRef instanceof PDFLib.PDFRef) orphanCandidates.push(rawRef);
    } else keep.push(rawRef);
  }
  if (removed) {
    if (keep.length) {
      var newArr = PDFLib.PDFArray.withContext(doc.context);
      keep.forEach(function (ref) { newArr.push(ref); });
      page.node.set(N.of("Annots"), newArr);
    } else {
      page.node.delete(N.of("Annots"));
    }
  }
  return { removed: removed, fieldsCleared: fieldsCleared, clearedValues: clearedValues };
}

/* ═══════════════ sanitize pass (metadata / XMP / JS / embedded files) ═══════════════
   Round-2 finding (Counterexample C): `doc.setTitle("")` etc. only clear the SIX standard
   Info keys pdf-lib knows about — a Word/SharePoint export's custom document-properties
   dictionary (company name, publication date, ...) lives under OTHER Info keys and, on
   `nist-800-63b.pdf`, survived `sanitize:true` verbatim. Enumerate and clear the Info
   dict's keys GENERICALLY (whatever they are) instead of allow-listing six names, and do
   the same for the catalog's non-standard keys and /PieceInfo (Word/Office producer
   metadata, catalog-level, entirely outside /Info). */
var CATALOG_STANDARD_KEYS = {
  Type: 1, Version: 1, Extensions: 1, Pages: 1, PageLabels: 1, Names: 1, Dests: 1,
  ViewerPreferences: 1, PageLayout: 1, PageMode: 1, Outlines: 1, Threads: 1, OpenAction: 1,
  AA: 1, URI: 1, AcroForm: 1, Metadata: 1, StructTreeRoot: 1, MarkInfo: 1, Lang: 1,
  SpiderInfo: 1, OutputIntents: 1, PieceInfo: 1, OCProperties: 1, Perms: 1, Legal: 1,
  Requirements: 1, Collection: 1, NeedsRendering: 1, ID: 1
};
function sanitizeDoc(PDFLib, doc, orphanCandidates) {
  var N = PDFLib.PDFName;
  var report = { info: false, infoKeysCleared: 0, xmp: false, javascript: false, embeddedFiles: false, openAction: false, pieceInfo: false, catalogCustomKeysCleared: 0 };
  try {
    var infoRaw = doc.context.trailerInfo.Info;
    var infoDict = infoRaw instanceof PDFLib.PDFRef ? doc.context.lookup(infoRaw) : infoRaw;
    if (infoDict && infoDict.keys) {
      infoDict.keys().forEach(function (k) {
        try { infoDict.set(k, PDFLib.PDFString.of("")); report.infoKeysCleared++; } catch (e) {}
      });
      report.info = report.infoKeysCleared > 0;
    }
  } catch (e) {}
  var cat = doc.catalog;
  // /PieceInfo — Office/Word producer metadata (custom properties, revision history) that
  // lives at the CATALOG level, entirely outside /Info. Drop the object outright.
  try {
    if (cat && cat.has(N.of("PieceInfo"))) {
      var pieceRaw = cat.get(N.of("PieceInfo"));
      if (pieceRaw instanceof PDFLib.PDFRef) orphanCandidates.push(pieceRaw);
      cat.delete(N.of("PieceInfo"));
      report.pieceInfo = true;
    }
  } catch (e) {}
  // any OTHER non-standard catalog key (custom producer extensions) — same treatment
  try {
    if (cat && cat.keys) {
      cat.keys().forEach(function (k) {
        var name = String(k).replace(/^\//, "");
        if (CATALOG_STANDARD_KEYS[name]) return;
        try {
          var raw = cat.get(k);
          if (raw instanceof PDFLib.PDFRef) orphanCandidates.push(raw);
          cat.delete(k);
          report.catalogCustomKeysCleared++;
        } catch (e2) {}
      });
    }
  } catch (e) {}
  try {
    if (cat && cat.has(N.of("Metadata"))) {
      var oldMeta = cat.get(N.of("Metadata"));
      if (oldMeta instanceof PDFLib.PDFRef) orphanCandidates.push(oldMeta);
      // write a fresh, empty XMP packet in its place — sanitize means the metadata
      // OBJECT is gone (queued for the GC sweep below) and replaced, not merely unlinked
      var xmp = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
        '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt>' +
        '<rdf:li xml:lang="x-default"></rdf:li></rdf:Alt></dc:title></rdf:Description>' +
        "</rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>";
      var enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
      var xmpBytes = enc ? enc.encode(xmp) : (function () { var u = new Uint8Array(xmp.length); for (var i = 0; i < xmp.length; i++) u[i] = xmp.charCodeAt(i) & 255; return u; })();
      var stream = doc.context.stream(xmpBytes, { Type: "Metadata", Subtype: "XML" });
      var ref = doc.context.register(stream);
      cat.set(N.of("Metadata"), ref);
      report.xmp = true;
    }
  } catch (e) {}
  try { if (cat && cat.has(N.of("OpenAction"))) { cat.delete(N.of("OpenAction")); report.openAction = true; } } catch (e) {}
  try {
    var names = cat && cat.lookup ? cat.lookup(N.of("Names")) : null;
    if (names && names.has) {
      if (names.has(N.of("JavaScript"))) { names.delete(N.of("JavaScript")); report.javascript = true; }
      if (names.has(N.of("EmbeddedFiles"))) { names.delete(N.of("EmbeddedFiles")); report.embeddedFiles = true; }
    }
  } catch (e) {}
  // /Outlines /Title — round-2 (checker addendum): the generic rawByteVerify now catches
  // this too. A bookmark pane routinely repeats the FULL document title verbatim (measured
  // on nist-800-63b.pdf: "NIST SP 800-63B, Digital Identity Guidelines: Authentication and
  // Lifecycle Management" as an outline /Title, entirely separate from /Info and /PieceInfo).
  // sanitize wipes every title unconditionally (not needle-gated — this is metadata
  // regardless of whether a caller happened to name it as a redaction target) while
  // leaving the outline TREE STRUCTURE intact (navigation still works, just untitled).
  try {
    var outlinesRaw0 = cat && cat.get ? cat.get(N.of("Outlines")) : null;
    var outlines0 = outlinesRaw0 instanceof PDFLib.PDFRef ? doc.context.lookup(outlinesRaw0) : outlinesRaw0;
    if (outlines0) {
      var firstRaw0 = outlines0.get ? outlines0.get(N.of("First")) : null;
      var queue0 = firstRaw0 ? [firstRaw0] : [];
      var seen0 = {}, n0 = 0;
      while (queue0.length && n0++ < 5000) {
        var r0 = queue0.shift();
        var k0 = r0 instanceof PDFLib.PDFRef ? refKey(r0) : String(r0);
        if (seen0[k0]) continue;
        seen0[k0] = 1;
        var item0 = r0 instanceof PDFLib.PDFRef ? doc.context.lookup(r0) : r0;
        if (!item0) continue;
        try { if (item0.has && item0.has(N.of("Title"))) { item0.set(N.of("Title"), PDFLib.PDFString.of("")); report.outlineTitlesCleared = (report.outlineTitlesCleared || 0) + 1; } } catch (e) {}
        try { var nx0 = item0.get ? item0.get(N.of("Next")) : null; if (nx0) queue0.push(nx0); } catch (e) {}
        try { var kf0 = item0.get ? item0.get(N.of("First")) : null; if (kf0) queue0.push(kf0); } catch (e) {}
      }
    }
  } catch (e) {}
  return report;
}

/* ═══════════════ /Outlines /Title + /StructTreeRoot /ActualText,/Alt scrub ═══════════════
   Best-effort, needle-driven (the exact matched substrings from a redactText/redactPattern
   call): a title or struct-tree string that CONTAINS a needle is cleared to "" and counted;
   walks are depth- and node-capped and every step is try/catch-guarded — a malformed or
   exotic outline/struct tree degrades to "0 scrubbed", never throws. */
function scrubOutlinesAndStructTree(PDFLib, doc, needles) {
  var N = PDFLib.PDFName;
  var result = { outlines: 0, structTree: 0 };
  if (!needles || !needles.length) return result;
  var lowerNeedles = needles.map(function (s) { return String(s).toLowerCase(); }).filter(Boolean);
  if (!lowerNeedles.length) return result;
  function textHasNeedle(s) {
    var low = s.toLowerCase();
    return lowerNeedles.some(function (n) { return low.indexOf(n) >= 0; });
  }
  try {
    var cat = doc.catalog;
    var outlinesRaw = cat && cat.get ? cat.get(N.of("Outlines")) : null;
    var outlines = outlinesRaw instanceof PDFLib.PDFRef ? doc.context.lookup(outlinesRaw) : outlinesRaw;
    if (outlines) {
      var firstRaw = outlines.get ? outlines.get(N.of("First")) : null;
      var queue = firstRaw ? [firstRaw] : [];
      var seen = {}, nodeCount = 0;
      while (queue.length && nodeCount++ < 5000) {
        var ref = queue.shift();
        var key = ref instanceof PDFLib.PDFRef ? refKey(ref) : String(ref);
        if (seen[key]) continue;
        seen[key] = 1;
        var item = ref instanceof PDFLib.PDFRef ? doc.context.lookup(ref) : ref;
        if (!item) continue;
        try {
          var titleRaw = item.get ? item.get(N.of("Title")) : null;
          if (titleRaw && titleRaw.decodeText) {
            var text = titleRaw.decodeText();
            if (textHasNeedle(text)) { item.set(N.of("Title"), PDFLib.PDFString.of("")); result.outlines++; }
          }
        } catch (e) {}
        try { var nextRaw = item.get ? item.get(N.of("Next")) : null; if (nextRaw) queue.push(nextRaw); } catch (e) {}
        try { var kidFirst = item.get ? item.get(N.of("First")) : null; if (kidFirst) queue.push(kidFirst); } catch (e) {}
      }
    }
  } catch (e) {}
  try {
    var structRaw = doc.catalog && doc.catalog.get ? doc.catalog.get(N.of("StructTreeRoot")) : null;
    var struct = structRaw instanceof PDFLib.PDFRef ? doc.context.lookup(structRaw) : structRaw;
    if (struct) {
      var walked = 0;
      var visit = function (node, depth) {
        if (!node || depth > 40 || walked++ > 8000) return;
        var dict = node instanceof PDFLib.PDFRef ? doc.context.lookup(node) : node;
        if (!dict || !dict.get) return;
        ["ActualText", "Alt"].forEach(function (key) {
          try {
            var raw = dict.get(N.of(key));
            if (raw && raw.decodeText) {
              var t = raw.decodeText();
              if (textHasNeedle(t)) { dict.set(N.of(key), PDFLib.PDFString.of("")); result.structTree++; }
            }
          } catch (e) {}
        });
        try {
          var kRaw = dict.get(N.of("K"));
          var k = kRaw instanceof PDFLib.PDFRef ? doc.context.lookup(kRaw) : kRaw;
          if (k instanceof PDFLib.PDFArray) { for (var i = 0; i < k.size(); i++) visit(k.get(i), depth + 1); }
          else if (k && k.get) visit(kRaw, depth + 1);
        } catch (e) {}
      };
      var rootK = struct.get ? struct.get(N.of("K")) : null;
      var rootKres = rootK instanceof PDFLib.PDFRef ? doc.context.lookup(rootK) : rootK;
      if (rootKres instanceof PDFLib.PDFArray) { for (var ri = 0; ri < rootKres.size(); ri++) visit(rootKres.get(ri), 0); }
      else if (rootK) visit(rootK, 0);
    }
  } catch (e) {}
  return result;
}

/* ═══════════════ raw-byte verification — the ONLY thing report.verified may be based on ═══════════════
   Round-2 finding (R2-1, ship-blocker): the previous version's header claimed decoding
   every stream "including /ObjStm" made this exhaustive. That was FALSE AS WRITTEN — the
   scan filtered to `obj instanceof PDFRawStream`, which skips every plain PDFDict, and a
   compressed object stream's members are exactly plain PDFDicts once pdf-lib expands
   them. The correct mechanism (verified by inspection and by a constructed /ObjStm
   fixture): pdf-lib's PARSER expands every /ObjStm container into its member objects and
   DELETES the container from the context at LOAD TIME — no /ObjStm object survives to be
   decoded, and `enumerateIndirectObjects()` already returns the expanded members as
   ordinary objects. The bug was never "we forgot to decode /ObjStm streams" — it was "we
   skip every object that ISN'T a stream", and that silently included /Info, /Outlines
   items, struct-tree elements and AcroForm field dicts regardless of whether they
   originated inside an /ObjStm or were always loose top-level objects.
   Fixed by NOT filtering: every object `enumerateIndirectObjects()` returns is scanned —
   streams are decoded and searched byte-for-byte (Flate, ASCII/UTF-16BE(+BOM)/hex-string
   needle variants, for arbitrary binary content like a content stream's `Tj` operands);
   every non-stream object's PDFString/PDFHexString VALUES are walked recursively
   (collectStrings, below) and decoded to plain text, then matched with a case-insensitive
   substring test — this also means the scan needs no allow-list of "where metadata
   lives" (/Info, /PieceInfo, /AcroForm field /DV, /Outlines /Title, /StructTreeRoot
   /ActualText, /OCProperties, /Names, ...): every dict/array in the file is walked
   generically, so a leak in a key nobody thought to name is still caught. */
function collectStrings(PDFLib, node, depth, out) {
  if (node == null || depth > 30 || out.length > 20000) return;
  if (node instanceof PDFLib.PDFString || node instanceof PDFLib.PDFHexString) {
    try { out.push(node.decodeText()); return; } catch (e) {}
    try { out.push(node.asString()); } catch (e2) {}
    return;
  }
  // Round-3 finding (N3b, checker): a /Name can carry a needle both as a VALUE (e.g. an
  // annotation's /NM, a font's /BaseFont subset+family) and as a dict KEY (e.g. a
  // /Resources /Font sub-dictionary keyed by the font's own name, or an /OCProperties
  // /OCGs entry). Names use their own #xx-hex-escape encoding, decoded here via
  // decodeText() (verified: PDFName.of("Hello#20World").decodeText() === "Hello World").
  // This was the ONE gap the round-3 independent oracle caught that this scanner missed —
  // collectStrings previously only ever looked at PDFString/PDFHexString VALUES.
  if (node instanceof PDFLib.PDFName) {
    try { out.push(node.decodeText()); return; } catch (e) {}
    try { out.push(String(node).replace(/^\//, "")); } catch (e2) {}
    return;
  }
  if (node instanceof PDFLib.PDFDict) {
    var entries = node.entries();
    for (var i = 0; i < entries.length; i++) {
      collectStrings(PDFLib, entries[i][0], depth + 1, out); // the KEY (itself a PDFName)
      collectStrings(PDFLib, entries[i][1], depth + 1, out); // the VALUE
    }
    return;
  }
  if (node instanceof PDFLib.PDFArray) {
    for (var j = 0; j < node.size(); j++) collectStrings(PDFLib, node.get(j), depth + 1, out);
    return;
  }
  // PDFRef is deliberately NOT followed — every object it could point to is visited
  // directly by the enumerateIndirectObjects() loop below; resolving refs here would
  // either double-count or, on a cyclic graph (e.g. /Parent <-> /Kids), recurse forever.
}
function computeNeedleVariants(needle) {
  var enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  function toBytes(str) {
    if (enc) return enc.encode(str);
    var u = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 255;
    return u;
  }
  function toHex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return out;
  }
  var variants = [];
  var ascii = toBytes(needle);
  variants.push(ascii);
  var u16 = new Uint8Array(needle.length * 2);
  for (var i = 0; i < needle.length; i++) { var c = needle.charCodeAt(i); u16[i * 2] = (c >> 8) & 255; u16[i * 2 + 1] = c & 255; }
  variants.push(u16);
  var u16bom = new Uint8Array(u16.length + 2);
  u16bom[0] = 0xFE; u16bom[1] = 0xFF; u16bom.set(u16, 2);
  variants.push(u16bom);
  [ascii, u16, u16bom].forEach(function (b) {
    var hex = toHex(b);
    variants.push(toBytes(hex.toUpperCase()));
    variants.push(toBytes(hex.toLowerCase()));
  });
  return variants;
}
function bytesIndexOf(hay, needle) {
  if (!needle.length || needle.length > hay.length) return -1;
  var first = needle[0], max = hay.length - needle.length;
  for (var i = 0; i <= max; i++) {
    if (hay[i] !== first) continue;
    var ok = true;
    for (var j = 1; j < needle.length; j++) { if (hay[i + j] !== needle[j]) { ok = false; break; } }
    if (ok) return i;
  }
  return -1;
}
async function rawByteVerify(PDFLib, outBytes, needles) {
  var haystacks = [{ label: "raw file bytes", bytes: outBytes }];
  var stringHaystacks = []; // [{ label, text }] — decoded PDFString/PDFHexString content
  var streamsDecoded = 0, streamsFailed = 0, objectsWalked = 0;
  try {
    var doc = await PDFLib.PDFDocument.load(outBytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    var all = doc.context.enumerateIndirectObjects();
    for (var i = 0; i < all.length; i++) {
      var ref = all[i][0], obj = all[i][1];
      objectsWalked++;
      var isStream = (obj instanceof PDFLib.PDFRawStream) || (obj && obj.dict && obj.contents);
      if (isStream) {
        try {
          var decoded = PDFLib.decodePDFRawStream(obj).decode();
          haystacks.push({ label: "decoded stream obj " + ref.objectNumber, bytes: decoded });
          streamsDecoded++;
        } catch (e) {
          haystacks.push({ label: "raw (undecoded) stream obj " + ref.objectNumber, bytes: obj.contents });
          streamsFailed++;
        }
        // a stream's DICT (e.g. an image XObject's /Name, a Form XObject's own keys) can
        // still carry string values — walk it too, same as any other object
        if (obj.dict) { var collected0 = []; collectStrings(PDFLib, obj.dict, 0, collected0); if (collected0.length) stringHaystacks.push({ label: "obj " + ref.objectNumber + " dict string(s)", text: collected0.join(" ") }); }
      } else {
        var collected = [];
        collectStrings(PDFLib, obj, 0, collected);
        if (collected.length) stringHaystacks.push({ label: "obj " + ref.objectNumber + " string field(s)", text: collected.join(" ") });
      }
    }
  } catch (e) {
    return { pass: null, method: "raw-byte scan could not reload the saved output (" + e.message + ")", findings: [], streamsDecoded: 0, streamsFailed: 0 };
  }
  var findings = [];
  needles.forEach(function (needle) {
    if (!needle) return;
    var variants = computeNeedleVariants(String(needle));
    for (var h = 0; h < haystacks.length; h++) {
      for (var v = 0; v < variants.length; v++) {
        if (bytesIndexOf(haystacks[h].bytes, variants[v]) >= 0) {
          findings.push({ needle: needle, where: haystacks[h].label });
          break;
        }
      }
    }
    var lowNeedle = String(needle).toLowerCase();
    for (var s = 0; s < stringHaystacks.length; s++) {
      if (stringHaystacks[s].text.toLowerCase().indexOf(lowNeedle) >= 0) {
        findings.push({ needle: needle, where: stringHaystacks[s].label });
      }
    }
  });
  return {
    pass: findings.length === 0,
    method: "raw-byte scan: " + objectsWalked + " object(s) enumerated (" + streamsDecoded + " stream(s) decoded" +
      (streamsFailed ? ", " + streamsFailed + " undecodable/raw" : "") + ", " + stringHaystacks.length +
      " non-stream object(s) with string content) — ASCII/UTF-16BE(+BOM)/hex-string variants on bytes, case-insensitive substring on decoded strings",
    findings: findings
  };
}

/* ═══════════════ core: apply a per-page removal plan ═══════════════
   perPageWork: { [pageIndex]: {
     ids?: [record ids already resolved],
     matches?: [{id, text}]  // per-record matched substrings, for collateral reporting
     rects?: [{x,top,right,bottom}]
   } } */
async function applyRedactions(pdfBytes, perPageWork, opts) {
  opts = opts || {};
  var PDFLib = getPDFLib();
  var Ops = getTextOps();
  var Edit = getTextEdit();
  var fillRgb01 = hexToRgb01(opts.fill || "#000000");
  var fillRgb255 = [Math.round(fillRgb01[0] * 255), Math.round(fillRgb01[1] * 255), Math.round(fillRgb01[2] * 255)];
  var pad = opts.pad != null ? opts.pad : 2;

  var doc = await PDFLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });

  var report = {
    pages: [], totalRecordsRemoved: 0, totalAnnotationsRemoved: 0, totalFormFieldsCleared: 0,
    images: [], rasterFallbackPages: [], notRemovable: [], collateral: [], sanitized: null,
    scrubbed: { outlines: 0, structTree: 0 }, thumbsRemoved: 0,
    orphansRemoved: 0, orphansKept: 0,
    verified: null, verifyMethod: null, verifyDetail: null
  };
  var orphanCandidates = [];
  var autoNeedles = []; // actual text of every record this call spliced — see the splice site below

  var pageIdxs = Object.keys(perPageWork).map(Number).sort(function (a, b) { return a - b; });
  for (var pi = 0; pi < pageIdxs.length; pi++) {
    var pageIndex = pageIdxs[pi];
    var work = perPageWork[pageIndex] || {};
    var pageReport = { page: pageIndex, recordsRemoved: 0, annotationsRemoved: 0, formFieldsCleared: 0, imagesPatched: 0, rasterFallback: false, notes: [] };

    var analysis;
    try { analysis = Ops.analyze(PDFLib, doc, pageIndex); }
    catch (e) {
      pageReport.rasterFallback = true;
      pageReport.notes.push("analyze() threw (" + e.message + ") — this page needs the pre-existing whole-page raster fallback; nothing on it was touched by this engine call.");
      report.rasterFallbackPages.push(pageIndex);
      report.pages.push(pageReport);
      continue;
    }

    // ── parity gate: pdf-textops refuses to claim it understood every operator, AND
    //    a Form XObject on the page hides any text drawn through it from pdf-textops
    //    entirely (analysis.notes.formXObjects counts `Do` calls on non-image XObjects) —
    //    per the 2026-08-18 check (B3), that must fail the gate exactly like an unknown
    //    operator, not be silently skipped while the page reports clean. ──
    var unknownOps = Object.keys(analysis.notes.unknownOps || {});
    var formXObjCount = analysis.notes.formXObjects || 0;
    if (unknownOps.length || formXObjCount > 0) {
      pageReport.rasterFallback = true;
      var reasons = [];
      if (unknownOps.length) reasons.push("unrecognised content-stream operator(s) [" + unknownOps.join(", ") + "]");
      if (formXObjCount > 0) reasons.push(formXObjCount + " Form XObject(s) (`/Fm Do`) — any text drawn inside one is invisible to pdf-textops and cannot be proven absent");
      pageReport.notes.push("parity gate failed: " + reasons.join(" and ") +
        " — this page falls back to the existing whole-page raster method for THIS PAGE ONLY. No text/image/annotation edit was applied here.");
      report.rasterFallbackPages.push(pageIndex);
      report.notRemovable.push({ page: pageIndex, reason: reasons.join("; "), rects: (work.rects || []).slice() });
      report.pages.push(pageReport);
      continue;
    }

    // ── resolve which records to delete ──
    var ids = (work.ids || []).slice();
    var boxRects = (work.rects || []).slice();
    if (boxRects.length) {
      boxRects.forEach(function (rect) {
        Edit.recordsInRect(analysis, rect, pad).forEach(function (r) { if (ids.indexOf(r.id) < 0) ids.push(r.id); });
      });
    }
    if (!boxRects.length && ids.length) {
      ids.forEach(function (id) {
        var r = analysis.records.filter(function (rr) { return rr.id === id; })[0];
        if (r) boxRects.push(r.rect);
      });
    }

    // ── collateral disclosure: a record removed via search/pattern that carries MORE
    //    text than the matched substring(s) is over-removal at the finest granularity
    //    the splice primitive offers — name it, per the header's documented promise. ──
    if (work.matches && work.matches.length) {
      var byId = {};
      work.matches.forEach(function (m) { (byId[m.id] = byId[m.id] || []).push(m.text); });
      Object.keys(byId).forEach(function (idStr) {
        var id = +idStr;
        var rec = analysis.records.filter(function (rr) { return rr.id === id; })[0];
        if (!rec) return;
        var matchedJoined = byId[id].join("");
        if (matchedJoined.length < rec.text.length) {
          report.collateral.push({ page: pageIndex, recordText: rec.text, matchedSubstrings: byId[id] });
        }
      });
    }

    if (ids.length) {
      // writeStream() registers a NEW content-stream object and repoints /Contents at it.
      // The old stream(s) are queued for the referent-checked GC sweep below rather than
      // deleted here — a stream SHARED by another (untouched) page must survive; only the
      // final sweep, run after every page's edits are applied, can tell the difference.
      var N0 = PDFLib.PDFName.of("Contents");
      var pageNode0 = doc.getPage(pageIndex).node;
      var oldContents = pageNode0.get(N0);
      if (oldContents instanceof PDFLib.PDFArray) { for (var oi = 0; oi < oldContents.size(); oi++) orphanCandidates.push(oldContents.get(oi)); }
      else if (oldContents instanceof PDFLib.PDFRef) orphanCandidates.push(oldContents);
      // capture the ACTUAL TEXT of every record about to be spliced, before splice() runs —
      // this feeds report.verified + the outline/struct-tree scrub automatically, so the
      // redactRects UI path (which supplies no needles of its own — H7) still gets a real
      // verification instead of always reporting `null`.
      ids.forEach(function (id) {
        var rec = analysis.records.filter(function (rr) { return rr.id === id; })[0];
        if (rec && rec.text) autoNeedles.push(rec.text);
      });
      var newBytes = Ops.splice(analysis, ids);
      Ops.writeStream(PDFLib, doc, pageIndex, newBytes);
      pageReport.recordsRemoved = ids.length;
      report.totalRecordsRemoved += ids.length;
    }
    // "no text records under this box" is only a genuine gap if NOTHING else in the box
    // was handled either — a box drawn purely over a form widget or an image has zero
    // text records by design (an annotation isn't a text-show operator) and must not be
    // reported as an unexplained miss. Decided after images/annotations run, below.
    var noTextRecordsFlag = !ids.length && boxRects.length > 0;

    // ── images intersecting the rects ──
    if (boxRects.length) {
      var imgRegions = locateImageRegions(PDFLib, doc, analysis, pageIndex);
      var pendingImagePatch = [];
      imgRegions.forEach(function (ir) {
        if (!boxRects.some(function (r) { return rectsOverlap(r, ir.rect); })) return;
        var res = tryPatchImage(PDFLib, doc, analysis, ir, boxRects, fillRgb255);
        if (res && res.patchedBytes) {
          pageReport.imagesPatched++;
          report.images.push({ page: pageIndex, name: ir.name, method: "jpeg-mcu-patch" });
          pendingImagePatch.push({ ir: ir, bytes: res.patchedBytes });
        } else {
          var reason = res === "unsupported-codec"
            ? "image '" + ir.name + "' intersects a redaction box but is not JPEG/DCTDecode — no in-tree re-encoder for its codec here, so this page falls back to whole-page raster"
            : res === "unsupported-geometry"
            ? "image '" + ir.name + "' intersects a redaction box but is placed with a rotated/skewed matrix (or has bad dimensions) — pixel-level patch refused, this page falls back to whole-page raster"
            : null;
          if (reason) {
            pageReport.rasterFallback = true;
            pageReport.notes.push(reason);
            if (report.rasterFallbackPages.indexOf(pageIndex) < 0) report.rasterFallbackPages.push(pageIndex);
          }
        }
      });
      for (var pp = 0; pp < pendingImagePatch.length; pp++) {
        var job = pendingImagePatch[pp];
        try {
          var newImg = await doc.embedJpg(job.bytes);
          var N = PDFLib.PDFName;
          var res2 = doc.getPage(pageIndex).node.Resources();
          var xd2 = res2.lookup(N.of("XObject"));
          // the PRE-erase image object is queued for the GC sweep, not left as a
          // recoverable orphan (the 2026-08-18 check's single worst finding)
          if (job.ir.xobj && job.ir.xobj.ref instanceof PDFLib.PDFRef) orphanCandidates.push(job.ir.xobj.ref);
          xd2.set(N.of(job.ir.name), newImg.ref);
        } catch (e) {
          pageReport.notes.push("image patch for '" + job.ir.name + "' was computed but could not be embedded (" + e.message + ") — falling back to raster for this page.");
          pageReport.rasterFallback = true;
          pageReport.imagesPatched--;
          if (report.rasterFallbackPages.indexOf(pageIndex) < 0) report.rasterFallbackPages.push(pageIndex);
        }
      }
    }

    // ── annotations intersecting the rects (+ form field /V, /AP clearing) ──
    if (boxRects.length) {
      var annRes = removeAnnotationsInRects(PDFLib, doc, analysis, pageIndex, boxRects, orphanCandidates);
      pageReport.annotationsRemoved = annRes.removed;
      pageReport.formFieldsCleared = annRes.fieldsCleared;
      report.totalAnnotationsRemoved += annRes.removed;
      report.totalFormFieldsCleared += annRes.fieldsCleared;
      // a cleared form field's old /V, /DV, /RV text has no page text-record to auto-derive
      // a verify needle from (the widget itself isn't a text-show operator) — feed it in
      // directly, so a redaction that ONLY touches a form field (Counterexample B's shape)
      // still gets a real report.verified instead of an unhelpful `null`.
      if (annRes.clearedValues && annRes.clearedValues.length) autoNeedles = autoNeedles.concat(annRes.clearedValues);
    }

    if (noTextRecordsFlag && !pageReport.imagesPatched && !pageReport.annotationsRemoved) {
      pageReport.notes.push("no text-show records found under the marked rectangle(s) — if the content is text rendered as vector outline paths or a Type3 glyph, pdf-textops cannot see it and cannot remove it. Only the visual black box below was drawn; this is reported, not silently claimed as removed.");
      report.notRemovable.push({ page: pageIndex, reason: "no stream text records under rect (possibly vector-outlined text / Type3)", rects: boxRects });
    }

    // ── /Thumb is a raster of the PRE-redaction page — drop it on every page this
    //    engine actually edited (gate already passed, so we reach here) ──
    if (ids.length || (boxRects.length && (pageReport.imagesPatched || pageReport.annotationsRemoved))) {
      try {
        var NT = PDFLib.PDFName.of("Thumb");
        var pnode = doc.getPage(pageIndex).node;
        if (pnode.has && pnode.has(NT)) {
          var thumbRaw = pnode.get(NT);
          if (thumbRaw instanceof PDFLib.PDFRef) { orphanCandidates.push(thumbRaw); report.thumbsRemoved++; }
          pnode.delete(NT);
        }
      } catch (e) {}
    }

    // ── visual mark (black rect) — a pure cosmetic overlay: the text under it, if any
    //    existed, is already gone via splice() above; this never substitutes for removal ──
    //
    // Round-4 fix (checker: check-w1-2.md §6, routed from W1-2 — "not theirs", a
    // pre-existing engine bug). `page.drawRectangle()` pushes a raw content-stream `re`
    // operator: pdf-lib's implementation (verified by reading its source, `drawRectangle`
    // in pdf-lib.min.js) applies NO rotation compensation and NO MediaBox-origin offset —
    // `x`/`y` land exactly where given, in the page's own DEFAULT USER SPACE (the same
    // numeric axes as its MediaBox; /Rotate is a pure VIEWING transform a reader applies
    // afterwards, it never touches how content-stream coordinates are interpreted).
    // `rect` here is in the VIEWPORT/top-left convention documented at the top of this
    // file — rotated-for-display, top-down, with the box (CropBox-if-present-else-
    // MediaBox) origin already subtracted (this is PDFTextOps.analyze()'s own
    // record.rect convention, and what `t/redact-pdf.js` actually sends: pdf.js viewport
    // pixel fractions, i.e. rotated display space — confirmed by reading its call site).
    // The OLD code treated `rect.x`/`rect.bottom` as already being raw content-stream
    // coordinates needing only a y-flip — wrong on two independent axes:
    //   (a) any non-zero MediaBox/CropBox origin was silently dropped (measured: a
    //       [100 50 695 892] MediaBox displaced the drawn box by exactly (-100, +50));
    //   (b) any /Rotate 90/180/270 page got NO visible mark at all (0 newly-blackened
    //       pixels — the rect landed off-canvas or transposed).
    // Fix: run the SAME inverse transform already proven correct for image-patch
    // geometry (`toDevice`, validated by an independent checker at all four rotations in
    // round 1) on the rect's corners, take the axis-aligned bounding box of the result
    // (a 90°-multiple rotation of an axis-aligned rect is still axis-aligned), and draw
    // THAT in content-stream space. One function, already exercised elsewhere in this
    // file — no new geometry code, no new failure surface. */
    if (opts.mark !== false && boxRects.length) {
      var page = doc.getPage(pageIndex);
      boxRects.forEach(function (rect) {
        var d0 = toDevice(analysis, rect.x, rect.top);
        var d1 = toDevice(analysis, rect.right, rect.bottom);
        var dx0 = Math.min(d0[0], d1[0]), dx1 = Math.max(d0[0], d1[0]);
        var dy0 = Math.min(d0[1], d1[1]), dy1 = Math.max(d0[1], d1[1]);
        page.drawRectangle({
          x: dx0, y: dy0,
          width: Math.max(0, dx1 - dx0), height: Math.max(0, dy1 - dy0),
          color: PDFLib.rgb(fillRgb01[0], fillRgb01[1], fillRgb01[2])
        });
      });
    }

    report.pages.push(pageReport);
  }

  if (opts.sanitize) report.sanitized = sanitizeDoc(PDFLib, doc, orphanCandidates);

  // needles = whatever the caller explicitly asked to verify, UNION the actual text of
  // every record this call spliced (autoNeedles) — the latter means redactRects (which
  // has no query/pattern of its own) still gets real verification + scrub coverage (H7).
  var needles = (opts.verifyStrings || []).concat(autoNeedles).filter(Boolean);
  report.autoVerifyStrings = autoNeedles;
  if (needles.length) report.scrubbed = scrubOutlinesAndStructTree(PDFLib, doc, needles);

  var gc = sweepOrphans(PDFLib, doc, orphanCandidates);
  report.orphansRemoved = gc.removed.length;
  report.orphansKept = gc.kept.length; // kept = still referenced elsewhere (e.g. a shared /Contents) — correctly NOT deleted

  var outBytes = await doc.save();

  // ── report.verified is DELIBERATELY NOT computed here. ──
  // Round-4 finding (checker/implementer, mixed-split.pdf): redactText/redactPattern learn
  // about DISQUALIFYING facts — a Tj-split survivor (splitMatches), a page hidden inside a
  // Form XObject (formXObjectPages) — only in their OWN per-page scan loop, which runs
  // BEFORE this function is called, but they used to push those facts into
  // `result.report.notRemovable` only AFTER calling applyRedactions and getting a report
  // back. If verified were computed in here, it would be computed against a `notRemovable`
  // that had not been fully assembled yet — a real match on page 1 could raw-byte-verify
  // clean while `splitMatches` on page 2 still named a page holding the SAME needle (split
  // across Tj operators, so absent as a contiguous byte run — the raw scan is honestly
  // right about bytes, but the page is not clean) — and `verified` would read `true`
  // anyway, because its own downgrade check ran too early to see the disqualifier.
  // The only correct point to compute `verified` is after EVERY caller — this function and
  // whichever public wrapper called it — has finished appending to `notRemovable` /
  // `rasterFallbackPages` / `formXObjectPages`. So this function stops at storing what a
  // final verification NEEDS (the needle list and the raw bytes) and every public entry
  // point (`redactRects`, `redactText`, `redactPattern`) calls `finalizeVerified()` as its
  // LAST step, after any of its own disqualifying pushes.
  report.verifyNeedles = needles;
  // "work was attempted" (as opposed to an unsolicited search/pattern call that matched
  // NOTHING anywhere, H6) is PRESENCE of per-page work, not its success — a page that had a
  // match but then failed the parity gate is still "attempted work" whose failure must
  // downgrade `verified` to false (via the `clean` check in finalizeVerified), not silently
  // read as null the way a genuine no-op does.
  report.hadWork = pageIdxs.some(function (pIdx) { return (perPageWork[pIdx].ids && perPageWork[pIdx].ids.length) || (perPageWork[pIdx].rects && perPageWork[pIdx].rects.length); });
  return { bytes: outBytes, report: report };
}

/* ═══════════════ verified — computed LAST, after every disqualifier is known ═══════════════
   Called by every public entry point as its final step (never by applyRedactions itself —
   see the comment above its `return`). Grounded ONLY in a raw-byte scan of the saved output
   (never the same decoder that found a match — that would be circular), never true on a
   no-op, and never true while `notRemovable` / `rasterFallbackPages` / `formXObjectPages`
   names anything for this call — which is what makes a Tj-split survivor (present as bytes
   split across two Tj operators, so genuinely absent as one contiguous run — the raw scan
   is not wrong, the page just isn't clean) correctly downgrade `verified` instead of the
   disqualifier arriving too late to be seen. */
async function finalizeVerified(PDFLib, result, opts) {
  var report = result.report;
  var needles = (report.verifyNeedles || []).filter(Boolean);
  var hadWork = !!report.hadWork || !!opts.sanitize || !!(opts.verifyStrings && opts.verifyStrings.length);
  if (!needles.length || opts.noopSearch || !hadWork) {
    report.verified = null;
    report.verifyMethod = !needles.length
      ? "no needles supplied — nothing to verify"
      : "no matching content was found to redact — a no-op is never reported verified";
    return result;
  }
  var vr = await rawByteVerify(PDFLib, result.bytes, needles);
  var clean = report.notRemovable.length === 0 && report.rasterFallbackPages.length === 0 &&
    (!report.formXObjectPages || report.formXObjectPages.length === 0);
  report.verified = vr.pass === null ? null : (vr.pass && clean);
  report.verifyMethod = vr.method + (clean ? "" : " — downgraded: notRemovable/rasterFallback/formXObjectPages is non-empty for this call, so a byte-clean scan alone is not reported as full verification");
  report.verifyDetail = vr.findings;
  return result;
}

/* ═══════════════ public: redactRects ═══════════════ */
async function redactRects(pdfBytes, items, opts) {
  opts = opts || {};
  var perPage = {};
  (items || []).forEach(function (it) {
    perPage[it.page] = perPage[it.page] || { rects: [] };
    perPage[it.page].rects.push(it.rect);
  });
  var result = await applyRedactions(pdfBytes, perPage, opts);
  return finalizeVerified(getPDFLib(), result, opts); // no extra disqualifiers of its own — still the LAST step, for consistency
}

/* ═══════════════ public: redactText — search over the engine's OWN text decode ═══════════════
   Deviation, disclosed: the plan describes finding matches via the pdf.js text layer and
   mapping them onto pdf-textops records. Splicing can only remove whole show-operator
   records (there is no character-level splice primitive), so a position found via pdf.js
   would still have to be mapped back onto a pdf-textops record before anything could be
   deleted. Matching directly against PDFTextOps.analyze()'s own decoded text skips that
   redundant remapping and is what is actually spliced — every match is a record it will
   physically remove. report.collateral names every record removed that carried MORE text
   than the matched substring(s) — record-granularity is the finest the splice primitive
   offers. See the file header for the DOCUMENTED (not silently missed) text-split-across-
   Tj-operators limitation, detected below via a per-page concatenation heuristic. */
function buildMatcher(spec) {
  if (spec.regex) {
    var flags = (spec.regex.flags || "").replace(/g/g, "");
    return new RegExp(spec.regex.source || spec.regex, flags + "g" + (spec.caseSensitive || /i/.test(flags) ? "" : "i"));
  }
  var q = String(spec.query || "");
  var esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (spec.wholeWord) esc = "\\b" + esc + "\\b";
  return new RegExp(esc, "g" + (spec.caseSensitive ? "" : "i"));
}
async function redactText(pdfBytes, spec, opts) {
  spec = spec || {};
  // Round-6 finding (checker): an empty/null/undefined `query` with no `regex` falls
  // through to `buildMatcher` -> `new RegExp("", "gi")`, which matches (a zero-width hit)
  // at the START of every record — every record on every scanned page gets spliced. Not
  // reachable through the shipped UI (which never lets a search box submit empty), but
  // this engine is the intended core of the future Privacy Scanner, called directly by
  // code, not just by a form — so an empty query must fail loudly, not silently redact
  // an entire document. API misuse, not a data condition: throw, don't return a report.
  if (!spec.regex && (spec.query == null || String(spec.query) === "")) {
    throw new Error("redactText: empty query — pass a non-empty `query` string or a `regex`, never both absent (an empty pattern would match, and splice, every record)");
  }
  opts = opts || {};
  var PDFLib = getPDFLib();
  var Ops = getTextOps();
  var probeDoc = await PDFLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  var pageCount = probeDoc.getPageCount();
  var pages = spec.pages || Array.from({ length: pageCount }, function (_, i) { return i; });
  var matcher = buildMatcher(spec);

  var perPage = {}, matchCount = 0, byPage = {}, matchedTexts = [], splitMatches = [], formXObjPages = [];
  for (var i = 0; i < pages.length; i++) {
    var pageIndex = pages[i];
    var analysis;
    try { analysis = Ops.analyze(PDFLib, probeDoc, pageIndex); } catch (e) { continue; }
    var ids = [], matches = [];
    analysis.records.forEach(function (r) {
      var rx = new RegExp(matcher.source, matcher.flags);
      var m;
      while ((m = rx.exec(r.text))) {
        if (ids.indexOf(r.id) < 0) ids.push(r.id);
        matches.push({ id: r.id, text: m[0] });
        matchedTexts.push(m[0]);
        matchCount++;
        if (m.index === rx.lastIndex) rx.lastIndex++; // guard zero-width patterns
      }
    });
    if (ids.length) { perPage[pageIndex] = { ids: ids, matches: matches }; byPage[pageIndex] = ids.length; }

    // Tj-split heuristic (documented limitation, detected not silently missed): does the
    // PAGE, concatenated in stream order across record boundaries, match when no single
    // record did? That is exactly the signature of a name/phrase split across Tj/'/".
    if (!ids.length) {
      try {
        var joined = analysis.records.map(function (r) { return r.text; }).join("");
        var rx2 = new RegExp(matcher.source, matcher.flags);
        if (rx2.test(joined)) {
          splitMatches.push({ page: pageIndex, note: "the search term matches this page's text only when records are concatenated across operator boundaries — likely split across consecutive Tj/'/\" show operators (e.g. \"(Jo) Tj (hn Smi) Tj (th) Tj\"). Not redacted: pdf-textops has no character-level splice, only whole-record removal, and no single record contains the full match." });
        }
      } catch (e) {}
    }

    // Form XObjects hide text from pdf-textops ENTIRELY — a page with one can never be
    // proven clean by this search, whether or not the VISIBLE page text also matched.
    // The per-page parity gate inside applyRedactions only fires for pages already in
    // perPageWork (i.e. that had a visible match); this disclosure covers the other case
    // — a search that found nothing because the only occurrence is inside the XObject.
    if (analysis.notes.formXObjects > 0) {
      formXObjPages.push({
        page: pageIndex, count: analysis.notes.formXObjects,
        note: "this page contains " + analysis.notes.formXObjects + " Form XObject(s) (`/Fm Do`) — text drawn inside one is invisible to pdf-textops, so this search cannot prove the term is absent from it even though the visible page text " + (ids.length ? "also matched and WAS redacted" : "did not match") + "."
      });
    }
  }
  var verifyStrings = (opts.verifyStrings || []).concat(matchedTexts);
  var result = await applyRedactions(pdfBytes, perPage, Object.assign({}, opts, { verifyStrings: verifyStrings }));
  result.report.searchMatches = matchCount;
  result.report.searchMatchesByPage = byPage;
  result.report.splitMatches = splitMatches;
  result.report.formXObjectPages = formXObjPages;
  // Round-4 fix (checker/implementer, mixed-split.pdf): these MUST land in notRemovable
  // BEFORE finalizeVerified runs, not after — see finalizeVerified's own comment. A real
  // match spliced on one page plus a Tj-split survivor named here on ANOTHER page used to
  // raw-byte-verify clean (the split needle is genuinely absent as a contiguous byte run)
  // while `notRemovable` was still empty at the moment `verified` got computed, because
  // that computation used to happen inside applyRedactions — before these pushes existed.
  splitMatches.forEach(function (sm) {
    result.report.notRemovable.push({ page: sm.page, reason: sm.note, rects: [] });
  });
  formXObjPages.forEach(function (fx) {
    result.report.notRemovable.push({ page: fx.page, reason: fx.note, rects: [] });
  });
  return finalizeVerified(PDFLib, result, opts); // LAST — every disqualifier above is now in notRemovable/formXObjectPages
}

/* ═══════════════ public: redactPattern — one or more named presets ═══════════════ */
async function redactPattern(pdfBytes, names, opts) {
  // Round-6 finding (checker), same discipline as redactText's guard: `names` absent,
  // empty, or naming no REAL preset is API misuse, not "nothing matched" — silently
  // returning a report with 0 matches would look identical to a genuine clean scan.
  var list0 = Array.isArray(names) ? names : (names == null ? [] : [names]);
  if (!list0.length || !list0.some(function (n) { return PATTERNS[n]; })) {
    throw new Error("redactPattern: no valid preset name(s) supplied — pass one of " + Object.keys(PATTERNS).join(", "));
  }
  opts = opts || {};
  var list = Array.isArray(names) ? names : [names];
  var PDFLib = getPDFLib();
  var Ops = getTextOps();
  var probeDoc = await PDFLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  var pageCount = probeDoc.getPageCount();
  var pages = opts.pages || Array.from({ length: pageCount }, function (_, i) { return i; });

  var perPage = {}, byPreset = {}, total = 0, matchedTexts = [], formXObjPages = [];
  for (var pI = 0; pI < pages.length; pI++) {
    var pageIndex = pages[pI];
    var analysis;
    try { analysis = Ops.analyze(PDFLib, probeDoc, pageIndex); } catch (e) { continue; }
    var ids = [], matches = [];
    list.forEach(function (name) {
      var pat = PATTERNS[name];
      if (!pat) return;
      byPreset[name] = byPreset[name] || 0;
      analysis.records.forEach(function (r) {
        var rx = new RegExp(pat.regex.source, pat.regex.flags.indexOf("g") < 0 ? pat.regex.flags + "g" : pat.regex.flags);
        var m;
        while ((m = rx.exec(r.text))) {
          if (pat.validate && !pat.validate(m[0])) continue;
          if (ids.indexOf(r.id) < 0) ids.push(r.id);
          matches.push({ id: r.id, text: m[0] });
          matchedTexts.push(m[0]);
          total++;
          byPreset[name]++;
        }
      });
    });
    if (ids.length) perPage[pageIndex] = { ids: ids, matches: matches };

    // same Form-XObject blind-spot disclosure as redactText — see its comment for why
    // this must be checked independent of whether the visible page text matched.
    if (analysis.notes.formXObjects > 0) {
      formXObjPages.push({
        page: pageIndex, count: analysis.notes.formXObjects,
        note: "this page contains " + analysis.notes.formXObjects + " Form XObject(s) (`/Fm Do`) — text drawn inside one is invisible to pdf-textops, so pattern matching cannot prove a planted pattern is absent from it even though the visible page text " + (ids.length ? "also matched and WAS redacted" : "did not match") + "."
      });
    }
  }

  var verifyStrings = (opts.verifyStrings || []).concat(matchedTexts);
  var result = await applyRedactions(pdfBytes, perPage, Object.assign({}, opts, { verifyStrings: verifyStrings }));
  result.report.patternMatches = total;
  result.report.patternMatchesByPreset = byPreset;
  result.report.formXObjectPages = formXObjPages;
  // same ordering fix as redactText — see finalizeVerified's comment: this MUST land in
  // notRemovable before finalizeVerified runs, never after.
  formXObjPages.forEach(function (fx) { result.report.notRemovable.push({ page: fx.page, reason: fx.note, rects: [] }); });
  return finalizeVerified(PDFLib, result, opts); // LAST
}

var API = {
  redactRects: redactRects,
  redactText: redactText,
  redactPattern: redactPattern,
  presets: PATTERNS,
  _internal: {
    locateImageRegions: locateImageRegions, toViewportTL: toViewportTL, toDevice: toDevice,
    sanitizeDoc: sanitizeDoc, luhnOk: luhnOk, ibanChecksum: ibanChecksum,
    sweepOrphans: sweepOrphans, containsRefAnywhere: containsRefAnywhere, refKey: refKey,
    rawByteVerify: rawByteVerify, computeNeedleVariants: computeNeedleVariants,
    clearFormFieldChain: clearFormFieldChain, scrubOutlinesAndStructTree: scrubOutlinesAndStructTree,
    finalizeVerified: finalizeVerified
  }
};
global.UBRedact = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof self !== "undefined" ? self : globalThis);
