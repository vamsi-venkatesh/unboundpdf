"use strict";
/* UnboundPDF — site chrome: nav, search, mobile menu */
(function () {
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function initNav() {
    var toggle = $(".nav-toggle");
    var menu = $(".nav-menu");
    if (toggle && menu) {
      toggle.addEventListener("click", function () {
        var open = menu.classList.toggle("open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
      document.addEventListener("click", function (ev) {
        if (!ev.target.closest(".nav-in")) {
          menu.classList.remove("open");
          toggle.setAttribute("aria-expanded", "false");
        }
      });
    }

    $$(".nav-dd > button").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var dd = btn.parentElement;
        var open = dd.classList.toggle("open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        $$(".nav-dd.open").forEach(function (other) {
          if (other !== dd) {
            other.classList.remove("open");
            var ob = other.querySelector("button");
            if (ob) ob.setAttribute("aria-expanded", "false");
          }
        });
      });
    });
  }

  function initSearch() {
    var input = $("#toolSearch");
    var grid = $("#allTools");
    if (!input || !grid) return;
    var cards = $$(".tool-card", grid);
    var cats = $$(".cat-section");
    var empty = $("#searchEmpty");

    function filter() {
      var q = input.value.trim().toLowerCase();
      var visible = 0;
      cards.forEach(function (card) {
        var name = (card.dataset.name || "").toLowerCase();
        var desc = (card.dataset.desc || "").toLowerCase();
        var match = !q || name.indexOf(q) >= 0 || desc.indexOf(q) >= 0;
        card.hidden = !match;
        if (match) visible++;
      });
      cats.forEach(function (sec) {
        var any = $$(".tool-card:not([hidden])", sec).length > 0;
        sec.hidden = !any && q.length > 0;
      });
      if (empty) empty.hidden = visible > 0 || !q;
    }

    input.addEventListener("input", filter);
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { input.value = ""; filter(); input.blur(); }
    });
  }

  function initSmoothHash() {
    $$('a[href^="#"]').forEach(function (a) {
      a.addEventListener("click", function (ev) {
        var id = a.getAttribute("href").slice(1);
        var target = document.getElementById(id);
        if (target) {
          ev.preventDefault();
          target.scrollIntoView({ behavior: "smooth", block: "start" });
          history.replaceState(null, "", "#" + id);
        }
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      initNav();
      initSearch();
      initSmoothHash();
    });
  } else {
    initNav();
    initSearch();
    initSmoothHash();
  }
})();




/* ── OFFLINE SERVICE WORKER — REGISTRATION (2026-08-13) ──────────────────────────────────────
   WHAT USED TO BE HERE: a loop that called `getRegistrations().unregister()` and deleted every
   cache key, on every single page load, enforcing the 2026-07-15 "no offline support" decision.
   That decision is reversed by founder order (P1-DESIGN §6). The loop is not merely obsolete —
   left in place it would unregister the new worker and wipe its caches on the very next load,
   forever. Retiring it is the load-bearing half of shipping offline; the identical loop in
   handoff.js (which the homepage loads instead of this file) is retired in the same change.

   Registration happens on FIRST INTERACTION, not at page load: a worker install races nothing
   important, but its shell precache (~1.2 MB) would otherwise compete with the tool's own engine
   download on the one load where the visitor is waiting. Any of these events means the visitor
   is here on purpose.

   The build stamp is read off THIS script's own <script src>, never hardcoded — a page can then
   only ever register the worker belonging to the build it is itself running. */
(function () {
  if (!("serviceWorker" in navigator)) return;
  if (window.__ubpSWWired) return;          /* site.js and handoff.js both load on a tool page */
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
    /* updateViaCache:"none" — the worker script must never be answered from the HTTP cache, or a
       deploy could sit behind a max-age and the version flip would never happen. */
    navigator.serviceWorker.register("/sw.js" + stamp, { scope: "/", updateViaCache: "none" })
      .catch(function () {});   /* no worker is a supported state, not an error to report */
  }
  for (var j = 0; j < events.length; j++) document.addEventListener(events[j], arm, true);
})();

/* ── SHARED SCROLL MOTION (2026-08-04) ──────────────────────────────────────────────
   This lived in hub.js, which ONLY the homepage loads — so all 33 tool pages had zero
   motion: their sections, their fold rows and their question rows never moved at all.
   It belongs here, in the file every page loads, and targets both section conventions
   (`.sec` on the hub, `.section` on tool pages).

   Never armed under prefers-reduced-motion: no classes, no properties, no progress bar,
   and every CSS fallback is the static state. Nothing here gates content — a page with
   JS off is simply visible. */
