/* One-shot file handoff: homepage drop -> tool page.
   IndexedDB, not sessionStorage, which would force the whole document through a base64
   string copy. Same-origin and client-only — these bytes never touch the network, which is
   the entire promise of the product.
   Consumed once and deleted immediately, and ignored if stale, so a document from an
   earlier session can never resurface in a later tab.

   WE STORE BYTES, NOT THE `File` OBJECT (fixed 2026-07-20).
   This file used to say "a File survives there as-is". That is true in Chrome and Firefox
   and FALSE IN WEBKIT: `put(File)` rejects on iOS Safari. The failure was swallowed by the
   caller's try/catch, so `carried` stayed false, no `?from=drop` marker was added, and every
   iPhone visitor who dropped a document on the homepage was asked to upload it a second time
   on the tool page — silently, with a clean console, on the one platform the desktop tests
   never covered. A structured-clonable {buf,name,type} works on every engine; the File is
   rebuilt on the other side. */
(function (g) {
  var DB = "unboundpdf", STORE = "handoff", KEY = "pending", MAX_AGE = 5 * 60 * 1000;

  function openDb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }

  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
        t.oncomplete = function () { db.close(); res(req ? req.result : null); };
        t.onerror = function () { db.close(); rej(t.error); };
        t.onabort = function () { db.close(); rej(t.error); };
      });
    });
  }

  g.UnboundHandoff = {
    /* Store the dropped file, then send the visitor to the tool they picked. */
    put: function (file) {
      try {
        return file.arrayBuffer().then(function (buf) {
          return tx("readwrite", function (s) {
            return s.put({ buf: buf, name: file.name, type: file.type || "application/pdf", at: Date.now() }, KEY);
          });
        });
      } catch (e) { return Promise.reject(e); }
    },
    /* Take it exactly once. Returns null rather than throwing — a failed handoff must
       degrade to a normal empty dropzone, never to a broken tool. */
    take: function () {
      try {
        return tx("readwrite", function (s) { var r = s.get(KEY); s.delete(KEY); return r; })
          .then(function (rec) {
            if (!rec) return null;
            if (Date.now() - rec.at > MAX_AGE) return null;
            if (rec.buf) return new File([rec.buf], rec.name || "document.pdf", { type: rec.type || "application/pdf" });
            return rec.file || null; // record written by an older build
          })
          .catch(function () { return null; });
      } catch (e) { return Promise.resolve(null); }
    }
  };

  /* This script loads on every page, take() only on a tool page reached via
     ?from=drop — so a visitor who drops a file on the homepage and never opens
     a tool leaves it stale in IndexedDB with nothing to ever clean it up.
     Sweep once per load: get, then delete only if it's past MAX_AGE, both
     inside one readwrite transaction so a fresh record (still eligible for
     take()) can never be caught mid-check and removed out from under it.
     Silent and best-effort — private mode / no IndexedDB just means nothing
     to sweep, not an error. */
  (function sweep() {
    try {
      tx("readwrite", function (s) {
        var r = s.get(KEY);
        r.onsuccess = function () {
          var rec = r.result;
          if (rec && Date.now() - rec.at > MAX_AGE) s.delete(KEY);
        };
        return null;
      }).catch(function () {});
    } catch (e) {}
  })();
})(window);


/* ── WORKSPACE ROUND TRIP — "Return to Workspace" (WS-3, 2026-08-20) ─────────────────────
   ADDITIVE ONLY. This file loads on every page already (see the service-worker block below
   for why), so this is the one place a small, page-agnostic addition reaches every tool
   page without editing any of them individually — editor.js, redact-pdf.js, core.js, and
   every other tool module are UNTOUCHED by this feature.

   /workspace/'s "Open in <Tool>" action (workspace.js) puts the active document through
   UnboundHandoff.put() above, then navigates here with ?wsreturn=<docId>&wstool=<slug>
   alongside the ?from=drop the existing take() path already claims. When that query param
   is present, this block shows a small floating button. It stays disabled until the tool
   page's OWN result exists — read from window.__wbResult, the SAME hook every
   workbench-driven tool already sets on a successful run (pdf-engine.js's resultScreen(),
   called by core.js for every ordinary tool AND directly by editor.js at its own result
   stage — see editor.js's own T.resultScreen() call, which is what powers pdf-editor,
   fill-sign and sign-pdf alike). Clicking it hands the result back through the exact same
   UnboundHandoff store and returns to /workspace/, which reads it there (processHandoffReturn
   in workspace.js) and folds it into the document's chain as one real step.

   v153.2 (founder, live): the button used to stay DISABLED with no cue until a Save produced
   window.__wbResult — on the PDF Editor (and its siblings fill-sign/sign-pdf, all built on
   editor.js) that meant clicking "Return to Workspace" before pressing the tool's OWN Save
   button did nothing, and nothing on screen said why. Where the tool exposes its own save
   control (editor.js's `.ed-save` — Save PDF / Sign & Download, shared by pdf-editor,
   fill-sign and sign-pdf), the button now starts ENABLED and drives that save itself on
   click, then returns once the result lands. Tools with no such hook (redact-pdf's own
   in-page Apply flow, at minimum) keep the original disabled-until-result behaviour — this
   file still cannot know how to trigger an arbitrary tool's own apply action. */
