/* =====================================================================================================
   Lowtide — js/main.js
   Everything on the page that is not the fluid itself. No dependencies, plain ES modules.

     fluid wiring      create the WebGL fluid (or fall back to the static page), feed it mouse + touch input
     smooth scroll     Lenis-style: wheel events move a target, the page eases toward it (lerp) every frame
     split text        headlines split into lines (for the line reveal) and statements into words
     GL text hand-off  after a headline's reveal plays, the fluid takes over drawing it (so it can distort)
     reveals           IntersectionObserver adds .is-in; CSS does the animation
     header + clock    hide on scroll down, show on scroll up; Dhaka time in the header/footer
     cursor            small lerped cursor with contextual labels ("View", "Stir") on fine pointers only
     page wipe         dark panel slides up before navigating to the other page; the preloader is shorter after it
     preloader         00 -> 100 counter while fonts + hero image load, then the page starts
     '+' markers       crosshair grid markers at section corners (a detail from the lusion.co recording)
     per-frame loop    ONE requestAnimationFrame: scroll -> word reveal -> header -> fluid.render(), in that order

   Fallbacks
     prefers-reduced-motion (or ?static in the URL): no fluid, no smooth scroll, no cursor, everything visible.
     Phones (UA or < 720px wide): lighter fluid settings, native scrolling, touch input feeds the fluid.
     No WebGL2 / no half-float render targets: body.no-gl, the DOM images and text simply show as normal.
   ===================================================================================================== */
import { createFluid } from './fluid.js';
// Tiny query helpers. reduced: the user asked the OS for less motion (or the page was opened with ?static).
// fine: a real mouse/trackpad (the custom cursor only makes sense there). isMobile: drives the lighter fluid settings.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || new URLSearchParams(location.search).has('static');
const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || innerWidth < 720;
// is-loading locks scrolling until the preloader finishes (see body.is-loading in style.css).
document.body.classList.add('is-loading');

/* ---------- fluid ---------- */
// manual: true -> the fluid does not run its own rAF; the single loop at the bottom of this file calls
// fluid.render() AFTER the smooth-scroll write, so GL quads are always placed at this frame's DOM position.
// Mobile: lower dpr and a 1/3 paint grid (it is a small screen, so 1/3 still costs little). Everything else follows
// the Lusion defaults — the brush rule max(40, width / 20) already gives a 40 px brush on a phone. These two values
// also become the phone's "defaults" inside the fluid, so the panel's reset / presets keep them.
// If createFluid throws (e.g. a shader fails to compile on an odd GPU) we log a warning and use the static page.
let fluid = null;
if (!reduced) {
  try {
    fluid = createFluid($('#gl'), isMobile
      ? { manual: true, dpr: Math.min(devicePixelRatio, 1.25), paintDiv: 3 }
      : { manual: true, dpr: Math.min(devicePixelRatio, 1.5) });
  } catch (e) { console.warn('fluid unavailable:', e.message); fluid = null; }
}
// Exposed for the console / gui.js: window.__fluid.set({ distort: 20 }), window.__fluid.stats().
window.__fluid = fluid;
if (!fluid) document.body.classList.add('no-gl');
else {
  // sub-frame samples: getCoalescedEvents gives every pointer position since the last frame, so a fast flick is a curve
  const move = (e) => { if (e.pointerType === 'touch') return; const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null; if (evs && evs.length) for (const ev of evs) fluid.pointer(ev.clientX, ev.clientY); else fluid.pointer(e.clientX, e.clientY); };
  window.addEventListener('pointermove', move, { passive: true });
  // A click starts a fresh stroke so the brush does not draw a straight line from wherever the pointer last was.
  window.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') { fluid.pointerLeave(); fluid.pointer(e.clientX, e.clientY); } }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => fluid.pointerLeave());
  // touch: a new finger starts a new stroke (no chord from the last lift point); moves carry velocity like the mouse.
  // Lusion's mobile rule: paint only while a finger is down AND moving (a resting finger has zero travel -> radius 0).
  // The third argument marks the stroke as touch, which turns scroll paint off (on a phone the finger is the scroll).
  window.addEventListener('touchstart', (e) => { const t = e.touches[0]; if (t) { fluid.pointerLeave(); fluid.pointer(t.clientX, t.clientY, true); } }, { passive: true });
  window.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (t) fluid.pointer(t.clientX, t.clientY, true); }, { passive: true });
  window.addEventListener('touchend', () => fluid.pointerLeave(), { passive: true });
  window.addEventListener('touchcancel', () => fluid.pointerLeave(), { passive: true });
  // tuning panel: ?gui (or #gui) loads lil-gui; press g to hide/show
  if (new URLSearchParams(location.search).has('gui') || location.hash === '#gui') import('./gui.js').then(m => m.mountGui(fluid)).catch(e => console.warn('gui failed to load:', e.message));
  // a little life on load: a slow sweep so the hero image stirs before the first move
  // Fake pointer path: 50 steps over ~0.8 s across the lower-middle of the viewport, starting 1.9 s after load.
  if (!isMobile) { setTimeout(() => { let i = 0; const sweep = setInterval(() => { const t = i / 50; fluid.pointer(innerWidth * (0.3 + 0.4 * t), innerHeight * (0.66 + Math.sin(t * 5) * 0.04)); if (++i > 50) { clearInterval(sweep); fluid.pointerLeave(); } }, 16); }, 1900); }
}

