# Lowtide

**An immersive, minimal studio site with a Lusion-style "screen paint" fluid — written in raw WebGL2, zero libraries.**

**Live demo → https://lowtide.sites.tab.bot/** · second page: [/studio.html](https://lowtide.sites.tab.bot/studio.html) · static fallback: [/?static](https://lowtide.sites.tab.bot/?static) · tuning panel: [/?gui](https://lowtide.sites.tab.bot/?gui)

Move the cursor (or drag a finger on a phone): the page behaves like a sheet of liquid glass. The trail refracts the white page, the photos **and the headlines** with thin chromatic fringes, then drifts and fades over a couple of seconds.

"Lowtide" is a fictional design studio — the site is a study/showcase piece by **Jehad Uddin**.

---

## Highlights

- **Screen-paint fluid** (`js/fluid.js`) — a quarter-res velocity "paint" grid + a refraction / directional-blur post pass. No three.js, no GSAP, no Lenis, no build step.
- **DOM ↔ WebGL sync** — images *and* headlines are drawn as GL quads that sit exactly on top of their DOM boxes, so the fluid can bend them. The DOM stays real: layout, text selection, find-in-page and screen readers all keep working.
- **Lenis-style smooth scroll** in ~30 lines, driven from the same frame loop as the GL so nothing lags while scrolling.
- Preloader counter, line-by-line text reveals, word-by-word scroll statement, custom cursor, page wipe between pages, `+` grid markers.
- **Respects the device** — phones get a lighter sim and native scrolling; `prefers-reduced-motion` (or `?static`) gets a calm, fully static page; no WebGL2 → plain DOM page.
- Every file is commented — start at the header of `js/fluid.js`.

## How the fluid works

