import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const DW = 512;
const DH = 424;
const POINTS = DW * DH;

const statusEl = document.getElementById('status');

// ---------------------------------------------------------------- scene setup

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
scene.fog = new THREE.FogExp2(0x05070a, 0.11);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 60);
camera.position.set(0, 0.1, 1.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.autoRotateSpeed = 0.6;
controls.target.set(0, 0, -2.2);

// ---------------------------------------------------------------- gpu textures

// Depth arrives as raw millimetres. An integer texture keeps it exact, and two
// of them let the vertex shader interpolate between the last two sensor frames -
// which is what makes an 8-15fps stream look fluid on a 120Hz display.
const makeDepthTexture = () => {
  const tex = new THREE.DataTexture(
    new Uint16Array(POINTS), DW, DH, THREE.RedIntegerFormat, THREE.UnsignedShortType,
  );
  tex.internalFormat = 'R16UI';
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
};

let depthPrev = makeDepthTexture();
let depthCurr = makeDepthTexture();

const makeColorTexture = () => {
  const tex = new THREE.Texture();
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
};

let colorPrev = makeColorTexture();
let colorCurr = makeColorTexture();

// ---------------------------------------------------------------- point cloud

const geometry = new THREE.BufferGeometry();
const pixelCoords = new Float32Array(POINTS * 3);
for (let row = 0, i = 0; row < DH; row++) {
  for (let col = 0; col < DW; col++, i++) {
    pixelCoords[i * 3] = col;
    pixelCoords[i * 3 + 1] = row;
    pixelCoords[i * 3 + 2] = 0;
  }
}
geometry.setAttribute('position', new THREE.BufferAttribute(pixelCoords, 3));
geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -3), 12);

const uniforms = {
  depthPrev: { value: depthPrev },
  depthCurr: { value: depthCurr },
  colorPrev: { value: colorPrev },
  colorCurr: { value: colorCurr },
  mixT: { value: 1 },
  snapDelta: { value: 250 },
  interpolate: { value: 1 },
  focal: { value: new THREE.Vector2(366, 366) },
  center: { value: new THREE.Vector2(256, 212) },
  resolution: { value: new THREE.Vector2(DW, DH) },
  pointSize: { value: 5 },
  opacity: { value: 1 },
  exposure: { value: 1.15 },
  nearClip: { value: 0.5 },
  farClip: { value: 4.5 },
  warp: { value: 0 },
  warpSpeed: { value: 0.7 },
  glitch: { value: 0 },
  time: { value: 0 },
  mode: { value: 0 },
  denoise: { value: 1 },
  edgeTol: { value: 120 },
  hasColor: { value: 0 },
  softEdge: { value: 1 },
};

