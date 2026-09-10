/*!
 * pdf-textops.js — content-stream TEXT operator interpreter for UnboundPDF.
 * (c) 2026 UnboundPDF. All code original.
 *
 * Purpose: map every text-show operator (Tj/TJ/'/") in a page's content stream to
 * {byte range, font, matrix, unicode, widths, rect}, so text can be TRULY DELETED
 * (splice the operators) or repositioned — never covered, never rasterised.
 * Scope by design: the TEXT machine + CTM. Path/shading/image ops are tracked only
 * as opaque tokens (and inline images are skipped safely). The parser is validated
 * against pdf.js text extraction in the harness (parity gate) — it must account for
 * every extracted item or the pipeline refuses to edit that page.
 */
(function (global) {
"use strict";

/* ═══════════════ tokenizer ═══════════════ */
var WS = { 0: 1, 9: 1, 10: 1, 12: 1, 13: 1, 32: 1 };
var DELIM = { 40: 1, 41: 1, 60: 1, 62: 1, 91: 1, 93: 1, 123: 1, 125: 1, 47: 1, 37: 1 };

function tokenize(bytes) {
  var toks = [], i = 0, n = bytes.length;
  function isWS(c) { return WS[c] === 1; }
  function isDelim(c) { return DELIM[c] === 1; }
  while (i < n) {
    var c = bytes[i];
    if (isWS(c)) { i++; continue; }
    if (c === 37) { // % comment
      while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++;
      continue;
    }
    var start = i;
    if (c === 47) { // /Name
      i++;
      var name = "";
      while (i < n && !isWS(bytes[i]) && !isDelim(bytes[i])) {
        var ch = bytes[i];
        if (ch === 35 && i + 2 < n) { // #xx
          name += String.fromCharCode(parseInt(String.fromCharCode(bytes[i + 1], bytes[i + 2]), 16));
          i += 3;
        } else { name += String.fromCharCode(ch); i++; }
      }
      toks.push({ t: "name", v: name, s: start, e: i });
      continue;
    }
    if (c === 40) { // (literal string)
      i++;
      var depth = 1, out = [];
      while (i < n && depth > 0) {
        var b = bytes[i];
        if (b === 92) { // backslash
          var nx = bytes[i + 1];
          if (nx === 110) out.push(10);
          else if (nx === 114) out.push(13);
          else if (nx === 116) out.push(9);
          else if (nx === 98) out.push(8);
          else if (nx === 102) out.push(12);
          else if (nx === 40 || nx === 41 || nx === 92) out.push(nx);
          else if (nx >= 48 && nx <= 55) { // octal
            var oct = 0, k = 0;
            i++;
            while (k < 3 && bytes[i] >= 48 && bytes[i] <= 55) { oct = oct * 8 + (bytes[i] - 48); i++; k++; }
            out.push(oct & 255);
            continue;
          } else if (nx === 10 || nx === 13) { // line continuation
            i += (nx === 13 && bytes[i + 2] === 10) ? 3 : 2;
            continue;
          } else out.push(nx);
          i += 2;
          continue;
        }
        if (b === 40) depth++;
        else if (b === 41) { depth--; if (depth === 0) { i++; break; } }
        out.push(b);
        i++;
      }
      toks.push({ t: "str", v: new Uint8Array(out), s: start, e: i });
      continue;
    }
    if (c === 60 && bytes[i + 1] === 60) { toks.push({ t: "dictopen", s: i, e: i + 2 }); i += 2; continue; }
    if (c === 62 && bytes[i + 1] === 62) { toks.push({ t: "dictclose", s: i, e: i + 2 }); i += 2; continue; }
    if (c === 60) { // <hex string>
      i++;
      var hex = "";
      while (i < n && bytes[i] !== 62) {
        var hc = bytes[i];
        if (!isWS(hc)) hex += String.fromCharCode(hc);
        i++;
      }
      i++;
      if (hex.length % 2) hex += "0";
      var hb = new Uint8Array(hex.length / 2);
      for (var h = 0; h < hb.length; h++) hb[h] = parseInt(hex.substr(h * 2, 2), 16);
      toks.push({ t: "str", v: hb, s: start, e: i });
      continue;
    }
    if (c === 91) { toks.push({ t: "arrayopen", s: i, e: i + 1 }); i++; continue; }
    if (c === 93) { toks.push({ t: "arrayclose", s: i, e: i + 1 }); i++; continue; }
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) { // number
      var nums = "";
      while (i < n && !isWS(bytes[i]) && !isDelim(bytes[i])) { nums += String.fromCharCode(bytes[i]); i++; }
      toks.push({ t: "num", v: parseFloat(nums) || 0, s: start, e: i });
      continue;
    }
    // operator / keyword
    var op = "";
    while (i < n && !isWS(bytes[i]) && !isDelim(bytes[i])) { op += String.fromCharCode(bytes[i]); i++; }
    if (!op.length) { i++; continue; } // stray { } we don't model
    if (op === "BI") { // inline image: skip through EI safely
      var j = i;
      while (j < n - 1) {
        if (isWS(bytes[j]) && bytes[j + 1] === 69 && bytes[j + 2] === 73 &&
            (j + 3 >= n || isWS(bytes[j + 3]) || isDelim(bytes[j + 3]))) { j += 3; break; }
        j++;
      }
      toks.push({ t: "op", v: "BI..EI", s: start, e: j });
      i = j;
      continue;
    }
    toks.push({ t: "op", v: op, s: start, e: i });
  }
  return toks;
}

/* ═══════════════ matrices ═══════════════ */
function matMul(a, b) { // row-vector convention, PDF style: result = a · b
  return [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]
  ];
}
function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
var IDENT = [1, 0, 0, 1, 0, 0];