The look is based on the method Lusion's co-founder **Edan Kwan** described publicly on Reddit:
[“How to create a cursor animation like in lusion.co” — r/threejs](https://www.reddit.com/r/threejs/comments/1fzr6vf/how_to_create_a_cursor_animation_like_in_lusionco/).
In short, it is *not* a Navier–Stokes simulation. It is a cheap "grid method": paint the cursor's velocity into a low-res grid, let that grid drift along a blurred copy of itself, and use it to distort the rendered page. **The code here is our own implementation of that idea** — no code, shaders or assets were taken from lusion.co.

Each frame runs four passes:

| # | Pass | Target | What it does |
|---|------|--------|--------------|
| 1 | **Paint** | RGBA16F ping-pong, 1/4 of the canvas | A soft **capsule brush** (2D distance to the segment *previous pointer → current pointer*) writes velocity into `.xy` and two weights into `.z` (slow, the stroke body) and `.w` (fast, a short highlight). The radius grows with pointer speed. Every texel then **advects itself along a blurred low-res copy of its own velocity** (semi-Lagrangian lookup), which is what makes the trail spread and float. Each channel decays at its own rate, and a little **curl noise** wobbles the lookup so edges stay organic. |
| 2 | **Blur** | RGBA16F ping-pong, 1/8 of the canvas | Downsample the paint and run a separable 9-tap Gaussian (5 bilinear fetches) a few times. Pass 1 reads this next frame. |
| 3 | **Scene** | RGBA8, full resolution | Clear to the page colour (alpha 0), then draw every visible DOM-synced quad (alpha 1): `[data-gl-image]` photos (cover-fit, rounded-corner SDF mask, reveal zoom) and `[data-gl-text]` headlines. |
| 4 | **Post** | the screen | **Refraction** along the gradient of the paint weight (a thin glassy rim) + **smear** along the velocity, a **9-tap jittered directional blur** along the velocity, **per-channel offsets** (oily RGB fringes), Lusion's velocity-driven **sine RGB shift**, a pale glass **body tint** + highlight on the page, and thin **holographic contour bands** only where the stroke's edge is. Scene alpha tells the pass what is page and what is content, so photos and text mostly refract instead of being tinted. |

Cost per frame: one quarter-res pass, one copy, 6 tiny blur passes, one scene pass, one full-screen post pass. It needs WebGL2 with `EXT_color_buffer_half_float` (or `EXT_color_buffer_float`) — signed velocity needs a half-float target. Without it `createFluid` returns `null` and the page falls back to plain DOM.

### Text in WebGL (the Lusion trick)

A headline with `data-gl-text` is rasterised **line by line** into a 2D canvas at device resolution. Each line is placed at the position of the DOM's own line box (measured with a `Range` → `getBoundingClientRect()`), the font is copied from `getComputedStyle`, and the result is uploaded as a texture. Once the CSS line-reveal has played, `main.js` calls `fluid.showText(el)`: the GL quad fades in and the DOM copy gets `color: transparent`. The text is still there for layout, selection and accessibility — you are just seeing the GL pixels, which the fluid can distort. On resize or font load the text is re-rasterised.

### Staying in sync with the DOM

Every frame `drawScene()` reads `el.getBoundingClientRect()` for each quad and converts it to clip space. The fluid runs with `manual: true` and the **single** `requestAnimationFrame` loop in `main.js` calls, in order: smooth-scroll write → word reveal → header → `fluid.render()`. Because the GL draws after the scroll position is written, the quads never trail the DOM by a frame.

### Round 1: a real fluid sim

`js/fluid-navier-stokes.js` is the first version — a classic stable-fluids solver (splat → curl → vorticity confinement → divergence → Jacobi pressure → gradient subtract → advect). It works, but on a white page the dye reads as ink, not glass, so round 2 switched to the paint grid. It is kept (commented) for reference and is not loaded by the site.

## Run it locally

No build step, no dependencies. Serve the folder with any static server (ES modules don't load from `file://`):

```bash
git clone https://github.com/Jehad123-lab/lowtide.git
cd lowtide
npx serve .            # or: python3 -m http.server 8080
```

Open `http://localhost:3000` (or `:8080`). Add `?gui` for the tuning panel, `?static` to preview the reduced-motion version. The only external requests are Google Fonts (Inter, Geist Mono) and, with `?gui` only, lil-gui from jsDelivr.

## Files

```
index.html                  home: hero (GL headline + GL image), work grid, statement, services, quote, contact
studio.html                 second page, same shell (the page wipe links the two)
css/style.css               the whole design system — tokens at the top (--ink, --line, --accent, type, easing)
js/main.js                  page behaviour: fluid wiring + input, smooth scroll, split text, reveals, cursor, wipe, preloader
js/fluid.js                 the fluid: createFluid(canvas, options) — paint grid + scene + refraction post pass
js/gui.js                   lil-gui tuning panel (only loaded with ?gui)
js/fluid-navier-stokes.js   round-1 stable-fluids version (reference only)
img/                        photos (see Image credits — not covered by the license)
favicon.svg
```

## Using the fluid

```js
import { createFluid } from './js/fluid.js';

const fluid = createFluid(document.querySelector('#gl'), { brushRadius: 64, distort: 10 });
if (fluid) {
  addEventListener('pointermove', e => fluid.pointer(e.clientX, e.clientY));
  document.documentElement.addEventListener('pointerleave', () => fluid.pointerLeave());
  fluid.enabled = true;            // start image reveals
}
```

Mark up anything you want the fluid to bend:

```html
<div class="gl-image" data-gl-image="img/photo.webp"><img class="gl-image__fallback" src="img/photo.webp" alt=""></div>
<h1 data-gl-text>Headline drawn in WebGL</h1>   <!-- then call fluid.showText(h1) -->
```

### Knobs

All options can be passed to `createFluid(canvas, { ... })`, changed live with `window.__fluid.set({ ... })`, or tuned in the [`?gui` panel](#tuning-panel-gui) (which has a *copy settings JSON* button).

| Group | Option | Default | Meaning |
|-------|--------|---------|---------|
| Brush | `brushMin` / `brushRadius` | 14 / 64 | capsule radius in CSS px at rest / at full speed |
| | `speedFull` | 40 | pointer speed (CSS px per frame) that counts as full speed |
| | `brushVel` | 0.6 | pointer delta → stored velocity |
| | `brushSoft` | 0.45 | edge softness of the brush (0 hard … 1 soft) |
| | `segmentsPerFrame` | 4 | sub-frame pointer samples painted as separate capsules (fast flicks stay curved) |
| Field | `pushStrength` | 1.1 | self-advection along the blurred field — the "spread" |
| | `dissV` / `dissW1` / `dissW2` | 0.985 / 0.99 / 0.8 | per-frame decay of velocity / stroke body / highlight (at 60 fps, frame-rate independent) |
| | `floorW` | 0.0012 | subtracted every frame so the tail reaches exactly zero |
| | `noise` / `noiseScale` | 0.25 / 3 | curl-noise wobble strength / scale |
| Post | `distort` | 10 | smear: CSS px of offset per unit velocity |
| | `domDistort` | 1 | multiplier of the offset on images/text vs the bare page |
| | `refract` | 24 | glassy rim: px of offset per unit weight gradient |
| | `blur` | 2.5 | length of the 9-tap directional blur |
| | `jitter` | 0.8 | random offset of the taps (hides banding) |
| | `chroma` | 0.3 | per-channel split of the displacement (RGB fringes) |
| | `rgbShift` | 0.35 | Lusion-style sine RGB tint driven by speed |
| Look | `rim` / `bands` | 0.10 / 18 | holographic contour bands at the stroke edge: strength / count |
| | `bodyTint` / `bodyStrength` | pale blue-white / 1 | glass tint over the stroke body (page only) |
| | `highlight` | 0.06 | sheen right behind the cursor |
| | `paper` | white | page colour (match `--page` in the CSS) |
| Quality | `dpr` | min(devicePixelRatio, 1.5) | canvas resolution |
| | `paintDiv` / `lowDiv` / `blurPasses` | 4 / 8 / 3 | paint grid = canvas ÷ 4, blur grid = canvas ÷ 8, Gaussian passes |
| Scroll | `scrollPaint` | 0 | scroll paint amount: scroll delta × this is added to the brush (×3 for speed/radius), so scrolling with a still mouse paints a streak, and the trail sticks to the page. 0 = off (the v3 default) |
| Engine | `model` | `'v3'` | `'v3'` = the default look; `'handbook'` = the engine behind the *Handbook (v4)* preset (see below) |
| Handbook only | `brushVw` / `brushAccel` / `blurRadius` / `fringe` / `float8` | 20 / 0.8 / 8 / 12.5 / false | max radius = max(`brushRadius`, width ÷ `brushVw`) · brush velocity momentum · blur radius of the 1/8 copy · sine-fringe strength · 8-bit paint targets like Lusion |

Phones use `dpr ≤ 1.25, paintDiv: 3, blurPasses: 2` and a smaller brush (see `main.js`).
`window.__fluid.stats()` reads the paint buffer back (max velocity, coverage) for debugging.

## Tuning panel (`?gui`)

Open the live demo with **`?gui`** (or `#gui`): [lowtide.sites.tab.bot/?gui](https://lowtide.sites.tab.bot/?gui), also on [/studio.html?gui](https://lowtide.sites.tab.bot/studio.html?gui). Locally it's `http://localhost:8080/?gui`.

- **[lil-gui](https://lil-gui.georgealways.com/) 0.19 loads only when `?gui` / `#gui` is in the URL.** It is imported lazily from jsDelivr by `js/gui.js`. The normal site downloads no extra code and stays dependency-free.
- **`g`** hides/shows the panel on desktop (ignored while typing in an input).
- **Presets** (the dropdown at the top). Choosing one resets everything to the defaults first, then applies the preset:
  - **Lusion**: the defaults above, matched frame by frame to recordings of lusion.co
  - **Subtle (round 2)**: the earlier, quieter look (smaller brush, little spread)
  - **Bold**: a bigger brush, more spread, a stronger offset and rim
  - **Ink-free glass**: no holographic rim and no RGB shift, only the glass body and highlight
  - **Handbook (v4)**: switches to the `handbook` engine with the numbers measured in the "Lusion.co Decoded" handbook (below), scroll paint on
  - Presets and *reset* keep the device's quality: on a phone they stay on the phone's 1/3 grid, dpr 1.25 and thumb-sized brush.
- **Folders**, one control per option in the knob table:
  - **Brush**: radius still/fast, full-speed px/frame, velocity scale, edge softness, sub-frame segments
  - **Field (spread & decay)**: spread/advection, blur passes, velocity/weight/highlight dissipation, weight floor, curl noise strength and scale
  - **Distortion (post)**: offset × velocity, DOM (text/img) amount, rim refraction, blur length, tap jitter, chromatic split, RGB shift
  - **Look**: holographic rim, rim band count, body tint colour, body strength, highlight
  - **Quality** (closed by default): paint grid ÷, blur grid ÷, canvas dpr. Changing these rebuilds the render targets.
- **Buttons**
  - **reset to defaults**
  - **copy settings JSON**: copies to the clipboard and also logs to the console, with a prompt as a fallback
  - **paste settings JSON**: applies a JSON object you paste

The copied JSON is a plain object of option names (everything except `dpr` and `paper`). You can paste it straight into code:

```js
const fluid = createFluid(canvas, {
  /* paste the copied settings here */
  "brushMin": 14, "brushRadius": 64, "pushStrength": 1.1, "distort": 10
});
```

In a Framer port, use the same values as the property-control defaults of `<FluidBackground />`.


## Optional: the Handbook (v4) engine

The default look is v3 (tuned by eye against recordings of lusion.co). The panel's **Handbook (v4)** preset switches `model` to `'handbook'`: the same four passes, driven by the values measured in the "Lusion.co Decoded" client-side handbook (chapter *Special: Cursor fluid trail (ScreenPaint)*), written in our own code:

| Thing | Handbook value | Option |
|-------|----------------|--------|
| Max brush radius | `max(40, viewportWidth / 20)` CSS px (72 px at 1440 wide) | `brushRadius: 40`, `brushVw: 20` |
| Radius from speed | pointer travel 0 → 100 px per frame maps to 0 → max; still pointer paints nothing | `brushMin: 0`, `speedFull: 100` |
| Brush velocity | leaky `v = v × 0.8 + step × dt × 0.8`, added under the brush, clamped to ±0.5 | `brushAccel: 0.8`, `brushVel: 0.8` |
| Fades per 60 fps frame | velocity 0.975 (≈0.45 s half-life), tail 0.95 (≈0.23 s), head 0.8 (≈0.05 s), min step 0.004 | `dissV`, `dissW1`, `dissW2`, `floorW` |
| Field | push 25 texels, blur(8, 1) on the 1/8 copy, noise 3 @ 0.02 | `pushStrength`, `blurRadius`, `blurPasses`, `noise`, `noiseScale` |
| Post | 9 taps spanning 0..8 steps of ≈15 CSS px (page dragged with the cursor); sine fringe only where weight < 0.4 | `distort: 60`, `blur: 60`, `rgbShift: 0.5`, `fringe: 12.5` |
| Scroll | scroll delta × offset ratio added to the brush; trail sticks to the page | `scrollPaint: 1` |
| Precision | optional 8-bit targets, velocity biased at 0.5 | `float8` (Quality folder) |

Fades in both engines are frame-rate corrected (`pow(x, dt × 60)`), so 120 Hz screens fade like 60 Hz ones.

## Touch & phones

- **Touch input.** A finger down starts a new stroke, so you never get a line from where the last finger lifted. Moving the finger carries velocity like a mouse, and lifting it ends the stroke. Listeners are passive, so page scrolling is not blocked.
- **Mouse/pen input** uses `pointermove` + `getCoalescedEvents()`. Every pointer sample since the last frame is painted, with up to `segmentsPerFrame` capsules per frame, so a fast flick draws a curve instead of a straight chord.
- **Lighter settings on phones.** When the user agent is a phone/tablet or the viewport is < 720 px wide, `main.js` passes `dpr ≤ 1.25, paintDiv: 3, blurPasses: 2, brushMin: 12, brushRadius: 48, speedFull: 28`. That means a 1/3-res paint grid at a lower canvas resolution and a brush scaled to a thumb.
- **The panel on a phone** starts collapsed (tap its title), runs full width and scrolls. *Reset* and the presets keep the phone's values (`dpr ≤ 1.25`, `paintDiv: 3`, the thumb-sized brush) — `fluid.defaults` is DEFAULTS plus whatever the page passed to `createFluid` on that device.
- **No WebGL2 / half-float, or `prefers-reduced-motion` / `?static`:** the page is plain DOM and static, and there's no fluid or panel.

## Porting to Framer (code components)

1. **`<FluidBackground />`** — a code component with a `useRef` canvas (`position: fixed; inset: 0; pointer-events: none`, lowest layer) and `useEffect(() => { const f = createFluid(canvas, props); … return () => f.destroy(); }, [])`. Paste `js/fluid.js` above it as-is (it is one exported function, no imports). Either drop `manual: true` so it runs its own loop, or call `fluid.render(t)` from your own rAF. Expose `distort`, `refract`, `blur`, `rim`, `brushRadius`, `bodyTint` as property controls — the `?gui` panel's *copy settings JSON* gives you the defaults.
2. **`<GLImage src />`** — renders `<div data-gl-image={src}><img src={src}/></div>` and calls `fluid.addImage(el)` on mount (share the fluid instance through React context or `window`). Framer's layout drives the box; the GL draws into it.
3. **GL headlines** — add `data-gl-text` and call `fluid.addText(el)` then `fluid.showText(el)` once the text has settled.
4. **Smooth scroll** — use Framer's built-in smooth scroll, *or* wrap `main.js`'s scroller in a tiny component. Not both.
5. **Text reveals** — use Framer's Appear → Lines effect instead of `splitLines()`; the word-by-word statement is ~20 lines with framer-motion's `useScroll` + `useTransform`.
6. **Cursor, preloader, page wipe** — small code components / Framer page transitions; no special code needed.
7. **Tokens** — `:root` in `style.css` maps 1:1 to Framer styles: Ink `#171717`, Ink-2 `#666`, Line `#e5e5e5`, Surface `#f5f5f5`, Accent `#ff8527`; Inter 300–700 + Geist Mono 12px uppercase labels.

## Image credits

All photographs were found on [cosmos.so](https://www.cosmos.so) and **belong to their respective owners**. They are included only to demonstrate the effect; they are **not** covered by this repository's license. If you are an owner and want an image removed or credited differently, please open an issue.

| File | Image | Source |
|------|-------|--------|
| `img/img02.webp` | Stacked concrete building in grey light (work card) | [cosmos.so file](https://cdn.cosmos.so/6dde50e9-9271-4998-b029-3198a69654dd) |
| `img/img03.webp` | Stacked concrete terraces (work card) | [cosmos.so file](https://cdn.cosmos.so/30888cf7-1c11-4a10-9b87-83b08f37b609) |
| `img/img04.webp` | Concrete tower against a pale sky (home hero, GL) | [cosmos.so file](https://cdn.cosmos.so/02c1c5af-af8c-4d11-b79a-5bea0ee5fb8e) |
| `img/img05.webp` | Lighthouse in a grey wave (studio) | [cosmos.so file](https://cdn.cosmos.so/8baf507c-bc9d-4156-8e9c-2a4d013bdd3c) |
| `img/img06.webp` | Lighthouse on a dark beach (work card) | [cosmos.so file](https://cdn.cosmos.so/fd2e3497-25c9-49e0-ba1e-c20d368277ee) |
| `img/img07.webp` | Lighthouse in sea mist (work card) | [cosmos.so file](https://cdn.cosmos.so/fd62dc34-7096-4aad-9e2c-940b6c22d464) |
| `img/img08.webp` | Rocks in sea fog (quote, GL) | [cosmos.so file](https://cdn.cosmos.so/7fd8525a-32db-4ff1-b6e4-148238272428) · [cosmos.so post](https://www.cosmos.so/e/1072892017) · [original](https://www.pinterest.com/pin/978336719072332517) |
| `img/img09.webp` | Lighthouse and grey sea (studio) | [cosmos.so file](https://cdn.cosmos.so/d5222002-b718-49bc-ab23-14207c11a594) |
| `img/img10.webp` | Hand on rock, black and white (studio) | [cosmos.so file](https://cdn.cosmos.so/e071ccdb-8dab-4227-b02e-4924a9bcb49d) · [cosmos.so post](https://www.cosmos.so/e/1033070856) · [original](https://www.instagram.com/_nahaaal/p/CYHO0iyILX1/) |
| `img/img11.webp` | Concrete facade with deep shadows (studio hero, GL) | [cosmos.so file](https://cdn.cosmos.so/82981034-3514-47d3-b3c4-e51b775ec0f9) |
| `img/img12.webp` | Lighthouse at dusk (studio) | [cosmos.so file](https://cdn.cosmos.so/a685f648-6fcb-4d53-84fa-5bcdbeef8322) |

## Credits & license

- Technique: the "grid method" as described publicly by Edan Kwan (Lusion) on Reddit — link above. Stable-fluids background: Jos Stam, *Stable Fluids* (SIGGRAPH 1999).
- Numbers cross-checked against the ["Lusion.co Decoded" handbook](https://shifatmasud.notion.site/Lusion-co-Decoded-Client-Side-Handbook-3fd48559569d81dd80b4c7407caf27cc) by shifatmasud (used for the optional *Handbook (v4)* preset). Only its measured values and described behaviour were used; none of the code it quotes is included here.
- Research references: lusion.co, immersivegarden.com and wajo.ai were studied for technique and layout; no code, shaders, fonts, copy or assets from them are included.
- Fonts: [Inter](https://rsms.me/inter/) and [Geist Mono](https://vercel.com/font), loaded from Google Fonts (SIL Open Font License).
- **Code** © 2026 Jehad Uddin — [MIT License](LICENSE). The license covers the source code only (HTML, CSS, JS, SVG), **not** the images in `img/`.