const vertexShader = /* glsl */ `
precision highp float;
precision highp usampler2D;

uniform usampler2D depthPrev, depthCurr;
uniform vec2 focal, center, resolution;
uniform float pointSize, nearClip, farClip, warp, warpSpeed, time, edgeTol;
uniform float mixT, snapDelta, glitch;
uniform int denoise, interpolate;

out vec2 vUv;
out float vDepth;
out float vEdge;
out float vGlitch;
out float vSize;

float depthAt(usampler2D tex, ivec2 p) {
  return float(texelFetch(tex, p, 0).r);
}

float hash(float n) { return fract(sin(n) * 43758.5453123); }

// libfreenect2's pinhole model, matching Registration::getPointXYZ. Image y grows
// downward, so it is flipped into the right-handed scene here.
vec3 unproject(vec2 pixel, float z) {
  return vec3(
     (pixel.x + 0.5 - center.x) / focal.x * z,
    -(pixel.y + 0.5 - center.y) / focal.y * z,
    -z
  );
}

void main() {
  ivec2 px = ivec2(position.xy);
  float mmC = depthAt(depthCurr, px);

  // Early-out before the neighbour fetches: a large share of the frame is empty,
  // and those pixels are culled regardless of what their neighbours say.
  if (mmC <= 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }

  float mm = mmC;
  if (interpolate == 1) {
    float mmP = depthAt(depthPrev, px);
    // Lerping across a depth discontinuity smears a point through empty space for
    // the whole inter-frame interval, so only blend when the two agree closely.
    if (mmP > 0.0 && abs(mmC - mmP) < snapDelta) mm = mix(mmP, mmC, mixT);
  }

  float z = mm * 0.001;

  // Neighbour spread doubles as a speckle test and an edge signal: isolated
  // points from dropped USB packets have no depth-consistent neighbours.
  float maxDiff = 0.0;
  int valid = 0;
  for (int i = 0; i < 4; i++) {
    ivec2 o = i == 0 ? ivec2(1, 0) : i == 1 ? ivec2(-1, 0) : i == 2 ? ivec2(0, 1) : ivec2(0, -1);
    ivec2 q = clamp(px + o, ivec2(0), ivec2(resolution) - 1);
    float n = depthAt(depthCurr, q);
    if (n > 0.0) {
      valid++;
      maxDiff = max(maxDiff, abs(n - mmC));
    }
  }
  vEdge = clamp(maxDiff / edgeTol, 0.0, 1.0);

  bool speckle = denoise == 1 && (valid < 3 || maxDiff > edgeTol * 3.0);
  if (z < nearClip || z > farClip || speckle) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }

  vec3 pos = unproject(position.xy, z);

  if (warp > 0.0) {
    float t = time * warpSpeed;
    pos += warp * vec3(
      sin(pos.y * 4.1 + t * 1.7) * cos(pos.z * 3.3 - t),
      sin(pos.z * 3.7 + t * 1.3) * cos(pos.x * 4.5 + t),
      sin(pos.x * 4.3 - t * 1.1) * cos(pos.y * 3.9 + t)
    );
  }

  // Datastream corruption: horizontal bands tear sideways, the way a failing
  // feed shears. Bands are picked stochastically so it stutters rather than pulses.
  vGlitch = 0.0;
  if (glitch > 0.0) {
    float band = floor(position.y / 12.0);
    float roll = hash(band + floor(time * 7.0) * 31.7);
    if (roll > 1.0 - glitch * 0.45) {
      float shove = (hash(band * 3.1 + floor(time * 7.0)) - 0.5) * glitch * 0.9;
      pos.x += shove;
      vGlitch = abs(shove) * 3.0;
    }
  }

  vUv = (position.xy + 0.5) / resolution;
  vDepth = z;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  // Clamped so a point right at the sensor cannot balloon into a full-screen quad.
  gl_PointSize = clamp(pointSize * (1.0 / max(0.15, -mv.z)), 1.0, 64.0);
  vSize = gl_PointSize;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D colorPrev, colorCurr;
uniform float opacity, exposure, nearClip, farClip, mixT, time;
uniform int mode, hasColor, softEdge;

in vec2 vUv;
in float vDepth;
in float vEdge;
in float vGlitch;
in float vSize;

out vec4 fragColor;

// Smooth cool-to-warm ramp; reads as depth without the banding of a hard palette.
vec3 depthRamp(float t) {
  vec3 a = vec3(0.06, 0.10, 0.28);
  vec3 b = vec3(0.15, 0.72, 0.78);
  vec3 c = vec3(0.98, 0.78, 0.32);
  vec3 d = vec3(0.96, 0.29, 0.42);
  return t < 0.33 ? mix(a, b, t / 0.33)
       : t < 0.66 ? mix(b, c, (t - 0.33) / 0.33)
                  : mix(c, d, (t - 0.66) / 0.34);
}

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);

  // Additive mode shapes the sprite purely with alpha falloff. Skipping the
  // discard keeps Apple's tile-based hidden-surface removal working.
  float falloff;
  if (softEdge == 1) {
    falloff = exp(-r2 * 9.0);
  } else {
    if (r2 > 0.25) discard;
    falloff = smoothstep(0.25, 0.02, r2);
  }

  float t = clamp((vDepth - nearClip) / max(0.001, farClip - nearClip), 0.0, 1.0);
  vec3 rgb = hasColor == 1
    ? mix(texture(colorPrev, vUv).rgb, texture(colorCurr, vUv).rgb, mixT)
    : vec3(0.7);
  vec3 col;
  float alpha = opacity;

  if (mode == 0) {
    col = rgb;
  } else if (mode == 1) {
    col = depthRamp(1.0 - t);
  } else if (mode == 2) {
    float lum = dot(rgb, vec3(0.299, 0.587, 0.114));
    float rim = pow(vEdge, 0.7);
    col = mix(vec3(0.20, 0.45, 0.75) * (0.35 + lum), vec3(0.75, 0.95, 1.0), rim);
    alpha *= 0.25 + 0.75 * rim + 0.25 * lum;
  } else if (mode == 3) {
    float bands = fract(vDepth * 12.0);
    float line = smoothstep(0.42, 0.5, bands) * smoothstep(0.58, 0.5, bands);
    col = mix(depthRamp(1.0 - t) * 0.18, vec3(1.0), line);
    alpha *= 0.15 + 0.85 * line;
  } else {
    // Blackwall: crimson volume, surfaces reading as containment rather than skin.
    // Depth discontinuities are where the wall "sees" you, so edges burn hottest.
    float lum = dot(rgb, vec3(0.299, 0.587, 0.114));
    vec3 deep = vec3(0.28, 0.010, 0.035);
    vec3 hot  = vec3(1.00, 0.115, 0.140);
    col = mix(deep, hot, pow(1.0 - t, 1.6));

    float rim = pow(vEdge, 0.55);
    col = mix(col, vec3(1.0, 0.42, 0.30), rim * 0.85);

    // A scan plane sweeping through depth, the ICE probing outward.
    float sweep = fract(vDepth * 0.55 - time * 0.28);
    float scan = smoothstep(0.965, 1.0, sweep);
    col += vec3(0.15, 0.85, 0.95) * scan * 1.6;

    // Torn bands flare cyan where the feed shears.
    col += vec3(0.2, 0.9, 1.0) * vGlitch;

    col *= 0.55 + 0.75 * lum;
    alpha *= 0.30 + 0.70 * rim + 0.45 * scan;
  }

  // Additive contributions sum, and near points get both larger sprites and more
  // overlap, so a splat's energy is normalised against its area. Without this the
  // nearest subject saturates to flat white while the background stays correct.
  if (softEdge == 1) alpha *= clamp(36.0 / (vSize * vSize), 0.05, 1.0);

  fragColor = vec4(col * exposure, alpha * falloff);
}
`;