/* ═══════════════ encodings ═══════════════ */
// WinAnsi differences from Latin-1 live in 0x80-0x9F; the rest maps 1:1 to Unicode.
var WINANSI_HIGH = {
  128: 0x20AC, 130: 0x201A, 131: 0x0192, 132: 0x201E, 133: 0x2026, 134: 0x2020, 135: 0x2021,
  136: 0x02C6, 137: 0x2030, 138: 0x0160, 139: 0x2039, 140: 0x0152, 142: 0x017D, 145: 0x2018,
  146: 0x2019, 147: 0x201C, 148: 0x201D, 149: 0x2022, 150: 0x2013, 151: 0x2014, 152: 0x02DC,
  153: 0x2122, 154: 0x0161, 155: 0x203A, 156: 0x0153, 158: 0x017E, 159: 0x0178
};
// Compact Adobe-glyph-list subset for /Differences (extended as fixtures demand).
var AGL = {
  space: 32, exclam: 33, quotedbl: 34, numbersign: 35, dollar: 36, percent: 37, ampersand: 38,
  quotesingle: 39, parenleft: 40, parenright: 41, asterisk: 42, plus: 43, comma: 44, hyphen: 45,
  period: 46, slash: 47, colon: 58, semicolon: 59, less: 60, equal: 61, greater: 62, question: 63,
  at: 64, bracketleft: 91, backslash: 92, bracketright: 93, asciicircum: 94, underscore: 95,
  grave: 96, braceleft: 123, bar: 124, braceright: 125, asciitilde: 126,
  quoteleft: 0x2018, quoteright: 0x2019, quotedblleft: 0x201C, quotedblright: 0x201D,
  endash: 0x2013, emdash: 0x2014, bullet: 0x2022, dagger: 0x2020, daggerdbl: 0x2021,
  ellipsis: 0x2026, fi: 0xFB01, fl: 0xFB02, germandbls: 0xDF, adieresis: 0xE4, odieresis: 0xF6,
  udieresis: 0xFC, Adieresis: 0xC4, Odieresis: 0xD6, Udieresis: 0xDC, eacute: 0xE9, egrave: 0xE8,
  agrave: 0xE0, ccedilla: 0xE7, Euro: 0x20AC, trademark: 0x2122, copyright: 0xA9, registered: 0xAE,
  degree: 0xB0, plusminus: 0xB1, section: 0xA7, paragraph: 0xB6, middot: 0xB7, sterling: 0xA3
};
function glyphToUni(name) {
  if (AGL[name] != null) return AGL[name];
  var m = name.match(/^uni([0-9A-Fa-f]{4})$/);
  if (m) return parseInt(m[1], 16);
  m = name.match(/^u([0-9A-Fa-f]{4,6})$/);
  if (m) return parseInt(m[1], 16);
  if (name.length === 1) return name.charCodeAt(0);
  return 0xFFFD;
}
function winAnsiToUni(code) {
  if (code >= 128 && code <= 159) return WINANSI_HIGH[code] || 0xFFFD;
  return code;
}

/* ToUnicode CMap parsing (bfchar/bfrange) — covers real-world producers. */
function parseToUnicode(bytes) {
  var s = "";
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  var map = {};
  function hexToStr(h) {
    var out = "";
    for (var k = 0; k + 4 <= h.length; k += 4) out += String.fromCharCode(parseInt(h.substr(k, 4), 16));
    if (h.length === 2) out = String.fromCharCode(parseInt(h, 16));
    return out;
  }
  var chunks = s.match(/beginbfchar[\s\S]*?endbfchar/g) || [];
  chunks.forEach(function (chunk) {
    var pairs = chunk.match(/<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>/g) || [];
    pairs.forEach(function (pr) {
      var hx = pr.match(/<([0-9A-Fa-f]+)>/g).map(function (x) { return x.replace(/[<>]/g, ""); });
      map[parseInt(hx[0], 16)] = hexToStr(hx[1]);
    });
  });
  var ranges = s.match(/beginbfrange[\s\S]*?endbfrange/g) || [];
  ranges.forEach(function (chunk) {
    var lines = chunk.match(/<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>\s*(?:<[0-9A-Fa-f]+>|\[[\s\S]*?\])/g) || [];
    lines.forEach(function (ln) {
      var heads = ln.match(/^<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*([\s\S]*)$/);
      if (!heads) return;
      var lo = parseInt(heads[1], 16), hi = parseInt(heads[2], 16), tail = heads[3].trim();
      if (tail[0] === "[") {
        var items = tail.match(/<([0-9A-Fa-f]+)>/g) || [];
        for (var c3 = lo; c3 <= hi && c3 - lo < items.length; c3++)
          map[c3] = hexToStr(items[c3 - lo].replace(/[<>]/g, ""));
      } else {
        var baseM = tail.match(/<([0-9A-Fa-f]+)>/);
        if (!baseM) return;
        var base = baseM[1];
        for (var c2 = lo; c2 <= hi && c2 - lo < 65536; c2++) {
          var last = parseInt(base.substr(base.length - 4), 16) + (c2 - lo);
          map[c2] = hexToStr(base.substr(0, base.length - 4) + ("0000" + last.toString(16)).slice(-4));
        }
      }
    });
  });
  return map;
}

/* ═══════════════ font model ═══════════════ */
var STD14 = {
  "Helvetica": "Helvetica", "Helvetica-Bold": "HelveticaBold", "Helvetica-Oblique": "HelveticaOblique",
  "Helvetica-BoldOblique": "HelveticaBoldOblique", "Courier": "Courier", "Courier-Bold": "CourierBold",
  "Courier-Oblique": "CourierOblique", "Courier-BoldOblique": "CourierBoldOblique",
  "Times-Roman": "TimesRoman", "Times-Bold": "TimesRomanBold", "Times-Italic": "TimesRomanItalic",
  "Times-BoldItalic": "TimesRomanBoldItalic", "Symbol": "Symbol", "ZapfDingbats": "ZapfDingbats",
  "Arial": "Helvetica", "Arial-Bold": "HelveticaBold", "Arial,Bold": "HelveticaBold",
  "ArialMT": "Helvetica", "Arial-BoldMT": "HelveticaBold", "TimesNewRoman": "TimesRoman",
  "TimesNewRomanPSMT": "TimesRoman", "CourierNew": "Courier"
};

function dictGet(PDFLib, d, k) {
  var N = PDFLib.PDFName;
  try { var v = d.lookup ? d.lookup(N.of(k)) : null; if (v != null) return v; } catch (e) {}
  try { return d.get(N.of(k)); } catch (e2) { return null; }
}

