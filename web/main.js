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
// Read here rather than beside the rest of the timeline, because `resize` runs at
// boot and has to know how much of the window the strip is taking. Hidden it
// measures zero, which is what keeps the live viewer's viewport exactly what it
// was.
const timelineEl = document.getElementById('timeline');

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
const PROGRAM_FOV = 50;

const freeCamera = new THREE.PerspectiveCamera(PROGRAM_FOV, innerWidth / innerHeight, 0.05, 60);
freeCamera.position.set(0, 0.1, 1.6);

const programCamera = new THREE.PerspectiveCamera(PROGRAM_FOV, innerWidth / innerHeight, 0.05, 60);

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
// Orienting is done on a camera-shaped scratch object rather than on a bare
// Object3D, because three points cameras and lights down -Z and everything else
// down +Z: the same lookAt on the wrong kind of object gives a pose facing the
// other way, and it would look plausible right up until the frustum was drawn.
const poseScratch = new THREE.PerspectiveCamera();

// The placeholder hands back a pose as a value rather than moving the camera
// itself, because the camera is a registry parameter like every other one and
// everything reaches it through the same door. Step 5 replaces this function with
// a curve read at t; nothing downstream of the registry has to change for that.
function programPose(t) {
  programSpherical.set(
    PROGRAM_ORBIT.radius,
    PROGRAM_ORBIT.phi,
    PROGRAM_ORBIT.theta - t * PROGRAM_ORBIT_RATE,
  );
  poseScratch.position.setFromSpherical(programSpherical).add(ORBIT_TARGET);
  poseScratch.lookAt(ORBIT_TARGET);
  return {
    position: poseScratch.position.toArray(),
    quaternion: poseScratch.quaternion.toArray(),
    fov: PROGRAM_FOV,
  };
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

// How long a ray's age is allowed to keep counting, in seconds of source time.
// This is not a free number: a ghost is drawn while `age < fadeTime + wakeTime *
// strength`, so once the clamp sits below the longest life the registry can ask
// for, a ray that stops swapping pins its age at the ceiling and sheds forever at
// fixed alpha. At 4.0 that was reachable - fade and wake top out at 1500 and 4000
// milliseconds - and it showed up as a wake that never expired in the live viewer
// and as a seek that could not reproduce a playback, because a reset zeroes the
// ghost and no length of pre-roll puts an immortal one back. The assertion below
// `PARAMS` is what keeps the two in step; raising a slider's maximum past this
// fails at boot rather than in the footage.
const MAX_AGE = 6.0;

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

// --------------------------------------------------------- binding a source frame

// The two doors every acquisition path goes through to put a capture frame in
// front of the shader. There is one of each rather than one per source, because
// the swap is the part that has to be identical: a socket arrival, a pinned run
// and an indexed pull all have to leave the textures in the same relationship or
// the renderer would produce a different image depending on where the bytes came
// from - which is the drift this whole design is arranged to prevent.
function bindDepth(data) {
  const swap = depthPrev;
  depthPrev = depthCurr;
  depthCurr = swap;
  depthCurr.image.data.set(data);
  depthCurr.needsUpdate = true;
  uniforms.depthPrev.value = depthPrev;
  uniforms.depthCurr.value = depthCurr;
}

// Ownership of the bitmap stays with the caller. Live closes its own two swaps
// later, once it is certainly unbound; the indexed cache holds its own until the
// frame is evicted. Closing one here would free a bitmap the other still needs.
function bindColor(bitmap) {
  const swap = colorPrev;
  colorPrev = colorCurr;
  colorCurr = swap;
  colorCurr.image = bitmap;
  colorCurr.needsUpdate = true;
  uniforms.colorPrev.value = colorPrev;
  uniforms.colorCurr.value = colorCurr;
  uniforms.hasColor.value = 1;
}

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
  // The stage is the window less whatever the timeline strip is taking, which is
  // nothing at all while it is hidden. Overlaying it on the image instead would
  // have cost nothing here and hidden the bottom of every frame being graded.
  const height = Math.max(1, innerHeight - timelineEl.offsetHeight);
  for (const cam of [freeCamera, programCamera]) {
    cam.aspect = innerWidth / height;
    cam.updateProjectionMatrix();
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2) * renderScale);
  renderer.setSize(innerWidth, height);
  composer.setPixelRatio(Math.min(devicePixelRatio, 2) * renderScale);
  composer.setSize(innerWidth, height);
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

// ------------------------------------------------------------ the registry

// One declarative registry. Every parameter that shapes the image says here what
// its default and range are, where its value lands in the renderer, how it
// interpolates once step 5 keyframes it, and which side of the look/composition
// split it sits on. Before this the values lived in four places - `uniforms.X`,
// `bloom.strength`, `afterimage.uniforms.damp` and `grade.uniforms.*` - with the
// DOM sliders as the actual source of truth, written by dispatching a synthetic
// input event at them. That works right up until something without a DOM has to
// set a look: a keyframe, a project file, a preset, or step 6's headless export
// renderer. Now those are all the same operation on one object.
//
// Three interpolation kinds cover the surface, and they are carried here rather
// than invented beside the keyframe editor, so there is one table rather than two
// that can quietly disagree:
//
//   scalar  lerps between keys, with ease handles. Most sliders.
//   step    holds until the next key. Every checkbox - lerping a boolean is
//           meaningless.
//   pose    position, orientation and field of view move together, because a
//           camera move judged one component at a time is not judged at all.
//
// The tag is the same axis that decides what a preset contains. `look` travels
// between clips. `composition` never does - applying someone else's look must not
// move your camera, which is the whole reason a preset is not just a saved
// project. `view` is neither: render scale and auto-orbit change what you are
// looking at rather than what the clip is, so they stay out of a preset and out of
// the undo snapshot for the same reason orbiting to inspect the cloud does.
//
// `near`/`far` are the awkward pair and are tagged look deliberately. They shape
// the image, but the right value depends on where the subject actually stood, so
// saving a preset picks which parameters go in with the look tags as the default
// selection rather than taking the whole tag blindly. They are also viewer clips
// and nothing else: they hide points that already arrived, which is unrelated to
// the grabber's --min-depth/--max-depth, and wiring the two together would throw
// away footage on the GPU before a frame was ever built.

function updateDrawRange() {
  const shedding = uniforms.fadeTime.value > 0 || uniforms.wakeTime.value > 0;
  geometry.setDrawRange(0, shedding ? POINTS * 2 : POINTS);
}

function gradeNeeded() {
  return grade.uniforms.rgbSplit.value > 0
    || grade.uniforms.scanlines.value > 0
    || grade.uniforms.grain.value > 0;
}

