"use strict";
/* Split from all-tools.js (W0-6, 2026-08-18). Verbatim "merge-pdf" tool block, registered against
   core.js's shared prelude on window.UBT. TIER 2 (runtime-cached), loaded only on this
   tool's own page, after core.js. */
(function () {
  var UBT = window.UBT;
  var tool = UBT.tool;
  if (tool === "merge-pdf") UBT.boot(function setup() {
    var T = UBT.T, workbench = UBT.workbench, urun = UBT.urun, actionRow = UBT.actionRow, fileCard = UBT.fileCard, icBtn = UBT.icBtn, gripHandle = UBT.gripHandle, wireRowDrag = UBT.wireRowDrag, reorderHint = UBT.reorderHint;
    var wb = workbench({ multiple: true, dropLabel: "Drop 2 or more PDFs here, or ", hint: "You can reorder files after adding them" });
    wb.onRestart = setup;
    var files = [];
    var list = T.el("ul", "wb-files");
    var toolbar = T.el("div", "wb-toolbar");
    var addMore = T.el("button", "wb-add-more", "+ Add more PDFs");
    addMore.type = "button";
    var clearAll = T.btn("Clear all", "btn ghost sm");
    toolbar.appendChild(addMore);
    toolbar.appendChild(T.el("span", "spacer"));
    toolbar.appendChild(clearAll);
    var act = actionRow("Merge PDFs");
    wb.configEl.appendChild(list);
    wb.configEl.appendChild(reorderHint("Drag a file by its handle, or use the ↑ ↓ buttons, to set the merge order."));
    wb.configEl.appendChild(toolbar);
    wb.configEl.appendChild(act.row);

    var addInput = T.input({ type: "file", accept: ".pdf,application/pdf" });
    addInput.multiple = true;
    addInput.style.display = "none";
    wb.configEl.appendChild(addInput);
    addMore.onclick = function () { addInput.click(); };
    addInput.onchange = function () { if (addInput.files.length) wb.onFiles(Array.from(addInput.files)); addInput.value = ""; };
    clearAll.onclick = function () { files = []; render(); wb.showUpload(); };

    var dragCtx = { from: null };
    function render() {
      T.clear(list);
      files.forEach(function (e, i) {
        var up = icBtn("\u2191", "Move up", function () { if (i > 0) { files.splice(i - 1, 0, files.splice(i, 1)[0]); render(); } });
        var dn = icBtn("\u2193", "Move down", function () { if (i < files.length - 1) { files.splice(i + 1, 0, files.splice(i, 1)[0]); render(); } });
        var x = icBtn("\u2715", "Remove", function () { files.splice(i, 1); render(); if (!files.length) wb.showUpload(); });
        var li = fileCard(e, [up, dn, x]);
        li.insertBefore(gripHandle(), li.firstChild);
        wireRowDrag(li, i, files, render, dragCtx);
        if (e.thumb) {
          var ico = li.querySelector(".fico");
          T.clear(ico);
          e.thumb.style.width = "100%"; e.thumb.style.height = "100%";
          e.thumb.style.objectFit = "cover"; e.thumb.style.borderRadius = "8px";
          ico.appendChild(e.thumb);
          ico.style.background = "#fff";
          ico.style.border = "1px solid var(--line)";
        }
        list.appendChild(li);
      });
      var ok = files.filter(function (f) { return !f.bad && !f.loading; });
      var totalPages = ok.reduce(function (s, f) { return s + (f.pages || 0); }, 0);
      act.summ.textContent = files.length ? ok.length + " files \u00B7 " + T.pluralPages(totalPages) : "No files yet";
      act.go.disabled = ok.length < 2;
    }

    wb.onFiles = function (fl) {
      wb.showConfig();
      Array.from(fl).forEach(function (file) {
        var e = { name: file.name, size: file.size, buf: null, pages: null, bad: false, loading: true, err: null };
        files.push(e);
        render();
        file.arrayBuffer().then(function (b) {
          e.buf = b;
          return T.openPdfjs(b).then(function (pdf) {
            e.pages = pdf.numPages;
            e.loading = false;
            return T.renderThumb(pdf, 1, 40).then(function (c) { e.thumb = c; }).catch(function () {});
          });
        }).then(render).catch(function (err) {
          e.bad = true; e.loading = false;
          e.err = T.isEncryptedError(err) ? "Password-protected — unlock it first" : "Not a readable PDF";
          render();
        });
      });
    };

    act.go.onclick = urun(wb, act.go, function () {
      var ok0 = files.filter(function (f) { return !f.bad && !f.loading; });
      return {
        op: "multi-doc", cancel: "ITEM",
        input: { size: ok0.reduce(function (s, f) { return s + (f.size || 0); }, 0),
                 pages: ok0.reduce(function (s, f) { return s + (f.pages || 0); }, 0) }
      };
    }, async function (ctx) {
      var ok = files.filter(function (f) { return !f.bad && !f.loading; });
      var out = await PDFLib.PDFDocument.create();
      for (var i = 0; i < ok.length; i++) {
        await ctx.check();
        ctx.step(i + 1, ok.length, "Merging file");
        await T.yield_();
        var src = await T.loadPdf(ok[i].buf);
        var pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach(function (p) { out.addPage(p); });
        src = null;
      }
      ctx.pulse("Rebuilding the merged PDF");   // pdf-lib save(): one non-yielding pass, no counter exists
      var bytes = await out.save();
      ctx.note("bytesOut", bytes.length);
      /* The last gate before anything is handed over: a Stop pressed during the final
         iteration must not still produce a result. ctx.check() throws if it was. */
      await ctx.check();
      wb.showResult({
        bytes: bytes, filename: "merged.pdf", mime: "application/pdf", kind: "pdf",
        title: "PDFs merged",
        stats: [{ label: "files combined", value: String(ok.length) }, { label: "total pages", value: String(out.getPageCount()) }]
      });
    });
  });
})();
