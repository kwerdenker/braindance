// Bridges the native Kinect grabber to the browser: spawns (or replays) the
// framed binary stream and fans it out over WebSocket, while serving the viewer.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { MessageParser, TYPE_HELLO, TYPE_FRAME } from './protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const PORT = Number(flag('--port', '8080'));
const REPLAY = flag('--replay');
const RECORD = flag('--record');
// No fallback on purpose. Which depth processors exist is a property of the
// libfreenect2 this grabber was built against - macOS has OpenCL and no OpenGL,
// the Pi's V3D the reverse - and the grabber already picks the fastest one its
// own build contains. Defaulting to 'cl' here would hand the Pi a processor that
// is not compiled in, which the grabber now rejects rather than silently falling
// back, so the capture node would never start.
const PIPELINE = flag('--pipeline');
const NO_COLOR = has('--no-color');

// A browser that falls behind must never build a queue - a stale point cloud
// reads as "the Kinect is slow". Drop frames instead.
const MAX_BUFFERED = 4 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const WEB_DIR = join(ROOT, 'web');
const THREE_DIR = join(ROOT, 'node_modules/three');

// A bare startsWith would also match a sibling like `web-private`, so the
// separator has to be part of the comparison.
const isInside = (dir, candidate) => candidate === dir || candidate.startsWith(dir + sep);

const httpServer = createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

  let filePath;
  if (urlPath.startsWith('/vendor/three/')) {
    filePath = join(THREE_DIR, urlPath.slice('/vendor/three/'.length));
  } else {
    filePath = join(WEB_DIR, urlPath === '/' ? 'index.html' : urlPath);
  }

  const resolved = normalize(filePath);
  if (!isInside(WEB_DIR, resolved) && !isInside(THREE_DIR, resolved)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[extname(resolved)] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(resolved).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
});

const wss = new WebSocketServer({ server: httpServer });

let helloJson = null;
const stats = { frames: 0, dropped: 0, bytes: 0, since: Date.now() };

let sensorState = 'starting';

function broadcastText(text) {
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(text);
}

function setSensorState(state) {
  sensorState = state;
  broadcastText(JSON.stringify({ status: state }));
}

// Live camera settings the viewer can change. Colour on/off has to restart the
// grabber because it decides which streams the device is told to open at all;
// low light is a command the running grabber applies in place.
const camera = { color: !NO_COLOR, lowLight: true };
let applyCamera = null; // wired up by startLive; absent in replay

wss.on('connection', (ws) => {
  ws.binaryType = 'nodebuffer';
  console.log(`[server] client connected (${wss.clients.size} total)`);
  if (helloJson) ws.send(helloJson);
  ws.send(JSON.stringify({ status: sensorState }));
  ws.send(JSON.stringify({ camera }));
  ws.on('error', (err) => console.error('[server] socket error:', err.message));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return; // a client sending junk is not the server's problem
    }
    if (!msg || typeof msg.camera !== 'object' || !msg.camera) return;
    if (!applyCamera) return;

    const next = {
      color: typeof msg.camera.color === 'boolean' ? msg.camera.color : camera.color,
      lowLight: typeof msg.camera.lowLight === 'boolean' ? msg.camera.lowLight : camera.lowLight,
    };
    applyCamera(next);
  });
});

function broadcastFrame(payload) {
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      stats.dropped++;
      continue;
    }
    ws.send(payload);
  }
  stats.frames++;
  stats.bytes += payload.length;
}

function handleMessage(msg) {
  if (msg.type === TYPE_HELLO) {
    helloJson = msg.payload.toString('utf8');
    console.log(`[server] sensor: ${helloJson}`);
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(helloJson);
  } else if (msg.type === TYPE_FRAME) {
    broadcastFrame(msg.payload);
  }
}

setInterval(() => {
  const dt = (Date.now() - stats.since) / 1000;
  if (stats.frames === 0) return;
  const fps = (stats.frames / dt).toFixed(1);
  const mbs = (stats.bytes / dt / 1e6).toFixed(1);
  console.log(`[server] ${fps} fps  ${mbs} MB/s  dropped=${stats.dropped}  clients=${wss.clients.size}`);
  Object.assign(stats, { frames: 0, dropped: 0, bytes: 0, since: Date.now() });
}, 5000);

// The Kinect v2 drops off the bus under sustained load on a marginal USB link,
// so a dead grabber is an expected condition, not a fatal one. Respawn it.
const RESTART_DELAYS = [1000, 2000, 4000, 8000];

