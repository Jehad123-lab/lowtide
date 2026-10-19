/* =====================================================================================================
   Lowtide — js/gui.js
   Live tuning panel for the fluid, built with lil-gui (https://lil-gui.georgealways.com/).
   Only loaded when the page is opened with ?gui or #gui (main.js does a dynamic import), so normal visitors
   never download it. lil-gui itself comes from a CDN at that moment — the site stays dependency-free.

   Every control writes straight into fluid.options through fluid.set(), so changes are instant.
   "copy settings JSON" gives you the current values to paste into createFluid(canvas, { ... }) or into
   Framer property-control defaults. Press "g" to hide/show the panel. Collapsed by default on phones.
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

  // Presets are applied on top of the defaults ({ ...D, ...preset }), so an empty object = the default (Lusion-like) look.
  const presets = {
    'Lusion': {},
    'Subtle (round 2)': { brushMin: 12, brushRadius: 38, brushVel: 0.55, pushStrength: 0.3, distort: 2.4, blur: 0.9, refract: 24, rim: 0.10, noise: 0.25 },
    'Bold': { brushMin: 20, brushRadius: 90, brushVel: 0.8, pushStrength: 1.6, distort: 18, blur: 4, refract: 40, rim: 0.16, highlight: 0.12, dissW1: 0.993 },
    'Ink-free glass': { rim: 0.0, rgbShift: 0.0, bodyStrength: 1.3, highlight: 0.1 },
  };
  const state = { preset: 'Lusion' };
  gui.add(state, 'preset', Object.keys(presets)).name('preset').onChange((p) => { fluid.set({ ...D, ...presets[p] }); refresh(); });

  // Brush: size of the capsule at rest and at full speed, what counts as full speed, how much velocity it writes.
  const fb = gui.addFolder('Brush');
  add(fb, 'brushMin', 2, 80, 1).name('radius (still) px');
  add(fb, 'brushRadius', 4, 200, 1).name('radius (fast) px');
  add(fb, 'speedFull', 5, 120, 1).name('full-speed px/frame');
  add(fb, 'brushVel', 0, 2, 0.01).name('velocity scale');
  add(fb, 'brushSoft', 0, 1, 0.01).name('edge softness');
  add(fb, 'segmentsPerFrame', 1, 8, 1).name('sub-frame segments');

  // Field: how the painted velocity spreads (self-advection + blur) and how fast each channel fades.
  const ff = gui.addFolder('Field (spread & decay)');
  add(ff, 'pushStrength', 0, 4, 0.01).name('spread / advection');
  add(ff, 'blurPasses', 0, 8, 1).name('spread blur passes');
  add(ff, 'dissV', 0.9, 0.999, 0.001).name('velocity dissipation');
  add(ff, 'dissW1', 0.9, 0.999, 0.001).name('weight dissipation');
  add(ff, 'dissW2', 0.3, 0.99, 0.001).name('highlight dissipation');
  add(ff, 'floorW', 0, 0.01, 0.0001).name('weight floor');
  add(ff, 'noise', 0, 2, 0.01).name('curl noise strength');
  add(ff, 'noiseScale', 0.5, 12, 0.1).name('curl noise scale');

  // Distortion: how strongly the post pass bends the page, text and images, and the colour fringes.
  const fd = gui.addFolder('Distortion (post)');
  add(fd, 'distort', 0, 40, 0.1).name('offset × velocity');
  add(fd, 'domDistort', 0, 3, 0.01).name('DOM (text/img) amount');
  add(fd, 'refract', 0, 120, 1).name('rim refraction');
  add(fd, 'blur', 0, 10, 0.1).name('blur length');
  add(fd, 'jitter', 0, 1, 0.01).name('tap jitter');
  add(fd, 'chroma', 0, 1, 0.01).name('chromatic split');
  add(fd, 'rgbShift', 0, 2, 0.01).name('RGB shift (velocity)');

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
  fq.close();

  // Buttons: reset, copy the current settings as JSON (clipboard, or a prompt if clipboard is blocked), paste JSON back in.
  const actions = {
    reset() { fluid.set({ ...D }); state.preset = 'Lusion'; refresh(); },
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
