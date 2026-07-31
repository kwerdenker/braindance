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

// The camera does two unrelated jobs and they cannot share an object. Orbiting to
// inspect the cloud is navigation - view state, leaving no trace - while a camera
// key is document state a keyframe writes and an export has to reproduce exactly.
// So there are two cameras: a free one the controls drive, and a program one the
// transport poses straight from program time. Damping is why nothing keyframed
// can go through the controls at all - it is a frame-rate-dependent filter, so the
// same move would land somewhere else at a different output frame rate.
const ORBIT_TARGET = new THREE.Vector3(0, 0, -2.2);

const freeCamera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 60);
freeCamera.position.set(0, 0.1, 1.6);

const programCamera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 60);

// Which of the two the viewport draws. The free camera is the default, so the live
// viewer stays exactly what it was. Step 5's top-down view draws the program
// camera's frustum from outside, which is why these are two objects rather than
// one object with the controls switched off.
let viewCamera = freeCamera;

const controls = new OrbitControls(freeCamera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.autoRotateSpeed = 0.6;
controls.target.copy(ORBIT_TARGET);

// The program pose is a pure function of program time, so it holds no state and
// has nothing to drift - which is the property step 5's keyframed path has to
// keep, and the reason this placeholder is shaped the way it is rather than
// animated off a clock. It is a slow orbit, one revolution per 100 seconds,
// starting where the free camera starts. Nothing shows it until something calls
// setViewCamera; the viewport draws the free camera by default.
const PROGRAM_ORBIT = new THREE.Spherical()
  .setFromVector3(new THREE.Vector3(0, 0.1, 1.6).sub(ORBIT_TARGET));
const PROGRAM_ORBIT_RATE = (2 * Math.PI) / 100;
const programSpherical = new THREE.Spherical();

function poseProgramCamera(t) {
  programSpherical.set(
    PROGRAM_ORBIT.radius,
    PROGRAM_ORBIT.phi,
    PROGRAM_ORBIT.theta - t * PROGRAM_ORBIT_RATE,
  );
  programCamera.position.setFromSpherical(programSpherical).add(ORBIT_TARGET);
  programCamera.lookAt(ORBIT_TARGET);
}

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
const renderPass = new RenderPass(scene, viewCamera);
composer.addPass(renderPass);

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

// Which camera the viewport draws. Navigation is switched off while the program
// camera is on screen, because a drag would otherwise move the free camera
// somewhere nobody can see and leave it there.
function setViewCamera(cam) {
  viewCamera = cam;
  renderPass.camera = cam;
  controls.enabled = cam === freeCamera;
}

function resize() {
  for (const cam of [freeCamera, programCamera]) {
    cam.aspect = innerWidth / innerHeight;
    cam.updateProjectionMatrix();
  }
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
// Still what it always was - orbit the view you are looking at. What changed is
// underneath: the controls advance it on the program delta the render loop hands
// them rather than on wall-clock time, so the same orbit renders the same way at
// any output frame rate, and it holds still when the stream stalls.
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
let streamDetached = false;

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
    // The decode is asynchronous, so one started while the stream was still live
    // can finish after a pinned run has taken the textures over - and it would
    // switch colour back on partway through, which is a render that differs from
    // its own repeat for reasons nothing in the transport can explain.
    if (streamDetached) {
      bitmap.close();
      return;
    }
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
  const stampMs = Number(view.getBigUint64(8, true));
  const offset = 16; // u32 + u32 + u64 timestamp

  const swap = depthPrev;
  depthPrev = depthCurr;
  depthCurr = swap;
  depthCurr.image.data.set(new Uint16Array(buffer, offset, depthBytes / 2));
  depthCurr.needsUpdate = true;
  uniforms.depthPrev.value = depthPrev;
  uniforms.depthCurr.value = depthCurr;

  const now = performance.now();
  livePairs.push(stampMs, now);

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
    if (streamDetached) return;
    sensorLabel = 'disconnected — retrying';
    setStatus();
    setTimeout(connect, 1000);
  };

  ws.onerror = () => ws.close();
}

