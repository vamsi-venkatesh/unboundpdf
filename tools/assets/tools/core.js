"use strict";
/* UnboundPDF v2 — CORE (shared prelude), split from all-tools.js (W0-6, 2026-08-18).
   Staged workbench: upload -> configure (live thumbnails) -> progress -> result screen
   (preview + download + start over). No innerHTML anywhere: DOM is built with safe
   createElement helpers.
   This file is TIER 1 (shell, precached). It builds window.UBT, the namespace every
   per-tool module in tools/t/<slug>.js reads its shared helpers from. Each tool module is
   its former all-tools.js block, byte-for-byte, wrapped to pull what it needs off UBT --
   see tools/t/<slug>.js. UBT.T is kept live (not snapshotted) because boot()'s go()
   assigns it asynchronously, after every tool module has already loaded; every consumer
   reads UBT.T at call time, never a load-time copy. */
(function () {
  window.UBT = window.UBT || {};
  var UBT = window.UBT;
  var tool = document.body && document.body.getAttribute("data-tool");
  UBT.tool = tool;
  if (!tool) return;
  // These pages are powered by editor.js (shared editor component)
  if (tool === "pdf-editor" || tool === "fill-sign" || tool === "sign-pdf") return;

  var T; // PDFTK
  function boot(fn) {
    function go() {
      T = window.PDFTK;
      UBT.T = T;
      if (tool === "html-to-pdf") fn();
      else T.onLibReady(fn);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
    else go();
  }

  /* ═══════════════ Workbench framework ═══════════════ */

  function workbench(opts) {
    var host = T.$("toolUI");
    /* PRE-BOOT INTAKE RACE, the deterministic half: whatever intake existed before this build
       (the page's static shell, or a previous pre-engine workbench) may hold files the user
       already handed over. Harvest them BEFORE the clear destroys that input; they replay
       below once this workbench has a consumer. */
    var prevInp = host && host.querySelector('input[type="file"]');
    if (prevInp && prevInp.files && prevInp.files.length) {
      window.__wbPendingFiles = Array.prototype.slice.call(prevInp.files);
    }
    T.clear(host);
    var wb = {};
    wb.opts = opts || {};

    // Stage: upload
    var up = T.el("div", "wb-stage wb-upload");
    var dz = T.el("div", "drop");
    dz.tabIndex = 0;
    dz.setAttribute("role", "button");
    dz.setAttribute("aria-label", "Upload files");
    var dt = T.el("div", "dz-t");
    dt.appendChild(document.createTextNode((opts.dropLabel || "Drop your file here, or ")));
    dt.appendChild(T.bnode("click to browse"));
    T.append(dz, [T.dzIcon(), dt, T.el("div", "dz-s", opts.hint || "Processed on your device — nothing is uploaded")]);
    var fin = T.input({ type: "file", accept: opts.accept || ".pdf,application/pdf" });
    if (opts.multiple) fin.multiple = true;
    dz.appendChild(fin);
    up.appendChild(dz);

    // Stage: configure
    var cfg = T.el("div", "wb-stage wb-config");
    cfg.hidden = true;

    // Stage: result
    var res = T.el("div", "wb-stage wb-result");
    res.hidden = true;

    host.appendChild(up);
    host.appendChild(cfg);
    host.appendChild(res);

    wb.err = T.errorPanel(host);
    wb.prog = T.progressPanel(host);
    wb.uploadEl = up; wb.configEl = cfg; wb.resultEl = res; wb.dropEl = dz;

    function onFiles(files) {
      wb.err.hide();
      if (wb.onFiles) wb.onFiles(files);
      /* PRE-BOOT INTAKE RACE (2026-08-28, found by the release gate's firefox audit on
         sanitize-pdf): a TIER-2 tool's surface loads lazily, and until it re-builds the
         workbench, THIS shell owns the drop zone — with no wb.onFiles consumer, a file handed
         over during that window used to be read, cleared and silently discarded. Stash what no
         consumer took; the next workbench build replays it. Cleared on consumption and on
         every replay attempt so a stale file can never resurface later. */
      else { window.__wbPendingFiles = Array.prototype.slice.call(files); return; }
      window.__wbPendingFiles = null;
    }
    T.wireDropEl(dz, fin, onFiles, !!opts.multiple);
    // QA hook: allows automated tests to inject File objects
    window.__wbAddFiles = onFiles;
    /* Replay a stash left by a previous (pre-boot) workbench, exactly once, and only into a
       workbench that has a real consumer. setTimeout(0): wb.onFiles is assigned by the tool
       AFTER workbench() returns. */
    setTimeout(function () {
      var pend = window.__wbPendingFiles;
      if (pend && pend.length && wb.onFiles && window.__wbAddFiles === onFiles) {
        window.__wbPendingFiles = null;
        onFiles(pend);
      }
    }, 0);
    window.__wbResult = null;
    /* The rung-4 hooks are cleared HERE, with __wbResult, for the reason __wbResult is:
       a hook that survives a restart lets a suite read the PREVIOUS run's numbers and
       call them this run's. They are set together and they must die together. */
    window.__ocrPrepTelemetry = null;
    window.__ocrPrepText = null;

    /* Try a sample — removes cold-start fear; file is fetched same-origin, never uploaded.
       Skip for image/docx-only intakes (their accept lists exclude PDF). */
    var accept = (opts.accept || ".pdf,application/pdf").toLowerCase();
    var pdfOk = accept.indexOf("pdf") >= 0;
    if (opts.sample !== false && pdfOk) {
      var sampleRow = T.el("p", "sample-row");
      var sampleBtn = T.el("button", "sample-btn", "Try a sample PDF");
      sampleBtn.type = "button";
      sampleBtn.addEventListener("click", async function () {
        sampleBtn.disabled = true;
        sampleBtn.textContent = "Loading…";
        try {
          var url = opts.sampleUrl || "/tools/assets/samples/letter.pdf";
          var resp = await fetch(url);
          if (!resp.ok) throw new Error("Sample unavailable");
          var blob = await resp.blob();
          var file = new File([blob], "sample-letter.pdf", { type: "application/pdf" });
          onFiles([file]);
        } catch (e) {
          wb.err.show("Could not load the sample. Choose a file from your device instead.");
          sampleBtn.disabled = false;
          sampleBtn.textContent = "Try a sample PDF";
        }
      });
      sampleRow.appendChild(sampleBtn);
      up.appendChild(sampleRow);
    }

    if (opts.honesty) {
      var chip = T.el("p", "honesty-chip", opts.honesty);
      up.appendChild(chip);
    }

    wb.showUpload = function () {
      up.hidden = false; cfg.hidden = true; res.hidden = true;
      document.body.classList.remove("tool-session");
    };
    wb.showConfig = function () {
      up.hidden = true; cfg.hidden = false; res.hidden = true;
      document.body.classList.add("tool-session");
    };
    wb.showResult = function (o) {
      up.hidden = true; cfg.hidden = true; res.hidden = false;
      document.body.classList.add("tool-session");
      wb.prog.done();
      o.onRestart = o.onRestart || wb.restart;
      T.resultScreen(res, o);
    };
    wb.restart = function () {
      document.body.classList.remove("tool-session");
      /* §2.7 — the ONLY place the window-parked references are released: the previous run's
         whole output (__wbResult.bytes), its preview closure, the preview document and the
         runtime's page ledger. Deliberately here and not on showResult: __wbResult is the
         gate's result hook and must survive for as long as the result screen is on screen. */
      if (T.releasePageRefs) T.releasePageRefs();
      if (wb.onRestart) wb.onRestart();
    };
    return wb;
  }

  /** Wrap an async handler: disables button, catches errors into wb.err. */
  function run(wb, goBtn, fn) {
    return async function () {
      wb.err.hide();
      var orig = goBtn.textContent;
      goBtn.disabled = true;
      var spin = T.el("span", "spinner");
      goBtn.textContent = "";
      goBtn.appendChild(spin);
      goBtn.appendChild(document.createTextNode("Working…"));
      await T.yield_();
      try {
        await fn();
      } catch (e) {
        console.error("[" + tool + "]", e);
        wb.prog.done();
        wb.err.showError(e);
      } finally {
        goBtn.disabled = false;
        goBtn.textContent = orig;
      }
    };
  }

  /* ═══════════════ Shared execution runtime adoption (P1-DESIGN §1.3, §4) ═══════════════
     Every heavy handler below runs inside UnboundRun.run(): truthful phases, a real Stop
     button, a cleanup ledger that runs on ok / failed / cancelled alike, and — structurally —
     no percentage that a counter did not produce. `ctx` has no set(pct), which is what
     deletes the 15 fake fixed percentages rather than merely discouraging them.

     The body keeps each tool's own result handling. Cancellation throws out of ctx.check()
     long before wb.showResult() is reached, so a cancelled run leaves the user on the config
     screen with the input untouched — no tool writes to its input. */

  /** Fallback ctx for a page served before runtime.js existed (a stale HTML cache). It obeys
      the same progress law — a percentage only ever comes from step()'s counter — so the
      tool degrades to "no Stop button", never to a dishonest bar. */
  function ubrShim(wb) {
    var last = 0;
    function say(t) { if (wb && wb.prog) wb.prog.set(last, t); }
    return {
      signal: null,
      plan: { mode: "standard", stub: true, batch: 8, pageCache: 3, previews: true },
      phase: function (n) { say(String(n) + "…"); },
      pulse: function (n) { say(String(n) + "…"); },
      step: function (i, n, label) {
        var total = Number(n) || 0, at = Number(i) || 0;
        if (total > 0) last = Math.max(0, Math.min(100, Math.round((at / total) * 100)));
        say((label ? String(label) + " " : "") + at + (total > 0 ? " of " + total : ""));
      },
      check: function () { return Promise.resolve(); },
      hold: function (v) { return v; },
      releaseAll: function () {},
      note: function (k, v) { return v; }
    };
  }

  /** desc: { op, cancel, input } or a function returning one — resolved at click time so a
      descriptor never depends on script load order or on config the user has not set yet. */
  function urun(wb, goBtn, desc, body) {
    return run(wb, goBtn, async function () {
      var UR = window.UnboundRun;
      if (!UR || typeof UR.run !== "function") return await body(ubrShim(wb));
      var d = (typeof desc === "function") ? desc() : (desc || {});
      /* The runtime RESOLVES on every real outcome (ok / failed / cancelled) and has already
         classified, shown and logged a failure — rethrowing would show the same error twice.
         It REJECTS on exactly one thing: a second run on a busy page (deskew has two buttons
         that can both start work). That is a user situation, not an exception, so it gets a
         sentence rather than the internal message. */
      try {
        return await UR.run({
          tool: d.tool || tool,
          op: d.op || "structural",
          input: (typeof d.input === "function") ? d.input() : (d.input || null),
          cancel: UR.CANCEL[d.cancel || "RESTART"] || UR.CANCEL.RESTART,
          ui: { prog: wb.prog, err: wb.err, host: wb.configEl || null },
          body: body
        });
      } catch (e) {
        if (/already in flight/.test(String((e && e.message) || e))) {
          wb.err.show("Another job is still running on this page. Wait for it to finish, or stop it first.");
          return null;
        }
        throw e;
      }
    });
  }

  /** The descriptor's `input` for a singlePdf state — bytes are recorded, never copied. */
  function stIn(st) {
    return function () {
      return { bytes: st.buf, name: st.name, size: st.size, pages: st.pages, pdf: st.pdf };
    };
  }

  function actionRow(goLabel) {
    var row = T.el("div", "actionrow wb-act");
    var summ = T.el("span", "summ");
    var spacer = T.el("span", "spacer");
    var go = T.btn(goLabel, "btn wb-go");
    row.appendChild(summ); row.appendChild(spacer); row.appendChild(go);
    return { row: row, summ: summ, go: go };
  }

  /* A <label> that neither wraps its control nor carries `for` names nothing. Every control
     built through fld() had a visible label and no ACCESSIBLE one; the Page size <select> on
     html-to-pdf is simply the one axe can prove it about (rule select-name, critical), because
     inputs alongside it were scraping a name off their placeholder. Bind the pair here, once,
     rather than hanging an aria-label on the single control a scan happened to catch. */
  var fldUid = 0;
  function fld(labelText, control, hintText) {
    var f = T.el("div", "fld");
    if (labelText) {
      var lab = T.el("label", null, labelText);
      if (control) {
        if (!control.id) control.id = "fld-" + (++fldUid);
        lab.setAttribute("for", control.id);
      }
      f.appendChild(lab);
    }
    if (control) f.appendChild(control);
    if (hintText) f.appendChild(T.el("p", "hint", hintText));
    return f;
  }

  function selectEl(options, value) {
    var s = document.createElement("select");
    s.className = "txtin";
    options.forEach(function (o) {
      var op = document.createElement("option");
      op.value = o[0]; op.textContent = o[1];
      s.appendChild(op);
    });
    if (value != null) s.value = value;
    return s;
  }

  function fileCard(entry, actions) {
    var li = T.el("li", "frow" + (entry.bad ? " bad" : ""));
    var ico = T.el("span", "fico", entry.icoText || "PDF");
    li.appendChild(ico);
    var m = T.el("span", "fmeta");
    m.appendChild(T.el("span", "fname", entry.name));
    m.appendChild(T.el("span", "fsub", entry.bad ? entry.err : entry.loading ? "Reading…" : T.fmtBytes(entry.size)));
    li.appendChild(m);
    if (entry.pages != null) li.appendChild(T.el("span", "fpages", T.pluralPages(entry.pages)));
    if (actions && actions.length) {
      var facts = T.el("span", "facts");
      actions.forEach(function (a) { facts.appendChild(a); });
      li.appendChild(facts);
    }
    return li;
  }

  function icBtn(sym, title, onclick) {
    var b = T.el("button", "icbtn" + (sym === "\u2715" ? " x" : ""), sym);
    b.type = "button";
    b.title = title;
    b.onclick = onclick;
    return b;
  }

  /** A visible drag handle (6-dot grip) so users can see a row is draggable. */
  function gripHandle() {
    var g = T.el("span", "fgrip");
    g.title = "Drag to reorder";
    g.setAttribute("aria-label", "Drag to reorder");
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "14"); svg.setAttribute("height", "16");
    svg.setAttribute("fill", "currentColor"); svg.setAttribute("aria-hidden", "true");
    [[5, 3], [11, 3], [5, 8], [11, 8], [5, 13], [11, 13]].forEach(function (p) {
      var c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", p[0]); c.setAttribute("cy", p[1]); c.setAttribute("r", "1.4");
      svg.appendChild(c);
    });
    g.appendChild(svg);
    return g;
  }

  /** Wire native drag-reorder on a list row. `ctx` holds the shared drag source ({from:null}). */
  function wireRowDrag(li, index, arr, rerender, ctx) {
    li.draggable = true;
    li.classList.add("frow-drag");
    li.addEventListener("dragstart", function (ev) {
      ctx.from = index;
      li.classList.add("dragging");
      try { ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", String(index)); } catch (e) {}
    });
    li.addEventListener("dragend", function () {
      li.classList.remove("dragging");
      if (li.parentNode) Array.prototype.forEach.call(li.parentNode.children, function (n) { n.classList.remove("drag-over"); });
      ctx.from = null;
    });
    li.addEventListener("dragover", function (ev) {
      ev.preventDefault();
      try { ev.dataTransfer.dropEffect = "move"; } catch (e) {}
      if (ctx.from !== null && ctx.from !== index) li.classList.add("drag-over");
    });
    li.addEventListener("dragleave", function () { li.classList.remove("drag-over"); });
    li.addEventListener("drop", function (ev) {
      ev.preventDefault();
      li.classList.remove("drag-over");
      if (ctx.from === null || ctx.from === index) return;
      arr.splice(index, 0, arr.splice(ctx.from, 1)[0]);
      ctx.from = null;
      rerender();
    });
  }

  /** A small "drag or use arrows to reorder" hint line. */
  function reorderHint(text) {
    var p = T.el("p", "hint reorder-hint");
    p.appendChild(gripHandle());
    p.appendChild(document.createTextNode(text || "Drag a row by its handle \u2014 or use the \u2191 \u2193 buttons \u2014 to set the order."));
    return p;
  }

  /* ── Pre-flight wiring (P1-DESIGN §3, step 7) ────────────────────────────────────────
     The op class each tool's heavy run declares in its urun() descriptor. Kept here as one
     table so the PRE-flight (which happens at intake, before any button exists) and the run
     descriptor cannot drift apart. Anything absent is "structural", which is what the
     descriptors default to. compress-pdf switches class on its own Maximum toggle, so it is
     given its common (Balanced) class here and the descriptor still decides at click time. */
  var TOOL_OP = {
    "pdf-to-jpg": "raster-export", "extract-images": "raster-export",
    "deskew-pdf": "raster-export", "html-to-pdf": "raster-export",
    "flatten-pdf": "raster-export", "redact-pdf": "raster-export",
    "ocr-pdf": "ocr", "merge-pdf": "multi-doc", "compress-pdf": "requant",
    "pdf-editor": "editor", "fill-sign": "editor", "sign-pdf": "editor",
    /* W5-E1 images pack: the three that decode, redraw and re-encode a raster are
       "raster-export" (the same class pdf-to-jpg declares); remove-watermark-pdf edits object
       structure and content streams, so it takes the default "structural". */
    "passport-photo": "raster-export", "remove-background": "raster-export",
    "resize-image": "raster-export",
    /* W6-B: heic-convert decodes a picture and re-encodes it, and email-to-pdf drives the same
       dompdf renderer html-to-pdf drives — both are the "raster-export" class, for the same
       reason those two are. */
    "heic-convert": "raster-export", "email-to-pdf": "raster-export",
    /* W6-C (2026-08-27): sanitize-pdf edits object structure only and takes the default
       "structural", so it is deliberately NOT listed here — a row that merely restates the
       default is a row that can drift from it.
       W7-B (2026-08-28): make-fillable is the same case. It adds widget annotations and an
       AcroForm and never writes a page's content stream, so it takes the default too and is
       likewise absent on purpose. */
    /* W7-C (2026-08-28): both new scan tools rasterise EVERY page before they can do anything —
       split-book-scan renders each sheet to crop it, remove-blank-pages renders each page to
       measure it — so the work the pre-flight has to size is raster work, whatever the rebuild
       afterwards looks like. Same class pdf-to-jpg and deskew-pdf declare, for the same reason. */
    "split-book-scan": "raster-export", "remove-blank-pages": "raster-export",
  };

  /** A genuine structural scan, not a size guess: sample the first pages' text layer through
      the pdf.js document the intake ALREADY opened (no second parse, no pixel decode) and
      cross it with bytes-per-page. A page with no text runs and heavy bytes is a scan; text
      runs with light bytes is a text document; both is mixed. */
  async function detectType(pdf, size, pages) {
    if (!pdf || !pdf.numPages) return null;
    var sample = Math.min(3, pdf.numPages), textRuns = 0;
    for (var i = 1; i <= sample; i++) {
      try {
        var pg = await pdf.getPage(i);
        var tc = await pg.getTextContent();
        textRuns += (tc && tc.items) ? tc.items.length : 0;
      } catch (e) { return null; }        // unreadable text layer: fall back to the estimate
    }
    var kbPerPage = pages ? (size / 1024) / pages : 0;
    var hasText = textRuns > 8 * sample;
    var heavy = kbPerPage > 150;
    return {
      type: (hasText && heavy) ? "mixed text and images" : hasText ? "mostly text" : "mostly scanned images",
      scanned: !hasText, imageHeavy: heavy
    };
  }

  /** Compute the document's plan, park it as the page plan (so thumbnails, the editor and
      the run all obey ONE decision) and put the §11 pre-processing panel on the config
      screen. Called after the tool's own setup has rendered, so the panel sits under the
      file card rather than being wiped by the tool's T.clear(). */
  function preflightFor(wb, st) {
    var UR = window.UnboundRun;
    if (!UR || !UR.preflight) return null;
    var opClass = TOOL_OP[tool] || "structural";
    var forced = null;                       // a mode the USER picked — survives the rescan
    function build(extra) {
      var input = { name: st.name, size: st.size, pages: st.pages };
      if (extra) { input.type = extra.type; input.scanned = extra.scanned; input.imageHeavy = extra.imageHeavy; }
      return input;
    }
    function place(plan) {
      UR.setPagePlan(plan);
      if (!wb.configEl) return;
      var old = wb.configEl.querySelector(".ubr-preflight");
      if (old && old.parentNode) old.parentNode.removeChild(old);
      var el = UR.preflightPanel(plan, function (mode) {
        forced = mode;
        place(UR.preflight(plan.input, opClass, { tool: tool, force: mode }));
      });
      if (!el) return;
      /* Under the file card (the tools' first config child), never above it: the file's own
         identity comes first, the expectation second. */
      var anchor = wb.configEl.firstChild;
      if (anchor && anchor.nextSibling) wb.configEl.insertBefore(el, anchor.nextSibling);
      else wb.configEl.appendChild(el);
    }
    var plan0 = UR.preflight(build(null), opClass, { tool: tool });
    place(plan0);
    /* The structural scan is async and cheap; when it lands it REPLACES the size-derived
       guess, and the panel says which one it used. */
    detectType(st.pdf, st.size, st.pages).then(function (d) {
      if (d && UR.pagePlan()) place(UR.preflight(build(d), opClass, { tool: tool, force: forced }));
    }).catch(function () {});
    return plan0;
  }

  /** Single-PDF intake: wires drop → reads buffer → opens PDF.js doc → onReady(state).
      Pre-flight is wrapped around onReady rather than pushed into 24 tool bodies: the tool
      renders its config synchronously, then the panel is inserted under the file card. One
      wiring point, no tool edited. */
  function singlePdf(wb, onReadyRaw) {
    var onReady = function (st) {
      var UR = window.UnboundRun;
      if (UR && UR.setPagePlan) UR.setPagePlan(null);   // a new document, a new decision
      onReadyRaw(st);
      try { preflightFor(wb, st); } catch (e) { /* pre-flight is advisory: never block intake */ }
    };
    wb.onFiles = function (files) {
      var f = files[0];
      if (!f) return;
      if (!T.looksLikePdf(f.name) && f.type !== "application/pdf") {
        wb.err.show("That doesn't look like a PDF file. Please choose a .pdf document.");
        return;
      }
      document.body.classList.add("wb-loading");
      /* Intake: a file read has no counter, so the bar asserts nothing and the text says
         what is happening. The old fixed 20% was a number about nothing. */
      wb.prog.set(0, "Reading " + f.name + "…");
      f.arrayBuffer().then(function (buf) {
        return T.openPdfjs(buf).then(function (pdf) {
          document.body.classList.remove("wb-loading");
          wb.prog.done();
          onReady({ buf: buf, name: f.name, size: f.size, pdf: pdf, pages: pdf.numPages });
        }).catch(function (e) {
          // PDF.js failed (encrypted or damaged) — try pdf-lib for a better error
          return T.loadPdf(buf).then(function (doc) {
            document.body.classList.remove("wb-loading");
            wb.prog.done();
            onReady({ buf: buf, name: f.name, size: f.size, pdf: null, pages: doc.getPageCount() });
          }).catch(function (e2) {
            document.body.classList.remove("wb-loading");
            wb.prog.done();
            wb.err.showError(e2);
          });
        });
      }).catch(function (e) {
        document.body.classList.remove("wb-loading");
        wb.prog.done();
        wb.err.showError(e);
      });
    };
  }

  /** Thumbnail grid. opts: {size, max, clickable, deletable, draggable, onClick(item), onChange,
      capNote(shown, rest, total) -> string} */
  function thumbGrid(container, pdf, opts) {
    opts = opts || {};
    var grid = T.el("div", "pgrid" + (opts.large ? " lg" : ""));
    var max = Math.min(pdf.numPages, opts.max || 150);
    /* The cap notice has to be read BEFORE the grid, not after it: appended below 200 thumbnails
       it landed ~5 screens down on a 1000-page document, where a warning cannot do its job. A tool
       whose carry-through rule differs from the default states its own via opts.capNote. */
    if (pdf.numPages > max) {
      var capNote = T.el("p", "msg warn", opts.capNote
        ? opts.capNote(max, pdf.numPages - max, pdf.numPages)
        : "Showing thumbnails for the first " + max + " of " + pdf.numPages + " pages. The rest are kept in the output in their original order, but cannot be edited here.");
      container.appendChild(capNote);
    }
    container.appendChild(grid);
    var items = [];
    var ctl = { items: items, grid: grid };

    /* Viewport-lazy thumbnails (large-doc runtime design §2.3). Every tile used to be rasterised
       up front in one sequential chain: at 110 CSS px x dpr 2 that is ~274 KB of canvas backing
       store per page, so a 150-tile grid held ~41 MB and organize-pdf's 200-tile grid ~55 MB —
       allocated on the CONFIG screen, before the user had clicked anything, and never released.
       Tiles are now rastered as they approach the viewport and released once far behind it, so
       the resident set follows the window rather than the document.

       Everything that makes a tile a tile — rotation, selection, deletion, drag order, its
       number — lives on the wrapper elements, never on the pixels, so a release/re-render round
       trip is invisible to callers and to the user. The .pcanvas wrap keeps its measured height
       while empty, so the grid never reflows under a scroll. */
    var THUMB_SIZE = opts.size || 110;
    /* Bands, in CSS px above and below the viewport. Measured at 1280x900 on a 200-tile grid
       (10 columns, ~195 px rows): ~46 tiles are genuinely ON screen, so that is the floor; the
       render band adds ~1.5 rows of lead so a scroll meets pixels, and the release band is wide
       enough that a short scroll back does not re-rasterise what it just dropped.

       Step 7 lets the pre-flight plan narrow them: in low-memory mode the render band drops
       to the viewport itself and the release band to one screen, so the grid holds roughly
       the tiles you can actually see. A shape, not a memory claim — and it falls back to the
       measured defaults whenever no plan exists. */
    var _tgPlan = (window.UnboundRun && window.UnboundRun.pagePlan) ? window.UnboundRun.pagePlan() : null;
    var _tgBand = (_tgPlan && _tgPlan.thumbBand) ? _tgPlan.thumbBand : null;
    var RENDER_MARGIN = _tgBand ? _tgBand.render : "300px 0px";
    var RELEASE_MARGIN = _tgBand ? _tgBand.release : "900px 0px";
    var queue = [], draining = false, observerFired = false, settled = false, paused = false;
    var placeholderH = 0;
    var settleFirstPass;
    var firstPass = new Promise(function (res) { settleFirstPass = res; });

    function applyRotation(item) {
      var c = item.canvas;
      if (!c) return;
      var odd = (item.rotation / 90) % 2 !== 0;
      var fit = 1;
      if (odd) {
        var r = c.width / c.height;
        fit = Math.min(r, 1 / r);
      }
      c.style.transform = "rotate(" + item.rotation + "deg)" + (odd ? " scale(" + fit.toFixed(3) + ")" : "");
    }

    function renderItem(item) {
      if (item.canvas || item.rendering || !item.want) return Promise.resolve();
      item.rendering = true;
      return T.renderThumb(pdf, item.index + 1, THUMB_SIZE).then(function (canvas) {
        item.rendering = false;
        // it may have scrolled out of reach while pdf.js was working — drop the pixels, not the tile
        if (!item.want) { canvas.width = 0; canvas.height = 0; return; }
        item.canvas = canvas;
        item.canvasWrap.style.minHeight = "";
        item.canvasWrap.appendChild(canvas);
        if (item.rotation) applyRotation(item);
      }).catch(function () { item.rendering = false; });
    }

    /** Drop a tile's pixel backing. `h` is its measured height, read by the caller in one batch
        so a release sweep does not interleave layout reads and writes. */
    function releaseItem(item, h) {
      var c = item.canvas;
      if (!c) return;
      item.canvas = null;
      if (c.parentNode) c.parentNode.removeChild(c);
      c.width = 0; c.height = 0;
      item.canvasWrap.style.minHeight = (h > 20 ? h : placeholderH || 60) + "px";
    }

    function settle() {
      if (settled || !observerFired || draining || queue.length) return;
      settled = true;
      settleFirstPass();
    }

    function drain() {
      if (draining) return;
      var next = null;
      while (queue.length) {
        var cand = queue.shift();
        cand.queued = false;
        if (cand.want && !cand.canvas && !cand.rendering) { next = cand; break; }
      }
      if (!next) { settle(); return; }
      draining = true;
      renderItem(next).then(function () { draining = false; drain(); });
    }

    function enqueue(item) {
      if (paused || item.canvas || item.queued || item.rendering) return;
      item.queued = true;
      queue.push(item);
    }

    for (var i = 0; i < max; i++) {
      (function (idx) {
        var th = T.el("div", "pthumb" + (opts.clickable ? " clickable" : "") + (opts.draggable ? " grab" : ""));
        var pc = T.el("div", "pcanvas");
        th.appendChild(pc);
        var pn = T.el("span", "pn", "Page " + (idx + 1));
        th.appendChild(pn);
        var item = { index: idx, el: th, canvasWrap: pc, label: pn, rotation: 0, deleted: false, selected: false };
        items.push(item);
        grid.appendChild(th);
        if (opts.clickable && opts.onClick) {
          th.addEventListener("click", function (ev) {
            if (ev.target.closest(".pdel") || ev.target.closest(".prot")) return;
            opts.onClick(item);
          });
        }
        if (opts.reorderable) {
          var mvUp = T.el("button", "pmove pmove-up", "\u2191");
          mvUp.type = "button"; mvUp.title = "Move earlier";
          mvUp.addEventListener("click", function (ev) { ev.stopPropagation(); ctl.moveItem(item, -1); });
          var mvDn = T.el("button", "pmove pmove-dn", "\u2193");
          mvDn.type = "button"; mvDn.title = "Move later";
          mvDn.addEventListener("click", function (ev) { ev.stopPropagation(); ctl.moveItem(item, 1); });
          th.appendChild(mvUp); th.appendChild(mvDn);
        }
        if (opts.deletable) {
          var del = T.el("button", "pdel", "\u2715");
          del.type = "button";
          del.title = "Remove page";
          del.addEventListener("click", function () {
            item.deleted = !item.deleted;
            th.classList.toggle("deleted", item.deleted);
            del.title = item.deleted ? "Restore page" : "Remove page";
            if (opts.onChange) opts.onChange();
          });
          th.appendChild(del);
        }
      })(i);
    }

    /* Give every empty tile a portrait-ish placeholder height, measured ONCE off the real grid
       column width, so the scroll length of a 200-page grid is the same before and after its
       thumbnails exist and the observer bands mean what they say. */
    function sizePlaceholders() {
      var w = 0;
      for (var i = 0; i < items.length && !w; i++) w = items[i].canvasWrap.clientWidth;
      placeholderH = Math.round((w || THUMB_SIZE) * 1.414);
      items.forEach(function (it) { if (!it.canvas) it.canvasWrap.style.minHeight = placeholderH + "px"; });
    }

    var io = null, ioRelease = null;
    if (typeof IntersectionObserver !== "undefined" && items.length) {
      if (window.requestAnimationFrame) window.requestAnimationFrame(sizePlaceholders);
      else setTimeout(sizePlaceholders, 0);
      io = new IntersectionObserver(function (es) {
        observerFired = true;
        es.forEach(function (e) {
          var item = e.target.__thumbItem;
          if (!item || !e.isIntersecting) return;
          item.want = true;
          enqueue(item);
        });
        drain();
      }, { rootMargin: RENDER_MARGIN, threshold: 0 });
      ioRelease = new IntersectionObserver(function (es) {
        var gone = [];
        es.forEach(function (e) {
          var item = e.target.__thumbItem;
          if (!item || e.isIntersecting) return;
          item.want = false;
          if (item.canvas) gone.push(item);
        });
        if (!gone.length) return;
        var hs = gone.map(function (it) { return it.canvasWrap.offsetHeight; });  // read pass…
        gone.forEach(function (it, i) { releaseItem(it, hs[i]); });               // …then write pass
      }, { rootMargin: RELEASE_MARGIN, threshold: 0 });
      items.forEach(function (it) {
        it.el.__thumbItem = it;
        io.observe(it.el);
        ioRelease.observe(it.el);
      });
      /* A grid that is never visible (a hidden stage, a zero-height container) would otherwise
         leave ctl.rendered pending forever. */
      setTimeout(function () { observerFired = true; settle(); }, 2500);
    } else {
      // no IntersectionObserver: the original eager behaviour, unchanged
      observerFired = true;
      items.forEach(function (it) { it.want = true; enqueue(it); });
      drain();
    }

    /* MEANING CHANGED (design §2.3): ctl.rendered now resolves when the thumbnails that are
       currently in view have rendered — not when all of them have, because all of them no
       longer render. Callers awaiting "the grid is usable" still get that. */
    ctl.rendered = firstPass;

    /** Drop every thumbnail and stop rasterising new ones. Called when a job starts: the pixels
        on a config screen are pure retention while the export competes for the same memory.
        Reversible on purpose — a job that fails leaves the user on that same config screen, and
        it must not be a grid of empty boxes, so resume() puts the visible ones back. */
    ctl.release = function () {
      paused = true;
      queue.length = 0;
      items.forEach(function (it) {
        it.want = false; it.queued = false;
        releaseItem(it, placeholderH);
      });
    };
    ctl.resume = function () {
      if (!paused) return;
      paused = false;
      // re-observing forces a fresh intersection callback for whatever is on screen right now
      if (io && ioRelease) items.forEach(function (it) { io.unobserve(it.el); io.observe(it.el); });
      else { items.forEach(function (it) { it.want = true; enqueue(it); }); drain(); }
    };

    /* Reorder by one step. Works with a tap, so it is the only reorder path that exists on a
       phone (HTML5 drag-and-drop does not fire on touch). Same mutation as the drag handler. */
    ctl.moveItem = function (item, dir) {
      var from = items.indexOf(item), to = from + dir;
      if (from < 0 || to < 0 || to >= items.length) return;
      items.splice(from, 1);
      items.splice(to, 0, item);
      var ref = items[to + 1];
      if (ref) grid.insertBefore(item.el, ref.el); else grid.appendChild(item.el);
      renumber();
      if (opts.onChange) opts.onChange();
    };

    ctl.setSelected = function (indices) {
      var set = {};
      (indices || []).forEach(function (n) { set[n] = true; });
      items.forEach(function (it) {
        it.selected = !!set[it.index];
        it.el.classList.toggle("sel", it.selected);
      });
    };
    ctl.setRotation = function (item, deg) {
      item.rotation = ((deg % 360) + 360) % 360;
      // the transform is re-applied by renderItem if this tile's pixels are currently released
      applyRotation(item);
      var old = item.el.querySelector(".pbadge");
      if (old) old.remove();
      if (item.rotation !== 0) {
        var badge = T.el("span", "pbadge", item.rotation + "\u00B0");
        item.el.appendChild(badge);
      }
    };

    if (opts.draggable) {
      var dragFrom = null;
      items.forEach(function (item) {
        item.el.draggable = true;
        item.el.addEventListener("dragstart", function (ev) {
          dragFrom = item;
          item.el.classList.add("dragging");
          ev.dataTransfer.effectAllowed = "move";
          try { ev.dataTransfer.setData("text/plain", String(item.index)); } catch (e) {}
        });
        item.el.addEventListener("dragend", function () {
          item.el.classList.remove("dragging");
          items.forEach(function (it) { it.el.classList.remove("dragover"); });
        });
        item.el.addEventListener("dragover", function (ev) {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = "move";
          if (dragFrom && dragFrom !== item) item.el.classList.add("dragover");
        });
        item.el.addEventListener("dragleave", function () { item.el.classList.remove("dragover"); });
        item.el.addEventListener("drop", function (ev) {
          ev.preventDefault();
          item.el.classList.remove("dragover");
          if (!dragFrom || dragFrom === item) return;
          var fromPos = items.indexOf(dragFrom), toPos = items.indexOf(item);
          items.splice(fromPos, 1);
          items.splice(toPos, 0, dragFrom);
          grid.insertBefore(dragFrom.el, fromPos < toPos ? item.el.nextSibling : item.el);
          renumber();
          if (opts.onChange) opts.onChange();
        });
      });
    }
    function renumber() {
      items.forEach(function (it, pos) {
        it.label.textContent = "Page " + (it.index + 1) + (pos !== it.index ? " \u2192 " + (pos + 1) : "");
      });
    }
    ctl.renumber = renumber;
    return ctl;
  }

  /** Compact sorted page indices into a range string like "1-3, 5". */
  function compactRanges(indices) {
    var sorted = indices.slice().sort(function (a, b) { return a - b; });
    var parts = [], start = null, prev = null;
    sorted.forEach(function (n) {
      if (start === null) { start = n; prev = n; return; }
      if (n === prev + 1) { prev = n; return; }
      parts.push(start === prev ? String(start + 1) : (start + 1) + "-" + (prev + 1));
      start = n; prev = n;
    });
    if (start !== null) parts.push(start === prev ? String(start + 1) : (start + 1) + "-" + (prev + 1));
    return parts.join(", ");
  }

  /* ═══════════════ Tools ═══════════════ */

  /* ── merge-pdf ── */

  UBT.boot = boot;
  UBT.workbench = workbench;
  UBT.run = run;
  UBT.urun = urun;
  UBT.stIn = stIn;
  UBT.actionRow = actionRow;
  UBT.fld = fld;
  UBT.selectEl = selectEl;
  UBT.fileCard = fileCard;
  UBT.icBtn = icBtn;
  UBT.gripHandle = gripHandle;
  UBT.wireRowDrag = wireRowDrag;
  UBT.reorderHint = reorderHint;
  UBT.singlePdf = singlePdf;
  UBT.thumbGrid = thumbGrid;
  UBT.compactRanges = compactRanges;
  UBT.TOOL_OP = TOOL_OP;
})();
