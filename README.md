# Lowtide

**An immersive, minimal studio site with a Lusion-style "screen paint" fluid — written in raw WebGL2, zero libraries.**

**Live demo → https://lowtide.sites.tab.bot/** · second page: [/studio.html](https://lowtide.sites.tab.bot/studio.html) · static fallback: [/?static](https://lowtide.sites.tab.bot/?static) · tuning panel: [/?gui](https://lowtide.sites.tab.bot/?gui)

Move the cursor (or drag a finger on a phone): the page behaves like a sheet of liquid. A crisp leading stroke drags the white page, the photos **and the headlines** along with the cursor, leaves a long soft wake with a thin oil-slick fringe, then drifts and fades in about a second. Scrolling with a still mouse paints a streak too.

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
| 1 | **Paint** | RGBA16F ping-pong (or RGBA8, toggle), 1/4 of the canvas | A soft **capsule brush** (2D distance to the segment *previous pointer → current pointer*) adds velocity into `.xy` (clamped to ±0.5) and two weights into `.z` (the long soft tail) and `.w` (the short crisp head). The radius grows with how far the pointer travelled this frame, and is 0 when it is still. Every texel then **advects itself along a blurred low-res copy of its own velocity** (semi-Lagrangian lookup, 25 texels upstream at full speed), which is what makes the trail spread and float. Each channel decays at its own rate, **curl noise** scaled by the amount of paint curls the wake, and while the page scrolls every lookup is shifted so the trail stays stuck to the page. |
| 2 | **Blur** | same format, 1/8 of the canvas | Downsample the paint and run one separable 17-tap Gaussian of radius 8 low texels. Pass 1 reads this next frame. |
| 3 | **Scene** | RGBA8, full resolution | Clear to the page colour (alpha 0), then draw every visible DOM-synced quad (alpha 1): `[data-gl-image]` photos (cover-fit, rounded-corner SDF mask, reveal zoom) and `[data-gl-text]` headlines. |
| 4 | **Post** | the screen | **Drags** the scene along the velocity (× the average of both weights), a **9-tap jittered directional blur** along it, and a 3-phase **sine "oil" fringe** that only shows in the fading wake. Optional glass extras (off in the Lusion preset, on in *Lusion + glass*): **refraction** along the weight gradient (a thin glassy rim), **per-channel offsets**, a pale **body tint** + highlight, and thin **holographic contour bands** at the stroke's edge. Scene alpha tells the pass what is page and what is content. |

Cost per frame: one quarter-res pass, one copy, 2 tiny blur passes, one scene pass, one full-screen post pass. It needs WebGL2. Half-float targets (`EXT_color_buffer_half_float` or `EXT_color_buffer_float`) are used when available; otherwise the paint runs in 8-bit with the velocity biased around 0.5, the way Lusion stores it. No WebGL2 → `createFluid` returns `null` and the page falls back to plain DOM.

### The numbers (v4)

