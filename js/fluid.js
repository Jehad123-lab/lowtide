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
     1. PAINT  — ping-pong RGBA16F target at 1/paintDiv of the canvas (default 1/4).
                 A soft capsule brush (2D segment distance field) from the previous pointer position to the
                 current one writes:   .xy = velocity (paint px / frame, signed -> needs half-float)
                                       .z  = "slow" weight (the body of the stroke, fades over ~2-3 s)
                                       .w  = "fast" weight (a short-lived highlight right behind the cursor)
                 Every texel then advects itself along a BLURRED low-res copy of the velocity (step 2 of the
                 previous frame) — that is what makes strokes spread, float and get wavy edges — decays per
                 channel (dissV / dissW1 / dissW2) and gets a little curl-noise wobble.
     2. BLUR   — copy the paint into a 1/lowDiv grid (default 1/8) and run a separable 9-tap Gaussian
                 blurPasses times. Step 1 reads this next frame.
     3. SCENE  — full-res RGBA8 target: the page colour (alpha 0) + DOM-synced GL quads (alpha 1):
                 images ([data-gl-image]) and headlines ([data-gl-text], rasterised to a 2D canvas).
                 The DOM copies stay in the page for layout, selection and screen readers — they are just
                 made invisible (opacity 0 on the <img>, color: transparent on the text) once GL draws them.
     4. POST   — full-screen pass to the visible canvas: refract the scene along the paint-weight gradient
                 (thin glassy rim) + along the velocity (slow smear), 9-tap jittered directional blur along the
                 velocity, per-channel offsets (chromatic fringe), Lusion-style sine RGB shift, a pale body
                 tint + highlight, and thin holographic contour bands only at the stroke's edges.

   TWO ENGINES (options.model)
     'v3'        the default and the look on the live site: everything described above, tuned by eye against
                 frame-by-frame recordings of lusion.co (notes in the study, round 2b).
     'handbook'  an optional engine used by the "Handbook (v4)" preset in the panel: the same 4 passes, but with
                 the behaviour and numbers measured in the "Lusion.co Decoded" client-side handbook by shifatmasud
                 (chapter "Special: Cursor fluid trail (ScreenPaint)"). Our own code; only the numbers were used:
                   brush       max radius max(40, viewportWidth / 20) CSS px, radius from pointer travel 0 -> 100 px
                               per frame, 0 when still; soft cone edge
                   velocity    leaky brush velocity v = v x 0.8 + step x dt x 0.8, ADDED under the brush, clamped ±0.5
                   fades       per 60 fps frame: velocity 0.975 (~0.45 s half-life), tail 0.95 (~0.23 s), head 0.8
                               (~0.05 s), minimum step 0.004
                   field       push 25 texels, blur(8, 1) on the 1/8 copy (17-tap Gaussian, radius 8), noise 3 @ 0.02
                   post        page dragged UPSTREAM along velocity x 2 x average weight; 9 taps spanning 0..8 steps of
                               ~15 CSS px (distort 60 + blur 60); 3-phase sine fringe only where weight < 0.4
                   precision   optional 8-bit targets (velocity biased at 0.5) like Lusion — float8
     Scroll paint (scrollPaint, both engines, default 0 = off so the default stays exactly v3): the scroll delta is
     added to the brush (x3 for the radius / speed, x1 for the velocity), so scrolling with a still mouse paints a
     streak, and the paint lookups follow the scroll so the trail stays stuck to the page.

   API
     const fluid = createFluid(canvas, options)   // returns null when WebGL2 / half-float targets are missing
       fluid.enabled            set true when the page is ready (images fade/zoom in only after that)
       fluid.pointer(x, y, isTouch)  feed pointer positions in CSS px (call as often as you get them);
                                isTouch marks a finger stroke (scroll paint is off for those)
       fluid.pointerLeave()     end the current stroke (pointer left / finger lifted)
       fluid.render(now)        draw one frame (when options.manual is true you drive the loop yourself)
       fluid.resize()           re-measure the canvas (also done automatically every frame)
       fluid.addImage(el)       register a [data-gl-image] element added after start-up
       fluid.addText(el)        register a [data-gl-text] element added after start-up
       fluid.refreshText(el?)   re-rasterise headline(s) (after a re-split / resize / font load)
       fluid.showText(el, on)   hand a headline to GL (on=true) or back to the DOM (on=false)
       fluid.set({...})         change any option live (used by the lil-gui panel in gui.js)
       fluid.settings()         current tunable values as a plain object (for "copy settings JSON")
       fluid.defaults           DEFAULTS + the device options the page passed in (a phone's dpr, paint grid, brush),
                                so the panel's reset / presets keep the device-appropriate quality
       fluid.options / fluid.halfFloat / fluid.precision / fluid.stats() / fluid.destroy()

   THREE PITFALLS WE HIT TUNING v3 (AND WHERE THE FIX LIVES)
     1. Additive curl noise accumulates. Adding noise to the stored velocity every frame makes it grow without
        limit, and the whole screen starts swimming. Fix: the noise only perturbs WHERE the paint shader samples
        the previous frame (see "push += curl(...)" in PAINT), weighted by the stroke's own weight. The shape
        drifts but the velocity never grows. The brush also SETS the velocity under the capsule (mix) instead of
        adding to it.
     2. Hitch frames become giant velocities. After a long frame or a tab switch, the pointer "jumps" hundreds of
        px in one step, and that reads as a huge flick. Fix: stepPaint() caps each segment's pointer delta at 44 CSS px
        before it becomes velocity, and the frame loop clamps dt to 1..50 ms.
     3. Frame-rate-dependent decay. Multiplying by 0.985 per frame fades twice as fast at 120 Hz as at 60 Hz.
        Fix: the dissipations are tuned at 60 fps and applied as pow(x, dt*60) in paintPass() (floorW is scaled
        by the same factor). Extra sub-frame segments painted in the same frame get dt = 0, so they add brush
        strokes without adding decay, advection or noise.

   INPUT (main.js feeds this)
     Mouse/pen: every getCoalescedEvents() sample goes to fluid.pointer(), and up to segmentsPerFrame capsules
     are painted per frame, so a fast flick is a curve, not a straight chord. Touch: touchstart ends the old
     stroke and starts a new one, touchmove carries velocity, and touchend / touchcancel end the stroke.

   KNOBS — see DEFAULTS below, every one is commented. The ones you will touch most:
     brushMin / brushRadius (stroke size), pushStrength (spread), dissV / dissW1 (how long it lingers),
     distort / refract / blur (how strongly the page bends), chroma / rgbShift / rim (colour fringes).
   ===================================================================================================== */
// canvas: the <canvas> to draw into (main.js uses a fixed, full-viewport, pointer-events:none canvas behind the page).
// opts:   any subset of DEFAULTS below (whatever the page passes here also becomes this device's "defaults"),
//         plus  manual (true = no internal rAF; call render(now) yourself),
//         hold (freeze the paint, for frame captures) and fixedDt (force a constant timestep).
export function createFluid(canvas, opts = {}) {
  // alpha:false -> the canvas is opaque (the post pass writes the full page colour itself);
  // no AA / depth / stencil: everything here is full-screen triangles and 2D quads.
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  if (!gl) return null;
  // Rendering INTO half-float textures needs one of these extensions. The paint buffer stores signed velocity,
  // which an 8-bit target cannot hold (Lusion packs it into 8 bits; half-float is simpler and more precise).
  const extHalf = gl.getExtension('EXT_color_buffer_half_float');
  const extFloat = gl.getExtension('EXT_color_buffer_float');
  const halfOK = !!(extHalf || extFloat);
  if (!halfOK) return null;                      // caller falls back to the static page (signed velocity needs a half-float target)
  // Lets float textures be sampled with LINEAR filtering where the driver needs it (half-float is filterable in WebGL2).
  gl.getExtension('OES_texture_float_linear');

  // ---------- tunable options ----------
  // All sizes are in CSS px so they look the same on every DPR; they are converted to paint / device px below.
  const DEFAULTS = {
    // Canvas resolution multiplier. Capped at 1.5: the post pass is per-pixel, 2x/3x screens would cost 2-4x for little gain.
    dpr: Math.min(window.devicePixelRatio || 1, 1.5),
    // paintDiv: paint grid = canvas / 4 (Edan's 1/4 grid).  lowDiv: blurred grid = canvas / 8.
    // blurPasses: how many H+V Gaussian passes the low grid gets (more = softer, wider spread).
    paintDiv: 4, lowDiv: 8, blurPasses: 3,
    // brush (Lusion: capsule prev→current, radius from pointer speed, nothing painted when still)
    brushMin: 14, brushRadius: 64,          // css px radius at zero / full speed
    speedFull: 40,                          // css px per frame that counts as "full speed"
    brushVel: 0.6,                          // pointer delta → stored velocity (× this)
    brushSoft: 0.45,                        // 0 = hard capsule edge, 1 = fully soft
    segmentsPerFrame: 4,                    // sub-frame pointer samples painted as separate capsules
    // field
    pushStrength: 1.1,                      // self-advection along the blurred low-res field (× velocity)
    // Per-frame multipliers at 60 fps (made frame-rate independent with pow(x, dt*60) in paintPass):
    // dissV  - velocity      (0.985 -> velocity halves in ~0.8 s)
    // dissW1 - slow weight   (0.99  -> the visible stroke lingers ~2-3 s)
    // dissW2 - fast weight   (0.8   -> highlight gone in a few frames)
    dissV: 0.985, dissW1: 0.99, dissW2: 0.8,
    // Subtracted from the slow weight every frame so tails reach exactly 0 instead of fading forever.
    floorW: 0.0012,
    // Curl-noise wobble of the advection lookup (strength, spatial frequency). Makes edges organic, not blobby.
    noise: 0.25, noiseScale: 3.0,
    // distortion (post)
    distort: 10,                            // css px of UV offset per unit velocity (Lusion: amount 20 × 1.25)
    domDistort: 1.0,                        // multiplier of the offset on content (text/images) vs the page
    refract: 24,                            // px displacement per unit weight-gradient (glassy rim)
    blur: 2.5,                              // 9-tap directional blur: ± velocity × this, css px
    jitter: 0.8,                            // blue-noise-ish jitter of the taps (0..1)
    chroma: 0.3,                            // per-channel offset of the displacement
    rgbShift: 0.35,                         // Lusion's sine RGB shift from velocity
    // look
    // rim: strength of the holographic contour bands at stroke edges.  bands: how many bands per unit of weight.
    rim: 0.10, bands: 18.0,
    // Pale blue-white multiply over the stroke body (on the page only, not on images/text).
    bodyTint: [0.94, 0.955, 0.995], bodyStrength: 1.0,
    // Additive white from the fast weight, i.e. a soft sheen right behind the cursor.
    highlight: 0.06,
    // Page colour drawn into the scene (should match --page in style.css).
    paper: [1, 1, 1],
    // scroll paint (both engines): scroll delta × this is added to the brush; 0 = off (and no page-stick), so the
    // default is exactly v3. The "Handbook (v4)" preset uses 1.
    scrollPaint: 0,
    // engine: 'v3' (default, the live look) or 'handbook' (the "Handbook (v4)" preset). See the header.
    model: 'v3',
    // Only read by the handbook engine (their handbook values; the v3 engine ignores them):
    brushVw: 20,                            // max radius = max(brushRadius, viewport width / brushVw); 0 = off
    brushAccel: 0.8,                        // brush velocity momentum per 60 fps frame (leaky integrator)
    blurRadius: 8,                          // Gaussian radius of the 1/8 copy, in low texels ("blur(8, 1)")
    fringe: 12.5,                           // strength of the sine fringe in the wake (shade 1.25 × colour multiplier 10)
    float8: false,                          // 8-bit paint targets like Lusion (velocity stored biased at 0.5)
  };
  // o = the live option object; fluid.set() mutates it, every pass reads it each frame.
  const o = Object.assign({}, DEFAULTS, opts);
  // BASE = what the panel's "reset" and presets go back to: DEFAULTS + every DEFAULTS key the page passed in. A phone
  // passes { dpr: 1.25, paintDiv: 3, ... }, so a reset on a phone keeps its 1/3 grid instead of the desktop's 1/4.
  const BASE = Object.assign({}, DEFAULTS);
  for (const key in opts) if (key in DEFAULTS) BASE[key] = opts[key];

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
  //   from, to   capsule ends in paint px (y up). -99 = "no stroke this frame"
  //   brushVel   velocity the brush writes (paint px / frame)         rFrom, rTo  capsule radius at each end (paint px; v3: equal)
  //   strength   0..1 brush opacity (scaled by pointer speed)         soft   edge softness (0 hard .. 1 soft)
  //   pushStrength  self-advection amount     dissV/dissW1/dissW2  per-channel decay (already pow'd by dt)
  //   floorW     weight floor this frame (v3: subtracted; handbook: minimum drop)   noise, noiseScale, time  curl wobble
  //   scrollUv   this frame's scroll in uv (y up), 0 unless scrollPaint > 0 — the paint follows the page
  //   hb         0 = v3 engine, 1 = handbook engine        bias  0 (half-float) or 0.5 (8-bit, handbook only)
  const PAINT = F(`
    vec2 uv0 = vUv - scrollUv;                            // scrollUv is 0 unless scroll paint is on
    vec4 low = texture(uLow, uv0);
    vec4 p;
    vec2 px = vUv * size;                                 // paint-pixel coords
    // Capsule brush = distance from this pixel to the segment from -> to:
    //   h = projection of the pixel onto the segment, clamped to 0..1;  d = distance to the closest point.
    // Inside radius -> 1, outside -> 0, with a smoothstep edge whose width is set by soft.
    vec2 pa = px - from, ba = to - from;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0., 1.);
    float d = length(pa - ba * h);
    if (hb < 0.5) {
      // ---- v3 engine (the default) ----
      // Self-advection: move the lookup BACKWARDS along the blurred velocity (semi-Lagrangian), so the
      // paint flows in the direction it is moving. Using the blurred copy instead of the sharp one is the
      // trick from Edan's comment: it spreads the stroke and keeps it from tearing.
      vec2 push = low.xy * pushStrength * texel;           // advect along the blurred field
      push += curl(vUv * noiseScale + time * 0.05) * noise * texel * low.z;   // curl-noise wobble of the sampling position (shape drifts, velocity does not grow)
      p = texture(uPrev, uv0 - push);
      float radius = rTo;
      float m = 1.0 - smoothstep(radius * (1.0 - soft), radius, d);  // capsule, edge softness
      m *= strength;
      // Velocity: decay, then blend toward the brush velocity under the capsule (mix, not add, so holding
      // the mouse in one spot never accumulates a runaway value).
      // Weights: decay minus a small floor, then max() with the brush mask so the stroke is fully on where
      // the brush just passed. w2 decays much faster (and with a 3x floor) -> the short highlight.
      vec2 v = p.xy * dissV;
      v = mix(v, brushVel, m);                              // the brush SETS the velocity under the capsule (no runaway accumulation)
      float w1 = max(p.z * dissW1 - floorW, 0.0); w1 = max(w1, m);
      float w2 = max(p.w * dissW2 - floorW * 3.0, 0.0);  w2 = max(w2, m);
      o = vec4(v, w1, w2);
    } else {
      // ---- handbook engine (optional, "Handbook (v4)" preset) ----
      // Same idea, measured numbers: the lookup goes pushStrength texels upstream along the blurred field, plus a
      // curl offset scaled by how much paint is around (w1 + w2); the noise domain is pushed by the local
      // velocity so swirls follow the stroke.
      vec2 lowVel = low.xy - bias;                          // signed velocity of the blurred field
      vec2 off = -lowVel * pushStrength;                    // in paint texels, upstream
      off += curl(px * noiseScale + lowVel * 6.0 + vec2(time * 0.02, 0.0)) * (low.z + low.w) * noise;
      p = texture(uPrev, uv0 + off * texel);
      vec2 v = p.xy - bias;
      // radius ramps from last frame's to this frame's along the segment, so speed changes taper smoothly
      float r = mix(rFrom, rTo, h);
      float m = r > 0.001 ? (1.0 - smoothstep(r * (1.0 - soft) - 0.01, r, d)) * strength : 0.0;
      // velocity: decay, ADD the brush velocity, clamp to ±0.5 (an 8-bit channel biased at 0.5 holds exactly that)
      v = clamp(v * dissV + brushVel * m, vec2(-0.5), vec2(0.5));
      // weights: drop by the larger of x(1 - diss) and floorW (so they reach exactly 0), then add the brush
      float w1 = max(p.z - max(p.z * (1.0 - dissW1), floorW), 0.0);
      float w2 = max(p.w - max(p.w * (1.0 - dissW2), floorW), 0.0);
      o = vec4(v + bias, min(w1 + m, 1.0), min(w2 + m, 1.0));
    }`,
    `uniform sampler2D uPrev, uLow; uniform vec2 texel, size, from, to, brushVel, scrollUv; uniform float rFrom, rTo, strength, soft, pushStrength, dissV, dissW1, dissW2, floorW, noise, noiseScale, time, hb, bias; ${NOISE}`);
  // COPY: plain texture copy (paint -> low-res grid; bilinear filtering does the downsample).
  const COPY = F(`o = texture(uT, vUv);`, `uniform sampler2D uT;`);
  // PASS 2 — BLUR (v3 engine): separable 9-tap Gaussian done with 5 bilinear fetches (the classic linear-sampling offsets
  // 1.3846 / 3.2308 and weights .2270 / .3162 / .0703). dir = (1,0) horizontal or (0,1) vertical.
  const BLUR = F(`vec4 s = texture(uT, vUv) * 0.2270270270;
    s += (texture(uT, vUv + dir*texel*1.3846153846) + texture(uT, vUv - dir*texel*1.3846153846)) * 0.3162162162;
    s += (texture(uT, vUv + dir*texel*3.2307692308) + texture(uT, vUv - dir*texel*3.2307692308)) * 0.0702702703;
    o = s;`, `uniform sampler2D uT; uniform vec2 texel, dir;`);
  // PASS 2 — BLUR (handbook engine): 17 taps spread evenly over ±radius low texels, Gaussian with sigma 0.4 × radius.
  // A blur is a weighted average, so the 8-bit velocity bias survives it untouched.
  const BLURR = F(`vec4 s = vec4(0.0); float ws = 0.0;
    for (int i = -8; i <= 8; i++) {
      float t = float(i) / 8.0;                          // -1..1 across the kernel
      float wt = exp(-t * t * 3.125);
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

  // 4. post: refraction + directional blur + chromatic fringe + holographic rim
  // PASS 4 — POST. Uniforms:
  //   uPaint    paint buffer (velocity xy, weights zw)      uScene  the scene from pass 3
  //   ptexel    1 / paint size                              stexel  uv per CSS px of the canvas
  //   distort   uv offset per unit velocity (smear)         domDistort  extra factor on images/text
  //   refract   uv offset per unit weight gradient (rim)    blur    length of the directional blur
  //   jitter    random offset of the 9 taps (hides banding) chroma  per-channel displacement split
  //   rgbShift  sine RGB tint from speed                    rim, bands  holographic contour lines
  //   bodyTint, bodyStrength, highlight  the pale glass body + sheen      time  animates the jitter
  //   hb        0 = v3 engine, 1 = handbook engine        bias, fringe  handbook only (8-bit bias, sine fringe strength)
  const POST = F(`
    vec4 pt = texture(uPaint, vUv);
    vec2 vel = pt.xy - bias; float w = pt.z, w2 = pt.w;
    // Handbook engine: normalised velocity = stored velocity (±0.5) × 2 × the average of both weights, and the
    // scene is read UPSTREAM (minus sign), so what is under the stroke is dragged along with the cursor.
    vec2 nv = vel * 2.0 * 0.5 * (w + w2);
    vec2 mv = hb > 0.5 ? -nv : vel;                        // v3: the stored velocity as is
    // Central differences of the slow weight -> its gradient g. It is large only at the stroke's edge, which is where a lens of liquid would refract most.
    float wl = texture(uPaint, vUv - vec2(ptexel.x, 0.)).z, wr = texture(uPaint, vUv + vec2(ptexel.x, 0.)).z;
    float wb = texture(uPaint, vUv - vec2(0., ptexel.y)).z, wt = texture(uPaint, vUv + vec2(0., ptexel.y)).z;
    vec2 g = vec2(wr - wl, wt - wb);                       // gradient of the stroke weight (the rim)
    float gl2 = length(g);
    // Scene alpha says what is under the pixel: 0 = bare page, 1 = image/text quad. Lets text and images distort by a different amount (domDistort).
    float content0 = texture(uScene, vUv).a;               // what is under this pixel: 0 page, 1 image/text
    float dm = mix(1.0, domDistort, content0);
    vec2 flowUv = mv * distort * dm * stexel;              // Lusion's offset: velocity × amount (× weight is already in vel's decay)
    vec2 rimUv = g * refract * stexel;                     // glassy rim: offset along the weight gradient
    vec2 disp = flowUv + rimUv;
    // 9-tap directional blur along the velocity (Lusion's ScreenPaintDistortion idea). Each tap reads
    // R slightly ahead and B slightly behind the displacement -> thin oily chromatic fringes.
    // j is per-pixel hash noise that shifts all taps a little, trading banding for fine grain.
    vec2 bdir = mv * blur * stexel;                        // directional blur vector
    float j = (fract(sin(dot(gl_FragCoord.xy + fract(time) * 61.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * jitter;
    vec3 col = vec3(0.); float content = 0.0;
    vec2 base = vUv + disp;
    for (int i = 0; i < 9; i++) {
      float t = (float(i) - 4.0 + j) / 4.0;               // -1..1 across the blur
      vec2 uv = base + bdir * t;
      col.r += texture(uScene, uv + disp * chroma).r;
      vec4 c = texture(uScene, uv); col.g += c.g; content += c.a;
      col.b += texture(uScene, uv - disp * chroma).b;
    }
    col /= 9.0; content /= 9.0;
    float page = 1.0 - content * 0.75;                     // the glassy tint lives on the page; images/text mostly just refract
    // Lusion's velocity-driven sine RGB shift (a tint that rides the smear), kept gentle
    float sv = length(vel);
    if (hb < 0.5) col += sin(sv * 1.4 + vec3(0.0, 2.0, 4.0)) * rgbShift * 0.08 * clamp(sv, 0., 1.) * w;
    // handbook: 3 phase-shifted sines of the velocity, only in the fading wake (1 - smoothstep(-0.9, 0.4, weight)
    // is strongest where the weight is low and gone above 0.4), scaled by speed and fringe
    else col += sin(vec3((nv.x + nv.y) * 40.0) + vec3(0.0, 2.0, 4.0) * rgbShift) * (1.0 - smoothstep(-0.9, 0.4, 0.5 * (w + w2))) * max(abs(nv.x), abs(nv.y)) * fringe;
    float svh = hb > 0.5 ? length(nv) * 2.4 : sv * 0.6;
    // pale glassy body + fast highlight
    // Pale glassy body (multiply) + highlight (add), both mostly on the page so photos are not washed out.
    col = mix(col, col * bodyTint, clamp(w * bodyStrength, 0., 1.) * page);
    col += w2 * highlight * page;
    // holographic bands: contour lines of the weight field, only where the field changes (edges)
    float edge = smoothstep(0.0, 0.08, gl2);
    vec3 holo = (sin(w * bands + svh + vec3(0.0, 2.1, 4.2)) * 0.5 + 0.5) * vec3(1.0, 1.0, 0.55);
    col -= holo * rim * edge * page;                       // on a light page: thin pastel lines (pink / cyan); on a dark one: faint glow
    o = vec4(col, 1.);`,
    `uniform sampler2D uPaint, uScene; uniform vec2 ptexel, stexel; uniform float distort, domDistort, refract, blur, jitter, chroma, rgbShift, rim, bands, bodyStrength, highlight, time, hb, bias, fringe; uniform vec3 bodyTint;`);

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
  // All six programs, compiled once. A GLSL error throws here -> main.js catches it and shows the static page.
  const P = { paint: program(V, PAINT), copy: program(V, COPY), blur: program(V, BLUR), blurR: program(V, BLURR), quad: program(QV, QF), post: program(V, POST) };

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
  // They are recreated whenever the canvas size, a grid, the engine or the precision changes (old ones are freed).
  // textDirty = headlines need re-rasterising.
  // Paint/low are RGBA16F; only the handbook engine with float8 uses RGBA8, with the velocity stored as v + 0.5
  // (BIAS), so "still" is cleared to (0.5, 0.5, 0, 0) there.
  let S = {}, textDirty = false, BIAS = 0;
  function freeTarget(t) { if (!t) return; for (const x of (t.read ? [t.read, t.write] : [t])) { gl.deleteTexture(x.t); gl.deleteFramebuffer(x.f); } }
  function initTargets() {
    freeTarget(S.paint); freeTarget(S.low); freeTarget(S.scene);
    const pw = Math.max(8, Math.round(canvas.width / o.paintDiv)), ph = Math.max(8, Math.round(canvas.height / o.paintDiv));
    const lw = Math.max(4, Math.round(canvas.width / o.lowDiv)), lh = Math.max(4, Math.round(canvas.height / o.lowDiv));
    const eight = o.model === 'handbook' && !!o.float8;
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
  let queue = [], prevPt = null, speed = 0, touching = false;
  function pointer(x, y, isTouch = false) { touching = !!isTouch; if (!prevPt) { prevPt = [x, y]; return; } queue.push([x, y]); if (queue.length > 24) queue.splice(0, queue.length - 24); }
  function pointerLeave() { prevPt = null; queue.length = 0; speed = 0; touching = false; }
  // Handbook engine state: bv = leaky brush velocity (paint px), lastR = last frame's radius (paint px).
  // lastScroll = window.scrollY at the previous painted frame (both engines, for scroll paint).
  let bv = [0, 0], lastR = 0, lastScroll = null;

  // One PAINT pass. from/to are CSS px (y down); they are converted to paint px with y flipped (GL y is up).
  // k = paint px per CSS px. When dt is 0 (an extra segment in the same frame) advection, noise and decay are
  // switched off so a fast flick painted as 4 segments does not decay 4 times (and the scroll shift is applied once).
  // r0 / r1: radius at each end in paint px (the v3 engine passes the same value twice).
  function paintPass(from, to, r0, r1, strength, vel, dt, now, scrollUv = 0) {
    const k = S.paint.w / canvas.clientWidth, H = canvas.clientHeight, hb = o.model === 'handbook';
    gl.useProgram(P.paint.p);
    gl.uniform1i(P.paint.u.uPrev, S.paint.read.attach(0)); gl.uniform1i(P.paint.u.uLow, S.low.read.attach(1));
    gl.uniform2f(P.paint.u.texel, S.paint.texel[0], S.paint.texel[1]); gl.uniform2f(P.paint.u.size, S.paint.w, S.paint.h);
    gl.uniform2f(P.paint.u.from, from ? from[0] * k : -99, from ? (H - from[1]) * k : -99);
    gl.uniform2f(P.paint.u.to, to ? to[0] * k : -99, to ? (H - to[1]) * k : -99);
    gl.uniform2f(P.paint.u.brushVel, vel[0], vel[1]);
    gl.uniform1f(P.paint.u.rFrom, r0); gl.uniform1f(P.paint.u.rTo, r1);
    gl.uniform1f(P.paint.u.strength, strength); gl.uniform1f(P.paint.u.soft, o.brushSoft);
    gl.uniform2f(P.paint.u.scrollUv, 0, dt > 0 ? scrollUv : 0);
    gl.uniform1f(P.paint.u.hb, hb ? 1 : 0); gl.uniform1f(P.paint.u.bias, BIAS);
    const f = dt * 60;    // frame-rate independent decay (tuned at 60 fps); extra segment passes in the same frame carry no decay
    // v3: push and noise are on/off per pass. Handbook: they are per-frame displacements, so they scale with f too.
    gl.uniform1f(P.paint.u.pushStrength, hb ? o.pushStrength * f : (dt > 0 ? o.pushStrength : 0));
    gl.uniform1f(P.paint.u.dissV, Math.pow(o.dissV, f)); gl.uniform1f(P.paint.u.dissW1, Math.pow(o.dissW1, f)); gl.uniform1f(P.paint.u.dissW2, Math.pow(o.dissW2, f));
    gl.uniform1f(P.paint.u.floorW, o.floorW * f);
    gl.uniform1f(P.paint.u.noise, hb ? o.noise * f : (dt > 0 ? o.noise : 0)); gl.uniform1f(P.paint.u.noiseScale, o.noiseScale); gl.uniform1f(P.paint.u.time, now * 0.001);
    draw(P.paint, S.paint.write); S.paint.swap();
  }

  // Scroll since the last painted frame. Returns { scrollUv, s }: scrollUv shifts the paint with the page (uv, y up);
  // s = the CSS px of scroll that count as brush motion (±200 max, × scrollPaint). Both are 0 when scrollPaint is 0,
  // and s is 0 for finger strokes or when the pointer is not on the page.
  function readScroll() {
    const sy = window.scrollY || 0; const ds = lastScroll === null ? 0 : sy - lastScroll; lastScroll = sy;
    if (!(o.scrollPaint > 0)) return { scrollUv: 0, s: 0 };
    return { scrollUv: ds / Math.max(1, canvas.clientHeight), s: prevPt && !touching ? Math.max(-200, Math.min(200, ds)) * o.scrollPaint : 0 };
  }
  function stepPaint(now, dt) { const sc = readScroll(); if (o.model === 'handbook') stepPaintHandbook(now, dt, sc); else stepPaintV3(now, dt, sc); }

  // v3 ENGINE. Turn this frame's queued pointer samples into capsules. Speed is smoothed (speed += (per - speed) * .35)
  // and mapped to 0..1 against speedFull: it grows the radius (brushMin -> brushRadius) and the strength.
  // No movement -> one pass with no brush (the field still advects and decays).
  // Scroll paint (only when scrollPaint > 0): the scroll counts as extra downward motion of the cursor over the
  // page (×3 for speed, ×1 for velocity); a still pointer over a scrolling page paints a dot that the page-glued
  // paint stretches into a streak.
  function stepPaintV3(now, dt, sc) {
    const k = S.paint.w / canvas.clientWidth;
    // collapse the queue to at most segmentsPerFrame points (keep the last one exact)
    let pts = queue; queue = [];
    if (pts.length > o.segmentsPerFrame) { const step = pts.length / o.segmentsPerFrame; const q = []; for (let i = 1; i <= o.segmentsPerFrame; i++) q.push(pts[Math.min(pts.length - 1, Math.round(i * step) - 1)]); pts = q; }
    if ((!pts.length || !prevPt) && prevPt && sc.s) {        // still pointer, scrolling page
      const dist = Math.abs(sc.s);
      speed += (dist * 3 - speed) * 0.35;
      const sp = Math.min(1, speed / o.speedFull);
      const radius = (o.brushMin + (o.brushRadius - o.brushMin) * sp) * k;
      const cl = Math.min(1, 44 / Math.max(dist, 1e-3));
      const r = Math.max(radius, 0.001);
      paintPass(prevPt, prevPt, r, r, Math.min(1, 0.3 + sp * 0.9), [0, -sc.s * cl * o.brushVel * k], dt, now, sc.scrollUv);
      return;
    }
    if (!pts.length || !prevPt) { speed *= 0.8; paintPass(null, null, 0.001, 0.001, 0, [0, 0], dt, now, sc.scrollUv); return; }
    let first = true;
    for (const p of pts) {
      const dx = p[0] - prevPt[0], dy = p[1] - prevPt[1] + (first ? sc.s : 0), dist = Math.hypot(dx, dy);
      const per = dist * (pts.length) + (first ? Math.abs(sc.s) * 2 : 0);   // speed estimate: this frame's total path length (+ scroll ×3 in all)
      speed += (per - speed) * 0.35;
      const sp = Math.min(1, speed / o.speedFull);
      const radius = (o.brushMin + (o.brushRadius - o.brushMin) * sp) * k;
      const strength = dist > 0.15 ? Math.min(1, 0.3 + sp * 0.9) : 0;
      const cl = Math.min(1, 44 / Math.max(dist, 1e-3));     // a hitch (long frame, tab switch) must not become a giant velocity
      const bvv = [dx * cl * o.brushVel * k * pts.length, -dy * cl * o.brushVel * k * pts.length];   // per-frame velocity (y flipped: GL up)
      const r = Math.max(radius, 0.001);
      paintPass(prevPt, p, r, r, strength, bvv, first ? dt : 0, now, sc.scrollUv);
      prevPt = p; first = false;
    }
  }

  // HANDBOOK ENGINE ("Handbook (v4)" preset).
  //  1. travel = this frame's pointer path in CSS px, normalised to a 60 fps frame (÷ dt*60), with the scroll
  //     motion added ×3 for the radius test.
  //  2. radius = brushMin → max radius, linear in travel from 0 to speedFull px; exactly 0 when nothing moved.
  //     max radius = max(brushRadius, viewport width / brushVw)  (handbook: max(40, width / 20)).
  //  3. brush velocity: bv × brushAccel^f + step(paint px) × dt × brushVel, once per frame (a leaky integrator).
  //  4. paint the segments; each adds bv / segments, and the radius ramps from last frame's to this frame's.
  //  A single segment longer than 600 CSS px in one frame is a teleport (tab switch, pointer re-entering): skipped.
  function stepPaintHandbook(now, dt, sc) {
    const k = S.paint.w / canvas.clientWidth, f = dt * 60;
    let pts = queue; queue = [];
    if (pts.length > o.segmentsPerFrame) { const step = pts.length / o.segmentsPerFrame; const q = []; for (let i = 1; i <= o.segmentsPerFrame; i++) q.push(pts[Math.min(pts.length - 1, Math.round(i * step) - 1)]); pts = q; }
    if (!prevPt) pts = [];
    let travel = 0, netX = 0, netY = 0, q = prevPt;
    for (const p of pts) { const dx = p[0] - q[0], dy = p[1] - q[1], dd = Math.hypot(dx, dy); if (dd <= 600) { travel += dd; netX += dx; netY += dy; } q = p; }
    const radTravel = Math.hypot(travel, 3 * sc.s) / Math.max(f, 1e-3);
    const maxR = Math.max(o.brushRadius, o.brushVw > 0 ? canvas.clientWidth / o.brushVw : 0);
    const R = radTravel > 0.01 ? (o.brushMin + (maxR - o.brushMin) * Math.min(1, radTravel / o.speedFull)) * k : 0;
    const ka = Math.pow(o.brushAccel, f), g = dt * o.brushVel;
    bv = [bv[0] * ka + netX * k * g, bv[1] * ka - (netY + sc.s) * k * g];     // y flipped: GL up; scroll = cursor moving down the page
    if (!R) { lastR = 0; paintPass(null, null, 0, 0, 0, [0, 0], dt, now, sc.scrollUv); return; }
    if (!pts.length) { paintPass(prevPt, prevPt, lastR || R, R, 1, bv, dt, now, sc.scrollUv); lastR = R; return; }   // still pointer, scrolling page
    const n = pts.length; let first = true, i = 0;
    for (const p of pts) {
      if (Math.hypot(p[0] - prevPt[0], p[1] - prevPt[1]) <= 600) {
        paintPass(prevPt, p, lastR + (R - lastR) * (i / n), lastR + (R - lastR) * ((i + 1) / n), 1, [bv[0] / n, bv[1] / n], first ? dt : 0, now, sc.scrollUv);
        first = false;
      }
      prevPt = p; i++;
    }
    if (first) paintPass(null, null, 0, 0, 0, [0, 0], dt, now, sc.scrollUv);   // every segment was a teleport: still advance the field
    lastR = R;
  }
  // PASS 2: paint -> low-res copy, then blurPasses × (horizontal + vertical) Gaussian on the low grid.
  // v3 engine: the fixed 9-tap kernel. Handbook engine: the 17-tap kernel of radius blurRadius.
  function blurPass() {
    gl.useProgram(P.copy.p); gl.uniform1i(P.copy.u.uT, S.paint.read.attach(0)); draw(P.copy, S.low.write); S.low.swap();
    const B = o.model === 'handbook' ? P.blurR : P.blur;
    gl.useProgram(B.p); gl.uniform2f(B.u.texel, S.low.texel[0], S.low.texel[1]);
    if (B.u.radius) gl.uniform1f(B.u.radius, o.blurRadius);
    for (let i = 0; i < o.blurPasses; i++) {
      gl.uniform1i(B.u.uT, S.low.read.attach(0)); gl.uniform2f(B.u.dir, 1, 0); draw(B, S.low.write); S.low.swap();
      gl.uniform1i(B.u.uT, S.low.read.attach(0)); gl.uniform2f(B.u.dir, 0, 1); draw(B, S.low.write); S.low.swap();
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

  // PASS 4 — POST to the screen. distort and blur are given in CSS px per unit velocity; k converts the paint-px
  // velocity into CSS px so the look does not change with paintDiv. stexel converts CSS px to uv.
  // Handbook engine: its velocity is already normalised (-1..1), so distort / blur are plain CSS px (no k / 4).
  function post(now) {
    gl.useProgram(P.post.p);
    gl.uniform1i(P.post.u.uPaint, S.paint.read.attach(0)); gl.uniform1i(P.post.u.uScene, S.scene.attach(1));
    gl.uniform2f(P.post.u.ptexel, S.paint.texel[0], S.paint.texel[1]);
    const d = canvas.width / canvas.clientWidth;          // px (css) → uv
    gl.uniform2f(P.post.u.stexel, d / canvas.width, d / canvas.height);
    const hb = o.model === 'handbook';
    const k = hb ? 4 : canvas.clientWidth / S.paint.w;     // velocity is in paint px/frame → css px (handbook: × 1)
    gl.uniform1f(P.post.u.distort, o.distort * k / 4); gl.uniform1f(P.post.u.domDistort, o.domDistort);
    gl.uniform1f(P.post.u.refract, o.refract); gl.uniform1f(P.post.u.blur, o.blur * k / 4); gl.uniform1f(P.post.u.jitter, o.jitter);
    gl.uniform1f(P.post.u.hb, hb ? 1 : 0); gl.uniform1f(P.post.u.bias, BIAS); gl.uniform1f(P.post.u.fringe, o.fringe);
    gl.uniform1f(P.post.u.chroma, o.chroma); gl.uniform1f(P.post.u.rgbShift, o.rgbShift); gl.uniform1f(P.post.u.rim, o.rim); gl.uniform1f(P.post.u.bands, o.bands);
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
  // set(): any option, live. Changing paintDiv / lowDiv / dpr / model / float8 forces the render targets to be rebuilt.
  const api = {
    enabled: false,
    pointer, pointerLeave, resize, render,
    addImage: loadImage, addText, refreshText, showText,
    set(q) { const re = ['paintDiv', 'lowDiv', 'dpr', 'model', 'float8'].some(k => k in q && q[k] !== o[k]); Object.assign(o, q); if (re) { canvas.width = 0; resize(); } },
    // defaults = DEFAULTS + the device options the page passed to createFluid (see BASE), a fresh copy each time
    get defaults() { return Object.assign({}, BASE); },
    settings() { const out = {}; for (const k of Object.keys(DEFAULTS)) if (!['dpr', 'paper'].includes(k)) out[k] = o[k]; return out; },
    destroy() { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis); gl.getExtension('WEBGL_lose_context')?.loseContext(); },
    get options() { return o; },
    get halfFloat() { return halfOK; },
    get precision() { return BIAS ? '8-bit' : 'half-float'; },
    stats() {   // debug: read the paint buffer back (max |v|, max w, coverage). 8-bit targets are read as bytes and rescaled.
      gl.bindFramebuffer(gl.FRAMEBUFFER, S.paint.read.f); const w = S.paint.w, h = S.paint.h; let px;
      try {
        if (BIAS) { const b = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b); px = Float32Array.from(b, (x) => x / 255); }
        else { px = new Float32Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px); }
      } catch (e) { return { error: e.message }; }
      let maxV = 0, maxW = 0, cov = 0, sumW = 0; for (let i = 0; i < px.length; i += 4) { const v = Math.hypot(px[i] - BIAS, px[i + 1] - BIAS); if (v > maxV) maxV = v; if (px[i + 2] > maxW) maxW = px[i + 2]; if (px[i + 2] > 0.05) cov++; sumW += px[i + 2]; }
      return { w, h, maxV, maxW, coverage: cov / (w * h), meanW: sumW / (w * h), model: o.model, precision: BIAS ? '8-bit' : 'half-float', err: gl.getError() };
    },
  };
  return api;
}