// Live acquisition has to be able to go away. A timeline render or an export
// pulls its frames from a file, and an arrival landing in the depth textures
// underneath one of those would corrupt the image it was asked to reproduce.
function detachStream() {
  streamDetached = true;
  socket?.close();
  // The socket closing does not stop a frame that has already been parsed, so
  // the queued JPEG goes too and any decode still in flight drops its result.
  pendingColor = null;
  sensorLabel = 'stream detached';
  setStatus();
}

// ------------------------------------------------------------------ transport

// Program time is the coordinate everything below reads: output seconds from the
// start of the edit. A transport is the only thing that answers "what time is
// it", and live viewing is the degenerate case of one rather than an exception -
// the playhead is pinned to the newest arrival instead of being dragged along a
// timeline or stepped at k / outputFps. That is what stops the live path drifting
// from what the editor and the export renderer produce, since there is only ever
// one clock and one image pipeline.
//
// Acquisition is a separate axis, below the renderer. A pair source answers which
// two capture frames bracket a program position and how far between them the
// playhead sits, and it is the only thing that knows where the bytes came from -
// live pushes arrivals in over the socket, and step 2's indexed source will pull
// them through the frame API. Both converge on the same two depth textures, so
// the renderer never learns which one fed it.
//
// A source hands back the frames the playhead crossed as *steps*, oldest first,
// each carrying the gap the sensor recorded before it and knowing how to make its
// own depth current. The surface memory has to see each frame in turn, so a bare
// list of gaps would leave step 4's pre-roll comparing the newest depth against
// itself and computing a wake that never happened.

const NOMINAL_GAP_MS = 1000 / 30;
// Past this, a stamp step is a take boundary rather than a stall. The sample
// capture has a real 1448ms gap in it, so the threshold has to sit well clear of
// what a struggling sensor produces or genuine stalls get repaired away.
const DISCONTINUITY_MS = 5000;
const noop = () => {};

class LivePairSource {
  constructor() {
    // The pair's stamps are a program clock built by accumulating the gaps the
    // sensor itself reported, so the playhead advances on capture cadence rather
    // than on however fast the socket happened to deliver.
    this.tA = 0;
    this.tB = 0;
    this.arrivedAtMs = 0;
    // Two smoothed intervals with different jobs, and conflating them is the
    // mistake to avoid. sourceGapMs stands in for a capture gap the stamps cannot
    // supply, and it is source time. deliveryMs is how long the pair is expected
    // to stay the newest one, and it is wall time - measured rather than assumed
    // at 30fps, because this stream is irregular and guessing wrong stutters
    // worse than not blending at all.
    this.sourceGapMs = NOMINAL_GAP_MS;
    this.deliveryMs = NOMINAL_GAP_MS;
    this.lastStampMs = null;
    this.lastWallMs = 0;
    this.pendingGapMs = 0;
    this.pendingFrames = 0;
  }

  /** One arrival, after its depth has been swapped into the current texture. */
  push(stampMs, wallMs) {
    const raw = this.lastStampMs === null ? 0 : stampMs - this.lastStampMs;
    this.lastStampMs = stampMs;

    // A replay loops its capture back to the start and a grabber restart opens a
    // new take, so the stamp can go backwards or leap a long way, and there the
    // smoothed gap stands in - program time only ever moves forward, because a
    // playhead that went backwards would walk the accumulators into a state no
    // sequence of frames could have produced. A merely long gap is not that: it
    // is a stall the sensor genuinely had, and the sample capture contains one of
    // 1448ms. Averaging it away would age the surface memory by a twentieth of
    // the time that actually passed and leave wakes alive that should have gone.
    const gap = (raw > 0 && raw < DISCONTINUITY_MS) ? raw : this.sourceGapMs;
    // The smoothed value only has to be a plausible stand-in, so the outliers stay
    // out of it even though they are used as they are above.
    if (raw > 5 && raw < 500) this.sourceGapMs = this.sourceGapMs * 0.8 + raw * 0.2;

    const delivered = this.lastWallMs ? wallMs - this.lastWallMs : 0;
    // Clamped so one stall does not stretch the blend across the next second.
    if (delivered > 5 && delivered < 500) this.deliveryMs = this.deliveryMs * 0.8 + delivered * 0.2;
    this.lastWallMs = wallMs;

    this.tA = this.tB;
    this.tB += gap;
    this.arrivedAtMs = wallMs;
    this.pendingGapMs += gap;
    this.pendingFrames++;
  }

