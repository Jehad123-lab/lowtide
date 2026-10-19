/* =====================================================================================================
   Lowtide — js/fluid-navier-stokes.js   (ROUND 1 — kept for reference, not loaded by the site)
   A small stable-fluids simulation (Jos Stam, "Stable Fluids", 1999 — the same family as Pavel Dobryakov's
   well-known WebGL demo and the sim Immersive Garden ships) in raw WebGL2, our own implementation.

   This was the first version of the effect. It is a real incompressible fluid, but on a white page the dye
   reads as coloured ink, not the glassy smear of lusion.co — so round 2 (js/fluid.js) switched to the
   paint-grid method. To try it, import it instead of ./fluid.js — note it runs its own rAF loop and has no
   render() / text API, so the fluid.render(), refreshText() and showText() calls in main.js must be guarded.

   Per frame (all on half-float ping-pong targets at simRes, dye at dyeRes):
     splat      add a Gaussian of velocity (and dye) at each queued pointer sample
     curl       vorticity w = dVy/dx - dVx/dy
     vorticity  confinement: push velocity along grad|w| x w to restore small swirls lost to numerical damping
     divergence how much each cell's velocity flows in/out
     pressure   Jacobi iterations solving  laplacian(p) = divergence  (pressureIterations times)
     gradient   subtract grad(p) from velocity -> velocity becomes divergence-free (incompressible)
     advect     move velocity and dye along velocity (semi-Lagrangian back-trace) with dissipation
   Display: the dye tints the page (ink wash + film grain); [data-gl-image] elements are drawn as DOM-synced quads
   that smear along the local velocity (9-tap directional blur + slight RGB shift).
   Exports: createFluid(canvas, options) -> { enabled, pointer, pointerLeave, resize, setQuality, addImage, destroy, options }
   ===================================================================================================== */
