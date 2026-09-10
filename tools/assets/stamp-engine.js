/*!
 * stamp-engine.js — shared TEXT-STAMPING engine for UnboundPDF (W5-E2, 2026-08-21).
 * (c) 2026 UnboundPDF. All code original. No third-party bytes are vendored by this file.
 *
 * Used by: tools/t/bates-numbering.js, tools/t/exhibit-stamper.js, tools/t/headers-footers.js.
 * Runs unchanged in the browser (window.UBStamp) and in Node (module.exports) so the QA
 * suites can drive the SAME code the product ships instead of a transcription of it.
 *
 * ── What this file is for ────────────────────────────────────────────────────────────────
 * Every stamp it draws is REAL TEXT drawn with pdf-lib's drawText into the page content
 * stream — selectable, searchable and copyable in any reader. Nothing is rasterised, and no
 * page is re-rendered: a stamped page keeps every original byte of its own content.
 *
 * ── The placement problem, and how it is solved here ─────────────────────────────────────
 * Two rotations compose on every stamp and they are NOT the same rotation:
 *   1. the page's own /Rotate (0/90/180/270) — how a reader sees the page, which is what
 *      "bottom-right corner" has to mean; and
 *   2. the stamp's own angle A (0/90/180/270) — an exhibit stamp turned up the side of the
 *      page still has to sit in the corner the user picked.
 *
 * pdf-lib's `rotate` option rotates the text COUNTER-CLOCKWISE about the anchor passed as
 * {x, y}, and that anchor is the baseline origin, NOT the lower-left of the rotated box.
 * That is MEASURED, not assumed: a 40pt "MMMM" (advance 133.28pt) drawn at (100, 200) on an
 * unrotated 400x600 page renders ink at, in page points,
 *     rotate 0   : x 103..228, y 200..228      (baseline +x, ascent +y)
 *     rotate 90  : x  71.. 99, y 203..329      (baseline +y, ascent -x)
 *     rotate 180 : x   3.. 96, y 171..199      (baseline -x, ascent -y)
 *     rotate 270 : x 100..128, y  71..196      (baseline -y, ascent +x)
 * (pdftoppm -r 72 -gray, ink = pixels < 128. _qa/test_stamp_engine.mjs re-renders and
 * re-measures this rather than trusting the note.)
 *
 * So for a rotation R the drawn box is  anchor + [0..advance]*(cos R, sin R)
 *                                              + [0..size]*(-sin R, cos R).
 *
 * The engine therefore works entirely in the VISIBLE frame (what the reader sees, origin at
 * the visible bottom-left, size visW x visH), places the block there, and maps the resulting
 * anchor back into unrotated user space with the page's own /Rotate mapping:
 *     /Rotate 0   : vx = x,      vy = y          (visW = W, visH = H)
 *     /Rotate 90  : vx = y,      vy = W - x      (visW = H, visH = W)
 *     /Rotate 180 : vx = W - x,  vy = H - y      (visW = W, visH = H)
 *     /Rotate 270 : vx = H - y,  vy = x          (visW = H, visH = W)
 * and the user-space rotation needed for a stamp that READS at angle A is R = (A + /Rotate)
 * mod 360 — again pinned by a rendering test, not by this comment.
 *
 * ── Deliberately NOT here ────────────────────────────────────────────────────────────────
 *  - Arbitrary (non-90-degree) stamp angles. The four right angles are what a court rule or
 *    a house style asks for, and each one is verified by rendering; an arbitrary angle would
 *    be verified by nothing.
 *  - Any font other than the base-14 Helvetica family. Stamps are Latin-1 label text;
 *    text-embed.js exists for real Unicode document text and is not needed to draw
 *    "SMITH-000123". winAnsiSafe() reports, by name, any character a base-14 font cannot
 *    carry, so an unstampable character is refused out loud instead of becoming "?".
 *
 * ── API ─────────────────────────────────────────────────────────────────────────────────
 *   UBStamp.batesLabel(n, {prefix, suffix, pad})            -> "SMITH-000123-A"
 *   UBStamp.exhibitLabel(i, {style, start})                 -> "A" ... "Z", "AA", "AB" ...
 *   UBStamp.expand(tpl, ctx)                                -> token substitution
 *   UBStamp.measure(font, lines, size, lineGap)             -> {width, height, lineWidths}
 *   UBStamp.drawBlock(PDFLib, page, font, spec)             -> {box, anchors} (visible frame)
 *   UBStamp.csvCell(v) / UBStamp.csv(rows)                  -> injection-neutralised CSV
 *   UBStamp.sha256Hex(bytes)                                -> Promise<string>
 *   UBStamp.winAnsiSafe(str)                                -> {ok, offending:[...]}
 *   UBStamp.POSITIONS                                       -> the nine position ids
 */
