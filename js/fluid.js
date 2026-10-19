/* =====================================================================================================
   Lowtide — js/fluid.js
   A Lusion-style "screen paint" fluid + refraction post pass, written from scratch in raw WebGL2.
   No three.js, no libraries, one exported function.

   WHY NOT A "REAL" FLUID SIM?
   Round 1 of this site used a classic stable-fluids (Navier-Stokes) solver — see js/fluid-navier-stokes.js.
   It looked like coloured ink. The effect on lusion.co is something else: as Lusion's co-founder Edan Kwan
   explained publicly on Reddit (r/threejs, "how to create a cursor animation like in lusion.co"), it is a
   cheap "grid method": paint the cursor's velocity into a low-res grid, let that grid drift along a blurred
   copy of itself, and use it to distort the rendered page in a post pass. No pressure solve, no divergence.
   This file is our own implementation of that idea.

   WHAT RUNS EVERY FRAME (4 passes)
     1. PAINT  — ping-pong target at 1/paintDiv of the canvas (default 1/4, Lusion's ">> 2").
                 Half-float (RGBA16F) by default; an 8-bit (RGBA8) mode exists like Lusion's (Quality → 8-bit).
                 A soft capsule brush (2D segment distance field) from the previous pointer position to the
                 current one writes:   .xy = velocity (signed, clamped to ±0.5 — the same range Lusion gets from
                                             an 8-bit channel biased around 0.5)
                                       .z  = weight 1, the long soft tail (half-life ≈ 0.23 s)
                                       .w  = weight 2, the short crisp head (half-life ≈ 0.05 s)
                 Every texel then advects itself along a BLURRED low-res copy of the velocity (pass 2 of the
                 previous frame) — pushStrength texels upstream — which is what makes strokes spread, float and
                 widen, decays per channel (dissV / dissW1 / dissW2, with a minimum step floorW) and gets a
                 curl-noise wobble that is scaled by how much paint is there. When the page scrolls, every lookup
                 is shifted by the scroll so the trail stays stuck to the page.
     2. BLUR   — copy the paint into a 1/lowDiv grid (default 1/8, Lusion's ">> 3") and blur it with a separable
                 17-tap Gaussian of radius blurRadius low texels (default 8, one H+V pass, Lusion's "blur(8, 1)").
                 Pass 1 reads this next frame.
     3. SCENE  — full-res RGBA8 target: the page colour (alpha 0) + DOM-synced GL quads (alpha 1):
                 images ([data-gl-image]) and headlines ([data-gl-text], rasterised to a 2D canvas).
                 The DOM copies stay in the page for layout, selection and screen readers — they are just
                 made invisible (opacity 0 on the <img>, color: transparent on the text) once GL draws them.
     4. POST   — full-screen pass to the visible canvas: drag the scene along the velocity (× the average of
                 the two weights), 9 jittered taps of directional blur along it, and a 3-phase sine "oil" fringe
                 that only shows in the fading wake. Optional extras that are OFF in the Lusion preset: glassy
                 rim refraction along the weight gradient, per-channel chromatic split, a pale body tint +
                 highlight, and thin holographic contour bands at the stroke's edges ("Lusion + glass" preset).

   NUMBERS (v4, Oct 2026)
     The Lusion preset (= DEFAULTS) uses the values measured in the "Lusion.co Decoded" client-side handbook by
     shifatmasud (chapter "Special: Cursor fluid trail (ScreenPaint)" + chapter 5). Only the numbers and the
     described behaviour were used; every line of code here is our own.
       brush        max radius = max(40, viewportWidth / 20) CSS px (72 px at 1440 wide), mapped from the pointer's
                    travel per frame 0 → 100 px; a still pointer paints nothing. Soft cone edge.
       brush vel.   leaky integrator: v = v × 0.8 + step × dt × 0.8 (momentum after you stop).
       fades/frame  velocity 0.975 (half-life ≈ 0.45 s at 60 fps), weight 1 0.95 (≈ 0.23 s), weight 2 0.8
                    (≈ 0.05 s), with a 0.004 minimum step so tails reach exactly zero.
       field        paint 1/4, blurred copy 1/8, blur(8, 1), push 25 texels, noise on: scale 0.02, strength 3.
       post         9 taps, one step = velocity × amount 3 / 4 × multiplier 5 = 3.75 paint texels ≈ 15 CSS px,
                    i.e. the taps span 0..8 steps (we express that as distort 60 + blur 60 CSS px); RGB shift 0.5,
                    fringe 12.5 (= shade 1.25 × colour multiplier 10), visible only where weight < 0.4.
       scroll       scroll delta × offset ratio is added to the brush (×3 for the radius test), so scrolling with
                    a still mouse paints a streak, and the advection lookup is shifted by the scroll.
       phone        paints only while a finger is down and moving (Lusion's mobile rule).
     What is ours, not theirs: half-float targets by default, every fade frame-rate corrected with pow(x, dt*60)
     (Lusion's are per frame, so a 120 Hz screen fades twice as fast there), sub-frame pointer samples, a true
     curl noise (rotated gradient) instead of a plain gradient offset, and the optional glass extras.

   API
     const fluid = createFluid(canvas, options)   // returns null when WebGL2 is missing
       fluid.enabled            set true when the page is ready (images fade/zoom in only after that)
       fluid.pointer(x, y, isTouch)  feed pointer positions in CSS px (call as often as you get them)
       fluid.pointerLeave()     end the current stroke (pointer left / finger lifted)
       fluid.render(now)        draw one frame (when options.manual is true you drive the loop yourself)
       fluid.resize()           re-measure the canvas (also done automatically every frame)
       fluid.addImage(el)       register a [data-gl-image] element added after start-up
       fluid.addText(el)        register a [data-gl-text] element added after start-up
       fluid.refreshText(el?)   re-rasterise headline(s) (after a re-split / resize / font load)
       fluid.showText(el, on)   hand a headline to GL (on=true) or back to the DOM (on=false)
       fluid.set({...})         change any option live (used by the lil-gui panel in gui.js)
       fluid.settings()         current tunable values as a plain object (for "copy settings JSON")
       fluid.defaults           DEFAULTS + the device options the page passed in (a phone's dpr / paint grid),
                                so "reset" and presets in the panel keep the device-appropriate quality
       fluid.options / fluid.halfFloat / fluid.stats() / fluid.destroy()

   THREE PITFALLS WE HIT TUNING v3 (AND WHERE THE FIX LIVES)
     1. Additive curl noise accumulates. Adding noise to the stored velocity every frame makes it grow without
        limit, and the whole screen starts swimming. Fix: the noise only perturbs WHERE the paint shader samples
        the previous frame (see "off += curl(...)" in PAINT), weighted by the stroke's own weight. The shape
        drifts but the velocity never grows. (v4: the brush now ADDS velocity like Lusion, but the stored value
        is clamped to ±0.5, so holding the mouse in one spot still cannot run away.)
     2. Hitch frames become giant velocities. After a long frame or a tab switch, the pointer "jumps" hundreds of
        px in one step, and that reads as a huge flick. Fix: stepPaint() skips any single segment longer than
        600 CSS px (a teleport, not a flick), the velocity is clamped in the shader, and the frame loop clamps dt
        to 1..50 ms.
     3. Frame-rate-dependent decay. Multiplying by 0.975 per frame fades twice as fast at 120 Hz as at 60 Hz.
        Fix: the dissipations are tuned at 60 fps and applied as pow(x, dt*60) in paintPass() (floorW, the push
        and the noise offset are scaled by the same factor). Extra sub-frame segments painted in the same frame
        get dt = 0, so they add brush strokes without adding decay, advection or noise.

   INPUT (main.js feeds this)
     Mouse/pen: every getCoalescedEvents() sample goes to fluid.pointer(), and up to segmentsPerFrame capsules
     are painted per frame, so a fast flick is a curve, not a straight chord. Touch: touchstart ends the old
     stroke and starts a new one, touchmove carries velocity, and touchend / touchcancel end the stroke — no
     finger, no paint. Scroll: the fluid reads window.scrollY itself each frame (see stepPaint).

   KNOBS — see DEFAULTS below, every one is commented. The ones you will touch most:
     brushRadius / brushVw (stroke size), pushStrength (spread), dissV / dissW1 / dissW2 (how long it lingers),
     distort / blur (how far the page is dragged), rgbShift / fringe (oil colours), scrollPaint (scroll streaks).
   ===================================================================================================== */