const PARAMS = {
  pointSize: { def: 5, min: 0.5, max: 64, step: 0.5, kind: 'scalar', tag: 'look',
    apply: (v) => { uniforms.pointSize.value = v; } },
  opacity: { def: 1, min: 0.05, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    apply: (v) => { uniforms.opacity.value = v; } },
  exposure: { def: 1.15, min: 0.05, max: 6, step: 0.05, kind: 'scalar', tag: 'look',
    apply: (v) => { uniforms.exposure.value = v; } },
  additive: { def: false, kind: 'step', tag: 'look', apply: setAdditive },

  near: { def: 0.05, min: 0.05, max: 9.5, step: 0.05, kind: 'scalar', tag: 'look',
    apply: (v) => { uniforms.nearClip.value = v; } },
  far: { def: 6, min: 0.05, max: 9.5, step: 0.05, kind: 'scalar', tag: 'look',
    apply: (v) => { uniforms.farClip.value = v; } },

  interpolate: { def: true, kind: 'step', tag: 'look',
    apply: (on) => { uniforms.interpolate.value = on ? 1 : 0; } },
  snapDelta: { def: 250, min: 20, max: 1200, step: 10, kind: 'scalar', tag: 'look',
    apply: (v) => { uniforms.snapDelta.value = v; } },

  // Both drive the same memory: fade is the honest cross-fade, wake is how much
  // longer a hard transition lingers on top of it. Sized in seconds rather than in
  // frame intervals, so improving the frame rate does not shorten the look. The
  // ghost half of the geometry is left out of the draw range entirely when neither
  // can shed, so a look with no persistence costs nothing to have the option.
  fade: { def: 120, min: 0, max: 1500, step: 10, kind: 'scalar', tag: 'look',
    apply: (v) => { uniforms.fadeTime.value = v / 1000; updateDrawRange(); } },
  wake: { def: 0, min: 0, max: 4000, step: 10, kind: 'scalar', tag: 'look',
    apply: (v) => { uniforms.wakeTime.value = v / 1000; updateDrawRange(); } },

  warp: { def: 0, min: 0, max: 1, step: 0.005, kind: 'scalar', tag: 'look',
    apply: (v) => { uniforms.warp.value = v; } },
  warpSpeed: { def: 0.7, min: 0, max: 3, step: 0.05, kind: 'scalar', tag: 'look',
    apply: (v) => { uniforms.warpSpeed.value = v; } },
  glitch: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    apply: (v) => { uniforms.glitch.value = v; } },
  // Still what it always was - orbit the view you are looking at - and still view
  // state rather than an edit: the controls advance it on the program delta the
  // render loop hands them, so the same orbit renders the same way at any output
  // frame rate and holds still when the stream stalls.
  spin: { def: false, kind: 'step', tag: 'view',
    apply: (on) => { controls.autoRotate = on; } },

  scan: { def: 0, min: 0, max: 1.5, step: 0.01, kind: 'scalar', tag: 'look',
    apply: (v) => { uniforms.scanAmount.value = v; } },
  rim: { def: 0.55, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    apply: (v) => { uniforms.rimAmount.value = v; } },
  // Each post pass costs a full-screen read and write whether or not it changes
  // anything, so a zero value switches its pass off rather than running it as a
  // no-op. The three grade terms share one pass, so they gate it together.
  bloom: { def: 0, min: 0, max: 6, step: 0.05, kind: 'scalar', tag: 'look',
    apply: (v) => { bloom.strength = v; bloom.enabled = v > 0; } },
  trails: { def: 0, min: 0, max: 0.97, step: 0.01, kind: 'scalar', tag: 'look',
    apply: (v) => { afterimage.uniforms.damp.value = v; afterimage.enabled = v > 0; } },
  rgbSplit: { def: 0, min: 0, max: 6, step: 0.05, kind: 'scalar', tag: 'look',
    apply: (v) => { grade.uniforms.rgbSplit.value = v; grade.enabled = gradeNeeded(); } },
  scanlines: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    apply: (v) => { grade.uniforms.scanlines.value = v; grade.enabled = gradeNeeded(); } },
  grain: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    apply: (v) => { grade.uniforms.grain.value = v; grade.enabled = gradeNeeded(); } },

  denoise: { def: true, kind: 'step', tag: 'look',
    apply: (on) => { uniforms.denoise.value = on ? 1 : 0; } },
  edgeTol: { def: 120, min: 10, max: 1200, step: 10, kind: 'scalar', tag: 'look',
    apply: (v) => { uniforms.edgeTol.value = v; } },
  renderScale: { def: 100, min: 40, max: 200, step: 5, kind: 'scalar', tag: 'view',
    apply: (v) => { renderScale = v / 100; resize(); } },

  // The one composition parameter today, and the only pose. It is here so step 5
  // reads the kind off the registry instead of keeping a second table beside the
  // camera path, and so the render path writes the pose the same way a keyframe
  // eventually will. Composition is edited in the world rather than on a slider,
  // which is why it is the one parameter with no panel control.
  camera: { def: programPose(0), kind: 'pose', tag: 'composition',
    apply: (p) => {
      programCamera.position.fromArray(p.position);
      programCamera.quaternion.fromArray(p.quaternion);
      if (programCamera.fov !== p.fov) {
        programCamera.fov = p.fov;
        programCamera.updateProjectionMatrix();
      }
    } },
};

// The surface memory's age ceiling has to cover the longest persistence the two
// sliders can ask for, or a ray that stops swapping pins its age below its own
// life and sheds forever. The check lives here rather than beside `MAX_AGE`
// because the shader string is built long before `PARAMS` exists, and it is an
// assertion rather than a clamp because the honest failure is "this look cannot
// be rendered correctly", which a silently shortened wake would hide.
{
  const longestLife = (PARAMS.fade.max + PARAMS.wake.max) / 1000;
  if (MAX_AGE < longestLife) {
    throw new Error(
      `the surface memory clamps age at ${MAX_AGE}s but fade and wake can ask for `
      + `${longestLife}s: a ghost past the clamp would never expire`,
    );
  }
}

// Range inputs snap to their step grid and clamp to their bounds, and the registry
// has to do the same arithmetic rather than lean on the DOM for it - otherwise a
// value set headlessly lands on the uniform unsnapped while the same value set
// through a slider lands snapped, and two runs of the same project disagree by a
// hair for reasons nothing records.
const decimalsOf = (x) => {
  const dot = String(x).indexOf('.');
  return dot < 0 ? 0 : String(x).length - dot - 1;
};

// Every value is checked for what it is rather than coerced into something. The
// callers that matter are not the sliders - those hand over exactly what the
// registry declared - but `params.apply(JSON.parse(projectFile))` and step 5's
// track output, and there the quiet coercions are the dangerous ones. `Number(null)`
// and `Number('')` are both a finite 0, so a truncated project would restore a
// zeroed look and say nothing, while `Number('abc')` on the very next key throws:
// the same corruption failing two different ways is worse than either. `!!value`
// has the mirror problem, turning the string "false" into true. So a scalar takes
// a number, a step takes a boolean, and anything else is a loud error at the point
// the bad value arrives instead of a wrong image somewhere downstream.
function normalise(name, spec, value) {
  if (spec.kind === 'pose') {
    // Shape alone is not enough. A short position array slices to a short array,
    // `fromArray` reads past its end and the camera's z becomes NaN; a missing fov
    // stores NaN, and because NaN !== NaN the apply then rewrites the projection
    // matrix every single frame. Live viewing hides all of it, because the next
    // frame overwrites the pose from `programPose(t)` - which is exactly why this
    // has to be caught here rather than when step 5 feeds a curve or a project file
    // through the same door and an export comes out black.
    const finite = (xs, n) => Array.isArray(xs) && xs.length === n && xs.every(Number.isFinite);
    if (!finite(value?.position, 3) || !finite(value?.quaternion, 4) || !Number.isFinite(value?.fov)) {
      throw new Error(
        `${name} is a pose: it needs a 3-number position, a 4-number quaternion and a `
        + `numeric fov, got ${JSON.stringify(value)}`,
      );
    }
    return {
      position: value.position.slice(),
      quaternion: value.quaternion.slice(),
      fov: value.fov,
    };
  }
  if (typeof spec.def === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${name} is a step parameter: it takes a boolean, got ${JSON.stringify(value)}`);
    return value;
  }
  const v = value;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${name} is a scalar: it takes a finite number, got ${JSON.stringify(value)}`);
  }
  const clamped = Math.min(spec.max, Math.max(spec.min, v));
  const snapped = spec.min + Math.round((clamped - spec.min) / spec.step) * spec.step;
  const decimals = Math.max(decimalsOf(spec.min), decimalsOf(spec.step));
  return Math.min(spec.max, Math.max(spec.min, Number(snapped.toFixed(decimals))));
}

const values = new Map();
const panelControls = new Map();

function writeControl(name, value) {
  const el = panelControls.get(name);
  if (!el) return;
  if (el.type === 'checkbox') {
    el.checked = value;
    return;
  }
  el.value = String(value);
  // Read the value back off the element rather than formatting the number here,
  // so the readout says exactly what the slider says even if they ever disagree.
  const out = el.parentElement.querySelector('output');
  if (out) out.textContent = el.value;
}

// Announced after every registry write, so whatever is showing the image can
// rebuild it. Live viewing needs nothing here - it renders every frame anyway -
// which is why this starts as a no-op and the timeline installs itself into it
// rather than the registry knowing a transport exists. Assigned rather than a
// subscriber list because there is one consumer and inventing a fan-out for it
// would be machinery for a problem nobody has.
let paramWritten = () => {};

const params = {
  spec(name) {
    const spec = PARAMS[name];
    if (!spec) throw new Error(`unknown parameter ${name}`);
    return { default: spec.def, min: spec.min, max: spec.max, step: spec.step, kind: spec.kind, tag: spec.tag };
  },
  names(tag) {
    return Object.keys(PARAMS).filter((n) => !tag || PARAMS[n].tag === tag);
  },
  get(name) {
    if (!(name in PARAMS)) throw new Error(`unknown parameter ${name}`);
    const v = values.get(name);
    return PARAMS[name].kind === 'pose' ? { ...v, position: [...v.position], quaternion: [...v.quaternion] } : v;
  },
  /** The single write path. Everything - UI, presets, step 5's tracks - goes here. */
  set(name, value) {
    const spec = PARAMS[name];
    if (!spec) throw new Error(`unknown parameter ${name}`);
    const v = normalise(name, spec, value);
    values.set(name, v);
    spec.apply(v);
    writeControl(name, v);
    // Here rather than at the call sites, for the same reason this is the single
    // write path at all: a preset, a slider, a mode and step 5's tracks all end up
    // on this line, so nothing can change the image without saying that it did.
    paramWritten(name, spec.tag);
    return v;
  },
  apply(next) {
    for (const [name, value] of Object.entries(next)) this.set(name, value);
    return this;
  },
  /**
   * A plain serialisable object. A project, a preset and an export job all start
   * here, which is why the default selection is document state - look plus
   * composition - and never view. Render scale and auto-orbit belong to whoever is
   * looking rather than to the clip, so an undo snapshot built on a bare `values()`
   * would put them in the document and pressing undo after dropping render scale
   * for performance would put it back: the exact behaviour that teaches people not
   * to trust undo. View state is still reachable, by naming it.
   */
  values(names = this.names().filter((n) => PARAMS[n].tag !== 'view')) {
    return Object.fromEntries(names.map((n) => [n, this.get(n)]));
  },
  /** Defaults, not a serialisation - so this one does cover view state. */
  reset(names = Object.keys(PARAMS)) {
    for (const name of names) this.set(name, PARAMS[name].def);
    return this;
  },
};

