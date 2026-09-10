/*!
 * pdf-textedit.js — true content-stream text editing for UnboundPDF.
 * (c) 2026 UnboundPDF. All code original. Depends on pdf-textops.js + pdf-lib
 * (+ fontkit and vendored Liberation faces — SIL OFL 1.1, licence text ships
 * alongside the font files — when a real embedded font is required).
 *
 * apply() REWRITES the page: the replaced text's show-operators are spliced out of
 * the content stream (original text truly gone — privacy by removal), push-down
 * moves are applied by rewriting absolute text matrices, and replacement text is
 * written per-line with an honest font strategy:
 *   1. same base-14 family when the original used one and the text fits WinAnsi;
 *   2. otherwise a REAL embedded font (Liberation), subsetted, full Unicode.
 * Nothing is rasterised. If any safety check fails, apply() refuses and the caller
 * falls back to fixed-layout mode — it must never silently damage a page.
 */
(function (global) {
"use strict";

function getOps() {
  var O = global.PDFTextOps || (typeof module !== "undefined" ? require("./pdf-textops.js") : null);
  if (!O) throw new Error("pdf-textops.js must be loaded first");
  return O;
}

var LIBERATION = {
  helvetica: "LiberationSans", times: "LiberationSerif", courier: "LiberationMono"
};
function faceFile(family, bold, italic) {
  var base = LIBERATION[family] || "LiberationSans";
  var style = bold && italic ? "BoldItalic" : bold ? "Bold" : italic ? "Italic" : "Regular";
  return base + "-" + style + ".ttf";
}
var STD_ENUM = {
  helvetica: ["Helvetica", "HelveticaBold", "HelveticaOblique", "HelveticaBoldOblique"],
  times: ["TimesRoman", "TimesRomanBold", "TimesRomanItalic", "TimesRomanBoldItalic"],
  courier: ["Courier", "CourierBold", "CourierOblique", "CourierBoldOblique"]
};

function normText(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

/* The comparison key for "is this the text the user thinks it is".
   The two sides come from DIFFERENT DECODERS — pdf.js `getTextContent` on one side, our own
   ToUnicode/encoding walk on the other — and they legitimately disagree on characters that
   render identically:
     · ligatures: the stream may carry U+FB01 "ﬁ" where extraction yields "f"+"i"
     · soft hyphens (U+00AD) and zero-width joiners: present in the stream, dropped by
       extraction (common in justified German text, which hyphenates heavily)
     · non-breaking space / narrow no-break space vs a plain space
     · composed vs decomposed accents — "ü" as one codepoint or "u" + combining diaeresis
   A byte-exact compare treats any of these as "this is not the paragraph you think" and
   aborts a perfectly ordinary edit into fixed-layout mode. Normalising first keeps the
   safety property (we still refuse unless the text matches) while dropping distinctions
   that no user could see. */
function cmpKey(s) {
  var t = String(s == null ? "" : s);
  if (t.normalize) t = t.normalize("NFKC");   // ligatures + compatibility forms + composition
  return t
    .replace(/[­​-‍⁠﻿]/g, "") // soft hyphen, ZW*, word-joiner, BOM
    .replace(/[‘’‚′]/g, "'")       // curly / prime quotes
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")            // dashes and minus
    .replace(/\s+/g, "")                                // all whitespace, incl. NBSP
    .toLowerCase();                                     // small-caps runs differ in case only
}

/* Compare two decodings of the same text, where OUR decoder is allowed to admit ignorance.

   The engine walks encodings and ToUnicode maps itself; pdf.js has years of per-producer
   heuristics and a full font-program reader. On documents that name glyphs unusually — a
   subsetted TrueType, a private /Differences table, a broken subsetter map — our walk yields
   an unknown-character marker for a glyph pdf.js reads correctly. Measured on the founder's
   German returns label: `want 581 chars, stream 581 over 11 records, first difference at 8`,
   stream "artikelm?ssen…" vs edited "artikelmüssen…" — same length, one unreadable glyph.

   Treating that as "this is not the paragraph you think it is" is wrong: it is not evidence
   of DIFFERENT text, it is our own failure to read one character. A position where WE emitted
   an unknown marker therefore matches anything; every character we did decode must still
   match exactly, so a changed word, number or punctuation mark is still refused. */
function isUnreadable(ch) {
  var c = ch.charCodeAt(0);
  return ch === "\uFFFD" || c === 0 || (c < 0x20) || (c >= 0x7F && c <= 0x9F);
}
function sameText(got, want) {
  if (got.length !== want.length) return false;
  for (var i = 0; i < got.length; i++) {
    if (got[i] === want[i]) continue;
    if (isUnreadable(got[i])) continue;   // our uncertainty, not a difference
    return false;
  }
  return true;
}

/** Records whose centre falls inside rect (viewport/top-left space). */
function recordsInRect(analysis, rect, pad) {
  pad = pad == null ? 2 : pad;
  return analysis.records.filter(function (r) {
    var cx = (r.rect.x + r.rect.right) / 2, cy = (r.rect.top + r.rect.bottom) / 2;
    return cx >= rect.x - pad && cx <= rect.right + pad && cy >= rect.top - pad && cy <= rect.bottom + pad;
  });
}

/** Pre-flight: can this edit be applied in stream mode? (Used by the editor before saving.) */
function check(PDFLib, doc, pageIndex, edits, translate) {
  var Ops = getOps();
  var analysis = Ops.analyze(PDFLib, doc, pageIndex);
  return checkWith(analysis, edits, translate);
}
function checkWith(analysis, edits, translate) {
  var Ops = getOps();
  // /Rotate pages: plain edits are fine (the writer builds a rotation-aware Tm);
  // push-down translation on rotated pages stays fixed-layout for now.
  if (analysis.rotate !== 0 && (translate || []).length)
    return { ok: false, reason: "push-down on a rotated page — fixed-layout mode" };
  var toRemove = [], report = [];
  for (var i = 0; i < (edits || []).length; i++) {
    var ed = edits[i];
    if (ed.insert) { report.push({ edit: i, records: 0, insert: true }); continue; }
    var recs = recordsInRect(analysis, ed.rect, 2);
    if (!recs.length) return { ok: false, reason: "no stream text found under the edited region" };
    var want = normText(ed.expectText);

    /* MATCH BY TEXT, NOT BY RECTANGLE (2026-07-20).
       The editor models a paragraph from pdf.js runs; the engine collects candidates by
       sweeping a padded rectangle. Those two views disagree whenever the rectangle catches
       anything the paragraph does not contain — a neighbouring line, a bullet, or (after a
       cover-mode save) a second copy of the very same words sitting at the same baseline.
       The old code compared the WHOLE sweep against the expected text and aborted on any
       difference, which is how a perfectly ordinary CV ended up in fixed-layout mode:
       measured `want` 86 chars vs `got` 175 chars over 3 records.
       Now: find the CONTIGUOUS run of records whose text reconstructs the expected text
       exactly, and operate on those alone. Safety is preserved — we still refuse unless the
       bytes we are about to delete spell precisely what the user believes they are editing —
       but a bystander record can no longer veto the edit. */
    if (want) {
      var wantK = cmpKey(want);
      var keys = recs.map(function (r) { return cmpKey(r.text); });
      var pick = null;
      for (var s = 0; s < recs.length && !pick; s++) {
        var acc = "";
        for (var e2 = s; e2 < recs.length; e2++) {
          acc += keys[e2];
          if (acc.length > wantK.length) break;
          if (sameText(acc, wantK)) { pick = recs.slice(s, e2 + 1); break; }
        }
      }
      if (!pick) {
        var gotK = keys.join("");
        var di = 0; while (di < gotK.length && di < wantK.length && gotK[di] === wantK[di]) di++;
        return {
          ok: false, reason: "stream text does not match the edited region (safety abort)",
          got: gotK.slice(0, 80), want: wantK.slice(0, 80),
          gotLen: gotK.length, wantLen: wantK.length, diffAt: di,
          gotAtDiff: gotK.slice(Math.max(0, di - 20), di + 40),
          wantAtDiff: wantK.slice(Math.max(0, di - 20), di + 40),
          records: recs.length
        };
      }
      recs = pick;
    }

    // editability is judged on the records we will actually touch, never on bystanders
    var bad = recs.filter(function (r) { return !r.editable; });
    if (bad.length) return { ok: false, reason: bad[0].uneditableReason || "region not editable" };

    toRemove.push.apply(toRemove, recs.map(function (r) { return r.id; }));
    report.push({ edit: i, records: recs.length, recs: recs });
  }
  var removedSet = {};
  toRemove.forEach(function (id) { removedSet[id] = 1; });
  // ' and " shows advance the line matrix as a side effect — splicing one would shift
  // every surviving record later in its chain
  for (var qz = 0; qz < analysis.records.length; qz++) {
    var rq = analysis.records[qz];
    if (!removedSet[rq.id] || !rq.selfAdvance) continue;
    for (var qf = qz + 1; qf < analysis.records.length; qf++) {
      var rf = analysis.records[qf];
      if (rf.chainId === rq.chainId && !removedSet[rf.id])
        return { ok: false, reason: "the removed text carries a line-advance later text depends on — fixed-layout mode" };
    }
  }
  // translation safety: everything below each cut must be movable, no graphics may
  // reach below the cut, and relative chains must move WHOLE (a chain is anchored by
  // one Tm — moving it moves every member, so no member may stay behind).
  // A cut may carry a REGION band {x0,x1} (Phase 3, column reflow): records fully
  // inside the band move, records fully outside stay, and anything SPANNING the band
  // boundary (a full-width footer) becomes a FLOOR the moved content must not cross.
  var moves = {}; // id -> total dy
  var gMoves = {}; // graphics index -> total dy (images moving as anchors)
  var pMoves = {}; // graphics index -> total dy (paths moving by operand rewrite)
  for (var t = 0; t < (translate || []).length; t++) {
    var tr = translate[t];
    var x0 = tr.x0 != null ? tr.x0 : -Infinity;
    var x1 = tr.x1 != null ? tr.x1 : Infinity;
    var banded = isFinite(x0) || isFinite(x1);
    var inBand = function (rect) { return rect.x >= x0 - 2 && rect.right <= x1 + 2; };
    var outBand = function (rect) { return rect.right < x0 + 2 || rect.x > x1 - 2; };
    var below = [], floorY = Infinity;
    for (var bz = 0; bz < analysis.records.length; bz++) {
      var rb = analysis.records[bz];
      if (removedSet[rb.id]) continue;
      if ((rb.rect.top + rb.rect.bottom) / 2 <= tr.belowY) continue;
      if (inBand(rb.rect)) { below.push(rb); continue; }
      if (outBand(rb.rect)) continue; // the other column — untouched by design
      // spans the boundary (footer/heading across columns): it stays, and content
      // may only move down INTO the whitespace above it
      if (rb.rect.top < tr.belowY)
        return { ok: false, reason: "content spanning the columns crosses the cut — fixed-layout mode" };
      floorY = Math.min(floorY, rb.rect.top);
    }
    for (var b2 = 0; b2 < below.length; b2++) {
      if (!Ops.translatable(below[b2], analysis))
        return { ok: false, reason: "text below the cut cannot be safely moved (relative positioning)" };
    }
    var movedImgBottom = -Infinity;
    for (var gz = 0; gz < (analysis.graphics || []).length; gz++) {
      var gr = analysis.graphics[gz];
      if (gr.type === "clip" || gr.bottom <= tr.belowY + 0.5) continue;
      if (banded && outBand(gr)) continue;
      if (banded && !inBand(gr)) { // spans the boundary — a floor, like spanning text
        if (gr.top < tr.belowY)
          return { ok: false, reason: "graphics spanning the columns cross the cut — fixed-layout mode" };
        floorY = Math.min(floorY, gr.top);
        continue;
      }
      // Phase 4: an IMAGE with a rewritable placing cm is an anchor — it MOVES with
      // the push instead of forcing fixed-layout
      if (gr.type === "image" && gr.cmOp && analysis.rotate === 0 &&
          Math.abs(gr.cmOp.outer[1]) < 0.001 && Math.abs(gr.cmOp.outer[2]) < 0.001 &&
          Math.abs(gr.cmOp.outer[3]) > 1e-6) {
        if (gr.top < tr.belowY - 0.5)
          return { ok: false, reason: "an image sits across the reflow cut — fixed-layout mode" };
        // text sharing the image's transform scope would move twice — refuse that page
        var comp = gr.ctm, valsI = gr.cmOp.vals;
        var identCm = Math.abs(valsI[0] - 1) < 1e-6 && Math.abs(valsI[3] - 1) < 1e-6 &&
                      Math.abs(valsI[1]) < 1e-6 && Math.abs(valsI[2]) < 1e-6;
        if (comp && !identCm) {
          for (var rz = 0; rz < analysis.records.length; rz++) {
            var rr = analysis.records[rz];
            if (rr.s > gr.cmOp.e && rr.ctm && rr.ctm.every(function (v2, i2) { return Math.abs(v2 - comp[i2]) < 1e-6; }))
              return { ok: false, reason: "text shares the image's transform — fixed-layout mode" };
          }
        }
        gMoves[gz] = (gMoves[gz] || 0) + tr.dy;
        movedImgBottom = Math.max(movedImgBottom, gr.bottom);
        continue;
      }
      /* Phase 4b: a PATH (rule, table border, form box) moves by rewriting the y
         operands of its own segments — the raster never enters into it. Conditions:
         wholly below the cut, one un-skewed ctm for every segment, every operand a
         plain rewritable number, and the landing spot still inside any active clip. */
      if (gr.type === "path" && gr.segs && gr.segs.length && !gr.mixedCtm &&
          gr.pathCtm && Math.abs(gr.pathCtm[1]) < 0.001 && Math.abs(gr.pathCtm[2]) < 0.001 &&
          Math.abs(gr.pathCtm[3]) > 1e-6 && analysis.rotate === 0) {
        if (gr.top < tr.belowY - 0.5)
          return { ok: false, reason: "a line/box sits across the reflow cut — fixed-layout mode" };
        var totalDyP = (pMoves[gz] || 0) + tr.dy;
        if (gr.clipBottom != null && gr.bottom + totalDyP > gr.clipBottom + 0.5)
          return { ok: false, reason: "a line/box would move outside its clipping region — fixed-layout mode" };
        pMoves[gz] = totalDyP;
        movedImgBottom = Math.max(movedImgBottom, gr.bottom);
        continue;
      }
      return { ok: false, reason: "graphics below the cut would not move (" + gr.type + ") — fixed-layout mode" };
    }
    if (isFinite(floorY)) {
      var maxBottom = -Infinity;
      below.forEach(function (r) { if (r.rect.bottom > maxBottom) maxBottom = r.rect.bottom; });
      maxBottom = Math.max(maxBottom, movedImgBottom);
      if ((below.length || isFinite(movedImgBottom)) && maxBottom > floorY - 0.5)
        return { ok: false, reason: "column content already reaches the spanning content — fixed-layout mode" };
      if ((below.length || isFinite(movedImgBottom)) && maxBottom + tr.dy > floorY - 0.5)
        return { ok: false, reason: "no room left before content that spans the columns — fixed-layout mode" };
    }
    below.forEach(function (r) { moves[r.id] = (moves[r.id] || 0) + tr.dy; });
  }
  // linked placements (two objects sharing one cm) must agree on their shift
  var byCmS = {};
  for (var gk in gMoves) {
    var grx = analysis.graphics[+gk];
    if (byCmS[grx.cmOp.s] != null && byCmS[grx.cmOp.s] !== gMoves[gk])
      return { ok: false, reason: "linked images would need different shifts — fixed-layout mode" };
    byCmS[grx.cmOp.s] = gMoves[gk];
  }
  // Chain structure: a relative chain (one BT with Td/T* steps — pdftex writes WHOLE
  // PAGES this way) is movable in pieces by RE-ANCHORING: wherever the shift amount
  // changes between consecutive kept members, the member's own positioning op is
  // rewritten as an absolute Tm. That op must exist and must not be shared with the
  // previous member (sharing = a mid-line split).
  var byChainV = {};
  analysis.records.forEach(function (r) {
    if (!removedSet[r.id]) (byChainV[r.chainId] = byChainV[r.chainId] || []).push(r);
  });
  for (var cid in byChainV) {
    var mem = byChainV[cid]; // analyze() order = stream order
    var prevDy = 0;
    for (var mi = 0; mi < mem.length; mi++) {
      var dyM = moves[mem[mi].id] || 0;
      if (dyM !== prevDy) {
        var po = mem[mi].posOp;
        if (!po || (po.kind !== "Tm" && po.kind !== "Td" && po.kind !== "TD" && po.kind !== "T*"))
          return { ok: false, reason: "a text line at the cut cannot be re-anchored — fixed-layout mode" };
        if (mi > 0 && mem[mi - 1].posOp && mem[mi - 1].posOp.s === po.s)
          return { ok: false, reason: "the cut would split a line of text — fixed-layout mode" };
      }
      prevDy = dyM;
    }
  }
  return { ok: true, analysis: analysis, removeIds: toRemove, moves: moves, gMoves: gMoves, pMoves: pMoves, report: report };
}

/** One-pass stream rewrite: remove show-ops + retarget absolute Tm ops + shift image anchors. */
function rewriteStream(analysis, removeIds, moves, gMoves, pMoves) {
  var kill = {};
  removeIds.forEach(function (i) { kill[i] = 1; });
  var edits = [];
  analysis.records.forEach(function (r) {
    if (kill[r.id]) edits.push({ s: r.s, e: r.e, repl: " " });
  });
  // Movement is applied by RE-ANCHORING: walking each chain in stream order, wherever
  // the shift changes between consecutive kept records, that record's positioning op is
  // replaced with an absolute Tm at its known line matrix, shifted by its dy. This moves
  // whole chains (boundary at the first member), chain SUFFIXES (pdftex one-BT pages —
  // the anchor breaks the relative link at the cut), and freezes interleaved non-movers.
  var seenPos = {};
  var byChainM = {};
  analysis.records.forEach(function (r) {
    if (!kill[r.id]) (byChainM[r.chainId] = byChainM[r.chainId] || []).push(r);
  });
  Object.keys(byChainM).forEach(function (cid) {
    var mem = byChainM[cid];
    var prevDy = 0;
    for (var mi = 0; mi < mem.length; mi++) {
      var r = mem[mi];
      var dy = moves[r.id] || 0;
      if (dy !== prevDy) {
        var po = r.posOp;
        if (po && seenPos[po.s] == null) {
          seenPos[po.s] = 1;
          // Tm's ty lives in TEXT space; dy is device points (downward). The CTM maps
          // text→device (b=c=0 guaranteed by translatable), so Δty = -dy/d — handles
          // producers like Skia printing through a flipped, px-scaled CTM.
          var dS = (r.ctm && Math.abs(r.ctm[3]) > 1e-6) ? r.ctm[3] : 1;
          // the LINE matrix set by this op (tm may carry intra-line advance — never use it)
          var m = r.tlm || r.tm;
          var repl = (+m[0].toFixed(6)) + " " + (+m[1].toFixed(6)) + " " + (+m[2].toFixed(6)) + " " +
                     (+m[3].toFixed(6)) + " " + (+m[4].toFixed(6)) + " " + (+(m[5] - dy / dS).toFixed(6)) + " Tm";
          // a TD folded its leading into the op — the Tm rewrite restores TL explicitly
          if (po.kind === "TD") repl += " " + (+(-po.vals[1]).toFixed(6)) + " TL";
          edits.push({ s: po.s, e: po.e, repl: repl });
        }
      }
      prevDy = dy;
    }
  });
  // image anchors: rewrite the placing cm's ty (Δty = -dy / outer.d, same space law as Tm)
  var seenCm = {};
  Object.keys(gMoves || {}).forEach(function (giS) {
    var gr = analysis.graphics[+giS];
    var dyG = gMoves[giS];
    if (!gr || !gr.cmOp || seenCm[gr.cmOp.s] != null) return;
    seenCm[gr.cmOp.s] = 1;
    var v = gr.cmOp.vals, dOut = gr.cmOp.outer[3] || 1;
    edits.push({
      s: gr.cmOp.s, e: gr.cmOp.e,
      repl: (+v[0].toFixed(6)) + " " + (+v[1].toFixed(6)) + " " + (+v[2].toFixed(6)) + " " +
            (+v[3].toFixed(6)) + " " + (+v[4].toFixed(6)) + " " + (+(v[5] - dyG / dOut).toFixed(6)) + " cm"
    });
  });
  // path anchors: shift every y operand of the path by -dy/d (its own text→device law)
  Object.keys(pMoves || {}).forEach(function (piS) {
    var gp = analysis.graphics[+piS];
    var dyP = pMoves[piS];
    if (!gp || !gp.segs || !gp.pathCtm) return;
    var dP = gp.pathCtm[3];
    gp.segs.forEach(function (sg) {
      edits.push({ s: sg.s, e: sg.e, repl: String(+(sg.v - dyP / dP).toFixed(6)) });
    });
  });
  edits.sort(function (a, b) { return a.s - b.s; });
  for (var i = 1; i < edits.length; i++) {
    if (edits[i].s < edits[i - 1].e) throw new Error("overlapping stream edits — refusing");
  }
  var out = [], pos = 0, b = analysis.bytes;
  function enc(str) {
    var u = new Uint8Array(str.length);
    for (var k = 0; k < str.length; k++) u[k] = str.charCodeAt(k) & 255;
    return u;
  }
  edits.forEach(function (ed) {
    if (ed.s > pos) out.push(b.subarray(pos, ed.s));
    out.push(enc(ed.repl));
    pos = Math.max(pos, ed.e);
  });
  out.push(b.subarray(pos));
  var total = out.reduce(function (n, p) { return n + p.length; }, 0);
  var res = new Uint8Array(total);
  var o = 0;
  out.forEach(function (p) { res.set(p, o); o += p.length; });
  return res;
}

/* ═══════════ Phase 2: reuse the document's own embedded font ═══════════ */

/** viewport (top-left) point → device-space Tm array for upright text under /Rotate. */
function viewportToTm(analysis, xVp, baselineTopVp) {
  // exact inverse of toViewport's pdf.js-true conventions; the linear part is the
  // matrix shape real view-upright text carries on each /Rotate (proven empirically:
  // 90 → [0,−1,1,0]).
  var bx = analysis.box ? analysis.box.x : 0, by = analysis.box ? analysis.box.y : 0;
  var r = analysis.rotate;
  if (r === 90) return [0, 1, -1, 0, baselineTopVp + bx, xVp + by];
  if (r === 180) return [-1, 0, 0, -1, (analysis.pdfW - xVp) + bx, baselineTopVp + by];
  if (r === 270) return [0, -1, 1, 0, (analysis.pdfW - baselineTopVp) + bx, (analysis.pdfH - xVp) + by];
  return [1, 0, 0, 1, xVp + bx, (analysis.vh - baselineTopVp) + by];
}

function colorOps(hex) {
  var m = String(hex || "#000000").match(/^#?([0-9a-f]{6})$/i);
  var v = m ? parseInt(m[1], 16) : 0;
  var f = function (x) { return +(x / 255).toFixed(4); };
  return f((v >> 16) & 255) + " " + f((v >> 8) & 255) + " " + f(v & 255) + " rg";
}

/** Try to write `ed` with the dominant font of the records it replaces.
 *  Returns {resName, fontInfo, encodeHex(text), widthOf(text)} or {miss: [...]}/null. */
function tryReuse(analysis, recs, ed, opts) {
  if (!recs || !recs.length) return null;
  var Ops = getOps();
  var counts = {};
  recs.forEach(function (r) { counts[r.resName] = (counts[r.resName] || 0) + r.chars.length; });
  var resName = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
  var f = analysis.fonts[resName];
  if (!f) return null;
  if (f.type0 && !f.identityH) return null;
  var inv = f.inverseMap();
  if (!inv) return null;
  // glyph-presence policy: fontkit-verified when the program parses (TrueType); otherwise
  // only characters the DOCUMENT already used with this font (conservative + honest)
  var face = null;
  if (opts && opts.fontkit) {
    var prog = null;
    try { prog = f.programBytes(); } catch (e0) { prog = null; }
    if (prog && (prog.kind === "FontFile2" || prog.kind === "FontFile")) {
      try {
        face = opts.fontkit.create(prog.bytes);
        face.hasGlyphForCodePoint(65); // probe: subsets without a cmap table throw LAZILY here
      } catch (e) { face = null; }
    }
  }
  /** True advance from the font program's hmtx (what viewers use when /Widths says 0). */
  function faceAdvance(cp2) {
    if (!face) return null;
    try {
      var g = face.glyphForCodePoint(cp2);
      if (g && g.advanceWidth != null && face.unitsPerEm) return g.advanceWidth / face.unitsPerEm * 1000;
    } catch (e) {}
    return null;
  }
  var usedUnis = {};
  if (f.usedCodes) for (var uc in f.usedCodes) usedUnis[f.usedCodes[uc]] = 1;
  var allText = ed.lines.map(function (l) { return l.text; }).join("");
  var miss = {};
  for (var i = 0; i < allText.length; i++) {
    var ch = allText[i];
    var cp = allText.codePointAt(i);
    if (cp > 0xFFFF) { i++; ch = String.fromCodePoint(cp); }
    if (ch === "\n" || ch === "\r" || ch === "\t") continue;
    var code = inv[ch];
    if (code == null) { miss[ch] = 1; continue; }
    /* Coverage is a UNION of proofs — any one suffices:
       - the font program's cmap has the codepoint (when it parses; subset TTFs often
         strip cmaps, so a miss here proves nothing),
       - the DOCUMENT already shows this character with this font,
       - base-14 fonts carry the full WinAnsi repertoire by definition. */
    var fkHas = false;
    if (face) { try { fkHas = face.hasGlyphForCodePoint(cp); } catch (e2) { fkHas = false; } }
    var hasGlyph = fkHas || usedUnis[ch] === 1 || (!!f.stdName && Ops.winAnsiEncodable(ch));
    if (!hasGlyph) miss[ch] = 1;
    // The advance may come from /Widths, std-14 metrics, or the program's hmtx;
    // a document-proven code renders even when no metric source is readable.
    if (f.widthOfCode(code) == null && !f.stdName && faceAdvance(cp) == null && usedUnis[ch] !== 1)
      miss[ch] = 1;
  }
  var missing = Object.keys(miss);
  if (missing.length) return { miss: missing };
  function codesOf(text) {
    var out = [];
    for (var k = 0; k < text.length; k++) {
      var cp2 = text.codePointAt(k);
      if (cp2 > 0xFFFF) k++;
      out.push(inv[String.fromCodePoint(cp2)]);
    }
    return out;
  }
  return {
    resName: resName,
    fontInfo: f,
    encodeHex: function (text) {
      return codesOf(text).map(function (c) {
        return f.type0 ? ("0000" + c.toString(16)).slice(-4) : ("00" + c.toString(16)).slice(-2);
      }).join("");
    },
    widthOf: function (text, size) {
      var w = 0;
      for (var k = 0; k < text.length; k++) {
        var cp3 = text.codePointAt(k);
        if (cp3 > 0xFFFF) k++;
        var c = inv[String.fromCodePoint(cp3)];
        w += (f.widthOfCode(c) || faceAdvance(cp3) || 500) / 1000 * size;
      }
      return w;
    }
  };
}

/** Raw operator emission for reuse edits — appended to the rewritten stream. */
function rawTextOps(analysis, ed, reuse) {
  var out = "\nq\nBT\n" + colorOps(ed.colorHex) + "\n/" + reuse.resName + " " + (+ed.size.toFixed(3)) + " Tf\n";
  ed.lines.forEach(function (ln) {
    if (!ln.text) return;
    var tm = viewportToTm(analysis, ln.x, ln.baselineTop).map(function (n) { return +n.toFixed(3); });
    out += tm.join(" ") + " Tm\n<" + reuse.encodeHex(ln.text) + "> Tj\n";
  });
  out += "ET\nQ\n";
  return out;
}

/** Resolve the writing font for an edit. Returns {font, label, embedded}. */
async function resolveFont(PDFLib, doc, ed, caches, opts) {
  var Ops = getOps();
  var family = ed.family || "helvetica";
  var idx = (ed.bold ? 1 : 0) + (ed.italic ? 2 : 0);
  var allText = ed.lines.map(function (l) { return l.text; }).join("");
  var stdOk = STD_ENUM[family] && Ops.winAnsiEncodable(allText);
  if (stdOk) {
    var key = "std:" + family + idx;
    if (!caches[key]) caches[key] = await doc.embedFont(PDFLib.StandardFonts[STD_ENUM[family][idx]]);
    return { font: caches[key], label: "standard " + STD_ENUM[family][idx], embedded: false };
  }
  // real embedded font path
  if (!opts || !opts.fontkit || !opts.fontFiles) {
    return { error: "text needs an embedded font (non-WinAnsi characters) but no font files were provided" };
  }
  var file = faceFile(family, ed.bold, ed.italic);
  var bytes = opts.fontFiles[file];
  if (!bytes) return { error: "font face not available: " + file };
  /* GLYPH COVERAGE — the honest gate. pdf-lib maps missing glyphs to .notdef silently
     (observed: U+2713 vanished into an empty box). Every character must have a real
     glyph in the chosen face, or we refuse with the character named. */
  var fkKey = "fk:" + file;
  if (!caches[fkKey]) caches[fkKey] = opts.fontkit.create(bytes);
  var face = caches[fkKey];
  var missing = {};
  for (var i2 = 0; i2 < allText.length; i2++) {
    var cp = allText.codePointAt(i2);
    if (cp > 0xFFFF) i2++;
    if (cp === 10 || cp === 13 || cp === 9 || cp === 32) continue;
    if (!face.hasGlyphForCodePoint(cp)) missing[String.fromCodePoint(cp)] = 1;
  }
  var missList = Object.keys(missing);
  if (missList.length) {
    return { error: "these characters have no glyph in the replacement font: " + missList.join(" ") + " — edit refused rather than printing empty boxes" };
  }
  var key2 = "lib:" + file;
  if (!caches[key2]) {
    if (!caches.__fontkitRegistered) {
      doc.registerFontkit(opts.fontkit);
      caches.__fontkitRegistered = true;
    }
    caches[key2] = await doc.embedFont(bytes, { subset: true });
  }
  return { font: caches[key2], label: "embedded " + file.replace(".ttf", "") + " (OFL)", embedded: true };
}

function hex2rgb(PDFLib, hex) {
  var m = String(hex || "#000000").match(/^#?([0-9a-f]{6})$/i);
  var v = m ? parseInt(m[1], 16) : 0;
  return PDFLib.rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

/** Apply edits: splice originals + move below-cut text + write replacement lines.
 *  edits: [{rect, expectText, lines: [{text, x, baselineTop}], size, family, bold,
 *           italic, colorHex}]     translate: [{belowY, dy}]
 *  opts: {fontkit, fontFiles: {faceFile: Uint8Array}, pieceInfo: object|null}   */
async function apply(PDFLib, doc, pageIndex, edits, translate, opts) {
  var Ops = getOps();
  var analysis = Ops.analyze(PDFLib, doc, pageIndex);
  // std-14 width resolution (needed for exact record extents on our own files)
  var pending = {};
  analysis.records.forEach(function (r) { if (r.pendingWidths && r.stdName) pending[r.stdName] = 1; });
  var stdFonts = {};
  for (var sn in pending) stdFonts[sn] = await doc.embedFont(PDFLib.StandardFonts[sn]);
  Ops.resolveStdWidths(analysis, stdFonts);

  var chk = checkWith(analysis, edits, translate);
  if (!chk.ok) return chk;

  // page-overflow records leave this page entirely: removed here, re-emitted verbatim
  // on the next page by applyFlow (which planned them before calling us)
  if (opts && opts._flowRemove && opts._flowRemove.length) {
    opts._flowRemove.forEach(function (id) {
      if (chk.removeIds.indexOf(id) < 0) chk.removeIds.push(id);
      delete chk.moves[id];
    });
  }

  var newBytes = rewriteStream(analysis, chk.removeIds, chk.moves, chk.gMoves, chk.pMoves);

  /* Writer chain, most faithful first:
       1. REUSE the document's own embedded font (raw ops, rotation-aware) — pixel-true;
       2. same base-14 family (WinAnsi text);
       3. embedded Liberation subset (full Unicode, glyph gate);
       4. refuse with the reason.
     Chain decisions are per edit; raw reuse ops are appended INTO the rewritten stream. */
  var plans = [];
  var rawTail = "";
  for (var pi2 = 0; pi2 < edits.length; pi2++) {
    var edP = edits[pi2];
    var recsP = (chk.report[pi2] && chk.report[pi2].recs) || null;
    // A user-selected family is an instruction, not a hint. The caller marks noReuse when
    // the font picker was changed away from Document font; silently reusing the source
    // font made the control lie and made the save receipt impossible to trust.
    var reuse = (edP.insert || edP.noReuse) ? null : tryReuse(analysis, recsP, edP, opts);
    if (reuse && !reuse.miss) {
      rawTail += rawTextOps(analysis, edP, reuse);
      plans.push({
        mode: "reuse",
        label: "reused " + (reuse.fontInfo.stdName ? "document font " : "embedded ") +
               (reuse.fontInfo.baseFont || reuse.resName) + " (exact document font)"
      });
    } else {
      plans.push({ mode: "draw", missNote: reuse && reuse.miss ? " (document font lacks: " + reuse.miss.slice(0, 6).join(" ") + ")" : "" });
    }
  }
  if (rawTail) {
    // the original stream may leave a non-identity CTM (Skia prints under a flipped
    // px-scale) — sandbox it in q…Q so the appended ops run in true device space
    var tailStr = "q\n";
    var tailPre = new Uint8Array(tailStr.length);
    for (var tp = 0; tp < tailStr.length; tp++) tailPre[tp] = tailStr.charCodeAt(tp) & 255;
    rawTail = "\nQ" + rawTail;
    var tailBytes = new Uint8Array(rawTail.length);
    for (var tb = 0; tb < rawTail.length; tb++) tailBytes[tb] = rawTail.charCodeAt(tb) & 255;
    var merged = new Uint8Array(tailPre.length + newBytes.length + tailBytes.length);
    merged.set(tailPre, 0);
    merged.set(newBytes, tailPre.length);
    merged.set(tailBytes, tailPre.length + newBytes.length);
    newBytes = merged;
  }
  Ops.writeStream(PDFLib, doc, pageIndex, newBytes);

  var page = doc.getPage(pageIndex);
  var caches = {};
  var fontsUsed = [];
  var bx = analysis.box ? analysis.box.x : 0, by = analysis.box ? analysis.box.y : 0;
  for (var i = 0; i < edits.length; i++) {
    var ed = edits[i];
    if (plans[i].mode === "reuse") { fontsUsed.push(plans[i].label); continue; }
    if (analysis.rotate !== 0) {
      return { ok: false, reason: "replacement needs a substitute font on a rotated page — fixed-layout mode" };
    }
    var rf = await resolveFont(PDFLib, doc, ed, caches, opts);
    if (rf.error) return { ok: false, reason: rf.error + (plans[i].missNote || "") };
    fontsUsed.push(rf.label + (plans[i].missNote || ""));
    var color = hex2rgb(PDFLib, ed.colorHex);
    for (var li = 0; li < ed.lines.length; li++) {
      var ln = ed.lines[li];
      if (!ln.text) continue;
      page.drawText(ln.text, {
        x: bx + ln.x,
        y: by + (analysis.vh - ln.baselineTop),
        size: ed.size,
        font: rf.font,
        color: color
      });
    }
  }

  if (opts && opts.pieceInfo) {
    try {
      var N = PDFLib.PDFName;
      var d = new Date();
      function p2(x) { return (x < 10 ? "0" : "") + x; }
      var stamp = "D:" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
      var privDict = doc.context.obj({
        LastModified: PDFLib.PDFString.of(stamp),
        Private: PDFLib.PDFString.of(JSON.stringify(opts.pieceInfo))
      });
      var pieceDict = doc.context.obj({ UnboundPDF: privDict });
      page.node.set(N.of("PieceInfo"), pieceDict);
    } catch (e) { /* metadata is best-effort — never fail a save over it */ }
  }

  return {
    ok: true,
    removed: chk.removeIds.length,
    moved: Object.keys(chk.moves).length,
    fontsUsed: fontsUsed
  };
}

/** Read back our PieceInfo model, if this file was edited by us before. */
function readPieceInfo(PDFLib, doc, pageIndex) {
  try {
    var N = PDFLib.PDFName;
    var pi = doc.getPage(pageIndex).node.lookup(N.of("PieceInfo"));
    if (!pi) return null;
    var ours = pi.lookup ? pi.lookup(N.of("UnboundPDF")) : null;
    if (!ours) return null;
    var priv = ours.lookup ? ours.lookup(N.of("Private")) : null;
    if (!priv) return null;
    return JSON.parse(priv.decodeText ? priv.decodeText() : String(priv).replace(/^\(|\)$/g, ""));
  } catch (e) { return null; }
}

/* ═══════════ Phase 4: controlled page overflow ═══════════
   Records pushed past the page's bottom margin FLOW to the top of the next page —
   spliced from this page, re-emitted VERBATIM (original show bytes; own cm/Tf/Tm/state)
   there, with that page's own content pushed down in turn. Cascades; appends a page at
   the end when needed. Everything is planned before anything mutates (atomic). */

function num6(v) { return String(+(+v).toFixed(6)); }

/** Which kept records must flow off this page, given the planned moves? */
function splitOverflow(analysis, chk, flow) {
  var over = [];
  Object.keys(chk.moves).forEach(function (idS) {
    var r = analysis.records[+idS];
    if (r && r.rect.bottom + chk.moves[idS] > flow.bottomY) over.push(r);
  });
  if (!over.length) return { out: null };
  if (analysis.rotate !== 0) return { refuse: "cannot flow text on a rotated page" };
  var cutoff = Math.min.apply(0, over.map(function (r) { return r.rect.top; })) - 0.5;
  var removedSet = {};
  chk.removeIds.forEach(function (id) { removedSet[id] = 1; });
  var items = [], minTop = Infinity, maxBottom = -Infinity;
  for (var i = 0; i < analysis.records.length; i++) {
    var r = analysis.records[i];
    if (removedSet[r.id] || r.rect.top < cutoff) continue;
    if (r.selfAdvance) return { refuse: "a line uses a combined move-and-show operator — cannot flow it" };
    if (Math.abs(r.ctm[1]) >= 0.001 || Math.abs(r.ctm[2]) >= 0.001 ||
        Math.abs(r.tlm[1]) >= 0.001 || Math.abs(r.tlm[2]) >= 0.001)
      return { refuse: "rotated or skewed text cannot flow to the next page" };
    var f = analysis.fonts[r.resName];
    if (!f || !f.rawRef) return { refuse: "a font needed on the next page has no reusable reference" };
    var dy = chk.moves[r.id] || 0;
    minTop = Math.min(minTop, r.rect.top + dy);
    maxBottom = Math.max(maxBottom, r.rect.bottom + dy);
    items.push({ rec: r, dy: dy });
  }
  for (var g = 0; g < (analysis.graphics || []).length; g++) {
    var gr = analysis.graphics[g];
    if (gr.type !== "clip" && gr.bottom > cutoff)
      return { refuse: "an image or graphic would need to flow to the next page — not supported yet" };
  }
  if (!items.length) return { out: null };
  return {
    out: {
      ids: items.map(function (it) { return it.rec.id; }),
      items: items, minTop: minTop, maxBottom: maxBottom,
      height: maxBottom - minTop, srcAnalysis: analysis
    }
  };
}

/** Register the carried records' fonts on the target page; returns resName→newName. */
function registerCarryFonts(PDFLib, doc, pageIdx, carry) {
  var N = PDFLib.PDFName;
  var node = doc.getPage(pageIdx).node;
  var res = node.Resources ? node.Resources() : null;
  if (!res) {
    res = doc.context.obj({});
    node.set(N.of("Resources"), res);
  }
  var fd = res.lookup ? res.lookup(N.of("Font")) : null;
  if (!fd) {
    fd = doc.context.obj({});
    res.set(N.of("Font"), fd);
  }
  var used = {};
  if (fd.keys) fd.keys().forEach(function (k) { used[String(k).replace(/^\//, "")] = 1; });
  var map = {}, i = 1;
  carry.items.forEach(function (it) {
    var rn = it.rec.resName;
    if (map[rn]) return;
    var nn = "UBF" + i;
    while (used[nn]) nn = "UBF" + (++i);
    fd.set(N.of(nn), carry.srcAnalysis.fonts[rn].rawRef);
    map[rn] = nn;
    used[nn] = 1;
    i++;
  });
  return map;
}

/** Byte-emit the carried records at the top of the target page (verbatim shows). */
function emitCarry(carry, flow, targetVh, targetBoxY, fontMap) {
  var src = carry.srcAnalysis;
  var parts = [];
  function push(str) {
    var u = new Uint8Array(str.length);
    for (var k = 0; k < str.length; k++) u[k] = str.charCodeAt(k) & 255;
    parts.push(u);
  }
  carry.items.forEach(function (it) {
    var r = it.rec;
    var newBase = flow.topY + ((r.baselineTop + it.dy) - carry.minTop);
    // rot-0 device baselines on both pages; Δty rides the record's own ctm scale
    var devSrc = (src.vh - r.baselineTop) + (src.box ? src.box.y : 0);
    var devDst = (targetVh - newBase) + targetBoxY;
    var dS = r.ctm[3] || 1;
    var ty2 = r.tlm[5] + (devDst - devSrc) / dS;
    push("q\n" +
      r.ctm.map(num6).join(" ") + " cm\nBT\n" +
      "/" + fontMap[r.resName] + " " + num6(r.size) + " Tf\n" +
      num6(r.Tc) + " Tc " + num6(r.Tw) + " Tw " + num6(r.Tz) + " Tz " + (r.renderMode || 0) + " Tr\n" +
      (r.color || "0 0 0 rg") + "\n" +
      num6(r.tlm[0]) + " " + num6(r.tlm[1]) + " " + num6(r.tlm[2]) + " " + num6(r.tlm[3]) + " " +
      num6(r.tlm[4]) + " " + num6(ty2) + " Tm\n");
    parts.push(src.bytes.subarray(r.s, r.e)); // the ORIGINAL show op — TJ kerning intact
    push("\nET\nQ\n");
  });
  var total = 0;
  parts.forEach(function (p) { total += p.length; });
  var out = new Uint8Array(total);
  var o = 0;
  parts.forEach(function (p) { out.set(p, o); o += p.length; });
  return out;
}

/** apply() + controlled overflow: plan the whole cascade, then execute it. */
async function applyFlow(PDFLib, doc, pageIndex, edits, translate, opts) {
  var Ops = getOps();
  var flow = opts.flow;
  var gap = flow.gap != null ? flow.gap : 12;

  async function analyzedFor(pi) {
    var A = Ops.analyze(PDFLib, doc, pi);
    var pending = {};
    A.records.forEach(function (r) { if (r.pendingWidths && r.stdName) pending[r.stdName] = 1; });
    var sf = {};
    for (var sn in pending) sf[sn] = await doc.embedFont(PDFLib.StandardFonts[sn]);
    Ops.resolveStdWidths(A, sf);
    return A;
  }

  /* PHASE A — plan every page; refuse before anything mutates */
  var an0 = await analyzedFor(pageIndex);
  var chk0 = checkWith(an0, edits, translate);
  if (!chk0.ok) return chk0;
  var s0 = splitOverflow(an0, chk0, flow);
  if (s0.refuse) return { ok: false, reason: s0.refuse };
  var flowPlans = [];
  var carry = s0.out, pi = pageIndex + 1, guard = 0;
  while (carry && carry.items.length) {
    if (++guard > 64) return { ok: false, reason: "overflow cascade too deep" };
    if (pi >= doc.getPageCount()) {
      flowPlans.push({ pageIndex: pi, newPage: true, incoming: carry });
      carry = null;
      break;
    }
    var anI = await analyzedFor(pi);
    if (anI.rotate !== 0) return { ok: false, reason: "page " + (pi + 1) + " is rotated — cannot flow onto it" };
    if (Math.abs(anI.vw - an0.vw) > 1 || Math.abs(anI.vh - an0.vh) > 1)
      return { ok: false, reason: "page " + (pi + 1) + " has a different size — cannot flow onto it" };
    // the whole page shifts down — cut at the very top so headers above the nominal
    // margin (title lines often start higher) move too instead of being overlapped
    var chkI = checkWith(anI, [], [{ belowY: 0, dy: carry.height + gap }]);
    if (!chkI.ok) return { ok: false, reason: "page " + (pi + 1) + ": " + chkI.reason };
    var sI = splitOverflow(anI, chkI, flow);
    if (sI.refuse) return { ok: false, reason: "page " + (pi + 1) + ": " + sI.refuse };
    flowPlans.push({ pageIndex: pi, analysis: anI, chk: chkI, incoming: carry, outgoing: sI.out });
    carry = sI.out;
    pi++;
  }

  /* PHASE B — execute: the edited page through apply() (it owns the writer chain),
     then each flow page: rewrite (shift down) + verbatim carry tail */
  var res0 = await apply(PDFLib, doc, pageIndex, edits, translate,
    Object.assign({}, opts, { _flowRemove: s0.out ? s0.out.ids : [] }));
  if (!res0.ok) return res0;
  for (var p = 0; p < flowPlans.length; p++) {
    var plan = flowPlans[p];
    if (plan.newPage) {
      var prev = doc.getPage(plan.pageIndex - 1);
      var sz = prev.getSize();
      doc.addPage([sz.width, sz.height]);
    }
    var fontMap = registerCarryFonts(PDFLib, doc, plan.pageIndex, plan.incoming);
    var tVh = plan.analysis ? plan.analysis.vh : plan.incoming.srcAnalysis.vh;
    var tBoxY = plan.analysis && plan.analysis.box ? plan.analysis.box.y : 0;
    var tail = emitCarry(plan.incoming, flow, tVh, tBoxY, fontMap);
    var base;
    if (plan.analysis) {
      var shifted = rewriteStream(plan.analysis, plan.outgoing ? plan.outgoing.ids : [], plan.chk.moves, plan.chk.gMoves, plan.chk.pMoves);
      // sandbox the original stream so the tail runs at identity CTM
      var pre = new Uint8Array(2); pre[0] = 113; pre[1] = 10; // "q\n"
      var mid = new Uint8Array(3); mid[0] = 10; mid[1] = 81; mid[2] = 10; // "\nQ\n"
      base = new Uint8Array(pre.length + shifted.length + mid.length + tail.length);
      base.set(pre, 0); base.set(shifted, pre.length);
      base.set(mid, pre.length + shifted.length);
      base.set(tail, pre.length + shifted.length + mid.length);
    } else {
      base = tail;
    }
    Ops.writeStream(PDFLib, doc, plan.pageIndex, base);
  }
  res0.flowedPages = flowPlans.map(function (pl) { return pl.pageIndex; });
  res0.flowedRecords = s0.out ? s0.out.items.length : 0;
  return res0;
}

var API = { apply: apply, applyFlow: applyFlow, check: check, recordsInRect: recordsInRect, readPieceInfo: readPieceInfo, faceFile: faceFile };
global.PDFTextEdit = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof self !== "undefined" ? self : globalThis);