// canvas: the <canvas> to draw into (main.js uses a fixed, full-viewport, pointer-events:none canvas behind the page).
// opts:   any subset of DEFAULTS below (a phone passes a lower dpr / coarser paintDiv here — those become its
//         defaults too), plus  manual (true = no internal rAF; call render(now) yourself),
//         hold (freeze the paint, for frame captures) and fixedDt (force a constant timestep).
export function createFluid(canvas, opts = {}) {
  // alpha:false -> the canvas is opaque (the post pass writes the full page colour itself);
  // no AA / depth / stencil: everything here is full-screen triangles and 2D quads.
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  if (!gl) return null;
  // Rendering INTO half-float textures needs one of these extensions. Half-float lets the paint buffer store
  // signed velocity directly. Lusion uses plain 8-bit targets with the velocity biased around 0.5; we keep that as
  // a fallback (and as a toggle in the panel): with no half-float support the fluid runs in 8-bit instead of
  // giving up.
  const extHalf = gl.getExtension('EXT_color_buffer_half_float');
  const extFloat = gl.getExtension('EXT_color_buffer_float');
  const halfOK = !!(extHalf || extFloat);
  // Lets float textures be sampled with LINEAR filtering where the driver needs it (half-float is filterable in WebGL2).
  gl.getExtension('OES_texture_float_linear');

  // ---------- tunable options ----------
  // All sizes are in CSS px so they look the same on every DPR; they are converted to paint / device px below.
  const DEFAULTS = {
    // Canvas resolution multiplier. Capped at 1.5: the post pass is per-pixel, 2x/3x screens would cost 2-4x for little gain.
    dpr: Math.min(window.devicePixelRatio || 1, 1.5),
    // paintDiv: paint grid = canvas / 4 (Lusion ">> 2", Edan's 1/4 grid).  lowDiv: blurred grid = canvas / 8 (">> 3").
    paintDiv: 4, lowDiv: 8,
    // float8: false = half-float paint targets (signed velocity, smooth fades); true = 8-bit like Lusion (velocity
    // stored biased around 0.5, fades step in 1/255 increments — that is why floorW exists). Forced true when the
    // GPU cannot render to half-float.
    float8: !halfOK,
    // brush — a capsule from the previous pointer position to the current one.
    //   max radius = max(brushRadius, viewportWidth / brushVw) CSS px. Lusion: max(40, width / 20) -> 72 px at 1440 wide,
    //   40 px on a phone. brushVw: 0 switches the viewport rule off (then brushRadius is the max radius).
    brushRadius: 40, brushVw: 20,
    brushMin: 0,                            // css px radius at the slightest movement (Lusion maps travel 0 -> radius 0)
    speedFull: 100,                         // css px of pointer travel per 60 fps frame that gives the max radius (Lusion: 100)
    brushVel: 0.8,                          // brush velocity gain: each frame v += step(paint px) × dt × brushVel  (Lusion 0.8)
    brushAccel: 0.8,                        // brush velocity momentum: v × brushAccel per 60 fps frame (Lusion 0.8, ~5× one step at steady speed)
    brushSoft: 1.0,                         // 0 = hard capsule edge, 1 = fully soft cone (Lusion: smoothstep from 0 to radius)
    segmentsPerFrame: 4,                    // sub-frame pointer samples painted as separate capsules (ours, not Lusion's)
    // scroll paint: the scroll delta × scrollPaint is added to the brush (×3 for the radius test, ×1 for the velocity),
    // so scrolling with a still mouse paints a streak. 0 = off. Lusion's offset ratio is 1 by default and sections
    // scale it between 0 and 1. The paint itself always follows the page while it scrolls.
    scrollPaint: 1.0,
    // field
    pushStrength: 25,                       // self-advection: texels upstream along the blurred field per unit of velocity (Lusion 25)
    blurRadius: 8, blurPasses: 1,           // the 1/8 copy's Gaussian: radius in low texels, H+V passes (Lusion "blur(8, 1)")
    // Per-frame multipliers at 60 fps (made frame-rate independent with pow(x, dt*60) in paintPass):
    // dissV  - velocity      (0.975 -> half-life ≈ 0.45 s)
    // dissW1 - weight 1, the long soft tail   (0.95 -> ≈ 0.23 s)
    // dissW2 - weight 2, the crisp head       (0.8  -> ≈ 0.05 s)
    dissV: 0.975, dissW1: 0.95, dissW2: 0.8,
    // Minimum amount a weight drops per frame, so tails reach exactly 0 instead of fading forever (Lusion 0.004 ≈ 1/255).
    floorW: 0.004,
    // Curl-noise wobble of the advection lookup: offset in texels = curl × (weight1 + weight2) × noise.
    // noiseScale = noise frequency per paint texel. Lusion (gradient noise): strength 3, scale 0.02.
    noise: 3, noiseScale: 0.02,
    // distortion (post). Velocity here is "normalised": stored velocity × 2 × average weight, so -1..1.
    distort: 60,                            // css px the page is dragged along the velocity at |v| = 1 (Lusion: 4 of its 15 px steps)
    domDistort: 1.0,                        // multiplier of the offset on content (text/images) vs the page
    blur: 60,                               // 9-tap directional blur: ± css px around the dragged point (taps span 0..2×distort)
    jitter: 1.0,                            // per-pixel random shift of the taps, in tap steps (Lusion: blue noise, 1 step)
    rgbShift: 0.5,                          // phase spread of the 3-channel sine fringe (Lusion 0.5)
    fringe: 12.5,                           // strength of that fringe (Lusion: shade 1.25 × colour multiplier 10)
    refract: 0,                             // glass extra: px displacement per unit weight-gradient (rim). 0 in the Lusion preset
    chroma: 0,                              // glass extra: per-channel offset of the displacement. 0 in the Lusion preset
    // look (glass extras, all 0 in the Lusion preset — see the "Lusion + glass" preset in gui.js)
    // rim: strength of the holographic contour bands at stroke edges.  bands: how many bands per unit of weight.
    rim: 0, bands: 18.0,
    // Pale blue-white multiply over the stroke body (on the page only, not on images/text).
    bodyTint: [0.94, 0.955, 0.995], bodyStrength: 0,
    // Additive white from weight 2, i.e. a soft sheen right behind the cursor.
    highlight: 0,
    // Page colour drawn into the scene (should match --page in style.css).
    paper: [1, 1, 1],
  };
  // o = the live option object; fluid.set() mutates it, every pass reads it each frame.
  const o = Object.assign({}, DEFAULTS, opts);
  if (!halfOK) o.float8 = true;
  // BASE = what "reset" and presets go back to: DEFAULTS + whatever DEFAULTS keys the page passed in. A phone passes
  // { dpr: 1.25, paintDiv: 3 }, so resetting from the panel keeps the phone's 1/3 grid instead of the desktop's 1/4.
  const BASE = Object.assign({}, DEFAULTS);
  for (const key in opts) if (key in DEFAULTS) BASE[key] = opts[key];
  if (!halfOK) BASE.float8 = true;

  // ---------- shaders ----------
  // ---------- GLSL ----------
  // V: full-screen vertex shader. Draws ONE big triangle (-1,-1)(3,-1)(-1,3) that covers the viewport; vUv is 0..1.
  // F(body, head): wraps a fragment-shader body in the WebGL2 boilerplate (version, precision, vUv in, colour out).
  const V = `#version 300 es
  precision highp float; in vec2 a; out vec2 vUv;
  void main(){ vUv = a*0.5+0.5; gl_Position = vec4(a,0.,1.); }`;
  const F = (body, head = '') => `#version 300 es
  precision highp float; precision highp sampler2D; in vec2 vUv; out vec4 o; ${head}
  void main(){ ${body} }`;

  // NOISE: tiny value noise + its curl. curl(p) = (dN/dy, -dN/dx) is divergence-free, so nudging the lookup
  // along it swirls the stroke without making it grow or shrink.
  const NOISE = `
  vec3 hash3(vec2 p){ vec3 q = vec3(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3)), dot(p,vec2(419.2,371.9))); return fract(sin(q)*43758.5453); }
  float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
    float a = hash3(i).x, b = hash3(i+vec2(1,0)).x, c = hash3(i+vec2(0,1)).x, d = hash3(i+vec2(1,1)).x;
    return mix(mix(a,b,u.x), mix(c,d,u.x), u.y); }
  vec2 curl(vec2 p){ float e = 0.01; float n1 = vnoise(p + vec2(0,e)), n2 = vnoise(p - vec2(0,e)), n3 = vnoise(p + vec2(e,0)), n4 = vnoise(p - vec2(e,0)); return vec2(n1-n2, -(n3-n4)) / (2.*e); }`;

  // 1. paint: capsule brush + self-advection + decay (+ curl noise)
  // PASS 1 — PAINT. Uniforms:
  //   uPrev      last frame's paint (read side of the ping-pong)      uLow   blurred low-res paint (pass 2)
  //   texel      1 / paint size (uv per paint pixel)                  size   paint size in px
  //   from, to   capsule ends in paint px (y up)                      rFrom, rTo  radius at each end (paint px)
  //   brushVel   velocity the brush adds under the capsule            strength    0..1 brush opacity (0 = no brush)
  //   soft       edge softness (0 hard .. 1 soft cone)                scrollUv    this frame's scroll, in uv (y up)
  //   pushStrength  texels of self-advection (already × dt*60)        dissV/dissW1/dissW2  decay (already pow'd by dt)
  //   floorW     minimum weight drop this frame                       noise, noiseScale, time  curl wobble
  //   bias       0 for half-float targets, 0.5 for 8-bit (velocity is stored as v + 0.5 there)
  const PAINT = F(`
    // Self-advection: move the lookup BACKWARDS (upstream) along the blurred velocity (semi-Lagrangian), so the
    // paint flows in the direction it is moving. Using the blurred 1/8 copy instead of the sharp one is the
    // trick from Edan's comment: it spreads the stroke into a widening wake and keeps it from tearing.
    // scrollUv shifts every lookup by this frame's scroll, so the paint stays glued to the page.
    vec2 uv0 = vUv - scrollUv;
    vec4 low = texture(uLow, uv0);
    vec2 lowVel = low.xy - bias;                          // signed velocity of the blurred field
    float lowAmt = low.z + low.w;                         // how much paint is around (0..2)
    vec2 off = -lowVel * pushStrength;                    // in paint texels, upstream
    // Curl-noise wobble of the sampling position (the shape drifts and curls, the velocity never grows).
    // The noise domain is pushed around by the local velocity, so the swirls follow the stroke.
    vec2 q = vUv * size * noiseScale + lowVel * 6.0 + vec2(time * 0.02, 0.0);
    off += curl(q) * lowAmt * noise;
    vec4 p = texture(uPrev, uv0 + off * texel);
    vec2 v = p.xy - bias;
    // Capsule brush = distance from this pixel to the segment from -> to:
    //   h = projection of the pixel onto the segment, clamped to 0..1;  d = distance to the closest point.
    // The radius is interpolated along the segment (last frame's radius -> this frame's), so a stroke that
    // speeds up or slows down tapers smoothly instead of stepping.
    vec2 px = vUv * size;                                 // paint-pixel coords
    vec2 pa = px - from, ba = to - from;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0., 1.);
    float d = length(pa - ba * h);
    float r = mix(rFrom, rTo, h);
    float m = r > 0.001 ? 1.0 - smoothstep(r * (1.0 - soft) - 0.01, r, d) : 0.0;
    m *= strength;
    // Velocity: decay, then ADD the brush velocity under the capsule and clamp to ±0.5 (the range an 8-bit channel
    // biased at 0.5 can hold — the same range Lusion works in). Under a moving brush it saturates within a few
    // frames, so the wake carries the stroke's direction at near-full strength and the weights do the fading.
    v = clamp(v * dissV + brushVel * m, vec2(-0.5), vec2(0.5));
    // Weights: drop by the larger of "x (1 - diss)" and floorW (so they reach exactly 0), then add the brush.
    float w1 = max(p.z - max(p.z * (1.0 - dissW1), floorW), 0.0);
    float w2 = max(p.w - max(p.w * (1.0 - dissW2), floorW), 0.0);
    w1 = min(w1 + m, 1.0); w2 = min(w2 + m, 1.0);
    o = vec4(v + bias, w1, w2);`,
    `uniform sampler2D uPrev, uLow; uniform vec2 texel, size, from, to, brushVel, scrollUv; uniform float rFrom, rTo, strength, soft, pushStrength, dissV, dissW1, dissW2, floorW, noise, noiseScale, time, bias; ${NOISE}`);
  // COPY: plain texture copy (paint -> low-res grid; bilinear filtering does the downsample).
  const COPY = F(`o = texture(uT, vUv);`, `uniform sampler2D uT;`);
  // PASS 2 — BLUR: separable Gaussian, 17 taps spread evenly over ±radius low texels (sigma = radius × 0.4).
  // dir = (1,0) horizontal or (0,1) vertical. Bilinear filtering fills in between taps when radius > 8.
  // In 8-bit mode the velocity is biased, but a blur is a weighted average, so the bias survives untouched.
  const BLUR = F(`vec4 s = vec4(0.0); float ws = 0.0;
    for (int i = -8; i <= 8; i++) {
      float t = float(i) / 8.0;                          // -1..1 across the kernel
      float wt = exp(-t * t * 3.125);                   // Gaussian with sigma 0.4 of the radius
      s += texture(uT, vUv + dir * texel * radius * t) * wt; ws += wt;
    }
    o = s / ws;`, `uniform sampler2D uT; uniform vec2 texel, dir; uniform float radius;`);

  // 3. scene quads (images + text) — plain draw, rounded corners, reveal mask
  // PASS 3 — SCENE quads. QV places a unit quad on screen: rect = (x, y, w, h) in clip space, computed in JS
  // from the element's getBoundingClientRect(). vUv is flipped so (0,0) is the element's top-left, like the DOM.
  const QV = `#version 300 es
  precision highp float; in vec2 a; out vec2 vUv; uniform vec4 rect; /* x,y,w,h in clip space */
  void main(){ vUv = vec2(a.x*0.5+0.5, 0.5 - a.y*0.5); vec2 p = rect.xy + (a*0.5+0.5)*rect.zw; gl_Position = vec4(p, 0., 1.); }`;
  // QF draws an image or a text texture into that quad. Uniforms:
  //   uImg       the texture                   imgAspect  cover-fit scale (like object-fit: cover)
  //   sizePx     quad size in device px        radiusPx   CSS border-radius in device px (rounded corners)
  //   reveal     0..1 image intro (zoom 1.10 -> 1.0 + diagonal wipe)     alpha  overall fade
  //   isText     1 for headline textures (no cover-fit, no zoom, no corners)
  const QF = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o;
  uniform sampler2D uImg; uniform vec2 imgAspect, sizePx; uniform float reveal, radiusPx, alpha, isText;
  // Signed distance to a rounded rectangle (negative inside). Used as an anti-aliased mask so GL corners match the CSS radius.
  float sdRoundedBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return min(max(q.x,q.y),0.0) + length(max(q,0.0)) - r; }
  void main(){
    vec2 uv = (vUv - 0.5) * imgAspect + 0.5;
    float scale = mix(1.10, 1.0, reveal); uv = (uv - 0.5) * scale + 0.5;
    if (isText > 0.5) uv = vUv;
    vec4 c = texture(uImg, uv);
    if (isText > 0.5) c.a = min(1.0, c.a * 1.25);   // canvas text rasterises a touch lighter than the DOM's; this matches the weight
    // Reveal mask: a soft diagonal edge that sweeps from bottom-left to top-right as reveal goes 0 -> 1.
    float edge = isText > 0.5 ? 1.0 : smoothstep(0.0, 0.22, reveal*1.25 - (vUv.y*0.6 + (1.0-vUv.x)*0.4));
    float d = sdRoundedBox((vUv - 0.5) * sizePx, sizePx * 0.5, radiusPx);
    float corner = isText > 0.5 ? 1.0 : 1.0 - smoothstep(-1.0, 1.0, d);
    o = vec4(c.rgb, c.a * edge * corner * alpha);
  }`;

  // 4. post: velocity drag + directional blur + sine fringe (+ optional glass extras)
  // PASS 4 — POST. Uniforms:
  //   uPaint    paint buffer (velocity xy, weights zw)      uScene  the scene from pass 3
  //   ptexel    1 / paint size                              stexel  uv per CSS px of the canvas
  //   distort   css px of drag at |velocity| = 1            domDistort  extra factor on images/text
  //   blur      ± css px of directional blur around it      jitter  random shift of the 9 taps, in tap steps
  //   rgbShift  phase spread of the sine fringe             fringe  its strength
  //   refract   uv offset per unit weight gradient (rim)    chroma  per-channel displacement split
  //   rim, bands  holographic contour lines                 bodyTint, bodyStrength, highlight  glassy body + sheen
  //   bias      0 (half-float) or 0.5 (8-bit)               time    animates the jitter
  const POST = F(`
    vec4 pt = texture(uPaint, vUv);
    vec2 vel = pt.xy - bias; float w = pt.z, w2 = pt.w;
    // Normalised velocity: stored velocity (±0.5) × 2 × the average of both weights -> -1..1. The fresh head
    // (weight 2) makes the leading stroke bend hardest; once it is gone the soft tail keeps a gentler drag.
    float wAvg = 0.5 * (w + w2);
    vec2 nv = vel * 2.0 * wAvg;
    // Central differences of weight 1 -> its gradient g. Large only at the stroke's edge (used by the glass extras).
    float wl = texture(uPaint, vUv - vec2(ptexel.x, 0.)).z, wr = texture(uPaint, vUv + vec2(ptexel.x, 0.)).z;
    float wb = texture(uPaint, vUv - vec2(0., ptexel.y)).z, wt = texture(uPaint, vUv + vec2(0., ptexel.y)).z;
    vec2 g = vec2(wr - wl, wt - wb);                       // gradient of the stroke weight (the rim)
    float gl2 = length(g);
    // Scene alpha says what is under the pixel: 0 = bare page, 1 = image/text quad. Lets text and images distort by a different amount (domDistort).
    float content0 = texture(uScene, vUv).a;               // what is under this pixel: 0 page, 1 image/text
    float dm = mix(1.0, domDistort, content0);
    // Read the scene UPSTREAM of the motion (minus sign), so what is under the stroke is dragged along with the cursor.
    vec2 flowUv = -nv * distort * dm * stexel;
    vec2 rimUv = g * refract * stexel;                     // glass extra: offset along the weight gradient
    vec2 disp = flowUv + rimUv;
    // 9 taps of directional blur along the velocity, centred on the dragged point: with blur == distort the taps run
    // from this pixel to 2 × distort upstream — Lusion's "9 steps from here along the velocity" layout.
    // j is per-pixel hash noise that shifts all taps (up to jitter steps), trading banding for fine grain.
    vec2 bdir = -nv * blur * stexel;                       // directional blur vector
    float j = (fract(sin(dot(gl_FragCoord.xy + fract(time) * 61.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * jitter;
    vec3 col = vec3(0.); float content = 0.0;
    vec2 base = vUv + disp;
    for (int i = 0; i < 9; i++) {
      float t = (float(i) - 4.0 + j) / 4.0;               // -1..1 across the blur
      vec2 uv = base + bdir * t;
      // chroma > 0: R reads slightly ahead and B slightly behind the displacement -> thin chromatic fringes.
      col.r += texture(uScene, uv + disp * chroma).r;
      vec4 c = texture(uScene, uv); col.g += c.g; content += c.a;
      col.b += texture(uScene, uv - disp * chroma).b;
    }
    col /= 9.0; content /= 9.0;
    float page = 1.0 - content * 0.75;                     // the glassy tint lives on the page; images/text mostly just refract
    // Oil fringe: three sine waves of the velocity, phase-shifted per channel by rgbShift, scaled by speed.
    // wake = 1 - smoothstep(-0.9, 0.4, wAvg): strongest where the weight is low, gone above 0.4 — so the colour
    // only shows in the fading wake, never on the fresh stroke.
    float wake = 1.0 - smoothstep(-0.9, 0.4, wAvg);
    col += sin(vec3((nv.x + nv.y) * 40.0) + vec3(0.0, 2.0, 4.0) * rgbShift) * wake * max(abs(nv.x), abs(nv.y)) * fringe;
    // Glass extras (0 in the Lusion preset): pale body (multiply) + highlight (add), both mostly on the page.
    col = mix(col, col * bodyTint, clamp(w * bodyStrength, 0., 1.) * page);
    col += w2 * highlight * page;
    // holographic bands: contour lines of the weight field, only where the field changes (edges)
    float sv = length(nv) * 2.4;
    float edge = smoothstep(0.0, 0.08, gl2);
    vec3 holo = (sin(w * bands + sv + vec3(0.0, 2.1, 4.2)) * 0.5 + 0.5) * vec3(1.0, 1.0, 0.55);
    col -= holo * rim * edge * page;                       // on a light page: thin pastel lines (pink / cyan); on a dark one: faint glow
    o = vec4(col, 1.);`,
    `uniform sampler2D uPaint, uScene; uniform vec2 ptexel, stexel; uniform float distort, domDistort, refract, blur, jitter, chroma, rgbShift, fringe, rim, bands, bodyStrength, highlight, time, bias; uniform vec3 bodyTint;`);

  // ---------- GL plumbing ----------
  // compile/program: build a program and collect every active uniform location into p.u[name],
  // so passes can write P.paint.u.radius etc. without manual getUniformLocation calls.
  function compile(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { throw new Error('shader: ' + gl.getShaderInfoLog(s)); } return s; }
  function program(vs, fs) {
    const p = gl.createProgram(); gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }
  // All five programs, compiled once. A GLSL error throws here -> main.js catches it and shows the static page.
  const P = { paint: program(V, PAINT), copy: program(V, COPY), blur: program(V, BLUR), quad: program(QV, QF), post: program(V, POST) };

  // vao: the single full-screen triangle (3 verts).  qvao: a unit quad (2 triangles, 6 verts) for the DOM-synced scene quads.
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const qvao = gl.createVertexArray(); gl.bindVertexArray(qvao);
  const qbuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, qbuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(vao);

  // fbo: a texture + framebuffer pair. attach(i) binds the texture to unit i and returns i, so a uniform can be
  // set in one line: gl.uniform1i(loc, target.attach(0)).
  // pingpong: two fbos that swap roles each pass (read last frame, write this frame) — a texture cannot be read
  // and written in the same draw.
  function fbo(w, h, internal, format, type, filter) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return { t, f, w, h, ok, texel: [1 / w, 1 / h], attach(i) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); return i; } };
  }
  function pingpong(w, h, internal, format, type, filter) { let r = fbo(w, h, internal, format, type, filter), wr = fbo(w, h, internal, format, type, filter); return { get read() { return r; }, get write() { return wr; }, swap() { const x = r; r = wr; wr = x; }, w, h, texel: r.texel, ok: r.ok && wr.ok }; }

  // S holds the render targets: S.paint (ping-pong, 1/4 res), S.low (ping-pong, 1/8 res, blurred), S.scene (full res).
  // They are recreated whenever the canvas size, a grid divisor or the precision changes (the old ones are freed).
  // textDirty = headlines need re-rasterising.
  // Paint/low targets: RGBA16F (half-float) or, with o.float8, RGBA8 like Lusion. In 8-bit the velocity is stored
  // as v + 0.5 (BIAS), so "still" must be cleared to (0.5, 0.5, 0, 0), not to zero.
  let S = {}, textDirty = false, BIAS = 0;
  function freeTarget(t) { if (!t) return; for (const x of (t.read ? [t.read, t.write] : [t])) { gl.deleteTexture(x.t); gl.deleteFramebuffer(x.f); } }
  function initTargets() {
    freeTarget(S.paint); freeTarget(S.low); freeTarget(S.scene);
    const pw = Math.max(8, Math.round(canvas.width / o.paintDiv)), ph = Math.max(8, Math.round(canvas.height / o.paintDiv));
    const lw = Math.max(4, Math.round(canvas.width / o.lowDiv)), lh = Math.max(4, Math.round(canvas.height / o.lowDiv));
    const eight = !!o.float8 || !halfOK;
    BIAS = eight ? 0.5 : 0;
    const mk = eight ? (w, h) => pingpong(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR)
                     : (w, h) => pingpong(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
    S.paint = mk(pw, ph); S.low = mk(lw, lh);
    S.scene = fbo(canvas.width, canvas.height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    if (!(S.paint.ok && S.low.ok && S.scene.ok)) throw new Error('fbo incomplete');
    if (eight) for (const x of [S.paint.read, S.paint.write, S.low.read, S.low.write]) { gl.bindFramebuffer(gl.FRAMEBUFFER, x.f); gl.viewport(0, 0, x.w, x.h); gl.clearColor(0.5, 0.5, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
  }
  // resize(): match the drawing buffer to the CSS size × dpr, capped at the GPU's max size (very tall viewports).
  const MAXSZ = Math.min(4096, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 4096);
  function resize() {
    const cap = Math.min(1, MAXSZ / Math.max(1, canvas.clientWidth, canvas.clientHeight) / o.dpr);
    const d = o.dpr * cap;
    const w = Math.max(1, Math.floor(canvas.clientWidth * d)), h = Math.max(1, Math.floor(canvas.clientHeight * d));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; initTargets(); textDirty = true; }
  }
  resize();

  // draw: bind a target (or the screen when target is null) and draw the full-screen triangle with prog.
  function draw(prog, target) {
    gl.useProgram(prog.p);
    if (target) { gl.bindFramebuffer(gl.FRAMEBUFFER, target.f); gl.viewport(0, 0, target.w, target.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---------- pointer ----------
  // CSS px → paint px. Pointer samples queue up (pointermove can arrive several times per frame, getCoalescedEvents more);
  // each frame paints up to `segmentsPerFrame` capsules prev→next through the queue, so a fast flick is a curve, not a chord.
  // touching: the current stroke comes from a finger (scroll paint is off then — on a phone the finger IS the scroll).
  let queue = [], prevPt = null, touching = false;
  function pointer(x, y, isTouch = false) { touching = !!isTouch; if (!prevPt) { prevPt = [x, y]; return; } queue.push([x, y]); if (queue.length > 24) queue.splice(0, queue.length - 24); }
  function pointerLeave() { prevPt = null; queue.length = 0; touching = false; }

  // Brush state carried between frames:
  //   bv      the brush velocity (paint px), a leaky integrator like Lusion's: bv = bv × 0.8 + step × dt × 0.8
  //   lastR   last frame's radius (paint px) — each capsule's radius ramps from lastR to this frame's
  //   lastScroll  window.scrollY at the previous frame (null until the first frame)
  let bv = [0, 0], lastR = 0, lastScroll = null;

  // One PAINT pass. from/to are CSS px (y down); they are converted to paint px with y flipped (GL y is up).
  // k = paint px per CSS px. When dt is 0 (an extra segment in the same frame) advection, noise and decay are
  // switched off so a fast flick painted as 4 segments does not decay 4 times. scrollUv (uv, y up) is applied only
  // on the frame's first pass for the same reason.
  function paintPass(from, to, r0, r1, strength, vel, dt, now, scrollUv) {
    const k = S.paint.w / canvas.clientWidth, H = canvas.clientHeight;
    gl.useProgram(P.paint.p);
    gl.uniform1i(P.paint.u.uPrev, S.paint.read.attach(0)); gl.uniform1i(P.paint.u.uLow, S.low.read.attach(1));
    gl.uniform2f(P.paint.u.texel, S.paint.texel[0], S.paint.texel[1]); gl.uniform2f(P.paint.u.size, S.paint.w, S.paint.h);
    gl.uniform2f(P.paint.u.from, from ? from[0] * k : -99, from ? (H - from[1]) * k : -99);
    gl.uniform2f(P.paint.u.to, to ? to[0] * k : -99, to ? (H - to[1]) * k : -99);
    gl.uniform2f(P.paint.u.brushVel, vel[0], vel[1]);
    gl.uniform1f(P.paint.u.rFrom, r0); gl.uniform1f(P.paint.u.rTo, r1);
    gl.uniform1f(P.paint.u.strength, strength); gl.uniform1f(P.paint.u.soft, o.brushSoft);
    gl.uniform2f(P.paint.u.scrollUv, 0, dt > 0 ? scrollUv : 0);
    const f = dt * 60;    // frame-rate independent decay (tuned at 60 fps); extra segment passes in the same frame carry no decay
    // push and noise are per-frame displacements too, so they scale with f (a 120 Hz frame moves the paint half as far)
    gl.uniform1f(P.paint.u.pushStrength, o.pushStrength * f);
    gl.uniform1f(P.paint.u.dissV, Math.pow(o.dissV, f)); gl.uniform1f(P.paint.u.dissW1, Math.pow(o.dissW1, f)); gl.uniform1f(P.paint.u.dissW2, Math.pow(o.dissW2, f));
    gl.uniform1f(P.paint.u.floorW, o.floorW * f); gl.uniform1f(P.paint.u.noise, o.noise * f); gl.uniform1f(P.paint.u.noiseScale, o.noiseScale); gl.uniform1f(P.paint.u.time, now * 0.001);
    gl.uniform1f(P.paint.u.bias, BIAS);
    draw(P.paint, S.paint.write); S.paint.swap();
  }
  // Turn this frame's queued pointer samples (and this frame's scroll) into capsules.
  //  1. travel = this frame's pointer path length in CSS px, normalised to a 60 fps frame (÷ dt*60).
  //  2. scroll paint: the scroll delta × scrollPaint is added to the pointer's motion — ×3 for the radius test
  //     (Lusion's "×3 viewport"), ×1 for the velocity — so a still mouse over a scrolling page paints a streak
  //     (the capsule shrinks to a dot at the cursor, and the page-glued paint stretches it as the page moves).
  //  3. radius = brushMin → max radius, linear in travel from 0 to speedFull px; exactly 0 when nothing moved.
  //     max radius = max(brushRadius, viewport width / brushVw).
  //  4. brush velocity: bv × brushAccel^f + step(paint px) × dt × brushVel, once per frame.
  //  5. paint the segments; each adds bv / segments so 4 sub-frame capsules don't add 4× the velocity.
  // No movement and no scroll -> one pass with no brush (the field still advects and decays).
  function stepPaint(now, dt) {
    const k = S.paint.w / canvas.clientWidth, f = dt * 60;
    // scroll since last frame (CSS px, + = page moved up). Big jumps (anchor links) still move the paint with the page,
    // but only ±200 px of it counts towards the brush.
    const sy = window.scrollY || 0; const ds = lastScroll === null ? 0 : sy - lastScroll; lastScroll = sy;
    const scrollUv = ds / Math.max(1, canvas.clientHeight);
    const sPaint = prevPt && !touching ? Math.max(-200, Math.min(200, ds)) * o.scrollPaint : 0;
    // collapse the queue to at most segmentsPerFrame points (keep the last one exact)
    let pts = queue; queue = [];
    if (pts.length > o.segmentsPerFrame) { const step = pts.length / o.segmentsPerFrame; const q = []; for (let i = 1; i <= o.segmentsPerFrame; i++) q.push(pts[Math.min(pts.length - 1, Math.round(i * step) - 1)]); pts = q; }
    if (!prevPt) pts = [];
    // a single segment longer than 600 css px in one frame is a teleport (tab switch, pointer re-entering), not a flick: skip it
    if (pts.length && Math.hypot(pts[0][0] - prevPt[0], pts[0][1] - prevPt[1]) > 600) { prevPt = pts.shift(); }
    let travel = 0, netX = 0, netY = 0, q = prevPt;
    for (const p of pts) { const dx = p[0] - q[0], dy = p[1] - q[1]; if (Math.hypot(dx, dy) > 600) break; travel += Math.hypot(dx, dy); netX += dx; netY += dy; q = p; }
    const fr = Math.max(f, 1e-3);
    const radTravel = Math.hypot(travel, 3 * sPaint) / fr;                      // per 60 fps frame, scroll counted ×3
    const maxR = Math.max(o.brushRadius, o.brushVw > 0 ? canvas.clientWidth / o.brushVw : 0);
    const R = radTravel > 0.01 ? (o.brushMin + (maxR - o.brushMin) * Math.min(1, radTravel / o.speedFull)) * k : 0;
    // leaky brush velocity (paint px, y flipped: GL up). The scroll term moves the "cursor" down the page.
    const ka = Math.pow(o.brushAccel, f), g = dt * o.brushVel;
    bv = [bv[0] * ka + netX * k * g, bv[1] * ka - (netY + sPaint) * k * g];
    if (!R) { lastR = 0; paintPass(null, null, 0, 0, 0, [0, 0], dt, now, scrollUv); return; }
    if (!pts.length) {      // still pointer, scrolling page: a dot at the cursor (the page-glued paint turns it into a streak)
      paintPass(prevPt, prevPt, lastR || R, R, 1, bv, dt, now, scrollUv); lastR = R; return;
    }
    const n = pts.length; let first = true, i = 0;
    for (const p of pts) {
      if (Math.hypot(p[0] - prevPt[0], p[1] - prevPt[1]) > 600) { prevPt = p; i++; continue; }
      const r0 = lastR + (R - lastR) * (i / n), r1 = lastR + (R - lastR) * ((i + 1) / n);
      paintPass(prevPt, p, r0, r1, 1, [bv[0] / n, bv[1] / n], first ? dt : 0, now, scrollUv);
      prevPt = p; first = false; i++;
    }
    if (first) paintPass(null, null, 0, 0, 0, [0, 0], dt, now, scrollUv);       // every segment was a teleport: still advance the field
    lastR = R;
  }
  // PASS 2: paint -> low-res copy, then blurPasses × (horizontal + vertical) Gaussian of radius blurRadius on the low grid.
  function blurPass() {
    gl.useProgram(P.copy.p); gl.uniform1i(P.copy.u.uT, S.paint.read.attach(0)); draw(P.copy, S.low.write); S.low.swap();
    gl.useProgram(P.blur.p); gl.uniform2f(P.blur.u.texel, S.low.texel[0], S.low.texel[1]); gl.uniform1f(P.blur.u.radius, o.blurRadius);
    for (let i = 0; i < o.blurPasses; i++) {
      gl.uniform1i(P.blur.u.uT, S.low.read.attach(0)); gl.uniform2f(P.blur.u.dir, 1, 0); draw(P.blur, S.low.write); S.low.swap();
      gl.uniform1i(P.blur.u.uT, S.low.read.attach(0)); gl.uniform2f(P.blur.u.dir, 0, 1); draw(P.blur, S.low.write); S.low.swap();
    }
  }

  // ---------- DOM-synced quads: images ----------
  // ---------- DOM <-> GL sync: images ----------
  // Any element with data-gl-image="url" becomes a GL quad. The <img> inside it stays in the DOM (layout, alt text,
  // no-GL fallback); once the texture is uploaded the element gets .is-gl and CSS fades the <img> to opacity 0.
  // Every frame drawScene() reads el.getBoundingClientRect() and puts the quad exactly there, so the GL image
  // follows layout, responsive CSS and scrolling for free. An IntersectionObserver starts its reveal (target = 1).
  const images = [];   // { el, tex, aspect, reveal, target }
  function loadImage(el) {
    const src = el.dataset.glImage; const img = new Image(); img.crossOrigin = 'anonymous';
    const entry = { el, tex: null, aspect: 1, reveal: 0, target: 0 };
    img.onload = () => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.generateMipmap(gl.TEXTURE_2D);
      entry.tex = t; entry.aspect = img.naturalWidth / img.naturalHeight; el.classList.add('is-gl');
    };
    img.src = src; images.push(entry); return entry;
  }
  document.querySelectorAll('[data-gl-image]').forEach(loadImage);
  const io = new IntersectionObserver((es) => es.forEach(e => { const it = images.find(i => i.el === e.target); if (it && e.isIntersecting) it.target = 1; }), { threshold: 0.15 });
  images.forEach(i => io.observe(i.el));

  // ---------- DOM-synced quads: text (Lusion's trick: DOM keeps layout, GL draws the pixels) ----------
  // Each [data-gl-text] element is rasterised line by line (it has been split into .line > span by main.js, or is a single block)
  // into a 2D canvas at device resolution, matched to the DOM's own line boxes, then drawn as a quad in the scene.
  const texts = [];    // { el, tex, w, h, alpha, on }
  const tcan = document.createElement('canvas'), tctx = tcan.getContext('2d', { willReadFrequently: false });
  // Rasterise one headline: canvas sized to the element's box at device resolution, font copied from computed
  // style, and each line drawn at the position of the DOM's own line box (a Range rect per .line span), with a
  // tiny horizontal scale to absorb canvas-vs-DOM width differences. Baseline = line box top + font ascent.
  function rasterText(entry) {
    const el = entry.el, r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    const d = canvas.width / canvas.clientWidth;
    const W = Math.min(4096, Math.ceil(r.width * d)), Hh = Math.min(4096, Math.ceil(r.height * d));
    tcan.width = W; tcan.height = Hh; tctx.clearRect(0, 0, W, Hh);
    const cs = getComputedStyle(el);
    tctx.fillStyle = el.dataset.glColor || cs.color.replace(/rgba?\(([^)]*)\)/, (m, a) => { const p = a.split(/[\s,\/]+/).filter(Boolean); return `rgb(${p[0]},${p[1]},${p[2]})`; });
    tctx.textBaseline = 'alphabetic';
    const ls = cs.letterSpacing && cs.letterSpacing !== 'normal' ? cs.letterSpacing : '0px';
    if ('letterSpacing' in tctx) tctx.letterSpacing = ls;
    const lines = el.querySelectorAll('.line > span, .wd'); const nodes = lines.length ? [...lines] : [el];
    const fontPx = parseFloat(cs.fontSize);
    tctx.font = `${cs.fontStyle} ${cs.fontWeight} ${fontPx * d}px ${cs.fontFamily}`;
    for (const n of nodes) {
      const text = n.textContent; if (!text.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(n); const rr = range.getBoundingClientRect();   // the glyph box of this line's text
      if (!rr.width) continue;
      const m = tctx.measureText(text);
      const fontAsc = (m.fontBoundingBoxAscent || fontPx * d * 0.97);
      const baseline = (rr.top - r.top) * d + fontAsc;         // a text range's rect is the font's content box: baseline = top + ascent
      const x = (rr.left - r.left) * d;
      const want = rr.width * d, have = m.width || 1;
      tctx.save(); tctx.translate(x, baseline); if (Math.abs(want / have - 1) < 0.2) tctx.scale(want / have, 1); tctx.fillText(text, 0, 0); tctx.restore();
    }
    if (!entry.tex) entry.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, entry.tex); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tcan);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    entry.w = r.width; entry.h = r.height; entry.ready = true; return true;
  }
  // Text entries start hidden (alpha 0, on false). main.js calls showText(el) after the CSS line-reveal has played;
  // then the quad fades in and the DOM copy gets .is-gl (color: transparent). The DOM text is still there for
  // selection, find-in-page and screen readers — you just see the GL pixels, which the fluid can bend.
  function addText(el) { const e = { el, tex: null, alpha: 0, on: false, ready: false }; texts.push(e); return e; }
  document.querySelectorAll('[data-gl-text]').forEach(addText);
  // main.js calls refreshText() after the split/reveal; `on` flips the DOM copy to transparent and fades the quad in
  function refreshText(which) { for (const t of texts) { if (which && t !== which) continue; t.ready = false; t.el.classList.remove('is-gl'); } textDirty = true; }
  function showText(el, on = true) { const t = texts.find(x => x.el === el); if (t) t.on = on; }
  let lastW = innerWidth; addEventListener('resize', () => { if (innerWidth !== lastW) { lastW = innerWidth; setTimeout(() => refreshText(), 60); } });

  // PASS 3 — SCENE. Clear to the page colour with alpha 0, then draw every visible image and text quad with
  // alpha blending (alpha 1 where there is content). place(r) converts a DOMRect (CSS px, y down) into clip space.
  // Quads off-screen (with a 40px margin) are skipped. Because main.js calls render() right after it writes the
  // scroll position, the rects are always this frame's — the GL layer never lags the DOM.
  function drawScene(now) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, S.scene.f); gl.viewport(0, 0, S.scene.w, S.scene.h);
    gl.clearColor(o.paper[0], o.paper[1], o.paper[2], 0); gl.clear(gl.COLOR_BUFFER_BIT);   // alpha 0 = bare page, 1 = a GL quad (image/text): the post pass tints the page, not the content
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(P.quad.p); gl.bindVertexArray(qvao);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const place = (r) => gl.uniform4f(P.quad.u.rect, (r.left / W) * 2 - 1, 1 - (r.bottom / H) * 2, (r.width / W) * 2, (r.height / H) * 2);
    for (const it of images) {
      if (!it.tex) continue;
      const r = it.el.getBoundingClientRect(); if (r.bottom < -40 || r.top > H + 40) continue;
      it.reveal += ((api.enabled ? it.target : 0) - it.reveal) * 0.05;
      place(r);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, it.tex); gl.uniform1i(P.quad.u.uImg, 0);
      const boxA = r.width / r.height, ia = it.aspect;
      gl.uniform2f(P.quad.u.imgAspect, boxA > ia ? 1 : boxA / ia, boxA > ia ? ia / boxA : 1);
      gl.uniform1f(P.quad.u.reveal, it.reveal); gl.uniform1f(P.quad.u.alpha, 1); gl.uniform1f(P.quad.u.isText, 0);
      const d = canvas.width / W;
      gl.uniform2f(P.quad.u.sizePx, r.width * d, r.height * d); gl.uniform1f(P.quad.u.radiusPx, (parseFloat(getComputedStyle(it.el).borderRadius) || 0) * d);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    // Rasterise pending headlines only once web fonts are loaded (otherwise the canvas would use the fallback font). If a text box changed size, it is re-rasterised.
    if (textDirty && document.fonts && document.fonts.status === 'loaded') { textDirty = false; for (const t of texts) if (!t.ready) { if (!rasterText(t)) textDirty = true; } }
    for (const t of texts) {
      if (!t.ready) continue;
      const r = t.el.getBoundingClientRect(); if (r.bottom < -40 || r.top > H + 40) continue;
      if (Math.abs(r.width - t.w) > 1 || Math.abs(r.height - t.h) > 1) { t.ready = false; textDirty = true; continue; }
      const want = t.on ? 1 : 0; t.alpha += (want - t.alpha) * 0.12;
      if (t.on && !t.el.classList.contains('is-gl')) t.el.classList.add('is-gl');
      if (!t.on && t.alpha < 0.02 && t.el.classList.contains('is-gl')) t.el.classList.remove('is-gl');
      if (t.alpha < 0.01) continue;
      place(r);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.uniform1i(P.quad.u.uImg, 0);
      gl.uniform2f(P.quad.u.imgAspect, 1, 1); gl.uniform1f(P.quad.u.reveal, 1); gl.uniform1f(P.quad.u.alpha, t.alpha); gl.uniform1f(P.quad.u.isText, 1);
      gl.uniform2f(P.quad.u.sizePx, 1, 1); gl.uniform1f(P.quad.u.radiusPx, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.bindVertexArray(vao); gl.disable(gl.BLEND);
  }

  // PASS 4 — POST to the screen. distort and blur are CSS px at |normalised velocity| = 1, independent of paintDiv
  // and dpr; stexel converts CSS px to uv.
  function post(now) {
    gl.useProgram(P.post.p);
    gl.uniform1i(P.post.u.uPaint, S.paint.read.attach(0)); gl.uniform1i(P.post.u.uScene, S.scene.attach(1));
    gl.uniform2f(P.post.u.ptexel, S.paint.texel[0], S.paint.texel[1]);
    const d = canvas.width / canvas.clientWidth;          // px (css) → uv
    gl.uniform2f(P.post.u.stexel, d / canvas.width, d / canvas.height);
    gl.uniform1f(P.post.u.distort, o.distort); gl.uniform1f(P.post.u.domDistort, o.domDistort);
    gl.uniform1f(P.post.u.refract, o.refract); gl.uniform1f(P.post.u.blur, o.blur); gl.uniform1f(P.post.u.jitter, o.jitter);
    gl.uniform1f(P.post.u.chroma, o.chroma); gl.uniform1f(P.post.u.rgbShift, o.rgbShift); gl.uniform1f(P.post.u.fringe, o.fringe);
    gl.uniform1f(P.post.u.rim, o.rim); gl.uniform1f(P.post.u.bands, o.bands); gl.uniform1f(P.post.u.bias, BIAS);
    gl.uniform1f(P.post.u.bodyStrength, o.bodyStrength); gl.uniform1f(P.post.u.highlight, o.highlight); gl.uniform1f(P.post.u.time, (now * 0.001) % 100); gl.uniform3fv(P.post.u.bodyTint, o.bodyTint);
    draw(P.post, null);
  }

  // ---------- loop ----------
  // ---------- loop ----------
  // dt is clamped (1 ms .. 50 ms) so a background tab or a long frame cannot explode the decay maths.
  // Rendering pauses while the tab is hidden (visibilitychange).
  let raf = 0, prev = performance.now(), visible = true;
  function render(now) {           // call this once per frame, AFTER scroll/layout writes, so the GL quads never lag the DOM
    if (!visible) return;
    const dt = o.fixedDt || Math.min(0.05, Math.max(0.001, (now - prev) / 1000)); prev = now;
    resize();
    gl.disable(gl.BLEND);
    if (!o.hold) { stepPaint(now, dt); blurPass(); }   // hold: freeze the paint (used for deterministic frame capture), keep drawing
    drawScene(now);
    post(now);
  }
  function frame(now) { raf = requestAnimationFrame(frame); render(now); }
  if (!o.manual) raf = requestAnimationFrame(frame);
  const onVis = () => { visible = !document.hidden; prev = performance.now(); };
  document.addEventListener('visibilitychange', onVis);

  // ---------- public API ----------
  // set(): any option, live. Changing paintDiv / lowDiv / dpr / float8 forces the render targets to be rebuilt.
  const api = {
    enabled: false,
    pointer, pointerLeave, resize, render,
    addImage: loadImage, addText, refreshText, showText,
    set(q) { const re = ['paintDiv', 'lowDiv', 'dpr', 'float8'].some(k => k in q && q[k] !== o[k]); Object.assign(o, q); if (!halfOK) o.float8 = true; if (re) { canvas.width = 0; resize(); } },
    // defaults = DEFAULTS + the device options the page passed to createFluid (see BASE), a fresh copy each time
    get defaults() { return Object.assign({}, BASE); },
    settings() { const out = {}; for (const k of Object.keys(DEFAULTS)) if (!['dpr', 'paper'].includes(k)) out[k] = o[k]; return out; },
    destroy() { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis); gl.getExtension('WEBGL_lose_context')?.loseContext(); },
    get options() { return o; },
    get halfFloat() { return halfOK; },
    get precision() { return BIAS ? '8-bit' : 'half-float'; },
    stats() {   // debug: read the paint buffer back (max |v|, max w, coverage). 8-bit targets read as bytes and are rescaled.
      gl.bindFramebuffer(gl.FRAMEBUFFER, S.paint.read.f); const w = S.paint.w, h = S.paint.h; let px;
      try {
        if (BIAS) { const b = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b); px = Float32Array.from(b, (x) => x / 255); }
        else { px = new Float32Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px); }
      } catch (e) { return { error: e.message }; }
      let maxV = 0, maxW = 0, cov = 0, sumW = 0; for (let i = 0; i < px.length; i += 4) { const v = Math.hypot(px[i] - BIAS, px[i + 1] - BIAS); if (v > maxV) maxV = v; if (px[i + 2] > maxW) maxW = px[i + 2]; if (px[i + 2] > 0.05) cov++; sumW += px[i + 2]; }
      return { w, h, maxV, maxW, coverage: cov / (w * h), meanW: sumW / (w * h), precision: BIAS ? '8-bit' : 'half-float', err: gl.getError() };
    },
  };
  return api;
}