(function (global) {
  "use strict";

  var VERSION = "1.0.0";
  var POSITIONS = ["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"];

  /* ═══════════════ labels ═══════════════ */

  /** Bates label: prefix + zero-padded number + suffix. `pad` is the TOTAL digit count;
   *  a number wider than `pad` is never truncated (a truncated Bates number is a WRONG
   *  Bates number, and a wrong one in a production set is worse than an ugly one), it
   *  simply grows — and the caller is told via batesOverflows(). */
  function batesLabel(n, opts) {
    opts = opts || {};
    var pad = opts.pad == null ? 6 : Math.max(0, opts.pad | 0);
    var digits = String(Math.max(0, Math.floor(n)));
    var padded = digits.length >= pad ? digits : new Array(pad - digits.length + 1).join("0") + digits;
    return (opts.prefix || "") + padded + (opts.suffix || "");
  }
  function batesOverflows(n, pad) {
    return String(Math.max(0, Math.floor(n))).length > Math.max(0, pad | 0);
  }

  /** Bijective base-26: 1->A ... 26->Z, 27->AA, 28->AB ... 52->AZ, 53->BA. The sequence
   *  every exhibit index and every spreadsheet column uses. */
  function numberToLetters(n) {
    n = Math.floor(n);
    if (n < 1) return "";
    var out = "";
    while (n > 0) {
      var rem = (n - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  }
  /** Inverse of numberToLetters: "A"->1, "Z"->26, "AA"->27. Returns 0 for anything else. */
  function lettersToNumber(s) {
    s = String(s || "").toUpperCase();
    if (!/^[A-Z]+$/.test(s)) return 0;
    var n = 0;
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n;
  }

  /** i is 0-based within the batch. opts.start is the FIRST label ("A" or 1). */
  function exhibitLabel(i, opts) {
    opts = opts || {};
    var style = opts.style === "numbers" ? "numbers" : "letters";
    var start = opts.start;
    if (style === "letters") {
      var s0 = typeof start === "string" ? (lettersToNumber(start) || 1) : (start ? Math.max(1, start | 0) : 1);
      return numberToLetters(s0 + i);
    }
    var n0 = typeof start === "string" ? (parseInt(start, 10) || 1) : (start == null ? 1 : Math.max(0, start | 0));
    return String(n0 + i);
  }

  /* ═══════════════ token expansion (headers/footers, exhibit templates) ═══════════════ */

  /** Supported tokens — this table and the visible help text on the tool page are the same
   *  list. An unknown {token} is left ALONE rather than silently blanked: a user who types
   *  {compnay} sees their typo instead of losing the text. */
  function expand(tpl, ctx) {
    ctx = ctx || {};
    return String(tpl == null ? "" : tpl).replace(/\{(n|N|date|filename|title|bates|exhibit)\}/g, function (m, key) {
      var v = ctx[key];
      return v == null ? m : String(v);
    });
  }

  /** ISO date (YYYY-MM-DD) in LOCAL time — a stamp reading "2026-08-21" must match the
   *  calendar on the wall of the person stamping it, not UTC's. */
  function isoDate(d) {
    d = d || new Date();
    var p = function (x) { return (x < 10 ? "0" : "") + x; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  /* ═══════════════ encoding honesty ═══════════════ */

  /** Base-14 fonts are WinAnsi-encoded. Report every character that cannot be carried, BY
   *  NAME (character + U+XXXX), so the tool can refuse instead of drawing "?" — the exact
   *  failure text-embed.js was built to end for document text. */
  function winAnsiSafe(str) {
    var offending = [];
    var s = String(str == null ? "" : str);
    var HIGH = [0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030,
      0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013,
      0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      var ok = (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || HIGH.indexOf(c) >= 0;
      if (!ok) {
        var hex = c.toString(16).toUpperCase();
        while (hex.length < 4) hex = "0" + hex;
        offending.push({ char: s[i], code: "U+" + hex, index: i });
      }
    }
    return { ok: offending.length === 0, offending: offending };
  }

  /* ═══════════════ measurement + placement ═══════════════ */

  function measure(font, lines, size, lineGap) {
    var gap = lineGap == null ? size * 0.25 : lineGap;
    var widths = lines.map(function (t) { return font.widthOfTextAtSize(t, size); });
    var width = widths.reduce(function (a, b) { return Math.max(a, b); }, 0);
    var height = lines.length * size + Math.max(0, lines.length - 1) * gap;
    return { width: width, height: height, lineWidths: widths, gap: gap };
  }

  function normAngle(a) {
    a = Math.round((a || 0) / 90) * 90;
    a = a % 360;
    return a < 0 ? a + 360 : a;
  }

  /** Page geometry in the frame the reader sees. */
  function visibleFrame(page) {
    var sz = page.getSize();
    var rot = 0;
    try { rot = (page.getRotation && page.getRotation().angle) || 0; } catch (e) { rot = 0; }
    rot = normAngle(rot);
    var turned = (rot === 90 || rot === 270);
    return {
      W: sz.width, H: sz.height, rotate: rot,
      visW: turned ? sz.height : sz.width,
      visH: turned ? sz.width : sz.height
    };
  }

  /** Visible-frame point -> unrotated user-space point. Inverse of the /Rotate mapping in
   *  this file's header, which the rendering suite re-derives from real ink. */
  function visibleToUser(frame, vx, vy) {
    switch (frame.rotate) {
      case 90: return { x: frame.W - vy, y: vx };
      case 180: return { x: frame.W - vx, y: frame.H - vy };
      case 270: return { x: vy, y: frame.H - vx };
      default: return { x: vx, y: vy };
    }
  }

  /** Lower-left corner of the block's box in the visible frame, for a 9-grid position. */
  function blockOrigin(frame, position, boxW, boxH, marginX, marginY) {
    var p = POSITIONS.indexOf(position) >= 0 ? position : "bc";
    var v = p[0], h = p[1];
    var vx = h === "l" ? marginX : h === "c" ? (frame.visW - boxW) / 2 : frame.visW - marginX - boxW;
    var vy = v === "t" ? frame.visH - marginY - boxH : v === "m" ? (frame.visH - boxH) / 2 : marginY;
    return { vx: vx, vy: vy };
  }

  /** Baseline origin for ONE line, from that line's own visible box lower-left plus its
   *  advance and size. Each case is the inverse of the measured box geometry in the header.  */
  function lineAnchorVisible(angle, lvx, lvy, advance, size) {
    switch (normAngle(angle)) {
      case 90: return { vx: lvx + size, vy: lvy };
      case 180: return { vx: lvx + advance, vy: lvy + size };
      case 270: return { vx: lvx, vy: lvy + advance };
      default: return { vx: lvx, vy: lvy };
    }
  }

  function toRgb(PDFLib, color) {
    if (color == null) return PDFLib.rgb(0.07, 0.09, 0.15);
    if (typeof color === "string") {
      var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
      if (!m) return PDFLib.rgb(0, 0, 0);
      return PDFLib.rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
    }
    return PDFLib.rgb(color.r || 0, color.g || 0, color.b || 0);
  }

  /**
   * Draw a block of one or more lines of REAL TEXT on `page`.
   *
   * spec: {
   *   lines: ["SMITH-000123", "CONFIDENTIAL"],   // top line of the stamp first
   *   size: 10,                                  // pt
   *   position: "br",                            // one of POSITIONS, in the READER's frame
   *   marginX, marginY,                          // pt from the visible page edge
   *   angle: 0|90|180|270,                       // how the stamp READS, in the reader's frame
   *   lineGap,                                   // pt between line boxes (default size*0.25)
   *   color: "#111827" | {r,g,b},
   *   align: "l"|"c"|"r"                         // within the block; defaults from `position`
   * }
   * Returns the block's visible-frame box and the per-line user-space anchors actually used,
   * so a caller (and the QA suite) can assert placement without re-deriving the maths.
   */
  function drawBlock(PDFLib, page, font, spec) {
    spec = spec || {};
    var lines = (spec.lines || []).filter(function (t) { return t != null && String(t).length; }).map(String);
    if (!lines.length) return { box: null, anchors: [] };
    var size = spec.size || 10;
    var angle = normAngle(spec.angle || 0);
    var m = measure(font, lines, size, spec.lineGap);
    var frame = visibleFrame(page);
    var marginX = spec.marginX == null ? 28 : spec.marginX;
    var marginY = spec.marginY == null ? 28 : spec.marginY;

    // The block's footprint in the visible frame swaps with a quarter-turn stamp.
    var turned = (angle === 90 || angle === 270);
    var boxW = turned ? m.height : m.width;
    var boxH = turned ? m.width : m.height;
    var origin = blockOrigin(frame, spec.position || "bc", boxW, boxH, marginX, marginY);

    var align = spec.align || (POSITIONS.indexOf(spec.position) >= 0 ? spec.position[1] : "c");
    var userRotation = normAngle(angle + frame.rotate);
    var color = toRgb(PDFLib, spec.color);
    var anchors = [];

    for (var i = 0; i < lines.length; i++) {
      var lw = m.lineWidths[i];
      // `across` runs from the stamp's own TOP edge downward (line stacking direction);
      // `along` runs with the baseline (horizontal alignment inside the block).
      var acrossOff = i * (size + m.gap);
      var alongOff = align === "l" ? 0 : align === "r" ? (m.width - lw) : (m.width - lw) / 2;

      var lvx, lvy;                                   // this line's box lower-left, visible frame
      if (angle === 0) { lvx = origin.vx + alongOff; lvy = origin.vy + boxH - acrossOff - size; }
      else if (angle === 180) { lvx = origin.vx + (m.width - lw - alongOff); lvy = origin.vy + acrossOff; }
      else if (angle === 90) { lvx = origin.vx + acrossOff; lvy = origin.vy + alongOff; }
      else { lvx = origin.vx + boxW - acrossOff - size; lvy = origin.vy + boxH - alongOff - lw; }

      var a = lineAnchorVisible(angle, lvx, lvy, lw, size);
      var u = visibleToUser(frame, a.vx, a.vy);
      page.drawText(lines[i], {
        x: u.x, y: u.y, size: size, font: font,
        rotate: PDFLib.degrees(userRotation), color: color
      });
      anchors.push({
        line: lines[i], x: u.x, y: u.y, rotate: userRotation,
        visible: { x: lvx, y: lvy, w: turned ? size : lw, h: turned ? lw : size }
      });
    }

    return {
      box: { x: origin.vx, y: origin.vy, w: boxW, h: boxH, visW: frame.visW, visH: frame.visH, pageRotate: frame.rotate },
      anchors: anchors, angle: angle, userRotation: userRotation
    };
  }

  /* ═══════════════ CSV ═══════════════ */

  /** RFC-4180 quoting PLUS formula-injection neutralisation: a cell whose first character is
   *  = + - @ (or a leading tab/CR, which a spreadsheet strips before re-reading the first
   *  character) is prefixed with a single quote, so an exhibit index cannot run as a formula
   *  when it is opened. Same rule as pdf-to-excel's CSV export — kept identical on purpose. */
  function csvCell(v) {
    var s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function csv(rows) {
    return rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n") + "\r\n";
  }

  /* ═══════════════ hashing ═══════════════ */

  /** SHA-256 of bytes, lower-case hex. WebCrypto in the browser, node:crypto under Node —
   *  never a hand-rolled digest. */
  async function sha256Hex(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (global.crypto && global.crypto.subtle && global.crypto.subtle.digest) {
      var ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      var d = await global.crypto.subtle.digest("SHA-256", ab);
      var out = "", v = new Uint8Array(d);
      for (var i = 0; i < v.length; i++) out += (v[i] < 16 ? "0" : "") + v[i].toString(16);
      return out;
    }
    if (typeof module !== "undefined" && module.exports) {
      var nodeCrypto = require("node:crypto");
      return nodeCrypto.createHash("sha256").update(Buffer.from(u8)).digest("hex");
    }
    throw new Error("stamp-engine: no SHA-256 implementation available in this environment");
  }

  var API = {
    VERSION: VERSION,
    POSITIONS: POSITIONS,
    batesLabel: batesLabel,
    batesOverflows: batesOverflows,
    numberToLetters: numberToLetters,
    lettersToNumber: lettersToNumber,
    exhibitLabel: exhibitLabel,
    expand: expand,
    isoDate: isoDate,
    winAnsiSafe: winAnsiSafe,
    measure: measure,
    visibleFrame: visibleFrame,
    visibleToUser: visibleToUser,
    blockOrigin: blockOrigin,
    lineAnchorVisible: lineAnchorVisible,
    drawBlock: drawBlock,
    csvCell: csvCell,
    csv: csv,
    sha256Hex: sha256Hex,
    _internal: { normAngle: normAngle, toRgb: toRgb }
  };

  global.UBStamp = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof self !== "undefined" ? self : globalThis);