  at(programSec) {
    const steps = [];
    if (this.pendingFrames > 0) {
      // Only two depth textures exist on this path, so a burst of arrivals inside
      // one display interval has already overwritten the frames in between and
      // their pixels are gone. One step carrying the summed gap is the best that
      // can be done here; the indexed source can fetch every crossed frame, which
      // is what an accurate seek needs and what this cannot give.
      steps.push({ gapSec: this.pendingGapMs / 1000, makeCurrent: noop });
      this.pendingGapMs = 0;
      this.pendingFrames = 0;
    }

    const spanMs = Math.max(1, this.tB - this.tA);
    const offsetMs = Math.min(Math.max(programSec * 1000 - this.tA, 0), spanMs);
    return { steps, mixT: offsetMs / spanMs, sinceFrameSec: offsetMs / 1000 };
  }
}

class LiveTransport {
  constructor(source) { this.source = source; }

  /**
   * Live is the one transport that reads a wall clock, and it reads it for a
   * single purpose: deciding where inside the current pair's gap the playhead
   * sits, so a 30fps stream still blends and fades smoothly on a 120Hz display.
   * What comes out is a program position, so nothing downstream can drift with
   * how long the tab has been open.
   */
  positionAt(wallMs) {
    const s = this.source;
    if (!s.arrivedAtMs) return 0;
    // Walk across the pair over one expected delivery interval, then hold. The
    // clock only picks a position inside the gap - how far program time advances
    // is the recorded gap and nothing else - so the wall clock decides pacing and
    // never duration. Pacing to delivery rather than to the capture gap is
    // deliberate: over a link slower than the sensor the two differ, and a
    // playhead that reached the newest arrival early would sit there juddering
    // instead of moving. Holding rather than extrapolating past it is the other
    // half of that - a late frame extrapolated would overshoot into garbage.
    const frac = Math.min(1, (wallMs - s.arrivedAtMs) / Math.max(1, s.deliveryMs));
    return (s.tA + frac * (s.tB - s.tA)) / 1000;
  }
}

const livePairs = new LivePairSource();
const liveTransport = new LiveTransport(livePairs);
let pairSource = livePairs;

// Opened here rather than beside the socket code, because `handleFrame` pushes
// into the pair source above. Arrivals cannot dispatch until module evaluation
// finishes either way, but relying on that at the call site makes the ordering
// look accidental when it is a requirement.
connect();

// ------------------------------------------------------------- render pipeline

// One ping-pong step of the surface memory, advanced by exactly one source frame.
// The transport calls it once per capture frame the playhead crosses, with that
// frame's own recorded gap, because the memory describes the sensor's timeline
// rather than the display's - and because a seek has to be able to walk it
// forward at will, which is impossible while "a frame arrived" is what drives it.
function advanceSurfaceState(dtSec) {
  stateUniforms.depthCurr.value = depthCurr;
  stateUniforms.statePrev.value = statePrev.texture;
  // The upper bound is the discontinuity gate and nothing tighter. A lower one
  // would undo the gate a layer down: the sample capture's real 1448ms stall
  // would arrive here and be truncated, so wakes born before the stall would
  // survive it with life left over - which is the failure the gate exists to
  // prevent. Anything past the gate never reaches this call.
  stateUniforms.dt.value = Math.min(DISCONTINUITY_MS / 1000, Math.max(0.001, dtSec));
  stateUniforms.snapDelta.value = uniforms.snapDelta.value;

  renderer.setRenderTarget(stateNext);
  stateQuad.render(renderer);
  renderer.setRenderTarget(null);

  const swap = statePrev;
  statePrev = stateNext;
  stateNext = swap;
  uniforms.stateTex.value = statePrev.texture;
}

