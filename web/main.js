import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DW = 512;
const DH = 424;
const POINTS = DW * DH;

const statusEl = document.getElementById('status');

// ---------------------------------------------------------------- scene setup

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
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
controls.target.set(0, 0, -2.2);

// ---------------------------------------------------------------- gpu textures

// Depth arrives as raw millimetres; an integer texture keeps it exact so the
// vertex shader can unproject without any quantisation loss.
const depthTexture = new THREE.DataTexture(
  new Uint16Array(POINTS), DW, DH, THREE.RedIntegerFormat, THREE.UnsignedShortType,
);
depthTexture.internalFormat = 'R16UI';
depthTexture.minFilter = THREE.NearestFilter;
depthTexture.magFilter = THREE.NearestFilter;
depthTexture.generateMipmaps = false;
depthTexture.needsUpdate = true;

const colorTexture = new THREE.Texture();
colorTexture.colorSpace = THREE.SRGBColorSpace;
colorTexture.minFilter = THREE.LinearFilter;
colorTexture.magFilter = THREE.LinearFilter;
colorTexture.generateMipmaps = false;

// ---------------------------------------------------------------- point cloud

// One vertex per depth pixel; `position` carries the pixel coordinate and the
// shader turns it into a world position using the sensor's own intrinsics.
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
  depthMap: { value: depthTexture },
  colorMap: { value: colorTexture },
  focal: { value: new THREE.Vector2(366, 366) },
  center: { value: new THREE.Vector2(256, 212) },
  resolution: { value: new THREE.Vector2(DW, DH) },
  pointSize: { value: 4 },
  opacity: { value: 1 },
  exposure: { value: 1.15 },
  nearClip: { value: 0.5 },
  farClip: { value: 4.5 },
  warp: { value: 0 },
  warpSpeed: { value: 0.7 },
  time: { value: 0 },
  mode: { value: 0 },
  denoise: { value: 1 },
  edgeTol: { value: 120 },
  hasColor: { value: 0 },
};

