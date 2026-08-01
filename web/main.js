import * as THREE from 'three';
import { PROJECT_VERSION } from './format.js';
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
// Named, because the editor's furniture lives on a second canvas over this one and
// "the canvas" stopped being an unambiguous thing to ask for. This is the rendered
// frame; the other one is chrome.
renderer.domElement.id = 'stage';
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

// Orienting is done on a camera-shaped scratch object rather than on a bare
// Object3D, because three points cameras and lights down -Z and everything else
// down +Z: the same lookAt on the wrong kind of object gives a pose facing the
// other way, and it would look plausible right up until the frustum was drawn.
const poseScratch = new THREE.PerspectiveCamera();

// A pose as a value rather than as a camera that has been moved, because the
// camera is a registry parameter like every other one and everything reaches it
// through the same door. Step 4 fed this from a placeholder orbit; the camera
// track feeds it now, and nothing downstream of the registry changed for that.
function poseLookingAt(position, target = ORBIT_TARGET, fov = PROGRAM_FOV) {
  poseScratch.position.copy(position);
  poseScratch.lookAt(target);
  return {
    position: poseScratch.position.toArray(),
    quaternion: poseScratch.quaternion.toArray(),
    fov,
  };
}

// Where the program camera stands when nothing has keyed it: exactly where the
// free camera starts, looking at the same point. A clip with no camera keys is a
// locked-off shot rather than a camera at the origin staring into the void.
const DEFAULT_POSE = poseLookingAt(new THREE.Vector3(0, 0.1, 1.6));

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
  // The drawing buffer's height, which is what makes every screen-space term
  // below a fraction of the frame rather than a count of pixels. Written by
  // `resize` and by nothing else, so the one place the buffer can change is also
  // the one place this can.
  bufferHeight: { value: 1080 },
  pointSize: { value: 9 },
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
uniform float bufferHeight;
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

  // Every screen-space term in this renderer is defined against a 1080p reference
  // and scales with the drawing buffer, and this is the dominant one. Set in
  // framebuffer pixels and scaled by distance but not by buffer height, the same
  // scene at twice the height kept each point the same pixel size while the frame
  // gained four times the pixels: coverage per point dropped fourfold, the 217k
  // points stopped overlapping into a surface, and the sub-pixel RGB split began
  // fringing individual points instead of edges. That is a different image rather
  // than the same one at higher fidelity, so pointSize is now pixels at 1080p.
  //
  // The clamp stays in framebuffer pixels deliberately. It is a bound on what the
  // hardware can draw rather than a look value: ALIASED_POINT_SIZE_RANGE is
  // [1, 511] on this GPU, so a sub-pixel point is not expressible at all and
  // scaling the lower bound would be a more elaborate way of asking for one. The
  // residual is confined to the clamped tails - the far cloud below one pixel, and
  // points closer than about a quarter of a metre - and a check comparing two
  // output sizes has to keep out of that band rather than pretend it is not there.
  float k = bufferHeight / 1080.0;
  gl_PointSize = clamp(pointSize * k / max(0.15, -mv.z), 1.0, 64.0);
  // Carried in reference pixels rather than framebuffer ones, because the fragment
  // shader normalises a splat's additive energy against its area. For the same
  // image at twice the size each point covers four times the pixels, so it has to
  // keep the same alpha - normalising against the drawn size instead would make
  // the identical look sum four times too bright at twice the resolution.
  vSize = gl_PointSize / k;
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
  // 116.64 is forced by the unit change rather than chosen. The same look now asks
  // for 1.8 times the point size it used to, so holding alpha fixed at every
  // distance means C / (1.8 P / d)^2 = 36 / (P / d)^2, and the only C that
  // satisfies it is 36 * 1.8^2. Leaving it at 36 would have moved the distance at
  // which the normalisation starts biting from 0.75m out to 1.35m - a look change
  // wearing a resolution fix's clothes.
  if (softEdge == 1) alpha *= clamp(116.64 / (vSize * vSize), 0.05, 1.0);

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

// Every grid a depth block can arrive on, keyed by its own sample count. The
// divisor is negotiated out of band on the socket, but a frame already in flight
// when the setting changes arrives under the previous one - so the length is what a
// frame actually is, where the last grant is only what the next frame will be. Every
// divisor the socket and the frame API accept lands on a distinct count, so nothing
// here has to be told which one it is looking at.
const DEPTH_GRIDS = new Map();
for (let k = 1; k <= 16; k++) {
  const w = Math.ceil(DW / k);
  const h = Math.ceil(DH / k);
  DEPTH_GRIDS.set(w * h, { k, w, h });
}

/**
 * A decimated grid back onto the sensor's own, nearest-neighbour, which is exactly
 * the sampling `decimatePayload` did on the node run backwards.
 *
 * A texel only means anything at the pixel it was measured at: the shader unprojects
 * `(col + 0.5 - cx) / fx * z` against intrinsics the sensor reported for a 512x424
 * grid, so where a sample sits in the texture *is* the ray it is claimed to lie on.
 * Writing a smaller grid straight into the larger one is therefore not a coarser
 * picture, it is a different scene. At ÷4 the 13,568 samples land in the first 27 of
 * 424 rows and the live cloud collapses into a band about a metre above the optical
 * axis, while the 203,520 texels the frame cannot reach - 93.8% of the grid - keep
 * the last full-rate frame and stand there frozen where the room used to be. That
 * reads as the depth returns having lost their scale, which is what it was reported
 * as, and it is a monitor silently changing its own geometry: the one thing the
 * design says an instrument must never do.
 *
 * Paying it back in compute rather than on the wire is the right side to pay on. The
 * divisor exists because a radio link cannot carry 14.6 MB/s and never because a
 * machine could not keep up, so expanding here costs the client the GPU it already
 * had spare and leaves the saving where it was asked for.
 */
function expandDepth(src, dst) {
  const grid = DEPTH_GRIDS.get(src.length);
  if (!grid) {
    throw new Error(
      `a depth block of ${src.length} samples is not the ${DW}x${DH} grid at any divisor this `
      + 'build serves: refusing rather than filling the head of the texture with it and '
      + 'unprojecting whatever was already in the rest as though it were the scene',
    );
  }
  if (grid.k === 1) {
    dst.set(src);
    return;
  }
  for (let row = 0; row < DH; row++) {
    const from = ((row / grid.k) | 0) * grid.w;
    const to = row * DW;
    for (let col = 0; col < DW; col++) dst[to + col] = src[from + ((col / grid.k) | 0)];
  }
}

