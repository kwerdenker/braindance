// Kinect v2 grabber: pulls depth + registered colour from libfreenect2 and writes
// a length-framed binary stream to stdout. All logging goes to stderr so a stray
// log line can never desync the frame stream.
//
//   [u32 magic 'KNCT'][u32 type][u32 payloadLen][payload]
//
//   type 1 (hello) : UTF-8 JSON, sent once before any frame
//   type 2 (frame) : [u32 depthBytes][u32 colorBytes][u64 timestampMs]
//                    [u16 depth[512*424] millimetres, 0 = no reading]
//                    [JPEG of the registered 512x424 colour image]

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <csignal>
#include <cerrno>
#include <string>
#include <vector>
#include <chrono>
#include <unistd.h>
#include <fcntl.h>

#include <libfreenect2/config.h>
#include <libfreenect2/libfreenect2.hpp>
#include <libfreenect2/frame_listener_impl.h>
#include <libfreenect2/registration.h>
#include <libfreenect2/packet_pipeline.h>
#include <libfreenect2/logger.h>

#include <turbojpeg.h>

static const uint32_t MAGIC = 0x4B4E4354; // 'KNCT'
static const uint32_t TYPE_HELLO = 1;
static const uint32_t TYPE_FRAME = 2;

static const int DW = 512;
static const int DH = 424;
static const size_t DEPTH_PIXELS = (size_t)DW * DH;

static volatile std::sig_atomic_t g_stop = 0;
static void on_signal(int) { g_stop = 1; }

// libfreenect2 logs to stdout by default, which would corrupt the binary stream.
class StderrLogger : public libfreenect2::Logger {
public:
  explicit StderrLogger(Level level) { level_ = level; }
  void log(Level level, const std::string &message) override {
    std::fprintf(stderr, "[%s] %s\n", libfreenect2::Logger::level2str(level).c_str(), message.c_str());
    std::fflush(stderr);
  }
};

