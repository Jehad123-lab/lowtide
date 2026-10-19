/* =====================================================================================================
   Lowtide — js/gui.js
   Live tuning panel for the fluid, built with lil-gui (https://lil-gui.georgealways.com/).
   Only loaded when the page is opened with ?gui or #gui (main.js does a dynamic import), so normal visitors
   never download it. lil-gui itself comes from a CDN at that moment — the site stays dependency-free.

   Every control writes straight into fluid.options through fluid.set(), so changes are instant.
   "copy settings JSON" gives you the current values to paste into createFluid(canvas, { ... }) or into
   Framer property-control defaults. Press "g" to hide/show the panel. Collapsed by default on phones.

   Presets and "reset" go back to fluid.defaults, which already carries the device's quality (a phone keeps its
   1/3 paint grid and dpr 1.25 instead of jumping to the desktop's 1/4 grid). Presets never set Quality keys.
   ===================================================================================================== */
export async function mountGui(fluid) {
  if (!fluid) { console.warn('gui: no fluid (reduced motion or no WebGL)'); return null; }
  const { GUI } = await import('https://cdn.jsdelivr.net/npm/lil-gui@0.19/+esm');
  const gui = new GUI({ title: 'Lowtide fluid', width: Math.min(320, innerWidth - 16) });
  // o: the live options object (lil-gui binds to its keys). D: the defaults, for reset / presets.
  // add(folder, key, min, max, step): a slider that calls fluid.set({ key: value }) on change; .listen() keeps it
  // in sync when values are changed elsewhere (presets, paste JSON).
  const o = fluid.options, D = fluid.defaults;
  const set = (k) => (v) => fluid.set({ [k]: v });
  const add = (f, k, a, b, st) => f.add(o, k, a, b, st).onChange(set(k)).listen();

  // Presets are applied on top of the defaults ({ ...D, ...preset }), so an empty object = the default look.
  //   Lusion          the numbers measured in the "Lusion.co Decoded" handbook (= DEFAULTS in fluid.js)
  //   Lusion + glass  same field, plus our glass extras from v3 (rim refraction, chroma split, body tint, highlight, holo rim)
  //   Subtle (round 2) a smaller, gentler stroke with the round-2 glass look
  //   Bold            bigger brush, longer tail, stronger drag
  //   Ink-free glass  glass body + refraction, no colour at all (no fringe, no holo rim)
  const glass = { refract: 24, chroma: 0.3, rim: 0.10, bodyStrength: 1.0, highlight: 0.06 };
  const presets = {
    'Lusion': {},
    'Lusion + glass': { ...glass },
    'Subtle (round 2)': { ...glass, brushVw: 0, brushRadius: 38, brushMin: 8, pushStrength: 10, dissW1: 0.96, distort: 22, blur: 18, fringe: 4, noise: 1.5 },
    'Bold': { ...glass, brushVw: 14, brushRadius: 90, brushMin: 10, pushStrength: 35, dissV: 0.98, dissW1: 0.965, distort: 95, blur: 85, fringe: 18, rim: 0.16, refract: 40, highlight: 0.12 },
    'Ink-free glass': { ...glass, rim: 0.0, rgbShift: 0.0, fringe: 0, bodyStrength: 1.3, highlight: 0.1 },
  };
  // Quality keys stay as the device set them, whatever a preset says (pasted JSON may still change them on purpose).
  const QUALITY = ['dpr', 'paintDiv', 'lowDiv', 'float8'];
  const keepQuality = (q) => { const out = { ...q }; for (const k of QUALITY) out[k] = o[k]; return out; };
  const state = { preset: 'Lusion' };
  gui.add(state, 'preset', Object.keys(presets)).name('preset').onChange((p) => { fluid.set(keepQuality({ ...D, ...presets[p] })); refresh(); });

  // Brush: max radius = max(radius floor, viewport width ÷ "viewport ÷"), radius grows with pointer travel per frame
  // up to "full radius at px/frame"; a still pointer paints nothing. Velocity: gain + momentum (leaky integrator).
  const fb = gui.addFolder('Brush');
  add(fb, 'brushRadius', 4, 200, 1).name('max radius floor px');
  add(fb, 'brushVw', 0, 60, 1).name('max radius = width ÷ (0 off)');
  add(fb, 'brushMin', 0, 80, 1).name('radius (slowest) px');
  add(fb, 'speedFull', 5, 200, 1).name('full radius at px/frame');
  add(fb, 'brushVel', 0, 3, 0.01).name('velocity gain');
  add(fb, 'brushAccel', 0, 0.98, 0.01).name('velocity momentum');
  add(fb, 'brushSoft', 0, 1, 0.01).name('edge softness');
  add(fb, 'segmentsPerFrame', 1, 8, 1).name('sub-frame segments');
  // Scroll paint: how much scrolling with a still mouse paints (0 = off). The trail always sticks to the page.
  add(fb, 'scrollPaint', 0, 3, 0.01).name('scroll paint amount');

  // Field: how the painted velocity spreads (self-advection + blur) and how fast each channel fades.
  const ff = gui.addFolder('Field (spread & decay)');
  add(ff, 'pushStrength', 0, 80, 0.5).name('spread / push (texels)');
  add(ff, 'blurRadius', 0, 16, 0.5).name('spread blur radius');
  add(ff, 'blurPasses', 0, 4, 1).name('spread blur passes');
  add(ff, 'dissV', 0.9, 0.999, 0.001).name('velocity dissipation');
  add(ff, 'dissW1', 0.8, 0.999, 0.001).name('tail dissipation');
  add(ff, 'dissW2', 0.3, 0.99, 0.001).name('head dissipation');
  add(ff, 'floorW', 0, 0.02, 0.0005).name('weight floor / frame');
  add(ff, 'noise', 0, 10, 0.05).name('curl noise strength');
  add(ff, 'noiseScale', 0.002, 0.1, 0.001).name('curl noise scale');

  // Distortion: how far the post pass drags the page, text and images, and the colour fringes.
  const fd = gui.addFolder('Distortion (post)');
  add(fd, 'distort', 0, 200, 1).name('drag px × velocity');
  add(fd, 'domDistort', 0, 3, 0.01).name('DOM (text/img) amount');
  add(fd, 'blur', 0, 200, 1).name('blur length px');
  add(fd, 'jitter', 0, 2, 0.01).name('tap jitter');
  add(fd, 'rgbShift', 0, 2, 0.01).name('RGB shift (phase)');
  add(fd, 'fringe', 0, 40, 0.1).name('oil fringe strength');
  add(fd, 'refract', 0, 120, 1).name('rim refraction (glass)');
  add(fd, 'chroma', 0, 1, 0.01).name('chromatic split (glass)');

  // Look: the glassy body tint, highlight and holographic rim bands.
  const fl = gui.addFolder('Look');
  add(fl, 'rim', 0, 0.4, 0.005).name('holographic rim');
  add(fl, 'bands', 2, 40, 0.5).name('rim band count');
  fl.addColor(o, 'bodyTint', 1).name('body tint').onChange(set('bodyTint')).listen();
  add(fl, 'bodyStrength', 0, 2, 0.01).name('body strength');
  add(fl, 'highlight', 0, 0.4, 0.005).name('highlight');

  // Quality: grid sizes and canvas resolution. Changing any of these rebuilds the render targets.
  const fq = gui.addFolder('Quality');
  add(fq, 'paintDiv', 1, 8, 1).name('paint grid (÷ screen)');
  add(fq, 'lowDiv', 2, 16, 1).name('blur grid (÷ screen)');
  add(fq, 'dpr', 0.5, 3, 0.05).name('canvas dpr');
  // 8-bit = Lusion's RGBA8 targets (velocity biased at 0.5). Half-float is the default: smoother fades, same look.
  // Greyed out (forced on) when the GPU cannot render to half-float.
  const c8 = fq.add(o, 'float8').name('8-bit paint (Lusion)').onChange(set('float8')).listen();
  if (!fluid.halfFloat) c8.disable();
  fq.close();

  // Buttons: reset, copy the current settings as JSON (clipboard, or a prompt if clipboard is blocked), paste JSON back in.
  const actions = {
    reset() { fluid.set({ ...D }); state.preset = 'Lusion'; refresh(); },   // D already holds this device's quality
    async copyJSON() {
      const txt = JSON.stringify(fluid.settings(), null, 2);
      try { await navigator.clipboard.writeText(txt); toast('settings copied'); } catch { window.prompt('copy your settings:', txt); }
      console.log('fluid settings', txt);
    },
    pasteJSON() { const txt = window.prompt('paste settings JSON:'); if (!txt) return; try { fluid.set(JSON.parse(txt)); refresh(); toast('applied'); } catch (e) { toast('bad JSON'); } },
  };
  gui.add(actions, 'reset').name('reset to defaults');
  gui.add(actions, 'copyJSON').name('copy settings JSON');
  gui.add(actions, 'pasteJSON').name('paste settings JSON');

  function refresh() { gui.controllersRecursive().forEach(c => c.updateDisplay()); }
  function toast(t) { const el = document.createElement('div'); el.textContent = t; el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#171717;color:#fff;font:12px/1 Geist Mono,monospace;padding:10px 14px;border-radius:999px;z-index:1000'; document.body.appendChild(el); setTimeout(() => el.remove(), 1400); }

  gui.domElement.style.zIndex = 900;
  if (innerWidth < 720) gui.close();
  // "g" toggles the panel (ignored while typing in an input and with cmd/ctrl held).
  addEventListener('keydown', (e) => { if (e.key === 'g' && !e.metaKey && !e.ctrlKey && !/input|textarea/i.test(document.activeElement?.tagName || '')) gui.show(gui._hidden); });
  window.__gui = gui;
  return gui;
}