/* ---------- smooth scroll (Lenis-style: wheel → lerp → window.scrollTo) ---------- */
// How it works: the browser still owns the real scroll position (so anchors, scrollbars, find-in-page and
// position: sticky all work). We only intercept the wheel, add deltaY to `target`, and every frame move
// `current` 8.5% of the way toward it, writing it with window.scrollTo. Touch devices and reduced motion keep
// native scrolling (lerp = 1). If something else scrolls the page (scrollbar drag, keyboard, find-in-page),
// the scroll listener re-syncs target/current to the real position.
const scroller = (() => {
  let target = scrollY, current = scrollY, active = false, lastNative = scrollY;
  const lerp = isMobile || reduced ? 1 : 0.085;
  const max = () => document.documentElement.scrollHeight - innerHeight;
  function tick() {               // called from the single per-frame loop below, before the GL render, so quads never lag the DOM
    if (!active) return;
    current += (target - current) * lerp;
    if (Math.abs(target - current) < 0.3) { current = target; active = false; }
    window.scrollTo(0, current); lastNative = current;
  }
  function kick() { active = true; }
  if (!isMobile && !reduced) {
    window.addEventListener('wheel', (e) => {
      // ctrl+wheel = browser zoom, leave it alone. deltaMode 1 = lines, 2 = pages; normalise both to px.
      if (e.ctrlKey) return; e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY;
      target = Math.max(0, Math.min(max(), target + d)); kick();
    }, { passive: false });
    window.addEventListener('scroll', () => { if (!active && Math.abs(scrollY - lastNative) > 1) { target = current = scrollY; lastNative = scrollY; } }, { passive: true });
  }
  return { tick, to(y) { target = Math.max(0, Math.min(max(), y)); if (lerp === 1) window.scrollTo({ top: target, behavior: 'smooth' }); else kick(); }, sync() { target = current = scrollY; } };
})();
// In-page links (href="#work" etc.) scroll through the smooth scroller, leaving 40px of room above the target.
$$('[data-scroll]').forEach(a => a.addEventListener('click', (e) => {
  const id = a.getAttribute('href'); const el = id && id.length > 1 ? $(id) : null; if (!el) return;
  e.preventDefault(); scroller.to(el.getBoundingClientRect().top + scrollY - (id === '#top' ? 0 : 40)); history.replaceState(null, '', id);
}));