// Pipe writes are capped at 64KB on macOS, so a ~500KB frame always partial-writes.
static bool write_all(int fd, const void *buf, size_t len) {
  const uint8_t *p = static_cast<const uint8_t *>(buf);
  while (len > 0) {
    ssize_t n = ::write(fd, p, len);
    if (n < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    p += n;
    len -= (size_t)n;
  }
  return true;
}

static bool write_message(int fd, uint32_t type, const void *payload, uint32_t payloadLen) {
  uint32_t header[3] = {MAGIC, type, payloadLen};
  if (!write_all(fd, header, sizeof(header))) return false;
  if (payloadLen && !write_all(fd, payload, payloadLen)) return false;
  return true;
}

static uint64_t now_ms() {
  using namespace std::chrono;
  return (uint64_t)duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

// The serial segments of the frame loop are single-digit milliseconds each and
// the payload memcpy is well under one, so profiling needs microseconds - a
// millisecond clock would quantise half the breakdown to zero.
static uint64_t now_us() {
  using namespace std::chrono;
  return (uint64_t)duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count();
}

// Low light on is the sensor's own behaviour: it lengthens integration until the
// image is properly exposed, which drops the colour camera to 15fps. Off pins the
// exposure to a single mains-flicker period - 16.667 pseudo-ms resolves to 10ms
// at 50Hz or 8.3ms at 60Hz, whichever the room is - so colour holds 30fps and the
// gain compensates as far as it can. Depth never changes either way.
static void applyLowLight(libfreenect2::Freenect2Device *dev, bool on) {
  if (on) dev->setColorAutoExposure(0.0f);
  else dev->setColorSemiAutoExposure(16.667f);
  std::fprintf(stderr, "[grabber] low light %s\n", on ? "on" : "off");
}

// Commands arrive newline terminated on stdin so the server can retune a running
// grabber. Restarting instead would cost a multi-second blackout, because closing
// the device on macOS sleeps 4s inside libfreenect2.
static void pollCommands(libfreenect2::Freenect2Device *dev, std::string &pending, bool wantColor) {
  char buf[256];
  ssize_t n;
  while ((n = ::read(STDIN_FILENO, buf, sizeof(buf))) > 0) pending.append(buf, (size_t)n);

  size_t nl;
  while ((nl = pending.find('\n')) != std::string::npos) {
    std::string line = pending.substr(0, nl);
    pending.erase(0, nl + 1);
    if (!line.empty() && line.back() == '\r') line.pop_back();

    if (line == "low-light on" || line == "low-light off") {
      if (wantColor) applyLowLight(dev, line == "low-light on");
    } else if (!line.empty()) {
      std::fprintf(stderr, "[grabber] unknown command: %s\n", line.c_str());
    }
  }
}

int main(int argc, char **argv) {
  int jpegQuality = 80;
  bool wantColor = true;
  // No libfreenect2 build has every processor: the macOS one has OpenCL and no
  // OpenGL, the Pi's V3D has OpenGL and no OpenCL at all. So the default is the
  // fastest processor this build actually contains, and asking for one that was
  // not compiled in is an error rather than a silent fall-through.
#if defined(LIBFREENECT2_WITH_OPENCL_SUPPORT)
  std::string pipelineName = "cl";
#elif defined(LIBFREENECT2_WITH_OPENGL_SUPPORT)
  std::string pipelineName = "gl";
#else
  std::string pipelineName = "cpu";
#endif
  std::string logLevel = "warning";
  bool profile = false;
  // libfreenect2 clips depth on the GPU before we ever see it, and its 0.5-4.5
  // defaults are Microsoft's published range, not the sensor's limit. Measured
  // by walking a hand into the lens: readings stay coherent at 99% right down to
  // 38mm, with the pixel count climbing monotonically the whole way in - 32k at
  // 160mm to 128k at 40mm, which is 59% of the frame from one palm. There is no
  // saturation cliff and no phase wrap; a wrap would jump discontinuously rather
  // than track the hand smoothly. The sensor is limited by reach, not physics.
  //
  // These are deliberately wider than what looks good. Gating here destroys data
  // the viewer can never get back, while the viewer's own near/far merely hides
  // it - and capturing wide is free, because the depth payload is a fixed-size
  // array whether 40% or 90% of it is populated. So the grabber takes everything
  // the sensor can resolve and the UI decides what to show. There is a real
  // surface at ~8.5m here that a 6m ceiling would have thrown away.
  float minDepth = 0.05f;
  float maxDepth = 9.0f;
  bool lowLight = true;

  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--no-color") wantColor = false;
    else if (a == "--pipeline" && i + 1 < argc) pipelineName = argv[++i];
    else if (a == "--quality" && i + 1 < argc) jpegQuality = std::atoi(argv[++i]);
    else if (a == "--log" && i + 1 < argc) logLevel = argv[++i];
    else if (a == "--min-depth" && i + 1 < argc) minDepth = (float)std::atof(argv[++i]);
    else if (a == "--max-depth" && i + 1 < argc) maxDepth = (float)std::atof(argv[++i]);
    else if (a == "--no-low-light") lowLight = false;
    else if (a == "--profile") profile = true;
    else if (a == "--help") {
      std::fprintf(stderr,
        "usage: grabber [--pipeline gl|cl|cpu] [--no-color] [--quality 1-100]\n"
        "               [--log none|error|warning|info|debug] [--profile]\n"
        "               [--min-depth m] [--max-depth m] [--no-low-light]\n"
        "\n"
        "  --pipeline picks the depth processor. Only the ones this libfreenect2\n"
        "  was built with are available: this build offers"
#ifdef LIBFREENECT2_WITH_OPENGL_SUPPORT
        " gl"
#endif
#ifdef LIBFREENECT2_WITH_OPENCL_SUPPORT
        " cl"
#endif
        " cpu, and defaults to %s.\n"
        "\n"
        "  --log debug surfaces libfreenect2's per-packet USB diagnostics,\n"
        "  including 'not all subsequences received' - the dropped-isochronous-\n"
        "  packet counter you want when tuning LIBFREENECT2_IR_TRANSFERS.\n"
        "\n"
        "  --profile times the serial half of the frame loop - registration,\n"
        "  depth conversion, JPEG encode, payload assembly and the write - plus\n"
        "  the time spent blocked waiting for the next depth frame, which is the\n"
        "  headroom left over. One CSV row per frame, all of them written to\n"
        "  stderr at exit so the reporting stays out of the loop being measured.\n"
        "\n"
        "  --min-depth/--max-depth clip on the GPU before the frame is built, so\n"
        "  they decide what exists at all - the viewer's own clip only hides what\n"
        "  these let through. Defaults are 0.05 and 9.0, wider than\n"
        "  libfreenect2's own 0.5 and 4.5.\n"
        "\n"
        "  --no-low-light caps the colour exposure to one flicker period, which\n"
        "  holds the colour camera at 30fps in a dim room at the cost of a darker\n"
        "  image. Left on, the camera lengthens its exposure and falls to 15fps.\n"
        "  Depth is unaffected either way - the two streams are decoupled.\n"
        "\n"
        "stdin commands, newline terminated, applied live:\n"
        "  low-light on|off\n",
        pipelineName.c_str());
      return 0;
    }
  }

  // Debug is genuinely noisy - one line per incomplete depth frame - so it stays
  // opt-in rather than being the default the server spawns with.
  libfreenect2::Logger::Level level = libfreenect2::Logger::Warning;
  if (logLevel == "none") level = libfreenect2::Logger::None;
  else if (logLevel == "error") level = libfreenect2::Logger::Error;
  else if (logLevel == "info") level = libfreenect2::Logger::Info;
  else if (logLevel == "debug") level = libfreenect2::Logger::Debug;
  libfreenect2::setGlobalLogger(new StderrLogger(level));

  std::signal(SIGINT, on_signal);
  std::signal(SIGTERM, on_signal);
  std::signal(SIGPIPE, SIG_IGN); // parent going away must not kill us mid-write

  libfreenect2::Freenect2 freenect2;
  if (freenect2.enumerateDevices() == 0) {
    std::fprintf(stderr, "[grabber] no Kinect v2 found\n");
    return 1;
  }
  std::string serial = freenect2.getDefaultDeviceSerialNumber();

  libfreenect2::PacketPipeline *pipeline = nullptr;
  if (pipelineName == "cpu") {
    pipeline = new libfreenect2::CpuPacketPipeline();
  } else if (pipelineName == "gl") {
#ifdef LIBFREENECT2_WITH_OPENGL_SUPPORT
    // The GL processor opens its own window, so a Wayland or X session has to be
    // reachable - XDG_RUNTIME_DIR and WAYLAND_DISPLAY on a headless login shell.
    pipeline = new libfreenect2::OpenGLPacketPipeline();
#else
    std::fprintf(stderr, "[grabber] this libfreenect2 was built without OpenGL support\n");
    return 1;
#endif
  } else if (pipelineName == "cl") {
#ifdef LIBFREENECT2_WITH_OPENCL_SUPPORT
    pipeline = new libfreenect2::OpenCLPacketPipeline();
#else
    std::fprintf(stderr, "[grabber] this libfreenect2 was built without OpenCL support\n");
    return 1;
#endif
  } else {
    std::fprintf(stderr, "[grabber] unknown pipeline '%s' (want gl, cl or cpu)\n", pipelineName.c_str());
    return 1;
  }

  libfreenect2::Freenect2Device *dev = freenect2.openDevice(serial, pipeline);
  if (!dev) {
    std::fprintf(stderr, "[grabber] failed to open device %s\n", serial.c_str());
    return 1;
  }

  // Depth and colour are listened to separately on purpose. A single
  // SyncMultiFrameListener releases a frame set only once *both* streams have
  // delivered, and the Kinect's colour camera halves to 15fps in dim light while
  // depth stays at 30 - so syncing them throws away every other depth frame for
  // no reason. Decoupled, depth runs at its own rate and reuses the most recent
  // colour, which is at worst one interval stale.
  libfreenect2::SyncMultiFrameListener depthListener(libfreenect2::Frame::Depth);
  libfreenect2::SyncMultiFrameListener colorListener(libfreenect2::Frame::Color);
  dev->setIrAndDepthFrameListener(&depthListener);
  if (wantColor) dev->setColorFrameListener(&colorListener);

  libfreenect2::Freenect2Device::Config config;
  config.MinDepth = minDepth;
  config.MaxDepth = maxDepth;
  dev->setConfiguration(config);

  if (wantColor) {
    if (!dev->start()) { std::fprintf(stderr, "[grabber] device start failed\n"); return 1; }
  } else {
    if (!dev->startStreams(false, true)) { std::fprintf(stderr, "[grabber] device start failed\n"); return 1; }
  }

  if (wantColor) applyLowLight(dev, lowLight);

  // Non-blocking so the capture loop never stalls waiting on a command that may
  // never come - the server usually has nothing to say.
  ::fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK);
  std::string pendingCommands;

  libfreenect2::Freenect2Device::IrCameraParams ir = dev->getIrCameraParams();
  libfreenect2::Freenect2Device::ColorCameraParams cp = dev->getColorCameraParams();
  libfreenect2::Registration registration(ir, cp);
  libfreenect2::Frame undistorted(DW, DH, 4), registered(DW, DH, 4);

  // The browser needs the real intrinsics to unproject; hardcoded values skew the cloud.
  //
  // startedAt is the wall clock, and it is here rather than in the server because
  // this is the only place that knows when the stream actually began. Every frame
  // timestamp below is steady_clock - monotonic since boot, which is exactly right
  // for frame spacing and useless for sorting a library, since two takes recorded a
  // day apart on a node that never rebooted are indistinguishable by it. A gallery
  // otherwise has nothing but the file's modification time, which changes when a
  // take is copied between machines.
  long long startedAt = std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()).count();
  char hello[512];
  int helloLen = std::snprintf(hello, sizeof(hello),
    "{\"serial\":\"%s\",\"firmware\":\"%s\",\"width\":%d,\"height\":%d,"
    "\"fx\":%.6f,\"fy\":%.6f,\"cx\":%.6f,\"cy\":%.6f,\"color\":%s,"
    "\"minDepth\":%.3f,\"maxDepth\":%.3f,\"lowLight\":%s,\"startedAt\":%lld}",
    serial.c_str(), dev->getFirmwareVersion().c_str(), DW, DH,
    ir.fx, ir.fy, ir.cx, ir.cy, wantColor ? "true" : "false",
    minDepth, maxDepth, (wantColor && lowLight) ? "true" : "false", startedAt);
  // snprintf truncates silently, and a truncated hello is not JSON - so every take
  // recorded afterwards would carry a sensor record nothing can parse, and the
  // gallery would list them all with unknown intrinsics. The serial and the
  // firmware are device strings rather than constants, so the length is not
  // something this file can reason about once and forget.
  if (helloLen < 0 || (size_t)helloLen >= sizeof(hello)) {
    std::fprintf(stderr, "[grabber] hello needs %d bytes and the buffer is %zu: refusing to "
                 "stream a sensor record that would be cut in half\n", helloLen, sizeof(hello));
    return 1;
  }
  if (!write_message(STDOUT_FILENO, TYPE_HELLO, hello, (uint32_t)helloLen)) return 1;
  std::fprintf(stderr, "[grabber] streaming %s (fx=%.2f fy=%.2f cx=%.2f cy=%.2f)\n",
               serial.c_str(), ir.fx, ir.fy, ir.cx, ir.cy);

  tjhandle jpegCompressor = wantColor ? tjInitCompress() : nullptr;
  unsigned char *jpegBuf = nullptr;
  unsigned long jpegSize = 0;

  std::vector<uint8_t> depthOut(DEPTH_PIXELS * sizeof(uint16_t));
  std::vector<uint8_t> payload;

  libfreenect2::FrameMap depthFrames, colorFrames;
  bool haveColor = false;
  uint64_t frameCount = 0;
  uint64_t colorCount = 0;

  // Records are buffered and dumped at exit rather than printed per frame, so
  // the profiling I/O cannot land inside the loop it is measuring.
  struct ProfRecord {
    uint64_t arrival;
    uint32_t newColor, wait, acq, reg, conv, enc, asm_, write, jpegBytes;
  };
  std::vector<ProfRecord> prof;
  if (profile) prof.reserve(1 << 17); // ~an hour at 30fps, so no realloc mid-loop

  while (!g_stop) {
    uint64_t tWaitStart = now_us();
    if (!depthListener.waitForNewFrame(depthFrames, 10 * 1000)) {
      std::fprintf(stderr, "[grabber] timeout waiting for frame\n");
      break;
    }
    uint64_t tArrived = now_us();

    pollCommands(dev, pendingCommands, wantColor);

    // Take a new colour frame only if one is already waiting; never block on it.
    // The previous one is released first so at most one is held outside the pool.
    bool newColor = false;
    if (wantColor && colorListener.hasNewFrame()) {
      if (haveColor) colorListener.release(colorFrames);
      haveColor = colorListener.waitForNewFrame(colorFrames, 1000);
      if (haveColor) { colorCount++; newColor = true; }
    }

    libfreenect2::Frame *depth = depthFrames[libfreenect2::Frame::Depth];
    libfreenect2::Frame *rgb = haveColor ? colorFrames[libfreenect2::Frame::Color] : nullptr;
    uint64_t tAcquired = now_us();

    const float *depthSrc;
    if (rgb) {
      registration.apply(rgb, depth, &undistorted, &registered);
      depthSrc = (const float *)undistorted.data;
    } else {
      // Same undistortion the colour path applies, so geometry does not shift
      // between the frames before the first colour arrives and the ones after.
      registration.undistortDepth(depth, &undistorted);
      depthSrc = (const float *)undistorted.data;
    }
    uint64_t tRegistered = now_us();

    uint16_t *d16 = (uint16_t *)depthOut.data();
    for (size_t i = 0; i < DEPTH_PIXELS; i++) {
      float mm = depthSrc[i];
      d16[i] = (mm > 0.0f && mm < 65535.0f) ? (uint16_t)mm : 0;
    }
    uint64_t tConverted = now_us();

    // registered is BGRX, already aligned 1:1 with the depth pixels. jpegSize is
    // an input as well as an output: TurboJPEG reuses the buffer it allocated on
    // the previous call and reads jpegSize as that buffer's capacity, so zeroing
    // it beforehand claims a zero-length buffer and the encode runs off the end.
    // libjpeg-turbo 3 on macOS absorbs that; 2.1.5 on Debian aarch64 corrupts the
    // heap and the grabber dies inside tjCompress2 within a few frames.
    // Because jpegSize now survives the call, a failed encode would leave the
    // previous frame's length behind and we would ship stale bytes as fresh ones.
    uint32_t colorBytes = 0;
    if (rgb) {
      if (tjCompress2(jpegCompressor, (unsigned char *)registered.data, DW, 0, DH,
                      TJPF_BGRX, &jpegBuf, &jpegSize, TJSAMP_420, jpegQuality, TJFLAG_FASTDCT) == 0)
        colorBytes = (uint32_t)jpegSize;
      else
        std::fprintf(stderr, "[grabber] jpeg encode failed: %s\n", tjGetErrorStr());
    }
    uint64_t tEncoded = now_us();

    uint32_t depthBytes = (uint32_t)depthOut.size();
    uint64_t ts = now_ms();

    payload.resize(4 + 4 + 8 + depthBytes + colorBytes);
    uint8_t *p = payload.data();
    std::memcpy(p, &depthBytes, 4); p += 4;
    std::memcpy(p, &colorBytes, 4); p += 4;
    std::memcpy(p, &ts, 8);         p += 8;
    std::memcpy(p, depthOut.data(), depthBytes); p += depthBytes;
    if (colorBytes) std::memcpy(p, jpegBuf, colorBytes);
    uint64_t tAssembled = now_us();

    bool ok = write_message(STDOUT_FILENO, TYPE_FRAME, payload.data(), (uint32_t)payload.size());
    uint64_t tWritten = now_us();
    depthListener.release(depthFrames);

    if (profile) {
      ProfRecord r;
      r.arrival   = tArrived; // absolute, so delivered rate over any window is exact
      r.newColor  = newColor ? 1 : 0;
      r.wait      = (uint32_t)(tArrived - tWaitStart);
      r.acq       = (uint32_t)(tAcquired - tArrived);
      r.reg       = (uint32_t)(tRegistered - tAcquired);
      r.conv      = (uint32_t)(tConverted - tRegistered);
      r.enc       = (uint32_t)(tEncoded - tConverted);
      r.asm_      = (uint32_t)(tAssembled - tEncoded);
      r.write     = (uint32_t)(tWritten - tAssembled);
      r.jpegBytes = colorBytes;
      prof.push_back(r);
    }

    if (!ok) break; // consumer closed the pipe

    // Colour lagging depth is normal in dim light and is the one number that
    // explains a washed-out or stale-looking image, so it is reported alongside.
    if (++frameCount % 150 == 0)
      std::fprintf(stderr, "[grabber] %llu frames (%llu colour)\n",
                   (unsigned long long)frameCount, (unsigned long long)colorCount);
  }

  if (haveColor) colorListener.release(colorFrames);

  if (profile) {
    std::fprintf(stderr, "[prof] n,arrival_us,newColor,wait_us,acq_us,reg_us,conv_us,enc_us,asm_us,write_us,jpeg_bytes\n");
    for (size_t i = 0; i < prof.size(); i++) {
      const ProfRecord &r = prof[i];
      std::fprintf(stderr, "[prof] %zu,%llu,%u,%u,%u,%u,%u,%u,%u,%u,%u\n",
                   i, (unsigned long long)r.arrival,
                   r.newColor, r.wait, r.acq, r.reg, r.conv, r.enc, r.asm_, r.write, r.jpegBytes);
    }
    std::fflush(stderr);
  }

  if (jpegBuf) tjFree(jpegBuf);
  if (jpegCompressor) tjDestroy(jpegCompressor);
  dev->stop();
  dev->close();
  std::fprintf(stderr, "[grabber] stopped after %llu frames\n", (unsigned long long)frameCount);
  return 0;
}
