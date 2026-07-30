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

int main(int argc, char **argv) {
  int jpegQuality = 80;
  bool wantColor = true;
  std::string pipelineName = "cl";
  std::string logLevel = "warning";

  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--no-color") wantColor = false;
    else if (a == "--pipeline" && i + 1 < argc) pipelineName = argv[++i];
    else if (a == "--quality" && i + 1 < argc) jpegQuality = std::atoi(argv[++i]);
    else if (a == "--log" && i + 1 < argc) logLevel = argv[++i];
    else if (a == "--help") {
      std::fprintf(stderr,
        "usage: grabber [--pipeline cl|cpu] [--no-color] [--quality 1-100]\n"
        "               [--log none|error|warning|info|debug]\n"
        "\n"
        "  --log debug surfaces libfreenect2's per-packet USB diagnostics,\n"
        "  including 'not all subsequences received' - the dropped-isochronous-\n"
        "  packet counter you want when tuning LIBFREENECT2_IR_TRANSFERS.\n");
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
  if (pipelineName == "cpu") pipeline = new libfreenect2::CpuPacketPipeline();
  else pipeline = new libfreenect2::OpenCLPacketPipeline();

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

  if (wantColor) {
    if (!dev->start()) { std::fprintf(stderr, "[grabber] device start failed\n"); return 1; }
  } else {
    if (!dev->startStreams(false, true)) { std::fprintf(stderr, "[grabber] device start failed\n"); return 1; }
  }

  libfreenect2::Freenect2Device::IrCameraParams ir = dev->getIrCameraParams();
  libfreenect2::Freenect2Device::ColorCameraParams cp = dev->getColorCameraParams();
  libfreenect2::Registration registration(ir, cp);
  libfreenect2::Frame undistorted(DW, DH, 4), registered(DW, DH, 4);

  // The browser needs the real intrinsics to unproject; hardcoded values skew the cloud.
  char hello[512];
  int helloLen = std::snprintf(hello, sizeof(hello),
    "{\"serial\":\"%s\",\"firmware\":\"%s\",\"width\":%d,\"height\":%d,"
    "\"fx\":%.6f,\"fy\":%.6f,\"cx\":%.6f,\"cy\":%.6f,\"color\":%s}",
    serial.c_str(), dev->getFirmwareVersion().c_str(), DW, DH,
    ir.fx, ir.fy, ir.cx, ir.cy, wantColor ? "true" : "false");
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

  while (!g_stop) {
    if (!depthListener.waitForNewFrame(depthFrames, 10 * 1000)) {
      std::fprintf(stderr, "[grabber] timeout waiting for frame\n");
      break;
    }

    // Take a new colour frame only if one is already waiting; never block on it.
    // The previous one is released first so at most one is held outside the pool.
    if (wantColor && colorListener.hasNewFrame()) {
      if (haveColor) colorListener.release(colorFrames);
      haveColor = colorListener.waitForNewFrame(colorFrames, 1000);
      if (haveColor) colorCount++;
    }

    libfreenect2::Frame *depth = depthFrames[libfreenect2::Frame::Depth];
    libfreenect2::Frame *rgb = haveColor ? colorFrames[libfreenect2::Frame::Color] : nullptr;

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

    uint16_t *d16 = (uint16_t *)depthOut.data();
    for (size_t i = 0; i < DEPTH_PIXELS; i++) {
      float mm = depthSrc[i];
      d16[i] = (mm > 0.0f && mm < 65535.0f) ? (uint16_t)mm : 0;
    }

    jpegSize = 0;
    if (rgb) {
      // registered is BGRX, already aligned 1:1 with the depth pixels
      tjCompress2(jpegCompressor, (unsigned char *)registered.data, DW, 0, DH,
                  TJPF_BGRX, &jpegBuf, &jpegSize, TJSAMP_420, jpegQuality, TJFLAG_FASTDCT);
    }

    uint32_t depthBytes = (uint32_t)depthOut.size();
    uint32_t colorBytes = (uint32_t)jpegSize;
    uint64_t ts = now_ms();

    payload.resize(4 + 4 + 8 + depthBytes + colorBytes);
    uint8_t *p = payload.data();
    std::memcpy(p, &depthBytes, 4); p += 4;
    std::memcpy(p, &colorBytes, 4); p += 4;
    std::memcpy(p, &ts, 8);         p += 8;
    std::memcpy(p, depthOut.data(), depthBytes); p += depthBytes;
    if (colorBytes) std::memcpy(p, jpegBuf, colorBytes);

    bool ok = write_message(STDOUT_FILENO, TYPE_FRAME, payload.data(), (uint32_t)payload.size());
    depthListener.release(depthFrames);
    if (!ok) break; // consumer closed the pipe

    // Colour lagging depth is normal in dim light and is the one number that
    // explains a washed-out or stale-looking image, so it is reported alongside.
    if (++frameCount % 150 == 0)
      std::fprintf(stderr, "[grabber] %llu frames (%llu colour)\n",
                   (unsigned long long)frameCount, (unsigned long long)colorCount);
  }

  if (haveColor) colorListener.release(colorFrames);

  if (jpegBuf) tjFree(jpegBuf);
  if (jpegCompressor) tjDestroy(jpegCompressor);
  dev->stop();
  dev->close();
  std::fprintf(stderr, "[grabber] stopped after %llu frames\n", (unsigned long long)frameCount);
  return 0;
}