let lastProgramTime = 0;

// Clears both feedback paths. Neither can be walked backwards, so an accurate
// seek clears them and pre-rolls forward from a known state - and all zeroes is
// that state, since a zero last-depth reads as invalid and the first frame after
// it comes through as births rather than as swaps.
function resetAccumulators() {
  const color = new THREE.Color();
  renderer.getClearColor(color);
  const alpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);
  // Three exposes no reset on the afterimage pass, so its two buffers are reached
  // for directly. They are the whole of its state at 0.185.1, and the check is
  // there because a rename on upgrade would fail silently: setRenderTarget of
  // undefined binds the canvas instead, the clear lands nowhere, and the seek
  // would quietly carry the previous image's trails into its pre-roll.
  const feedback = [statePrev, stateNext, afterimage._textureComp, afterimage._textureOld];
  if (!feedback.every((target) => target?.isWebGLRenderTarget)) {
    throw new Error('afterimage internals moved: the accumulator reset is no longer complete');
  }
  for (const target of feedback) {
    renderer.setRenderTarget(target);
    renderer.clear(true, true, true);
  }
  renderer.setRenderTarget(null);
  renderer.setClearColor(color, alpha);
  lastProgramTime = 0;
}

// One image at one program position. This is the whole seam: the timeline and the
// export transports drive exactly this call, and an accurate seek is nothing more
// than running it repeatedly at earlier positions and throwing the results away.
function renderProgramFrame(t) {
  const frame = pairSource.at(t);
  for (const step of frame.steps) {
    step.makeCurrent();
    advanceSurfaceState(step.gapSec);
  }

  uniforms.mixT.value = frame.mixT;
  uniforms.sinceFrameSec.value = frame.sinceFrameSec;
  uniforms.time.value = t;
  grade.uniforms.time.value = t;

  poseProgramCamera(t);

  const dt = Math.max(0, t - lastProgramTime);
  lastProgramTime = t;

  // The delta goes in explicitly because the composer falls back to a clock of
  // its own when render() is called bare, which would put a wall clock back
  // inside the seam even though no pass in this chain reads the delta today.
  if (postEnabled()) composer.render(dt);
  else renderer.render(scene, viewCamera);
}

// Navigation's own clock, kept out of the seam. The controls mutate the free
// camera by accumulation, so calling them from inside `renderProgramFrame` would
// make two renders at the same program time produce different images - the exact
// coupling this step removes, arriving through a different door. They stay out
// here, and they read a delta of their own rather than the one the render keeps.
let lastNavTime = 0;

renderer.setAnimationLoop(() => {
  const t = liveTransport.positionAt(performance.now());
  // Auto-orbit is the one thing the controls advance on a delta, and it gets the
  // program delta rather than a wall clock, so the same orbit renders the same
  // way at any output frame rate. The stall behaviour falls out of that: program
  // time does not advance without frames, so the delta is zero and the orbit
  // holds still instead of lurching when the next one lands.
  controls.update(Math.max(0, t - lastNavTime));
  lastNavTime = t;
  renderProgramFrame(t);
});

// ------------------------------------------------------------------ drive hook

// A run of capture frames pinned from a file, driving the renderer with no socket
// and no wall clock anywhere in the loop. It is the shape the indexed source will
// take: bracket the position, then hand back every source frame the playhead
// crossed so the surface memory sees each one in turn.
class PinnedPairSource {
  constructor(buffer) {
    const view = new DataView(buffer);
    this.frames = [];
    for (let off = 0; off + 16 <= buffer.byteLength;) {
      const depthBytes = view.getUint32(off, true);
      const colorBytes = view.getUint32(off + 4, true);
      this.frames.push({
        depth: new Uint16Array(buffer, off + 16, depthBytes / 2),
        stampMs: Number(view.getBigUint64(off + 8, true)),
      });
      off += 16 + depthBytes + colorBytes;
    }
    const first = this.frames[0].stampMs;
    this.times = this.frames.map((f) => (f.stampMs - first) / 1000);
    this.applied = -1;
  }

