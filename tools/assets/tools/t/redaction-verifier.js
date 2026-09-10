"use strict";
/* redaction-verifier (W5-E2, 2026-08-21) — drop ANY "redacted" PDF, from any tool, and find
   out whether the text is really gone.
   Registered against core.js's shared prelude on window.UBT. TIER 2 (runtime-cached).

   All detection is sites/tools/assets/redaction-audit.js; this file is intake, the per-page
   verdict surface, the reveal toggle and the report download.

   THE CLAIM, AND ITS LIMIT, IN THE SAME BREATH — every string this file shows says both:
     it detects text that is STILL PRESENT; it cannot see what was removed.
   A page with no findings is a page where nothing extractable was found under a mark. It is
   not proof that a redaction happened, and it is not proof that the document is safe. The
   engine ships that sentence in report.limitations so the UI cannot render a verdict without
   it, and this file prints it next to every verdict rather than on a page nobody scrolls to. */
(function () {
  var UBT = window.UBT;
  var tool = UBT.tool;
  if (tool === "redaction-verifier") UBT.boot(function setup() {
    var T = UBT.T, workbench = UBT.workbench, urun = UBT.urun, stIn = UBT.stIn,
      actionRow = UBT.actionRow, fld = UBT.fld, fileCard = UBT.fileCard, singlePdf = UBT.singlePdf;

    var enginePromise = null;
    function loadEngine() {
      if (enginePromise) return enginePromise;
      var seq = Promise.resolve();
      [
        ["pdf-textops.js", function () { return !!window.PDFTextOps; }],
        ["pdf-textedit.js", function () { return !!window.PDFTextEdit; }],
        ["redact-engine.js", function () { return !!window.UBRedact; }],
        ["redaction-audit.js", function () { return !!window.UBRedactAudit; }],
        ["stamp-engine.js", function () { return !!window.UBStamp; }]
      ].forEach(function (pair) {
        seq = seq.then(function () { return pair[1]() ? null : T.loadScript(T.BASE + pair[0]); });
      });
      enginePromise = seq.then(function () {
        if (!window.UBRedactAudit) throw new Error("Could not load the checking engine. Check your connection and try again.");
        return window.UBRedactAudit;
      });
      return enginePromise;
    }
    loadEngine().catch(function () {});

    var KIND_LABEL = {
      "text-under-cover": "Text under a filled box",
      "invisible-text": "Invisible text (rendering mode 3)",
      "hidden-layer-text": "Text in a hidden layer",
      "annotation-cover": "Text under an annotation"
    };

    function mask(s) {
      var n = String(s == null ? "" : s).length;
      return new Array(Math.min(n, 24) + 1).join("\u2022") + (n > 24 ? "\u2026" : "") + " (" + n + " characters)";
    }

    var wb = workbench({ hint: "Any PDF, from any tool — this checks what the file actually still contains" });
    wb.onRestart = setup;

    singlePdf(wb, function (st) {
      wb.showConfig();
      T.clear(wb.configEl);
      wb.configEl.appendChild(fileCard({ name: st.name, size: st.size, pages: st.pages }));

      var lead = T.el("p", "hint",
        "This looks for text that is still in the file: under a filled box, drawn invisibly, in a layer the document hides, or under an annotation. It detects text that is still present — it cannot see what was removed, and it cannot tell you whether a redaction was ever performed.");
      wb.configEl.appendChild(lead);

      var rangeIn = T.input({ type: "text", className: "txtin mono", value: "1-" + st.pages });
      wb.configEl.appendChild(fld("Pages to check", rangeIn));

      var act = actionRow("Check this document");
      wb.configEl.appendChild(act.row);

      function update() {
        var parsed = T.parseRanges(rangeIn.value, st.pages);
        act.summ.textContent = parsed.error ? parsed.error : "Checking " + T.pluralPages(parsed.indices.length);
        act.go.disabled = !!parsed.error;
      }
      rangeIn.addEventListener("input", update);
      update();

      act.go.onclick = urun(wb, act.go, { op: "structural", cancel: "PAGE", input: stIn(st) }, async function (ctx) {
        var Audit = await loadEngine();
        var parsed = T.parseRanges(rangeIn.value, st.pages);
        if (parsed.error) throw new Error(parsed.error);
        if (!parsed.indices.length) throw new Error("No pages selected — choose at least one page.");

        var report = await Audit.auditDocument(new Uint8Array(st.buf), {
          pages: parsed.indices,
          onPage: function (i, n) { ctx.step(i + 1, n, "Checking page"); },
          check: function () { return ctx.check(); }
        });
        await ctx.check();

        /* ── the verdict surface ── */
        var panel = T.el("div", "verifier-report");
        var revealed = false;

        var headline = T.el("p");
        headline.style.cssText = "font-weight:700;font-size:15px;margin:0 0 6px";
        headline.textContent = report.findings.length
          ? "Text is still present in this file."
          : report.verdict === "cannot-check"
            ? "No text was found under a mark on the pages that could be checked — and some pages could not be checked."
            : "No text was found under a mark on the pages checked.";
        panel.appendChild(headline);

        var caveat = T.el("p", "hint");
        caveat.textContent = "This detects text that is still present. It cannot see what was removed, so a clear result is not proof that a redaction was performed.";
        panel.appendChild(caveat);

        var pageList = T.el("ul", "verifier-pages");
        pageList.style.cssText = "list-style:none;padding:0;margin:12px 0";
        function renderPages() {
          T.clear(pageList);
          report.pages.forEach(function (pg) {
            var li = T.el("li");
            li.style.cssText = "padding:8px 0;border-top:1px solid var(--line)";
            var head = T.el("div");
            head.style.cssText = "font-weight:600;font-size:14px";
            head.textContent = "Page " + (pg.page + 1) + " — " + (
              pg.verdict === "text-found" ? pg.findings.length + " finding(s)" :
                pg.verdict === "cannot-check" ? "could not be fully checked" : "nothing found");
            li.appendChild(head);
            pg.findings.forEach(function (f) {
              var row = T.el("div", "hint");
              row.style.marginTop = "3px";
              var pos = f.rect ? " at x " + f.rect.x.toFixed(0) + ", y " + f.rect.top.toFixed(0) + " pt from the top-left" : "";
              row.textContent = (KIND_LABEL[f.kind] || f.kind) + pos + " · " + (revealed ? "“" + f.text + "”" : mask(f.text));
              li.appendChild(row);
              var why = T.el("div", "hint");
              why.style.cssText = "margin-top:2px;opacity:.8";
              why.textContent = f.note;
              li.appendChild(why);
            });
            pg.notes.forEach(function (n) {
              var nn = T.el("div", "hint");
              nn.style.marginTop = "3px";
              nn.textContent = n;
              li.appendChild(nn);
            });
            pageList.appendChild(li);
          });
        }
        renderPages();
        panel.appendChild(pageList);

        if (report.findings.length) {
          var toggle = T.btn("Show the text that was found", "btn ghost sm");
          toggle.onclick = function () {
            revealed = !revealed;
            toggle.textContent = revealed ? "Hide the text again" : "Show the text that was found";
            renderPages();
          };
          panel.appendChild(toggle);
          var warn = T.el("p", "hint");
          warn.textContent = "The text is hidden until you ask for it, so a shared screen does not do the leaking for you.";
          panel.appendChild(warn);
        }

        var limits = T.el("ul");
        limits.style.cssText = "margin:12px 0 0;padding-left:18px;font-size:12px;color:var(--ink2)";
        report.limitations.forEach(function (l) {
          var li2 = T.el("li");
          li2.textContent = l;
          limits.appendChild(li2);
        });
        panel.appendChild(limits);

        /* ── the downloadable report: masked unless the user revealed the text ── */
        var S = window.UBStamp;
        function buildCsv(includeText) {
          var rows = [["Page", "Finding", "X (pt from left)", "Y (pt from top)", "Text", "Note"]];
          report.pages.forEach(function (pg) {
            if (!pg.findings.length && !pg.notes.length) {
              rows.push([String(pg.page + 1), "nothing found", "", "", "", ""]);
              return;
            }
            pg.findings.forEach(function (f) {
              rows.push([
                String(f.page + 1), KIND_LABEL[f.kind] || f.kind,
                f.rect ? f.rect.x.toFixed(1) : "", f.rect ? f.rect.top.toFixed(1) : "",
                includeText ? f.text : mask(f.text), f.note
              ]);
            });
            pg.notes.forEach(function (n) { rows.push([String(pg.page + 1), "note", "", "", "", n]); });
          });
          report.limitations.forEach(function (l) { rows.push(["", "limitation", "", "", "", l]); });
          return new TextEncoder().encode(S ? S.csv(rows) : rows.map(function (r) { return r.join(","); }).join("\r\n"));
        }

        wb.showResult({
          bytes: buildCsv(false),
          filename: T.baseName(st.name) + "-redaction-check.csv",
          mime: "text/csv", kind: "text",
          title: report.findings.length ? "Text is still present" : "Nothing found under a mark",
          stats: [
            { label: "findings", value: String(report.findings.length) },
            { label: "pages checked", value: String(report.pages.length) },
            { label: "marks found", value: String(report.counts.covers) }
          ],
          note: panel,
          extraActions: report.findings.length ? [{
            label: "Download report WITH the text found",
            bytes: buildCsv(true),
            filename: T.baseName(st.name) + "-redaction-check-with-text.csv",
            mime: "text/csv"
          }] : []
        });
      });
    });
  });
})();