// The panel is a view on the registry and holds no parameter data of its own. The
// range, the default and the readout are all stamped from here at boot, because
// two copies of a slider's bounds is two things to keep in step and the HTML copy
// is the one nothing headless can read.
for (const [name, spec] of Object.entries(PARAMS)) {
  const el = document.getElementById(name);
  if (spec.tag === 'composition') {
    // Composition is edited in the world - a camera path is the one thing you
    // cannot judge from a graph - so it having grown a slider means the split has
    // been crossed somewhere and is worth stopping over.
    if (el) throw new Error(`composition parameter ${name} has a panel control`);
    continue;
  }
  if (!el) throw new Error(`parameter ${name} has no panel control`);
  panelControls.set(name, el);
  if (el.type === 'checkbox') {
    el.addEventListener('change', () => params.set(name, el.checked));
  } else {
    el.min = String(spec.min);
    el.max = String(spec.max);
    el.step = String(spec.step);
    // The string-to-number conversion belongs to the control rather than to the
    // registry: a slider's value is text because the DOM says so, and letting that
    // reach `normalise` would mean loosening it for every other caller too.
    el.addEventListener('input', () => params.set(name, Number(el.value)));
  }
}

params.reset();

// ------------------------------------------------------------------- presets

// Applying a preset is a user action and can never be an evaluation-time effect: a
// look that re-applied itself while the playhead moved would make the timeline lie
// about what it is showing. The render path raises this flag for the length of one
// frame, and the two bulk writes a gesture performs refuse while it is up. Ordinary
// parameter writes stay legal, because that is exactly what step 5's tracks do.
//
// What that actually covers, stated plainly so step 5 inherits the problem rather
// than a false sense of having solved it. The flag catches the two doors a preset
// goes through today - `applyPreset` and `setMode` - and nothing else. `params.apply`
// is public and unguarded, so a caller that assembles the same bulk write by hand
// gets no complaint, and the flag spans `renderProgramFrame` alone, so an evaluator
// that writes its track values just before calling it is semantically inside
// evaluation with the flag down. Widening it needs the shape of step 5's evaluator
// to be known: the honest boundary is "the evaluator is running", and that object
// does not exist yet.
let evaluating = false;

// Registry writes the transport makes on its own behalf, rather than on a user's:
// the camera pose every render poses, and the three parameters a draft borrows for
// one frame and hands back. Neither may ask for a repaint. A render that scheduled
// another render would never stop, and a draft would be chased by the accurate
// seek it exists to postpone - so the drag would pay for both.
//
// This is a separate flag from `evaluating` rather than a widening of it, and the
// two mean different things: `evaluating` says a preset is not a track, this says
// a write came from the renderer rather than from a hand. Nesting is real - a
// draft's suppression spans a render that suppresses in turn - so it saves and
// restores instead of clearing.
let transportWriting = false;

function withoutRepaint(write) {
  const outer = transportWriting;
  transportWriting = true;
  try {
    return write();
  } finally {
    transportWriting = outer;
  }
}

function refuseDuringEvaluation(what) {
  if (evaluating) {
    throw new Error(`${what} during evaluation: presets and modes are user actions, not tracks`);
  }
}

/** Copies a set of look values in. The only bulk write a user gesture performs. */
function applyPreset(preset) {
  refuseDuringEvaluation('preset applied');
  params.apply(preset);
}

// The Blackwall look is a whole pipeline state rather than a shader branch, so
// selecting it drives the post chain too, and leaving it restores a neutral view.
// Both are ordinary look presets now: values the registry knows how to write.
//
// For step 7, which is where this bites: the mode is not one of those values, and
// `params.values(params.names('look'))` will not capture or restore it. That is the
// right call here - the mode is clip state rather than a keyframeable parameter -
// but the spec's preset table does list mode as presettable look, so preset save
// and preset apply have to carry the mode alongside the registry subset rather than
// assuming the subset is the whole preset.
const BLACKWALL = { bloom: 0.5, trails: 0.5, rgbSplit: 1.6, scanlines: 0.35, grain: 0.22, glitch: 0.18, pointSize: 4.5, scan: 0.35, rim: 0.5, fade: 120, wake: 550, additive: true };
const NEUTRAL = { bloom: 0, trails: 0, rgbSplit: 0, scanlines: 0, grain: 0, glitch: 0, pointSize: 5, scan: 0, rim: 0.55, fade: 120, wake: 0, additive: false };

// The mode is a property of the clip rather than a track of any kind. Selecting it
// rewrites twelve other look values, so a mode keyframe would silently stomp every
// other track at the instant it fired - one mode per clip removes that problem
// instead of leaving it to be managed. Multi-mode clips are not ruled out, only
// deferred, and the stomping is what would have to be solved properly first.
let clipMode = 0;

function setMode(mode) {
  refuseDuringEvaluation('mode selected');
  const wasBlackwall = clipMode === 4;
  clipMode = mode;
  uniforms.mode.value = mode;

  if (mode === 4) {
    applyPreset(BLACKWALL);
    scene.fog.color.setHex(0x05070a);
  } else if (wasBlackwall) {
    applyPreset(NEUTRAL);
  }

  document.querySelectorAll('#modes button').forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.mode) === mode));
  });

  // Asked for explicitly, because the mode is clip state and deliberately not a
  // registry parameter - so selecting Depth or Contour writes nothing the
  // registry announces, and the image would sit on the previous reading of the
  // footage until something else happened to move.
  requestRepaint();
}