const vertexShader = /* glsl */ `
precision highp float;
precision highp usampler2D;

uniform usampler2D depthMap;
uniform vec2 focal, center, resolution;
uniform float pointSize, nearClip, farClip, warp, warpSpeed, time, edgeTol;
uniform int denoise;

out vec2 vUv;
out float vDepth;
out vec3 vViewPos;
out float vEdge;

float depthAt(ivec2 p) {
  return float(texelFetch(depthMap, p, 0).r);
}

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
  float mm = depthAt(px);
  float z = mm * 0.001;

  // Neighbour spread doubles as a speckle test and an edge signal: isolated
  // points from dropped USB packets have no depth-consistent neighbours.
  float maxDiff = 0.0;
  int valid = 0;
  for (int i = 0; i < 4; i++) {
    ivec2 o = i == 0 ? ivec2(1, 0) : i == 1 ? ivec2(-1, 0) : i == 2 ? ivec2(0, 1) : ivec2(0, -1);
    ivec2 q = clamp(px + o, ivec2(0), ivec2(resolution) - 1);
    float n = depthAt(q);
    if (n > 0.0) {
      valid++;
      maxDiff = max(maxDiff, abs(n - mm));
    }
  }
  vEdge = clamp(maxDiff / edgeTol, 0.0, 1.0);

  bool speckle = denoise == 1 && (valid < 3 || maxDiff > edgeTol * 3.0);
  if (mm <= 0.0 || z < nearClip || z > farClip || speckle) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // behind the far plane: clipped away
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

  vUv = (position.xy + 0.5) / resolution;
  vDepth = z;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(1.0, pointSize * (1.0 / max(0.15, -mv.z)));
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D colorMap;
uniform float opacity, exposure, nearClip, farClip;
uniform int mode, hasColor;

in vec2 vUv;
in float vDepth;
in vec3 vViewPos;
in float vEdge;

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
  // Round, soft-edged sprites - square points look like a spreadsheet.
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float falloff = smoothstep(0.25, 0.02, r2);

  float t = clamp((vDepth - nearClip) / max(0.001, farClip - nearClip), 0.0, 1.0);
  vec3 rgb = hasColor == 1 ? texture(colorMap, vUv).rgb : vec3(0.7);
  vec3 col;
  float alpha = opacity;

  if (mode == 0) {
    col = rgb;
  } else if (mode == 1) {
    col = depthRamp(1.0 - t);
  } else if (mode == 2) {
    // Ghost: luminance shell that glows where the surface turns away.
    float lum = dot(rgb, vec3(0.299, 0.587, 0.114));
    float rim = pow(vEdge, 0.7);
    col = mix(vec3(0.20, 0.45, 0.75) * (0.35 + lum), vec3(0.75, 0.95, 1.0), rim);
    alpha *= 0.25 + 0.75 * rim + 0.25 * lum;
  } else {
    // Contour: bright bands sweeping through depth, dark between them.
    float bands = fract(vDepth * 12.0);
    float line = smoothstep(0.42, 0.5, bands) * smoothstep(0.58, 0.5, bands);
    col = mix(depthRamp(1.0 - t) * 0.18, vec3(1.0), line);
    alpha *= 0.15 + 0.85 * line;
  }

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

scene.add(new THREE.Points(geometry, material));

// ---------------------------------------------------------------- ui wiring

const bind = (id, uniformName, transform = (v) => v) => {
  const el = document.getElementById(id);
  const out = el.parentElement.querySelector('output');
  const apply = () => {
    const v = Number(el.value);
    uniforms[uniformName].value = transform(v);
    if (out) out.textContent = v;
  };
  el.addEventListener('input', apply);
  apply();
};

bind('pointSize', 'pointSize');
bind('opacity', 'opacity');
bind('exposure', 'exposure');
bind('near', 'nearClip');
bind('far', 'farClip');
bind('warp', 'warp');
bind('warpSpeed', 'warpSpeed');
bind('edgeTol', 'edgeTol');

document.getElementById('denoise').addEventListener('change', (e) => {
  uniforms.denoise.value = e.target.checked ? 1 : 0;
});

const spinEl = document.getElementById('spin');
spinEl.addEventListener('change', (e) => {
  controls.autoRotate = e.target.checked;
});
controls.autoRotateSpeed = 0.6;

document.querySelectorAll('#modes button').forEach((btn) => {
  btn.addEventListener('click', () => {
    uniforms.mode.value = Number(btn.dataset.mode);
    document.querySelectorAll('#modes button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b === btn));
    });
  });
});

addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'H') {
    const p = document.getElementById('panel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
  }
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- stream

const depthView = depthTexture.image.data;
let framesSeen = 0;
let lastFpsAt = performance.now();
let fps = 0;
let sensorLabel = '';
let decodeBusy = false;
let pendingColor = null;
let liveBitmap = null;

let sensorState = '';

function setStatus() {
  const rate = document.createElement('b');
  rate.textContent = fps.toFixed(0);
  const nodes = [
    document.createTextNode(sensorLabel),
    document.createElement('br'),
    rate,
    document.createTextNode(' fps'),
  ];
  if (sensorState) {
    const note = document.createElement('span');
    note.textContent = sensorState;
    note.style.color = '#e8a33d';
    nodes.push(document.createElement('br'), note);
  }
  statusEl.replaceChildren(...nodes);
}

// One decode in flight at a time; newer frames replace any queued one so the
// view always converges on the most recent image rather than lagging behind.
async function pumpColorDecode() {
  if (decodeBusy || !pendingColor) return;
  decodeBusy = true;
  const bytes = pendingColor;
  pendingColor = null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const previous = liveBitmap;
    colorTexture.image = bitmap;
    colorTexture.needsUpdate = true;
    liveBitmap = bitmap;
    uniforms.hasColor.value = 1;
    // Free the old bitmap only after the new one is bound.
    if (previous) previous.close();
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

  depthView.set(new Uint16Array(buffer, offset, depthBytes / 2));
  depthTexture.needsUpdate = true;

  if (colorBytes > 0) {
    pendingColor = new Uint8Array(buffer, offset + depthBytes, colorBytes);
    pumpColorDecode();
  }

  framesSeen++;
  const now = performance.now();
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

  ws.onopen = () => {
    sensorLabel = 'waiting for sensor…';
    setStatus();
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);

      if (msg.status) {
        sensorState = { live: '', starting: 'sensor starting…', lost: 'sensor lost — restarting' }[msg.status] ?? msg.status;
        if (msg.status !== 'live') fps = 0;
        setStatus();
        return;
      }

      const hello = msg;
      uniforms.focal.value.set(hello.fx, hello.fy);
      uniforms.center.value.set(hello.cx, hello.cy);
      if (!hello.color) uniforms.hasColor.value = 0;
      sensorLabel = `${hello.serial} · fw ${hello.firmware}`;
      setStatus();
      console.log('sensor intrinsics', hello);
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
  uniforms.time.value = clock.getElapsedTime();
  controls.update();
  renderer.render(scene, camera);
});