(function () {
  if (!window.matchMedia || !("IntersectionObserver" in window)) return;
  /* REDUCED MOTION IS "REDUCED", NOT "ABSENT" (fixed 2026-08-04 after the founder saw no motion
     at all on his iPhone). This used to return early and kill everything — reveals, ink, the
     progress bar — so anyone with iOS Settings ▸ Accessibility ▸ Motion ▸ Reduce Motion ON got a
     completely static page. The preference exists to stop VESTIBULAR motion: parallax drift,
     sliding, scaling. The accepted substitute (Apple HIG and the W3C note both say so) is a
     cross-fade. So under the preference we keep the arrival as opacity-only, keep the ink
     drawing (a small local mark, nothing travels), keep the progress bar, and drop exactly the
     things that move the viewport under you: drift, sheen sweep, translate/scale, the deal-out. */
  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.documentElement.classList.add(reduced ? "motion-reduced" : "motion-full");

  var secs = [].slice.call(document.querySelectorAll("main .sec, main .section"));
  if (secs.length) {
    /* TWO OBSERVERS (reveal / re-arm), different roots — and the reveal fires IN THE
       VIEWER'S EYES: negative bottom margin + a 5% ratio floor mean ~8% of the viewport is
       showing the section before the pop starts. History, because each rule was paid for:
       the old 20% PRE-arm made every pop complete below the fold on a slow desktop wheel
       scroll ("where is the motion?"); firing on isIntersecting popped the first section at
       page load over 8 visible pixels. Landing mid-pop on a fast flick is the intended feel
       now — the from-state is a visible .25, never a hole. RE-ARM stays on the real viewport
       at true ratio 0 (off-screen, so resetting is invisible) — that split is what makes
       replay work on every return. */
    var reveal = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        /* ratio, not isIntersecting: the initial observation fires with isIntersecting=true
           for even 8 visible pixels, which popped the first section AT LOAD — done before the
           founder's first wheel step. 5% showing = the pop happens in front of the eyes. */
        if (e.intersectionRatio >= 0.05) { e.target.classList.remove("pre"); e.target.classList.add("in"); }
      });
    }, { threshold: 0.05, rootMargin: "0px 0px -8% 0px" });
    var rearm = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.intersectionRatio === 0 && e.target.classList.contains("in")) {
          e.target.classList.remove("in"); e.target.classList.add("pre");
        }
      });
    }, { threshold: 0 });
    secs.forEach(function (s) {
      /* 1.25×viewport matches the expanded root: a section just below the fold is already
         inside the pre-trigger zone and must not be hidden first (arm-then-reveal flash). */
      if (s.getBoundingClientRect().top > innerHeight * 1.25) s.classList.add("pre");
      reveal.observe(s); rearm.observe(s);
    });
  }

  /* Ink: measure every stroked mark once, publish its true length, then let CSS draw it.
     Measured, never guessed — a dasharray shorter than its path leaves a mark permanently
     broken. Shapes that cannot be measured are left solid. */
  var shapes = document.querySelectorAll(".t-ic svg > *, .cat-ic svg > *, .hero-ic svg > *");
  var measured = 0;
  [].forEach.call(shapes, function (s) {
    var len = typeof s.getTotalLength === "function" ? s.getTotalLength() : 0;
    if (len > 0) { s.style.setProperty("--len", len.toFixed(1)); measured++; }
  });
  if (measured) document.documentElement.classList.add("ink-armed");

  /* Reading progress + per-section light sweep, from ONE rAF-coalesced passive listener
     writing only custom properties. No layout writes, so nothing can shift. */
  var prog = document.createElement("div");
  prog.className = "prog"; prog.setAttribute("aria-hidden", "true");
  document.body.appendChild(prog);
  var queued = false;
  /* Clamped to one viewport traversal: unbounded, an element far above the fold keeps
     accumulating (measured +79px) and can drift into its neighbour. */
  var clamp = function (r) {
    return Math.max(-1, Math.min(1, (r.top + r.height / 2 - innerHeight / 2) / innerHeight));
  };
  /* Homepage-only parallax target; null on tool pages, so the loop simply skips it.
     (The numeral-watermark drift died 2026-08-04 with the watermarks — founder order.) */
  var shot = document.querySelector(".ed-shot");
  function frame() {
    queued = false;
    var span = document.documentElement.scrollHeight - innerHeight;
    prog.style.setProperty("--p", span > 0 ? Math.min(1, Math.max(0, scrollY / span)).toFixed(4) : "0");
    if (reduced) return; /* progress only — everything below MOVES, which is the point of the preference */
    secs.forEach(function (g) { g.style.setProperty("--sheen", ((1 - clamp(g.getBoundingClientRect())) / 2).toFixed(3)); });
    if (shot) shot.style.setProperty("--shot-y", (clamp(shot.getBoundingClientRect()) * -28).toFixed(1) + "px");
  }
  var request = function () { if (!queued) { queued = true; requestAnimationFrame(frame); } };
  addEventListener("scroll", request, { passive: true });
  addEventListener("resize", request, { passive: true });
  frame();
})();