The default ("Lusion") preset uses the values measured in the **[“Lusion.co Decoded: Client-Side Handbook”](https://shifatmasud.notion.site/Lusion-co-Decoded-Client-Side-Handbook-3fd48559569d81dd80b4c7407caf27cc) by shifatmasud** (chapter *Special: Cursor fluid trail (ScreenPaint)*). Only the numbers and the described behaviour were used — the code is ours.

| Thing | Value | In our code |
|-------|-------|-------------|
| Max brush radius | `max(40, viewportWidth / 20)` CSS px — 72 px at 1440 wide, 40 px on a phone | `brushRadius: 40`, `brushVw: 20` |
| Radius from speed | pointer travel per frame 0 → 100 px maps to 0 → max; still pointer paints nothing | `brushMin: 0`, `speedFull: 100` |
| Brush velocity | leaky: `v = v × 0.8 + step × dt × 0.8` | `brushAccel: 0.8`, `brushVel: 0.8` |
| Fades per frame @ 60 fps | velocity 0.975 (half-life ≈ 0.45 s), tail 0.95 (≈ 0.23 s), head 0.8 (≈ 0.05 s), min step 0.004 | `dissV`, `dissW1`, `dissW2`, `floorW` |
| Grids | paint 1/4, blurred copy 1/8, blur(8, 1) | `paintDiv: 4`, `lowDiv: 8`, `blurRadius: 8`, `blurPasses: 1` |
| Push / noise | push 25 texels, noise on, scale 0.02, strength 3 | `pushStrength: 25`, `noiseScale: 0.02`, `noise: 3` |
| Distortion | 9 taps, one step = velocity × 3 / 4 × 5 paint texels (≈ 15 CSS px) → taps span 0..120 px | `distort: 60`, `blur: 60`, `jitter: 1` |
| Colour | RGB shift 0.5, shade 1.25 × colour multiplier 10, only where weight < 0.4 | `rgbShift: 0.5`, `fringe: 12.5` |
| Scroll | scroll delta × offset ratio added to the brush (×3 for the radius) | `scrollPaint: 1` |
| Phone | paint only while a finger is down and moving | touch input in `main.js` |

What is different on purpose: fades are frame-rate corrected (`pow(x, dt × 60)`; Lusion's are per frame, so a 120 Hz screen fades twice as fast there), targets are half-float by default, pointer samples are sub-frame (`getCoalescedEvents`), and the noise is a true curl (a rotated gradient) rather than a plain gradient offset.

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

const fluid = createFluid(document.querySelector('#gl'), { distort: 60, scrollPaint: 1 });
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
| Brush | `brushRadius` | 40 | max radius floor in CSS px |
| | `brushVw` | 20 | max radius = max(`brushRadius`, viewport width ÷ this); 0 = off |
| | `brushMin` | 0 | radius at the slightest movement (CSS px) |
| | `speedFull` | 100 | pointer travel (CSS px per 60 fps frame) that gives the max radius |
| | `brushVel` / `brushAccel` | 0.8 / 0.8 | brush velocity gain / momentum (leaky integrator) |
| | `brushSoft` | 1 | edge softness of the brush (0 hard … 1 soft cone) |
| | `segmentsPerFrame` | 4 | sub-frame pointer samples painted as separate capsules (fast flicks stay curved) |
| | **`scrollPaint`** | **1** | **scroll paint amount: scroll delta × this is added to the brush (×3 for the radius), so scrolling with a still mouse paints a streak. 0 = off** |
| Field | `pushStrength` | 25 | self-advection: texels upstream along the blurred field — the "spread" |
| | `blurRadius` / `blurPasses` | 8 / 1 | Gaussian radius (low texels) / H+V passes on the 1/8 grid |
| | `dissV` / `dissW1` / `dissW2` | 0.975 / 0.95 / 0.8 | per-frame decay of velocity / tail / head (at 60 fps, frame-rate independent) |
| | `floorW` | 0.004 | minimum weight drop per frame, so the tail reaches exactly zero |
| | `noise` / `noiseScale` | 3 / 0.02 | curl-noise strength (texels per unit paint) / frequency per paint texel |
| Post | `distort` | 60 | CSS px the page is dragged along the velocity at full strength |
| | `domDistort` | 1 | multiplier of the drag on images/text vs the bare page |
| | `blur` | 60 | ± CSS px of the 9-tap directional blur around the dragged point |
| | `jitter` | 1 | random shift of the taps, in tap steps (hides banding) |
| | `rgbShift` / `fringe` | 0.5 / 12.5 | phase spread / strength of the sine "oil" fringe in the wake |
| | `refract` | 0 | glass extra: rim refraction, px per unit weight gradient (24 in *Lusion + glass*) |
| | `chroma` | 0 | glass extra: per-channel split of the displacement (0.3 in *Lusion + glass*) |
| Look | `rim` / `bands` | 0 / 18 | glass extra: holographic contour bands at the stroke edge: strength / count |
| | `bodyTint` / `bodyStrength` | pale blue-white / 0 | glass extra: tint over the stroke body (page only) |
| | `highlight` | 0 | glass extra: sheen right behind the cursor |
| | `paper` | white | page colour (match `--page` in the CSS) |
| Quality | `dpr` | min(devicePixelRatio, 1.5) | canvas resolution |
| | `paintDiv` / `lowDiv` | 4 / 8 | paint grid = canvas ÷ 4, blur grid = canvas ÷ 8 |
| | `float8` | false | 8-bit paint targets like Lusion (forced on when the GPU has no half-float render targets) |

Phones use `dpr ≤ 1.25, paintDiv: 3` (see `main.js`); everything else follows the defaults.
`window.__fluid.stats()` reads the paint buffer back (max velocity, coverage) for debugging.

## Tuning panel (`?gui`)

Open the live demo with **`?gui`** (or `#gui`): [lowtide.sites.tab.bot/?gui](https://lowtide.sites.tab.bot/?gui), also on [/studio.html?gui](https://lowtide.sites.tab.bot/studio.html?gui). Locally it's `http://localhost:8080/?gui`.

- **[lil-gui](https://lil-gui.georgealways.com/) 0.19 loads only when `?gui` / `#gui` is in the URL.** It is imported lazily from jsDelivr by `js/gui.js`. The normal site downloads no extra code and stays dependency-free.
- **`g`** hides/shows the panel on desktop (ignored while typing in an input).
- **Presets** (the dropdown at the top). Choosing one resets everything to the defaults first, then applies the preset:
  - **Lusion**: the defaults above — the handbook's measured numbers
  - **Lusion + glass**: the same field plus our glass extras (rim refraction, chromatic split, body tint, highlight, holographic rim)
  - **Subtle (round 2)**: a quieter look (smaller brush, little spread) with the glass extras
  - **Bold**: a bigger brush, more spread, a longer tail, a stronger drag and rim
  - **Ink-free glass**: glass body, refraction and highlight, no colour (no fringe, no holographic rim)
  - Presets and *reset* keep the device's quality: on a phone they stay on the phone's 1/3 grid and dpr 1.25.
- **Folders**, one control per option in the knob table:
  - **Brush**: max radius floor, max radius = width ÷, radius (slowest), full radius at px/frame, velocity gain, velocity momentum, edge softness, sub-frame segments, **scroll paint amount** (0 = off)
  - **Field (spread & decay)**: spread/push, spread blur radius and passes, velocity/tail/head dissipation, weight floor, curl noise strength and scale
  - **Distortion (post)**: drag px × velocity, DOM (text/img) amount, blur length, tap jitter, RGB shift phase, oil fringe strength, rim refraction (glass), chromatic split (glass)
  - **Look**: holographic rim, rim band count, body tint colour, body strength, highlight
  - **Quality** (closed by default): paint grid ÷, blur grid ÷, canvas dpr, **8-bit paint (Lusion)**. Changing these rebuilds the render targets.
- **Buttons**
  - **reset to defaults**
  - **copy settings JSON**: copies to the clipboard and also logs to the console, with a prompt as a fallback
  - **paste settings JSON**: applies a JSON object you paste

The copied JSON is a plain object of option names (everything except `dpr` and `paper`). You can paste it straight into code:

```js
const fluid = createFluid(canvas, {
  /* paste the copied settings here */
  "brushRadius": 40, "brushVw": 20, "pushStrength": 25, "distort": 60, "scrollPaint": 1
});
```

In a Framer port, use the same values as the property-control defaults of `<FluidBackground />`.

## Touch & phones

- **Touch input.** A finger down starts a new stroke, so you never get a line from where the last finger lifted. Moving the finger carries velocity like a mouse, and lifting it ends the stroke — Lusion's mobile rule: paint only while a finger is down and moving (a resting finger has zero travel, so radius 0). Scroll paint is off for touch strokes (the finger is the scroll). Listeners are passive, so page scrolling is not blocked.
- **Mouse/pen input** uses `pointermove` + `getCoalescedEvents()`. Every pointer sample since the last frame is painted, with up to `segmentsPerFrame` capsules per frame, so a fast flick draws a curve instead of a straight chord.
- **Lighter settings on phones.** When the user agent is a phone/tablet or the viewport is < 720 px wide, `main.js` passes `dpr ≤ 1.25, paintDiv: 3` — a 1/3-res paint grid at a lower canvas resolution. The brush follows the same rule as desktop, which gives 40 px on a phone. Those device values become the fluid's defaults on that device.
- **The panel on a phone** starts collapsed (tap its title), runs full width and scrolls. *Reset* and the presets keep the phone's `dpr` and `paintDiv: 3` (fixed in v4 — before, they jumped to the desktop's 1/4 grid).
- **No half-float:** the fluid runs in 8-bit. **No WebGL2, or `prefers-reduced-motion` / `?static`:** the page is plain DOM and static, and there's no fluid or panel.

## Porting to Framer (code components)

1. **`<FluidBackground />`** — a code component with a `useRef` canvas (`position: fixed; inset: 0; pointer-events: none`, lowest layer) and `useEffect(() => { const f = createFluid(canvas, props); … return () => f.destroy(); }, [])`. Paste `js/fluid.js` above it as-is (it is one exported function, no imports). Either drop `manual: true` so it runs its own loop, or call `fluid.render(t)` from your own rAF. Expose `distort`, `blur`, `fringe`, `scrollPaint`, `brushRadius`, `dissW1` as property controls — the `?gui` panel's *copy settings JSON* gives you the defaults.
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
- Numbers cross-checked against the ["Lusion.co Decoded" handbook](https://shifatmasud.notion.site/Lusion-co-Decoded-Client-Side-Handbook-3fd48559569d81dd80b4c7407caf27cc) by shifatmasud. Only its measured values and described behaviour were used; none of the code it quotes is included here.
- Research references: lusion.co, immersivegarden.com and wajo.ai were studied for technique and layout; no code, shaders, fonts, copy or assets from them are included.
- Fonts: [Inter](https://rsms.me/inter/) and [Geist Mono](https://vercel.com/font), loaded from Google Fonts (SIL Open Font License).
- **Code** © 2026 Jehad Uddin — [MIT License](LICENSE). The license covers the source code only (HTML, CSS, JS, SVG), **not** the images in `img/`.
