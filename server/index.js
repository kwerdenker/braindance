// Bridges the native Kinect grabber to the browser: spawns (or replays) the
// framed binary stream and fans it out over WebSocket, while serving the viewer.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { MessageParser, TYPE_HELLO, TYPE_FRAME } from './protocol.js';
import { openCapture, captureIdFor } from './capture.js';
import { handleExportSocket, MAX_FRAME_BYTES } from './export.js';

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
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
};

const WEB_DIR = join(ROOT, 'web');
const THREE_DIR = join(ROOT, 'node_modules/three');
const CAPTURES_DIR = join(ROOT, 'captures');
const EXPORTS_DIR = join(ROOT, 'exports');

// A bare startsWith would also match a sibling like `web-private`, so the
// separator has to be part of the comparison.
const isInside = (dir, candidate) => candidate === dir || candidate.startsWith(dir + sep);

// A capture is addressed by id - its file name without the extension - resolved
// inside the captures directory. Ids arrive off the URL, so anything that could
// name a path rather than a take is rejected outright rather than normalised and
// hoped about; the leading character rules out `..` on its own.
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// `--replay` may name a file anywhere, so the replayed take registers its own id.
const captureAliases = new Map();

function capturePathFor(id) {
  if (captureAliases.has(id)) return captureAliases.get(id);
  return VALID_ID.test(id) ? join(CAPTURES_DIR, `${id}.knct`) : null;
}

// The frame API: the browser asks for a frame or a run, the server preads it out
// of the capture and returns the bytes unchanged. Two response shapes, because
// the two calls want different things. A single frame is the payload alone -
// byte for byte what `broadcastFrame` puts on the socket - so the pulled and the
// pushed path hand the same decoder the same input. A run is the file's own
// slice, framing included, because payloads concatenated have no boundaries left
// to parse back and the headers that supply them are already interleaved.
async function serveCapture(res, id, rest) {
  const path = capturePathFor(id);
  if (!path) {
    res.writeHead(404).end('unknown capture');
    return;
  }

  let capture;
  try {
    capture = await openCapture(path);
  } catch (err) {
    if (err.code === 'ENOENT') res.writeHead(404).end('unknown capture');
    else res.writeHead(500).end(`capture unreadable: ${err.message}`);
    return;
  }

  // The sensor's own intrinsics, as the grabber reported them when the take was
  // recorded. The timeline path has no socket to hear them on, and unprojecting a
  // take on the boot defaults is wrong in a way nothing on screen can show -
  // every point translates together, so both arms of every comparison are wrong
  // identically. Step 2's scan already recorded where the hello sits, so this is
  // one positioned read.
  if (rest === 'hello') {
    const payload = await capture.readHello();
    if (!payload) {
      res.writeHead(404).end('this capture carries no hello');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME['.json'],
      'Content-Length': payload.length,
      'Cache-Control': 'no-cache',
    });
    res.end(payload);
    return;
  }

  if (rest === 'index') {
    const body = Buffer.from(JSON.stringify(capture.index));
    res.writeHead(200, {
      'Content-Type': MIME['.json'],
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
    return;
  }

  const inRange = (n) => Number.isInteger(n) && n >= 0 && n < capture.frameCount;

  const one = /^frame\/(\d+)$/.exec(rest);
  if (one) {
    const n = Number(one[1]);
    if (!inRange(n)) {
      res.writeHead(404).end('no such frame');
      return;
    }
    const payload = await capture.readFrame(n);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': payload.length,
      'Cache-Control': 'no-cache',
    });
    res.end(payload);
    return;
  }

  const run = /^frames\/(\d+)-(\d+)$/.exec(rest);
  if (run) {
    const a = Number(run[1]);
    const b = Number(run[2]);
    if (!inRange(a) || !inRange(b) || a > b) {
      res.writeHead(404).end('no such range');
      return;
    }
    const { start, end } = capture.frameRunSpan(a, b);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': end - start + 1,
      'Cache-Control': 'no-cache',
    });
    // `pipeline` rather than `pipe`, because the headers are already out by the
    // time anything can go wrong. A bare pipe leaves a read error as an unhandled
    // stream event, which takes the whole process down - replay, socket fan-out
    // and static server with it - and leaves a client that walked away mid-run
    // holding a reader nobody stops. This tears down both ends either way; the
    // response is truncated against its declared length, which is the only honest
    // signal left once a 200 has been sent.
    pipeline(capture.createFrameRunStream(a, b), res, (err) => {
      if (err) console.error(`[server] frame run ${id} ${a}-${b} failed: ${err.message}`);
    });
    return;
  }

  res.writeHead(404).end('not found');
}