document.querySelectorAll('#modes button').forEach((btn) => {
  btn.addEventListener('click', () => setMode(Number(btn.dataset.mode)));
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

    bindColor(bitmap);

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

  bindDepth(new Uint16Array(buffer, offset, depthBytes / 2));

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

// What the instrument reads instead of taking the transport's word for anything.
// A check that asks "did the seek reset the accumulators" has to be able to see
// that it did, or it is asserting the claim rather than enforcing it.
const counters = { renders: 0, stateAdvances: 0, resets: 0, drafts: 0, seeks: 0, requests: 0, framesFetched: 0 };

// The one function mapping program time to source time. Everything above it works
// in program time - the playhead, the look, the camera, every keyframe step 5 adds
// - and everything below it works in source time, because that is what a capture
// is addressed in. A constant slope is normal speed, a shallow one slow motion.
//
// Step 5 replaces the body with a curve read at t and nothing on either side
// changes, which is the whole reason the mapping is a function here rather than a
// multiplication inlined at the two call sites that need it. Export needs no
// inverse of it, which is why the playhead lives in program time at all.
const retime = {
  rate: 1,
  sourceSecAt(programSec) { return programSec * this.rate; },
  // The local slope, in source seconds per program second. A pre-roll needs it to
  // turn fade and wake - which are source milliseconds and stay that way - into a
  // number of output frames.
  slopeAt(/* programSec */) { return this.rate; },
  // How long a program is, given a source that long. It lives here rather than as
  // a division at the transport, because a curve answers it by integrating and a
  // caller reaching for `rate` would be a third door into a seam that promises
  // two - which is the drift this design keeps refusing one layer up.
  programDurationFor(sourceSec) { return sourceSec / Math.abs(this.rate); },
  // The program position a source position sits at. The inverse exists only while
  // the slope is constant, and export never needs it - it is here so a seek can
  // shorten a pre-roll to the source frames it can actually hold, which is the one
  // place a source bound has to become a program bound. Step 5's curve answers it
  // by searching its own keys, or refuses and the clamp reads the target instead.
  programSecAt(sourceSec) { return sourceSec / this.rate; },
};

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

// ------------------------------------------------------------- render pipeline

// One ping-pong step of the surface memory, advanced by exactly one source frame.
// The transport calls it once per capture frame the playhead crosses, with that
// frame's own recorded gap, because the memory describes the sensor's timeline
// rather than the display's - and because a seek has to be able to walk it
// forward at will, which is impossible while "a frame arrived" is what drives it.
function advanceSurfaceState(dtSec) {
  counters.stateAdvances++;
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
  counters.resets++;
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
  counters.renders++;
  evaluating = true;
  try {
    // The one place program time becomes source time. Live is the degenerate case
    // - a rate of 1 with the playhead built out of the capture's own gaps, so the
    // mapping is the identity and the live path is unchanged by having it here.
    const frame = pairSource.at(retime.sourceSecAt(t));
    for (const step of frame.steps) {
      step.makeCurrent();
      advanceSurfaceState(step.gapSec);
    }

    uniforms.mixT.value = frame.mixT;
    uniforms.sinceFrameSec.value = frame.sinceFrameSec;
    uniforms.time.value = t;
    grade.uniforms.time.value = t;

    // The pose goes in through the registry rather than onto the camera, which is
    // what makes the camera a parameter with a kind rather than an object the
    // render path happens to move. Step 5 swaps the placeholder for a curve and
    // this line does not change.
    withoutRepaint(() => params.set('camera', programPose(t)));

    const dt = Math.max(0, t - lastProgramTime);
    lastProgramTime = t;

    // The delta goes in explicitly because the composer falls back to a clock of
    // its own when render() is called bare, which would put a wall clock back
    // inside the seam even though no pass in this chain reads the delta today.
    if (postEnabled()) composer.render(dt);
    else renderer.render(scene, viewCamera);
  } finally {
    evaluating = false;
  }
}

// Navigation's own clock, kept out of the seam. The controls mutate the free
// camera by accumulation, so calling them from inside `renderProgramFrame` would
// make two renders at the same program time produce different images - the exact
// coupling this step removes, arriving through a different door. They stay out
// here, and they read a delta of their own rather than the one the render keeps.
let lastNavTime = 0;

// Auto-orbit is the one thing the controls advance on a delta, and it gets the
// program delta rather than a wall clock, so the same orbit renders the same way
// at any output frame rate. The stall behaviour falls out of that: program time
// does not advance without frames, so the delta is zero and the orbit holds still
// instead of lurching when the next one lands. Both transports drive it, which is
// why it is a function of the position rather than a line inside the live loop.
function advanceNavigation(t) {
  controls.update(Math.max(0, t - lastNavTime));
  lastNavTime = t;
}

function liveLoop() {
  const t = liveTransport.positionAt(performance.now());
  advanceNavigation(t);
  renderProgramFrame(t);
}

// -------------------------------------------------------------- indexed frames

// The pull half of the acquisition axis. Live cannot be asked for a frame the
// sensor has not produced; a timeline knows exactly which frame it wants, so it
// binary-searches step 2's index and fetches through the HTTP frame API. What it
// hands back is the same shape the pushed source hands back, so the renderer
// never learns which one fed it.

// How many frames stay decoded. Depth is 434KB and a registered colour bitmap
// about 868KB, so this is the memory ceiling in the browser rather than a tuning
// knob - 192 frames is roughly 180MB with colour on half of them, and it has to
// cover the longest pre-roll a slow damp can ask for.
const CACHE_FRAMES = 192;
// The most frames one call may ask to have resident at once, kept below the cache
// so a span always has room for the two bitmaps the colour textures are holding
// and for the pair at the target. A pre-roll can reach past this: the trails half
// is a count of output frames independent of the rate, so its source span is
// `frames * rate / outputFps`, and a damp of 0.97 at 4x with 24fps out spans 25
// seconds of source - every one of those a slider value. The seek clamps and says
// what it dropped rather than asking for more than can be held.
const MAX_SPAN_FRAMES = CACHE_FRAMES - 16;
// How many frames one range request covers. The endpoint will serve any run, but
// the response is buffered whole in the browser, so the request is chunked to
// bound that allocation at about 16MB.
const RUN_FRAMES = 32;
// How far ahead playback keeps the cache filled, in output frames. A fetch is
// about a millisecond and an output frame is 33, so this only has to absorb a
// stall rather than hide the latency.
const PREFETCH_FRAMES = 30;
const KNCT_MAGIC = 0x4b4e4354;
const KNCT_HEADER = 12;

// The walk every source that can address a capture by time performs, written
// once. Bracket a source position, hand back each frame the playhead crossed with
// the gap the sensor recorded before it, and refuse to move backwards without a
// reset. The pinned run and the indexed pull are genuinely the same shape and
// were written out twice, which had already begun to drift - one clamped a
// negative gap and the other did not - so the only thing a subclass says is where
// a frame's bytes come from.
//
// Live is not one of these and stays separate on purpose: it cannot be asked for
// a frame the sensor has not produced, so it has no bracket to search and no
// frame to make current.
class StampedPairSource {
  /** @param times source seconds from the first frame, ascending. */
  constructor(times) {
    if (times.length < 2) throw new Error(`a pair source needs two frames, got ${times.length}`);
    this.times = times;
    // The accumulators have been walked through this frame.
    this.applied = -1;
  }

  get count() { return this.times.length; }

  get duration() { return this.times[this.times.length - 1]; }

  /** The frame at or before `sourceSec`, as the lower half of a bracketing pair. */
  bracket(sourceSec) {
    let lo = 0;
    let hi = this.count - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.times[mid] <= sourceSec) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Puts the walk back at frame `i`, so the next `at` emits `i` and `i + 1` as
   * its steps. Both a draft scrub and an accurate seek need it for the same
   * reason: the accumulators have just been cleared, so the source's record of
   * how far they were walked no longer holds.
   */
  seekTo(i) {
    this.applied = Math.max(-1, Math.min(this.count - 2, i) - 1);
  }

  rewind() { this.applied = -1; }

  /** One frame's bytes in front of the shader. Where they come from is the subclass. */
  // eslint-disable-next-line no-unused-vars
  makeCurrent(k) {
    throw new Error(`${this.constructor.name} does not say where its frames come from`);
  }

  at(sourceSec) {
    const times = this.times;
    const i = this.bracket(sourceSec);

    // The pair is (i, i+1) and the accumulators have been walked through i+1,
    // which is the same relationship live holds between its two arrivals. Moving
    // backwards past that leaves them describing a future that has not happened,
    // and there is no way to walk them back - the caller has to reset and seek
    // the walk forward. Refusing is the point: a transport that forgets to reset
    // before a backward seek is this design's likeliest integration bug, and
    // silently re-ageing the accumulators would hand it a subtly wrong image
    // instead of an error.
    if (i + 1 < this.applied) {
      throw new Error(
        `backward seek to ${sourceSec}s without a reset: the accumulators have `
        + `already consumed frame ${this.applied}`,
      );
    }

    const steps = [];
    for (let k = this.applied + 1; k <= i + 1; k++) {
      // Clamped, because a capture whose stamps are not strictly ascending would
      // otherwise age the surface memory backwards. The state pass clamps the
      // other end, at the discontinuity gate.
      const gapSec = k === 0 ? NOMINAL_GAP_MS / 1000 : Math.max(0, times[k] - times[k - 1]);
      steps.push({ gapSec, makeCurrent: () => this.makeCurrent(k) });
    }
    this.applied = i + 1;

    const span = Math.max(1e-6, times[i + 1] - times[i]);
    const offset = Math.min(Math.max(sourceSec - times[i], 0), span);
    return { steps, mixT: offset / span, sinceFrameSec: offset };
  }
}

class IndexedPairSource extends StampedPairSource {
  static async open(id) {
    const res = await fetch(`/capture/${encodeURIComponent(id)}/index`);
    if (!res.ok) throw new Error(`capture ${id}: ${res.status} ${res.statusText}`);
    return new IndexedPairSource(id, await res.json());
  }

  constructor(id, index) {
    const stamps = index.frames.stampMs;
    if (stamps.length < 2) throw new Error(`capture ${id} has ${stamps.length} frames, need two to bracket`);
    // Source seconds from the first frame, which is what a capture is addressed
    // in. The stamps themselves are the sensor's own monotonic clock and carry an
    // arbitrary origin.
    super(stamps.map((s) => (s - stamps[0]) / 1000));
    this.id = id;
    this.index = index;
    this.cache = new Map();
    this.pending = null;
  }

  resident(a, b) {
    for (let k = Math.max(0, a); k <= Math.min(this.count - 1, b); k++) {
      if (!this.cache.has(k)) return false;
    }
    return true;
  }

  /**
   * Puts frames a..b in the cache. Fetches are serialised rather than run in
   * parallel: a prefetch racing a seek would fetch the same run twice and, worse,
   * could evict the seek's own frames out from under it between its fetch and its
   * render.
   */
  ensure(a, b) {
    const run = () => this.fetchSpan(a, b);
    this.pending = (this.pending ?? Promise.resolve()).then(run, run);
    return this.pending;
  }

  async fetchSpan(a, b) {
    const from = Math.max(0, a);
    const to = Math.min(this.count - 1, b);
    // Loud, because there is no useful partial answer. A caller asking for more
    // frames than the cache can hold would have some of them evicted before it
    // rendered the rest, and the image it produced would be built from whatever
    // survived - which is exactly the silent wrong picture this source refuses
    // elsewhere. Both callers clamp; this is what makes that a requirement
    // rather than a convention.
    if (to - from + 1 > MAX_SPAN_FRAMES) {
      throw new Error(
        `a span of ${to - from + 1} frames does not fit a cache of ${CACHE_FRAMES}: `
        + 'the caller has to clamp it and say what it dropped',
      );
    }
    const runs = [];
    for (let k = from; k <= to; k++) {
      if (this.cache.has(k)) continue;
      const last = runs[runs.length - 1];
      // Split at the chunk length as well as at a cache hit. A run can be the
      // whole pre-roll, and one response covering it would be buffered whole by
      // `arrayBuffer` - hundreds of megabytes for a slow damp on a full-rate
      // take, in a single allocation, for a decode that proceeds frame by frame
      // anyway.
      if (last && last[1] === k - 1 && last[1] - last[0] + 1 < RUN_FRAMES) last[1] = k;
      else runs.push([k, k]);
    }
    // Trimmed after every chunk rather than once at the end, so the cache tracks
    // its ceiling while a long span is filling instead of overshooting it and
    // settling back afterwards. The span itself is protected, which is safe
    // precisely because the guard above bounds it below the ceiling.
    for (const [lo, hi] of runs) {
      await this.fetchRun(lo, hi);
      this.trim(from, to);
    }
  }

  /**
   * A run in one request where there is a run to have. Step 2 measured eight
   * frames as one range request at 2.27ms against 4.93ms as eight separate ones,
   * and a pre-roll asks for exactly that shape - a contiguous block, known in
   * advance, wanted at once.
   */
  async fetchRun(lo, hi) {
    counters.requests++;
    const single = lo === hi;
    const url = single
      ? `/capture/${encodeURIComponent(this.id)}/frame/${lo}`
      : `/capture/${encodeURIComponent(this.id)}/frames/${lo}-${hi}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
    const buffer = await res.arrayBuffer();

    // A single frame is the payload alone and a run is the file's own slice with
    // the KNCT framing still interleaved, because payloads concatenated have no
    // boundaries left to parse back. Two shapes, one decoder below them.
    const decodes = [];
    if (single) {
      decodes.push(this.take(lo, buffer, 0, buffer.byteLength));
    } else {
      const view = new DataView(buffer);
      let off = 0;
      for (let k = lo; k <= hi; k++) {
        if (off + KNCT_HEADER > buffer.byteLength) {
          throw new Error(`run ${lo}-${hi} ended at frame ${k}: the response was short`);
        }
        const magic = view.getUint32(off, true);
        if (magic !== KNCT_MAGIC) {
          throw new Error(`run ${lo}-${hi} desynced at frame ${k}: magic 0x${magic.toString(16)}`);
        }
        const len = view.getUint32(off + 8, true);
        decodes.push(this.take(k, buffer, off + KNCT_HEADER, len));
        off += KNCT_HEADER + len;
      }
    }
    await Promise.all(decodes);
    counters.framesFetched += decodes.length;
  }

  /**
   * One frame payload into the cache. The depth block is copied out rather than
   * kept as a view: a view would pin the whole run's buffer alive for as long as
   * any one of its frames was cached, so an eight-frame run would cost eight
   * times its own size until the last of them was evicted.
   */
  async take(k, buffer, offset, length) {
    const view = new DataView(buffer, offset, length);
    const depthBytes = view.getUint32(0, true);
    const colorBytes = view.getUint32(4, true);
    if (depthBytes !== POINTS * 2) {
      throw new Error(`frame ${k} carries ${depthBytes} depth bytes, expected ${POINTS * 2}`);
    }
    const depth = new Uint16Array(buffer.slice(offset + 16, offset + 16 + depthBytes));
    let bitmap = null;
    if (colorBytes > 0) {
      const jpeg = new Uint8Array(buffer, offset + 16 + depthBytes, colorBytes);
      try {
        bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
      } catch {
        /* a torn JPEG from a dropped USB packet: this frame renders depth only */
      }
    }
    this.cache.set(k, { depth, bitmap });
  }

  /**
   * Drops the oldest frames outside the span just asked for. The two bitmaps the
   * colour textures are holding are skipped whatever their age - closing one
   * would leave the shader sampling a detached bitmap, and the failure would show
   * up as a black colour channel rather than as an error.
   */
  trim(keepFrom, keepTo) {
    if (this.cache.size <= CACHE_FRAMES) return;
    const bound = [colorPrev.image, colorCurr.image];
    for (const k of this.cache.keys()) {
      if (this.cache.size <= CACHE_FRAMES) break;
      if (k >= keepFrom && k <= keepTo) continue;
      const frame = this.cache.get(k);
      if (frame.bitmap && bound.includes(frame.bitmap)) continue;
      frame.bitmap?.close();
      this.cache.delete(k);
    }
  }

  makeCurrent(k) {
    const frame = this.cache.get(k);
    // Loud rather than approximate. A missing frame means the transport rendered
    // without awaiting its own fetch, and the alternative to throwing is an image
    // built from whatever depth happened to still be in the texture - which would
    // be a wrong picture that no later check could attribute to anything.
    if (!frame) throw new Error(`frame ${k} is not resident: ensure() was not awaited`);
    bindDepth(frame.depth);
    // Colour arrives at half the depth rate on this sensor, so a frame without a
    // JPEG leaves the pair where it was. That is what the live path does with the
    // same stream, and matching it is what makes a seek reproduce a playback.
    if (frame.bitmap) bindColor(frame.bitmap);
  }

}

// ------------------------------------------------------------------ the timeline

// The playhead driven by the timeline rather than by an arrival. Everything
// expensive about that comes from the two feedback accumulators: the image at t
// is not a function of the frames at t, so landing on a position means rendering
// the frames before it and throwing them away. How many is computable.
//
// The two halves are sized in different units and both are converted to output
// frames here, because a pre-roll is a run of `renderProgramFrame` calls and
// nothing else. Fade and wake are source milliseconds - they stay source-referred
// for the three reasons the design gives - so they convert through the retime
// slope and the output frame rate. The afterimage is already in output frames and
// depends only on damp. Neither is a constant, so both are computed per seek.

// 1% of the previous image left in the afterimage. Three's pass is
// `max(new, damp * old)` with anything under 0.1 zeroed outright, so a residual
// this small has already been cut to exactly zero rather than merely made small -
// which is what lets a seek land on the same pixels as a playback instead of near
// them.
const AFTERIMAGE_RESIDUAL = 0.01;

// The three the accumulators run on. A draft holds them at zero for one frame:
// with fade and wake at zero the ghost half leaves the draw range and the live
// half's ramp-in is a constant 1, so the surface memory contributes nothing to
// the image at all, and with trails at zero the afterimage pass is switched off.
// That is the whole of what makes a draft a single frame with no history.
const BYPASSED = ['fade', 'wake', 'trails'];
const BYPASS_ZERO = { fade: 0, wake: 0, trails: 0 };

// The most output frames one tick may render to catch up. Enough to absorb a
// hitch of a few frames, small enough that a machine which cannot sustain the
// rate still yields between ticks rather than freezing the tab trying.
const CATCHUP_FRAMES = 4;
// How far behind real time playback has to fall before it says so. About eight
// frames at 30fps: below that it is a hitch, above it the rate on screen is not
// the rate the readout claims.
const BEHIND_NOTICE_MS = 250;

class TimelineTransport {
  constructor(source) {
    this.source = source;
    this.outputFps = 30;
    // The playhead is an integer output frame rather than a float second, so
    // playback and a seek walk the same grid. A seek that landed between two
    // output frames would pre-roll along a different set of positions than the
    // playback it is meant to reproduce, and the images would differ for a reason
    // nothing records.
    this.frame = 0;
    this.playing = false;
    this.nextDueMs = 0;
    // Raised by a draft, because a draft is deliberately not the true image.
    // Anything that has to be true - releasing the scrubber, pressing play -
    // clears it by seeking.
    this.drafted = false;
    this.prefetching = null;
    this.lastSeek = null;
    this.lastCostMs = 0;
    // How far playback is running behind real time, in wall milliseconds. Never
    // closed by skipping - only reported.
    this.behindMs = 0;
    // The tail of the operation chain, and whether one is running right now.
    this.queue = null;
    this.working = false;
  }

  get programSec() { return this.frame / this.outputFps; }

  /** Program seconds. The retime answers it, because only the retime knows how. */
  get duration() { return retime.programDurationFor(this.source.duration); }

  get lastFrame() { return Math.max(0, Math.floor(this.duration * this.outputFps)); }

  frameAt(programSec) {
    return Math.max(0, Math.min(this.lastFrame, Math.round(programSec * this.outputFps)));
  }

  sourceFrameAt(programSec) {
    return this.source.bracket(retime.sourceSecAt(programSec));
  }

  /**
   * Everything that produces an image runs alone, in the order it was asked for.
   *
   * Two of them interleaved is the failure this transport keeps finding, and it
   * is always the same shape: an operation clears the accumulators and walks
   * forward, another one resumes inside that walk, and the second asks the source
   * to go backwards. The source refuses - correctly, and far too late for anyone
   * to do anything with. A repaint landing under a scrub, a scrub release landing
   * under a repaint, and a preset applied while a seek is still fetching its
   * frames are all that shape, so they are all fixed here rather than one at a
   * time at the three call sites that happen to have been noticed.
   */
  async exclusive(work) {
    const run = async () => {
      this.working = true;
      try {
        return await work();
      } finally {
        this.working = false;
      }
    };
    const mine = (this.queue ?? Promise.resolve()).then(run, run);
    // The chain itself must never reject, or one failed operation would be
    // inherited by every operation queued behind it.
    this.queue = mine.catch(() => {});
    return mine;
  }

  /** Resolves once nothing this transport started is still running. */
  idle() { return this.queue ?? Promise.resolve(); }

  /**
   * How many output frames have to be rendered and discarded ahead of a seek.
   * Reported in both halves rather than as one number, because which half wins
   * says which parameter to reach for when a seek is slow.
   */
  preroll(programSec = this.programSec) {
    const surfaceSec = uniforms.fadeTime.value + uniforms.wakeTime.value;
    // How much source time one output frame advances. A hold has a slope of zero
    // and no number of output frames covers a source duration at that speed, so
    // the surface half is skipped there - correctly, because a hold is not
    // advancing the surface memory either.
    const sourcePerFrame = Math.abs(retime.slopeAt(programSec)) / this.outputFps;
    const surface = sourcePerFrame > 0 ? Math.ceil(surfaceSec / sourcePerFrame) : 0;
    const damp = afterimage.enabled ? afterimage.uniforms.damp.value : 0;
    const trails = damp > 0 ? Math.ceil(Math.log(AFTERIMAGE_RESIDUAL) / Math.log(damp)) : 0;
    const frames = Math.max(surface, trails);
    return { surface, trails, frames, sec: frames / this.outputFps };
  }

  /**
   * The true image at a program position: clear both feedback paths, then render
   * forward from far enough back that neither carries anything the playback would
   * not have carried. `frames` overrides the computed length, which is how the
   * proof tool shows that the computed one is load-bearing rather than generous.
   */
  seek(programSec, options = {}) {
    return this.exclusive(() => this.seekNow(programSec, options));
  }

  async seekNow(programSec, { frames } = {}) {
    const target = this.frameAt(programSec);
    const t = target / this.outputFps;
    const plan = this.preroll(t);
    const asked = frames ?? plan.frames;
    let length = asked;
    let start = Math.max(0, target - length);
    const to = this.sourceFrameAt(t) + 1;
    let from = this.sourceFrameAt(start / this.outputFps);

    // A pre-roll can want more source frames than the cache can hold - the trails
    // half is a count of output frames whatever the rate, so a slow damp at a high
    // speed reaches far back through the take. Fetching it anyway would evict its
    // own head before the render reached it, so the pre-roll is shortened to what
    // can be held and the shortfall is recorded the way head-clipping already is.
    // An honest short pre-roll beats a long one built on frames that went away.
    if (to - from + 1 > MAX_SPAN_FRAMES) {
      from = to - MAX_SPAN_FRAMES + 1;
      start = Math.min(target, Math.ceil(retime.programSecAt(this.source.times[from]) * this.outputFps));
      length = target - start;
    }
    await this.source.ensure(from, to);

    const began = performance.now();
    counters.seeks++;
    resetAccumulators();
    this.source.seekTo(from);
    // Navigation advances once for the whole seek rather than once per pre-roll
    // frame. The pre-roll is hidden rendering, so letting the controls settle
    // through it would smear the orbit's damping into the afterimage of an image
    // nobody asked to be moving.
    advanceNavigation(t);
    for (let k = start; k <= target; k++) renderProgramFrame(k / this.outputFps);

    this.lastCostMs = performance.now() - began;
    this.frame = target;
    this.drafted = false;
    this.lastSeek = {
      target, start, frames: length, plan,
      // A pre-roll that ran into the head of the take is shorter than the one
      // that was computed, so an equality proved at such a position is proving
      // something easier. Recorded rather than hidden.
      clamped: asked > target,
      // And so is one the frame cache could not hold. Both are the same kind of
      // fact - the seek did less than it computed - and a reader has to be able
      // to tell which, because only the second is a ceiling worth raising.
      capped: length < Math.min(asked, target),
      shortfall: Math.min(asked, target) - length,
      sourceFrames: to - from + 1,
    };
    this.paint();
    return this.lastSeek;
  }

  /**
   * One frame with the accumulators bypassed, for the length of a drag. The
   * parameters are zeroed after the fetch and restored before returning, all
   * inside one task, so the panel never paints them at zero.
   *
   * This is the shape the note on `evaluating` predicted - a bulk write landing
   * immediately either side of a render, semantically inside evaluation with the
   * flag down - and the flag is deliberately not widened over it. Two reasons.
   * The rule the flag enforces is that a *preset* is a user action rather than a
   * track, and a draft writes no track: it borrows three parameters for one frame
   * and gives them back, so refusing a preset click during a seek would be a
   * different rule wearing this one's name. And the window that would need
   * protecting cannot be entered - there is no await between the borrow and the
   * restore, so no gesture can land inside it and leave the three parameters
   * stranded at zero. Step 5's evaluator is a different case and still wants the
   * honest boundary the note asks for.
   */
  draft(programSec) {
    return this.exclusive(() => this.draftNow(programSec));
  }

  async draftNow(programSec) {
    const target = this.frameAt(programSec);
    const t = target / this.outputFps;
    const i = this.sourceFrameAt(t);
    await this.source.ensure(i, i + 1);

    const began = performance.now();
    // Borrow, render and hand back, none of it asking for a repaint: these three
    // writes are the transport's own, and a repaint scheduled off them would run
    // the accurate seek this frame exists to avoid.
    withoutRepaint(() => {
      const held = params.values(BYPASSED);
      params.apply(BYPASS_ZERO);
      try {
        // The reset is what lets a drag go backwards. Nothing here reads the
        // accumulators, so clearing them costs four target clears and removes the
        // one state that could not be walked the other way.
        resetAccumulators();
        this.source.seekTo(i);
        advanceNavigation(t);
        renderProgramFrame(t);
      } finally {
        params.apply(held);
      }
    });

    this.lastCostMs = performance.now() - began;
    counters.drafts++;
    this.frame = target;
    this.drafted = true;
    this.paint();
    return this.lastCostMs;
  }

  /**
   * One output frame forward, or false if there is nothing to advance to. The
   * playback loop and the proof tool drive the same call - the loop adds pacing
   * and prefetch around it and nothing else.
   */
  step() {
    const next = this.frame + 1;
    if (next > this.lastFrame) return false;
    const t = next / this.outputFps;
    if (!this.source.resident(this.source.applied + 1, this.sourceFrameAt(t) + 1)) return false;
    advanceNavigation(t);
    renderProgramFrame(t);
    this.frame = next;
    return true;
  }

  tick(nowMs = performance.now()) {
    if (!this.playing) return;
    // An exclusive operation is mid-walk, and stepping into it would advance the
    // accumulators underneath a reset that has already happened.
    if (this.working) {
      this.prefetch();
      return;
    }
    // Every frame that has come due is rendered, up to a cap, and only the last
    // of them reaches the screen. That honours never-skip - each one still walks
    // the accumulators, which is the whole reason a frame cannot be dropped -
    // while letting a single slow tick be repaid instead of becoming a permanent
    // offset. The cap is what stops a machine that cannot keep up from spending
    // an entire tick catching up and never yielding.
    let rendered = 0;
    while (nowMs >= this.nextDueMs && rendered < CATCHUP_FRAMES) {
      if (!this.step()) break;
      this.nextDueMs += 1000 / this.outputFps;
      rendered++;
    }
    if (rendered > 0) this.paint();
    else if (this.frame >= this.lastFrame) this.pause();
    // Anything still owed after the cap is a deficit the machine is not going to
    // repay, and it is surfaced rather than absorbed: a link too slow to feed the
    // playhead and a renderer too slow to draw it both look like smooth playback
    // at the wrong speed, which is the one thing an instrument must not do
    // quietly. Nothing is skipped to close it - playback runs late, in order.
    this.behindMs = Math.max(0, nowMs - this.nextDueMs);
    this.prefetch();
  }

  /** The fetch in flight, or null when the window ahead is already resident. */
  prefetch() {
    if (this.prefetching) return this.prefetching;
    // Clamped for the same reason a seek is: at a high rate the window ahead
    // covers more source frames than the cache holds, and asking for them is a
    // refusal rather than a slow answer. Prefetching less is harmless - the next
    // tick asks again from wherever the playhead has reached.
    const ahead = Math.min(
      this.sourceFrameAt((this.frame + PREFETCH_FRAMES) / this.outputFps) + 1,
      this.source.applied + MAX_SPAN_FRAMES - 1,
    );
    if (this.source.resident(this.source.applied, ahead)) return null;
    const fetching = this.source.ensure(this.source.applied, ahead)
      .catch((err) => showTimelineError(err))
      .finally(() => { if (this.prefetching === fetching) this.prefetching = null; });
    this.prefetching = fetching;
    return fetching;
  }

  /**
   * Playback with the wall clock taken out: every output frame in order, as fast
   * as the bytes arrive. This is what step 6's export transport is, and it is
   * also how a proof tool reaches a position "by playback" without waiting real
   * seconds for it. It adds no rendering of its own - `step` is still the only
   * thing that renders - so a run and a played take walk identical positions.
   */
  runTo(toFrame) {
    return this.exclusive(() => this.runToNow(toFrame));
  }

  async runToNow(toFrame) {
    const limit = Math.min(toFrame, this.lastFrame);
    let stalls = 0;
    while (this.frame < limit) {
      if (this.step()) {
        stalls = 0;
        continue;
      }
      if (++stalls > 200) throw new Error(`playback stalled at output frame ${this.frame}`);
      await (this.prefetch() ?? new Promise((r) => setTimeout(r, 0)));
    }
    return this.frame;
  }

  async play() {
    if (this.playing) return;
    this.behindMs = 0;
    // A draft is not the image playback would have produced, so playing on from
    // one would start the afterimage off a picture that never existed.
    if (this.drafted) await this.seek(this.programSec);
    this.playing = true;
    this.nextDueMs = performance.now();
    this.paint();
  }

  pause() {
    this.playing = false;
    this.paint();
  }

  paint() { paintTimeline(this); }
}

// --------------------------------------------------------------- the timeline UI

// Deliberately small. The scrubber, the playhead, play/pause and a speed control,
// and the two clocks that say what the coordinate actually is - program time read
// off the ruler and source time derived from it through the retime, never edited.
// Step 5 is what grows lanes, keys and a curve underneath this.

const ui = {
  root: timelineEl,
  play: document.getElementById('tPlay'),
  program: document.getElementById('tProgram'),
  source: document.getElementById('tSource'),
  rate: document.getElementById('tRate'),
  rateOut: document.getElementById('tRateOut'),
  fps: document.getElementById('tFps'),
  preroll: document.getElementById('tPreroll'),
  cost: document.getElementById('tCost'),
  behind: document.getElementById('tBehind'),
  bed: document.getElementById('tBed'),
  ruler: document.getElementById('tRuler'),
  playhead: document.getElementById('tPlayhead'),
  note: document.getElementById('tNote'),
};

let timeline = null;

const timecode = (sec) => {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
};

function showTimelineError(err) {
  ui.note.textContent = String(err?.message ?? err);
  console.error('[timeline]', err);
}

function paintTimeline(t) {
  const program = t.programSec;
  ui.play.textContent = t.playing ? '❙❙' : '▶';
  ui.play.setAttribute('aria-label', t.playing ? 'Pause' : 'Play');
  ui.program.textContent = timecode(program);
  ui.source.textContent = timecode(retime.sourceSecAt(program));
  ui.playhead.style.left = `${(program / Math.max(1e-6, t.duration)) * 100}%`;
  const plan = t.preroll(program);
  // Both halves, because which one wins is the whole point of computing it: the
  // surface half moves with fade, wake, speed and output rate, the trails half
  // only with damp, and a reader who sees one number cannot tell them apart.
  ui.preroll.textContent = `${plan.frames} frames · ${plan.sec.toFixed(2)} s `
    + `(surface ${plan.surface}, trails ${plan.trails})`;
  ui.cost.textContent = t.lastCostMs
    ? `${t.drafted ? 'draft' : 'seek'} ${t.lastCostMs.toFixed(1)} ms`
    : '—';
  // Playback never drops a frame to keep up, so falling behind is a fact about
  // the machine rather than about the edit, and it belongs on screen for the same
  // reason the decimation setting does: an instrument that silently changes its
  // own scale is worse than none.
  ui.behind.textContent = t.playing && t.behindMs > BEHIND_NOTICE_MS
    ? `${(t.behindMs / 1000).toFixed(1)}s behind`
    : '';
}

function buildRuler(t) {
  const total = Math.max(1e-6, t.duration);
  const step = total > 120 ? 20 : total > 60 ? 10 : total > 20 ? 5 : 1;
  const ticks = [];
  for (let s = 0; s <= total; s += step) {
    const tick = document.createElement('div');
    tick.className = 'ttick';
    tick.style.left = `${(s / total) * 100}%`;
    const label = document.createElement('label');
    label.textContent = `${s}s`;
    tick.appendChild(label);
    ticks.push(tick);
  }
  ui.ruler.replaceChildren(...ticks);
}

// A drag resolves at whatever rate the drafts come back, and never queues more
// than one behind the one in flight: the position the pointer is at now is the
// only one worth rendering, so an older one is dropped rather than caught up on.
// Same shape as the colour decode pump, and for the same reason.
let draftWanted = null;
let draftBusy = false;

async function pumpDraft() {
  if (draftBusy || draftWanted === null || !timeline) return;
  draftBusy = true;
  const t = draftWanted;
  draftWanted = null;
  try {
    await timeline.draft(t);
  } catch (err) {
    showTimelineError(err);
  } finally {
    draftBusy = false;
    if (draftWanted !== null) pumpDraft();
  }
}

// A look change while the playhead is parked has to rebuild the image, and it has
// to rebuild it *accurately*. Drafting here would be worse than useless: fade,
// wake and trails are exactly the three a draft zeroes, so grading them against
// one would show nothing changing at all - which is the WYSIWYG failure the
// single-renderer decision exists to prevent, arriving through the back door.
//
// An accurate seek is 33ms at Blackwall, so a slider drag resolves at about
// 30 repaints a second, and the coalescing below is what keeps it there: only the
// latest state is worth rebuilding, so an older request is dropped rather than
// caught up on. A look with a long pre-roll repaints more slowly, which is honest
// - the chip beside it says how many frames it is paying for.
let repaintWanted = false;
let repaintBusy = false;
let repaintScheduled = false;

async function pumpRepaint() {
  if (repaintBusy || !repaintWanted || !timeline) return;
  repaintBusy = true;
  repaintWanted = false;
  try {
    await timeline.seek(timeline.programSec);
  } catch (err) {
    showTimelineError(err);
  } finally {
    repaintBusy = false;
    if (repaintWanted) pumpRepaint();
  }
}

/** Rebuilds the image and the readouts at wherever the playhead is parked. */
function requestRepaint() {
  // Playing rebuilds every frame anyway, and a drag is about to ask for the true
  // image the moment it ends, so neither needs one scheduled underneath it.
  if (!timeline || timeline.playing || scrubbing || orbiting) return;
  repaintWanted = true;
  if (repaintScheduled) return;
  repaintScheduled = true;
  // Deferred to the end of the task so a bulk write asks for one image rather
  // than a queue of them. Selecting Blackwall is twelve registry writes plus the
  // mode itself: repainting on the first would render a look with one parameter
  // applied and eleven still to come, then render the real one behind it - two
  // accurate seeks to show one picture, the first of which never existed.
  queueMicrotask(() => {
    repaintScheduled = false;
    pumpRepaint();
  });
}

paramWritten = (name, tag) => {
  // View state changes what you are looking at rather than what the clip is, and
  // both of today's view parameters already do their own work: render scale
  // resizes the buffers, and auto-orbit only means anything with a clock running.
  if (tag === 'view' || transportWriting) return;
  requestRepaint();
};

const programAtPointer = (e) => {
  const r = ui.bed.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * timeline.duration;
};

let scrubbing = false;

ui.bed.addEventListener('pointerdown', (e) => {
  if (!timeline) return;
  ui.bed.setPointerCapture(e.pointerId);
  scrubbing = true;
  timeline.pause();
  draftWanted = programAtPointer(e);
  pumpDraft();
});

ui.bed.addEventListener('pointermove', (e) => {
  if (!scrubbing) return;
  draftWanted = programAtPointer(e);
  pumpDraft();
});

for (const type of ['pointerup', 'pointercancel']) {
  ui.bed.addEventListener(type, (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    // The queued position goes first, and it is the whole of the fix for the one
    // gesture this transport exists to get right. A draft is usually in flight
    // when the pointer comes up, and its `finally` pumps whatever is queued
    // behind it - so without this the release would render the true image and
    // then paint a draft of the second-to-last pointer position over the top of
    // it, leaving `drafted` up and the playhead a few frames out. The fetch
    // ordering guarantees the wrong one lands last rather than making it a race.
    draftWanted = null;
    // Releasing is what asks for the true image, so this is the one gesture that
    // pays for a pre-roll. The picture visibly changes here, which is the
    // well-understood convention rather than a surprise.
    timeline.seek(programAtPointer(e)).catch(showTimelineError);
  });
}

ui.play.addEventListener('click', () => {
  if (!timeline) return;
  if (timeline.playing) timeline.pause();
  else timeline.play().catch(showTimelineError);
});

ui.rate.addEventListener('input', () => {
  if (!timeline) return;
  // Speed is the retime's slope, which is document state rather than transport
  // state - it is the one-key version of the curve step 5 draws. Changing it
  // moves where the playhead's program time lands in the take, so the image has
  // to be rebuilt at the position the playhead already holds.
  retime.rate = Number(ui.rate.value);
  ui.rateOut.textContent = `${retime.rate.toFixed(2)}×`;
  const wasPlaying = timeline.playing;
  timeline.pause();
  buildRuler(timeline);
  timeline.seek(Math.min(timeline.programSec, timeline.duration))
    .then(() => { if (wasPlaying) return timeline.play(); })
    .catch(showTimelineError);
});

ui.fps.addEventListener('change', () => {
  if (!timeline) return;
  const held = timeline.programSec;
  timeline.outputFps = Number(ui.fps.value);
  const wasPlaying = timeline.playing;
  timeline.pause();
  timeline.seek(held)
    .then(() => { if (wasPlaying) return timeline.play(); })
    .catch(showTimelineError);
});

// Orbiting while the playhead is parked has the same shape as scrubbing: a drag
// wants a cheap frame per pointer move and a true one on release. Only a pointer
// drag is answered - the controls also fire `change` from the update inside a
// render, and answering that would render itself in a loop.
let orbiting = false;
controls.addEventListener('start', () => { orbiting = true; });
controls.addEventListener('change', () => {
  if (!orbiting || !timeline || timeline.playing) return;
  draftWanted = timeline.programSec;
  pumpDraft();
});
controls.addEventListener('end', () => {
  orbiting = false;
  if (!timeline || timeline.playing) return;
  // Same release rule as the scrubber: whatever is queued behind the draft in
  // flight would otherwise paint itself over the true image this asks for.
  draftWanted = null;
  timeline.seek(timeline.programSec).catch(showTimelineError);
});

/**
 * Opens a take on the timeline. The live socket is never opened on this path.
 *
 * **Step 6 has to fix this before it exports anything.** The sensor's intrinsics -
 * `uniforms.focal` and `uniforms.center` - arrive only over the WebSocket, in the
 * hello the grabber sends, so a page opened on a take renders on the defaults
 * baked into the uniform block: fx 366, fy 366, cx 256, cy 212. Those are the
 * nominal values, and this sensor's own hello reports cx 257.775909 and
 * cy 206.784195, so every unprojected point is already a fraction of a pixel out
 * and a take from a differently-calibrated device would be further. Nothing on
 * screen can show it, because the whole image is consistently wrong in the same
 * way - which is exactly why it has to be written down here rather than left to
 * be noticed. The fix is small and step 2 already did the hard part: the sidecar
 * records the hello's offset and length, so the intrinsics are one fetch away and
 * belong in this function beside the index.
 */
async function openTake(id) {
  const source = await IndexedPairSource.open(id);
  // A page opened on a take opens no socket at all, and the detach is still the
  // door it goes through: the flag it raises is what stops a colour decode
  // started anywhere else from landing in the textures under a timeline render.
  detachStream();
  sensorLabel = `take ${id} · ${source.count} frames · ${source.duration.toFixed(2)}s`;
  setStatus();

  pairSource = source;
  timeline = new TimelineTransport(source);
  document.body.classList.add('editing');
  ui.root.hidden = false;
  ui.rateOut.textContent = `${retime.rate.toFixed(2)}×`;
  ui.fps.value = String(timeline.outputFps);
  resize();
  buildRuler(timeline);
  await timeline.seek(0);
  renderer.setAnimationLoop(() => timeline.tick());
  return timeline;
}

// ------------------------------------------------------------------ drive hook

// A run of capture frames pinned from a file, driving the renderer with no socket
// and no wall clock anywhere in the loop. Everything about the walk it performs is
// the shared one; all it adds is that its bytes are already in memory.
class PinnedPairSource extends StampedPairSource {
  constructor(buffer) {
    const view = new DataView(buffer);
    const frames = [];
    for (let off = 0; off + 16 <= buffer.byteLength;) {
      const depthBytes = view.getUint32(off, true);
      const colorBytes = view.getUint32(off + 4, true);
      frames.push({
        depth: new Uint16Array(buffer, off + 16, depthBytes / 2),
        stampMs: Number(view.getBigUint64(off + 8, true)),
      });
      off += 16 + depthBytes + colorBytes;
    }
    const first = frames[0].stampMs;
    super(frames.map((f) => (f.stampMs - first) / 1000));
    this.frames = frames;
  }

  makeCurrent(k) {
    bindDepth(this.frames[k].depth);
  }
}

let pinnedPairs = null;

// ------------------------------------------------------------------------- boot

// Which transport owns the loop is decided once, here, and the two are exclusive:
// a page editing a take must not have a socket writing depth into the textures
// underneath it, and a live viewer has no timeline to drive. There is no gallery
// yet to pick a take from, so the take is named on the URL - step 7 replaces this
// line with a library and nothing below it changes.
const REQUESTED_TAKE = new URLSearchParams(location.search).get('take');

if (REQUESTED_TAKE) {
  openTake(REQUESTED_TAKE).catch((err) => {
    sensorLabel = `cannot open take ${REQUESTED_TAKE}`;
    setStatus();
    showTimelineError(err);
  });
} else {
  // Opened here rather than beside the socket code, because `handleFrame` pushes
  // into the pair source above. Arrivals cannot dispatch until module evaluation
  // finishes either way, but relying on that at the call site makes the ordering
  // look accidental when it is a requirement.
  connect();
  renderer.setAnimationLoop(liveLoop);
}

// Handles for profiling and for poking at the scene from the console.
globalThis.__kinect = {
  renderer, composer, scene, freeCamera, programCamera, controls, uniforms, material,
  bloom, afterimage, grade, geometry, resetAccumulators, renderProgramFrame,

  // The registry and the two bulk writes a user gesture performs. Both refuse
  // while a frame is being evaluated - see the note on `evaluating` for exactly
  // how far that reaches and where step 5 has to extend it.
  params, applyPreset, setMode, presets: { BLACKWALL, NEUTRAL },
  mode: () => clipMode,
  // No control switches the viewport yet - the free camera is what the live
  // viewer shows. This is how the program camera is reached until step 5 gives
  // it a path worth looking at and the top-down view a reason to draw its frustum.
  setViewCamera,
  viewCamera: () => viewCamera,

  // The timeline, and the counters a proof tool reads instead of taking the
  // transport's word for what it did. A check asserting "the seek reset the
  // accumulators once and rendered 29 frames" has to be able to see both numbers,
  // or it is restating the claim rather than testing it.
  timeline: {
    open: openTake,
    transport: () => timeline,
    retime,
    counters,
    /**
     * Resolves once every scheduled repaint has been enqueued and run and the
     * transport's queue has drained. Anything measuring renders needs it: a
     * repaint it did not ask for would land inside its window and be counted as
     * work the thing under test performed.
     */
    async settled() {
      for (let i = 0; i < 200; i++) {
        // A macrotask, so a repaint scheduled on the microtask queue has been
        // enqueued by the time the transport is asked whether it is idle.
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        await timeline?.idle();
        if (!repaintWanted && !repaintBusy && !repaintScheduled && !timeline?.working) return;
      }
      throw new Error('the transport never settled');
    },
    /** A snapshot, so a reader cannot accidentally hold a live object. */
    read() {
      if (!timeline) return null;
      const t = timeline;
      return {
        frame: t.frame,
        programSec: t.programSec,
        sourceSec: retime.sourceSecAt(t.programSec),
        outputFps: t.outputFps,
        rate: retime.rate,
        duration: t.duration,
        lastFrame: t.lastFrame,
        playing: t.playing,
        drafted: t.drafted,
        lastSeek: t.lastSeek,
        lastCostMs: t.lastCostMs,
        behindMs: t.behindMs,
        preroll: t.preroll(),
        applied: t.source.applied,
        cached: t.source.cache.size,
        mixT: uniforms.mixT.value,
        sinceFrameSec: uniforms.sinceFrameSec.value,
        hasColor: uniforms.hasColor.value,
      };
    },
  },

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
    /**
     * One frame's depth straight into the current texture, bypassing every pair
     * source. This exists for one check and it is the only one that can be made:
     * everything else a transport proves is relative, because both arms of a
     * comparison walk the same lookup, so a systematic off-by-one in which frame
     * gets bound would shift them together and agree. Rendering from bytes handed
     * in here ties a picture to a frame number instead.
     */
    injectDepth(depth) { bindDepth(depth); },
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