(function () {
  var params;
  try { params = new URL(window.location.href).searchParams; } catch (e) { return; }
  var wsReturn = params.get("wsreturn");
  if (!wsReturn) return;
  var wsTool = params.get("wstool") || (document.body && document.body.getAttribute("data-tool")) || "tool";

  function mount() {
    if (!document.body) { setTimeout(mount, 50); return; }
    /* NEVER on the workspace page itself (2026-08-21, found while driving the redesigned
       /workspace/): the RETURN leg lands back on /workspace/?wsreturn=…&wstool=…, and this
       block — which only reads the query string — mounted a permanently-disabled "Return to
       Workspace" button over the workspace's own footer. workspace.js strips those params
       moments later via history.replaceState, but that is AFTER this deferred script has
       already run, so the button stayed. It is a tool-page affordance; the workspace is where
       it returns TO, so the page that carries data-workspace never needs it. */
    if (document.body.getAttribute("data-workspace") != null) return;

    var mobileQuery = window.matchMedia ? window.matchMedia("(max-width: 720px)") : null;
    function isMobileReturn() { return !!(mobileQuery && mobileQuery.matches); }
    var mobileReturn = isMobileReturn();
    var wrap = document.createElement("div");
    wrap.id = "wsReturnWrap";
    wrap.style.cssText = mobileReturn
      ? "position:fixed;left:8px;right:8px;top:8px;z-index:99999;display:flex;" +
        "flex-direction:column;align-items:stretch;gap:6px;max-width:none;box-sizing:border-box;"
      : "position:fixed;right:16px;bottom:16px;z-index:99999;display:flex;" +
        "flex-direction:column;align-items:flex-end;gap:6px;max-width:280px;";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "wsReturnBtn";
    btn.style.cssText = "padding:10px 16px;border-radius:8px;border:1px solid #17171A;background:#17171A;" +
      "color:#fff;font:600 14px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.18);white-space:nowrap;" +
      (mobileReturn ? "width:100%;min-height:44px;" : "");

    /* the "nothing happened" cue: a short-lived note when an attempted save produced no
       result within 10s (no edits made yet, most likely). */
    var note = document.createElement("div");
    note.id = "wsReturnNote";
    note.hidden = true;
    note.style.cssText = "font:600 11.5px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;color:#9A4B12;" +
      "background:#FDF1E2;border:1px solid #EBD9B4;padding:4px 8px;border-radius:6px;text-align:right;";

    var caption = document.createElement("div");
    caption.id = "wsReturnCaption";
    caption.textContent = "Your result goes back to the Workspace as a new copy.";
    caption.style.cssText = "font:500 11.5px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;color:#5B5B63;" +
      "background:rgba(255,255,255,.9);padding:2px 4px;border-radius:4px;text-align:right;" +
      (mobileReturn ? "display:none;" : "");

    wrap.appendChild(btn);
    wrap.appendChild(note);
    wrap.appendChild(caption);
    document.body.appendChild(wrap);

    function saveHook() { return document.querySelector(".ed-save"); }
    function hasResult() { return !!(window.__wbResult && window.__wbResult.bytes); }

    /* The editor's own phone chrome owns the bottom of the viewport: its 5-slot dock at
       rest, and Format/Done while typing. A second fixed footer necessarily covered those
       controls. Put this action in normal document flow immediately BEFORE the editor's
       wb-stage, not inside it: Save hides that stage and reveals its result-stage sibling.
       The shared #toolUI host remains visible across both states, so Return is never lost
       at the exact moment a result becomes ready. */
    function placeReturn() {
      var onPhone = isMobileReturn();
      btn.style.width = onPhone ? "100%" : "auto";
      btn.style.minHeight = onPhone ? "44px" : "";
      caption.style.display = onPhone ? "none" : "";
      if (!onPhone) {
        if (wrap.parentNode !== document.body) document.body.appendChild(wrap);
        wrap.style.cssText = "position:fixed;left:auto;right:16px;top:auto;bottom:16px;z-index:99999;display:flex;" +
          "flex-direction:column;align-items:flex-end;gap:6px;width:auto;max-width:280px;padding:0;" +
          "box-sizing:border-box;background:transparent;border:0;";
        wrap.removeAttribute("data-mobile-flow");
        return;
      }
      var editorRoot = document.querySelector(".ed-root");
      if (editorRoot && editorRoot.parentNode) {
        var editorStage = editorRoot.parentNode;
        var toolHost = editorStage.closest && editorStage.closest("#toolUI");
        if (toolHost && editorStage.parentNode === toolHost) {
          if (wrap.parentNode !== toolHost || wrap.nextSibling !== editorStage) toolHost.insertBefore(wrap, editorStage);
          wrap.style.cssText = "position:relative;left:auto;right:auto;top:auto;bottom:auto;z-index:1;" +
            "display:flex;flex-direction:column;align-items:stretch;gap:6px;width:100%;max-width:none;" +
            "box-sizing:border-box;padding:8px 10px;background:#fff;border-bottom:1px solid rgba(23,23,26,.14);";
          wrap.setAttribute("data-mobile-flow", "true");
          return;
        }
      }
      /* Non-editor tools keep the compact floating affordance they already had. */
      if (wrap.parentNode !== document.body) document.body.appendChild(wrap);
      wrap.style.cssText = "position:fixed;left:8px;right:8px;top:8px;bottom:auto;z-index:99999;display:flex;" +
        "flex-direction:column;align-items:stretch;gap:6px;width:auto;max-width:none;padding:0;" +
        "box-sizing:border-box;background:transparent;border:0;";
      wrap.removeAttribute("data-mobile-flow");
    }

    var awaitingSave = false, saveTimer = null;

    function renderIdle() {
      note.hidden = true;
      if (saveHook()) {
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.textContent = "Save and return to Workspace";
        btn.title = "Save this result, then send it back to the Workspace chain";
      } else {
        btn.disabled = true;
        btn.style.opacity = ".55";
        btn.textContent = "Return to Workspace";
        btn.title = "Finish this tool's result first";
      }
    }
    function renderReady() {
      note.hidden = true;
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.textContent = "Return to Workspace";
      btn.title = "Send this result back to the Workspace chain";
    }
    function refresh() {
      /* Re-read the media query every pass: phone rotation and responsive QA can cross the
         breakpoint after mount. Both directions restore the appropriate parent + geometry. */
      placeReturn();
      if (awaitingSave) return; // mid auto-save — leave the "Saving…" state alone
      if (hasResult()) renderReady(); else renderIdle();
    }
    var poll = setInterval(refresh, 400);
    refresh();

    function doReturn() {
      if (!hasResult() || !window.UnboundHandoff) return;
      clearInterval(poll);
      btn.disabled = true;
      btn.textContent = "Returning…";
      var r = window.__wbResult;
      var file;
      try { file = new File([r.bytes], r.filename || "result.pdf", { type: "application/pdf" }); }
      catch (e) { btn.disabled = false; renderReady(); poll = setInterval(refresh, 400); return; }
      window.UnboundHandoff.put(file).then(function () {
        var u = new URL(window.location.origin + "/workspace/");
        u.searchParams.set("wsreturn", wsReturn);
        u.searchParams.set("wstool", wsTool);
        window.location.href = u.toString();
      }).catch(function () {
        btn.disabled = false;
        renderReady();
        poll = setInterval(refresh, 400);
      });
    }

    btn.addEventListener("click", function () {
      if (hasResult()) { doReturn(); return; }
      var hook = saveHook();
      if (!hook) return; // disabled in this state — nothing this file knows how to trigger
      awaitingSave = true;
      note.hidden = true;
      btn.disabled = true;
      btn.textContent = "Saving…";
      try { hook.click(); } catch (e) {}
      var waited = 0;
      clearTimeout(saveTimer);
      (function pollSave() {
        if (hasResult()) { awaitingSave = false; doReturn(); return; }
        waited += 300;
        if (waited >= 10000) {
          awaitingSave = false;
          btn.disabled = false;
          btn.style.opacity = "1";
          btn.textContent = "Save and return to Workspace";
          btn.title = "Save this result, then send it back to the Workspace chain";
          note.textContent = "Nothing saved yet — make an edit, then save.";
          note.hidden = false;
          return;
        }
        saveTimer = setTimeout(pollSave, 300);
      })();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();


/* ── OFFLINE SERVICE WORKER — REGISTRATION (2026-08-13) ──────────────────────────────────────
   WHAT USED TO BE HERE: the twin of site.js's unregister-and-wipe loop, enforcing the
   2026-07-15 "no offline support" decision on every page load. Reversed by founder order
   (P1-DESIGN §6). This file, not site.js, is the one the HOMEPAGE loads, which is why the
   registration has to live in both — between them every page is covered, and the
   `__ubpSWWired` flag means a tool page that loads both registers exactly once.

   Rationale for the shape (first interaction, stamp read from the page, updateViaCache:"none")
   is documented once, in site.js. Keep the two copies identical. */
(function () {
  if (!("serviceWorker" in navigator)) return;
  if (window.__ubpSWWired) return;
  window.__ubpSWWired = true;

  var stamp = "";
  try {
    var src = (document.currentScript && document.currentScript.src) || "";
    var m = src.match(/\?v=(\d+)/);
    if (!m) {
      var all = document.querySelectorAll('script[src*="/tools/assets/"],link[href*="/tools/assets/"]');
      for (var i = 0; i < all.length && !m; i++) {
        m = String(all[i].src || all[i].href).match(/\?v=(\d+)/);
      }
    }
    if (m) stamp = "?v=" + m[1];
  } catch (e) {}

  var events = ["pointerdown", "keydown", "touchstart", "drop", "change"];
  function arm() {
    for (var i = 0; i < events.length; i++) document.removeEventListener(events[i], arm, true);
    navigator.serviceWorker.register("/sw.js" + stamp, { scope: "/", updateViaCache: "none" })
      .catch(function () {});
  }
  for (var j = 0; j < events.length; j++) document.addEventListener(events[j], arm, true);
})();