function startLive() {
  const bin = join(ROOT, 'native/build/grabber');
  const buildArgs = () => {
    const a = PIPELINE ? ['--pipeline', PIPELINE] : [];
    if (!camera.color) a.push('--no-color');
    if (!camera.lowLight) a.push('--no-low-light');
    return a;
  };

  const recorder = RECORD ? createWriteStream(RECORD) : null;
  if (recorder) console.log(`[server] recording to ${RECORD}`);

  let child = null;
  let attempt = 0;
  let shuttingDown = false;
  let restarting = false;

  const spawnGrabber = () => {
    const grabberArgs = buildArgs();
    console.log(`[server] starting grabber: ${bin} ${grabberArgs.join(' ')}`);
    setSensorState('starting');

    const parser = new MessageParser();
    // stdin is a pipe so settings that do not need a restart can be sent to the
    // running grabber instead of costing a multi-second device reopen.
    child = spawn(bin, grabberArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdin.on('error', () => { /* the grabber can exit mid-write */ });

    child.stdout.on('data', (chunk) => {
      if (recorder) recorder.write(chunk);
      try {
        for (const msg of parser.push(chunk)) {
          handleMessage(msg);
          if (msg.type === TYPE_HELLO) {
            attempt = 0; // a clean handshake means the link is healthy again
            setSensorState('live');
          }
        }
      } catch (err) {
        // A desynced stream is unrecoverable; restarting rebuilds the framing.
        console.error('[server]', err.message);
        child.kill('SIGTERM');
      }
    });

    child.on('exit', (code, signal) => {
      console.error(`[server] grabber exited (code=${code} signal=${signal})`);
      if (shuttingDown) return;
      if (restarting) {
        // Asked for, not a failure - so it does not count toward the backoff.
        restarting = false;
        setTimeout(spawnGrabber, 250);
        return;
      }
      setSensorState('lost');
      const delay = RESTART_DELAYS[Math.min(attempt, RESTART_DELAYS.length - 1)];
      attempt++;
      console.log(`[server] restarting grabber in ${delay}ms (attempt ${attempt})`);
      setTimeout(spawnGrabber, delay);
    });
  };

  applyCamera = (next) => {
    const needsRestart = next.color !== camera.color;
    const lowLightChanged = next.lowLight !== camera.lowLight;
    if (!needsRestart && !lowLightChanged) return;

    Object.assign(camera, next);
    broadcastText(JSON.stringify({ camera }));

    if (needsRestart) {
      console.log(`[server] colour camera ${camera.color ? 'on' : 'off'} - restarting grabber`);
      restarting = true;
      attempt = 0;
      child?.kill('SIGTERM');
      return;
    }
    // Colour off means there is no exposure to set, but the flag is still worth
    // remembering so it takes effect when colour comes back.
    if (camera.color) {
      console.log(`[server] low light ${camera.lowLight ? 'on' : 'off'}`);
      child?.stdin.write(`low-light ${camera.lowLight ? 'on' : 'off'}\n`);
    }
  };

  spawnGrabber();

  process.on('SIGINT', () => {
    shuttingDown = true;
    child?.kill('SIGTERM');
    recorder?.end();
    process.exit(0);
  });
}

function startReplay() {
  let raw;
  try {
    raw = readFileSync(REPLAY);
  } catch {
    console.error(`[server] no capture at ${REPLAY} — record one first: npm run record`);
    return;
  }

  console.log(`[server] replaying ${REPLAY}`);
  const parser = new MessageParser();
  const messages = [];
  for (const msg of parser.push(raw)) {
    // Detach from the parser's backing buffer so the array stays valid.
    messages.push({ type: msg.type, payload: Buffer.from(msg.payload) });
  }
  const hello = messages.find((m) => m.type === TYPE_HELLO);
  if (hello) handleMessage(hello);

  const frames = messages.filter((m) => m.type === TYPE_FRAME);
  if (frames.length === 0) {
    console.error('[server] replay file contains no frames');
    return;
  }
  // Replay the recorded arrival spacing rather than a uniform 30fps. A live
  // stream is deeply irregular - measured p50 64ms against p90 222ms - and
  // pacing every frame 33ms apart hands the viewer the one cadence that never
  // happens, so interpolation tuned against replay looks right here and stutters
  // on the sensor. Frame 0 anchors the loop; the gap after the last frame reuses
  // the median so the wrap does not stall.
  const stamps = frames.map((f) => Number(f.payload.readBigUInt64LE(8)));
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).filter((g) => g > 0 && g < 2000);
  const median = gaps.length ? gaps.slice().sort((a, b) => a - b)[gaps.length >> 1] : 33;
  gaps.push(median);

  console.log(`[server] ${frames.length} frames loaded, median gap ${median}ms`);

  let i = 0;
  const tick = () => {
    handleMessage(frames[i % frames.length]);
    const gap = gaps[i % gaps.length];
    i++;
    setTimeout(tick, gap);
  };
  tick();
}

httpServer.listen(PORT, () => {
  console.log(`[server] viewer on http://localhost:${PORT}`);
  if (REPLAY) startReplay();
  else startLive();
});
