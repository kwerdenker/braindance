// Bridges the native Kinect grabber to the browser: spawns (or replays) the
// framed binary stream and fans it out over WebSocket, while serving the viewer.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
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
const PIPELINE = flag('--pipeline', 'cl');
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

const httpServer = createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

  let filePath;
  if (urlPath.startsWith('/vendor/three/')) {
    filePath = join(ROOT, 'node_modules/three', urlPath.slice('/vendor/three/'.length));
  } else {
    filePath = join(ROOT, 'web', urlPath === '/' ? 'index.html' : urlPath);
  }

  // Keep path traversal inside the two directories we intend to expose.
  const resolved = normalize(filePath);
  if (!resolved.startsWith(join(ROOT, 'web')) && !resolved.startsWith(join(ROOT, 'node_modules/three'))) {
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

wss.on('connection', (ws) => {
  ws.binaryType = 'nodebuffer';
  console.log(`[server] client connected (${wss.clients.size} total)`);
  if (helloJson) ws.send(helloJson);
  ws.on('error', (err) => console.error('[server] socket error:', err.message));
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

function startLive() {
  const bin = join(ROOT, 'native/build/grabber');
  const grabberArgs = ['--pipeline', PIPELINE];
  if (NO_COLOR) grabberArgs.push('--no-color');

  console.log(`[server] starting grabber: ${bin} ${grabberArgs.join(' ')}`);
  const child = spawn(bin, grabberArgs, { stdio: ['ignore', 'pipe', 'inherit'] });

  const recorder = RECORD ? createWriteStream(RECORD) : null;
  if (recorder) console.log(`[server] recording to ${RECORD}`);

  const parser = new MessageParser();
  child.stdout.on('data', (chunk) => {
    if (recorder) recorder.write(chunk);
    try {
      for (const msg of parser.push(chunk)) handleMessage(msg);
    } catch (err) {
      console.error('[server]', err.message);
      child.kill('SIGTERM');
    }
  });

  child.on('exit', (code, signal) => {
    console.error(`[server] grabber exited (code=${code} signal=${signal})`);
    recorder?.end();
  });

  process.on('SIGINT', () => {
    child.kill('SIGTERM');
    process.exit(0);
  });
}

function startReplay() {
  console.log(`[server] replaying ${REPLAY} (looping at 30fps)`);
  const parser = new MessageParser();
  const messages = [];
  for (const msg of parser.push(readFileSync(REPLAY))) {
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
  console.log(`[server] ${frames.length} frames loaded`);

  let i = 0;
  setInterval(() => {
    handleMessage(frames[i % frames.length]);
    i++;
  }, 1000 / 30);
}

httpServer.listen(PORT, () => {
  console.log(`[server] viewer on http://localhost:${PORT}`);
  if (REPLAY) startReplay();
  else startLive();
});