const material = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms,
  vertexShader,
  fragmentShader,
  transparent: true,
  depthWrite: true,
});

const cloud = new THREE.Points(geometry, material);
scene.add(cloud);

function setAdditive(on) {
  material.blending = on ? THREE.AdditiveBlending : THREE.NormalBlending;
  material.depthWrite = !on;
  uniforms.softEdge.value = on ? 1 : 0;
  material.needsUpdate = true;
}
setAdditive(false);

// ---------------------------------------------------------------- post chain

// Deliberately ordered: trails accumulate the raw cloud, bloom blows out the hot
// edges, then the grade tears the whole image the way a failing signal would.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const afterimage = new AfterimagePass(0.0);
afterimage.enabled = false;
composer.addPass(afterimage);

const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.0, 0.7, 0.2);
bloom.enabled = false;
composer.addPass(bloom);

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    rgbSplit: { value: 0 },
    scanlines: { value: 0 },
    grain: { value: 0 },
    time: { value: 0 },
    resolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  // One combined pass: chaining separate RGBShift/Film/Vignette passes would cost
  // a full-screen read and write each.
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float rgbSplit, scanlines, grain, time;
    uniform vec2 resolution;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec2 texel = 1.0 / resolution;
      vec3 col;

      if (rgbSplit > 0.0) {
        // Split grows toward the edges, so the centre stays legible.
        vec2 dir = (vUv - 0.5);
        vec2 off = dir * rgbSplit * texel * 8.0;
        col.r = texture2D(tDiffuse, vUv + off).r;
        col.g = texture2D(tDiffuse, vUv).g;
        col.b = texture2D(tDiffuse, vUv - off).b;
      } else {
        col = texture2D(tDiffuse, vUv).rgb;
      }

      if (scanlines > 0.0) {
        float line = sin(vUv.y * resolution.y * 1.3 + time * 2.0) * 0.5 + 0.5;
        col *= 1.0 - scanlines * 0.35 * line;
        // A brighter band crawling down the frame, like a refresh sweep.
        float sweep = fract(vUv.y * 0.5 - time * 0.06);
        col += vec3(0.35, 0.02, 0.06) * scanlines * smoothstep(0.985, 1.0, sweep);
      }

      if (grain > 0.0) {
        // Weighted by luminance so grain lives in the signal instead of lifting
        // the empty background into a grey haze.
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        float n = hash(vUv * resolution + fract(time) * 137.0);
        col += (n - 0.5) * grain * 0.22 * (0.15 + lum);
      }

      // Vignette is tied to the grade so the frame always closes down on the subject.
      float vig = smoothstep(1.05, 0.32, length(vUv - 0.5));
      col *= mix(1.0, vig, 0.55);

      // Roll highlights off per channel instead of letting additive accumulation
      // clip to flat white - hot areas keep their hue this way.
      col = col / (1.0 + col);
      // Then crush the toe back down: Reinhard lifts blacks, and this look needs
      // the empty space to stay genuinely black rather than dark red.
      col = max(col - 0.018, 0.0) * 1.12;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

const grade = new ShaderPass(GradeShader);
grade.enabled = false;
composer.addPass(grade);
composer.addPass(new OutputPass());