/* ---------- split text ---------- */
// splitLines: wrap every word in a span, read each word's offsetTop to find where the browser broke the lines,
// then rebuild as  <span class="line"><span style="--i:n">words…</span></span>.  The outer span clips
// (overflow: hidden) and the inner one slides up with a per-line delay from --i (see .reveal-lines in CSS).
// The original text is kept in el._raw so we can re-split on resize when the line breaks change.
function splitLines(el) {
  if (el._raw == null) el._raw = el.textContent;
  el.innerHTML = el._raw.split(' ').map(w => `<span class="wd">${w}</span>`).join(' ');
  const words = $$('.wd', el); const lines = []; let top = null;
  words.forEach(w => { if (w.offsetTop !== top) { top = w.offsetTop; lines.push([]); } lines[lines.length - 1].push(w.textContent); });
  el.innerHTML = lines.map((l, i) => `<span class="line"><span style="--i:${i}">${l.join(' ')}</span></span>`).join('');
}
// splitWords: one span per word, used by the scroll-driven statement (tickWords below).
function splitWords(el) {
  if (el._raw == null) el._raw = el.textContent;
  el.innerHTML = el._raw.split(' ').map(w => `<span class="w">${w}</span>`).join(' ');
}
const lineEls = $$('[data-split]'), wordEls = $$('[data-split-words]');
lineEls.forEach(splitLines); wordEls.forEach(splitWords);
// Width change -> line breaks may change -> re-split and ask the fluid to re-rasterise its GL headlines.
let rw = innerWidth; addEventListener('resize', () => { if (innerWidth !== rw) { rw = innerWidth; lineEls.forEach(splitLines); if (fluid) fluid.refreshText(); } });

