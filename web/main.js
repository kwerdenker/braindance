import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

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

// ------------------------------------------------------------- surface memory

// A ray that lands on a different surface between two frames is a death and a
// birth. Today the point simply teleports, which is the loudest artifact in the
// viewer: 3.14% of pixels flip valid/zero every frame pair with no fade at all,
// 44x more pixels than the snap threshold ever touches.
//
// Remembering where the ray used to be turns that into a cross-fade, and the
// same memory is what a wake needs - so both come from one pass, one per
// arriving frame rather than one per display frame.
//
//   .r  depth the ray had before the swap, mm - where the ghost stays
//   .g  seconds since that swap
//   .b  how hard the swap was, 0..1
//   .a  depth at the previous arrival, mm - the swap detector itself
const stateType = renderer.getContext().getExtension('EXT_color_buffer_float')
  ? THREE.FloatType
  : THREE.HalfFloatType;

const makeStateTarget = () => new THREE.WebGLRenderTarget(DW, DH, {
  type: stateType,
  minFilter: THREE.NearestFilter,
  magFilter: THREE.NearestFilter,
  depthBuffer: false,
  stencilBuffer: false,
  generateMipmaps: false,
});

let statePrev = makeStateTarget();
let stateNext = makeStateTarget();

const MAX_AGE = 4.0;

const stateUniforms = {
  depthCurr: { value: depthCurr },
  statePrev: { value: statePrev.texture },
  resolution: { value: new THREE.Vector2(DW, DH) },
  dt: { value: 1 / 30 },
  snapDelta: { value: 250 },
};

const stateQuad = new FullScreenQuad(new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: stateUniforms,
  vertexShader: /* glsl */ `
    in vec3 position;
    void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    precision highp usampler2D;

    uniform usampler2D depthCurr;
    uniform sampler2D statePrev;
    uniform vec2 resolution;
    uniform float dt, snapDelta;

    out vec4 outState;

    void main() {
      ivec2 px = ivec2(gl_FragCoord.xy);
      float cur = float(texelFetch(depthCurr, px, 0).r);
      vec4 s = texelFetch(statePrev, px, 0);
      float last = s.a;

      bool wasValid = last > 0.0;
      bool isValid = cur > 0.0;
      float jump = (wasValid && isValid) ? abs(cur - last) : 0.0;
      bool swapped = (wasValid != isValid) || jump > snapDelta;

      if (!swapped) {
        // Clamped so age cannot grow without bound across a long session, and so
        // it never reaches the magnitude where a float stops absorbing a 33ms step.
        outState = vec4(s.r, min(s.g + dt, ${MAX_AGE.toFixed(1)}), s.b, cur);
        return;
      }

      // A pixel blinking in the middle of a flat wall is the depth solve's
      // confidence gate chattering, not motion. Keying strength off the local
      // depth spread separates the two: noise sits on a smooth surface and gets
      // only the brief cross-fade, while a silhouette crossing sheds a full wake.
      float ref = isValid ? cur : last;
      float edge = 0.0;
      for (int i = 0; i < 4; i++) {
        ivec2 o = i == 0 ? ivec2(1, 0) : i == 1 ? ivec2(-1, 0) : i == 2 ? ivec2(0, 1) : ivec2(0, -1);
        float n = float(texelFetch(depthCurr, clamp(px + o, ivec2(0), ivec2(resolution) - 1), 0).r);
        if (n > 0.0) edge = max(edge, abs(n - ref));
      }

      float strength = (wasValid && isValid)
        ? clamp(jump / (snapDelta * 3.0), 0.0, 1.0)
        : clamp(edge / snapDelta, 0.0, 1.0);

      outState = vec4(wasValid ? last : 0.0, 0.0, strength, cur);
    }
  `,
}));

// ---------------------------------------------------------------- point cloud

// Two vertices per depth pixel: one for the live point, one for the ghost it
// leaves behind. Shedding needs both on screen at once. The ghost half is left
// out of the draw range entirely when nothing can be shed, so it costs nothing.
const geometry = new THREE.BufferGeometry();
const pixelCoords = new Float32Array(POINTS * 2 * 3);
const slotAttr = new Float32Array(POINTS * 2);
for (let slot = 0; slot < 2; slot++) {
  for (let row = 0, i = 0; row < DH; row++) {
    for (let col = 0; col < DW; col++, i++) {
      const k = slot * POINTS + i;
      pixelCoords[k * 3] = col;
      pixelCoords[k * 3 + 1] = row;
      pixelCoords[k * 3 + 2] = 0;
      slotAttr[k] = slot;
    }
  }
}
geometry.setAttribute('position', new THREE.BufferAttribute(pixelCoords, 3));
geometry.setAttribute('aSlot', new THREE.BufferAttribute(slotAttr, 1));
geometry.setDrawRange(0, POINTS);
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
  scanAmount: { value: 0 },
  rimAmount: { value: 0.55 },
  stateTex: { value: statePrev.texture },
  fadeTime: { value: 0.12 },
  wakeTime: { value: 0 },
  sinceFrameSec: { value: 0 },
};