  rewind() { this.applied = -1; }

  makeCurrent(k) {
    const swap = depthPrev;
    depthPrev = depthCurr;
    depthCurr = swap;
    depthCurr.image.data.set(this.frames[k].depth);
    depthCurr.needsUpdate = true;
    uniforms.depthPrev.value = depthPrev;
    uniforms.depthCurr.value = depthCurr;
  }

  at(programSec) {
    const times = this.times;
    let i = 0;
    while (i < times.length - 2 && times[i + 1] <= programSec) i++;

    // The pair is (i, i+1) and the accumulators have been walked through i+1,
    // which is the same relationship live holds between its two arrivals. Moving
    // backwards past that leaves them describing a future that has not happened,
    // and there is no way to walk them back - the caller has to reset and pre-roll
    // forward. Refusing is the point: a timeline transport that forgets to reset
    // before a backward seek is step 4's likeliest integration bug, and silently
    // re-aging the accumulators would hand it a subtly wrong image instead of an
    // error.
    if (i + 1 < this.applied) {
      throw new Error(
        `backward seek to ${programSec}s without a reset: the accumulators have `
        + `already consumed frame ${this.applied}`,
      );
    }

    const steps = [];
    for (let k = this.applied + 1; k <= i + 1; k++) {
      const gapSec = k === 0 ? NOMINAL_GAP_MS / 1000 : times[k] - times[k - 1];
      steps.push({ gapSec, makeCurrent: () => this.makeCurrent(k) });
    }
    this.applied = i + 1;

    const span = Math.max(1e-6, times[i + 1] - times[i]);
    const offset = Math.min(Math.max(programSec - times[i], 0), span);
    return { steps, mixT: offset / span, sinceFrameSec: offset };
  }
}

let pinnedPairs = null;

// Handles for profiling and for poking at the scene from the console.
globalThis.__kinect = {
  renderer, composer, scene, freeCamera, programCamera, controls, uniforms, material,
  bloom, afterimage, grade, geometry, resetAccumulators, renderProgramFrame,
  // No control switches the viewport yet - the free camera is what the live
  // viewer shows. This is how the program camera is reached until step 5 gives
  // it a path worth looking at and the top-down view a reason to draw its frustum.
  setViewCamera,
  viewCamera: () => viewCamera,

  // The deterministic drive. Every claim from step 1 onward is checked through
  // it: pin the inputs, step the playhead to an exact program position, read the
  // image back, and see whether the same positions give the same pixels twice.
  drive: {
    /** Detaches the live loop and feeds a run of capture frame payloads instead. */
    pin(buffer) {
      renderer.setAnimationLoop(null);
      detachStream();
      pinnedPairs = new PinnedPairSource(buffer);
      pairSource = pinnedPairs;
      // Colour decode is asynchronous, so a pinned run leaves it out rather than
      // racing it. Depth is what the accumulators read anyway.
      uniforms.hasColor.value = 0;
      return pinnedPairs.times.slice();
    },
    times() { return pinnedPairs.times.slice(); },
    reset() {
      pinnedPairs?.rewind();
      resetAccumulators();
    },
    stepTo(t) { renderProgramFrame(t); },
    /** Must be called in the same task as the render: the buffer is not preserved. */
    readPixels() {
      const gl = renderer.getContext();
      const { drawingBufferWidth: w, drawingBufferHeight: h } = gl;
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    },
    async hashes(times) {
      const out = [];
      for (const t of times) {
        renderProgramFrame(t);
        const pixels = this.readPixels();
        const digest = await crypto.subtle.digest('SHA-256', pixels);
        out.push(Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''));
      }
      return out;
    },
  },

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