// The two doors every acquisition path goes through to put a capture frame in
// front of the shader. There is one of each rather than one per source, because
// the swap is the part that has to be identical: a socket arrival, a pinned run
// and an indexed pull all have to leave the textures in the same relationship or
// the renderer would produce a different image depending on where the bytes came
// from - which is the drift this whole design is arranged to prevent.
//
// The expansion is inside the door for the same reason. A monitor was the only
// caller handing over a decimated grid, so fixing it where the socket unpacks its
// bytes would have left the next caller that decimates - the editor over a slow
// link, which the design already asks for - to find the same hole again.
function bindDepth(data) {
  const swap = depthPrev;
  depthPrev = depthCurr;
  depthCurr = swap;
  expandDepth(data, depthCurr.image.data);
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
      // The same 1080p reference the point pass uses. Every term here is sized in
      // reference pixels rather than framebuffer ones, so the grade a look was
      // built at holds at any output size: without it the split narrows, the
      // scanlines crowd and the grain thins as resolution rises - a look that is
      // *nearly* resolution-independent, which is the kind you trust and then have
      // to debug. Bloom needs none of this and gets none: it already runs at half
      // the drawing buffer, so it is proportional by construction.
      float k = resolution.y / 1080.0;
      vec2 ref = resolution / k;
      vec2 texel = 1.0 / ref;
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
        float line = sin(vUv.y * ref.y * 1.3 + time * 2.0) * 0.5 + 0.5;
        col *= 1.0 - scanlines * 0.35 * line;
      }

      if (grain > 0.0) {
        // Weighted by luminance so grain lives in the signal instead of lifting
        // the empty background into a grey haze.
        //
        // Quantised onto the reference grid rather than sampled continuously, so
        // one grain cell is one 1080p pixel wherever the frame is drawn. Sampling
        // continuously would give four sub-pixels of a 2x render four unrelated
        // hash values that average to a quarter of the variance, which is exactly
        // the "grain grows finer as resolution rises" this reference exists to
        // stop. At 1080p it is the same one-value-per-pixel noise it always was,
        // off a different seed.
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        float n = hash(floor(vUv * ref) + fract(time) * 137.0);
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

// The drawing buffer an export has taken over, or null while the window owns it.
/**
 * Every size the export menu offers, grouped by the ratio it is.
 *
 * **This is the list, and the menu is built from it.** Step 6 recorded the failure
 * that makes that worth insisting on: `export-check` swept four sizes that were all
 * 1.6 while the menu offered four that were all 16:9, so a build referencing the
 * width instead of the height was bit-identical on every arm the tool had and drew
 * 11.1% too large on every size the product shipped. Two lists, neither aware of the
 * other. There is now one, and the check reads it off the page.
 *
 * **Ratios are exact, and dimensions are even.** `yuv420p` subsamples chroma by two
 * each way, so an odd dimension is not encodable and `server/export.js` refuses it
 * rather than letting ffmpeg fail after the first frame is already written. 65:24
 * only lands on both at once when the height is a multiple of 48, which is why its
 * widths are 2730 and 3900 rather than anything rounder - a menu entry labelled
 * 65:24 that is really 2.7062 would be a number this repo would find later and have
 * to correct.
 *
 * Both 4K flavours are here because they are different shapes: UHD is 3840x2160 and
 * 16:9, DCI is 4096x2160 and 1.896:1, and picking one would silently decide an
 * aspect for anybody who asked for "4K".
 */
const EXPORT_SIZES = [
  { ratio: '16:9', sizes: [[960, 540], [1280, 720], [1920, 1080], [3840, 2160]] },
  { ratio: '1.90:1 DCI', sizes: [[2048, 1080], [4096, 2160]] },
  { ratio: '4:3', sizes: [[1440, 1080], [2880, 2160]] },
  { ratio: '1:1', sizes: [[1080, 1080], [2160, 2160]] },
  { ratio: '65:24', sizes: [[2730, 1008], [3900, 1440]] },
];
const DEFAULT_EXPORT_SIZE = '1920x1080';

// An export's output resolution is a setting rather than a property of whatever
// window it was started from, and the look is resolution-relative precisely so
// that can be true - but the buffer still has to actually become that size, and
// there is one function that sizes it. So the override lands here rather than
// beside the export, and `renderScale` loses to it: it multiplies the pixel
// ratio, so a preview left at 85% would otherwise deliver an 85% file under a
// 1080p name.
let outputSize = null;

/**
 * The aspect the editor frames at, which is the aspect the export will be.
 *
 * Before this the viewport took its aspect from the window, so what you framed was
 * only what you got if your window happened to match - mild while every size in the
 * menu was 16:9, and severe the moment one of them is 1:1 or 65:24. The stage is
 * letterboxed to this instead, so the picture on screen is the picture in the file.
 *
 * **Vertical field is what stays fixed as this changes**, which is three.js's own
 * behaviour for a perspective camera and is also the only choice consistent with the
 * rest of the renderer: `pointSize` is pixels at 1080p and scales by
 * `bufferHeight / 1080`, and every grade term is referred to the same height. Hold
 * the vertical field and a point's apparent size against the world is invariant
 * across every aspect and every output size, so a look holds. Hold the horizontal
 * field instead and changing aspect moves the vertical field underneath a point size
 * still scaling off height, so the density of points per screen height drifts and
 * the grade quietly stops being the grade anybody tuned.
 *
 * So a wider ratio shows more to the sides and a squarer one shows less, and neither
 * changes how big anything is.
 */
let targetSize = { w: 1920, h: 1080 };
const targetAspect = () => targetSize.w / targetSize.h;

// Where the letterboxed stage sits in the window. Set by `resize`, read by the
// overlay so both canvases cover the same pixels.
const stageBox = { left: 0, top: 0 };

/** The menu, filled from `EXPORT_SIZES` and grouped by ratio. One list. */
function buildExportMenu(select) {
  if (!select) return select;
  for (const group of EXPORT_SIZES) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.ratio;
    for (const [w, h] of group.sizes) {
      const option = document.createElement('option');
      option.value = `${w}x${h}`;
      option.textContent = `${w}x${h}`;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }
  select.value = DEFAULT_EXPORT_SIZE;
  return select;
}

/**
 * Adopt an output size: the editor reframes to it and the project remembers it.
 *
 * The size is document state rather than a control's position, because a
 * composition and the shape it was composed for are one thing. A 65:24 shot reopened
 * at 1920x1080 would be a different shot with the same keys, which is the class of
 * silent reinterpretation the point-size rebase already taught this repo to refuse.
 */
function setTargetSize(text, { fromDocument = false } = {}) {
  const [w, h] = String(text).split('x').map(Number);
  if (!(w > 0 && h > 0)) return false;
  targetSize = { w, h };
  if (ui?.exportSize && ui.exportSize.value !== `${w}x${h}`) {
    // A size a document names that the menu does not offer is still the size the
    // clip was framed at, so it is added rather than snapped to a neighbour.
    if (![...ui.exportSize.options].some((o) => o.value === `${w}x${h}`)) {
      const option = document.createElement('option');
      option.value = `${w}x${h}`;
      option.textContent = `${w}x${h} (from the project)`;
      ui.exportSize.appendChild(option);
    }
    ui.exportSize.value = `${w}x${h}`;
  }
  void fromDocument;
  resize();
  return true;
}

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
  // The stage is the window less the timeline strip, and then the largest box of the
  // target aspect that fits inside it. The letterbox is what makes the editor
  // WYSIWYG: the camera's aspect is the canvas's aspect is the file's aspect, so
  // nothing is stretched and nothing is cropped between here and the export.
  //
  // Fitting rather than masking, because the two directions are not symmetric. A
  // target narrower than the window could be shown by masking the sides, but a target
  // wider than the window sees *more* world than the window is showing, and no mask
  // can draw what was never rendered.
  const availW = innerWidth;
  const availH = Math.max(1, innerHeight - timelineEl.offsetHeight);
  const fitH = Math.max(1, Math.min(availH, Math.round(availW / targetAspect())));
  const fitW = Math.max(1, Math.round(fitH * targetAspect()));
  const width = outputSize ? outputSize.w : fitW;
  const height = outputSize ? outputSize.h : fitH;
  // An export's aspect comes from the output it was asked for, not from the window
  // it was started in, or the file would be framed by whoever happened to be
  // watching.
  for (const cam of [freeCamera, programCamera]) {
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
  }
  const ratio = outputSize ? 1 : Math.min(devicePixelRatio, 2) * renderScale;
  renderer.setPixelRatio(ratio);
  // The canvas keeps the CSS box it had while an export runs. The buffer becomes
  // the output's, which is the part that matters, and the page does not reflow
  // around a 1080p canvas in a 640px window and drag the editor's furniture with
  // it.
  renderer.setSize(width, height, !outputSize);
  composer.setPixelRatio(ratio);
  composer.setSize(width, height);
  // Where the letterboxed stage sits, published for the overlay to line up with.
  // Written rather than each canvas working it out, so the two cannot drift apart by
  // a scrollbar - and read by `drawChrome` rather than set on the chrome canvas from
  // here, because that element is created hundreds of lines below and touching it in
  // this function is a temporal-dead-zone throw on the very first `resize()`.
  if (!outputSize) {
    stageBox.left = Math.round((availW - fitW) / 2);
    stageBox.top = Math.round((availH - fitH) / 2);
    renderer.domElement.style.position = 'fixed';
    renderer.domElement.style.left = `${stageBox.left}px`;
    renderer.domElement.style.top = `${stageBox.top}px`;
  }
  const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
  // Bloom is the most expensive pass, so it runs at half resolution - and the
  // resolution it is half of is the 1080p reference rather than the drawing
  // buffer, which is what makes its halo a fixed fraction of the frame.
  //
  // Running it at half the *buffer* makes bloom's cost proportional and its
  // appearance anything but: UnrealBloomPass bakes a fixed tap count into its
  // shaders when it is constructed - [6, 10, 14, 18, 22] across the five mips -
  // while `setSize` scales the mip chain with what it is given. More texels per
  // mip and the same number of taps means a halo whose width in frame-fractions
  // is inversely proportional to buffer height, halving every time the buffer
  // doubles. Measured at 1920x1200 against 3840x2400 it was the whole of the
  // remaining residual once every other term was reference-relative: a mean
  // channel difference of 13.1 against 0.6, and a halo covering the frame at the
  // smaller size against 80.3% of it at the larger.
  //
  // The reference the chain is frozen at is the 600-tall buffer the look was graded
  // against, and it is the same reference `pointSize` was rebased to. Freezing it at
  // 1080 instead was tried and is wrong for a reason worth writing down: the halo's
  // width is a tap count over a texel count, so a chain with 1.8x the texels has a
  // halo 1.8x tighter - constant at last, but constant at a glow Blackwall was never
  // tuned for. Measured across the two builds, the whole look at 1080p against the
  // graded look at 600: 7.16/255 on the worst of forty tile means at a 1080-frozen
  // chain, 1.10 at this one.
  //
  // What holds it constant is measured to 1200 and shipped to 2160, and the gap is
  // worth naming rather than assuming. The bright pass reads the full-resolution
  // frame into this frozen chain with one bilinear tap per destination texel, so
  // it point-samples a 2:1 region of the frame at a 600 buffer, 4:1 at 1200 and
  // 7.2:1 at 2160 - the undersampling grows with output size while the chain does
  // not. `export-check` compares 600 against 1200, where it measures 0.781/255 on
  // the coarse grid; nothing here has been measured at 4K, so a 4K export inherits
  // the claim by extrapolation. The way to close it is an arm at 3840x2160 against
  // 1920x1080, not an argument.
  //
  // The cost moves with it, in both directions. A 4K export now pays 600-referred
  // bloom, which is the cheaper half of the trade and the right direction for a
  // render that is CPU-bound anyway. A capture node previewing at 800x480 pays it
  // too, which is the expensive half, and the two chains rather than the ratio
  // between them: the old code called setSize(400, 240) there and got a 200x120
  // first mip, this one calls setSize(500, 300) and gets 250x150. That is 37,500
  // texels against 24,000, so 1.56x on the machine with the least to spare.
  const refWidth = (buf.x / buf.y) * 600;
  bloom.setSize(Math.max(1, refWidth / 2), 300);
  grade.uniforms.resolution.value.set(buf.x, buf.y);
  uniforms.bufferHeight.value = buf.y;
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
  // Pixels at 1080p, not pixels. The unit changed exactly once, when the screen-
  // space terms went resolution-relative, and every value here changed with it:
  // this default and both presets are their old values times 1080/600, the 600
  // being the drawing buffer the look was graded against. The step went with them
  // - 0.5 was a fifth of a pixel of the old grid and 8.1 is not on it, and a
  // preset that snapped to 8.0 would leave the rebase 1.2% out for no reason
  // anyone could later find.
  pointSize: { def: 9, min: 0.5, max: 64, step: 0.1, kind: 'scalar', tag: 'look',
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

  // The one composition parameter, and the only pose. The camera track reads its
  // kind off this entry rather than off a second table beside the path editor, and
  // the render path writes the evaluated pose through the same door every other
  // value goes through. Composition is edited in the world rather than on a
  // slider, which is why it is the one parameter with no panel control - the
  // buttons that key it are not named after it, so the check below still holds.
  camera: { def: DEFAULT_POSE, kind: 'pose', tag: 'composition',
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
    // Closed in step 7, because step 7 is where a hand-edited or truncated project
    // file arrives. Four finite numbers is not a rotation: a quaternion that is not
    // of unit length reaches the camera, where three renormalises on some paths and
    // not others, and where slerping between one unit and one non-unit quaternion
    // is not the rotation either of them names - so a camera move authored between
    // two such keys renders a path nobody drew, and nothing in the console says so.
    //
    // Refused rather than renormalised, which is the same call every other branch
    // here makes. A quaternion 12% long is not a rotation with a scale attached, it
    // is a number nobody meant, and quietly normalising it would produce *an*
    // orientation and hide the fact that the file is damaged.
    //
    // The tolerance is four orders of magnitude looser than the error a real
    // quaternion carries. Three's own output is unit to about 1e-7 and a project
    // round-trips it through full-precision JSON, so 1e-3 has never been near a
    // live value - while the shapes this is for, a truncated component or a hand
    // -typed axis, miss by tenths.
    const len = Math.hypot(...value.quaternion);
    if (Math.abs(len - 1) > 1e-3) {
      throw new Error(
        `${name} has a quaternion of length ${len.toFixed(6)}: a rotation is unit length, `
        + `and interpolating through [${value.quaternion.join(', ')}] would render a `
        + 'camera move nobody authored',
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

/**
 * The registry's door, and every way in goes through it.
 *
 * **`PARAMS[name]` is not a membership test.** `PARAMS` is an object literal, so it
 * inherits from `Object.prototype` - and `constructor`, `toString`, `valueOf` and
 * `__proto__` all answer something truthy there. Gating on truthiness let every one
 * of those names through where `wibble` was refused, so a project file naming
 * `__proto__` as a track put `__proto__` in `tracks`, `normalise` read `min`, `max`
 * and `step` off a function and made NaN out of undefined, and the page threw
 * somewhere mid-render. That is a failure *inside* the evaluator instead of a
 * decision at the door, which is the entire class of thing the door exists for.
 *
 * `Object.hasOwn` asks the question that was meant: is this one of the parameters
 * this build declares. One helper rather than four spellings of the check, because
 * four spellings is how three of them came to be `PARAMS[name]` and one `name in
 * PARAMS` - which is the same hole written two ways.
 */
function specOf(name) {
  if (!Object.hasOwn(PARAMS, name)) throw new Error(`unknown parameter ${JSON.stringify(name)}`);
  return PARAMS[name];
}

const params = {
  spec(name) {
    const spec = specOf(name);
    return { default: spec.def, min: spec.min, max: spec.max, step: spec.step, kind: spec.kind, tag: spec.tag };
  },
  names(tag) {
    return Object.keys(PARAMS).filter((n) => !tag || PARAMS[n].tag === tag);
  },
  get(name) {
    const spec = specOf(name);
    const v = values.get(name);
    return spec.kind === 'pose' ? { ...v, position: [...v.position], quaternion: [...v.quaternion] } : v;
  },
  /**
   * What `set` would store, without storing it. A key holds a parameter's value,
   * so it has to be the value the parameter would take - a key dragged in a lane
   * and the same value typed into the slider landing a hair apart would be two
   * positions the slider cannot express, differing for a reason nothing records.
   */
  normalise(name, value) {
    return normalise(name, specOf(name), value);
  },
  /** The single write path. Everything - UI, presets, step 5's tracks - goes here. */
  set(name, value) {
    const spec = specOf(name);
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
  /**
   * A bulk write. Guarded, because the note on `evaluating` called this the door
   * the flag did not cover: a preset assembled by hand rather than passed through
   * `applyPreset` used to get no complaint at all. The evaluator writes key by key
   * through `set` and never comes here, so closing this costs it nothing.
   */
  apply(next) {
    refuseDuringEvaluation('a bulk write');
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
    // A checkbox has no drag, so its `change` is both the write and the end of the
    // interaction.
    el.addEventListener('change', () => { writeFromControl(name, el.checked); history.commit(); });
  } else {
    el.min = String(spec.min);
    el.max = String(spec.max);
    el.step = String(spec.step);
    // The string-to-number conversion belongs to the control rather than to the
    // registry: a slider's value is text because the DOM says so, and letting that
    // reach `normalise` would mean loosening it for every other caller too.
    el.addEventListener('input', () => writeFromControl(name, Number(el.value)));
    // The other half of the `input`/`change` split, and the whole of what makes
    // undo coalesce: one snapshot when the drag ends rather than one per pointer
    // move. Nothing is pushed if the drag put the value back where it started.
    el.addEventListener('change', () => history.commit());
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
//
// Both point sizes are the ones these presets always had, times 1080/600. That is
// the whole of the re-tune and it happens exactly once: `pointSize` is pixels at
// 1080p now, the buffer these looks were graded against was 600 tall, and 4.5 and
// 5 pixels there are 8.1 and 9 pixels at the reference. Nothing else in either
// preset moves, because nothing else in either preset was in pixels - the grade's
// frequencies are not parameters, and they simply become 1080p-referred with the
// rest of the look.
const BLACKWALL = { bloom: 0.5, trails: 0.5, rgbSplit: 1.6, scanlines: 0.35, grain: 0.22, glitch: 0.18, pointSize: 8.1, scan: 0.35, rim: 0.5, fade: 120, wake: 550, additive: true };
const NEUTRAL = { bloom: 0, trails: 0, rgbSplit: 0, scanlines: 0, grain: 0, glitch: 0, pointSize: 9, scan: 0, rim: 0.55, fade: 120, wake: 0, additive: false };

// The mode is a property of the clip rather than a track of any kind. Selecting it
// rewrites twelve other look values, so a mode keyframe would silently stomp every
// other track at the instant it fired - one mode per clip removes that problem
// instead of leaving it to be managed. Multi-mode clips are not ruled out, only
// deferred, and the stomping is what would have to be solved properly first.
let clipMode = 0;

// The mode itself, without the look that comes with choosing it. Undo restores a
// whole snapshot including the twelve values Blackwall wrote, so replaying the
// preset on top of them would overwrite what was just restored with what the
// preset happens to say today. This is the half both callers share rather than a
// second path: `setMode` is this plus the preset a user asked for.
function applyModeValue(mode) {
  clipMode = mode;
  uniforms.mode.value = mode;
  if (mode === 4) scene.fog.color.setHex(0x05070a);
  document.querySelectorAll('#modes button').forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.mode) === mode));
  });
}

function setMode(mode) {
  refuseDuringEvaluation('mode selected');
  const wasBlackwall = clipMode === 4;
  applyModeValue(mode);

  if (mode === 4) applyPreset(BLACKWALL);
  else if (wasBlackwall) applyPreset(NEUTRAL);

  // Asked for explicitly, because the mode is clip state and deliberately not a
  // registry parameter - so selecting Depth or Contour writes nothing the
  // registry announces, and the image would sit on the previous reading of the
  // footage until something else happened to move.
  requestRepaint();
}

document.querySelectorAll('#modes button').forEach((btn) => {
  btn.addEventListener('click', () => {
    setMode(Number(btn.dataset.mode));
    // One click is one interaction, so the snapshot goes on at the end of it. The
    // twelve look values Blackwall wrote are inside the same snapshot, which is
    // the whole reason undo cannot be a command stack here.
    history.commit();
  });
});

// ------------------------------------------------------------ keyframe tracks

// A track is keys on a registry parameter, stamped in program time. The kind is
// read off the registry entry rather than declared again here, because two tables
// that can disagree is exactly what the registry was built to remove - `wake`
// being a scalar in one of them and a step in the other is a bug nothing would
// catch until an export.
//
// Three kinds, and each is a different answer to "what is between two keys":
//
//   scalar  a cubic ease from one value to the next. The two handles are the same
//           unit square CSS `cubic-bezier` uses, so the pair (1/3,1/3),(2/3,2/3)
//           is exactly linear and every other pair bends the *timing* without
//           moving either value.
//   step    the earlier value, held. A checkbox has nothing between true and
//           false, and half a segment spent at 0.5 would be refused by
//           `normalise` anyway - loudly, in the middle of a render.
//   pose    position, orientation and field of view moving together. Position
//           runs a Catmull-Rom through the keys, because a camera cornering on
//           straight lines reads as a mistake rather than as a move; orientation
//           slerps, and fov lerps.

// The handles of a linear segment. Named rather than written out at the four
// places a key is made, because a key created with anything else silently eases.
const EASE_OUT_LINEAR = [1 / 3, 1 / 3];
const EASE_IN_LINEAR = [2 / 3, 2 / 3];

// One coordinate of a unit cubic Bezier with its ends pinned at 0 and 1, which is
// what lets a handle be two numbers instead of a control point.
const bez = (a, b, u) => {
  const v = 1 - u;
  return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u;
};
const bezSlope = (a, b, u) => {
  const v = 1 - u;
  return 3 * v * v * a + 6 * v * u * (b - a) + 3 * u * u * (1 - b);
};

/**
 * The Bezier parameter at which the curve's x reaches `x`. Newton first because it
 * converges in two or three steps over most of the range, then bisection, because
 * Newton stalls exactly where an ease handle is interesting: a hold at the start
 * of a segment is a near-zero derivative, and dividing by it walks off the curve.
 */
function easeParam(ax, bx, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let u = x;
  for (let i = 0; i < 8; i++) {
    const err = bez(ax, bx, u) - x;
    if (Math.abs(err) < 1e-9) return u;
    const d = bezSlope(ax, bx, u);
    if (d < 1e-6) break;
    const next = u - err / d;
    if (!(next > 0 && next < 1)) break;
    u = next;
  }
  let lo = 0;
  let hi = 1;
  u = x;
  for (let i = 0; i < 60; i++) {
    const err = bez(ax, bx, u) - x;
    if (Math.abs(err) < 1e-12) break;
    if (err > 0) hi = u; else lo = u;
    u = (lo + hi) / 2;
  }
  return u;
}

/** Where in a segment's value range a fraction of the way through it lands. */
function easeAt(a, b, x) {
  const u = easeParam(a[0], b[0], x);
  return bez(a[1], b[1], u);
}

/** d(value fraction)/d(time fraction), which is what a retime slope is built from. */
function easeSlopeAt(a, b, x) {
  const u = easeParam(a[0], b[0], x);
  const dx = bezSlope(a[0], b[0], u);
  if (dx > 1e-6) return bezSlope(a[1], b[1], u) / dx;
  // A vertical tangent is a legitimate handle placement, and the analytic ratio is
  // infinite there. It used to report zero, which is the opposite of the truth and
  // the wrong kind of wrong: this is the slope step 6's audio gate reads to decide
  // whether the take is playing at 1.0, and a zero at the steepest point of a ramp
  // would unmute exactly where it has to mute. Measured over a small window
  // instead - large, finite, and in the right direction, which is what every
  // caller can actually use.
  const h = 1e-4;
  const lo = Math.max(0, x - h);
  const hi = Math.min(1, x + h);
  return (easeAt(a, b, hi) - easeAt(a, b, lo)) / Math.max(1e-9, hi - lo);
}

/** The last key at or before `t`, or -1 when `t` sits before every key. */
function keyBefore(keys, t) {
  let lo = 0;
  let hi = keys.length - 1;
  if (hi < 0 || t < keys[0].t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keys[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Outside the keys a look track holds its end values and the retime curve keeps
// going. That difference is not a preference: a look with one bloom key is a
// constant bloom, while a retime that flattened past its last key would freeze
// the program there and make the take's tail unreachable.
const HOLD_ENDS = 'hold';
const EXTEND_ENDS = 'extend';

function scalarAt(keys, t, ends) {
  const n = keys.length;
  if (n === 0) return 0;
  if (n === 1) return keys[0].value;
  const i = keyBefore(keys, t);
  if (i < 0) {
    if (ends === HOLD_ENDS) return keys[0].value;
    return keys[0].value + (t - keys[0].t) * segmentSlope(keys, 0, 0);
  }
  if (i >= n - 1) {
    if (ends === HOLD_ENDS) return keys[n - 1].value;
    return keys[n - 1].value + (t - keys[n - 1].t) * segmentSlope(keys, n - 2, 1);
  }
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  // Coincident keys are a legal transient while one is being dragged onto
  // another, and the later value is what a step would give, so it is what this
  // gives rather than a division by zero.
  if (span <= 0) return b.value;
  return a.value + (b.value - a.value) * easeAt(a.easeOut, b.easeIn, (t - a.t) / span);
}

/** The slope of segment `i` at one of its ends, in value per program second. */
function segmentSlope(keys, i, x) {
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  if (span <= 0) return 0;
  return ((b.value - a.value) / span) * easeSlopeAt(a.easeOut, b.easeIn, x);
}

function scalarSlopeAt(keys, t) {
  const n = keys.length;
  if (n < 2) return 0;
  const i = keyBefore(keys, t);
  if (i < 0) return segmentSlope(keys, 0, 0);
  if (i >= n - 1) return segmentSlope(keys, n - 2, 1);
  const span = keys[i + 1].t - keys[i].t;
  if (span <= 0) return 0;
  return segmentSlope(keys, i, (t - keys[i].t) / span);
}

function stepAt(keys, t) {
  const i = keyBefore(keys, t);
  return keys[i < 0 ? 0 : i].value;
}

// Catmull-Rom, written in its Hermite form with tangents divided by the *time*
// between the neighbouring keys rather than by an assumed even spacing. The
// textbook uniform formula is the same curve when keys are evenly spaced and a
// different one when they are not: it reads the parameter as an index, so two
// keys 0.2s apart and two keys 3s apart get the same tangent and the camera
// lurches out of the tight pair. Keys land wherever the edit wants them, so the
// non-uniform form is the only one that means what the spec says it means.
function hermite(p0, p1, m0, m1, span, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  return h00 * p0 + h10 * span * m0 + h01 * p1 + h11 * span * m1;
}

/**
 * The tangent at key `i`, in metres per program second.
 *
 * At the ends the missing neighbour is the end key mirrored one segment *outside*
 * the path rather than the end key sitting on top of itself. That is what makes
 * this the non-uniform generalisation of the textbook formula rather than a
 * near-miss of it: with the duplicate at the same instant the end tangent comes
 * out twice what the uniform Catmull-Rom gives, so the curve would leave its first
 * key at double speed and the two forms would disagree on evenly spaced keys - the
 * one case where they have to agree exactly.
 */
function tangentAt(keys, i, axis) {
  const n = keys.length;
  const at = (k) => (k < 0
    ? { t: 2 * keys[0].t - keys[1].t, value: keys[0].value }
    : (k > n - 1
      ? { t: 2 * keys[n - 1].t - keys[n - 2].t, value: keys[n - 1].value }
      : keys[k]));
  const lo = at(i - 1);
  const hi = at(i + 1);
  const span = hi.t - lo.t;
  if (span <= 0) return 0;
  return (hi.value.position[axis] - lo.value.position[axis]) / span;
}

const slerpA = new THREE.Quaternion();
const slerpB = new THREE.Quaternion();

function poseAt(keys, t) {
  const n = keys.length;
  if (n === 1) return keys[0].value;
  const i = keyBefore(keys, t);
  if (i < 0) return keys[0].value;
  if (i >= n - 1) return keys[n - 1].value;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  if (span <= 0) return b.value;
  const u = (t - a.t) / span;

  const position = [0, 1, 2].map((axis) => hermite(
    a.value.position[axis], b.value.position[axis],
    tangentAt(keys, i, axis), tangentAt(keys, i + 1, axis),
    span, u,
  ));

  // Slerp rather than a Catmull-Rom through the quaternions. The spec asks for the
  // spline on position, and it asks for it there because that is where a straight
  // line is visible as a corner; an orientation between two keys has no such
  // corner to round off, and a spline through four quaternions can leave the unit
  // sphere in ways that read as a roll nobody keyed.
  slerpA.fromArray(a.value.quaternion);
  slerpB.fromArray(b.value.quaternion);
  slerpA.slerp(slerpB, u);

  return {
    position,
    quaternion: slerpA.toArray(),
    fov: a.value.fov + (b.value.fov - a.value.fov) * u,
  };
}

class Track {
  constructor(name) {
    this.name = name;
    // Off the registry, never declared here. See the note above.
    this.kind = params.spec(name).kind;
    this.keys = [];
  }

  get length() { return this.keys.length; }

  /** The key at `t`, within half an output frame, or null. */
  keyAt(t, tol) {
    for (const key of this.keys) if (Math.abs(key.t - t) <= tol) return key;
    return null;
  }

  /** Writes a key at `t`, replacing one already there. Returns it. */
  setKey(t, value, tol) {
    const existing = this.keyAt(t, tol);
    if (existing) {
      existing.value = value;
      return existing;
    }
    const key = { t, value, easeOut: [...EASE_OUT_LINEAR], easeIn: [...EASE_IN_LINEAR] };
    this.keys.push(key);
    this.sort();
    return key;
  }

  removeKey(key) {
    const i = this.keys.indexOf(key);
    if (i >= 0) this.keys.splice(i, 1);
  }

  sort() { this.keys.sort((x, y) => x.t - y.t); }

  valueAt(t) {
    if (this.kind === 'step') return stepAt(this.keys, t);
    if (this.kind === 'pose') return poseAt(this.keys, t);
    return scalarAt(this.keys, t, HOLD_ENDS);
  }

  serialise() {
    return this.keys.map((k) => ({
      t: k.t, value: k.value, easeOut: [...k.easeOut], easeIn: [...k.easeIn],
    }));
  }
}

// Only tracks that carry keys exist. An empty track is a parameter with a single
// value, which the registry already holds, and keeping one per parameter would
// mean the lane list and the track list had to be filtered into agreement
// everywhere instead of being the same list.
const tracks = new Map();

function trackFor(name) {
  let track = tracks.get(name);
  if (!track) {
    track = new Track(name);
    tracks.set(name, track);
  }
  return track;
}

function dropTrackIfEmpty(name) {
  const track = tracks.get(name);
  if (track && track.keys.length === 0) tracks.delete(name);
}

// Every track written through the one door, at one program position. This is the
// evaluator the note on `evaluating` asked for: it runs inside
// `renderProgramFrame`, so the flag now spans exactly what its name claims, and a
// preset or a mode selected from a track's own apply would be refused rather than
// merely unlikely.
//
// The suppression is not optional and is the reason this is one function rather
// than a loop at the call site. `params.set` announces every write, the timeline
// answers an announcement by scheduling an accurate seek, and an evaluator
// writing eight track values per frame without this would schedule eight seeks
// per frame - each of which renders a pre-roll, which evaluates, which schedules
// more. It never settles, and the symptom is a tab that gets slower rather than
// an error.
// The parameters a draft has borrowed, or null. The evaluator has to see this or
// the borrow does not hold: `draftNow` zeroes fade, wake and trails and then calls
// the render, and the evaluator inside it wrote any of the three that carried keys
// straight back. A scrub over a clip with a keyed wake then drafted with the wake
// live on freshly cleared accumulators - every point newborn, the whole cloud in
// its ramp-in - which is neither the accumulator-free frame a draft is defined as
// nor an image that existed at that position. It also broke the property two
// drafts of one position are compared on.
let borrowed = null;

function evaluateTracks(t) {
  if (tracks.size === 0) return;
  withoutRepaint(() => {
    for (const track of tracks.values()) {
      if (track.keys.length === 0) continue;
      if (borrowed && borrowed.has(track.name)) continue;
      params.set(track.name, track.valueAt(t));
    }
  });
}

/**
 * What a parameter is worth at a program position rather than right now: its
 * track's value if it carries keys, the registry's if it does not, snapped either
 * way so it is the value a render at that position would actually apply.
 *
 * This exists because "what is the look here" and "what is the look on screen" are
 * different questions the moment anything is keyed, and a seek has to ask the
 * first one about a position it has not rendered yet.
 */
function valueAtProgram(name, t) {
  const track = tracks.get(name);
  if (!track || track.keys.length === 0) return params.get(name);
  return params.normalise(name, track.valueAt(t));
}

// Where a key lands, and how near an existing one has to be to count as the same
// key. Half an output frame, because the playhead is an integer output frame and
// two keys inside one of them cannot be told apart by anything downstream.
const playheadSec = () => (timeline ? timeline.programSec : 0);
const keyTolerance = () => 0.5 / (timeline ? timeline.outputFps : 30);

/**
 * A parameter written from its panel control. With keys on the track this writes
 * the key at the playhead rather than the parameter alone - Final Cut's rule, and
 * here it is not a convention but the only thing that works: the evaluator rewrites
 * every keyed parameter on the very next render, so a bare `params.set` would be
 * overwritten before the slider stopped moving and the control would appear to
 * spring back on its own.
 */
function writeFromControl(name, value) {
  const applied = params.set(name, value);
  const track = tracks.get(name);
  if (track && track.keys.length > 0) {
    // The normalised value rather than the raw one, so the key holds exactly what
    // the parameter holds. A key a hair off its own slider would put an
    // interpolated value between two positions the slider cannot express.
    track.setKey(playheadSec(), applied, keyTolerance());
    lanesChanged();
  }
}

/** Adds a key at the playhead, or removes the one already there. */
function toggleKey(name) {
  const track = trackFor(name);
  const existing = track.keyAt(playheadSec(), keyTolerance());
  if (existing) {
    track.removeKey(existing);
    dropTrackIfEmpty(name);
  } else {
    // The parameter's current value, so planting the first key on a track never
    // changes the image. A key that moved the picture the moment it appeared would
    // make keying a look a destructive act.
    track.setKey(playheadSec(), params.get(name), keyTolerance());
  }
  lanesChanged();
  requestRepaint();
  history.commit();
}

// ------------------------------------------------------------------- the project

// Everything an edit *is*, as one plain object. A project file, an undo snapshot
// and step 6's export job all start here, which is why this is one function rather
// than a serialiser per consumer that would each learn about a new track kind
// separately.
//
// What is in it is document state and nothing else. `params.values()` already
// defaults to look plus composition and leaves `view` out, so render scale and
// auto-orbit are absent by construction rather than by a list kept in step with
// the registry. The playhead, the free camera's orbit and which panel is open are
// absent for the same reason: none of them is what the clip is.
//
// The mode is in it, and that is worth stating because the spec's undo table puts
// "which layer is displayed" in the not-undoable column. That row sits beside
// panel visibility and render scale - both of which the registry tags `view` - and
// it was written before the section that settled the mode as clip state whose
// selection *applies a preset*, which the same table lists as undoable. Leaving it
// out would restore the twelve values Blackwall wrote while leaving Blackwall
// selected: a state that never existed, which is the exact failure a whole-project
// snapshot exists to make impossible.

function serialiseProject() {
  return {
    version: PROJECT_VERSION,
    mode: clipMode,
    // Composition per the preset table - it is never in a preset and it is part of
    // what the clip is - so it is document state and it is undoable.
    outputFps: timeline ? timeline.outputFps : 30,
    // The shape the clip was framed for. A composition and its aspect are one thing:
    // reopening a 65:24 shot at 1920x1080 would be a different shot wearing the same
    // keys, which is the silent reinterpretation the point-size rebase already taught
    // this repo to refuse rather than absorb.
    outputSize: `${targetSize.w}x${targetSize.h}`,
    params: params.values(),
    tracks: Object.fromEntries([...tracks].map(([name, track]) => [name, track.serialise()])),
    retime: retime.serialise(),
    // Provenance, not a reference. The values above are already copied in, so this
    // changes nothing about what renders - it only records which revision of which
    // look this clip was built from, which is what lets a gallery see that three
    // clips are on one revision and two are on an older one.
    appliedPreset,
  };
}

/**
 * A key as it arrives from outside, checked into a key this editor can hold.
 *
 * `t` is checked here and the value is checked by the registry, which is the split
 * that matters: a time is a time whatever the parameter, and only the registry
 * knows that `camera` is a pose and `additive` is a boolean. Handles default to
 * linear when absent - a key written without them is linear, not handleless - and
 * are checked when present, because a handle outside the unit box bends a curve
 * back on itself inside a segment.
 */
function restoreKey(owner, k) {
  if (!Number.isFinite(k?.t)) {
    throw new Error(`${owner} has a key at t=${JSON.stringify(k?.t)}: a key time has to be a finite number`);
  }
  const handle = (side, xs, fallback) => {
    if (xs === undefined) return [...fallback];
    if (!Array.isArray(xs) || xs.length !== 2 || !xs.every(Number.isFinite)) {
      throw new Error(`${owner}'s key at ${k.t}s has a ${side} handle of ${JSON.stringify(xs)}: it takes two finite numbers`);
    }
    return [...xs];
  };
  return {
    t: k.t,
    value: k.value,
    easeOut: handle('easeOut', k.easeOut, EASE_OUT_LINEAR),
    easeIn: handle('easeIn', k.easeIn, EASE_IN_LINEAR),
  };
}

/**
 * The one door a whole document comes through, and since step 7 it is the door a
 * **file from outside this page** comes through - an undo snapshot and a project
 * loaded off disk are the same object and take the same route, because a second
 * route is a second set of checks to keep honest.
 *
 * Everything here refuses rather than repairs. That is not caution for its own
 * sake: the three things this now catches are each a *silent* wrong image rather
 * than a crash, which is the class of failure this repo keeps finding after the
 * fact. A falling retime curve stops playback with the play button still lit. A
 * non-unit quaternion renders a camera move nobody drew. A `pointSize` from before
 * step 6's rebase draws 1.8x wrong at every size.
 */
function restoreProject(project) {
  if (!project || typeof project !== 'object') {
    throw new Error(`a project is an object, got ${JSON.stringify(project)}`);
  }
  // The version gate, first, because everything below it is interpreted *in* the
  // version. A file with no version predates the field, which means it predates
  // the point at which `pointSize` stopped being drawing-buffer pixels - so its
  // look cannot be reconstructed from what it contains, and opening it on a guess
  // would render a size nobody authored and record no reason why.
  if (project.version !== PROJECT_VERSION) {
    throw new Error(
      `this project is version ${JSON.stringify(project.version)} and this build reads `
      + `version ${PROJECT_VERSION}: point size is pixels at 1080p in version ${PROJECT_VERSION} `
      + 'and was pixels at the drawing buffer before it, so there is no faithful reading of '
      + 'an unversioned file',
    );
  }
  if (!Number.isInteger(project.mode) || project.mode < 0 || project.mode > 4) {
    throw new Error(`mode is ${JSON.stringify(project.mode)}: the clip's mode is a whole number from 0 to 4`);
  }
  if (!Number.isFinite(project.outputFps) || project.outputFps <= 0) {
    throw new Error(`outputFps is ${JSON.stringify(project.outputFps)}: it has to be a positive number`);
  }
  // Checked here rather than shrugged off, because a size that does not parse would
  // otherwise leave the editor framing at whatever the last clip was and quietly
  // export a different shape from the one on screen. Absent is allowed and means the
  // 1920x1080 this field was introduced beside - the version gate above is what makes
  // that reading safe, since nothing older than it can reach here.
  if (project.outputSize !== undefined && !/^[1-9][0-9]*x[1-9][0-9]*$/.test(String(project.outputSize))) {
    throw new Error(`outputSize is ${JSON.stringify(project.outputSize)}: it reads as WIDTHxHEIGHT`);
  }
  setTargetSize(project.outputSize ?? DEFAULT_EXPORT_SIZE, { fromDocument: true });
  if (!project.params || typeof project.params !== 'object') {
    throw new Error('a project carries a params object');
  }
  if (!project.tracks || typeof project.tracks !== 'object') {
    throw new Error('a project carries a tracks object, empty if nothing is keyed');
  }
  if (!project.retime || !Array.isArray(project.retime.keys) || !Number.isFinite(project.retime.rate)) {
    throw new Error('a project carries a retime with a numeric rate and an array of keys');
  }

  // Built whole before anything is written, so a project that fails halfway leaves
  // the editor on the clip it already had rather than on a half-applied one. The
  // registry's own refusals do the value checking, key by key: `params.normalise`
  // is what rejects a scalar that is a string, a step that is not a boolean and -
  // since this step - a quaternion that is not of unit length. Routing keys through
  // it is the whole of why a hand-edited camera track cannot reach `poseAt`.
  const restoredTracks = [];
  for (const [name, keys] of Object.entries(project.tracks)) {
    if (!Array.isArray(keys)) throw new Error(`track ${name} is not an array of keys`);
    if (keys.length === 0) continue;
    // Names the registry does not know are refused rather than dropped. A track
    // silently discarded is an edit silently lost, and the file is more likely to
    // be from a build this one cannot read than to be harmlessly extra.
    params.spec(name);
    restoredTracks.push([name, keys.map((k) => {
      const key = restoreKey(`track ${name}`, k);
      key.value = params.normalise(name, key.value);
      return key;
    })]);
  }

  const restoredRetime = project.retime.keys.map((k) => {
    const key = restoreKey('the retime curve', k);
    if (!Number.isFinite(key.value)) {
      throw new Error(`the retime key at ${key.t}s maps to ${JSON.stringify(key.value)}: source time is a number`);
    }
    return key;
  });
  // The fourth door onto the curve, and the one this step exists to close. The
  // other three are gestures inside a page that already vetted the curve; this is
  // the one a file arrives through, and a descending region does not merely fail -
  // it kills the animation loop, or worse, passes the residency guard vacuously
  // because the bounds it compares have crossed, and playback simply stops
  // advancing with the play button still lit.
  retime.assertMonotonic(restoredRetime);

  // Null or a name and a revision, and checked because it is displayed: a stamp
  // carrying an object where a string belongs would put "[object Object]" on a
  // chip that is supposed to be the audit trail for a set of clips.
  const stamp = project.appliedPreset ?? null;
  if (stamp !== null && (typeof stamp.name !== 'string' || typeof stamp.rev !== 'string')) {
    throw new Error(`appliedPreset is ${JSON.stringify(stamp)}: it is null, or a name and a rev`);
  }

  applyModeValue(project.mode);
  params.apply(project.params);
  appliedPreset = stamp;

  tracks.clear();
  for (const [name, keys] of restoredTracks) trackFor(name).keys = keys;

  retime.rate = project.retime.rate;
  retime.keys = restoredRetime;

  if (timeline && timeline.outputFps !== project.outputFps) {
    // The playhead is not part of the document, so an undo that changed the output
    // rate has to keep it where it is - and the playhead is an integer output
    // frame, so leaving the frame number alone would move it in seconds. Held in
    // program seconds across the change, which is the coordinate that means
    // anything here, and rounded back onto the new grid.
    const held = timeline.programSec;
    timeline.outputFps = project.outputFps;
    timeline.frame = timeline.frameAt(held);
  }
  timingChanged();
}

// Whole snapshots rather than a command stack, and the argument is that this one
// cannot be got wrong. A command stack needs every mutation path to implement both
// directions correctly, and the classic way an editor corrupts someone's work is
// an undo that is not quite the inverse of its redo. A snapshot has no such
// failure mode: whatever the mutation was, the state before it is already held.
// The memory argument that normally favours commands does not apply - a project is
// tens of kilobytes of JSON, so a hundred levels is a few megabytes.
//
// Pushed at the end of an interaction rather than per input event. The controls
// already draw that line for us: `input` fires continuously through a drag and
// `change` fires once on release, so a slider drag is one snapshot and not two
// hundred.
const UNDO_LIMIT = 100;

const history = {
  stack: [],
  // What the document looked like at the end of the last interaction. Comparing
  // against it is what makes a commit that changed nothing cost nothing - which
  // is how orbiting, scrubbing and dropping render scale leave the stack alone
  // without any of them having to know that the stack exists.
  baseline: null,
  restoring: false,

  get depth() { return this.stack.length; },

  snapshot() { return JSON.stringify(serialiseProject()); },

  /** Starts the stack from whatever the clip already is. */
  begin() {
    this.stack.length = 0;
    this.baseline = this.snapshot();
    paintUndoCount();
  },

  commit() {
    if (this.restoring) return false;
    const now = this.snapshot();
    if (now === this.baseline) return false;
    this.stack.push(this.baseline);
    if (this.stack.length > UNDO_LIMIT) this.stack.shift();
    this.baseline = now;
    // Said here rather than left to the next repaint. A commit is the end of an
    // interaction and usually the last thing that happens in it - a node drag
    // repaints on every pointer move and then commits on release - so a readout
    // that waited for a repaint would sit one level behind for as long as nothing
    // else moved.
    paintUndoCount();
    return true;
  },

  undo() {
    const previous = this.stack.pop();
    if (previous === undefined) return false;
    // Playback walks the accumulators forward one output frame at a time and they
    // cannot be walked back, so a retime curve restored underneath a running
    // playhead asks the source to go backwards on the very next step - which it
    // refuses, from inside the animation loop. Paused across the restore and
    // re-seeked afterwards, which is the same thing the speed slider does and for
    // the same reason. Playing again afterwards is deliberate: undo is about what
    // the clip is, and stopping the transport is not part of what it undoes.
    const resume = timeline ? timeline.playing : false;
    if (resume) timeline.pause();
    this.restoring = true;
    try {
      restoreProject(JSON.parse(previous));
      this.baseline = previous;
    } finally {
      this.restoring = false;
    }
    // The playhead deliberately does not move. Undo is about what the clip is, and
    // walking the playhead backwards on every press is the behaviour that teaches
    // people not to trust it.
    paintUndoCount();
    if (resume) {
      timeline.seek(timeline.programSec)
        .then(() => timeline.play())
        .catch(showTimelineError);
    } else {
      requestRepaint();
    }
    return true;
  },
};

addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'H') {
    const p = document.getElementById('panel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    history.undo();
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

// ------------------------------------------------- what this monitor pulls
//
// A depth divisor and a frame stride, asked for over the socket that is already
// carrying the frames. Decimation is a network concession and never a compute one:
// the capture node sustains full rate, and this exists because a radio link cannot
// carry 14.6 MB/s while the same machine is also writing it to disk.
//
// **Nothing here ever moves on its own.** The controls are the operator's, the
// granted setting is always on screen, and a link that cannot sustain what was asked
// says so rather than quietly coarsening - an instrument that changes its own scale
// is worse than none, because coarse depth reads as a badly placed subject and a
// dropped stride reads as a sensor losing frames, and both get blamed on the room.
const monDivisorEl = document.getElementById('monDivisor');
const monStrideEl = document.getElementById('monStride');
const monAcceptCostEl = document.getElementById('monAcceptCost');
const monNoteEl = document.getElementById('monNote');

// The last setting the server confirmed, which is what the record button consults.
// Held rather than read back off the sliders, because a slider carries what somebody
// dragged it to and this has to carry what was granted.
let monitorState = { divisor: 1, stride: 1, loopback: true, granted: true, wouldRefuseRecording: false };

function sendMonitor() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const body = { divisor: Number(monDivisorEl.value), stride: Number(monStrideEl.value) };
  if (monAcceptCostEl?.checked) body.acceptMonitorCost = true;
  socket.send(JSON.stringify({ monitor: body }));
}

function showMonitor(state) {
  monitorState = state;
  monDivisorEl.value = String(state.divisor);
  monStrideEl.value = String(state.stride);
  monDivisorEl.nextElementSibling.value = String(state.divisor);
  monStrideEl.nextElementSibling.value = String(state.stride);
  if (monAcceptCostEl) {
    monAcceptCostEl.parentElement.style.display = state.loopback ? 'none' : '';
  }

  // The stride reads as a position, so it needs a real ordinal rather than a "th"
  // glued on - the slider runs to 30 and three of the values in that range would
  // otherwise read "2th", "3th", "21th". The teens are the exception the naive rule
  // gets wrong in the other direction.
  const ordinal = (n) => {
    const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th'
      : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
    return `${n}${suffix}`;
  };

  // A frame is 486KB at full rate; the depth block scales with the divisor squared
  // and the colour block does not move at all, which is why the saving flattens.
  // Stated from the grid rather than from a table, so the number cannot drift from
  // what the sender is actually building.
  const depthKB = Math.ceil(512 / state.divisor) * Math.ceil(424 / state.divisor) * 2 / 1000;
  const perFrame = depthKB + 52;
  const rate = perFrame * (30 / state.stride) / 1000;
  const parts = [];
  if (!state.granted) parts.push('ungranted');
  parts.push(`depth ÷${state.divisor}, every ${state.stride === 1 ? 'frame' : `${ordinal(state.stride)} frame`}`);
  parts.push(`about ${perFrame.toFixed(0)}KB a frame, ${rate.toFixed(1)} MB/s`);
  if (state.refused) parts.push(`refused: ${state.refused}`);
  if (state.wouldRefuseRecording) {
    parts.push(`a take will refuse to start at this setting - finer than the ÷${state.cap.divisor} `
      + `×${state.cap.stride} a recording allows, and the frames it costs never reach the file`);
  } else if (state.granted && !state.loopback) {
    parts.push('coarse enough to record through');
  }
  parts.push('the recording is always full fidelity whatever this says');
  monNoteEl.textContent = `${parts.join(' · ')}.`;
  monNoteEl.classList.toggle('warn', Boolean(!state.granted || state.wouldRefuseRecording || state.refused));
}

for (const el of [monDivisorEl, monStrideEl]) el.addEventListener('input', sendMonitor);

function connect() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.binaryType = 'arraybuffer';
  socket = ws;

  ws.onopen = () => { sensorLabel = 'waiting for sensor…'; setStatus(); };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);

      if (msg.status) {
        sensorState = {
          live: '', starting: 'sensor starting…', lost: 'sensor lost — restarting',
          // Not a fault to wait out, so it does not say "restarting": this is the
          // editing station, and the footage is on the node.
          absent: 'no sensor on this machine',
        }[msg.status] ?? msg.status;
        if (msg.status !== 'live') fps = 0;
        setStatus();
        return;
      }

      if (msg.camera) {
        showCamera(msg.camera);
        return;
      }

      // Any connected client can arm or stop a take, so every connected monitor
      // has to see the state change - that is the whole reason record state is
      // broadcast rather than answered only to whoever asked.
      if (msg.recording) {
        recordState = msg.recording;
        paintRecord(null);
        return;
      }

      // What the server granted this monitor, which is not always what it asked
      // for. Rendered from the answer rather than from the request, because the one
      // property this negotiation has to hold is that the setting on screen is the
      // setting on the wire.
      if (msg.monitor) {
        showMonitor(msg.monitor);
        return;
      }

      // **The hello is recognised rather than reached by falling through, and that
      // is a fix rather than a tidy-up.** Every branch above returns, so this used
      // to be the else-case for anything unrecognised - which meant a message type
      // added later did not fail, it set `focal` to (undefined, undefined). Every
      // point then unprojects to NaN and the viewer renders an empty frame with no
      // error anywhere, on a page that looks fine. Step 9's monitor message landed
      // exactly here and `library-check` caught it as fifteen identical renders.
      //
      // Tested on the hello's own fields because the payload is written into the
      // take verbatim, so there is no discriminator the server could add without
      // changing the file format. `serial` and the four intrinsics are what the
      // grabber always emits (`native/grabber.cpp:375-381`).
      if (typeof msg.serial === 'string' && Number.isFinite(msg.fx)) {
        uniforms.focal.value.set(msg.fx, msg.fy);
        uniforms.center.value.set(msg.cx, msg.cy);
        if (!msg.color) uniforms.hasColor.value = 0;
        sensorLabel = `${msg.serial} · fw ${msg.firmware}`;
        setStatus();
        console.log('sensor intrinsics', msg);
        return;
      }

      // Loud rather than ignored. A message this page does not understand means the
      // server is ahead of it, and the failure that produces is silent by nature.
      console.warn('unrecognised message on the frame socket', msg);
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
// in program time - the playhead, the look, the camera, every keyframe - and
// everything below it works in source time, because that is what a capture is
// addressed in. A constant slope is normal speed, a shallow one slow motion, a
// zero one a hold.
//
// It is an ordinary track in program time, evaluated by the same scalar code every
// look track goes through, and its value *is* a source second. That is what makes a
// speed ramp another track rather than a case inside the renderer, and it is why
// export needs no inverse: the playhead is already the coordinate the keys are in.
//
// `rate` is the slope wherever the curve has nothing to say - with no keys at all,
// which is what a clip starts as, and with the single origin key the first ramp
// creates. The speed slider writes it, so a clip with no retime keys behaves
// exactly as it did before there was a curve.
const retime = {
  rate: 1,
  // Ascending in `t`, and the first is always at program 0 once there are any. A
  // curve that started somewhere else would leave the first frame of the edit to
  // an extrapolation rule, so `keyRetime` plants the origin rather than letting
  // that be implicit.
  keys: [],

  sourceSecAt(programSec) {
    const keys = this.keys;
    if (keys.length === 0) return programSec * this.rate;
    if (keys.length === 1) return keys[0].value + (programSec - keys[0].t) * this.rate;
    return scalarAt(keys, programSec, EXTEND_ENDS);
  },

  // The local slope, in source seconds per program second. A pre-roll needs it to
  // turn fade and wake - which are source milliseconds and stay that way - into a
  // number of output frames, and step 6's audio gate reads it to decide whether
  // the take is playing at 1.0.
  slopeAt(programSec) {
    if (this.keys.length < 2) return this.rate;
    return scalarSlopeAt(this.keys, programSec);
  },

  /**
   * How many output frames back the curve has to reach for a pre-roll to cover
   * `sourceSpanSec` of source time ending at `programSec`.
   *
   * This is the question the pre-roll actually has, and reading `slopeAt` at the
   * target was the wrong answer to it the moment the slope stopped being
   * constant: slope-at-a-point times a frame count is the tangent line, not the
   * curve, so a ramp under-rolls on the shallow side and over-rolls on the steep
   * one. A hold is the extreme of that - the slope there is zero, no multiple of
   * it covers any source span at all, and the old arithmetic answered "no frames
   * needed" for the one case that needs the most. The surface memory holds what it
   * held before the hold began, so a correct pre-roll walks back *through* the
   * hold to where source time was last moving, and that is what this counts.
   *
   * Walked frame by frame rather than integrated in closed form, because a
   * pre-roll is a run of `renderProgramFrame` calls on the output frame grid and
   * nothing else - the number wanted is how many of those, so counting them is
   * the answer rather than an approximation of it.
   */
  framesBackFor(programSec, sourceSpanSec, outputFps, ceiling) {
    if (!(sourceSpanSec > 0)) return { frames: 0, covered: true };
    const at = this.sourceSecAt(programSec);
    const limit = Math.max(0, Math.floor(ceiling));
    for (let n = 1; n <= limit; n++) {
      if (at - this.sourceSecAt(programSec - n / outputFps) >= sourceSpanSec - 1e-9) {
        return { frames: n, covered: true };
      }
    }
    // A whole edit's worth of output frames that never covered the span. Reported
    // rather than rounded up to something plausible: the honest reading is that
    // this look cannot be warmed up on this curve, and a caller that wants to seek
    // anyway now knows its image is short rather than believing it is complete.
    return { frames: limit, covered: false };
  },

  /**
   * The program position a source position sits at. Export never needs it - that
   * is the whole point of keying in program time - and it is here for the two
   * places a source bound has to become a program bound: shortening a pre-roll to
   * the source frames the cache can hold, and asking how long the program is.
   *
   * Answered by searching the keys, which is legitimate precisely because it is
   * not on the render path. A curve with a hold in it is not injective, so this
   * returns the *first* program time reaching the source position, and a curve
   * that never reaches it returns where the curve ends.
   */
  programSecAt(sourceSec) {
    const keys = this.keys;
    if (keys.length === 0) return sourceSec / this.rate;
    if (keys.length === 1) return keys[0].t + (sourceSec - keys[0].value) / this.rate;
    if (sourceSec <= keys[0].value) {
      const slope = segmentSlope(keys, 0, 0);
      return slope > 0 ? keys[0].t - (keys[0].value - sourceSec) / slope : keys[0].t;
    }
    for (let i = 0; i < keys.length - 1; i++) {
      if (keys[i + 1].value < sourceSec) continue;
      // Bisected rather than solved, because the segment is an eased cubic and its
      // inverse has no useful closed form. Fifty halvings of a segment is well
      // under a microsecond and this runs once per seek, never once per frame.
      let lo = keys[i].t;
      let hi = keys[i + 1].t;
      for (let k = 0; k < 50; k++) {
        const mid = (lo + hi) / 2;
        if (this.sourceSecAt(mid) < sourceSec) lo = mid;
        else hi = mid;
      }
      return hi;
    }
    const last = keys[keys.length - 1];
    const slope = segmentSlope(keys, keys.length - 2, 1);
    // A curve that ends flat or falling never reaches any later source position,
    // so the program ends with the curve. The footage past there is unreachable
    // through this edit, which is a statement about the edit rather than a fault.
    return slope > 0 ? last.t + (sourceSec - last.value) / slope : last.t;
  },

  // How long a program is, given a source that long. It lives here rather than as
  // a division at the transport, because a curve answers it by searching and a
  // caller reaching for `rate` would be a third door into a seam that promises
  // two - which is the drift this design keeps refusing one layer up.
  programDurationFor(sourceSec) { return Math.max(0, this.programSecAt(sourceSec)); },

  /**
   * Refuses a curve that runs downhill. Non-decreasing is the invariant: equal
   * values are a hold and are legal, falling values are a reverse and are not.
   *
   * A reverse is not merely unimplemented, it is unreachable by construction. The
   * surface memory and the afterimage are advanced one source frame at a time and
   * neither can be walked back, so a descending segment asks the pair source to go
   * backwards and it refuses - from inside the animation loop, which three then
   * stops driving. The spec reaches for "a hold or a reverse" when arguing that
   * keying in source time needs an inverse, which reads as though a reverse ought
   * to be authorable; it is not, on this renderer, and that is a limitation rather
   * than an oversight.
   */
  assertMonotonic(keys) {
    for (const key of keys) {
      // Handles first, because a curve can run downhill without any pair of key
      // values doing so. Ascending keys with an outgoing y handle above 1 overshoot
      // past the later value and come back down inside the segment, which is a
      // reverse that a values-only check cannot see - and on a capture whose frames
      // are 107ms apart a shallow one hides inside single brackets, so `mixT` walks
      // backwards within a pair and the reverse renders silently rather than being
      // refused. x is checked for a different reason: outside the unit range the
      // timing curve is no longer single-valued in time, so the segment has two
      // values at one instant.
      //
      // Inside the unit box both are safe, and that is a property rather than a
      // hope: a cubic with ordinates 0, a, b, 1 has derivative
      // `3[a s² + 2(b−a)st + (1−b)t²]` for s = 1−u, t = u, which is non-negative
      // throughout [0,1]² - at worst zero, at a = 1, b = 0, where it is `3(1−2u)²`.
      for (const [side, h] of [['easeOut', key.easeOut], ['easeIn', key.easeIn]]) {
        if (!h.every((c) => c >= 0 && c <= 1)) {
          throw new Error(
            `the retime key at program ${key.t}s has a ${side} handle at `
            + `[${h.join(', ')}]: a handle outside the unit box bends the curve back on `
            + 'itself inside the segment, and source time cannot run backwards',
          );
        }
      }
    }
    for (let i = 1; i < keys.length; i++) {
      if (keys[i].value < keys[i - 1].value) {
        throw new Error(
          `the retime curve falls from ${keys[i - 1].value}s to ${keys[i].value}s between `
          + `program ${keys[i - 1].t}s and ${keys[i].t}s: source time cannot run backwards, `
          + 'because neither accumulator can',
        );
      }
    }
    return keys;
  },

  serialise() {
    return {
      rate: this.rate,
      keys: this.keys.map((k) => ({
        t: k.t, value: k.value, easeOut: [...k.easeOut], easeIn: [...k.easeIn],
      })),
    };
  },
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

// Where an export takes its bytes, and it is one position rather than a callback
// on every frame.
//
// The readback has to happen in the same task as the render that produced it -
// nothing preserves the drawing buffer across a paint - and `renderProgramFrame`
// is the only thing that renders, so this is the only place that is certainly
// true. A callback on every frame would be simpler and much worse: a seek's
// pre-roll renders dozens of frames nobody wants, `readPixels` is a full GPU
// stall, and paying one per discarded frame would put the cost of an accurate
// seek into every exported frame. So the export names the program position it
// wants, and the sink fires when the render is at it - which a pre-roll's
// positions never are, since both sides divide the same integer frame by the same
// output rate.
let frameSink = null;

// One image at one program position. This is the whole seam: the timeline and the
// export transports drive exactly this call, and an accurate seek is nothing more
// than running it repeatedly at earlier positions and throwing the results away.
function renderProgramFrame(t) {
  counters.renders++;
  chromeStale = true;
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

    // Every track, look and camera alike, written through the registry rather than
    // onto the uniforms and the camera object. That is what makes the camera a
    // parameter with a kind rather than something the render path happens to move,
    // and it is why a project file, a preset and an evaluated frame are the same
    // operation. A clip with no keys writes nothing and the registry's own values
    // stand, which is a locked-off camera and a static look.
    evaluateTracks(t);

    const dt = Math.max(0, t - lastProgramTime);
    lastProgramTime = t;

    // The delta goes in explicitly because the composer falls back to a clock of
    // its own when render() is called bare, which would put a wall clock back
    // inside the seam even though no pass in this chain reads the delta today.
    if (postEnabled()) composer.render(dt);
    else renderer.render(scene, viewCamera);

    if (frameSink !== null && t === frameSink.t) {
      const gl = renderer.getContext();
      gl.readPixels(
        0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight,
        gl.RGBA, gl.UNSIGNED_BYTE, frameSink.pixels,
      );
      frameSink.hits++;
    }
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
// The same three as a set, because the evaluator asks about one name per track and
// a three-element `includes` per track per frame is a linear scan inside the render
// loop for no reason.
const BYPASSED_SET = new Set(BYPASSED);

// The most output frames one tick may render to catch up. Enough to absorb a
// hitch of a few frames, small enough that a machine which cannot sustain the
// rate still yields between ticks rather than freezing the tab trying.
const CATCHUP_FRAMES = 4;
// How far behind real time playback has to fall before it says so. About eight
// frames at 30fps: below that it is a hitch, above it the rate on screen is not
// the rate the readout claims.
const BEHIND_NOTICE_MS = 250;
// How many times an operation re-plans itself around a curve that moved while it
// was fetching, before standing down and leaving the job to the repaint the same
// mutation queued. Two, which is the smallest number that absorbs one
// interruption: a plan, a fetch during which the curve moves, a re-plan, and a
// second fetch for the span the new curve wants. Past two it is chasing a hand
// rather than absorbing an event - a drag rewrites the curve on every pointer move,
// so no finite bound catches up with one, and standing down is the right answer
// there rather than a longer chase. Measured at both ends rather than guessed: at
// three an ordinary four-move drag hit the bound every time, and at one a single
// interruption never landed at all.
const SEEK_REPLANS = 2;
// How many stand-downs in a row before this stops being contention and starts
// being a seek that cannot converge for some other reason. A drag produces a
// handful and then lands; nothing else should produce any. Without this the quiet
// stand-down would be a silent stale image, which is the one outcome worse than an
// error.
const SEEK_OVERTAKEN_LIMIT = 12;

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
    // How many seeks in a row stood down because the curve moved under them. Reset
    // by any seek that lands, so a drag's handful never accumulates into a fault.
    this.overtaken = 0;
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
    // Read from the tracks *at the target*, never off the uniforms. The uniforms
    // hold whatever the last render left there, which is the look at wherever the
    // playhead happened to be parked - so with fade, wake or trails keyed, a seek
    // from a cheap position to an expensive one sized its warm-up for the cheap
    // one and landed short. Measured before the fix: trails keyed 0 at 0s and 0.9
    // at 8s, parked at 0 and seeking to 11s, computed 21 frames where the same
    // seek run warm computed 44, and landed 62/255 away from its own playback over
    // 12% of the frame. Sampling at the target is the right rule rather than a
    // conservative one: a ghost is drawn while `age < fade + wake * strength` read
    // from the uniforms *at draw time*, so it is the target's values that decide
    // what is still on screen there.
    const surfaceSec = (valueAtProgram('fade', programSec)
      + valueAtProgram('wake', programSec)) / 1000;
    // The surface half is a *window* on the curve rather than a slope times a
    // count - see `framesBackFor`. The ceiling is the whole edit in output frames,
    // because a pre-roll longer than the program it sits in cannot be rendered by
    // anything; it is deliberately not the target, so a length the head of the
    // take will clip is still reported at full and `seekNow` still says it
    // clipped it.
    const back = retime.framesBackFor(programSec, surfaceSec, this.outputFps, this.lastFrame);
    // The trails half is a window too, and for the same reason the retime half is.
    // Three's pass is `max(new, damp * old)` applied per output frame with *that
    // frame's* damp, so what survives from before a pre-roll is the *product* of
    // damp across the window - not `damp_at_target ^ n`. Sampling at the target
    // reads the tangent again: with damp keyed 0.95 up to the target and 0.5 at it,
    // the formula asked for 7 frames where the product needs 50, and the seek
    // landed 50/255 away from its own playback over 8.7% of the frame. Measured on
    // this page before the walk replaced it.
    //
    // The surface half genuinely is a point sample and stays one, which is worth
    // stating because the two look alike. The state texture's contents do not
    // depend on fade or wake at all - `advanceSurfaceState` reads only the gap and
    // the snap threshold - and the *drawing* decision reads the uniforms at the
    // frame being drawn. So covering fade plus wake of source time ending at the
    // target is exactly sufficient there, and nothing earlier in the window can ask
    // for more.
    const back2 = this.trailsFramesBack(programSec);
    const trails = back2.frames;
    const frames = Math.max(back.frames, trails);
    return {
      surface: back.frames,
      // False when a whole edit's worth of output frames still did not cover fade
      // plus wake - a curve flat enough that the surface memory cannot be warmed
      // from inside this program. The seek runs anyway and this is how it says the
      // image it produced is short.
      surfaceCovered: back.covered,
      trails,
      trailsCovered: back2.covered,
      frames,
      sec: frames / this.outputFps,
    };
  }

  /**
   * How many output frames back the afterimage has to be rebuilt from for nothing
   * of what came before to still be visible.
   *
   * A pre-roll of `L` renders frames `N-L` to `N` from a cleared buffer, so what
   * playback still carries from before `N-L` and this does not is scaled by the
   * product of damp over frames `N-L+1..N`. That is the number to drive under the
   * residual, and it is only `damp^L` while damp is constant - which is exactly
   * what it is on a clip with no trails key, so this returns what the closed form
   * returned and step 4's figures are unchanged.
   */
  trailsFramesBack(programSec) {
    // Zero damp is the pass switched off entirely, so there is no history to
    // rebuild rather than a very short one.
    if (!(valueAtProgram('trails', programSec) > 0)) return { frames: 0, covered: true };
    const ceiling = Math.max(1, this.lastFrame);
    let product = 1;
    for (let n = 1; n <= ceiling; n++) {
      product *= valueAtProgram('trails', programSec - (n - 1) / this.outputFps);
      if (product <= AFTERIMAGE_RESIDUAL) return { frames: n, covered: true };
    }
    return { frames: ceiling, covered: false };
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

  /**
   * Which output frames a seek renders and which source frames they need. Split
   * out because it has to be answered twice - see `seekNow`.
   */
  planSeek(programSec, frames) {
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
    return { target, t, plan, asked, length, start, from, to };
  }

  async seekNow(programSec, options = {}) {
    // Planned, fetched, then planned again, and the second plan is not belt and
    // braces. The retime curve is document state: dragging one of its keys
    // rewrites it on every pointer move, and a fetch is awaited in the middle of
    // this. So the span computed before the await can describe a program the page
    // no longer has - and rendering it walks the source backwards, which the pair
    // source refuses, correctly and far too late for anyone to do anything with.
    // Bounded rather than a `while (true)`: the plan only keeps moving while the
    // pointer is still down, and the repaint queued behind that pointer runs this
    // again anyway, so giving up is losing one frame rather than losing the edit.
    let planned = this.planSeek(programSec, options.frames);
    for (let attempt = 0; !this.source.resident(planned.from, planned.to); attempt++) {
      if (attempt >= SEEK_REPLANS) {
        // Overtaken, not broken. The hand that moved the curve has already queued a
        // repaint, so this operation is stale before it finishes and the useful
        // thing to do is stand down quietly rather than shout - a drag rewrites the
        // curve on every pointer move, and an error per move is an instrument
        // crying wolf at its own user. Asking for a repaint here is what makes the
        // quiet safe: it guarantees a successor, so standing down costs a frame
        // rather than leaving a stale image nobody could attribute to anything.
        this.overtaken++;
        if (this.overtaken > SEEK_OVERTAKEN_LIMIT) {
          this.overtaken = 0;
          throw new Error(
            `${SEEK_OVERTAKEN_LIMIT} seeks in a row were overtaken before they could land: `
            + 'the span a seek plans is not becoming resident, which is not a moving curve',
          );
        }
        requestRepaint();
        return null;
      }
      await this.source.ensure(planned.from, planned.to);
      planned = this.planSeek(programSec, options.frames);
    }
    const { target, t, plan, asked, from, to } = planned;
    const { length, start } = planned;

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
    this.overtaken = 0;
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
    // The same re-plan a seek does, and for the same reason: a drag on a retime key
    // rewrites the curve while this is awaiting its two frames, and the pair the
    // old curve named is not the pair the new one wants.
    let target = this.frameAt(programSec);
    let t = target / this.outputFps;
    let i = this.sourceFrameAt(t);
    for (let attempt = 0; !this.source.resident(i, i + 1); attempt++) {
      if (attempt >= SEEK_REPLANS) {
        throw new Error(`the retime curve moved under ${SEEK_REPLANS} plans of a draft at ${programSec}s`);
      }
      await this.source.ensure(i, i + 1);
      target = this.frameAt(programSec);
      t = target / this.outputFps;
      i = this.sourceFrameAt(t);
    }

    const began = performance.now();
    // Borrow, render and hand back, none of it asking for a repaint: these three
    // writes are the transport's own, and a repaint scheduled off them would run
    // the accurate seek this frame exists to avoid.
    withoutRepaint(() => {
      const held = params.values(BYPASSED);
      params.apply(BYPASS_ZERO);
      borrowed = BYPASSED_SET;
      try {
        // The reset is what lets a drag go backwards. Nothing here reads the
        // accumulators, so clearing them costs four target clears and removes the
        // one state that could not be walked the other way.
        resetAccumulators();
        this.source.seekTo(i);
        advanceNavigation(t);
        renderProgramFrame(t);
        // Inside the borrow, not after it. The top-down draws the same cloud the
        // frame did, so drawing it once the three parameters were handed back
        // would put a wake in the plan view that the picture beside it does not
        // have - and two drafts of one position would then differ by whatever
        // fade and wake happened to be, which is exactly what a draft is defined
        // not to depend on.
        drawChrome();
      } finally {
        borrowed = null;
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
    const want = this.sourceFrameAt(t) + 1;
    // A span that runs backwards is not "already resident", it is unwalkable - and
    // the residency test cannot tell the difference, because it compares a low
    // bound against a high one and passes vacuously the moment they cross. That
    // gave a curve running downhill two different failures depending on what
    // happened to be cached: with the frames resident, the pair source refused from
    // inside the animation loop and took the page down; without them, this returned
    // false forever and the prefetch below refused the same span the same vacuous
    // way, so playback simply stopped advancing and said nothing at all. The second
    // is the worse one. Named here, at the guard that was passing, so the tick can
    // pause and surface it either way.
    if (want < this.source.applied) {
      throw new Error(
        `playback at ${t.toFixed(3)}s wants source frame ${want} while the accumulators have `
        + `consumed ${this.source.applied}: the retime curve runs backwards here`,
      );
    }
    if (!this.source.resident(this.source.applied + 1, want)) return false;
    advanceNavigation(t);
    renderProgramFrame(t);
    this.frame = next;
    return true;
  }

  /**
   * One turn of the animation loop, and the only place in this file that catches
   * broadly.
   *
   * Three's `setAnimationLoop` does not request another frame after its callback
   * throws, so anything escaping here stops the page permanently - no playback, no
   * scrubbing, no repaint, and with nothing persisted that is the whole editing
   * session. The throw that reaches it is real: `StampedPairSource.at` refuses a
   * backward walk, correctly, and a retime curve that runs downhill asks for one on
   * the next step. The doors that could author such a curve are clamped now, so
   * this is a backstop rather than the fix - but a backstop is exactly what the one
   * function whose failure costs everything should have.
   */
  tick(nowMs = performance.now()) {
    try {
      this.tickNow(nowMs);
    } catch (err) {
      // Paused rather than left running: whatever the accumulators are holding, the
      // next step would ask for the same refusal again. Surfaced rather than
      // swallowed, because a playhead that silently stopped is the wrong picture
      // problem one layer up.
      this.playing = false;
      this.paint();
      showTimelineError(err);
    }
  }

  tickNow(nowMs) {
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
    // In the same task as the last `step`, because the loop only awaits when a
    // step could not run. That matters for one reason: paint is where the chrome
    // is drawn, and a run that ended without it would leave the buffer differing
    // from a seek's by the overlay alone - two arms of an equality disagreeing
    // about furniture rather than about the image.
    this.paint();
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

// ------------------------------------------------------------------- the export

// One renderer, driven with no wall clock anywhere.
//
// The classic failure here is a second offline renderer that never quite matches
// the preview, so there is not one: an export is the timeline transport stepped at
// k / outputFps, and `runTo` - playback with the clock taken out - is the driver.
// `step` stays the only thing that renders, so an exported frame and a played one
// walk identical positions by construction rather than by agreement. Slower than
// real time is fine and is arguably the point: the whole reason to record raw is
// to spend more time on the image than the sensor had.
//
// Remote encoding is then this same code driven by Playwright in headless Chrome
// on a bigger machine, which is why the job record below carries the renderer
// class from the very first job.

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  // Marked handled here so a failure that nobody is awaiting yet - the socket
  // dying between two frames, say - surfaces at the await that comes next instead
  // of as an unhandled rejection with no context attached.
  promise.catch(() => {});
  return { promise, resolve, reject };
};

/**
 * The wire, and the flow control on it.
 *
 * Frames go out as raw RGBA binary messages and the server acks each one once it
 * has reached ffmpeg's stdin. The window is what stops the browser running ahead
 * of the encoder: a cheap look renders faster than libx264 encodes, and without an
 * ack the frames would pile up eight megabytes at a time in the server's memory
 * behind a stdin that is not draining. `bufferedAmount` would bound the browser's
 * own queue and say nothing at all about that one.
 */
class ExportSink {
  constructor(begin) {
    this.ready = deferred();
    this.done = deferred();
    this.window = 1;
    this.sent = 0;
    this.acked = 0;
    this.waiting = null;
    this.failure = null;
    this.finished = false;
    const socket = new WebSocket(`ws://${location.host}/export`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => socket.send(JSON.stringify({ begin }));
    socket.onmessage = (event) => this.receive(JSON.parse(event.data));
    socket.onerror = () => this.fail(new Error('the export socket failed'));
    socket.onclose = () => this.fail(new Error('the export socket closed before the encode finished'));
    this.socket = socket;
  }

  receive(msg) {
    if (msg.error) {
      this.fail(new Error(msg.error));
    } else if (msg.ready) {
      this.window = msg.ready.window;
      this.ready.resolve(msg.ready);
    } else if (msg.ack) {
      this.acked = msg.ack;
      const waiter = this.waiting;
      this.waiting = null;
      waiter?.resolve();
    } else if (msg.done) {
      this.finished = true;
      this.done.resolve(msg.done);
    }
  }

  fail(err) {
    if (this.failure || this.finished) return;
    this.failure = err;
    this.ready.reject(err);
    this.done.reject(err);
    this.waiting?.reject(err);
    this.socket.close();
  }

  /** Hands one frame to the wire and returns once the pipe has room for the next. */
  async send(pixels) {
    if (this.failure) throw this.failure;
    // `send` queues a copy, which is what lets the readback reuse one buffer for
    // the whole export rather than allocating eight megabytes a frame. If that
    // were ever untrue the exported frames would be the *last* frame repeated,
    // which is exactly what the per-frame hashes the server returns would catch.
    this.socket.send(pixels);
    this.sent++;
    while (!this.failure && this.sent - this.acked >= this.window) {
      this.waiting = deferred();
      await this.waiting.promise;
    }
  }

  async finish() {
    if (this.failure) throw this.failure;
    this.socket.send(JSON.stringify({ end: true }));
    return this.done.promise;
  }
}

class ExportTransport {
  constructor(transport, options) {
    this.transport = transport;
    this.width = options.width;
    this.height = options.height;
    this.fps = options.fps;
    this.from = options.from;
    this.to = options.to;
    this.onProgress = options.onProgress ?? (() => {});
    // One buffer for the whole run. `readPixels` is a GPU-to-CPU synchronisation
    // point and will stall the pipeline every frame; that is accepted at export
    // rates, and if it ever becomes the limit the fix is asynchronous readback
    // through a pixel buffer with a fence rather than a different transport.
    this.pixels = new Uint8Array(options.width * options.height * 4);
  }

  /**
   * Every frame from `from` to `to`, in order, each one read back in the same task
   * as the render that produced it.
   *
   * The first frame is the only one that costs a seek - it has to pre-roll the
   * accumulators from a known state, exactly as landing the playhead there in the
   * editor would - and every frame after it is a single step. That is why an
   * export needs no driver of its own: those are the two things the timeline
   * transport already does.
   */
  async run(sink) {
    for (let n = this.from; n <= this.to; n++) {
      const at = n / this.fps;
      frameSink = { t: at, pixels: this.pixels, hits: 0 };
      let hits = 0;
      try {
        if (n === this.from) await this.transport.seek(at);
        else await this.transport.runTo(n);
      } finally {
        hits = frameSink.hits;
        frameSink = null;
      }
      // Counted rather than assumed. A seek that stood down, a `runTo` asked for a
      // frame it was already past, or a program position that stopped being the
      // one the sink names would all leave the buffer holding the previous frame -
      // and an export of the same image repeated is the failure that looks most
      // like a success.
      if (hits !== 1) {
        throw new Error(`the render at ${at.toFixed(6)}s reached the export ${hits} times, not once`);
      }
      await sink.send(this.pixels);
      this.onProgress(n - this.from + 1, this.to - this.from + 1);
    }
    return this.to - this.from + 1;
  }
}

// Whether an export owns the renderer. Nothing else may draw while one does: a
// repaint queued by a slider, or a draft from a scrub, would clear the
// accumulators in the middle of a walk the export is halfway through and hand it
// a frame with no history behind it.
let exporting = false;

const rendererClass = () => {
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
};

/**
 * The door. Sizes the buffer to the output, points the viewport at the program
 * camera, takes the furniture off, renders the clip, and puts the editor back
 * exactly as it was.
 *
 * The output size is a setting rather than the window's, which is only true
 * because every screen-space term is resolution-relative now - that is the whole
 * reason this step comes after the one above it.
 */
async function exportClip(options = {}) {
  if (!timeline) throw new Error('there is no clip open to export');
  if (exporting) throw new Error('an export is already running');
  const width = Math.trunc(options.width ?? 1920);
  const height = Math.trunc(options.height ?? 1080);
  const fps = options.fps ?? timeline.outputFps;

  const restore = {
    outputFps: timeline.outputFps,
    programSec: timeline.programSec,
    chrome: chromeOn,
    camera: viewCamera,
  };

  exporting = true;
  timeline.pause();
  try {
    // The rate first, because the frame grid every position below is named in is
    // the output rate's grid.
    timeline.outputFps = fps;
    const from = Math.max(0, Math.trunc(options.from ?? 0));
    const to = Math.min(timeline.lastFrame, Math.trunc(options.to ?? timeline.lastFrame));
    if (to < from) throw new Error(`an export of frames ${from}..${to} has nothing in it`);

    // Composition comes from the camera track, so the export renders what the
    // program camera sees whatever the editor happens to be orbiting.
    setViewCamera(programCamera);
    // Chrome is not the frame. It lives on a canvas of its own so it cannot reach
    // the pixels anyway; taking it off is so the editor is not drawing a path over
    // a buffer that has become the output's size underneath it.
    chromeOn = false;
    placeChrome();
    outputSize = { w: width, h: height };
    resize();

    const gl = renderer.getContext();
    if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) {
      throw new Error(
        `the drawing buffer is ${gl.drawingBufferWidth}x${gl.drawingBufferHeight} after asking for `
        + `${width}x${height}: the output size did not reach the renderer`,
      );
    }

    const run = new ExportTransport(timeline, {
      width, height, fps, from, to, onProgress: options.onProgress,
    });
    const sink = new ExportSink({
      name: options.name ?? timeline.source.id,
      width,
      height,
      fps,
      frames: to - from + 1,
      codec: options.codec ?? 'h264',
      // A job is a project file plus a capture named by content hash plus output
      // settings, and it records the renderer class it was made on. There is one
      // render machine today so the field constrains nothing - but a job record
      // without it cannot be retrofitted once old jobs exist, and provenance is
      // exactly what is wanted on the day two workers disagree about an image.
      project: serialiseProject(),
      capture: timeline.source.index.hash,
      renderer: rendererClass(),
    });
    await sink.ready.promise;
    await run.run(sink);
    return await sink.finish();
  } finally {
    exporting = false;
    outputSize = null;
    resize();
    chromeOn = restore.chrome;
    placeChrome();
    setViewCamera(restore.camera);
    timeline.outputFps = restore.outputFps;
    timeline.frame = timeline.frameAt(restore.programSec);
    timingChanged();
    requestRepaint();
  }
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
  rateKey: document.getElementById('tRateKey'),
  fps: document.getElementById('tFps'),
  preroll: document.getElementById('tPreroll'),
  cost: document.getElementById('tCost'),
  undo: document.getElementById('tUndo'),
  behind: document.getElementById('tBehind'),
  bed: document.getElementById('tBed'),
  rail: document.getElementById('tRail'),
  beds: document.getElementById('tBeds'),
  ruler: document.getElementById('tRuler'),
  playhead: document.getElementById('tPlayhead'),
  note: document.getElementById('tNote'),
  cameraGroup: document.getElementById('cameraGroup'),
  camKey: document.getElementById('camKey'),
  camClear: document.getElementById('camClear'),
  camView: document.getElementById('camView'),
  exportSize: buildExportMenu(document.getElementById('tExportSize')),
  exportGo: document.getElementById('tExport'),
  exportNote: document.getElementById('tExportNote'),
  marks: document.getElementById('tMarks'),
  markCount: document.getElementById('tMarkCount'),
  mark: document.getElementById('tMark'),
  preset: document.getElementById('tPreset'),
  presetApply: document.getElementById('tPresetApply'),
  presetSave: document.getElementById('tPresetSave'),
  project: document.getElementById('tProject'),
  projectOpen: document.getElementById('tProjectOpen'),
  projectSave: document.getElementById('tProjectSave'),
  recGo: document.getElementById('recGo'),
  recMark: document.getElementById('recMark'),
  recNote: document.getElementById('recNote'),
  recSpace: document.getElementById('recSpace'),
  toLibrary: document.getElementById('toLibrary'),
};

// The chips strip hides its scrollbar so the bar keeps its 51px and the lanes stay
// where a dragged key expects them - which also hid the only evidence that anything
// was off its right edge. This puts a fade there when there is, and takes it away
// when there is not, so the strip says whether it has more.
//
// Watched two ways because it overflows for two reasons. The window getting narrower
// changes the strip's own box, which is the ResizeObserver; the readouts inside it
// getting longer - the pre-roll grows on a slow ramp, an export note arrives - does
// not, which is the MutationObserver. Either one alone leaves a state where the fade
// is wrong, and a fade that is wrong is worse than none.
{
  const chips = document.querySelector('.tchips');
  const sayMore = () => chips.classList.toggle('more', chips.scrollWidth > chips.clientWidth + 1);
  new ResizeObserver(sayMore).observe(chips);
  new MutationObserver(sayMore).observe(chips, { subtree: true, childList: true, characterData: true });
  sayMore();
}

// The export note is pinned beside the render button and truncates rather than
// pushing the controls off, so the whole sentence has to stay reachable somewhere -
// a failure message is exactly the one that overflows.
const sayExport = (text) => {
  ui.exportNote.textContent = text;
  ui.exportNote.title = text;
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

/**
 * The program length the ruler and the lanes are drawn against.
 *
 * Frozen for the length of a lane drag, and that is not a nicety. The retime curve
 * *is* the program length: dragging one of its keys down slows the clip, which
 * lengthens the program, which rescales the ruler, which moves the key under a
 * pointer that has not moved horizontally - and the new position is read back as a
 * new program time, which slows it further. Measured before it was fixed: a
 * twelve-pixel vertical drag walked one key from 15.0s to 48.3s in four moves, and
 * the drag got faster the longer it went on.
 */
const rulerDuration = () => {
  if (laneDrag) return laneDrag.duration;
  return timeline ? timeline.duration : 1;
};

function paintUndoCount() {
  ui.undo.textContent = String(history.depth);
}

function paintTimeline(t) {
  const program = t.programSec;
  ui.play.textContent = t.playing ? '❙❙' : '▶';
  ui.play.setAttribute('aria-label', t.playing ? 'Pause' : 'Play');
  ui.program.textContent = timecode(program);
  ui.source.textContent = timecode(retime.sourceSecAt(program));
  ui.playhead.style.left = `${(program / Math.max(1e-6, rulerDuration())) * 100}%`;
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
  paintUndoCount();
  paintLanes();
  // Editor furniture - the camera path, its nodes and the top-down - is drawn
  // here rather than inside `renderProgramFrame`, and the distinction is not
  // cosmetic. That function is the seam: one image at one program position, and
  // it is what an export hashes and what every equality in this repo compares.
  // Chrome is not the frame. Drawing it here also means it lands in the same task
  // as the render that produced the buffer, which is the only place it can land
  // at all, since the drawing buffer is not preserved across a paint.
  drawChrome();
}

function buildRuler() {
  const total = Math.max(1e-6, rulerDuration());
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
  if (draftBusy || draftWanted === null || !timeline || exporting) return;
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
  // image the moment it ends, so neither needs one scheduled underneath it. An
  // export is the same rule for a harder reason: it is walking the accumulators
  // forward a frame at a time, and a repaint landing between two of its frames
  // would reset them under it. It repaints once at the end for the editor's sake.
  if (!timeline || timeline.playing || scrubbing || orbiting || exporting) return;
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
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * rulerDuration();
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
  // state - it is the one-key version of the curve, and the curve takes over the
  // moment there are keys. Changing it moves where the playhead's program time
  // lands in the take, so the image has to be rebuilt at the position the
  // playhead already holds.
  retime.rate = Number(ui.rate.value);
  const wasPlaying = timeline.playing;
  timeline.pause();
  timingChanged();
  timeline.seek(Math.min(timeline.programSec, timeline.duration))
    .then(() => { if (wasPlaying) return timeline.play(); })
    .catch(showTimelineError);
});

ui.rate.addEventListener('change', () => history.commit());

ui.fps.addEventListener('change', () => {
  if (!timeline) return;
  const held = timeline.programSec;
  timeline.outputFps = Number(ui.fps.value);
  const wasPlaying = timeline.playing;
  timeline.pause();
  timingChanged();
  timeline.seek(held)
    .then(() => { if (wasPlaying) return timeline.play(); })
    .catch(showTimelineError);
  history.commit();
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

// ------------------------------------------------------------ look in tracks

// Look is edited here and composition is not, and the split is the same one that
// decides what a preset contains. `bloom`, `wake` and the rest have no spatial
// meaning, so they get conventional lanes with ease handles; inventing an in-world
// metaphor for a scalar would buy novelty at the cost of being able to type 0.5.
// The camera goes the other way for the same reason read backwards - see the world
// surface below.
//
// Only parameters carrying keys get a lane. Nine permanent lanes was the first
// shape of this and it spends the strip on rows that say nothing; five that are
// all animated is the same information in half the height.

const LANE_H = { scalar: 34, step: 22, pose: 22 };
const RETIME_LANE_H = 40;
// How far a curve is sampled across a lane. The viewBox is resolution-independent,
// so this is a smoothness choice and not a pixel count.
const CURVE_SAMPLES = 120;
const SVG_NS = 'http://www.w3.org/2000/svg';

// Which key is selected, as {owner, key}. `owner` is a parameter name or the
// retime, and the pair is held rather than an index because sorting a track moves
// indices out from under a drag.
let selection = null;

const svg = (name, attrs) => {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/** The value range a lane draws against. */
function laneRange(owner) {
  if (owner === 'retime') {
    const total = Math.max(1e-6, timeline ? timeline.source.duration : 1);
    return { min: 0, max: total };
  }
  const spec = params.spec(owner);
  return { min: spec.min, max: spec.max };
}

function laneRows() {
  const rows = [];
  if (retime.keys.length > 0) {
    rows.push({ owner: 'retime', label: 'retime', kind: 'scalar', height: RETIME_LANE_H });
  }
  // Composition before look, and the camera first inside it, because that is the
  // order the split is described in everywhere else in this design.
  for (const name of ['camera', ...params.names('look')]) {
    const track = tracks.get(name);
    if (!track || track.keys.length === 0) continue;
    rows.push({ owner: name, label: name, kind: track.kind, height: LANE_H[track.kind] });
  }
  return rows;
}

const keysOf = (owner) => (owner === 'retime' ? retime.keys : (tracks.get(owner)?.keys ?? []));

function laneReadout(owner) {
  if (owner === 'retime') return `${retime.slopeAt(playheadSec()).toFixed(2)}×`;
  const value = params.get(owner);
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') return value >= 100 ? value.toFixed(0) : value.toFixed(2);
  return `${keysOf(owner).length} keys`;
}

/**
 * Rebuilds the lane rows. Called when the *set* of lanes or keys changes, never
 * per frame - the playhead moving repaints readouts through `paintLanes` and
 * touches no DOM structure, because rebuilding a lane under a drag would replace
 * the element the pointer is captured on.
 */
function rebuildLanes() {
  for (const el of [...ui.rail.children, ...ui.beds.children]) {
    if (!el.classList.contains('ruler') && el !== ui.playhead) el.remove();
  }
  const rows = laneRows();
  const duration = Math.max(1e-6, rulerDuration());

  for (const row of rows) {
    const rail = document.createElement('div');
    rail.className = 'trow';
    rail.style.height = `${row.height}px`;
    const label = document.createElement('span');
    label.textContent = row.label;
    const value = document.createElement('b');
    value.dataset.readout = row.owner;
    value.textContent = laneReadout(row.owner);
    rail.append(label, value);
    ui.rail.appendChild(rail);

    const bed = document.createElement('div');
    bed.className = 'trow';
    bed.style.height = `${row.height}px`;
    const lane = document.createElement('div');
    lane.className = 'tlane';
    lane.dataset.owner = row.owner;
    bed.appendChild(lane);
    ui.beds.insertBefore(bed, ui.playhead);
    drawLane(lane, row, duration);
  }

  ui.root.style.setProperty('--tlanes-h', `${rows.reduce((n, r) => n + r.height + 1, 0)}px`);
  // The strip changed height, so the stage the renderer sizes itself to did too -
  // and so did the canvas the furniture is drawn on, which is sized to the stage.
  resize();
  placeChrome();
}

function drawLane(lane, row, duration) {
  const keys = keysOf(row.owner);
  const x = (t) => (t / duration) * 100;

  if (row.kind === 'scalar') {
    // The curve itself, because a row of diamonds says where the keys are and
    // nothing at all about the shape between them - and the shape is exactly what
    // an ease handle edits. Drawn in a 0..1000 by 0..100 viewBox stretched to the
    // lane, so it costs nothing to redraw at a different width.
    const { min, max } = laneRange(row.owner);
    const span = Math.max(1e-9, max - min);
    const at = row.owner === 'retime'
      ? (t) => retime.sourceSecAt(t)
      : (t) => tracks.get(row.owner).valueAt(t);
    // **Known gap, carried deliberately.** The curve is drawn from the raw eased
    // value while the parameter itself is clamped to its range on the way in, so an
    // overshooting ease handle near a bound draws a curve leaving the lane where
    // the rendered value simply saturates. The lane is then a picture of a value
    // the clip cannot hold. The fix is to draw through `params.normalise` the way
    // the keys already are.
    const points = [];
    for (let i = 0; i <= CURVE_SAMPLES; i++) {
      const t = (i / CURVE_SAMPLES) * duration;
      const y = 100 - ((at(t) - min) / span) * 100;
      points.push(`${(i / CURVE_SAMPLES) * 1000},${Math.max(-20, Math.min(120, y)).toFixed(2)}`);
    }
    const box = svg('svg', { viewBox: '0 0 1000 100', preserveAspectRatio: 'none' });
    box.appendChild(svg('polyline', {
      points: points.join(' '), fill: 'none', stroke: 'var(--accent)',
      'stroke-width': 1.4, 'vector-effect': 'non-scaling-stroke',
    }));
    lane.appendChild(box);
  }

  for (const key of keys) {
    const node = document.createElement('div');
    node.className = 'tkey';
    if (selection && selection.key === key) node.classList.add('sel');
    node.style.left = `${x(key.t)}%`;
    node.style.top = `${keyY(row, key)}%`;
    node.dataset.role = 'key';
    lane.appendChild(node);
    node.__key = key;
    node.__row = row;
  }

  if (row.kind !== 'scalar' || !selection || keys.indexOf(selection.key) < 0) return;
  // Handles only on the selected key, and only where there is a segment for them
  // to shape. Two of them at once on every key is a lane nobody can read.
  const i = keys.indexOf(selection.key);
  for (const side of ['easeOut', 'easeIn']) {
    const seg = side === 'easeOut' ? i : i - 1;
    if (seg < 0 || seg >= keys.length - 1) continue;
    const handle = document.createElement('div');
    handle.className = 'thandle';
    const point = handlePoint(row, keys, seg, side);
    handle.style.left = `${x(point.t)}%`;
    handle.style.top = `${point.y}%`;
    handle.dataset.role = 'handle';
    handle.__key = selection.key;
    handle.__row = row;
    handle.__side = side;
    handle.__seg = seg;
    lane.appendChild(handle);
  }
}

/** A key's vertical place in its lane, as a percentage from the top. */
function keyY(row, key) {
  if (row.kind !== 'scalar') return 50;
  const { min, max } = laneRange(row.owner);
  const v = typeof key.value === 'number' ? key.value : min;
  return Math.max(0, Math.min(100, 100 - ((v - min) / Math.max(1e-9, max - min)) * 100));
}

/** Where an ease handle sits, in program seconds and lane percentage. */
function handlePoint(row, keys, seg, side) {
  const a = keys[seg];
  const b = keys[seg + 1];
  const h = side === 'easeOut' ? a.easeOut : b.easeIn;
  const { min, max } = laneRange(row.owner);
  const value = a.value + (b.value - a.value) * h[1];
  return {
    t: a.t + (b.t - a.t) * h[0],
    y: Math.max(-15, Math.min(115, 100 - ((value - min) / Math.max(1e-9, max - min)) * 100)),
  };
}

/**
 * Holds a retime key inside its neighbours, in both time and value.
 *
 * The value half is what stops a reverse being authored - see
 * `retime.assertMonotonic` for why one cannot be rendered. The time half is the
 * same rule read the other way: a key dragged past its neighbour would sort into a
 * different position and pair its value with the wrong side, producing a descent
 * without any value having moved. Clamping rather than refusing, because a drag
 * that stops at the neighbour reads as the curve resisting; one that throws
 * mid-gesture reads as the editor breaking.
 */
function clampRetimeKey(keys, key) {
  const i = keys.indexOf(key);
  // The curve is anchored at the origin, so its first key holds still in time.
  // Letting it slide would leave the head of the edit to an extrapolation rule,
  // which is the thing planting the origin key exists to avoid.
  if (i === 0) key.t = 0;
  else {
    const after = i < keys.length - 1 ? keys[i + 1].t : Infinity;
    key.t = Math.max(keys[i - 1].t + KEY_GAP_SEC, Math.min(after - KEY_GAP_SEC, key.t));
  }
  const floor = i > 0 ? keys[i - 1].value : 0;
  const ceiling = i < keys.length - 1 ? keys[i + 1].value : timeline.source.duration;
  key.value = Math.max(floor, Math.min(ceiling, key.value));
}

// The least program time two retime keys may be apart. Zero would let two of them
// land on the same instant, which is a segment of no duration and a slope of
// infinity - legal arithmetic and an unreadable lane.
const KEY_GAP_SEC = 1 / 240;

/** Readouts only. Structure is `rebuildLanes`, and the two are kept apart on purpose. */
function paintLanes() {
  for (const el of ui.rail.querySelectorAll('b[data-readout]')) {
    el.textContent = laneReadout(el.dataset.readout);
  }
  for (const [name, btn] of keyButtons) paintKeyButton(name, btn);
  paintRateKey();
}

/** A lane appeared, moved or went away. */
function lanesChanged() {
  rebuildLanes();
  paintLanes();
}

/** The retime curve or the output rate moved, so every position on the ruler did. */
function timingChanged() {
  if (!timeline) return;
  ui.rate.value = String(retime.rate);
  ui.rateOut.textContent = `${retime.rate.toFixed(2)}×`;
  // The slider is the one-key version of the curve, so once the curve has keys it
  // has nothing left to say: it would set a slope only the extrapolated ends read.
  // Saying so is better than leaving a live control that moves nothing visible.
  ui.rate.disabled = retime.keys.length > 0;
  ui.fps.value = String(timeline.outputFps);
  buildRuler();
  paintMarks();
  lanesChanged();
}

// --------------------------------------------------------------- marks on the take

// The take's marks, fetched once when it opens. They belong to the take rather
// than to any project built on it, which is the whole reason they live in a
// sidecar: correcting one corrects it for every edit of that footage, and the
// gallery can draw them without loading anything that knows about edits.
let takeMarks = [];
let openTakeId = null;

function paintMarks() {
  const host = ui.marks;
  if (!host) return;
  host.replaceChildren();
  ui.markCount.textContent = String(takeMarks.length);
  if (!timeline) return;
  const total = Math.max(1e-6, rulerDuration());
  for (const mark of takeMarks) {
    // Marks are stamped in source milliseconds and the ruler is program seconds,
    // so every tick goes through the curve. The two coincide only at rate 1 with
    // no keys, which is exactly the case that would let a wrong implementation
    // look right - so this is drawn through `programSecAt` even when it is the
    // identity.
    const program = retime.programSecAt(mark.sourceMs / 1000);
    const el = document.createElement('span');
    // A mark the edit never reaches is drawn at the edge in the dim colour rather
    // than dropped. `programSecAt` returns where the curve ends for a source
    // position it never gets to, so this is the honest reading of that answer: the
    // moment is still in the footage, and a tick that silently vanished when
    // somebody shortened the clip would be worse than one that needs explaining.
    const beyond = program >= total - 1e-9 && mark.sourceMs / 1000 > retime.sourceSecAt(total) + 1e-9;
    el.className = beyond ? 'tmk beyond' : 'tmk';
    el.style.left = `${Math.max(0, Math.min(1, program / total)) * 100}%`;
    el.title = `${mark.label ?? mark.id} · source ${(mark.sourceMs / 1000).toFixed(2)}s`;
    host.appendChild(el);
  }
}

async function loadMarks(id) {
  try {
    const res = await fetch(`/capture/${encodeURIComponent(id)}/marks`);
    takeMarks = res.ok ? (await res.json()).marks : [];
  } catch {
    takeMarks = [];
  }
  paintMarks();
}

/**
 * Flags the moment at the playhead. Written in source milliseconds, because a
 * mark describes the footage rather than this edit of it - it survives a retime,
 * outlives this project, and is shared by every project built on this take.
 */
async function markHere() {
  if (!openTakeId || !timeline) return;
  const sourceMs = Math.round(retime.sourceSecAt(timeline.programSec) * 1000);
  const rec = { id: `m${Date.now().toString(36)}`, sourceMs, label: `mark ${takeMarks.length + 1}`, at: Date.now() };
  const res = await fetch(`/capture/${encodeURIComponent(openTakeId)}/marks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marks: [rec] }),
  });
  takeMarks = (await res.json()).marks;
  paintMarks();
}

// ------------------------------------------------------------- the preset library

/**
 * Where the look on screen came from, or null if nobody applied one.
 *
 * This is a copy plus a stamp rather than a reference, and the copy is what keeps
 * a project self-contained - a render worker needs the file and nothing else, and
 * re-rendering last month's project has to produce the image it produced then.
 * Resolving a preset by name at render time would give centrally-updatable
 * cohesion at the cost of both those properties, and deleting a preset would break
 * every project that named it.
 *
 * The stamp recovers most of what a reference offered, for nothing: because
 * presets are content-hashed the same way captures are, the gallery can see that
 * three clips are on one revision of a look and two are on an older one. Drift is
 * not repaired automatically - tweaking a preset means re-applying it - but it
 * stops being invisible, which is the part that bites when a set of clips is
 * supposed to belong together.
 */
let appliedPreset = null;

/**
 * A preset carries the look values *and* the mode, and the second half is a
 * special case rather than an oversight.
 *
 * The registry deliberately excludes the mode: it is clip state, not a
 * keyframeable parameter, so `params.values(params.names('look'))` will neither
 * capture nor restore it. The spec's preset table lists mode first among
 * presettable look, and both statements hold - a preset carries static values, and
 * applying one is a user action - so the preset format carries the mode alongside
 * the registry subset instead of assuming the subset is the whole preset.
 */
function presetFromCurrentLook(names) {
  return { mode: clipMode, values: params.values(names ?? params.names('look')) };
}

/**
 * Applies a saved preset and stamps where it came from.
 *
 * `applyModeValue` rather than `setMode`, and this is the trap the two functions
 * were split for. `setMode(4)` applies the hardcoded BLACKWALL look as part of
 * selecting the mode, so routing a user's own preset through it would overwrite
 * that user's twelve values with the built-in ones on the way past - the preset
 * would appear to load and would not be the preset.
 */
function applyStoredPreset(doc) {
  refuseDuringEvaluation('a stored preset applied');
  if (doc.body.version !== PROJECT_VERSION) {
    throw new Error(
      `preset ${doc.name} is version ${JSON.stringify(doc.body.version)} and this build reads `
      + `${PROJECT_VERSION}: point size is pixels at 1080p here and was pixels at the drawing `
      + 'buffer before, so its look cannot be reconstructed',
    );
  }
  if (Number.isInteger(doc.body.mode)) applyModeValue(doc.body.mode);
  params.apply(doc.body.values ?? {});
  appliedPreset = { name: doc.name, rev: doc.rev };
  requestRepaint();
  history.commit();
}

const documentsIn = async (kind) => (await (await fetch(`/${kind}`)).json())[kind];

async function refreshPresets() {
  const list = await documentsIn('presets');
  ui.preset.replaceChildren(new Option('—', ''));
  for (const doc of list) ui.preset.appendChild(new Option(doc.name, doc.name));
  if (appliedPreset) ui.preset.value = appliedPreset.name;
  return list;
}

async function refreshProjects() {
  const list = await documentsIn('projects');
  ui.project.replaceChildren(new Option('—', ''));
  for (const doc of list) ui.project.appendChild(new Option(doc.name, doc.name));
  return list;
}

// ------------------------------------------------------- dragging keys and handles

// One pointer path for keys and handles in every lane, because they differ only in
// what a drag writes. Attached to the lane column rather than per element, so a
// rebuild between two pointer events cannot leave a listener on a node that is no
// longer in the document.
let laneDrag = null;

function laneProgramAt(clientX) {
  const r = ui.bed.getBoundingClientRect();
  return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * rulerDuration();
}

// **Known gap, carried deliberately.** An undo landing between this pointerdown
// and its pointerup rebuilds every track from the snapshot, so `laneDrag.key` is
// left pointing at an object no track holds any more: the rest of the drag writes
// into nothing and the release commits a document the drag never touched. It needs
// a keyboard undo during a pointer drag, which no gesture produces by hand. The fix
// is for the restore to cancel any drag in flight.
ui.beds.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.tkey, .thandle');
  if (!el || !timeline) return;
  e.preventDefault();
  e.stopPropagation();
  ui.beds.setPointerCapture(e.pointerId);
  const lane = el.closest('.tlane');
  laneDrag = {
    el, row: el.__row, key: el.__key, side: el.__side, seg: el.__seg,
    role: el.dataset.role, rect: lane.getBoundingClientRect(),
    // Read before anything in the drag can change it - see `rulerDuration`.
    duration: timeline.duration,
  };
  selection = { owner: el.__row.owner, key: el.__key };
  lanesChanged();
});

ui.beds.addEventListener('pointermove', (e) => {
  if (!laneDrag) return;
  const { row, key, rect } = laneDrag;
  const keys = keysOf(row.owner);
  const { min, max } = laneRange(row.owner);
  const frac = Math.min(1.15, Math.max(-0.15, (e.clientY - rect.top) / Math.max(1, rect.height)));
  const value = min + (1 - frac) * (max - min);

  if (laneDrag.role === 'key') {
    key.t = Math.max(0, laneProgramAt(e.clientX));
    if (row.kind === 'scalar') key.value = value;
    if (row.owner === 'retime') clampRetimeKey(keys, key);
    else {
      if (row.kind === 'scalar') {
        // Through the registry's own snapping without writing the parameter, so a
        // key dragged in a lane and one written from the slider hold the same
        // value. Writing it would also be wrong: the key being dragged is usually
        // not the one at the playhead, and the evaluator would put the parameter
        // back a frame later, so the panel would jump and snap back for no reason.
        key.value = params.normalise(row.owner, key.value);
      }
      // A look track may go up and down and its keys may be dragged past one
      // another, so it sorts. The retime cannot and does not - see the clamp.
      tracks.get(row.owner).keys.sort((x, y) => x.t - y.t);
    }
    if (row.owner === 'retime') timingChanged();
  } else {
    const a = keys[laneDrag.seg];
    const b = keys[laneDrag.seg + 1];
    const dt = Math.max(1e-9, b.t - a.t);
    const dv = b.value - a.value;
    const h = laneDrag.side === 'easeOut' ? a.easeOut : b.easeIn;
    // x stays inside the segment because the ease is a function of time within it:
    // a handle past either end makes the timing curve fold back on itself and the
    // value would run backwards through part of the segment.
    h[0] = Math.min(1, Math.max(0, (laneProgramAt(e.clientX) - a.t) / dt));
    if (Math.abs(dv) > 1e-9) h[1] = (value - a.value) / dv;
    // A look handle may overshoot - a value that swings past its key and comes
    // back is an ordinary creative choice. The retime's may not: y outside the unit
    // range makes the eased source time leave the segment's own bounds and run
    // downhill inside it, which is a reverse authored through the back door.
    if (row.owner === 'retime') h[1] = Math.min(1, Math.max(0, h[1]));
  }
  lanesChanged();
  requestRepaint();
});

for (const type of ['pointerup', 'pointercancel']) {
  ui.beds.addEventListener(type, () => {
    if (!laneDrag) return;
    const wasRetime = laneDrag.row.owner === 'retime';
    laneDrag = null;
    // The ruler was held still for the drag, so this is where it catches up with
    // however much longer or shorter the curve has made the program.
    if (wasRetime) timingChanged();
    else lanesChanged();
    // One drag is one interaction, which is the whole of the coalescing rule.
    history.commit();
  });
}

// --------------------------------------------------- the keyframe controls

// One per look parameter, stamped from the registry the same way the sliders are.
// View parameters deliberately get none: render scale and auto-orbit are not part
// of the clip, so there is nothing there to key and a control implying otherwise
// would be the split leaking.
const keyButtons = new Map();

function makeKeyButton(name) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'kf';
  btn.setAttribute('aria-label', `${name} keyframe`);
  btn.appendChild(document.createElement('i'));
  btn.addEventListener('click', () => toggleKey(name));
  keyButtons.set(name, btn);
  return btn;
}

function paintKeyButton(name, btn) {
  const track = tracks.get(name);
  const state = !track || track.keys.length === 0
    ? 'none'
    : (track.keyAt(playheadSec(), keyTolerance()) ? 'here' : 'some');
  btn.dataset.kf = state;
}

for (const name of params.names('look')) {
  const el = panelControls.get(name);
  const btn = makeKeyButton(name);
  if (el.type === 'checkbox') {
    // The control is the whole `<label class="check">`, and a button inside a
    // label would toggle the checkbox when clicked, so the two become siblings in
    // a row rather than the button being appended into it.
    const label = el.parentElement;
    const row = document.createElement('div');
    row.className = 'checkrow';
    label.replaceWith(row);
    row.append(label, btn);
  } else {
    el.parentElement.appendChild(btn);
  }
  btn.dataset.kf = 'none';
}

// The retime's own key control, beside the speed slider rather than in a lane,
// because the lane only exists once there is a curve to draw in it.
ui.rateKey.addEventListener('click', () => {
  if (!timeline) return;
  const t = playheadSec();
  const tol = keyTolerance();
  const existing = retime.keys.find((k) => Math.abs(k.t - t) <= tol);
  // **Known gap, carried deliberately.** Removing the origin key from a curve with
  // three or more keys leaves a first key that is not at program 0, so the head of
  // the edit falls back to the extrapolation rule the origin exists to remove.
  // Nothing renders wrong - the curve is still monotonic and still evaluable - but
  // the clip's first frame starts reading from a source time nobody chose. The fix
  // is to refuse to remove the origin while anything sits after it.
  if (existing && retime.keys.length > 1) {
    retime.keys.splice(retime.keys.indexOf(existing), 1);
    // The origin key is only meaningful with something after it.
    if (retime.keys.length === 1 && retime.keys[0].t === 0) retime.keys.length = 0;
  } else if (!existing) {
    // The source time the curve already maps to, so planting a key never moves the
    // image. The origin comes with the first one, which is what keeps the curve
    // anchored at the head of the edit rather than at an extrapolation.
    if (retime.keys.length === 0 && t > 0) {
      retime.keys.push({
        t: 0, value: retime.sourceSecAt(0),
        easeOut: [...EASE_OUT_LINEAR], easeIn: [...EASE_IN_LINEAR],
      });
    }
    retime.keys.push({
      t, value: retime.sourceSecAt(t),
      easeOut: [...EASE_OUT_LINEAR], easeIn: [...EASE_IN_LINEAR],
    });
    retime.keys.sort((x, y) => x.t - y.t);
  }
  timingChanged();
  requestRepaint();
  history.commit();
});

function paintRateKey() {
  const t = playheadSec();
  const tol = keyTolerance();
  ui.rateKey.dataset.kf = retime.keys.length === 0
    ? 'none'
    : (retime.keys.some((k) => Math.abs(k.t - t) <= tol) ? 'here' : 'some');
}

// --------------------------------------------- composition in the world

// A camera move is the one thing you cannot judge from a graph. Editing
// `position.x` as a curve while the actual question is where it flies through the
// room is the classic mistake, so the path draws in the view and in a top-down
// orthographic, and its keys are nodes you drag in space.
//
// **None of it is drawn into the rendered frame, and that is load-bearing rather
// than tidy.** The first version of this scissored a top-down into a corner of the
// same canvas, and it broke the step 4 check that ties a program position to the
// bytes of one capture frame: one arm renders through the transport and the other
// pushes a frame's depth straight into the texture, so the arm that painted
// carried furniture the arm that did not could never have. That is the general
// case rather than an accident of one check - `renderProgramFrame` is what an
// export hashes and what every equality in this repo compares, and chrome is not
// the frame. So the furniture lives on a 2D canvas of its own, over the stage,
// and the rendered image underneath is exactly what it was.
//
// The plan view then costs no readback either. The current depth frame is already
// on the CPU - `bindDepth` copies it into the DataTexture's own array - so the
// top-down projects that directly, subsampled, using the same intrinsics the
// shader unprojects with. A scatter is also the honest thing for a plan view to
// be: it answers where the subject is standing, and a wake or a bloom is not a
// place.

const chromeCanvas = document.createElement('canvas');
chromeCanvas.id = 'chrome';
chromeCanvas.hidden = true;
document.body.appendChild(chromeCanvas);
const chromeCtx = chromeCanvas.getContext('2d');

const INSET = { w: 176, h: 118, margin: 8 };
// Metres across the plan view's shorter axis.
const TOP_SPAN = 7;
// Centred a little deeper than the orbit target, so the sensor at the origin sits
// inside the frame rather than on its edge - the plan is unreadable without it,
// because everything in it is a distance from there.
const TOP_CENTRE = { x: 0, z: -2.6 };
// Every fourth pixel each way, so the plan is thirteen thousand points rather than
// two hundred and seventeen thousand. At a hundred and eighteen pixels tall the
// rest would land on top of each other anyway, and this runs on the main thread on
// every paint.
const PLAN_STRIDE = 4;
const FRUSTUM_LEN = 0.55;

// Whether the furniture is on screen at all. Off in the live viewer, because there
// is no clip there to compose.
let chromeOn = false;
// Whether anything has rendered since the furniture was last drawn, so a paint
// that produced no image does not redraw a path over a frame that never changed.
let chromeStale = false;

const scratchVec = new THREE.Vector3();

function stageSize() {
  const size = renderer.getSize(new THREE.Vector2());
  return { w: size.x, h: size.y };
}

function insetRect() {
  const { w, h } = stageSize();
  return { x: w - INSET.w - INSET.margin, y: INSET.margin, w: INSET.w, h: INSET.h, stage: { w, h } };
}

function cameraKeys() {
  const track = tracks.get('camera');
  return track ? track.keys : [];
}

/** World x/z to a point in the plan view, and back. Screen up is deeper into the room. */
function planScale(rect) { return rect.h / TOP_SPAN; }

function planPoint(rect, x, z) {
  const s = planScale(rect);
  return {
    x: rect.x + rect.w / 2 + (x - TOP_CENTRE.x) * s,
    y: rect.y + rect.h / 2 + (z - TOP_CENTRE.z) * s,
  };
}

function planWorld(rect, px, py) {
  const s = planScale(rect);
  return {
    x: TOP_CENTRE.x + (px - rect.x - rect.w / 2) / s,
    z: TOP_CENTRE.z + (py - rect.y - rect.h / 2) / s,
  };
}

/** A point projected through a perspective camera into stage pixels, or null behind it. */
function projectThrough(position, camera, rect) {
  scratchVec.fromArray(position).project(camera);
  // `project` divides by w, and w is negative behind the camera - which flips the
  // sign and puts a point that is behind you on screen in front of you. z outside
  // the unit cube is the readable form of that test.
  if (scratchVec.z < -1 || scratchVec.z > 1) return null;
  return {
    x: rect.x + ((scratchVec.x + 1) / 2) * rect.w,
    y: rect.y + ((1 - scratchVec.y) / 2) * rect.h,
    z: scratchVec.z,
  };
}

/** The sampled camera path, in world space. Empty below two keys - a point is not a path. */
const PATH_SAMPLES = 120;

function pathPoints() {
  const keys = cameraKeys();
  if (keys.length < 2) return [];
  const from = keys[0].t;
  const to = keys[keys.length - 1].t;
  const out = [];
  for (let i = 0; i < PATH_SAMPLES; i++) {
    out.push(poseAt(keys, from + ((to - from) * i) / (PATH_SAMPLES - 1)).position);
  }
  return out;
}

/**
 * The program camera's frustum as world-space segments. Read off the camera the
 * registry posed rather than off the track, so what is drawn is what would be
 * rendered - including a clip with no keys at all, whose pose is a single value.
 */
function frustumSegments() {
  programCamera.updateMatrixWorld(true);
  const half = Math.tan((programCamera.fov * Math.PI) / 360) * FRUSTUM_LEN;
  const wide = half * programCamera.aspect;
  const corners = [[-wide, -half], [wide, -half], [wide, half], [-wide, half]].map(([x, y]) => scratchVec
    .set(x, y, -FRUSTUM_LEN).applyMatrix4(programCamera.matrixWorld).toArray());
  const apex = programCamera.position.toArray();
  const segments = corners.map((corner) => [apex, corner]);
  for (let i = 0; i < 4; i++) segments.push([corners[i], corners[(i + 1) % 4]]);
  return segments;
}

function strokePolyline(points) {
  let started = false;
  chromeCtx.beginPath();
  for (const p of points) {
    if (!p) { started = false; continue; }
    if (started) chromeCtx.lineTo(p.x, p.y);
    else chromeCtx.moveTo(p.x, p.y);
    started = true;
  }
  chromeCtx.stroke();
}

function drawNodes(project) {
  const keys = cameraKeys();
  keys.forEach((key, i) => {
    const p = project(key.value.position);
    if (!p) return;
    chromeCtx.beginPath();
    chromeCtx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    chromeCtx.fillStyle = '#0d1014';
    chromeCtx.fill();
    chromeCtx.strokeStyle = selection && selection.owner === 'camera' && cameraKeys()[i] === selection.key
      ? '#e8ecf1' : '#5ad1c4';
    chromeCtx.lineWidth = 1.4;
    chromeCtx.stroke();
  });
}

/** The point cloud from above, straight off the depth texture's own array. */
function drawPlanCloud(rect) {
  const depth = depthCurr.image.data;
  const fx = uniforms.focal.value.x;
  const cx = uniforms.center.value.x;
  const near = uniforms.nearClip.value;
  const far = uniforms.farClip.value;
  const s = planScale(rect);
  chromeCtx.fillStyle = 'rgba(232, 236, 241, 0.55)';
  for (let row = 0; row < DH; row += PLAN_STRIDE) {
    for (let col = 0; col < DW; col += PLAN_STRIDE) {
      const mm = depth[row * DW + col];
      if (mm === 0) continue;
      const z = mm * 0.001;
      if (z < near || z > far) continue;
      // libfreenect2's pinhole model, the same one the vertex shader unprojects
      // with, and reading the same two uniforms so there is one set of intrinsics
      // rather than two that can drift.
      const wx = ((col + 0.5 - cx) / fx) * z;
      const px = rect.x + rect.w / 2 + (wx - TOP_CENTRE.x) * s;
      const py = rect.y + rect.h / 2 + (-z - TOP_CENTRE.z) * s;
      if (px < rect.x || px > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) continue;
      chromeCtx.fillRect(px, py, 1, 1);
    }
  }
}

function drawChrome() {
  if (!chromeOn || !chromeStale) return;
  chromeStale = false;
  const { w, h } = stageSize();
  const dpr = Math.min(devicePixelRatio, 2);
  if (chromeCanvas.width !== Math.round(w * dpr) || chromeCanvas.height !== Math.round(h * dpr)) {
    chromeCanvas.width = Math.round(w * dpr);
    chromeCanvas.height = Math.round(h * dpr);
  }
  chromeCanvas.style.width = `${w}px`;
  chromeCanvas.style.height = `${h}px`;
  // Onto the letterboxed stage rather than the window's corner, so the path, the
  // nodes and the frustum land on the pixels they annotate.
  chromeCanvas.style.left = `${stageBox.left}px`;
  chromeCanvas.style.top = `${stageBox.top}px`;
  chromeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  chromeCtx.clearRect(0, 0, w, h);

  const stage = { x: 0, y: 0, w, h };
  const path = pathPoints();

  // ── over the picture: the path, its nodes and the shot the program camera has.
  chromeCtx.lineWidth = 1.4;
  chromeCtx.strokeStyle = 'rgba(90, 209, 196, 0.85)';
  strokePolyline(path.map((p) => projectThrough(p, viewCamera, stage)));
  chromeCtx.strokeStyle = 'rgba(255, 157, 90, 0.9)';
  chromeCtx.lineWidth = 1;
  for (const [a, b] of frustumSegments()) {
    strokePolyline([projectThrough(a, viewCamera, stage), projectThrough(b, viewCamera, stage)]);
  }
  drawNodes((p) => projectThrough(p, viewCamera, stage));

  // ── the top-down. A camera move is the one thing you cannot judge from inside
  // the camera, so this is where the path is actually edited.
  const rect = insetRect();
  chromeCtx.save();
  chromeCtx.beginPath();
  chromeCtx.rect(rect.x, rect.y, rect.w, rect.h);
  chromeCtx.fillStyle = 'rgba(13, 16, 20, 0.92)';
  chromeCtx.fill();
  chromeCtx.clip();

  // Range rings a metre apart, so the plan reads as distances rather than as a
  // picture that happens to be small.
  chromeCtx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
  chromeCtx.lineWidth = 1;
  const origin = planPoint(rect, 0, 0);
  for (let m = 1; m <= 6; m++) {
    chromeCtx.beginPath();
    chromeCtx.arc(origin.x, origin.y, m * planScale(rect), Math.PI, 2 * Math.PI);
    chromeCtx.stroke();
  }

  drawPlanCloud(rect);

  chromeCtx.strokeStyle = 'rgba(90, 209, 196, 0.9)';
  chromeCtx.lineWidth = 1.4;
  strokePolyline(path.map((p) => planPoint(rect, p[0], p[2])));
  chromeCtx.strokeStyle = 'rgba(255, 157, 90, 0.9)';
  chromeCtx.lineWidth = 1;
  for (const [a, b] of frustumSegments()) {
    strokePolyline([planPoint(rect, a[0], a[2]), planPoint(rect, b[0], b[2])]);
  }
  drawNodes((p) => planPoint(rect, p[0], p[2]));

  // The sensor itself, because every distance in this view is measured from it.
  chromeCtx.fillStyle = '#e8ecf1';
  chromeCtx.fillRect(origin.x - 3, origin.y - 1.5, 6, 3);

  chromeCtx.restore();
  chromeCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  chromeCtx.lineWidth = 1;
  chromeCtx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  chromeCtx.fillStyle = '#6d7683';
  chromeCtx.font = '9px ui-monospace, Menlo, monospace';
  chromeCtx.fillText('TOP-DOWN', rect.x + 5, rect.y + rect.h - 5);
}

function placeChrome() {
  chromeCanvas.hidden = !chromeOn;
  if (!chromeOn) return;
  chromeStale = true;
  drawChrome();
}
addEventListener('resize', placeChrome);

// ------------------------------------------------ dragging a node in space

// Hit-testing by projecting each node to the screen rather than by raycasting.
// The same code then serves both views - the plan is a second projection of the
// same four points - and a raycaster would need a camera the plan view does not
// have, since it is drawn on a 2D canvas rather than by the renderer.
const NODE_GRAB_PX = 9;

/** Where a node lands, in stage pixels, in whichever view is asked for. */
function nodeScreenPoint(position, plan) {
  if (plan) {
    const rect = insetRect();
    return planPoint(rect, position[0], position[2]);
  }
  return projectThrough(position, viewCamera, { x: 0, y: 0, ...stageSize() });
}

/** Which view a pointer is in. The plan wins where they overlap - it is on top. */
function viewUnder(clientX, clientY) {
  const canvas = renderer.domElement.getBoundingClientRect();
  const x = clientX - canvas.left;
  const y = clientY - canvas.top;
  if (x < 0 || y < 0 || x > canvas.width || y > canvas.height) return null;
  const inset = insetRect();
  const plan = x >= inset.x && x <= inset.x + inset.w && y >= inset.y && y <= inset.y + inset.h;
  return { plan, x, y };
}

function nodeUnder(view) {
  let best = null;
  cameraKeys().forEach((key, i) => {
    const p = nodeScreenPoint(key.value.position, view.plan);
    if (!p) return;
    const d = Math.hypot(p.x - view.x, p.y - view.y);
    if (d <= NODE_GRAB_PX && (!best || d < best.d)) best = { key, i, d, depth: p.z ?? 0 };
  });
  return best;
}

let nodeDrag = null;

// Captured on the window rather than on the canvas, and this is the one part of
// the gesture that is not obvious. OrbitControls listens on the canvas too, and
// two listeners on the same element fire in registration order whatever their
// capture flag says - so a canvas-level listener could not stop the controls from
// also seeing the press, and the node would move while the view orbited under it.
// Catching the event a level up is what makes `stopPropagation` mean anything.
addEventListener('pointerdown', (e) => {
  if (!chromeOn || e.target !== renderer.domElement) return;
  const view = viewUnder(e.clientX, e.clientY);
  if (!view) return;
  const hit = nodeUnder(view);
  if (!hit) return;
  e.preventDefault();
  e.stopPropagation();
  renderer.domElement.setPointerCapture(e.pointerId);
  controls.enabled = false;
  selection = { owner: 'camera', key: hit.key };
  nodeDrag = { plan: view.plan, hit, pointerId: e.pointerId };
}, true);

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!nodeDrag) return;
  const canvas = renderer.domElement.getBoundingClientRect();
  const x = e.clientX - canvas.left;
  const y = e.clientY - canvas.top;
  const p = nodeDrag.hit.key.value.position;
  // The plan view moves a node across the floor and leaves its height alone,
  // because a top-down drag says nothing about height and inventing one from it
  // would silently drop the camera every time a path was tidied up. The 3D view
  // moves it in the plane it is already in, facing the viewer, which is the only
  // unambiguous reading one pointer has there.
  if (nodeDrag.plan) {
    const world = planWorld(insetRect(), x, y);
    p[0] = world.x;
    p[2] = world.z;
  } else {
    const size = stageSize();
    scratchVec.set((x / size.w) * 2 - 1, 1 - (y / size.h) * 2, nodeDrag.hit.depth).unproject(viewCamera);
    p[0] = scratchVec.x;
    p[1] = scratchVec.y;
    p[2] = scratchVec.z;
  }
  requestRepaint();
});

for (const type of ['pointerup', 'pointercancel']) {
  renderer.domElement.addEventListener(type, () => {
    if (!nodeDrag) return;
    nodeDrag = null;
    controls.enabled = viewCamera === freeCamera;
    history.commit();
  });
}

ui.camKey.addEventListener('click', () => {
  if (!timeline) return;
  const track = trackFor('camera');
  // The pose you are looking from, which is what makes orbiting to a shot and
  // keying it one gesture. The free camera is navigation everywhere else in this
  // design; here it is the viewfinder, and the copy is one-way.
  freeCamera.updateMatrixWorld(true);
  track.setKey(playheadSec(), {
    position: freeCamera.position.toArray(),
    quaternion: freeCamera.quaternion.toArray(),
    fov: freeCamera.fov,
  }, keyTolerance());
  lanesChanged();
  requestRepaint();
  history.commit();
});

ui.camClear.addEventListener('click', () => {
  const track = tracks.get('camera');
  const key = track?.keyAt(playheadSec(), keyTolerance());
  if (!key) return;
  track.removeKey(key);
  dropTrackIfEmpty('camera');
  lanesChanged();
  requestRepaint();
  history.commit();
});

// The export control: one size and one button. What is exported is the clip, at
// the output rate the timeline is already set to, through the program camera -
// which frames, which codec and where the file goes are the job queue's questions
// rather than this one's, and inventing a dialog for them here would be inventing
// the answers too.
ui.exportGo.addEventListener('click', async () => {
  if (exporting) return;
  const [width, height] = ui.exportSize.value.split('x').map(Number);
  ui.exportGo.disabled = true;
  sayExport(`export ${width}x${height} starting`);
  try {
    const done = await exportClip({
      width,
      height,
      onProgress: (n, total) => {
        sayExport(`export ${Math.round((n / total) * 100)}% · frame ${n}/${total}`);
      },
    });
    sayExport(`${done.output} · ${done.frames} frames · ${(done.bytes / 1e6).toFixed(1)} MB `
      + `in ${(done.elapsedMs / 1000).toFixed(1)}s`);
  } catch (err) {
    sayExport(`export failed: ${err.message}`);
    showTimelineError(err);
  } finally {
    ui.exportGo.disabled = false;
  }
});

// ------------------------------------------------- the library controls in the editor

// Changing the export size reframes the editor, because the point of letterboxing
// the stage is that the two are never allowed to disagree.
ui.exportSize.addEventListener('change', () => setTargetSize(ui.exportSize.value));
setTargetSize(DEFAULT_EXPORT_SIZE, { fromDocument: true });

ui.mark.addEventListener('click', () => { markHere().catch(showTimelineError); });

ui.presetApply.addEventListener('click', async () => {
  const name = ui.preset.value;
  if (!name) return;
  try {
    applyStoredPreset(await (await fetch(`/presets/${encodeURIComponent(name)}`)).json());
    ui.note.textContent = `applied ${name} · ${appliedPreset.rev.slice(7, 15)}`;
  } catch (err) {
    showTimelineError(err);
  }
});

ui.presetSave.addEventListener('click', async () => {
  // Named by the user, because a preset library whose entries are called
  // "preset 3" is a library nobody uses twice.
  const name = prompt('save this look as', appliedPreset?.name ?? 'look-1');
  if (!name) return;
  try {
    const res = await fetch(`/presets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(presetFromCurrentLook()),
    });
    const saved = await res.json();
    if (saved.error) throw new Error(saved.error);
    // Saving stamps the clip too. The look on screen genuinely is that revision of
    // that preset, and leaving the stamp on whatever was applied before would have
    // the provenance say a look this clip no longer has.
    appliedPreset = { name: saved.name, rev: saved.rev };
    await refreshPresets();
    ui.note.textContent = `saved ${saved.name} · ${saved.rev.slice(7, 15)}`;
    history.commit();
  } catch (err) {
    showTimelineError(err);
  }
});

ui.projectSave.addEventListener('click', async () => {
  const name = prompt('save this edit as', ui.project.value || `${openTakeId ?? 'clip'}-edit`);
  if (!name) return;
  try {
    // The take is named by content hash rather than by path, which is what makes a
    // project a self-contained render job and what catches a capture that was
    // truncated, re-recorded or swapped underneath an edit. A path cannot do
    // either.
    const body = { ...serialiseProject(), take: { id: openTakeId, hash: openTakeHash } };
    const res = await fetch(`/projects/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const saved = await res.json();
    if (saved.error) throw new Error(saved.error);
    await refreshProjects();
    ui.project.value = saved.name;
    ui.note.textContent = `saved ${saved.name} · ${saved.bytes} bytes`;
  } catch (err) {
    showTimelineError(err);
  }
});

ui.projectOpen.addEventListener('click', async () => {
  const name = ui.project.value;
  if (!name) return;
  try {
    await loadProjectNamed(name);
  } catch (err) {
    showTimelineError(err);
  }
});

/**
 * Loads a project file onto the open take. This is the untrusted door: everything
 * before now came from a state this page had already vetted, and a file has not.
 *
 * The take is checked by hash before the document is applied. A project that names
 * different footage renders somebody else's edit over this take and looks entirely
 * plausible doing it, and a project whose take was re-recorded under the same name
 * is the same failure with nobody to blame - which is exactly what hash-referencing
 * the capture was for.
 *
 * Playback is stopped across the restore for the reason undo stops it: the
 * accumulators walk forward one source frame at a time and cannot be walked back,
 * so a retime curve swapped underneath a running playhead asks the source to go
 * backwards on the very next step, from inside the animation loop.
 */
async function loadProjectNamed(name) {
  const doc = await (await fetch(`/projects/${encodeURIComponent(name)}`)).json();
  if (doc.error) throw new Error(doc.error);
  const take = doc.body.take;
  if (take && openTakeHash && take.hash && take.hash !== openTakeHash) {
    throw new Error(
      `project ${name} was built on ${take.id} (${take.hash.slice(0, 22)}…) and the open take `
      + `hashes ${openTakeHash.slice(0, 22)}…: this is different footage, so the edit would `
      + 'render against material it was never authored against',
    );
  }
  const resume = timeline ? timeline.playing : false;
  if (resume) timeline.pause();
  restoreProject(doc.body);
  // The stack restarts from the loaded document rather than keeping the previous
  // clip's history. Undoing across a project load would walk back into an edit of
  // something else, which is the shape of undo people learn not to trust.
  history.begin();
  await timeline.seek(timeline.programSec);
  if (resume) timeline.play();
  ui.project.value = name;
  ui.note.textContent = `opened ${name}`;
  return doc;
}

// ------------------------------------------------------------- the recorder surface

// Record, mark and remaining time - the load-bearing four-fifths of a shooting
// surface. It is on the live viewer and nowhere else: a clip on the timeline has
// nothing to record, and the two transports are exclusive for the same reason.
//
// The control is an HTTP call and the *state* comes back on the socket every
// monitor is already listening to, which keeps the property the spec asks for -
// a phone watching a capture node can start the take it is watching and press
// mark, and every other monitor sees the recording state change.
let recordState = { armed: false, recording: false, takeId: null, startedAt: null };

function paintRecord(storage) {
  if (!ui.recGo) return;
  const rec = recordState.recording;
  // A server that cannot record at all says so on the button rather than offering
  // one that fails when pressed. The replay server is the case, and it is one click
  // away in the setup this repo documents: before this the button was unconditional,
  // and pressing it on a replay opened a take, threw on every frame, and took the
  // live stream down while `/record/state` went on reporting a healthy recording.
  const blocked = recordState.cannotRecord ?? null;
  ui.recGo.disabled = Boolean(blocked);
  ui.recGo.title = blocked ?? '';
  ui.recGo.textContent = rec ? 'stop' : 'record';
  ui.recGo.setAttribute('aria-pressed', String(rec));
  ui.recMark.disabled = !rec;
  // Said before the button is pressed rather than only in the 409 it would answer.
  // The refusal exists so a full-rate monitor cannot quietly cost the take frames,
  // and an operator who only learns that from an error in the second they were
  // trying to roll has been told too late to do anything with it.
  const costly = recordState.monitors?.costingTheTake ?? [];
  const monitorWarning = !rec && costly.length
    ? `${costly.length} monitor${costly.length > 1 ? 's are' : ' is'} watching over the network at `
      + `${costly.map((m) => `÷${m.divisor} ×${m.stride}`).join(', ')} - a take will refuse to start until `
      + `they are at ÷${recordState.monitors.cap.divisor} ×${recordState.monitors.cap.stride} or coarser`
    : null;
  ui.recNote.textContent = blocked ?? monitorWarning ?? (rec
    ? `${recordState.takeId} · ${recordState.frames} frames`
      + (recordState.dropped ? ` · ${recordState.dropped} dropped to a slow disk` : '')
    : (recordState.armed ? 'armed, waiting for the sensor' : 'not recording'));
  if (storage) {
    // A directory that is not there is a different problem from one that is full,
    // and the operator gets the sentence rather than the errno that used to arrive
    // here raw.
    ui.recSpace.textContent = storage.error ?? `${storage.label} left at current settings`;
    // The warning is load-bearing rather than polish: with manual-only deletion the
    // card genuinely fills, and unattended the failure lands mid-shoot.
    ui.recSpace.classList.toggle('low', Boolean(storage.error) || storage.secondsLeft < 15 * 60);
  }
}

async function pollRecord() {
  try {
    const state = await (await fetch('/record/state')).json();
    recordState = state;
    paintRecord(state.storage);
  } catch { /* a server that went away is the status line's problem, not this one's */ }
}

if (ui.recGo) {
  ui.recGo.addEventListener('click', async () => {
    ui.recGo.disabled = true;
    try {
      // The content type is not decoration: a route that changes something refuses
      // a request that does not declare JSON, because that declaration is the one
      // thing a page you merely visit cannot make without asking permission first.
      const res = await fetch(recordState.recording || recordState.armed ? '/record/stop' : '/record/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const body = await res.json();
      if (body.error) ui.recNote.textContent = body.error;
    } finally {
      ui.recGo.disabled = false;
      await pollRecord();
    }
  });
  ui.recMark.addEventListener('click', async () => {
    const body = await (await fetch('/record/mark', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })).json();
    ui.recNote.textContent = body.error ?? `${body.label} at ${(body.sourceMs / 1000).toFixed(1)}s`;
  });
  ui.toLibrary.addEventListener('click', () => { location.href = '/library.html'; });
}

ui.camView.addEventListener('click', () => {
  const program = viewCamera === freeCamera;
  setViewCamera(program ? programCamera : freeCamera);
  ui.camView.setAttribute('aria-pressed', String(program));
  requestRepaint();
});

/**
 * Opens a take on the timeline. The live socket is never opened on this path.
 *
 * The intrinsics come from the take rather than from a socket, and that is the
 * whole reason this function fetches twice. `uniforms.focal` and `uniforms.center`
 * used to arrive only in the hello the grabber sends over the WebSocket, so a page
 * opened on a take unprojected every point on the defaults baked into the uniform
 * block - fx 366, fy 366, cx 256, cy 212 against this sensor's own 366.031494 and
 * cx 257.775909, cy 206.784195. That is about 45mm of error at three metres,
 * scaling with depth, and nothing on screen could ever have shown it: the error is
 * a near-uniform translation, so both arms of every comparison in this repo were
 * wrong in exactly the same way and agreed. Step 2's scan already recorded where
 * the hello sits in the file, so this is one positioned read.
 *
 * A take with no hello is refused rather than opened on the defaults. The whole
 * point of the fetch is that geometry nobody can check must not be baked into an
 * export, and "we do not know this sensor's intrinsics" is exactly that case.
 *
 * The live socket writes the same two uniforms without this gate, and that is the
 * right place for the asymmetry rather than an omission: a live preview bakes
 * nothing, and a hello the sensor sent badly is recorded into the capture along
 * with everything else, so the file is where it becomes permanent and opening the
 * file is where it gets refused.
 */
// The open take's content hash, which is how a project names its footage. Read off
// the index the source already fetched rather than recomputed, because rehashing
// gigabytes on every project save is exactly what step 2's design refuses.
let openTakeHash = null;

async function openTake(id) {
  const source = await IndexedPairSource.open(id);
  const res = await fetch(`/capture/${encodeURIComponent(id)}/hello`);
  if (!res.ok) {
    throw new Error(
      `take ${id} carries no sensor hello (${res.status}): its intrinsics are unknown, and `
      + 'unprojecting it on the boot defaults would put every point out by tens of millimetres '
      + 'with nothing on screen to show it',
    );
  }
  const hello = await res.json();
  // Positive rather than finite, and inside the frame rather than merely a number.
  // `Number.isFinite(0)` is true, so a hello carrying `fx: 0` - the shape a writer
  // that recorded a field it never filled produces - passed a refusal written to
  // stop exactly this: every pixel unprojects through a division by zero, and a
  // negative focal mirrors the cloud through the optical axis. Both are geometry
  // nobody can check, which is the case this gate exists for rather than a corner
  // of it.
  //
  // The centre is bounded by the depth grid this page is about to index rather
  // than by a range invented here: `pixel` runs over DWxDH in the vertex shader,
  // so a principal point outside it puts the optical axis off the sensor, which is
  // a transposed or unit-confused record rather than an unusual camera. The bound
  // is deliberately not tight - a real cx sits near the middle - because a
  // plausible-but-wrong centre is a translation no bound can distinguish from a
  // correct one, and pretending otherwise would be a threshold with no method
  // behind it.
  const usable = hello.fx > 0 && hello.fy > 0
    && hello.cx > 0 && hello.cx < DW
    && hello.cy > 0 && hello.cy < DH;
  if (!usable) {
    throw new Error(
      `take ${id} has an unusable hello: ${JSON.stringify(hello)} - focal lengths must be `
      + `positive and the centre must lie inside the ${DW}x${DH} depth frame`,
    );
  }
  uniforms.focal.value.set(hello.fx, hello.fy);
  uniforms.center.value.set(hello.cx, hello.cy);
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
  ui.cameraGroup.hidden = false;
  // The path, its nodes and the top-down go on with the timeline and only with it.
  // A live viewer has no clip to compose and the pinned drive hashes images, so
  // furniture in either would be furniture nobody asked for in pixels somebody is
  // comparing.
  chromeOn = true;
  placeChrome();
  openTakeId = id;
  openTakeHash = source.index.hash;
  // Awaited, so the first paint of the ruler already has the ticks on it. A take
  // whose marks arrived a frame later would show them appearing, which reads as
  // the page finding them rather than the take having them.
  await loadMarks(id);
  await refreshPresets().catch(() => {});
  await refreshProjects().catch(() => {});
  timingChanged();
  // The stack starts from whatever the clip already is, so the first undo has
  // somewhere honest to land rather than an empty document.
  history.begin();
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
  // The remaining-time readout, on the surface an operator is actually looking at.
  // Polled rather than pushed because free space changes on its own - another
  // process writing, a card filling - and a number that only moved when the
  // recorder did would be stale in the one direction that matters.
  pollRecord();
  setInterval(pollRecord, 5000);
}

// Handles for profiling and for poking at the scene from the console.
globalThis.__kinect = {
  renderer, composer, scene, freeCamera, programCamera, controls, uniforms, material,
  bloom, afterimage, grade, geometry, resetAccumulators, renderProgramFrame,

  // The sizes the export menu offers, and the way to adopt one.
  //
  // **Exposed so a proof tool sweeps the sizes the product ships rather than a list
  // of its own.** That is the step 6 hole written as an interface: `export-check` had
  // four arms that were all 1.6 while this menu had four that were all 16:9, so a
  // build referring to the width was bit-identical on every arm and 11.1% wrong on
  // every size a user could pick. A tool reading this cannot drift from the menu,
  // because it is the menu.
  //
  // `setTargetSize` is here for the same reason the editor letterboxes: the stage's
  // shape is the export's shape now, so a tool asking for a stage of some size has to
  // say which shape it means rather than assuming the window decides.
  exportSizes: () => EXPORT_SIZES.flatMap((g) => g.sizes.map(([w, h]) => ({ ratio: g.ratio, w, h }))),
  setTargetSize: (text) => setTargetSize(text, { fromDocument: true }),
  targetSize: () => ({ ...targetSize }),

  // The registry and the two bulk writes a user gesture performs. All three refuse
  // while a frame is being evaluated, which now means exactly what it says: the
  // evaluator runs inside `renderProgramFrame`, so the flag spans it.
  params, applyPreset, setMode, presets: { BLACKWALL, NEUTRAL },
  mode: () => clipMode,

  /**
   * Keys, the curve and the undo stack. Every number a check reads comes from
   * here rather than from the DOM, because a lane is a view on a track the same
   * way a slider is a view on the registry - and asserting against the view would
   * pass on a page that drew the right diamonds over the wrong curve.
   */
  keyframes: {
    /** Writes a whole set of tracks at once. The keys are the tool's, not the page's. */
    setTracks(spec) {
      tracks.clear();
      for (const [name, keys] of Object.entries(spec)) {
        if (keys.length === 0) continue;
        const track = trackFor(name);
        track.keys = keys.map((k) => ({
          t: k.t,
          value: k.value,
          easeOut: [...(k.easeOut ?? EASE_OUT_LINEAR)],
          easeIn: [...(k.easeIn ?? EASE_IN_LINEAR)],
        }));
        track.sort();
      }
      lanesChanged();
    },
    setRetime({ rate = 1, keys = [] }) {
      retime.rate = rate;
      // Built first, then checked, then stored. The guard reads handles, so it has
      // to see the ones a key will actually have rather than the ones it arrived
      // with - a key written without them is linear, not handleless, and asking the
      // guard to know that would put the defaults in two places.
      const built = keys.map((k) => ({
        t: k.t,
        value: k.value,
        easeOut: [...(k.easeOut ?? EASE_OUT_LINEAR)],
        easeIn: [...(k.easeIn ?? EASE_IN_LINEAR)],
      }));
      retime.assertMonotonic(built);
      retime.keys = built;
      timingChanged();
    },
    /** What a track says at a program position, without rendering anything. */
    valueAt(name, t) { return tracks.get(name)?.valueAt(t) ?? null; },
    names() { return [...tracks.keys()]; },
    toggle: toggleKey,
    lanes: () => laneRows().map((r) => ({ owner: r.owner, kind: r.kind, keys: keysOf(r.owner).length })),
    project: serialiseProject,
    undo: {
      depth: () => history.depth,
      commit: () => history.commit(),
      pop: () => history.undo(),
      begin: () => history.begin(),
    },
    /** The furniture, so a check can prove it is out of the frame and not merely small. */
    chrome: {
      on: () => chromeOn,
      set(on) { chromeOn = on; placeChrome(); },
      inset: insetRect,
    },
    camera: {
      keys: () => cameraKeys().map((k) => ({ t: k.t, value: k.value })),
      /** Where a path node lands on screen, which is what a drag has to hit. */
      project(i, plan) { return nodeScreenPoint(cameraKeys()[i].value.position, plan); },
    },
  },
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
        overtaken: t.overtaken,
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

  /**
   * The library's half of the editor: the document version, the load path a
   * project file arrives through, the preset stamp, and the take's marks.
   *
   * `restoreProject` is exposed raw and deliberately. It is the door every refusal
   * this step added lives on, and a check that could only reach it through a
   * successful save-and-load could never hand it the malformed documents those
   * refusals exist for.
   */
  library: {
    PROJECT_VERSION,
    restoreProject,
    serialiseProject,
    loadProject: loadProjectNamed,
    applyStoredPreset,
    presetFromCurrentLook,
    appliedPreset: () => appliedPreset,
    marks: () => takeMarks.map((m) => ({ ...m })),
    markHere,
    takeId: () => openTakeId,
    takeHash: () => openTakeHash,
    /** Where each mark ticks on the ruler, as the page actually drew it. */
    markTicks: () => [...document.querySelectorAll('#tMarks .tmk')].map((el) => ({
      left: Number.parseFloat(el.style.left),
      beyond: el.classList.contains('beyond'),
    })),
  },

  // The export, and the two things a check has to be able to ask it: run one, and
  // find out whether one is running. `run` resolves with what the server said it
  // wrote - the output path, the frame count, and the hashes of the frames that
  // actually crossed the wire, which is the only view anything has of what left
  // the browser.
  export: {
    run: exportClip,
    running: () => exporting,
    rendererClass,
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