const vertexShader = /* glsl */ `
precision highp float;
precision highp usampler2D;

uniform usampler2D depthPrev, depthCurr;
uniform sampler2D stateTex;
uniform vec2 focal, center, resolution;
uniform float pointSize, nearClip, farClip, warp, warpSpeed, time, edgeTol;
uniform float mixT, snapDelta, glitch;
uniform float fadeTime, wakeTime, sinceFrameSec;
uniform int denoise, interpolate;

in float aSlot;

out vec2 vUv;
out float vDepth;
out float vEdge;
out float vGlitch;
out float vSize;
out float vGhost;
out float vFade;

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

  // Age advances continuously between arrivals, so a 30fps stream still fades on
  // a 120Hz display instead of stepping once per frame.
  vec4 st = texelFetch(stateTex, px, 0);
  float age = st.g + sinceFrameSec;

  float z;
  vEdge = 0.0;
  vGhost = 0.0;
  vFade = 1.0;

  if (aSlot > 0.5) {
    // The ghost: what the ray used to be looking at. A hard swap earns a longer
    // wake than a soft one, which is what keeps a static scene from shedding.
    float life = fadeTime + wakeTime * st.b;
    if (st.r <= 0.0 || life <= 0.0 || age >= life) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    float k = 1.0 - age / life;
    vGhost = st.b;
    vFade = k * k; // eased so it thins out rather than stepping off
    z = st.r * 0.001;
    // vEdge stays 0: it drives the rim term, and a shed point burning at full rim
    // is the white blowout this look already had to be pulled back from once.
  } else {
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

    z = mm * 0.001;

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
    if (speckle) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    // Born points ramp in over the same window their predecessor fades out.
    vFade = fadeTime > 0.0 ? clamp(age / fadeTime, 0.0, 1.0) : 1.0;
  }

  if (z < nearClip || z > farClip) {
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
uniform float scanAmount, rimAmount;
uniform int mode, hasColor, softEdge;

in vec2 vUv;
in float vDepth;
in float vEdge;
in float vGlitch;
in float vSize;
in float vGhost;
in float vFade;

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
    col = mix(col, vec3(0.95, 0.34, 0.22), rim * rimAmount);

    // A scan plane sweeping through depth, the ICE probing outward. Kept narrow
    // and tinted rather than white - a wide hot band reads as a light leak
    // dragging across the geometry instead of something scanning it.
    float sweep = fract(vDepth * 0.55 - time * 0.28);
    float scan = smoothstep(0.988, 1.0, sweep);
    col += vec3(0.10, 0.62, 0.78) * scan * scanAmount;

    // Torn bands flare cyan where the feed shears.
    col += vec3(0.2, 0.9, 1.0) * vGlitch;

    col *= 0.55 + 0.75 * lum;
    alpha *= 0.30 + 0.70 * rim * rimAmount + 0.45 * scan * scanAmount;

    // Shed points run hotter than the surface they left, so a wake reads as the
    // wall having noticed something rather than as leftover geometry.
    col = mix(col, vec3(1.00, 0.42, 0.20), vGhost * 0.55);
  }

  // Cross-fade. A dying point thins out where it stood instead of blinking off,
  // and its replacement comes up over the same window.
  alpha *= vFade;
  // Ghosts sit under the live cloud so they read as afterglow, never as surface.
  if (vGhost > 0.0) alpha *= 0.5;

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
bindUniform('scan', 'scanAmount');
bindUniform('rim', 'rimAmount');

// Both drive the same memory: fade is the honest cross-fade, wake is how much
// longer a hard transition lingers on top of it. Sized in seconds rather than in
// frame intervals, so improving the frame rate does not shorten the look.
bind('fade', (v) => { uniforms.fadeTime.value = v / 1000; updateDrawRange(); });
bind('wake', (v) => { uniforms.wakeTime.value = v / 1000; updateDrawRange(); });

function updateDrawRange() {
  const shedding = uniforms.fadeTime.value > 0 || uniforms.wakeTime.value > 0;
  geometry.setDrawRange(0, shedding ? POINTS * 2 : POINTS);
}

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
const BLACKWALL = { bloom: 0.5, trails: 0.5, rgbSplit: 1.6, scanlines: 0.35, grain: 0.22, glitch: 0.18, pointSize: 4.5, scan: 0.35, rim: 0.5, fade: 120, wake: 550 };
const NEUTRAL = { bloom: 0, trails: 0, rgbSplit: 0, scanlines: 0, grain: 0, glitch: 0, pointSize: 5, scan: 0, rim: 0.55, fade: 120, wake: 0 };

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
let stateDirty = false;
let arrivalDt = 1 / 30;

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
  let gap = frameInterval;
  if (lastFrameAt) {
    gap = now - lastFrameAt;
    // Clamped so one stall does not stretch the blend across the next second.
    if (gap > 5 && gap < 500) frameInterval = frameInterval * 0.8 + gap * 0.2;
  }
  lastFrameAt = now;
  sinceFrame = 0;

  // The surface memory advances once per arrival, not once per display frame -
  // it describes the sensor's timeline, not the display's.
  arrivalDt = Math.min(0.5, Math.max(0.001, gap / 1000));
  stateDirty = true;

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

// Camera settings live on the sensor, not in the shader, so the server owns them
// and the checkboxes only mirror what it reports back. Toggling colour restarts
// the grabber; low light is applied to the running one.
const colorCamEl = document.getElementById('colorCam');
const lowLightEl = document.getElementById('lowLight');
let socket = null;

function sendCamera(patch) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ camera: patch }));
}

function showCamera(state) {
  colorCamEl.checked = state.color;
  lowLightEl.checked = state.lowLight;
  // Exposure is meaningless with the colour camera off, so the control says so
  // rather than silently doing nothing.
  lowLightEl.disabled = !state.color;
  lowLightEl.parentElement.classList.toggle('disabled', !state.color);
}

colorCamEl.addEventListener('change', () => sendCamera({ color: colorCamEl.checked }));
lowLightEl.addEventListener('change', () => sendCamera({ lowLight: lowLightEl.checked }));

function connect() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.binaryType = 'arraybuffer';
  socket = ws;

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

      if (msg.camera) {
        showCamera(msg.camera);
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

// One ping-pong step of the surface memory. Kept on the render loop rather than
// inside the socket handler so all GL work stays on one code path, and so a burst
// of arrivals inside one display interval collapses to a single update.
function advanceSurfaceState() {
  stateUniforms.depthCurr.value = depthCurr;
  stateUniforms.statePrev.value = statePrev.texture;
  stateUniforms.dt.value = arrivalDt;
  stateUniforms.snapDelta.value = uniforms.snapDelta.value;

  renderer.setRenderTarget(stateNext);
  stateQuad.render(renderer);
  renderer.setRenderTarget(null);

  const swap = statePrev;
  statePrev = stateNext;
  stateNext = swap;
  uniforms.stateTex.value = statePrev.texture;
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  uniforms.time.value = clock.getElapsedTime();
  grade.uniforms.time.value = uniforms.time.value;

  if (stateDirty) {
    advanceSurfaceState();
    stateDirty = false;
  }

  // Walk toward the newest frame over one measured interval, then hold. Holding
  // rather than extrapolating keeps a late frame from overshooting into garbage.
  sinceFrame += dt * 1000;
  uniforms.mixT.value = Math.min(1, sinceFrame / Math.max(1, frameInterval));
  uniforms.sinceFrameSec.value = sinceFrame / 1000;

  controls.update();

  if (postEnabled()) composer.render(dt);
  else renderer.render(scene, camera);
});

// Handles for profiling and for poking at the scene from the console.
globalThis.__kinect = {
  renderer, composer, scene, camera, controls, uniforms, material, bloom, afterimage, grade, geometry,
  // Reads the surface memory back off the GPU. Mostly useful for checking that a
  // static scene sheds nothing: if it does, the swap detector is firing on sensor
  // noise rather than on motion.
  stateStats() {
    const buf = new Float32Array(POINTS * 4);
    renderer.readRenderTargetPixels(statePrev, 0, 0, DW, DH, buf);
    let ghosts = 0, hard = 0, soft = 0, fresh = 0;
    const life = uniforms.fadeTime.value + uniforms.wakeTime.value;
    for (let i = 0; i < POINTS; i++) {
      const ghost = buf[i * 4], age = buf[i * 4 + 1], strength = buf[i * 4 + 2];
      if (ghost > 0 && age < uniforms.fadeTime.value + uniforms.wakeTime.value * strength) ghosts++;
      if (age < 0.05) {
        fresh++;
        if (strength > 0.5) hard++; else soft++;
      }
    }
    const pct = (n) => +((n / POINTS) * 100).toFixed(2);
    return { ghostsDrawn: pct(ghosts), swappedLast50ms: pct(fresh), hard: pct(hard), soft: pct(soft), life };
  },
};