const httpServer = createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    // A malformed percent escape such as /%zz throws here, and an exception
    // thrown out of this handler ends the process - taking replay, the socket
    // fan-out and the viewer with it over a request nobody meant.
    res.writeHead(400).end('bad request');
    return;
  }

  const capture = /^\/capture\/([^/]+)\/(.+)$/.exec(urlPath);
  if (capture) {
    serveCapture(res, capture[1], capture[2]).catch((err) => {
      console.error('[server] capture request failed:', err.message);
      if (!res.headersSent) res.writeHead(500);
      res.end('capture read failed');
    });
    return;
  }

  let filePath;
  if (urlPath.startsWith('/vendor/three/')) {
    filePath = join(THREE_DIR, urlPath.slice('/vendor/three/'.length));
  } else if (urlPath.startsWith('/exports/')) {
    // Served so a finished export can be played back where it was made, in the
    // browser, rather than only inspected with a probe. A video that decodes is
    // the last thing an export has to prove and the only one a metadata check
    // cannot make.
    filePath = join(EXPORTS_DIR, urlPath.slice('/exports/'.length));
  } else {
    filePath = join(WEB_DIR, urlPath === '/' ? 'index.html' : urlPath);
  }

  const resolved = normalize(filePath);
  if (!isInside(WEB_DIR, resolved) && !isInside(THREE_DIR, resolved) && !isInside(EXPORTS_DIR, resolved)) {
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

// Two sockets on one port, routed here rather than by handing each server the
// http server. `ws` aborts an upgrade whose path it does not recognise, so two
// servers attached that way would each destroy the other's handshakes - the
// second one to see the event would 400 a socket the first had already taken.
const wss = new WebSocketServer({ noServer: true });
// Compression off, said rather than inherited: an export is raw RGBA over
// loopback precisely so no CPU is spent on bytes that were never scarce, and a
// deflate negotiated by default would undo that decision silently.
const exportWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });

httpServer.on('upgrade', (req, socket, head) => {
  let path;
  try {
    path = new URL(req.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  const target = path === '/export' ? exportWss : path === '/' ? wss : null;
  if (!target) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

exportWss.on('connection', (ws) => {
  console.log('[export] client connected');
  ws.on('error', (err) => console.error('[export] socket error:', err.message));
  handleExportSocket(ws, { outDir: EXPORTS_DIR });
});

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

async function startReplay() {
  let capture;
  try {
    capture = await openCapture(REPLAY);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`[server] no capture at ${REPLAY} — record one first: npm run record`);
    } else {
      // Anything else is a real failure of the reader and has to say so. A
      // blanket catch here used to report every error as a missing file, which
      // is how a capture the old whole-file read simply refused to open came to
      // look like a capture nobody had recorded.
      console.error(`[server] cannot open ${REPLAY}: ${err.message}`);
    }
    return;
  }

  // The replayed take is reachable over the frame API under its own id even when
  // it lives outside the captures directory.
  captureAliases.set(captureIdFor(REPLAY), resolve(REPLAY));

  const stamps = capture.index.frames.stampMs;
  if (stamps.length === 0) {
    console.error('[server] replay file contains no frames');
    return;
  }

  console.log(`[server] replaying ${REPLAY}`);
  const hello = await capture.readHello();
  if (hello) handleMessage({ type: TYPE_HELLO, payload: hello });

  // Replay the recorded arrival spacing rather than a uniform 30fps. A live
  // stream is deeply irregular - measured p50 64ms against p90 222ms - and
  // pacing every frame 33ms apart hands the viewer the one cadence that never
  // happens, so interpolation tuned against replay looks right here and stutters
  // on the sensor. Frame 0 anchors the loop; the gap after the last frame reuses
  // the median so the wrap does not stall.
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).filter((g) => g > 0 && g < 2000);
  const median = gaps.length ? gaps.slice().sort((a, b) => a - b)[gaps.length >> 1] : 33;
  gaps.push(median);

  console.log(
    `[server] ${stamps.length} frames indexed, median gap ${median}ms, ${capture.index.hash}`,
  );

  // A replayed take is as live as this server gets, and saying so is what gives
  // the lost state below something to mean.
  setSensorState('live');

  let i = 0;
  let failing = false;
  const schedule = () => {
    const gap = gaps[i % gaps.length];
    i++;
    setTimeout(tick, gap);
  };
  // Each frame is read at the moment it is due, so replaying a five-minute take
  // costs the same memory as replaying a nine-second one. The read is awaited
  // before the timer is set, which adds its own duration to every gap - measured
  // at 0.07 to 0.6ms against a 64ms median, so under 1% and inside the slop the
  // old in-memory loop already had.
  const tick = () => {
    capture
      .readFrame(i % stamps.length)
      .then((payload) => {
        if (failing) {
          failing = false;
          console.log('[server] replay reads recovered');
          setSensorState('live');
        }
        handleMessage({ type: TYPE_FRAME, payload });
        schedule();
      })
      .catch((err) => {
        // A read that fails must not freeze the loop in silence. A viewer holding
        // its last frame looks exactly like a paused take, so the state goes to
        // lost the way it does when the grabber dies, and the loop keeps trying
        // at the recorded cadence rather than stopping - a transient failure then
        // recovers on its own. Logged on the transition only, or a take whose
        // file went away would fill the console every 64ms.
        if (!failing) {
          failing = true;
          console.error(`[server] replay read failed: ${err.message}`);
          setSensorState('lost');
        }
        schedule();
      });
  };
  tick();
}

httpServer.listen(PORT, () => {
  console.log(`[server] viewer on http://localhost:${PORT}`);
  if (REPLAY) startReplay().catch((err) => console.error(`[server] replay failed: ${err.message}`));
  else startLive();
});