let renderScale = 1;

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2) * renderScale);
  renderer.setSize(innerWidth, innerHeight);
  composer.setPixelRatio(Math.min(devicePixelRatio, 2) * renderScale);
  composer.setSize(innerWidth, innerHeight);
  const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
  // Bloom is the most expensive pass, so it runs at half the buffer resolution.
  bloom.setSize(Math.max(1, buf.x / 2), Math.max(1, buf.y / 2));
  grade.uniforms.resolution.value.set(buf.x, buf.y);
}
addEventListener('resize', resize);
resize();

function postEnabled() {
  return afterimage.enabled || bloom.enabled || grade.enabled;
}

// ---------------------------------------------------------------- ui wiring

const bind = (id, apply) => {
  const el = document.getElementById(id);
  const out = el.parentElement.querySelector('output');
  const run = () => {
    apply(Number(el.value));
    if (out) out.textContent = el.value;
  };
  el.addEventListener('input', run);
  run();
};

const bindUniform = (id, name) => bind(id, (v) => { uniforms[name].value = v; });

bindUniform('pointSize', 'pointSize');
bindUniform('opacity', 'opacity');
bindUniform('exposure', 'exposure');
bindUniform('near', 'nearClip');
bindUniform('far', 'farClip');
bindUniform('warp', 'warp');
bindUniform('warpSpeed', 'warpSpeed');
bindUniform('glitch', 'glitch');
bindUniform('edgeTol', 'edgeTol');
bindUniform('snapDelta', 'snapDelta');

bind('bloom', (v) => { bloom.strength = v; bloom.enabled = v > 0; });
bind('trails', (v) => { afterimage.uniforms.damp.value = v; afterimage.enabled = v > 0; });
bind('rgbSplit', (v) => { grade.uniforms.rgbSplit.value = v; grade.enabled = gradeNeeded(); });
bind('scanlines', (v) => { grade.uniforms.scanlines.value = v; grade.enabled = gradeNeeded(); });
bind('grain', (v) => { grade.uniforms.grain.value = v; grade.enabled = gradeNeeded(); });
bind('renderScale', (v) => { renderScale = v / 100; resize(); });

function gradeNeeded() {
  return grade.uniforms.rgbSplit.value > 0
    || grade.uniforms.scanlines.value > 0
    || grade.uniforms.grain.value > 0;
}

const checkbox = (id, apply) => {
  const el = document.getElementById(id);
  el.addEventListener('change', () => apply(el.checked));
  apply(el.checked);
  return el;
};

checkbox('denoise', (on) => { uniforms.denoise.value = on ? 1 : 0; });
checkbox('interpolate', (on) => { uniforms.interpolate.value = on ? 1 : 0; });
checkbox('spin', (on) => { controls.autoRotate = on; });
const additiveEl = checkbox('additive', setAdditive);

const setSlider = (id, value) => {
  const el = document.getElementById(id);
  el.value = String(value);
  el.dispatchEvent(new Event('input'));
};

// The Blackwall look is a whole pipeline state, not a shader branch, so selecting
// it drives the post chain too. Leaving it restores a neutral view.
const BLACKWALL = { bloom: 0.55, trails: 0.55, rgbSplit: 1.6, scanlines: 0.4, grain: 0.22, glitch: 0.18, pointSize: 4.5 };
const NEUTRAL = { bloom: 0, trails: 0, rgbSplit: 0, scanlines: 0, grain: 0, glitch: 0, pointSize: 5 };

let currentMode = 0;
function applyMode(mode) {
  const wasBlackwall = currentMode === 4;
  currentMode = mode;
  uniforms.mode.value = mode;

  if (mode === 4) {
    for (const [id, v] of Object.entries(BLACKWALL)) setSlider(id, v);
    additiveEl.checked = true;
    setAdditive(true);
    scene.fog.color.setHex(0x05070a);
  } else if (wasBlackwall) {
    for (const [id, v] of Object.entries(NEUTRAL)) setSlider(id, v);
    additiveEl.checked = false;
    setAdditive(false);
  }

  document.querySelectorAll('#modes button').forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.mode) === mode));
  });
}

document.querySelectorAll('#modes button').forEach((btn) => {
  btn.addEventListener('click', () => applyMode(Number(btn.dataset.mode)));
});

addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'H') {
    const p = document.getElementById('panel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
  }
});

// ---------------------------------------------------------------- stream

let framesSeen = 0;
let lastFpsAt = performance.now();
let fps = 0;
let sensorLabel = '';
let sensorState = '';
let decodeBusy = false;
let pendingColor = null;
let retiringBitmap = null;