function FontInfo(PDFLib, doc, resName, dict) {
  this.resName = resName;
  this._PDFLib = PDFLib;
  this._doc = doc;
  var N = PDFLib.PDFName;
  function get(d, k) { return dictGet(PDFLib, d, k); }
  this.subtype = String(get(dict, "Subtype") || "");
  this.baseFont = String(get(dict, "BaseFont") || "").replace(/^\//, "").replace(/^[A-Z]{6}\+/, "");
  this.type0 = this.subtype === "/Type0";
  this.toUnicode = null;
  var tu = get(dict, "ToUnicode");
  if (tu) {
    try {
      var tuStream = tu.dict ? tu : doc.context.lookup(tu);
      this.toUnicode = parseToUnicode(PDFLib.decodePDFRawStream(tuStream).decode());
    } catch (e) {}
  }

  // font descriptor (for the embedded program) — Type0 keeps it on the descendant
  this._descriptor = null;
  try {
    if (this.type0) {
      var dfs = get(dict, "DescendantFonts");
      var df0 = dfs && dfs.lookup ? dfs.lookup(0) : null;
      this._descriptor = df0 ? get(df0, "FontDescriptor") : null;
      this.identityH = /Identity-H/.test(String(get(dict, "Encoding") || ""));
    } else {
      this._descriptor = get(dict, "FontDescriptor");
    }
  } catch (e) {}

  if (this.type0) {
    this.bytesPerCode = 2; // Identity-H (the near-universal case; others fall to uneditable anyway)
    this.widths = {};
    this.defaultWidth = 1000;
    var desc = get(dict, "DescendantFonts");
    try {
      var d0 = desc && desc.lookup ? desc.lookup(0) : null;
      if (d0) {
        var dw = get(d0, "DW");
        if (dw != null) this.defaultWidth = dw.asNumber ? dw.asNumber() : parseFloat(String(dw)) || 1000;
        var W = get(d0, "W");
        if (W && W.size) {
          var flat = [];
          for (var i = 0; i < W.size(); i++) flat.push(W.lookup(i));
          for (var k = 0; k < flat.length;) {
            var c1 = flat[k] && flat[k].asNumber ? flat[k].asNumber() : NaN;
            var nxt = flat[k + 1];
            if (nxt && nxt.size !== undefined) { // c [w w ...]
              for (var li = 0; li < nxt.size(); li++) {
                var wv = nxt.lookup(li);
                this.widths[c1 + li] = wv && wv.asNumber ? wv.asNumber() : 1000;
              }
              k += 2;
            } else if (nxt && nxt.asNumber) { // c1 c2 w
              var c2v = nxt.asNumber();
              var w3 = flat[k + 2] && flat[k + 2].asNumber ? flat[k + 2].asNumber() : 1000;
              for (var cc = c1; cc <= c2v && cc - c1 < 65536; cc++) this.widths[cc] = w3;
              k += 3;
            } else k += 1;
          }
        }
      }
    } catch (e) {}
    // Phase 2: Identity-H composites with a ToUnicode map are editable (write = inverse
    // ToUnicode + /W widths, chars restricted to the subset's proven coverage)
    this.editable = !!(this.identityH && this.toUnicode);
    this.uneditableReason = this.editable ? null : "composite font without Identity-H + ToUnicode";
  } else {
    this.bytesPerCode = 1;
    this.encBase = "WinAnsi";
    this.diff = null;
    var enc = get(dict, "Encoding");
    if (enc) {
      var encName = String(enc);
      if (/WinAnsi/.test(encName)) this.encBase = "WinAnsi";
      else if (/MacRoman/.test(encName)) this.encBase = "MacRoman";
      else if (/Standard/.test(encName)) this.encBase = "Standard";
      else if (enc.lookup || enc.get) {
        var be = get(enc, "BaseEncoding");
        if (be && /WinAnsi/.test(String(be))) this.encBase = "WinAnsi";
        var da = get(enc, "Differences");
        if (da && da.size) {
          this.diff = {};
          var code = 0;
          for (var di = 0; di < da.size(); di++) {
            var item = da.lookup(di);
            if (item && item.asNumber) code = item.asNumber();
            else {
              var nm = String(item).replace(/^\//, "");
              if (/^-?[\d.]+$/.test(nm)) code = parseFloat(nm);
              else this.diff[code++] = nm;
            }
          }
        }
      }
    }
    this.firstChar = 0;
    this.charWidths = null;
    var fc = get(dict, "FirstChar");
    var wsArr = get(dict, "Widths");
    if (wsArr && wsArr.size) {
      this.firstChar = fc && fc.asNumber ? fc.asNumber() : parseFloat(String(fc)) || 0;
      this.charWidths = [];
      for (var wi = 0; wi < wsArr.size(); wi++) {
        var wv2 = wsArr.lookup(wi);
        this.charWidths.push(wv2 && wv2.asNumber ? wv2.asNumber() : 0);
      }
    }
    this.stdName = STD14[this.baseFont] || null;
    this.editable = true;
  }
}
/** Decoded embedded font program bytes, or null. kind: FontFile|FontFile2|FontFile3 */
FontInfo.prototype.programBytes = function () {
  if (this._prog !== undefined) return this._prog;
  this._prog = null;
  var PDFLib = this._PDFLib;
  if (this._descriptor) {
    var kinds = ["FontFile2", "FontFile3", "FontFile"];
    for (var i = 0; i < kinds.length; i++) {
      var ref = dictGet(PDFLib, this._descriptor, kinds[i]);
      if (ref) {
        try {
          var st = ref.dict ? ref : this._doc.context.lookup(ref);
          this._prog = { kind: kinds[i], bytes: PDFLib.decodePDFRawStream(st).decode() };
          break;
        } catch (e) {}
      }
    }
  }
  return this._prog;
};

/** unicode string char → code map for WRITING with this font's own resource.
 *  Only codes the font can genuinely show: width-bearing (or std-14), preferring codes
 *  the document already used. Returns null when inversion is impossible. */
FontInfo.prototype.inverseMap = function () {
  if (this._inv !== undefined) return this._inv;
  var inv = {};
  if (this.type0) {
    if (!this.toUnicode || !this.identityH) return (this._inv = null);
    for (var codeS in this.toUnicode) {
      var uni = this.toUnicode[codeS];
      if (uni && uni.length && inv[uni] == null) inv[uni] = +codeS;
    }
    return (this._inv = inv);
  }
  for (var c = 0; c <= 255; c++) {
    var u;
    if (this.toUnicode && this.toUnicode[c] != null) u = this.toUnicode[c];
    else if (this.diff && this.diff[c]) u = String.fromCharCode(glyphToUni(this.diff[c]));
    else if (this.encBase === "WinAnsi") u = String.fromCharCode(winAnsiToUni(c));
    else if (c >= 32 && c <= 126) u = String.fromCharCode(c);
    else continue;
    if (u === "�" || u === "�") continue;
    var hasWidth = this.charWidths
      ? (c >= this.firstChar && c - this.firstChar < this.charWidths.length && this.charWidths[c - this.firstChar] > 0)
      : !!this.stdName; // std-14: metrics exist for the full encoding
    // Word writes /Widths 0 for codes it renders via the font program's hmtx table —
    // a code the DOCUMENT shows is proven renderable regardless of its /Widths entry.
    if (!hasWidth && !(this.usedCodes && this.usedCodes[c] != null)) continue;
    if (inv[u] == null || (this.usedCodes && this.usedCodes[c] != null)) inv[u] = c;
  }
  return (this._inv = inv);
};

FontInfo.prototype.widthOfCode = function (code) {
  if (this.type0) return this.widths[code] != null ? this.widths[code] : this.defaultWidth;
  if (this.charWidths && code >= this.firstChar && code - this.firstChar < this.charWidths.length) {
    var w = this.charWidths[code - this.firstChar];
    return w > 0 ? w : null;
  }
  return null;
};

FontInfo.prototype.decode = function (bytes) {
  var out = [];
  if (this.bytesPerCode === 2) {
    for (var i = 0; i + 1 < bytes.length; i += 2) {
      var code = (bytes[i] << 8) | bytes[i + 1];
      var uni = this.toUnicode && this.toUnicode[code] != null ? this.toUnicode[code] : "�";
      out.push({ code: code, uni: uni, w1000: this.widths[code] != null ? this.widths[code] : this.defaultWidth });
    }
    return out;
  }
  for (var j = 0; j < bytes.length; j++) {
    var c = bytes[j], u;
    if (this.toUnicode && this.toUnicode[c] != null) u = this.toUnicode[c];
    else if (this.diff && this.diff[c]) u = String.fromCharCode(glyphToUni(this.diff[c]));
    else if (this.encBase === "WinAnsi") u = String.fromCharCode(winAnsiToUni(c));
    else u = String.fromCharCode(c);
    var w = null;
    if (this.charWidths && c >= this.firstChar && c - this.firstChar < this.charWidths.length) {
      w = this.charWidths[c - this.firstChar] || null;
    }
    out.push({ code: c, uni: u, w1000: w }); // null → resolved via std-14 metrics later
  }
  return out;
};

/* ═══════════════ the interpreter ═══════════════ */
function analyze(PDFLib, doc, pageIndex) {
  var page = doc.getPage(pageIndex);
  var N = PDFLib.PDFName;
  var rotate = 0;
  try { rotate = page.getRotation().angle || 0; } catch (e) {}
  rotate = ((rotate % 360) + 360) % 360;
  /* Coordinates are viewer-relative: pdf.js (and the editor) work in the CropBox with its
     origin subtracted. Use CropBox when present, else MediaBox, and carry the origin so
     device points map exactly onto editor space (offset-origin files were silently wrong). */
  var box = { x: 0, y: 0, w: page.getWidth(), h: page.getHeight() };
  try {
    var cb = page.node.CropBox ? page.node.CropBox() : null;
    var mb = page.node.MediaBox ? page.node.MediaBox() : null;
    var use = cb || mb;
    if (use && use.size && use.size() === 4) {
      var b0 = use.lookup(0).asNumber(), b1 = use.lookup(1).asNumber();
      var b2 = use.lookup(2).asNumber(), b3 = use.lookup(3).asNumber();
      box = { x: Math.min(b0, b2), y: Math.min(b1, b3), w: Math.abs(b2 - b0), h: Math.abs(b3 - b1) };
    }
  } catch (e) {}
  var pdfW = box.w, pdfH = box.h;

  var contents = page.node.Contents();
  var streams = [];
  if (contents instanceof PDFLib.PDFArray) {
    for (var ci = 0; ci < contents.size(); ci++) streams.push(contents.lookup(ci));
  } else if (contents) streams.push(contents);
  var parts = [], total = 0;
  streams.forEach(function (st) {
    var dec = PDFLib.decodePDFRawStream(st).decode();
    parts.push(dec);
    total += dec.length + 1;
  });
  var bytes = new Uint8Array(total);
  var off = 0;
  parts.forEach(function (p) { bytes.set(p, off); off += p.length; bytes[off++] = 10; });

  var fonts = {};
  var res = page.node.Resources();
  var fdict = res ? res.lookup(N.of("Font")) : null;
  if (fdict && fdict.keys) {
    fdict.keys().forEach(function (k) {
      var name = String(k).replace(/^\//, "");
      try {
        fonts[name] = new FontInfo(PDFLib, doc, name, fdict.lookup(k));
        // the raw (possibly indirect) ref — page overflow re-registers it on the target page
        fonts[name].rawRef = fdict.get ? fdict.get(k) : null;
      } catch (e) {}
    });
  }
  // XObject subtypes: images are anchors that can MOVE with a push (via their cm);
  // form XObjects stay opaque refusals
  var xobjKinds = {};
  var xdict = res ? res.lookup(N.of("XObject")) : null;
  if (xdict && xdict.keys) {
    xdict.keys().forEach(function (k) {
      try {
        var xo = xdict.lookup(k);
        var xd = xo && xo.dict ? xo.dict : xo;
        var st = xd && xd.lookup ? xd.lookup(N.of("Subtype")) : null;
        xobjKinds[String(k).replace(/^\//, "")] = String(st || "").replace(/^\//, "");
      } catch (e) {}
    });
  }

  var toks = tokenize(bytes);

  var ctm = IDENT.slice(), ctmStack = [];
  var tm = IDENT.slice(), tlm = IDENT.slice();
  var font = null, size = 0, TL = 0, Tc = 0, Tw = 0, Tz = 100, Ts = 0, Tr = 0;
  var color = "0 0 0 rg";
  var lastPosOp = null;
  // relative-positioning chains: BT or Tm starts a chain; Td/TD/T*/'/" records inherit
  // their absolute anchor from the chain's head — a Tm, or a first Td/TD straight after
  // BT (absolute while the line matrix is identity) — moving the head moves them all
  var chainSeq = 0, chainHeads = {}, btOrigin = false;
  var lastCm = null; // most recent cm at the current q depth — the would-be image anchor
  var records = [], stack = [], notes = { unknownOps: {}, type0Runs: 0, formXObjects: 0 };
  /* Non-text content extents (device space), so vertical translation can PROVE nothing
     visual is left behind: paths, images, form XObjects. Text inside form XObjects is not
     descended into — pages using them fail the parity gate and fall back honestly. */
  var graphics = [];
  var pendingPath = null;
  var clipBox = null, clipStack = []; // device-space intersection of active W clips
  function pathPoint(x, y) {
    var p = apply(ctm, x, y);
    if (!pendingPath) pendingPath = { x0: p[0], y0: p[1], x1: p[0], y1: p[1], segs: [], ctm: ctm.slice(), mixedCtm: false, clipped: false };
    else {
      pendingPath.x0 = Math.min(pendingPath.x0, p[0]);
      pendingPath.y0 = Math.min(pendingPath.y0, p[1]);
      pendingPath.x1 = Math.max(pendingPath.x1, p[0]);
      pendingPath.y1 = Math.max(pendingPath.y1, p[1]);
      // a cm between segments = pieces living in different spaces; not movable as one
      for (var mi = 0; mi < 6; mi++) if (Math.abs(pendingPath.ctm[mi] - ctm[mi]) > 1e-9) { pendingPath.mixedCtm = true; break; }
    }
  }
  /** The y-coordinate NUMBER tokens of one path op — the spans a vertical translation
   *  must rewrite to move this path in the structure (Phase 4b: rules/boxes move too). */
  function pathYToks(toks2) {
    if (!pendingPath) return;
    toks2.forEach(function (a) {
      if (a && a.t === "num" && a.s != null) pendingPath.segs.push({ s: a.s, e: a.e, v: a.v || 0 });
      else pendingPath.mixedCtm = true; // un-rewritable operand (name/var token) — refuse the move
    });
  }
  function flushPath(kind) {
    if (!pendingPath) return;
    graphics.push({
      type: kind, x0: pendingPath.x0, y0: pendingPath.y0, x1: pendingPath.x1, y1: pendingPath.y1,
      segs: pendingPath.segs, pathCtm: pendingPath.ctm, mixedCtm: pendingPath.mixedCtm,
      clip: clipBox ? { x0: clipBox.x0, y0: clipBox.y0, x1: clipBox.x1, y1: clipBox.y1 } : null
    });
    pendingPath = null;
  }
  function unitBox(kind, cmRef) {
    var c0 = apply(ctm, 0, 0), c1 = apply(ctm, 1, 1), c2 = apply(ctm, 1, 0), c3 = apply(ctm, 0, 1);
    graphics.push({
      type: kind,
      x0: Math.min(c0[0], c1[0], c2[0], c3[0]), y0: Math.min(c0[1], c1[1], c2[1], c3[1]),
      x1: Math.max(c0[0], c1[0], c2[0], c3[0]), y1: Math.max(c0[1], c1[1], c2[1], c3[1]),
      // the placing cm op (span + values + the CTM it composed onto): rewriting its ty
      // moves this object — the anchor mechanics of Phase 4
      cmOp: cmRef ? { s: cmRef.s, e: cmRef.e, vals: cmRef.vals.slice(), outer: cmRef.outer.slice() } : null,
      ctm: ctm.slice()
    });
  }

  var vw = (rotate === 90 || rotate === 270) ? pdfH : pdfW;
  var vh = (rotate === 90 || rotate === 270) ? pdfW : pdfH;
  function toViewport(xd, yd) { // device space → rotated viewport space (bottom-up), box-origin removed
    // conventions proven against pdf.js viewport transforms (top-down yv):
    //   0: xv=x,  yv=H−y | 90: xv=y, yv=x | 180: xv=W−x, yv=y | 270: xv=H−y, yv=W−x
    // the pipeline expects bottom-up y (vh − yv), so each case returns [xv, vh − yv].
    var x = xd - box.x, y = yd - box.y;
    if (rotate === 90) return [y, vh - x];
    if (rotate === 180) return [pdfW - x, vh - y];
    if (rotate === 270) return [pdfH - y, vh - (pdfW - x)];
    return [x, y];
  }
  function rotMatrix(m) { return Math.abs(m[1]) > 0.001 || Math.abs(m[2]) > 0.001; }
  /** Editable = upright IN THE ROTATED VIEW: on a /Rotate page, real documents paint
   *  text pre-rotated so the viewer shows it upright — exactly the matrix shape our
   *  rotation-aware writer (viewportToTm) emits. sc = the glyph scale. */
  function viewUpright(trm) {
    var sc = Math.hypot(trm[2], trm[3]);
    if (!sc) return false;
    var tol = 0.02 * sc;
    if (rotate === 90) return Math.abs(trm[0]) < tol && Math.abs(trm[3]) < tol && trm[1] > 0 && trm[2] < 0;
    if (rotate === 180) return Math.abs(trm[1]) < tol && Math.abs(trm[2]) < tol && trm[0] < 0 && trm[3] < 0;
    if (rotate === 270) return Math.abs(trm[0]) < tol && Math.abs(trm[3]) < tol && trm[1] < 0 && trm[2] > 0;
    return !rotMatrix(trm);
  }

  function emitShow(strTok, tjParts, opStart, opEnd) {
    if (!font || !size) return;
    var chars = [];
    var advance = 0;
    var pieces = tjParts || [{ str: strTok.v }];
    var text = "";
    var hasPendingWidths = false;
    pieces.forEach(function (p) {
      if (p.adj != null) { advance += (-p.adj / 1000) * size * (Tz / 100); return; }
      font.decode(p.str).forEach(function (d) {
        var w1000 = d.w1000;
        if (w1000 == null) { w1000 = 500; hasPendingWidths = true; }
        var adv = ((w1000 / 1000) * size + Tc + (d.code === 32 ? Tw : 0)) * (Tz / 100);
        chars.push({ code: d.code, uni: d.uni, adv: adv, w1000: d.w1000, pend: d.w1000 == null });
        text += d.uni;
        advance += adv;
      });
    });
    var trm = matMul(tm, ctm);
    var p0 = apply(trm, 0, Ts);
    var pE = apply(trm, advance, Ts);
    var pT = apply(trm, 0, Ts + size * 0.88);
    var pB = apply(trm, 0, Ts - size * 0.22);
    var xsA = [p0[0], pE[0], pT[0], pB[0]], ysA = [p0[1], pE[1], pT[1], pB[1]];
    var vp0 = toViewport(Math.min.apply(0, xsA), Math.min.apply(0, ysA));
    var vp1 = toViewport(Math.max.apply(0, xsA), Math.max.apply(0, ysA));
    var xmin = Math.min(vp0[0], vp1[0]), xmax = Math.max(vp0[0], vp1[0]);
    var ymin = Math.min(vp0[1], vp1[1]), ymax = Math.max(vp0[1], vp1[1]);
    var baseVp = toViewport(p0[0], p0[1]);
    records.push({
      id: records.length,
      s: opStart, e: opEnd,
      posOp: lastPosOp ? { kind: lastPosOp.kind, s: lastPosOp.s, e: lastPosOp.e, vals: lastPosOp.vals.slice() } : null,
      chainId: chainSeq,
      resName: font.resName, baseFont: font.baseFont, subtype: font.subtype, stdName: font.stdName || null,
      type0: font.type0,
      editable: font.editable !== false && viewUpright(trm),
      uneditableReason: font.editable === false ? font.uneditableReason : (!viewUpright(trm) ? "rotated or skewed text matrix" : null),
      size: size, sizeDev: size * Math.hypot(trm[2], trm[3]),
      renderMode: Tr, invisible: Tr === 3,
      color: color,
      tm: tm.slice(), tlm: tlm.slice(), ctm: ctm.slice(),
      Tc: Tc, Tw: Tw, Tz: Tz,
      text: text, chars: chars, pendingWidths: hasPendingWidths,
      rect: { x: xmin, top: vh - ymax, right: xmax, bottom: vh - ymin },
      baselineTop: vh - baseVp[1],
      advance: advance
    });
    if (font.type0) notes.type0Runs++;
    if (!font.usedCodes) font.usedCodes = {};
    chars.forEach(function (c2) { font.usedCodes[c2.code] = c2.uni; });
    tm = matMul([1, 0, 0, 1, advance, 0], tm);
  }

  for (var ti = 0; ti < toks.length; ti++) {
    var tk = toks[ti];
    if (tk.t !== "op") { stack.push(tk); continue; }
    var op = tk.v;
    var args = stack;
    switch (op) {
      case "q": ctmStack.push(ctm.slice()); clipStack.push(clipBox); break;
      case "Q":
        ctm = ctmStack.pop() || IDENT.slice();
        clipBox = clipStack.length ? clipStack.pop() : null;
        if (lastCm && ctmStack.length < lastCm.depth) lastCm = null; // out of scope
        break;
      case "cm":
        if (args.length >= 6) {
          var mv = args.slice(-6).map(function (a) { return a.v || 0; });
          lastCm = { s: args[args.length - 6].s, e: tk.e, vals: mv, outer: ctm.slice(), depth: ctmStack.length };
          ctm = matMul(mv, ctm);
        }
        break;
      case "BT": tm = IDENT.slice(); tlm = IDENT.slice(); lastPosOp = null; chainSeq++; btOrigin = true; break;
      case "ET": break;
      case "Tf":
        if (args.length >= 2) {
          font = fonts[args[args.length - 2].v] || null;
          size = args[args.length - 1].v || 0;
        }
        break;
      case "TL": if (args.length) TL = args[args.length - 1].v; break;
      case "Tr": if (args.length) Tr = args[args.length - 1].v; break;
      case "Tc": if (args.length) Tc = args[args.length - 1].v; break;
      case "Tw": if (args.length) Tw = args[args.length - 1].v; break;
      case "Tz": if (args.length) Tz = args[args.length - 1].v; break;
      case "Ts": if (args.length) Ts = args[args.length - 1].v; break;
      case "Tm":
        if (args.length >= 6) {
          var tv = args.slice(-6).map(function (a) { return a.v || 0; });
          tm = tv.slice(); tlm = tv.slice();
          lastPosOp = { kind: "Tm", s: args[args.length - 6].s, e: tk.e, vals: tv };
          btOrigin = false;
          chainSeq++;
          chainHeads[chainSeq] = { s: lastPosOp.s, e: lastPosOp.e, vals: tv.slice() };
        }
        break;
      case "Td":
        if (args.length >= 2) {
          var tx = args[args.length - 2].v || 0, ty = args[args.length - 1].v || 0;
          // pdftex positions with a bare Td straight after BT — the line matrix is still
          // identity, so this Td IS absolute and can head the chain (rewritable as a Tm)
          if (btOrigin)
            chainHeads[chainSeq] = { s: args[args.length - 2].s, e: tk.e, vals: [1, 0, 0, 1, tx, ty], asTm: true, tl: null };
          btOrigin = false;
          tlm = matMul([1, 0, 0, 1, tx, ty], tlm);
          tm = tlm.slice();
          lastPosOp = { kind: "Td", s: args[args.length - 2].s, e: tk.e, vals: [tx, ty] };
        }
        break;
      case "TD":
        if (args.length >= 2) {
          var tx2 = args[args.length - 2].v || 0, ty2 = args[args.length - 1].v || 0;
          if (btOrigin)
            chainHeads[chainSeq] = { s: args[args.length - 2].s, e: tk.e, vals: [1, 0, 0, 1, tx2, ty2], asTm: true, tl: -ty2 };
          btOrigin = false;
          TL = -ty2;
          tlm = matMul([1, 0, 0, 1, tx2, ty2], tlm);
          tm = tlm.slice();
          lastPosOp = { kind: "TD", s: args[args.length - 2].s, e: tk.e, vals: [tx2, ty2] };
        }
        break;
      case "T*":
        btOrigin = false;
        tlm = matMul([1, 0, 0, 1, 0, -TL], tlm);
        tm = tlm.slice();
        lastPosOp = { kind: "T*", s: tk.s, e: tk.e, vals: [] };
        break;
      case "Tj":
        if (args.length && args[args.length - 1].t === "str")
          emitShow(args[args.length - 1], null, args[args.length - 1].s, tk.e);
        break;
      case "'":
        btOrigin = false;
        tlm = matMul([1, 0, 0, 1, 0, -TL], tlm); tm = tlm.slice();
        lastPosOp = { kind: "T*", s: tk.s, e: tk.e, vals: [] };
        if (args.length && args[args.length - 1].t === "str") {
          var nQ1 = records.length;
          emitShow(args[args.length - 1], null, args[args.length - 1].s, tk.e);
          // the show op ITSELF advances the line matrix — splicing it would shift
          // every later record in the chain
          if (records.length > nQ1) records[records.length - 1].selfAdvance = true;
        }
        break;
      case '"':
        if (args.length >= 3) {
          Tw = args[args.length - 3].v || 0;
          Tc = args[args.length - 2].v || 0;
          btOrigin = false;
          tlm = matMul([1, 0, 0, 1, 0, -TL], tlm); tm = tlm.slice();
          lastPosOp = { kind: "T*", s: tk.s, e: tk.e, vals: [] };
          if (args[args.length - 1].t === "str") {
            var nQ2 = records.length;
            emitShow(args[args.length - 1], null, args[args.length - 3].s, tk.e);
            if (records.length > nQ2) records[records.length - 1].selfAdvance = true;
          }
        }
        break;
      case "TJ": {
        var parts2 = [], startS = tk.s;
        var depth2 = 0, j2 = args.length - 1;
        if (j2 >= 0 && args[j2].t === "arrayclose") {
          j2--;
          var items2 = [];
          for (; j2 >= 0; j2--) {
            if (args[j2].t === "arrayclose") depth2++;
            else if (args[j2].t === "arrayopen") { if (!depth2) break; depth2--; }
            else items2.unshift(args[j2]);
          }
          if (j2 >= 0) startS = args[j2].s;
          items2.forEach(function (it) {
            if (it.t === "str") parts2.push({ str: it.v });
            else if (it.t === "num") parts2.push({ adj: it.v });
          });
          emitShow(null, parts2, startS, tk.e);
        }
        break;
      }
      case "rg": case "g": case "k": case "sc": case "scn":
        color = args.map(function (a) { return a.t === "num" ? +a.v.toFixed(4) : String(a.v); }).join(" ") + " " + op;
        break;
      case "m": case "l":
        if (args.length >= 2) {
          pathPoint(args[args.length - 2].v || 0, args[args.length - 1].v || 0);
          pathYToks([args[args.length - 1]]);
        }
        break;
      case "c":
        if (args.length >= 6) {
          var cv = args.slice(-6).map(function (a) { return a.v || 0; });
          pathPoint(cv[0], cv[1]); pathPoint(cv[2], cv[3]); pathPoint(cv[4], cv[5]);
          pathYToks([args[args.length - 5], args[args.length - 3], args[args.length - 1]]);
        }
        break;
      case "v": case "y":
        if (args.length >= 4) {
          var vv = args.slice(-4).map(function (a) { return a.v || 0; });
          pathPoint(vv[0], vv[1]); pathPoint(vv[2], vv[3]);
          pathYToks([args[args.length - 3], args[args.length - 1]]);
        }
        break;
      case "re":
        if (args.length >= 4) {
          var rv = args.slice(-4).map(function (a) { return a.v || 0; });
          pathPoint(rv[0], rv[1]); pathPoint(rv[0] + rv[2], rv[1] + rv[3]);
          pathYToks([args[args.length - 3]]); // the y origin; width/height are lengths
        }
        break;
      case "S": case "s": case "f": case "F": case "f*": case "B": case "B*": case "b": case "b*":
        flushPath("path");
        break;
      case "n": case "W": case "W*": case "h":
        // a W/W* clip carved from the current path constrains everything painted later
        // in this q-scope — a moved path could slide out of it, so paths remember it
        if ((op === "W" || op === "W*") && pendingPath)
          clipBox = clipBox
            ? { x0: Math.max(clipBox.x0, pendingPath.x0), y0: Math.max(clipBox.y0, pendingPath.y0), x1: Math.min(clipBox.x1, pendingPath.x1), y1: Math.min(clipBox.y1, pendingPath.y1) }
            : { x0: pendingPath.x0, y0: pendingPath.y0, x1: pendingPath.x1, y1: pendingPath.y1 };
        if (op === "n") flushPath("clip");
        break;
      case "Do": {
        var xnm = args.length ? String(args[args.length - 1].v || "") : "";
        var xkind = xobjKinds[xnm] === "Image" ? "image" : "xobject";
        if (xkind === "xobject") notes.formXObjects++;
        unitBox(xkind, lastCm && lastCm.depth === ctmStack.length ? lastCm : null);
        break;
      }
      case "BI..EI": unitBox("image", lastCm && lastCm.depth === ctmStack.length ? lastCm : null); break;
      case "sh": unitBox("shading"); break;
      default:
        if (!/^(w|J|j|M|d|ri|i|gs|cs|CS|SC|SCN|G|RG|K|BMC|BDC|EMC|MP|DP|d0|d1|Tr)$/.test(op))
          notes.unknownOps[op] = (notes.unknownOps[op] || 0) + 1;
    }
    stack = [];
  }

  // graphics extents in viewport/top-left space, matching text record rects
  var graphicsTL = graphics.map(function (gr) {
    var a0 = toViewport(gr.x0, gr.y0), a1 = toViewport(gr.x1, gr.y1);
    var out = {
      type: gr.type,
      x: Math.min(a0[0], a1[0]), right: Math.max(a0[0], a1[0]),
      top: vh - Math.max(a0[1], a1[1]), bottom: vh - Math.min(a0[1], a1[1]),
      cmOp: gr.cmOp || null,
      ctm: gr.ctm || null
    };
    if (gr.type === "path") {
      out.segs = gr.segs || [];
      out.pathCtm = gr.pathCtm || null;
      out.mixedCtm = !!gr.mixedCtm;
      if (gr.clip) {
        var c0 = toViewport(gr.clip.x0, gr.clip.y0), c1 = toViewport(gr.clip.x1, gr.clip.y1);
        out.clipTop = vh - Math.max(c0[1], c1[1]);
        out.clipBottom = vh - Math.min(c0[1], c1[1]);
      }
    }
    return out;
  });

  return { bytes: bytes, records: records, fonts: fonts, notes: notes, graphics: graphicsTL, pdfW: pdfW, pdfH: pdfH, rotate: rotate, vw: vw, vh: vh, box: box, chainHeads: chainHeads };
}

/** Resolve widths for standard-14 fonts without /Widths, via pdf-lib AFM metrics.
 *  stdFonts: { stdName: embedded pdf-lib font }. Recomputes advances + x-extents. */
function resolveStdWidths(analysis, stdFonts) {
  analysis.records.forEach(function (r) {
    if (!r.pendingWidths || !r.stdName || !stdFonts[r.stdName]) return;
    var f = stdFonts[r.stdName];
    var adv = 0;
    r.chars.forEach(function (c) {
      if (c.pend) {
        try {
          c.w1000 = f.widthOfTextAtSize(c.uni, 1000);
          c.adv = ((c.w1000 / 1000) * r.size + r.Tc + (c.code === 32 ? r.Tw : 0)) * (r.Tz / 100);
          c.pend = false;
        } catch (e) {}
      }
      adv += c.adv;
    });
    r.advance = adv;
    r.pendingWidths = false;
    if (analysis.rotate === 0 && Math.abs(r.tm[1]) < 0.001 && Math.abs(r.tm[2]) < 0.001) {
      var trm = matMul(r.tm, r.ctm);
      var p0 = apply(trm, 0, 0), pE = apply(trm, adv, 0);
      var bx = analysis.box ? analysis.box.x : 0; // viewport space, not device space
      r.rect.x = Math.min(p0[0], pE[0]) - bx;
      r.rect.right = Math.max(p0[0], pE[0]) - bx;
    }
  });
}

/** Remove records (by id) from the stream → new bytes. */
function splice(analysis, ids) {
  var kill = {};
  ids.forEach(function (i) { kill[i] = 1; });
  var ranges = analysis.records.filter(function (r) { return kill[r.id]; })
    .map(function (r) { return [r.s, r.e]; })
    .sort(function (a, b) { return a[0] - b[0]; });
  if (!ranges.length) return analysis.bytes;
  var out = [], pos = 0, b = analysis.bytes;
  ranges.forEach(function (rg) {
    if (rg[0] > pos) out.push(b.subarray(pos, rg[0]));
    pos = Math.max(pos, rg[1]);
  });
  out.push(b.subarray(pos));
  var totalLen = out.reduce(function (n, p) { return n + p.length + 1; }, 0);
  var res = new Uint8Array(totalLen);
  var o = 0;
  out.forEach(function (p) { res.set(p, o); o += p.length; res[o++] = 32; });
  return res;
}

/** Can this record be moved vertically? Geometric gate only — upright, unrotated.
 *  STRUCTURAL validity (an anchorable positioning op at every shift boundary) is
 *  checked chain-by-chain in the caller; non-boundary members inherit their shift
 *  through the rewritten anchor and need no op of their own. */
function translatable(record, analysis) {
  if (analysis.rotate !== 0) return false;
  return Math.abs(record.ctm[1]) < 0.001 && Math.abs(record.ctm[2]) < 0.001 &&
         Math.abs(record.tm[1]) < 0.001 && Math.abs(record.tm[2]) < 0.001;
}

/** Move records DOWN by dy (top-left points) by rewriting their absolute Tm ops. */
function translateY(analysis, ids, dyTopLeft) {
  var kill = {};
  ids.forEach(function (i) { kill[i] = 1; });
  var edits = [];
  var seen = {};
  analysis.records.forEach(function (r) {
    if (!kill[r.id] || !r.posOp || seen[r.posOp.s]) return;
    seen[r.posOp.s] = 1; // several shows can share one Tm — rewrite once
    var v = r.posOp.vals;
    var repl = v[0] + " " + v[1] + " " + v[2] + " " + v[3] + " " + v[4] + " " + (+(v[5] - dyTopLeft).toFixed(3)) + " Tm";
    edits.push({ s: r.posOp.s, e: r.posOp.e, repl: repl });
  });
  edits.sort(function (a, b) { return a.s - b.s; });
  var out = [], pos = 0, b = analysis.bytes;
  var enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  function encode(str) {
    if (enc) return enc.encode(str);
    var u = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 255;
    return u;
  }
  edits.forEach(function (ed) {
    if (ed.s > pos) out.push(b.subarray(pos, ed.s));
    out.push(encode(ed.repl));
    pos = ed.e;
  });
  out.push(b.subarray(pos));
  var totalLen = out.reduce(function (n, p2) { return n + p2.length; }, 0);
  var res = new Uint8Array(totalLen);
  var o = 0;
  out.forEach(function (p2) { res.set(p2, o); o += p2.length; });
  return res;
}

/** Write bytes back as the page's single content stream. */
function writeStream(PDFLib, doc, pageIndex, newBytes) {
  var page = doc.getPage(pageIndex);
  var context = doc.context;
  var stream = context.flateStream ? context.flateStream(newBytes) : context.stream(newBytes);
  var ref = context.register(stream);
  page.node.set(PDFLib.PDFName.of("Contents"), ref);
}

/* Can every char of s be written in WinAnsi (so a base-14 font can carry it)? */
var WINANSI_INV = (function () {
  var inv = {};
  Object.keys(WINANSI_HIGH).forEach(function (k) { inv[WINANSI_HIGH[k]] = +k; });
  return inv;
})();
function winAnsiEncodable(s) {
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c === 10 || c === 13 || c === 9) continue;
    if (c < 32) return false;
    if (c <= 0x7F) continue;
    if (c >= 0xA0 && c <= 0xFF) continue;
    if (WINANSI_INV[c] != null) continue;
    return false;
  }
  return true;
}

var API = {
  analyze: analyze, splice: splice, translateY: translateY, translatable: translatable,
  resolveStdWidths: resolveStdWidths, writeStream: writeStream, winAnsiEncodable: winAnsiEncodable,
  _tokenize: tokenize, _parseToUnicode: parseToUnicode
};
global.PDFTextOps = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof self !== "undefined" ? self : globalThis);