export function createFluid(canvas, opts = {}) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  if (!gl) return null;
  const extHalf = gl.getExtension('EXT_color_buffer_half_float');
  const extFloat = gl.getExtension('EXT_color_buffer_float');
  if (!extHalf && !extFloat) return null;          // caller falls back to the static page
  gl.getExtension('OES_texture_float_linear');

  const o = Object.assign({
    // simRes/dyeRes: grid size on the short side (velocity is coarse, dye is finer).  pressureIterations: Jacobi steps.
    // curl: vorticity confinement strength.  *Dissipation: per-step multipliers.  splatRadius/splatForce: brush.
    // dyeStrength / tint / tint2: ink colour.  smear: how much images streak along the velocity.
    simRes: 128, dyeRes: 512, dpr: Math.min(window.devicePixelRatio || 1, 1.5),
    pressureIterations: 14, curl: 12, velocityDissipation: 0.985, dyeDissipation: 0.975, pressureDissipation: 0.8,
    splatRadius: 0.22, splatForce: 4200, dyeStrength: 0.3,
    tint: [0.98, 0.52, 0.18], tint2: [0.30, 0.36, 0.48], paper: [1, 1, 1],
    smear: 1.0,
  }, opts);

  // ---------- shaders ----------
  // Vertex shader also passes the 4 neighbour uvs (left/right/top/bottom) for the finite-difference passes.
  const V = `#version 300 es
  precision highp float; in vec2 a; out vec2 vUv, vL, vR, vT, vB; uniform vec2 texelSize;
  void main(){ vUv = a*0.5+0.5; vL = vUv - vec2(texelSize.x,0.); vR = vUv + vec2(texelSize.x,0.); vT = vUv + vec2(0.,texelSize.y); vB = vUv - vec2(0.,texelSize.y); gl_Position = vec4(a,0.,1.); }`;
  const F = (body, head = '') => `#version 300 es
  precision highp float; precision highp sampler2D; in vec2 vUv, vL, vR, vT, vB; out vec4 o; ${head}
  void main(){ ${body} }`;

  // SPLAT: add exp(-d^2 / radius) * color around the pointer (aspect-corrected so it is round).
  const SPLAT = F(`vec2 p = vUv - point; p.x *= aspect; vec3 s = exp(-dot(p,p)/radius) * color; vec3 b = texture(uTarget, vUv).xyz; o = vec4(b + s, 1.);`,
    `uniform sampler2D uTarget; uniform float aspect, radius; uniform vec3 color; uniform vec2 point;`);
  // CURL: scalar vorticity from neighbour differences.
  const CURL = F(`float L = texture(uV, vL).y, R = texture(uV, vR).y, T = texture(uV, vT).x, B = texture(uV, vB).x; o = vec4(0.5*(R - L - T + B), 0., 0., 1.);`, `uniform sampler2D uV;`);
  // VORT: vorticity confinement — force along the normalised gradient of |curl|, scaled by curl strength.
  const VORT = F(`float L = texture(uC, vL).x, R = texture(uC, vR).x, T = texture(uC, vT).x, B = texture(uC, vB).x, C = texture(uC, vUv).x;
    vec2 f = 0.5*vec2(abs(T)-abs(B), abs(R)-abs(L)); f /= length(f)+1e-4; f *= curl*C; f.y *= -1.; vec2 v = texture(uV, vUv).xy; v += f*dt; v = clamp(v, -1000., 1000.); o = vec4(v, 0., 1.);`,
    `uniform sampler2D uV, uC; uniform float curl, dt;`);
  // DIV: velocity divergence, with solid-wall boundaries (outside cells mirror the centre velocity).
  const DIV = F(`float L = texture(uV, vL).x, R = texture(uV, vR).x, T = texture(uV, vT).y, B = texture(uV, vB).y; vec2 C = texture(uV, vUv).xy;
    if (vL.x < 0.) L = -C.x; if (vR.x > 1.) R = -C.x; if (vT.y > 1.) T = -C.y; if (vB.y < 0.) B = -C.y; o = vec4(0.5*(R - L + T - B), 0., 0., 1.);`, `uniform sampler2D uV;`);
  // CLEAR: fade last frame's pressure (a warm start for the Jacobi solve).
  const CLEAR = F(`o = value * texture(uT, vUv);`, `uniform sampler2D uT; uniform float value;`);
  // PRESS: one Jacobi iteration of the pressure Poisson equation.
  const PRESS = F(`float L = texture(uP, vL).x, R = texture(uP, vR).x, T = texture(uP, vT).x, B = texture(uP, vB).x; float d = texture(uD, vUv).x; o = vec4((L + R + B + T - d)*0.25, 0., 0., 1.);`, `uniform sampler2D uP, uD;`);
  // GRAD: subtract the pressure gradient -> divergence-free velocity.
  const GRAD = F(`float L = texture(uP, vL).x, R = texture(uP, vR).x, T = texture(uP, vT).x, B = texture(uP, vB).x; vec2 v = texture(uV, vUv).xy; v -= vec2(R - L, T - B); o = vec4(v, 0., 1.);`, `uniform sampler2D uP, uV;`);
  // ADV: semi-Lagrangian advection — sample the source at (uv - dt * velocity) and apply dissipation.
  const ADV = F(`vec2 c = vUv - dt * texture(uV, vUv).xy * texelSize; vec4 r = texture(uS, c); o = vec4(dissipation * r.rgb, 1.);`, `uniform sampler2D uV, uS; uniform float dt, dissipation; uniform vec2 texelSize;`);

  // Page background: paper + ink wash from the dye + a faint grain.
  const BG = F(`vec3 d = texture(uDye, vUv).rgb; float a = clamp(length(d), 0., 1.);
    vec3 ink = mix(tint2, tint, clamp(d.r*1.6 - d.b*0.5, 0., 1.));
    float g = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
    vec3 col = mix(paper, ink, a * 0.5) + g * 0.012;
    o = vec4(col, 1.);`, `uniform sampler2D uDye; uniform vec3 tint, tint2, paper;`);

  // DOM-synced image quad, smeared by the local velocity (Lusion-style directional blur + RGB shift, our own take).
  const IMGV = `#version 300 es
  precision highp float; in vec2 a; out vec2 vUv; out vec2 vScreen; uniform vec4 rect; /* x,y,w,h in clip space */
  void main(){ vUv = vec2(a.x*0.5+0.5, 0.5 - a.y*0.5); vec2 p = rect.xy + (a*0.5+0.5)*rect.zw; vScreen = p*0.5+0.5; gl_Position = vec4(p, 0., 1.); }`;
  const IMGF = `#version 300 es
  precision highp float; in vec2 vUv; in vec2 vScreen; out vec4 o;
  uniform sampler2D uImg, uV; uniform vec2 imgAspect, sizePx; uniform float smear, reveal, time, radiusPx;
  float sdRoundedBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return min(max(q.x,q.y),0.0) + length(max(q,0.0)) - r; }
  float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main(){
    vec2 vel = texture(uV, vScreen).xy;            // sim units (px/frame-ish)
    vec2 v = vel * 0.00045 * smear;                 // to uv
    v = clamp(v, vec2(-0.08), vec2(0.08));
    vec2 uv = (vUv - 0.5) * imgAspect + 0.5;       // cover-fit
    float scale = mix(1.12, 1.0, reveal);           // settle-in zoom on reveal
    uv = (uv - 0.5) * scale + 0.5;
    float j = hash(gl_FragCoord.xy + time) - 0.5;
    vec2 start = uv - v * 0.5 + v * j * 0.12;
    vec3 col = vec3(0.);
    for (int i = 0; i < 9; i++) { col += texture(uImg, start + v * float(i) / 8.0).rgb; }
    col /= 9.0;
    float m = length(vel) * 0.004;
    vec3 shift = vec3(texture(uImg, uv + v*0.9).r, col.g, texture(uImg, uv - v*0.9).b);
    col = mix(col, shift, clamp(m, 0., 1.) * 0.8);
    // soft mask reveal from the bottom-left (clip-ish wipe)
    float edge = smoothstep(0.0, 0.22, reveal*1.25 - (vUv.y*0.6 + (1.0-vUv.x)*0.4));
    float d = sdRoundedBox((vUv - 0.5) * sizePx, sizePx * 0.5, radiusPx);
    float corner = 1.0 - smoothstep(-1.0, 1.0, d);
    o = vec4(col, edge * corner);
  }`;

  function compile(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { throw new Error('shader: ' + gl.getShaderInfoLog(s)); } return s; }
  function program(vs, fs) {
    const p = gl.createProgram(); gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }
  const P = { splat: program(V, SPLAT), curl: program(V, CURL), vort: program(V, VORT), div: program(V, DIV), clear: program(V, CLEAR), press: program(V, PRESS), grad: program(V, GRAD), adv: program(V, ADV), bg: program(V, BG), img: program(IMGV, IMGF) };

  // fullscreen triangle
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  // unit quad for images
  const qvao = gl.createVertexArray(); gl.bindVertexArray(qvao);
  const qbuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, qbuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(vao);

  const linearOK = true; // WebGL2: RGBA16F/RG16F/R16F are filterable
  function fbo(w, h, internal, format, type, filter) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    return { t, f, w, h, ok, texel: [1 / w, 1 / h], attach(i) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); return i; } };
  }
  function pingpong(w, h, internal, format, type, filter) { let r = fbo(w, h, internal, format, type, filter), wr = fbo(w, h, internal, format, type, filter); return { get read() { return r; }, get write() { return wr; }, swap() { const x = r; r = wr; wr = x; }, w, h, texel: r.texel, ok: r.ok && wr.ok }; }

  const HF = gl.HALF_FLOAT;
  let sim, dye, S = {};
  // Targets keep the sim grid's aspect ratio equal to the canvas: simRes is the short side.
  function initTargets() {
    const asp = canvas.width / canvas.height;
    const sw = Math.round(o.simRes * Math.max(asp, 1)), sh = Math.round(o.simRes * Math.max(1 / asp, 1));
    const dw = Math.round(o.dyeRes * Math.max(asp, 1)), dh = Math.round(o.dyeRes * Math.max(1 / asp, 1));
    sim = { w: sw, h: sh, texel: [1 / sw, 1 / sh] };
    S.vel = pingpong(sw, sh, gl.RG16F, gl.RG, HF, gl.LINEAR);
    S.dye = pingpong(dw, dh, gl.RGBA16F, gl.RGBA, HF, gl.LINEAR);
    S.press = pingpong(sw, sh, gl.R16F, gl.RED, HF, gl.NEAREST);
    S.div = fbo(sw, sh, gl.R16F, gl.RED, HF, gl.NEAREST);
    S.curl = fbo(sw, sh, gl.R16F, gl.RED, HF, gl.NEAREST);
    if (!(S.vel.ok && S.dye.ok && S.press.ok && S.div.ok && S.curl.ok)) throw new Error('fbo incomplete');
  }

  const MAXSZ = Math.min(4096, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 4096);
  function resize() {
    const cap = Math.min(1, MAXSZ / Math.max(1, canvas.clientWidth, canvas.clientHeight) / o.dpr);   // keep the drawing buffer inside the GPU's limit on very tall viewports
    const d = o.dpr * cap;
    const w = Math.max(1, Math.floor(canvas.clientWidth * d)), h = Math.max(1, Math.floor(canvas.clientHeight * d));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; initTargets(); }
  }
  resize();

  function draw(prog, target) {
    gl.useProgram(prog.p);
    if (target) { gl.bindFramebuffer(gl.FRAMEBUFFER, target.f); gl.viewport(0, 0, target.w, target.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---------- pointer ----------
  const splats = [];
  let last = null, lastT = 0;
  // Pointer -> splat queue. Movement is clamped per event so a fast flick stays a brush stroke, not an explosion.
  function pointer(x, y, down) {    // x,y in CSS px, relative to the canvas
    const now = performance.now();
    const nx = x / canvas.clientWidth, ny = 1 - y / canvas.clientHeight;
    if (!last) { last = [nx, ny]; lastT = now; return; }
    let dx = (nx - last[0]), dy = (ny - last[1]);
    const dt = Math.max(1, now - lastT) / 16.7;
    last = [nx, ny]; lastT = now;
    const cap = 0.04;                 // like IG's 20px clamp: a flick stays a brush, not a bomb
    dx = Math.max(-cap, Math.min(cap, dx)); dy = Math.max(-cap, Math.min(cap, dy));
    if (Math.abs(dx) + Math.abs(dy) < 1e-5) return;
    splats.push({ x: nx, y: ny, dx: dx * o.splatForce / dt, dy: dy * o.splatForce / dt, speed: Math.hypot(dx, dy) });
  }
  function pointerLeave() { last = null; }

  function splat(s) {
    const asp = canvas.width / canvas.height;
    const sp = Math.min(1, s.speed / 0.03);
    gl.useProgram(P.splat.p);
    gl.uniform1i(P.splat.u.uTarget, S.vel.read.attach(0)); gl.uniform1f(P.splat.u.aspect, asp);
    gl.uniform2f(P.splat.u.point, s.x, s.y); gl.uniform3f(P.splat.u.color, s.dx, s.dy, 0);
    const r = o.splatRadius / 100 * (0.5 + sp);
    gl.uniform1f(P.splat.u.radius, r); draw(P.splat, S.vel.write); S.vel.swap();
    gl.uniform1i(P.splat.u.uTarget, S.dye.read.attach(0));
    const k = o.dyeStrength * (0.35 + sp);
    gl.uniform3f(P.splat.u.color, k, k * 0.55, k * 0.25);
    gl.uniform1f(P.splat.u.radius, r * 0.8); draw(P.splat, S.dye.write); S.dye.swap();
  }

  // One simulation step, in the classic order: splats, curl, vorticity, divergence, pressure solve, gradient subtract, advect velocity, advect dye.
  function step(dt) {
    gl.disable(gl.BLEND);
    for (let i = splats.length - 1; i >= 0; i--) splat(splats.splice(i, 1)[0]);
    const tx = sim.texel;
    gl.useProgram(P.curl.p); gl.uniform2f(P.curl.u.texelSize, tx[0], tx[1]); gl.uniform1i(P.curl.u.uV, S.vel.read.attach(0)); draw(P.curl, S.curl);
    gl.useProgram(P.vort.p); gl.uniform2f(P.vort.u.texelSize, tx[0], tx[1]); gl.uniform1i(P.vort.u.uV, S.vel.read.attach(0)); gl.uniform1i(P.vort.u.uC, S.curl.attach(1)); gl.uniform1f(P.vort.u.curl, o.curl); gl.uniform1f(P.vort.u.dt, dt); draw(P.vort, S.vel.write); S.vel.swap();
    gl.useProgram(P.div.p); gl.uniform2f(P.div.u.texelSize, tx[0], tx[1]); gl.uniform1i(P.div.u.uV, S.vel.read.attach(0)); draw(P.div, S.div);
    gl.useProgram(P.clear.p); gl.uniform1i(P.clear.u.uT, S.press.read.attach(0)); gl.uniform1f(P.clear.u.value, o.pressureDissipation); draw(P.clear, S.press.write); S.press.swap();
    gl.useProgram(P.press.p); gl.uniform2f(P.press.u.texelSize, tx[0], tx[1]); gl.uniform1i(P.press.u.uD, S.div.attach(0));
    for (let i = 0; i < o.pressureIterations; i++) { gl.uniform1i(P.press.u.uP, S.press.read.attach(1)); draw(P.press, S.press.write); S.press.swap(); }
    gl.useProgram(P.grad.p); gl.uniform2f(P.grad.u.texelSize, tx[0], tx[1]); gl.uniform1i(P.grad.u.uP, S.press.read.attach(0)); gl.uniform1i(P.grad.u.uV, S.vel.read.attach(1)); draw(P.grad, S.vel.write); S.vel.swap();
    gl.useProgram(P.adv.p); gl.uniform2f(P.adv.u.texelSize, tx[0], tx[1]); gl.uniform1f(P.adv.u.dt, dt);
    gl.uniform1i(P.adv.u.uV, S.vel.read.attach(0)); gl.uniform1i(P.adv.u.uS, S.vel.read.attach(0)); gl.uniform1f(P.adv.u.dissipation, o.velocityDissipation); draw(P.adv, S.vel.write); S.vel.swap();
    gl.uniform1i(P.adv.u.uV, S.vel.read.attach(0)); gl.uniform1i(P.adv.u.uS, S.dye.read.attach(1)); gl.uniform1f(P.adv.u.dissipation, o.dyeDissipation); draw(P.adv, S.dye.write); S.dye.swap();
  }

  // ---------- DOM-synced images ----------
  const images = [];   // { el, tex, aspect, reveal }
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

  // Images are drawn straight to the screen on top of the background, positioned from getBoundingClientRect() each frame.
  function drawImages(time) {
    if (!images.length) return;
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(P.img.p); gl.bindVertexArray(qvao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    for (const it of images) {
      if (!it.tex) continue;
      const r = it.el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > H) continue;
      it.reveal += ((api.enabled ? it.target : 0) - it.reveal) * 0.05;
      const x = (r.left / W) * 2 - 1, y = 1 - (r.bottom / H) * 2, w = (r.width / W) * 2, h = (r.height / H) * 2;
      gl.uniform4f(P.img.u.rect, x, y, w, h);
      gl.uniform1i(P.img.u.uImg, (gl.activeTexture(gl.TEXTURE0), gl.bindTexture(gl.TEXTURE_2D, it.tex), 0));
      gl.uniform1i(P.img.u.uV, S.vel.read.attach(1));
      const boxA = r.width / r.height, ia = it.aspect;
      gl.uniform2f(P.img.u.imgAspect, boxA > ia ? 1 : boxA / ia, boxA > ia ? ia / boxA : 1);
      gl.uniform1f(P.img.u.smear, o.smear); gl.uniform1f(P.img.u.reveal, it.reveal); gl.uniform1f(P.img.u.time, time * 0.001);
      const d = canvas.width / W;
      gl.uniform2f(P.img.u.sizePx, r.width * d, r.height * d); gl.uniform1f(P.img.u.radiusPx, (parseFloat(getComputedStyle(it.el).borderRadius) || 0) * d);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.bindVertexArray(vao); gl.disable(gl.BLEND);
  }

  // ---------- loop ----------
  let raf = 0, prev = performance.now(), running = true, visible = true;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!visible) return;
    const dt = Math.min(0.033, (now - prev) / 1000); prev = now;
    resize();
    if (!o.skipStep) step(dt);
    if (o.skipBg) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0,0,canvas.width,canvas.height); gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT); } else {
    gl.useProgram(P.bg.p); gl.uniform1i(P.bg.u.uDye, S.dye.read.attach(0));
    gl.uniform3fv(P.bg.u.tint, o.tint); gl.uniform3fv(P.bg.u.tint2, o.tint2); gl.uniform3fv(P.bg.u.paper, o.paper);
    draw(P.bg, null); }
    if (!o.skipImg) drawImages(now);
  }
  raf = requestAnimationFrame(frame);
  const onVis = () => { visible = !document.hidden; prev = performance.now(); };
  document.addEventListener('visibilitychange', onVis);

  const api = {
    enabled: false,
    pointer, pointerLeave, resize,
    setQuality(q) { Object.assign(o, q); initTargets(); },
    addImage: loadImage,
    destroy() { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis); gl.getExtension('WEBGL_lose_context')?.loseContext(); },
    get options() { return o; },
  };
  return api;
}