// Interpolation runs against measured arrival spacing, not an assumed 30fps -
// this stream is irregular, and guessing wrong stutters worse than not blending.
let frameInterval = 1000 / 30;
let lastFrameAt = 0;
let sinceFrame = 0;

function setStatus() {
  const rate = document.createElement('b');
  rate.textContent = fps.toFixed(0);
  const nodes = [
    document.createTextNode(sensorLabel),
    document.createElement('br'),
    rate,
    document.createTextNode(' fps in'),
  ];
  if (sensorState) {
    const note = document.createElement('span');
    note.textContent = sensorState;
    note.style.color = '#e8a33d';
    nodes.push(document.createElement('br'), note);
  }
  statusEl.replaceChildren(...nodes);
}

async function pumpColorDecode() {
  if (decodeBusy || !pendingColor) return;
  decodeBusy = true;
  const bytes = pendingColor;
  pendingColor = null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const dropped = retiringBitmap;
    retiringBitmap = colorPrev.image instanceof ImageBitmap ? colorPrev.image : null;

    const swap = colorPrev;
    colorPrev = colorCurr;
    colorCurr = swap;
    colorCurr.image = bitmap;
    colorCurr.needsUpdate = true;
    uniforms.colorPrev.value = colorPrev;
    uniforms.colorCurr.value = colorCurr;
    uniforms.hasColor.value = 1;

    // Only close a bitmap once it is two swaps old and certainly unbound.
    if (dropped) dropped.close();
  } catch {
    /* a torn JPEG from a dropped USB packet: skip this frame */
  } finally {
    decodeBusy = false;
    if (pendingColor) pumpColorDecode();
  }
}

function handleFrame(buffer) {
  const view = new DataView(buffer);
  const depthBytes = view.getUint32(0, true);
  const colorBytes = view.getUint32(4, true);
  const offset = 16; // u32 + u32 + u64 timestamp

  const swap = depthPrev;
  depthPrev = depthCurr;
  depthCurr = swap;
  depthCurr.image.data.set(new Uint16Array(buffer, offset, depthBytes / 2));
  depthCurr.needsUpdate = true;
  uniforms.depthPrev.value = depthPrev;
  uniforms.depthCurr.value = depthCurr;

  const now = performance.now();
  if (lastFrameAt) {
    const gap = now - lastFrameAt;
    // Clamped so one stall does not stretch the blend across the next second.
    if (gap > 5 && gap < 500) frameInterval = frameInterval * 0.8 + gap * 0.2;
  }
  lastFrameAt = now;
  sinceFrame = 0;

  if (colorBytes > 0) {
    pendingColor = new Uint8Array(buffer, offset + depthBytes, colorBytes);
    pumpColorDecode();
  }

  framesSeen++;
  if (now - lastFpsAt >= 1000) {
    fps = (framesSeen * 1000) / (now - lastFpsAt);
    framesSeen = 0;
    lastFpsAt = now;
    setStatus();
  }
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => { sensorLabel = 'waiting for sensor…'; setStatus(); };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);

      if (msg.status) {
        sensorState = { live: '', starting: 'sensor starting…', lost: 'sensor lost — restarting' }[msg.status] ?? msg.status;
        if (msg.status !== 'live') fps = 0;
        setStatus();
        return;
      }

      uniforms.focal.value.set(msg.fx, msg.fy);
      uniforms.center.value.set(msg.cx, msg.cy);
      if (!msg.color) uniforms.hasColor.value = 0;
      sensorLabel = `${msg.serial} · fw ${msg.firmware}`;
      setStatus();
      console.log('sensor intrinsics', msg);
    } else {
      handleFrame(event.data);
    }
  };

  ws.onclose = () => {
    sensorLabel = 'disconnected — retrying';
    setStatus();
    setTimeout(connect, 1000);
  };

  ws.onerror = () => ws.close();
}

connect();

// ---------------------------------------------------------------- render loop

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  uniforms.time.value = clock.getElapsedTime();
  grade.uniforms.time.value = uniforms.time.value;

  // Walk toward the newest frame over one measured interval, then hold. Holding
  // rather than extrapolating keeps a late frame from overshooting into garbage.
  sinceFrame += dt * 1000;
  uniforms.mixT.value = Math.min(1, sinceFrame / Math.max(1, frameInterval));

  controls.update();

  if (postEnabled()) composer.render(dt);
  else renderer.render(scene, camera);
});

// Handles for profiling and for poking at the scene from the console.
globalThis.__kinect = { renderer, composer, scene, camera, controls, uniforms, material, bloom, afterimage, grade };
