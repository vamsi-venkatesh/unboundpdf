"use strict";
/* UnboundPDF shared engine v2 — load/save/download, PDF.js helpers, thumbnails,
   progress, result screen with preview, human-readable errors, ZIP, dropzone. */
(function (global) {
  /* Robust requestAnimationFrame — pdf.js chunks page.render() via rAF, and browsers PAUSE rAF
     in hidden / unfocused / backgrounded tabs (and throttle it under load). That would leave the
     result-screen preview and page thumbnails blank while the Download button still works.
     Drive each callback by whichever fires first — the real rAF or a short timeout fallback — so
     rendering always completes. "First wins" keeps normal on-screen animations at full cadence. */
  (function () {
    if (global.__pdftkRafPatched) return;
    global.__pdftkRafPatched = true;
    var realRaf = typeof global.requestAnimationFrame === "function" ? global.requestAnimationFrame.bind(global) : null;
    function now() { return (global.performance && performance.now) ? performance.now() : Date.now(); }
    // a MessageChannel tick fires even in tab states that throttle BOTH rAF and
    // setTimeout (frozen/occluded tabs) — the last resort that keeps renders moving
    var mc = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
    var mcQueue = [];
    if (mc) {
      mc.port1.onmessage = function () {
        var jobs = mcQueue.splice(0);
        for (var i = 0; i < jobs.length; i++) { try { jobs[i](now()); } catch (e) {} }
      };
    }
    global.requestAnimationFrame = function (cb) {
      var done = false;
      function run(t) { if (!done) { done = true; try { cb(t); } catch (e) {} } }
      var rid = realRaf ? realRaf(run) : 0;
      var tid = setTimeout(function () { run(now()); }, 32);
      if (mc) { mcQueue.push(run); mc.port2.postMessage(0); }
      return rid || tid;
    };
  })();

  var BASE = "/tools/assets/";
  var DOMAIN = "https://unboundpdf.com";

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function bnode(t) { var b = document.createElement("b"); b.textContent = t; return b; }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function setContent(node, parts) {
    clear(node);
    parts.forEach(function (x) {
      node.appendChild(typeof x === "object" ? x : document.createTextNode(String(x)));
    });
  }
  function show(e) { if (e) e.hidden = false; }
  function hide(e) { if (e) e.hidden = true; }

  function fmtBytes(b) {
    // Rounding to whole KB reported a real 6% compression as "6 KB before / 6 KB after", which
    // reads as "nothing happened". Show a decimal below 100 KB so a genuine change is visible.
    if (b < 1024) return b + " B";
    if (b < 1048576) { var k = b / 1024; return (k < 100 ? k.toFixed(1) : k.toFixed(0)) + " KB"; }
    return (b / 1048576).toFixed(1) + " MB";
  }
  function pluralPages(n) { return n + (n === 1 ? " page" : " pages"); }
  function yield_() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function looksLikePdf(name) { return /\.pdf$/i.test(name || ""); }
  function baseName(name) { return (name || "document").replace(/\.[a-z0-9]+$/i, ""); }
  function pad(n, w) { n = "" + n; while (n.length < w) n = "0" + n; return n; }
  function clone(buf) {
    if (buf instanceof ArrayBuffer) return buf.slice(0);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  function isEncryptedError(e) {
    if (!e) return false;
    if (global.PDFLib && PDFLib.EncryptedPDFError && e instanceof PDFLib.EncryptedPDFError) return true;
    var s = ((e && e.name) || "") + " " + ((e && e.message) || "");
    return /encrypt|password/i.test(s);
  }

  /** Does this exception mean "the device ran out of memory", as opposed to "the file is bad"?
   *  The strings below are the ones the runtimes actually throw, not a guess:
   *    V8 heap / ArrayBuffer   "Array buffer allocation failed", "Invalid array buffer length",
   *                            "Invalid typed array length", "Invalid string length",
   *                            RangeError name, "out of memory"
   *    Canvas / 2D context     "Out of memory" from a too-large canvas, and the null-context
   *                            symptom that follows a failed backing-store allocation
   *                            ("Cannot read properties of null (reading 'getContext')",
   *                             "getContext(...) is null")
   *    Blob / File             "Failed to construct 'Blob'"
   *  Deliberately NOT matched: "Maximum call stack size exceeded" — that is recursion, not memory.
   */
  function isAllocationError(e) {
    if (!e) return false;
    var s = ((e && e.name) || "") + " " + ((e && e.message) || e);
    if (/Maximum call stack/i.test(s)) return false;
    return /out of memory|array buffer allocation failed|invalid (typed )?array (buffer )?length|invalid string length|allocation failed|failed to allocate|cannot allocate|OOM/i.test(s)
      || /RangeError/.test(s) && /length|size|allocat/i.test(s)
      || /getContext/i.test(s) && /null|undefined/i.test(s)
      || /failed to construct 'Blob'/i.test(s);
  }

  /** Map an exception to a human-readable message node (may contain a link). */
  function humanError(e, ctx) {
    var wrap = el("span");
    if (isEncryptedError(e)) {
      wrap.appendChild(document.createTextNode("This PDF is password-protected. "));
      var a = el("a", null, "Unlock it first");
      a.href = "/tools/unlock-pdf/";
      wrap.appendChild(a);
      wrap.appendChild(document.createTextNode(" with your password, then come back."));
      return wrap;
    }
    var msg = String((e && e.message) || e || "Unknown error");
    if (/Failed to parse PDF|Invalid PDF|Expected instance of PDFDict|Trying to parse invalid object/i.test(msg)) {
      wrap.appendChild(document.createTextNode("This file doesn't look like a valid PDF (it may be damaged). Try the "));
      var r = el("a", null, "Repair PDF");
      r.href = "/tools/repair-pdf/";
      wrap.appendChild(r);
      wrap.appendChild(document.createTextNode(" tool."));
      return wrap;
    }
    if (/detached ArrayBuffer/i.test(msg)) {
      wrap.appendChild(document.createTextNode("Something went wrong reading the file. Please reload the page and try again."));
      return wrap;
    }
    if (isAllocationError(e)) {
      /* An allocation failure is not a broken file and not a bug in the document — it is this
         browser tab running out of room. Say that, say the original is safe (nothing is ever
         uploaded or overwritten), and name the two things that actually help. No memory
         quantity is quoted: we do not know this device's budget, and inventing one would be
         a lie (large-doc runtime design §3.4). */
      wrap.appendChild(document.createTextNode(
        (ctx ? ctx + ": t" : "T")
        + "his document needs more memory than this browser tab can give it, so the operation stopped. "
        + "Your original file was not changed — it never left your device. "
        + "Try a smaller page range, close other tabs, or open this file on a desktop browser."));
      return wrap;
    }
    wrap.appendChild(document.createTextNode((ctx ? ctx + ": " : "") + msg));
    return wrap;
  }

  function download(bytes, filename, type) {
    var blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: type || "application/octet-stream" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 800);
  }

  /* ── ZIP (store) ── */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  /* Read a zip (pptx/docx/any OOXML) client-side: central-directory walk + native
     DecompressionStream("deflate-raw") for method 8, direct slice for stored method 0.
     Written for pptx-to-pdf — mammoth bundles its own unzip for .docx but does not expose it,
     and vendoring a whole zip library for two methods would be weight without a job. */
  async function readZip(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    // find End Of Central Directory (scan back over a possible comment)
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip file");
    var count = dv.getUint16(eocd + 10, true);
    var cdOff = dv.getUint32(eocd + 16, true);
    var entries = {};
    var p = cdOff;
    for (var e = 0; e < count; e++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var cmtLen = dv.getUint16(p + 32, true);
      var lhOff = dv.getUint32(p + 42, true);
      var name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { method: method, csize: csize, lhOff: lhOff };
      p += 46 + nameLen + extraLen + cmtLen;
    }
    async function file(name) {
      var en = entries[name];
      if (!en) return null;
      // local header: sizes/name/extra lengths live at fixed offsets
      var lh = en.lhOff;
      if (dv.getUint32(lh, true) !== 0x04034b50) throw new Error("bad zip entry: " + name);
      var nLen = dv.getUint16(lh + 26, true), xLen = dv.getUint16(lh + 28, true);
      var start = lh + 30 + nLen + xLen;
      var raw = u8.subarray(start, start + en.csize);
      if (en.method === 0) return new Uint8Array(raw);
      if (en.method !== 8) throw new Error("unsupported zip method " + en.method);
      if (typeof DecompressionStream === "undefined") throw new Error("browser lacks DecompressionStream");
      var ds = new DecompressionStream("deflate-raw");
      var out = new Response(new Blob([raw]).stream().pipeThrough(ds));
      return new Uint8Array(await out.arrayBuffer());
    }
    return { names: Object.keys(entries), file: file,
             text: async function (name) { var b = await file(name); return b ? new TextDecoder().decode(b) : null; } };
  }

  /** Build a stored (method 0) ZIP.
   *
   *  An entry is either byte-backed — `{name, data: Uint8Array}`, the original contract — or
   *  Blob-backed — `{name, blob, crc, size}`, where the producer computed the CRC while the
   *  bytes were momentarily in hand. Blob-backed entries exist so a 100-page export never holds
   *  100 decoded images on the heap at once, and so the archive itself is never materialised as
   *  one contiguous Uint8Array (that concatenation was a guaranteed 2x peak at the very end of
   *  the job — large-doc runtime design §2.4).
   *
   *  Return type follows the input: a Blob when any entry is Blob-backed, otherwise the
   *  Uint8Array the byte-backed callers (docx packaging, the split tools) still expect.
   *  Every consumer of a zip result — download(), resultScreen(), the QA `__wbResult` readers —
   *  already accepts either. */
  function buildZip(entries) {
    var enc = new TextEncoder();
    var parts = [], central = [], offset = 0, anyBlob = false;
    entries.forEach(function (e) {
      var nameB = enc.encode(e.name);
      var isBlob = !!e.blob;
      if (isBlob) anyBlob = true;
      var size = isBlob ? (e.size != null ? e.size : e.blob.size) : e.data.length;
      var crc = e.crc != null ? (e.crc >>> 0) : crc32(e.data);
      var lh = new Uint8Array(30 + nameB.length), dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true);
      dv.setUint16(26, nameB.length, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, size, true); dv.setUint32(22, size, true);
      lh.set(nameB, 30);
      parts.push(lh, isBlob ? e.blob : e.data);
      var ch = new Uint8Array(46 + nameB.length), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(28, nameB.length, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
      cv.setUint32(42, offset, true);
      ch.set(nameB, 46);
      central.push(ch);
      offset += lh.length + size;
    });
    var centralSize = 0; central.forEach(function (c) { centralSize += c.length; });
    var eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
    var all = parts.concat(central, [eocd]);
    if (anyBlob) return new Blob(all, { type: "application/zip" });
    var total = 0; all.forEach(function (a) { total += a.length; });
    var out = new Uint8Array(total), p = 0;
    all.forEach(function (a) { out.set(a, p); p += a.length; });
    return out;
  }

  function parseRanges(str, total) {
    if (!str || !str.trim()) return { error: "Enter which pages to extract (e.g. 1-3, 5)." };
    var out = [], tokens = str.split(",");
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i].trim(); if (!tok) continue;
      var m;
      if ((m = tok.match(/^(\d+)\s*-\s*(\d+)$/))) {
        var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (a === 0 || b === 0) return { error: "Pages start at 1, not 0." };
        if (a > total || b > total) return { error: "This PDF only has " + pluralPages(total) + ' — "' + tok + '" is out of range.' };
        if (a <= b) { for (var p = a; p <= b; p++) out.push(p - 1); }
        else { for (var q = a; q >= b; q--) out.push(q - 1); }
      } else if ((m = tok.match(/^(\d+)$/))) {
        var n = parseInt(m[1], 10);
        if (n === 0) return { error: "Pages start at 1, not 0." };
        if (n > total) return { error: "This PDF only has " + pluralPages(total) + " — page " + n + " doesn't exist." };
        out.push(n - 1);
      } else return { error: "Could not understand \"" + tok + "\". Use numbers like 1-3, 5, 8-10." };
    }
    if (!out.length) return { error: "No pages selected." };
    return { indices: out, error: null };
  }

  function append(parent, children) {
    (children || []).forEach(function (ch) {
      if (!ch) return;
      if (typeof ch === "string") parent.appendChild(document.createTextNode(ch));
      else parent.appendChild(ch);
    });
    return parent;
  }
  function input(attrs) {
    var n = document.createElement("input");
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "className") n.className = attrs[k];
      else if (k === "type") n.type = attrs[k];
      else if (k === "value") n.value = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    return n;
  }
  function btn(text, cls, id) {
    var b = el("button", cls || "btn", text);
    b.type = "button";
    if (id) b.id = id;
    return b;
  }
  function dzIcon() {
    var ic = el("div", "dz-ic");
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("aria-hidden", "true");
    var p1 = document.createElementNS(NS, "path");
    p1.setAttribute("d", "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z");
    var p2 = document.createElementNS(NS, "polyline");
    p2.setAttribute("points", "14 2 14 8 20 8");
    var p3 = document.createElementNS(NS, "line");
    p3.setAttribute("x1", "12"); p3.setAttribute("y1", "18"); p3.setAttribute("x2", "12"); p3.setAttribute("y2", "12");
    var p4 = document.createElementNS(NS, "polyline");
    p4.setAttribute("points", "9 15 12 12 15 15");
    svg.appendChild(p1); svg.appendChild(p2); svg.appendChild(p3); svg.appendChild(p4);
    ic.appendChild(svg);
    return ic;
  }

  function wireDropEl(dz, inp, onFiles, multiple) {
    dz.addEventListener("click", function (ev) {
      if (ev.target === inp) return;
      inp.click();
    });
    dz.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); inp.click(); }
    });
    inp.addEventListener("change", function () {
      if (inp.files && inp.files.length) onFiles(multiple ? Array.from(inp.files) : [inp.files[0]]);
      inp.value = "";
    });
    ["dragenter", "dragover"].forEach(function (evt) {
      dz.addEventListener(evt, function (ev) { ev.preventDefault(); ev.stopPropagation(); dz.classList.add("over"); });
    });
    ["dragleave", "dragend", "drop"].forEach(function (evt) {
      dz.addEventListener(evt, function (ev) { ev.preventDefault(); dz.classList.remove("over"); });
    });
    dz.addEventListener("drop", function (ev) {
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files.length) onFiles(multiple ? Array.from(files) : [files[0]]);
    });
    claimHandoff(onFiles);
  }

  function wireDrop(dropId, inputId, onFiles, multiple) {
    var dz = $(dropId), inp = $(inputId);
    if (!dz || !inp) return;
    wireDropEl(dz, inp, function (files) { onFiles(files); }, multiple);
  }

  /* A file dropped on the homepage is carried here rather than asked for twice.
     Hooked into wireDropEl — the intake every tool actually calls — so all of them inherit
     it with no per-tool wiring to forget. Guarded to claim at most once per page.
     Silent no-op unless the visitor actually arrived from the homepage drop. */
  function claimHandoff(onFiles) {
    if (!/[?&]from=drop(&|$)/.test(global.location.search)) return;
    if (!global.UnboundHandoff || claimHandoff.done) return;
    claimHandoff.done = true;
    global.UnboundHandoff.take().then(function (file) {
      // Drop the marker either way, so a refresh doesn't re-announce a handoff that's gone.
      try {
        var u = new URL(global.location.href);
        u.searchParams.delete("from");
        history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
      } catch (e) {}
      if (file) onFiles([file]);
    });
  }

  /* ── pdf-lib helpers ── */
  var libReady = false;
  var libWaiters = [];
  function onLibReady(fn) { if (libReady) fn(); else libWaiters.push(fn); }
  function waitLib(tries) {
    if (global.__PDFLIB_FAILED) { engineFailed(); return; }
    if (global.PDFLib && PDFLib.PDFDocument) {
      libReady = true;
      libWaiters.forEach(function (fn) { fn(); });
      libWaiters = [];
      return;
    }
    if (tries > 120) { engineFailed(); return; }
    setTimeout(function () { waitLib(tries + 1); }, 50);
  }
  function engineFailed() {
    var n = $("engineNote");
    if (n) {
      n.textContent = "The PDF engine could not load. Reload the page to try again.";
      n.style.color = "var(--err)";
    }
  }
  function loadPdf(buf, opts) {
    return PDFLib.PDFDocument.load(clone(buf), Object.assign({ updateMetadata: false }, opts || {}))
      .catch(function (e) {
        /* Owner-locked PDFs — restrictions with an EMPTY user password — are everywhere in
           the wild (spec sheets, government and vendor docs). Every viewer opens them freely,
           but pdf-lib refuses, so users were told to "unlock" a file that was never locked
           for them. The vendored fork can genuinely DECRYPT given the user password, so open
           these transparently with the empty one. A REAL user password still fails here and
           keeps the honest unlock-first message; never guess at actual passwords. */
        if (isEncryptedError(e) && !(opts && "password" in opts)) {
          return PDFLib.PDFDocument.load(clone(buf), Object.assign({ updateMetadata: false }, opts || {}, { password: "" }));
        }
        throw e;
      });
  }
  function readPdfMeta(buf) {
    return loadPdf(buf).then(function (doc) { return { pages: doc.getPageCount() }; });
  }
  function savePdf(doc, opts) { return doc.save(opts || {}); }

  /* ── PDF.js loader ── */
  var pdfjsLoading = false;
  var pdfjsWaiters = [];
  function loadPdfJs() {
    return new Promise(function (resolve, reject) {
      if (global.pdfjsLib && global.pdfjsLib.getDocument) { resolve(global.pdfjsLib); return; }
      pdfjsWaiters.push({ resolve: resolve, reject: reject });
      if (pdfjsLoading) return;
      pdfjsLoading = true;
      var s = document.createElement("script");
      s.src = BASE + "pdf.min.js";
      s.onload = function () {
        if (global.pdfjsLib) {
          pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + "pdf.worker.min.js";
          pdfjsWaiters.forEach(function (w) { w.resolve(pdfjsLib); });
          pdfjsWaiters = [];
        } else {
          pdfjsWaiters.forEach(function (w) { w.reject(new Error("PDF.js failed")); });
          pdfjsWaiters = [];
        }
      };
      s.onerror = function () {
        pdfjsWaiters.forEach(function (w) { w.reject(new Error("PDF.js load failed")); });
        pdfjsWaiters = [];
      };
      document.head.appendChild(s);
    });
  }

  /** Open a PDF.js document from an ArrayBuffer/Uint8Array (always copies — PDF.js transfers the buffer).
   *
   *  DOCUMENT READINESS PIPELINE (2026-07-22). This is the ONE door every tool walks
   *  through, so it is where a document that is not yet readable gets made readable —
   *  rather than each tool dead-ending on its own. Founder: "we have OCR, we have so many
   *  tools — it should use them if required."
   *
   *  Measured over the 36-file corpus, two files never opened AT ALL and produced a silent
   *  forever-spinner with no message:
   *    · locked.pdf            — encrypted; pdf.js throws PasswordException
   *    · corrupt-truncated.pdf — pdf.js rejects it, yet pdf-lib loads it FINE, so the bytes
   *                              are recoverable and we simply never tried
   *  A hang with no explanation is worse than a refusal with a reason, and worse still when
   *  we already own the tool that fixes it.
   *
   *  So: a password is asked for and retried; a structurally broken file is REBUILT through
   *  pdf-lib and retried once. Whatever still fails is thrown with `.reason` set
   *  ("locked" | "damaged"), so the caller can say which of our own tools to reach for
   *  instead of spinning. Scans need nothing here — the editor already OCRs them on demand.
   *
   *  opts.password   — try this password first
   *  opts.onPassword — () => string|Promise<string>, asked once when the file is encrypted
   */
  function openPdfjs(buf, opts) {
    opts = opts || {};
    function tag(err, reason) {
      try { err.reason = reason; } catch (e) {}
      return err;
    }
    function isPasswordErr(e) {
      var n = (e && (e.name || (e.constructor && e.constructor.name))) || "";
      return n === "PasswordException" || /password/i.test((e && e.message) || "");
    }
    return loadPdfJs().then(function (pdfjs) {
      function attempt(password) {
        var cfg = { data: clone(buf) };
        if (password) cfg.password = password;
        return pdfjs.getDocument(cfg).promise;
      }
      /* Rebuild through pdf-lib: it tolerates structures pdf.js refuses, and re-saving
         emits a clean xref/trailer. Only ever tried ONCE, and only on a non-password
         failure, so a genuinely unreadable file still fails fast instead of looping. */
      function rebuildAndRetry(origErr) {
        var PL = global.PDFLib;
        if (!PL || !PL.PDFDocument) return Promise.reject(tag(origErr, "damaged"));
        return PL.PDFDocument.load(clone(buf), { ignoreEncryption: true, throwOnInvalidObject: false })
          .then(function (doc) { return doc.save({ useObjectStreams: false }); })
          .then(function (fixed) { buf = fixed; return attempt(); })
          .catch(function () { return Promise.reject(tag(origErr, "damaged")); });
      }
      return attempt(opts.password).catch(function (err) {
        if (isPasswordErr(err)) {
          if (typeof opts.onPassword !== "function") return Promise.reject(tag(err, "locked"));
          return Promise.resolve(opts.onPassword()).then(function (pw) {
            if (!pw) return Promise.reject(tag(err, "locked"));
            return attempt(pw).catch(function (e2) { return Promise.reject(tag(e2, "locked")); });
          });
        }
        return rebuildAndRetry(err);
      });
    });
  }

  // The page's asset version, read from its own versioned script tags. A ?v= is a
  // CONTENT IDENTITY — lazy-loaded engine scripts must carry the same version as the
  // page that loads them, or CDN caches serve a stale engine against new markup.
  var ASSET_V = (function () {
    try {
      var ss = document.querySelectorAll("script[src*='?v=']");
      for (var i = 0; i < ss.length; i++) {
        var m = (ss[i].getAttribute("src") || "").match(/\?v=(\d+)/);
        if (m) return m[1];
      }
    } catch (e) {}
    return "";
  })();

  function loadScript(url) {
    if (ASSET_V && url.indexOf("?") < 0) url += "?v=" + ASSET_V;
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = url;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Failed to load " + url)); };
      document.head.appendChild(s);
    });
  }

  /* ── JPEG requant worker (P1-DESIGN §5.1) ─────────────────────────────────────────────
     A feature-detected, benchmark-gated offload of the coefficient-domain requantiser. The
     handle it returns exposes `terminate()`, which is what the runtime's cleanup ledger
     duck-types on — `ctx.hold(rw)` is therefore the whole cancellation story: cancel (or any
     other exit) disposes the ledger, the worker dies, and every message still in flight
     rejects instead of dangling.

     DEFAULT OFF — and the default is a MEASUREMENT, not caution. `_qa/bench-requant-worker.mjs`
     on compress-pdf × scan-300p, 4 interleaved pairs, run twice (medians, session A / B):
       wall          14.8s -> 15.2s  |  16.3s -> 16.7s   (inside the run-to-run spread)
       worst stall     31ms -> 33ms  |    30ms -> 32ms   (NO improvement)
       peak RSS      947MB -> 1955MB | 941MB -> 1759MB   (+1008 / +818MB, ranges disjoint)
     §5.1's gate requires a non-regression in wall time AND an improvement in worst stall.
     The stall half fails: step 5's per-image yielding had already brought worst stalls to
     ~30ms, so there was nothing left for a worker to win — and the second JS heap costs
     ~0.9GB on a 119MB input. (An n=2 sample said SHIP; n=4, twice, says otherwise. The small
     sample was the error.) Output is byte-identical between the paths, which is why the code
     stays: the offload is correct, it is simply not worth its memory today. Re-run the
     benchmark before flipping this — on a constrained device the answer may differ.

     `?requantworker=1` on the tool URL opts a single page load in. Read ONCE, so the two
     paths cannot diverge mid-run. Nothing in the UI sets it and no public copy mentions it. */
  var REQUANT_WORKER_ON = (function () {
    try { return /(^|[?&])requantworker=1(&|$)/.test(String(location.search || "")); }
    catch (e) { return false; }
  })();

  function makeRequantWorker() {
    if (!REQUANT_WORKER_ON) return null;
    if (typeof Worker !== "function") return null;
    // file:// gives workers an opaque origin in every engine we support; importScripts fails.
    try { if (location.protocol === "file:") return null; } catch (e) {}

    var w;
    try { w = new Worker(BASE + "jpeg-requant-worker.js" + (ASSET_V ? "?v=" + ASSET_V : "")); }
    catch (e) { return null; }

    var seq = 0, pending = Object.create(null), deadReason = null;
    function killPending(reason) {
      deadReason = deadReason || reason;
      for (var k in pending) {
        var p = pending[k]; delete pending[k];
        try { p.reject(new Error(reason)); } catch (e) {}
      }
    }
    var resolveReady, rejectReady;
    var ready = new Promise(function (res, rej) { resolveReady = res; rejectReady = rej; });
    /* A worker that neither reports ready nor errors (a hung importScripts behind a proxy)
       must not hold the run hostage: time out into the synchronous path. */
    var readyTimer = setTimeout(function () { rejectReady(new Error("requant worker never reported ready")); }, 10000);

    w.onmessage = function (ev) {
      var m = ev.data || {};
      if (m.type === "ready") { clearTimeout(readyTimer); resolveReady(m); return; }
      if (m.type === "fatal") { clearTimeout(readyTimer); rejectReady(new Error(m.error || "requant worker failed to start")); killPending(m.error || "requant worker failed to start"); return; }
      if (m.type !== "result") return;
      var p = pending[m.id];
      if (!p) return;
      delete pending[m.id];
      p.resolve(m);
    };
    w.onerror = function (ev) {
      var why = "requant worker error: " + ((ev && ev.message) || "unknown");
      clearTimeout(readyTimer); rejectReady(new Error(why)); killPending(why);
    };

    return {
      ready: ready,
      terminate: function () {
        clearTimeout(readyTimer);
        killPending("requant worker terminated");
        try { w.terminate(); } catch (e) {}
      },
      /* bytes: Uint8Array of the embedded JPEG. Resolves with the worker's reply verbatim. */
      requant: function (bytes, opts) {
        if (deadReason) return Promise.reject(new Error(deadReason));
        var id = ++seq;
        /* TRANSFER ONLY A BUFFER THE VIEW OWNS. pdf-lib's getContents() can hand back a view
           INTO a larger parsed buffer; transferring that would detach the whole document and
           destroy the run. When the view is a window, we copy once — correctness first. */
        var owns = (bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.length);
        var buf = owns ? bytes.buffer : bytes.slice().buffer;
        return new Promise(function (resolve, reject) {
          pending[id] = { resolve: resolve, reject: reject };
          w.postMessage({
            type: "requant", id: id, buf: buf,
            pageWpt: opts.pageWpt, targetDpi: opts.targetDpi, targetPct: opts.targetPct
          }, [buf]);
          /* DEBUG CHECK (opt-in, `window.__ubrRequantDebug = true`): a real transfer DETACHES
             the sender's buffer, so byteLength must be 0 here. A non-zero reading means the
             structured clone silently copied — the zero-copy claim would be false. */
          if (typeof window !== "undefined" && window.__ubrRequantDebug) {
            window.__ubrRequantXfer = window.__ubrRequantXfer || { transferred: 0, copied: 0, owned: 0, aliased: 0 };
            window.__ubrRequantXfer[owns ? "owned" : "aliased"]++;
            window.__ubrRequantXfer[buf.byteLength === 0 ? "transferred" : "copied"]++;
            if (buf.byteLength !== 0) console.warn("requant: buffer was NOT transferred (byteLength " + buf.byteLength + ")");
          }
        });
      }
    };
  }

  function renderPageToCanvas(pdf, pageNum, scale) {
    return pdf.getPage(pageNum).then(function (page) {
      var vp = page.getViewport({ scale: scale || 1.5 });
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      // WATCHDOG: pdf.js settles render() only via rAF ticks; in a frozen tab that
      // promise can hang FOREVER (the silent stuck-at-92% save). A timed race turns
      // the hang into a catchable, honest error at every render call site at once.
      var task = page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
      return Promise.race([
        task.promise,
        new Promise(function (_, rej) {
          setTimeout(function () {
            try { task.cancel(); } catch (e) {}
            rej(new Error("page render timed out — the tab may be suspended; keep it visible and try again"));
          }, 30000);
        })
      ]).then(function () {
        return { canvas: canvas, width: vp.width, height: vp.height, page: page };
      });
    });
  }

  /* ── Canvas AREA budget (design §2.2) ────────────────────────────────────────────────
     Every raster path here sized its canvas from a scale and hoped. The preview modal's
     own arithmetic was min(clientWidth-36,1000) x zoom(<=3) x dpr(<=2) = 6000 device px
     wide, i.e. ~50.9 Mpx / ~204 MB for ONE canvas on A4 — past the area ceiling where
     mobile Safari hands back a SILENTLY BLANK canvas rather than an error, which is the
     worst possible failure: it looks like the document is empty.

     So: a self-chosen area budget, and past it we DEGRADE — render at the clamped scale
     and let CSS upscale the result. Softer pixels at maximum zoom, never a blank page.
     The budget is ours, not a platform number: no iOS/Safari threshold is measured yet
     (P1 §8 step 2 could not simulate a small device), so this file states none. */
  var MAX_CANVAS_AREA = (function () {
    try {
      var dm = global.navigator && global.navigator.deviceMemory;
      if (typeof dm === "number" && dm > 0 && dm <= 2) return 4e6;   // low-memory: 4 Mpx
    } catch (e) {}
    return 16e6;                                                     // standard: 16 Mpx
  })();

  /** Reduce `scale` until width x height fits the area budget. Returns `scale` unchanged
      when it already fits, so the common path is arithmetic-identical to before. */
  function clampScaleToArea(vpW, vpH, scale, budget) {
    var max = budget || MAX_CANVAS_AREA;
    var area = (vpW * scale) * (vpH * scale);
    if (!(area > max) || !(vpW > 0) || !(vpH > 0)) return scale;
    return scale * Math.sqrt(max / area);
  }

  /** Render a page to a canvas of a given CSS pixel width (device-pixel aware).
      The canvas keeps its CSS size (`100%` here, or whatever the caller sets), so a
      clamped render is displayed upscaled rather than shrunk — see clampScaleToArea. */
  function renderThumb(pdf, pageNum, cssWidth) {
    return pdf.getPage(pageNum).then(function (page) {
      var vp1 = page.getViewport({ scale: 1 });
      var dpr = Math.min(global.devicePixelRatio || 1, 2);
      var scale = clampScaleToArea(vp1.width, vp1.height, (cssWidth * dpr) / vp1.width);
      var vp = page.getViewport({ scale: scale });
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      canvas.style.width = "100%";
      canvas.style.height = "auto";
      return page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise.then(function () {
        /* A thumbnail is a one-shot raster: nothing here will re-render this page, so pdf.js's
           per-page parsed operator list and image cache are pure retention once the pixels
           exist. cleanup() is a no-op while a render is still pending, so this is safe. */
        try { page.cleanup(); } catch (e) {}
        return canvas;
      });
    });
  }

  /** Encode a canvas to a Blob. The bytes stay off-heap until somebody asks for them, which is
      what lets a page-by-page export keep only the archive's parts, not its contents. */
  function canvasToBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob); else reject(new Error("Could not encode this page as an image."));
      }, mime, quality);
    });
  }
  function canvasToJpegBlob(canvas, quality) { return canvasToBlob(canvas, "image/jpeg", quality || 0.85); }
  /* blob.arrayBuffer() replaces the old toBlob -> FileReader hop: one fewer full copy of every
     encoded page, and no FileReader instance per page (design §2.4 part 1). */
  function canvasToJpegBytes(canvas, quality) {
    return canvasToJpegBlob(canvas, quality).then(function (b) {
      return b.arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
    });
  }
  function canvasToPngBytes(canvas) {
    return canvasToBlob(canvas, "image/png").then(function (b) {
      return b.arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
    });
  }

  function embedJpegPage(doc, jpegBytes, w, h) {
    return doc.embedJpg(jpegBytes).then(function (embedded) {
      var page = doc.addPage([w, h]);
      page.drawImage(embedded, { x: 0, y: 0, width: w, height: h });
      return page;
    });
  }

  /* ── Minimal DOCX generator (text-only) ── */
  function escapeXml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  /* Block-based .docx builder. Blocks:
       { t:"p", text, bold?, halfPts? }               — a paragraph; halfPts = w:sz (2 x points)
       { t:"p", runs:[run], halfPts?, bold? }         — a paragraph built from formatted RUNS
       { t:"img", ext:"jpeg"|"png", data, wPx, hPx }  — an inline picture, scaled to page width
       { t:"table", rows:[[cell]], widths?:[twips], borders?:bool }   — a real w:tbl
     A run is  { text, bold?, italic?, halfPts?, color?:"RRGGBB", link?:"https://…" }.
     A cell is { text?|runs?, gridSpan?:n, vMerge?:"restart"|"continue", blocks?:[block] }, or
     NULL for a slot a gridSpan to its left already covers. `blocks` nests content inside the
     cell — a `t:"table"` block there is a real nested table.
     Second argument (optional):
       { sectPr: { wTwips, hTwips, landscape?, marginTwips? } }        — w:sectPr page setup

     Grew out of textToDocx (kept below as a wrapper): the old exporter emitted one bare <w:p>
     per PDF LINE, so Word showed a hard break mid-sentence on every line and no image ever
     survived the trip. W2-5 (2026-08-19) added runs (bold/italic/colour/hyperlink), real tables
     and w:sectPr — ADDITIVELY: a block with no `runs`, no `t:"table"` and no opts produces the
     byte-identical XML it produced before, which is what keeps every existing caller intact. */
  function docxFromBlocks(blocks, opts) {
    opts = opts || {};
    var EMU = 9525;                       // per CSS px

    /* XML 1.0 legality, not just XML escaping. escapeXml() handles &<>" -- it does NOT handle the
       characters XML 1.0 forbids OUTRIGHT, which no escaping can rescue: the C0 controls except
       tab/LF/CR, U+FFFE/U+FFFF, and unpaired surrogates. Real PDFs produce them: pdf32000-spec.pdf
       yields 25 distinct forbidden code points through symbolic fonts' ToUnicode maps, and one of
       them in a <w:t> makes document.xml fatally malformed -- `xmllint --noout` rejects it and Word
       shows the repair prompt. They carry no text (they are glyph codes that mapped to nothing), so
       they are dropped rather than substituted; substituting a space would invent word breaks that
       are not in the document. Applied to every text node AND every attribute value this builder
       writes. */
    function xmlSafe(s) {
      s = String(s);
      var out = "", n = s.length;
      for (var i = 0; i < n; i++) {
        var c = s.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF) {                       // high surrogate
          var d = (i + 1 < n) ? s.charCodeAt(i + 1) : 0;
          if (d >= 0xDC00 && d <= 0xDFFF) { out += s.charAt(i) + s.charAt(i + 1); i++; continue; }
          continue;                                             // lone high surrogate: illegal
        }
        if (c >= 0xDC00 && c <= 0xDFFF) continue;               // lone low surrogate: illegal
        if (c === 0x09 || c === 0x0A || c === 0x0D) { out += s.charAt(i); continue; }
        if (c < 0x20) continue;                                 // C0 controls: illegal in XML 1.0
        if (c === 0xFFFE || c === 0xFFFF) continue;             // permanently unassigned: illegal
        out += s.charAt(i);
      }
      return out;
    }
    function xesc(s) { return escapeXml(xmlSafe(s)); }

    var MAXW = 5943600;                   // 6.5in printable width
    var media = [], rels = [], body = "";
    var linkRels = [], linkSeen = {};

    /** External hyperlink relationships are the one rel kind that needs TargetMode="External";
     *  identical URLs share one relationship, the way Word itself writes them. */
    function linkRel(url) {
      if (linkSeen[url]) return linkSeen[url];
      var id = "rLnk" + (linkRels.length + 1);
      linkRels.push('<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + xesc(url) + '" TargetMode="External"/>');
      linkSeen[url] = id;
      return id;
    }
    function normHex(c) {
      if (!c) return null;
      if (typeof c === "string") return /^[0-9a-fA-F]{6}$/.test(c) ? c.toUpperCase() : null;
      if (c.length >= 3) {
        var h = "";
        for (var i = 0; i < 3; i++) { var v = Math.max(0, Math.min(255, Math.round(c[i]))); h += (v < 16 ? "0" : "") + v.toString(16); }
        return h.toUpperCase();
      }
      return null;
    }
    function runXml(r) {
      var rpr = "";
      if (r.bold) rpr += "<w:b/>";
      if (r.italic) rpr += "<w:i/>";
      var hex = normHex(r.color);
      /* Pure black is the default and Word writes no w:color for it; emitting one anyway is
         harmless but noisy, and it makes a diff of two exports look like a formatting change. */
      if (hex && hex !== "000000") rpr += '<w:color w:val="' + hex + '"/>';
      if (r.halfPts) rpr += '<w:sz w:val="' + r.halfPts + '"/><w:szCs w:val="' + r.halfPts + '"/>';
      /* No w:rStyle here on purpose: this package ships no styles.xml, and a run that names a
         style the package does not define is exactly the kind of dangling reference that makes
         Word offer to repair the file. The link's appearance is carried by explicit colour and
         underline instead. */
      if (r.link) rpr += (hex ? "" : '<w:color w:val="0563C1"/>') + '<w:u w:val="single"/>';
      var x = "<w:r>" + (rpr ? "<w:rPr>" + rpr + "</w:rPr>" : "") +
        '<w:t xml:space="preserve">' + xesc(r.text || "") + "</w:t></w:r>";
      if (r.link) x = '<w:hyperlink r:id="' + linkRel(r.link) + '">' + x + "</w:hyperlink>";
      return x;
    }
    function paraXml(b) {
      if (b.runs && b.runs.length) {
        var ppr = b.ppr || "";
        return "<w:p>" + ppr + b.runs.map(runXml).join("") + "</w:p>";
      }
      var rpr = "";
      if (b.bold || b.halfPts) {
        rpr = "<w:rPr>" + (b.bold ? "<w:b/>" : "") +
          (b.halfPts ? '<w:sz w:val="' + b.halfPts + '"/><w:szCs w:val="' + b.halfPts + '"/>' : "") + "</w:rPr>";
      }
      return "<w:p><w:r>" + rpr + "<w:t xml:space=\"preserve\">" + xesc(b.text || "") + "</w:t></w:r></w:p>";
    }
    var BORDERS = "<w:tblBorders>" +
      ["top", "left", "bottom", "right", "insideH", "insideV"].map(function (e) {
        return "<w:" + e + ' w:val="single" w:sz="4" w:space="0" w:color="auto"/>';
      }).join("") + "</w:tblBorders>";
    function tableXml(b) {
      var rows = b.rows || [];
      if (!rows.length) return "";
      var nCols = 0;
      rows.forEach(function (r) {
        var n = 0;
        r.forEach(function (c) { n += c ? (c.gridSpan || 1) : 0; });
        nCols = Math.max(nCols, n);
      });
      if (!nCols) return "";
      var widths = (b.widths && b.widths.length === nCols) ? b.widths : null;
      var total = 0;
      if (widths) widths.forEach(function (w) { total += w; });
      if (!widths || total <= 0) {
        widths = []; for (var i = 0; i < nCols; i++) widths.push(Math.round(9360 / nCols));
        total = 9360;
      }
      var x = '<w:tbl><w:tblPr><w:tblW w:w="' + total + '" w:type="dxa"/>' +
        (b.borders === false ? "" : BORDERS) + '<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>' +
        widths.map(function (w) { return '<w:gridCol w:w="' + w + '"/>'; }).join("") + "</w:tblGrid>";
      rows.forEach(function (row) {
        x += "<w:tr>";
        var col = 0;
        row.forEach(function (cell) {
          if (!cell) { col++; return; }               // covered by a gridSpan to the left
          var span = cell.gridSpan || 1;
          var w = 0; for (var k = col; k < col + span && k < widths.length; k++) w += widths[k];
          var tcPr = '<w:tcW w:w="' + (w || Math.round(total / nCols)) + '" w:type="dxa"/>' +
            (span > 1 ? '<w:gridSpan w:val="' + span + '"/>' : "") +
            (cell.vMerge === "restart" ? '<w:vMerge w:val="restart"/>' : cell.vMerge === "continue" ? "<w:vMerge/>" : "");
          /* A w:tc with no w:p is the single most common cause of Word's "unreadable content"
             repair prompt on a hand-rolled .docx, so an empty cell still gets one. A cell may
             also host NESTED blocks (a table inside a cell, which is how a genuinely nested
             table is represented); tableXml already appends the paragraph Word requires after
             a table, inside the cell as well as in the body. */
          var inner = "";
          if ((cell.runs && cell.runs.length) || cell.text) {
            inner += paraXml({ runs: cell.runs, text: cell.text, bold: cell.bold, halfPts: cell.halfPts });
          }
          (cell.blocks || []).forEach(function (nb) {
            if (nb && nb.t === "table") inner += tableXml(nb);
            else if (nb) inner += paraXml(nb);
          });
          if (!inner) inner = "<w:p/>";
          x += "<w:tc><w:tcPr>" + tcPr + "</w:tcPr>" + inner + "</w:tc>";
          col += span;
        });
        x += "</w:tr>";
      });
      x += "</w:tbl>";
      /* Word requires a paragraph after a table (and between two adjacent tables). */
      return x + "<w:p/>";
    }

    blocks.forEach(function (b, i) {
      if (b.t === "img" && b.data && b.data.length) {
        var n = media.length + 1;
        var name = "image" + n + "." + b.ext;
        media.push({ name: "word/media/" + name, data: b.data });
        rels.push('<Relationship Id="rImg' + n + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/' + name + '"/>');
        var cx = Math.max(1, Math.round((b.wPx || 300) * EMU));
        var cy = Math.max(1, Math.round((b.hPx || 200) * EMU));
        if (cx > MAXW) { cy = Math.round(cy * MAXW / cx); cx = MAXW; }
        body += '<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
          '<wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:docPr id="' + (1000 + i) + '" name="' + name + '"/>' +
          '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
          '<pic:pic><pic:nvPicPr><pic:cNvPr id="' + (1000 + i) + '" name="' + name + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
          '<pic:blipFill><a:blip r:embed="rImg' + n + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
          '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
          '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
          '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
      } else if (b.t === "table") {
        body += tableXml(b);
      } else {
        body += paraXml(b);
      }
    });

    var sect = "";
    if (opts.sectPr && opts.sectPr.wTwips && opts.sectPr.hTwips) {
      var m = opts.sectPr.marginTwips == null ? 1440 : opts.sectPr.marginTwips;
      sect = "<w:sectPr><w:pgSz w:w=" + '"' + Math.round(opts.sectPr.wTwips) + '" w:h="' + Math.round(opts.sectPr.hTwips) + '"' +
        (opts.sectPr.landscape ? ' w:orient="landscape"' : "") + "/>" +
        '<w:pgMar w:top="' + m + '" w:right="' + m + '" w:bottom="' + m + '" w:left="' + m + '" w:header="720" w:footer="720" w:gutter="0"/>' +
        "</w:sectPr>";
    }

    var xml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
      "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"" +
      " xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"" +
      " xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\"" +
      " xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"" +
      " xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">" +
      "<w:body>" + body + sect + "</w:body></w:document>";
    var enc = new TextEncoder();
    var files = [
      { name: "[Content_Types].xml", data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
      { name: "_rels/.rels", data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
      { name: "word/document.xml", data: enc.encode(xml) },
      { name: "word/_rels/document.xml.rels", data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels.concat(linkRels).join("") + "</Relationships>") }
    ].concat(media.map(function (m2) { return { name: m2.name, data: m2.data }; }));
    return buildZip(files);
  }
  function textToDocx(paragraphs) {
    return docxFromBlocks(paragraphs.map(function (p) { return { t: "p", text: p }; }));
  }

  function csvEscape(s) {
    s = String(s);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function rowsToCsv(rows) {
    return rows.map(function (r) { return r.map(csvEscape).join(","); }).join("\n");
  }

  /* ── Word wrap for pdf-lib text ── */
  function wrapText(text, font, size, maxWidth) {
    var out = [];
    String(text).split(/\n/).forEach(function (rawLine) {
      var line = rawLine.replace(/\t/g, "    ");
      if (!line.trim()) { out.push(""); return; }
      var words = line.split(/\s+/), cur = "";
      words.forEach(function (w) {
        var trial = cur ? cur + " " + w : w;
        var tw;
        try { tw = font.widthOfTextAtSize(trial, size); } catch (e) { tw = trial.length * size * 0.55; }
        if (tw <= maxWidth) { cur = trial; return; }
        if (cur) out.push(cur);
        // hard-break very long words
        while (true) {
          var ww;
          try { ww = font.widthOfTextAtSize(w, size); } catch (e2) { ww = w.length * size * 0.55; }
          if (ww <= maxWidth || w.length <= 1) break;
          var cut = Math.max(1, Math.floor(w.length * maxWidth / ww));
          out.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        cur = w;
      });
      out.push(cur);
    });
    return out;
  }

  /* WinAnsi (cp1252) encodes far more than Latin-1: the bullet, euro sign, en/em dash, curly
     quotes, trademark and daggers all sit at 0x80-0x9F and pass through pdf-lib's encoder intact
     — each one verified by drawing it, saving, and extracting it back out.
     The old version replaced EVERY codepoint above U+00FF with "?". That destroyed the bullet
     word-to-pdf inserts for every list item (so bulleted CVs converted to "? item"), rewrote em
     dashes inside text the user never touched, and turned Cyrillic/CJK/Greek documents into rows
     of "?" behind a green success screen — with no warning anywhere.
     Now: keep what the font can genuinely render, and REPORT what it cannot so callers can warn. */
  var WINANSI_EXTRA = /[\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/;

  /** Replace only the characters the WinAnsi standard fonts genuinely cannot encode.
   *  @param {string} s
   *  @param {string[]} [report] collects the dropped characters, so the caller can tell the user.
   */
  function sanitizeWinAnsi(s, report) {
    return String(s).replace(/[^\x00-\xFF]/g, function (ch) {
      if (WINANSI_EXTRA.test(ch)) return ch;          // the font can render it — leave it alone
      if (report && report.indexOf(ch) === -1) report.push(ch);
      return "?";
    });
  }

  /* ── Progress panel ── */
  function progressPanel(host) {
    var wrap = el("div", "working");
    wrap.hidden = true;
    var txt = el("span", "work-txt", "Processing…");
    var barWrap = el("span", "bar");
    var bar = el("i");
    barWrap.appendChild(bar);
    wrap.appendChild(txt);
    wrap.appendChild(barWrap);
    if (host) host.appendChild(wrap);
    return {
      el: wrap,
      set: function (pct, text) {
        wrap.hidden = false;
        bar.style.width = Math.min(100, Math.max(0, pct)) + "%";
        if (text != null) txt.textContent = text;
      },
      done: function () { wrap.hidden = true; bar.style.width = "0%"; }
    };
  }

  /* ── Error panel ── */
  function errorPanel(host) {
    var wrap = el("div", "msg err");
    wrap.hidden = true;
    var mi = el("span", "mi", "\u26A0");
    var txt = el("span");
    wrap.appendChild(mi); wrap.appendChild(txt);
    if (host) host.appendChild(wrap);
    return {
      el: wrap,
      show: function (nodeOrText) {
        clear(txt);
        if (typeof nodeOrText === "string") txt.textContent = nodeOrText;
        else txt.appendChild(nodeOrText);
        wrap.hidden = false;
        wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
      },
      showError: function (e, ctx) { this.show(humanError(e, ctx)); },
      hide: function () { wrap.hidden = true; }
    };
  }

  /* ── Full PDF preview modal ──
     Renders the actual output page-by-page with PDF.js (rAF-robust, so it paints in every browser
     including embedded ones that lack a native PDF plugin). Prev/Next paging + zoom + page counter,
     plus an "Open in new tab" that hands the blob to the browser's own viewer for those who prefer it. */
  function openPdfPreview(bytes, filename) {
    var blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: "application/pdf" });
    var url = URL.createObjectURL(blob);
    var st = { pdf: null, page: 1, count: 1, zoom: 1, busy: false, want: 1 };

    var back = el("div", "pv-back");
    var modal = el("div", "pv-modal");

    /* header */
    var head = el("div", "pv-head");
    head.appendChild(el("span", "pv-title", filename || "Preview"));
    head.appendChild(el("span", "pv-spacer"));
    var openTab = el("a", "pv-openlink", "Open in new tab ↗");
    openTab.href = url; openTab.target = "_blank"; openTab.rel = "noopener";
    head.appendChild(openTab);
    var dlBtn = btn("Download", "btn dl sm");
    dlBtn.addEventListener("click", function () { download(bytes, filename, "application/pdf"); });
    head.appendChild(dlBtn);
    var closeBtn = el("button", "pv-close", "✕");
    closeBtn.type = "button"; closeBtn.title = "Close (Esc)";
    head.appendChild(closeBtn);
    modal.appendChild(head);

    /* page navigation toolbar */
    var nav = el("div", "pv-nav");
    var prev = el("button", "pv-navbtn", "‹"); prev.type = "button"; prev.title = "Previous page";
    var pageLbl = el("span", "pv-pagelbl", "…");
    var next = el("button", "pv-navbtn", "›"); next.type = "button"; next.title = "Next page";
    var zoomOut = el("button", "pv-navbtn", "−"); zoomOut.type = "button"; zoomOut.title = "Zoom out";
    var zoomLbl = el("span", "pv-zoomlbl", "100%");
    var zoomIn = el("button", "pv-navbtn", "+"); zoomIn.type = "button"; zoomIn.title = "Zoom in";
    nav.appendChild(prev); nav.appendChild(pageLbl); nav.appendChild(next);
    nav.appendChild(el("span", "pv-navsep"));
    nav.appendChild(zoomOut); nav.appendChild(zoomLbl); nav.appendChild(zoomIn);
    modal.appendChild(nav);

    /* scrollable canvas area */
    var body = el("div", "pv-body");
    var host = el("div", "pv-canvas-host");
    var spinner = el("div", "pv-loading", "Rendering preview…");
    host.appendChild(spinner);
    body.appendChild(host);
    modal.appendChild(body);

    back.appendChild(modal);
    document.body.appendChild(back);

    function updateNav() {
      pageLbl.textContent = st.page + " / " + st.count;
      prev.disabled = st.page <= 1;
      next.disabled = st.page >= st.count;
      zoomLbl.textContent = Math.round(st.zoom * 100) + "%";
    }
    function renderCurrent() {
      if (!st.pdf || st.busy) return;
      st.busy = true;
      var target = st.page;
      var cssW = Math.min((body.clientWidth || 800) - 36, 1000) * st.zoom;
      renderThumb(st.pdf, target, Math.max(120, cssW)).then(function (canvas) {
        canvas.style.width = Math.max(120, cssW) + "px";
        canvas.className = "pv-page-canvas";
        clear(host); host.appendChild(canvas);
        body.scrollTop = 0;
        st.busy = false;
        if (st.want !== target) renderCurrent(); // coalesce rapid nav
      }).catch(function () {
        st.busy = false;
        clear(host);
        var e = el("div", "pv-error");
        e.appendChild(document.createTextNode("Couldn't render the preview here. "));
        var a = el("a", null, "Open it in a new tab"); a.href = url; a.target = "_blank"; a.rel = "noopener";
        e.appendChild(a); e.appendChild(document.createTextNode(" instead."));
        host.appendChild(e);
      });
    }
    function go(p) {
      st.page = Math.min(st.count, Math.max(1, p)); st.want = st.page;
      updateNav(); renderCurrent();
    }
    function setZoom(z) { st.zoom = Math.min(3, Math.max(0.4, z)); updateNav(); renderCurrent(); }
    prev.addEventListener("click", function () { go(st.page - 1); });
    next.addEventListener("click", function () { go(st.page + 1); });
    zoomOut.addEventListener("click", function () { setZoom(st.zoom / 1.2); });
    zoomIn.addEventListener("click", function () { setZoom(st.zoom * 1.2); });

    openPdfjs(bytes).then(function (pdf) {
      st.pdf = pdf; st.count = pdf.numPages; st.page = 1; st.want = 1;
      updateNav(); renderCurrent();
    }).catch(function () {
      clear(host);
      var e = el("div", "pv-error");
      e.appendChild(document.createTextNode("This file couldn't be opened for preview. "));
      var a = el("a", null, "Open it in a new tab"); a.href = url; a.target = "_blank"; a.rel = "noopener";
      e.appendChild(a);
      host.appendChild(e);
    });

    function close() {
      document.removeEventListener("keydown", onKey);
      back.remove();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 800);
      global.__wbPreviewOpen = false;
      /* §2.7: close() used to drop the DOM and keep the document — a live PDFDocumentProxy
         (worker port, page cache, decoded images) per preview, forever. Reopening builds a
         fresh one from the same bytes, so nothing depends on this surviving. */
      if (st.pdf) { try { st.pdf.destroy(); } catch (e) {} st.pdf = null; }
      if (host) { try { clear(host); } catch (e) {} }
      if (global.__wbPreviewState === st) global.__wbPreviewState = null;
    }
    function onKey(e) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight" || e.key === "PageDown") go(st.page + 1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") go(st.page - 1);
    }
    document.addEventListener("keydown", onKey);
    closeBtn.addEventListener("click", close);
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    global.__wbPreviewOpen = true;
    global.__wbPreviewState = st;
    return back;
  }

  /* ── Image preview modal (for image results / image ZIP entries) ── */
  function openImagePreview(bytes, filename, mime) {
    var url = URL.createObjectURL(bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime || "image/png" }));
    var back = el("div", "pv-back");
    var modal = el("div", "pv-modal");
    var head = el("div", "pv-head");
    head.appendChild(el("span", "pv-title", filename || "Image"));
    head.appendChild(el("span", "pv-spacer"));
    var dl = btn("Download", "btn dl sm");
    dl.addEventListener("click", function () { download(bytes, filename, mime); });
    head.appendChild(dl);
    var closeBtn = el("button", "pv-close", "✕");
    closeBtn.type = "button"; closeBtn.title = "Close (Esc)";
    head.appendChild(closeBtn);
    modal.appendChild(head);
    var body = el("div", "pv-body pv-imgbody");
    var img = el("img", "pv-img");
    img.src = url; img.alt = filename || "";
    body.appendChild(img);
    modal.appendChild(body);
    back.appendChild(modal);
    document.body.appendChild(back);
    function close() {
      document.removeEventListener("keydown", onKey);
      back.remove();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 800);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    closeBtn.addEventListener("click", close);
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    return back;
  }

  /* ── Window-parked references + their release (design §2.7) ─────────────────────────
     Four things outlived every run: `__wbResult.bytes` (the WHOLE output), `__wbOpenPreview`
     (a closure over the same bytes), `__wbPreviewState.pdf` (a live PDFDocumentProxy that
     close() never destroyed) and the result strip's second document over the output. None
     was ever released, so N run→restart cycles retained N outputs.

     `__wbResult` is also the gate's QA hook (`all-tools.js:68`), which is exactly why this
     runs on RESTART and nowhere else — never while a result screen is still on screen. */
  var resultStripPdf = null;

  function releasePageRefs() {
    try { global.__wbResult = null; } catch (e) {}
    try { global.__wbOpenPreview = null; } catch (e) {}
    try {
      var ps = global.__wbPreviewState;
      /* Don't destroy under an OPEN modal: renderCurrent() would fail into its own error
         panel. A modal open at restart time keeps its document until it closes. */
      if (ps && ps.pdf && !global.__wbPreviewOpen) {
        try { ps.pdf.destroy(); } catch (e2) {}
        ps.pdf = null;
        global.__wbPreviewState = null;
      }
    } catch (e) {}
    if (resultStripPdf) {
      try { resultStripPdf.destroy(); } catch (e) {}
      resultStripPdf = null;
    }
    /* The runtime's page-level ledger: object URLs, canvases and documents held with
       UnboundRun.holdPage() across runs. Absent (un-adopted page) → nothing to do. */
    try {
      if (global.UnboundRun && global.UnboundRun.releasePage) global.UnboundRun.releasePage();
    } catch (e) {}
  }

  /* ── Result screen with preview ──
     opts: { bytes, filename, mime, kind: 'pdf'|'zip'|'image'|'text',
             previewBytes (preview different bytes than downloaded, e.g. protect),
             entries: [{name, data}] (zip), stats: [{label, value}],
             note, onRestart, extraActions: [{label, bytes, filename, mime}] } */
  function resultScreen(host, opts) {
    clear(host);
    host.hidden = false;
    var panel = el("div", "result-panel");

    var head = el("div", "result-head");
    var check = el("div", "success-check");
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.5");
    var poly = document.createElementNS(NS, "polyline");
    poly.setAttribute("points", "20 6 9 17 4 12");
    svg.appendChild(poly);
    check.appendChild(svg);
    head.appendChild(check);
    var ht = el("div");
    ht.appendChild(el("div", "result-title", opts.title || "Your file is ready"));
    var sub = el("div", "result-sub");
    var subBits = [];
    if (opts.filename) subBits.push(opts.filename);
    // a Blob result (Blob-backed ZIP, §2.4) reports its length as .size, not .length
    if (opts.bytes) subBits.push(fmtBytes(opts.bytes.length || opts.bytes.byteLength || opts.bytes.size || 0));
    sub.textContent = subBits.join(" · ");
    ht.appendChild(sub);
    head.appendChild(ht);
    panel.appendChild(head);

    if (opts.stats && opts.stats.length) {
      var statsRow = el("div", "result-stats");
      opts.stats.forEach(function (s) {
        var chip = el("span", "result-stat");
        chip.appendChild(el("b", null, s.value));
        chip.appendChild(document.createTextNode(" " + s.label));
        statsRow.appendChild(chip);
      });
      panel.appendChild(statsRow);
    }

    var prev = el("div", "result-preview");
    panel.appendChild(prev);

    if (opts.note) {
      var noteEl = el("p", "hint result-note");
      if (typeof opts.note === "string") noteEl.textContent = opts.note;
      else noteEl.appendChild(opts.note);
      panel.appendChild(noteEl);
    }

    var kind = opts.kind || (/\.pdf$/i.test(opts.filename || "") ? "pdf" : /\.zip$/i.test(opts.filename || "") ? "zip" : "none");
    // previewBytes lets a tool preview DIFFERENT bytes than it downloads (e.g. protect-pdf previews the
    // unencrypted content while the download is the encrypted file).
    var previewSrc = opts.previewBytes || opts.bytes;
    var canPreviewPdf = (kind === "pdf") || !!opts.previewBytes;

    var actions = el("div", "result-actions");
    // Preview-before-download: open the real PDF in a pageable viewer
    if (canPreviewPdf) {
      var pv = btn("Preview", "btn preview");
      var eye = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      eye.setAttribute("viewBox", "0 0 24 24"); eye.setAttribute("fill", "none");
      eye.setAttribute("stroke", "currentColor"); eye.setAttribute("stroke-width", "2");
      eye.setAttribute("class", "pv-eye");
      var ep = document.createElementNS("http://www.w3.org/2000/svg", "path");
      ep.setAttribute("d", "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z");
      var ec = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      ec.setAttribute("cx", "12"); ec.setAttribute("cy", "12"); ec.setAttribute("r", "3");
      eye.appendChild(ep); eye.appendChild(ec);
      pv.insertBefore(eye, pv.firstChild);
      pv.addEventListener("click", function () { openPdfPreview(previewSrc, opts.filename); });
      actions.appendChild(pv);
    }
    var dl = btn("Download " + (opts.label || fileLabel(opts.filename)), "btn dl");
    dl.addEventListener("click", function () {
      download(opts.bytes, opts.filename, opts.mime);
    });
    actions.appendChild(dl);
    (opts.extraActions || []).forEach(function (a) {
      var b2 = btn(a.label, "btn ghost");
      b2.addEventListener("click", function () { download(a.bytes, a.filename, a.mime); });
      actions.appendChild(b2);
    });
    var again = btn("Start over", "btn ghost");
    again.addEventListener("click", function () {
      if (opts.onRestart) opts.onRestart();
    });
    actions.appendChild(again);
    panel.appendChild(actions);
    host.appendChild(panel);
    host.scrollIntoView({ behavior: "smooth", block: "nearest" });

    // QA hook
    global.__wbResult = { bytes: opts.bytes, filename: opts.filename, kind: opts.kind };
    global.__wbOpenPreview = canPreviewPdf ? function () { return openPdfPreview(previewSrc, opts.filename); } : null;

    // Async preview fill (thumbnail strip — a quick glance; click any page, or the Preview button,
    // to open the full pageable viewer)
    if (canPreviewPdf) {
      var lbl = el("div", "result-prev-label", "Preview · tap a page to open");
      prev.appendChild(lbl);
      var strip = el("div", "result-pages clickable");
      strip.addEventListener("click", function () { openPdfPreview(previewSrc, opts.filename); });
      prev.appendChild(strip);
      openPdfjs(previewSrc).then(function (pdf) {
        resultStripPdf = pdf;   // a SECOND live document over the output bytes — see releasePageRefs
        lbl.textContent = "Preview · " + pluralPages(pdf.numPages) + " · tap to open";
        var count = Math.min(pdf.numPages, 5);
        var chain = Promise.resolve();
        for (var i = 1; i <= count; i++) {
          (function (n) {
            chain = chain.then(function () {
              return renderThumb(pdf, n, 140).then(function (canvas) {
                var card = el("div", "result-page");
                card.appendChild(canvas);
                card.appendChild(el("span", "pn", String(n)));
                strip.appendChild(card);
              });
            });
          })(i);
        }
        return chain.then(function () {
          if (pdf.numPages > count) {
            strip.appendChild(el("div", "result-page more", "+" + (pdf.numPages - count) + " more"));
          }
        });
      }).catch(function () {
        lbl.textContent = "Preview unavailable (file is encrypted or non-standard).";
      });
    } else if (kind === "zip" && opts.entries) {
      var lbl2 = el("div", "result-prev-label", opts.entries.length + " files in ZIP");
      prev.appendChild(lbl2);
      var list = el("ul", "result-ziplist");
      opts.entries.slice(0, 12).forEach(function (e) {
        var li = el("li");
        li.appendChild(el("span", "zname", e.name));
        // Blob-backed entries carry an explicit size (the bytes are off-heap by design)
        li.appendChild(el("span", "zsize", fmtBytes(e.size != null ? e.size : (e.data ? e.data.length : (e.blob ? e.blob.size : 0)))));
        var isPdf = /\.pdf$/i.test(e.name);
        var isImg = /\.(jpe?g|png|webp)$/i.test(e.name);
        if (isPdf || isImg) {
          li.classList.add("zpreview");
          li.title = "Click to preview";
          li.appendChild(el("span", "zeye", "Preview ›"));
          li.addEventListener("click", function () {
            if (isPdf) openPdfPreview(e.data, e.name);
            else openImagePreview(e.data || e.blob, e.name, /\.png$/i.test(e.name) ? "image/png" : /\.webp$/i.test(e.name) ? "image/webp" : "image/jpeg");
          });
        }
        list.appendChild(li);
      });
      if (opts.entries.length > 12) {
        var li2 = el("li");
        li2.appendChild(el("span", "zname", "… and " + (opts.entries.length - 12) + " more"));
        list.appendChild(li2);
      }
      prev.appendChild(list);
      if (opts.previewCanvases && opts.previewCanvases.length) {
        var strip2 = el("div", "result-pages");
        opts.previewCanvases.slice(0, 5).forEach(function (c, i) {
          var card = el("div", "result-page");
          c.style.width = "100%"; c.style.height = "auto";
          card.appendChild(c);
          card.appendChild(el("span", "pn", String(i + 1)));
          strip2.appendChild(card);
        });
        prev.appendChild(strip2);
      }
    } else if (kind === "image" && opts.previewUrl) {
      var img = el("img", "result-img");
      img.src = opts.previewUrl;
      img.alt = "Result preview";
      prev.appendChild(img);
    } else if (kind === "text" && opts.previewText != null) {
      prev.appendChild(el("div", "result-prev-label", "Preview"));
      var pre = el("pre", "result-text", String(opts.previewText).slice(0, 1200) || "(empty)");
      prev.appendChild(pre);
    } else if (kind === "canvases" && opts.previewCanvases) {
      var strip3 = el("div", "result-pages");
      opts.previewCanvases.slice(0, 6).forEach(function (c, i) {
        var card = el("div", "result-page");
        c.style.width = "100%"; c.style.height = "auto";
        card.appendChild(c);
        card.appendChild(el("span", "pn", String(i + 1)));
        strip3.appendChild(card);
      });
      prev.appendChild(strip3);
    } else {
      prev.remove();
    }
    return panel;
  }
  function fileLabel(name) {
    if (/\.zip$/i.test(name)) return "ZIP";
    if (/\.pdf$/i.test(name)) return "PDF";
    if (/\.docx$/i.test(name)) return "DOCX";
    if (/\.csv$/i.test(name)) return "CSV";
    if (/\.(jpe?g|png)$/i.test(name)) return "image";
    if (/\.txt$/i.test(name)) return "TXT";
    return "file";
  }

  /* ── Shell renderer (steps/faq/related come from static HTML now; kept for FAQ injection) ── */
  function renderShell(cfg) {
    var faqHost = $("faqList");
    if (faqHost && cfg.faq && !faqHost.children.length) {
      cfg.faq.forEach(function (f, i) {
        var det = document.createElement("details");
        if (i === 0) det.open = true;
        var sum = document.createElement("summary");
        var icon = el("span", "faq-icon", "+");
        sum.appendChild(icon);
        sum.appendChild(document.createTextNode(f.q));
        var ans = el("div", "fa");
        ans.appendChild(document.createTextNode(f.a));
        det.appendChild(sum);
        det.appendChild(ans);
        faqHost.appendChild(det);
      });
    }
  }

  global.PDFTK = {
    $: $, el: el, bnode: bnode, clear: clear, setContent: setContent, append: append,
    input: input, btn: btn, dzIcon: dzIcon,
    show: show, hide: hide, fmtBytes: fmtBytes, pluralPages: pluralPages,
    yield_: yield_, looksLikePdf: looksLikePdf, baseName: baseName, pad: pad, clone: clone,
    isEncryptedError: isEncryptedError, isAllocationError: isAllocationError, humanError: humanError,
    download: download, buildZip: buildZip, crc32: crc32,
    parseRanges: parseRanges, wireDrop: wireDrop, wireDropEl: wireDropEl,
    waitLib: waitLib, onLibReady: onLibReady, loadPdf: loadPdf, readPdfMeta: readPdfMeta,
    savePdf: savePdf, loadPdfJs: loadPdfJs, openPdfjs: openPdfjs, loadScript: loadScript,
    makeRequantWorker: makeRequantWorker, REQUANT_WORKER_ON: REQUANT_WORKER_ON,
    renderPageToCanvas: renderPageToCanvas, renderThumb: renderThumb,
    canvasToJpegBytes: canvasToJpegBytes, canvasToPngBytes: canvasToPngBytes,
    canvasToBlob: canvasToBlob, canvasToJpegBlob: canvasToJpegBlob,
    embedJpegPage: embedJpegPage, textToDocx: textToDocx, docxFromBlocks: docxFromBlocks, rowsToCsv: rowsToCsv, readZip: readZip,
    wrapText: wrapText, sanitizeWinAnsi: sanitizeWinAnsi,
    progressPanel: progressPanel, errorPanel: errorPanel, resultScreen: resultScreen,
    renderShell: renderShell,
    MAX_CANVAS_AREA: MAX_CANVAS_AREA, clampScaleToArea: clampScaleToArea,
    releasePageRefs: releasePageRefs,
    get libReady() { return libReady; },
    DOMAIN: DOMAIN, BASE: BASE
  };

  global.__pdftk = global.__pdftk || {};
  Object.assign(global.__pdftk, {
    parseRanges: parseRanges, buildZip: buildZip, download: download
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { waitLib(0); });
  } else waitLib(0);
})(window);