/* ---------- GL text: hand a headline to the fluid once its line reveal has played (DOM keeps layout, GL draws the pixels) ---------- */
// The CSS reveal animates the DOM text first; 1.25 s later (when it has settled) we ask the fluid to rasterise
// the final layout and draw it in GL. From then on the visible headline is a texture the fluid can refract,
// while the DOM copy (now color: transparent) keeps layout, selection and accessibility.
function glText(el) {
  if (!fluid || !el.hasAttribute('data-gl-text') || el._gl) return; el._gl = true;
  setTimeout(() => { fluid.refreshText(); fluid.showText(el); }, reduced ? 0 : 1250);
}
/* ---------- reveals ---------- */
// Reveal anything with .reveal / .reveal-lines when ~12% of it is in view (a little before the bottom edge). Hero items wait for the preloader.
const io = new IntersectionObserver((es) => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('is-in'); glText(e.target); io.unobserve(e.target); } }), { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
const observeReveals = () => $$('.reveal, .reveal-lines').forEach(el => { if (!el.closest('.hero') || document.body.classList.contains('is-ready')) io.observe(el); });

/* word-by-word on scroll (statement blocks) */
// Each frame: progress p (0..1) of the statement through the viewport -> how many words are lit (.is-on).
function tickWords() {
  wordEls.forEach(el => {
    const r = el.getBoundingClientRect(); const p = Math.max(0, Math.min(1, (innerHeight * 0.85 - r.top) / (r.height + innerHeight * 0.35)));
    const ws = $$('.w', el); const n = Math.round(p * ws.length);
    ws.forEach((w, i) => w.classList.toggle('is-on', i < n || reduced));
  });
}

/* ---------- header hide/show + clock ---------- */
// Header hides when scrolling down past 120px and comes back on any upward scroll; gets a frosted background after 40px.
const header = $('#header'); let lastY = scrollY;
function tickHeader() { const y = scrollY; header.classList.toggle('is-hidden', y > lastY + 4 && y > 120); if (y < lastY - 4) header.classList.remove('is-hidden'); header.classList.toggle('is-scrolled', y > 40); lastY = y; }
function clock() { const t = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dhaka' }).format(new Date()); const a = $('#clock'), b = $('#clock2'); if (a) a.textContent = 'Dhaka ' + t; if (b) b.textContent = t; }
clock(); setInterval(clock, 30000);

/* ---------- cursor ---------- */
// Custom cursor (mouse/trackpad only). The dot follows the pointer with a 0.22 lerp in its own rAF.
// Over links it grows (.is-link); over GL images it says "Stir", over work cards "View".
if (fine && !reduced) {
  const c = $('#cursor'), label = $('.cursor__label', c); let x = innerWidth / 2, y = innerHeight / 2, cx = x, cy = y;
  window.addEventListener('pointermove', (e) => { x = e.clientX; y = e.clientY; document.body.classList.add('has-cursor'); const t = e.target && e.target.closest ? e.target.closest('a, button, [data-gl-image]') : null; c.classList.toggle('is-link', !!t); const l = t && t.hasAttribute('data-gl-image') ? 'Stir' : (t && t.classList.contains('work__link') ? 'View' : ''); label.textContent = l; c.classList.toggle('has-label', !!l); }, { passive: true });
  (function cur() { cx += (x - cx) * 0.22; cy += (y - cy) * 0.22; c.style.transform = `translate3d(${cx}px,${cy}px,0)`; requestAnimationFrame(cur); })();
}

/* ---------- page wipe on internal links ---------- */
// Internal links (data-link): slide the dark #wipe panel up (0.6 s), then navigate. A sessionStorage flag tells
// the next page to run a short 0.5 s preloader instead of the full 1.5 s one. Same-page hashes just scroll;
// cmd/ctrl-click is left to the browser (new tab).
const wipe = $('#wipe');
$$('a[data-link]').forEach(a => a.addEventListener('click', (e) => {
  const href = a.getAttribute('href'); if (!href || href.startsWith('#') || e.metaKey || e.ctrlKey) return;
  const [path, hash] = href.split('#'); const samePage = (location.pathname.split('/').pop() || 'index.html') === path;
  if (samePage && hash) { e.preventDefault(); const el = $('#' + hash); if (el) scroller.to(el.getBoundingClientRect().top + scrollY - 40); return; }
  e.preventDefault(); if (reduced) { location.href = href; return; }
  sessionStorage.setItem('lt-wipe', '1'); wipe.classList.add('is-in'); setTimeout(() => { location.href = href; }, 620);
}));

/* ---------- preloader ---------- */
// Preloader: the counter eases 00 -> 100 (ease-out cubic) over 1.5 s (0.5 s after a page wipe, 0 with reduced
// motion), then waits for web fonts + the hero image before start(): the preloader slides away, the fluid is
// enabled (images start their reveal), and the hero reveals play.
const pre = $('#preloader'), count = $('#count');
const fast = sessionStorage.getItem('lt-wipe') === '1'; sessionStorage.removeItem('lt-wipe');
const dur = reduced ? 0 : fast ? 500 : 1500;
const heroImg = $('.hero img'); const ready = Promise.all([document.fonts ? document.fonts.ready : 0, heroImg && !heroImg.complete ? new Promise(r => { heroImg.onload = heroImg.onerror = r; }) : 0]);
const t0 = performance.now();
(function tick() {
  const p = dur ? Math.min(1, (performance.now() - t0) / dur) : 1; const e = 1 - Math.pow(1 - p, 3);
  count.textContent = String(Math.round(e * 100)).padStart(2, '0');
  if (p < 1) requestAnimationFrame(tick); else ready.then(start);
})();
function start() {
  pre.classList.add('is-done'); document.body.classList.remove('is-loading'); document.body.classList.add('is-ready'); if (fluid) setTimeout(() => { fluid.enabled = true; }, 350);
  if (location.hash && $(location.hash)) { const el = $(location.hash); window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 40); scroller.sync(); }
  setTimeout(() => { $$('.hero .reveal, .hero .reveal-lines').forEach(el => { el.classList.add('is-in'); glText(el); }); observeReveals(); }, 120);
  setTimeout(() => pre.remove(), 1200);
}
// Reduced motion: show everything immediately, no reveals.
if (reduced) { $$('.reveal, .reveal-lines').forEach(el => el.classList.add('is-in')); }

/* ---------- '+' grid markers at section corners (the detail from the lusion recording) ---------- */
$$('.section:not(.marquee-wrap)').forEach((s, i, all) => { const corners = ['tl', 'tr']; if (i === all.length - 1) corners.push('bl', 'br'); corners.forEach(c => { const el = document.createElement('i'); el.className = 'plus plus--' + c; el.setAttribute('aria-hidden', 'true'); s.appendChild(el); }); });

/* ---------- per-frame ---------- */
// The ONE frame loop. Order matters: write the scroll position first, then everything that reads layout,
// and the fluid last so its DOM-synced quads use this frame's rects (no one-frame lag/jitter while scrolling).
(function raf(now) { requestAnimationFrame(raf); scroller.tick(); tickWords(); tickHeader(); if (fluid) fluid.render(now || performance.now()); })(performance.now());
// We restore hash positions ourselves in start(); the browser's own restoration would fight the smooth scroller.
history.scrollRestoration = 'manual';
