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
//   type 3 (colour): [u64 timestampMs][JPEG of the native 1920x1080 colour image]
//                    Only while the server has asked for it - see `hd-color` below.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <csignal>
#include <cerrno>
#include <string>
#include <vector>
#include <chrono>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>

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
static const uint32_t TYPE_COLOR = 3;

static const int CW = 1920;
static const int CH = 1080;

// A corpus is deliberately not KNCT: the wire format carries u16 millimetre depth
// and a JPEG, which are both lossy relative to what Registration::apply actually
// consumes. Its own magic keeps the two from ever being read by the wrong reader.
static const uint32_t CORPUS_MAGIC = 0x4B435250; // 'KCRP'
static const uint32_t CORPUS_VERSION = 1;

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

// Corpus files are written whole and closed before the next frame is touched, so
// a corpus interrupted mid-capture leaves complete frames rather than a trailing
// half-frame the harness would have to guess about.
static bool write_file(const std::string &path, const void *const *parts,
                       const size_t *lens, size_t n) {
  int fd = ::open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    std::fprintf(stderr, "[grabber] cannot open %s: %s\n", path.c_str(), std::strerror(errno));
    return false;
  }
  bool ok = true;
  for (size_t i = 0; i < n && ok; i++) ok = write_all(fd, parts[i], lens[i]);
  if (::close(fd) != 0) ok = false;
  if (!ok) std::fprintf(stderr, "[grabber] short write to %s\n", path.c_str());
  return ok;
}

// **stdout has two writers, so framing a message is a critical section.** The frame
// loop writes type 1 and type 2; the colour encoder thread below writes type 3. A
// message is a header followed by its payload as two separate `write_all` calls over
// a pipe that partial-writes at 64KB, so without this lock the two interleave - a
// header claiming 215KB followed by the first 64KB of somebody else's depth grid.
// The parser on the other end reads that as a desync and restarts the grabber, and
// it would do it rarely, unreproducibly, and only once a webcam was attached.
static std::mutex g_writeMutex;

static bool write_message(int fd, uint32_t type, const void *payload, uint32_t payloadLen) {
  std::lock_guard<std::mutex> lock(g_writeMutex);
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

/**
 * The webcam output's producer: the colour camera's own picture, encoded off the
 * frame loop.
 *
 * **Why a second encode at all.** Type 2 already carries colour, but it carries the
 * *registered* colour - `Registration::apply`'s resample of the colour camera into
 * the depth camera's viewpoint. That image wears the depth camera's 70.6 degree
 * frustum rather than the colour camera's 84.1, and it is punched through with holes
 * wherever the depth solve returned nothing, because registration has no depth to
 * carry a colour sample on. It is a texture for a point cloud and not a picture of a
 * room, so a webcam has to start from the 1920x1080 frame instead.
 *
 * **Why its own thread.** A 1080p TurboJPEG encode at the same settings measures
 * 5.50ms mean on this machine - 90 real sensor frames over a six-second subscription,
 * no warmup discarded, zero busy drops, q80, TJSAMP_420, FASTDCT. The serial half of
 * the frame loop is 7.1ms against a 33ms budget with `Registration::apply` taking 6.3
 * of it, so encoding here would add the full encode to capture-to-wire latency for an
 * output most runs do not have attached. On its own thread the loop pays the copy
 * below and nothing else.
 *
 * **Why it copies rather than borrows.** The `Frame` handed in belongs to
 * libfreenect2's listener and is released when the next colour frame arrives. At
 * 30fps that is 33ms against a 5.50ms mean encode, so borrowing would be safe almost
 * always - and "almost always" is a data race that surfaces as a torn picture on a
 * dim-light run nobody can reproduce.
 *
 * **Drop-to-latest rather than a queue.** A colour frame arriving while the encoder
 * is busy overwrites the pending one. A queue would grow latency under exactly the
 * condition a live output cannot afford it, and a webcam wants the newest frame
 * rather than every frame.
 */
class HdEncoder {
public:
  explicit HdEncoder(int quality) : quality_(quality) {}

  void start() { thread_ = std::thread(&HdEncoder::run, this); }

  void stop() {
    {
      std::lock_guard<std::mutex> lock(m_);
      stop_ = true;
    }
    cv_.notify_all();
    if (thread_.joinable()) thread_.join();
  }

  bool enabled() const { return enabled_.load(std::memory_order_relaxed); }
  void setEnabled(bool on) { enabled_.store(on, std::memory_order_relaxed); }
  uint64_t sent() const { return sent_.load(std::memory_order_relaxed); }
  uint64_t encodeUs() const { return encodeUs_.load(std::memory_order_relaxed); }
  uint64_t dropped() const { return dropped_.load(std::memory_order_relaxed); }

  /** Called on the frame loop, and the only thing it costs is the copy. */
  void submit(const uint8_t *bgrx, size_t bytes, uint64_t ts) {
    {
      std::lock_guard<std::mutex> lock(m_);
      // An unconsumed frame still in the slot is one the encoder never got to, and
      // it is counted rather than silently replaced: a webcam delivering 12fps off a
      // 30fps sensor is a fact about this machine, and the alternative is somebody
      // attributing it to the sensor.
      if (hasPending_) dropped_.fetch_add(1, std::memory_order_relaxed);
      pending_.assign(bgrx, bgrx + bytes);
      pendingTs_ = ts;
      hasPending_ = true;
    }
    cv_.notify_one();
  }

private:
  void run() {
    tjhandle jpeg = tjInitCompress();
    if (!jpeg) {
      std::fprintf(stderr, "[grabber] cannot start the hd colour encoder: %s\n", tjGetErrorStr());
      return;
    }
    std::vector<uint8_t> work;
    std::vector<uint8_t> payload;
    unsigned char *buf = nullptr;
    // Declared out here and never reset for the same reason the frame loop's is:
    // TurboJPEG reads it as the capacity of the buffer it allocated last time, and
    // zeroing it claims a zero-length buffer that the encode then runs off the end of.
    unsigned long size = 0;

    for (;;) {
      uint64_t ts;
      {
        std::unique_lock<std::mutex> lock(m_);
        cv_.wait(lock, [this] { return hasPending_ || stop_; });
        if (stop_) break;
        work.swap(pending_);
        ts = pendingTs_;
        hasPending_ = false;
      }

      uint64_t t0 = now_us();
      if (tjCompress2(jpeg, work.data(), CW, 0, CH, TJPF_BGRX, &buf, &size,
                      TJSAMP_420, quality_, TJFLAG_FASTDCT) != 0) {
        std::fprintf(stderr, "[grabber] hd colour encode failed: %s\n", tjGetErrorStr());
        continue;
      }
      encodeUs_.fetch_add(now_us() - t0, std::memory_order_relaxed);

      payload.resize(8 + (size_t)size);
      std::memcpy(payload.data(), &ts, 8);
      std::memcpy(payload.data() + 8, buf, (size_t)size);
      // Through the same locked writer as everything else, which is what keeps this
      // thread's 215KB from landing inside the frame loop's 486KB.
      if (!write_message(STDOUT_FILENO, TYPE_COLOR, payload.data(), (uint32_t)payload.size())) break;
      sent_.fetch_add(1, std::memory_order_relaxed);
    }

    if (buf) tjFree(buf);
    tjDestroy(jpeg);
  }

  const int quality_;
  std::thread thread_;
  std::mutex m_;
  std::condition_variable cv_;
  std::vector<uint8_t> pending_;
  uint64_t pendingTs_ = 0;
  bool hasPending_ = false;
  bool stop_ = false;
  std::atomic<bool> enabled_{false};
  std::atomic<uint64_t> sent_{0};
  std::atomic<uint64_t> encodeUs_{0};
  std::atomic<uint64_t> dropped_{0};
};

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
static void pollCommands(libfreenect2::Freenect2Device *dev, std::string &pending, bool wantColor,
                         HdEncoder *hd) {
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
    } else if (line == "hd-color on" || line == "hd-color off") {
      // Asked for rather than always on, because a 1080p JPEG is roughly 215KB and
      // another ~50Mbit/s down a pipe whose backpressure reaches this process and
      // makes it miss USB deadlines. With colour off there is no frame to encode, and
      // saying so on stderr is what stops the server waiting for a stream that is
      // never coming.
      const bool on = line == "hd-color on";
      if (!wantColor && on) {
        std::fprintf(stderr, "[grabber] refusing hd colour: this grabber was started with --no-color\n");
      } else if (hd) {
        hd->setEnabled(on);
        std::fprintf(stderr, "[grabber] hd colour %s\n", on ? "on" : "off");
      }
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

  // Corpus dumping exists so the registration harness can run without a sensor.
  // It writes the *inputs* to Registration::apply - the undistorted-depth source
  // and the colour image - rather than its output, because a corpus of outputs
  // could only ever agree with the build that produced it.
  std::string dumpCorpus;
  int dumpCount = 24;
  int dumpEvery = 10;

  // The text each numeric flag was actually given, kept alongside the parsed value
  // purely so a refusal can quote it. `std::atoi` answers 0 for anything it cannot
  // read, so reporting the parsed int tells somebody who typed `--dump-every all`
  // that the problem is a '0' they never wrote, and sends them looking for it.
  const char *qualityRaw = nullptr, *dumpCountRaw = nullptr, *dumpEveryRaw = nullptr;

  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--no-color") wantColor = false;
    else if (a == "--pipeline" && i + 1 < argc) pipelineName = argv[++i];
    else if (a == "--quality" && i + 1 < argc) jpegQuality = std::atoi(qualityRaw = argv[++i]);
    else if (a == "--log" && i + 1 < argc) logLevel = argv[++i];
    else if (a == "--min-depth" && i + 1 < argc) minDepth = (float)std::atof(argv[++i]);
    else if (a == "--max-depth" && i + 1 < argc) maxDepth = (float)std::atof(argv[++i]);
    else if (a == "--no-low-light") lowLight = false;
    else if (a == "--profile") profile = true;
    else if (a == "--dump-corpus" && i + 1 < argc) dumpCorpus = argv[++i];
    else if (a == "--dump-count" && i + 1 < argc) dumpCount = std::atoi(dumpCountRaw = argv[++i]);
    else if (a == "--dump-every" && i + 1 < argc) dumpEvery = std::atoi(dumpEveryRaw = argv[++i]);
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
        "  hd_copy_us is the webcam's share: the 1080p encode itself runs on\n"
        "  another thread and is summarised separately, so what lands on the loop\n"
        "  is the copy that hands the frame over and nothing else.\n"
        "\n"
        "  On stdin, one command per line: 'low-light on|off' and\n"
        "  'hd-color on|off'. The second starts and stops the type 3 colour\n"
        "  stream the webcam output reads, and it is off until asked because a\n"
        "  1080p JPEG is roughly 215KB a frame of pipe nobody is reading.\n"
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
        "  --dump-corpus writes the inputs to Registration::apply into a\n"
        "  directory - one raw file per frame plus the calibration - so the\n"
        "  differential harness can run with no sensor attached. Frames are\n"
        "  sampled every --dump-every (default 10) so a corpus spans real scene\n"
        "  motion rather than a burst of near-identical images, and the grabber\n"
        "  exits after --dump-count (default 24) of them.\n"
        "\n"
        "stdin commands, newline terminated, applied live:\n"
        "  low-light on|off\n",
        pipelineName.c_str());
      return 0;
    }
  }

  // The numeric flags are checked here rather than where they are parsed, because a
  // later argument overwrites an earlier one and the only value worth judging is the
  // one that survives the loop.
  //
  // All three arrive through std::atoi, which reports "not a number" as 0 - so a typo,
  // a swapped argument, or the literal 0 are indistinguishable by the time the value is
  // used. --dump-every reaching the loop as 0 makes the sampling test
  // `frameCount % (uint64_t)dumpEvery` a division by zero, which on both arm64 and
  // x86-64 is SIGFPE rather than anything the program can catch. Under the server that
  // reads as a grabber dying the instant it is spawned, and the supervisor treats an
  // instant exit as the flaky USB link it was written for and respawns forever - so the
  // operator is told there is no sensor when what actually happened is that a flag was
  // not a number. --dump-count 0 is quieter and no better: the frame that would end the
  // dump can never satisfy `++dumped >= dumpCount`, so a corpus run never stops. And
  // --quality reaches tjCompress2, which is undefined outside 1-100.
  //
  // Exit 2 rather than the 1 a runtime failure returns, because these two are different
  // answers: nothing was attempted here, so there is nothing to retry or diagnose.
  if (jpegQuality < 1 || jpegQuality > 100) {
    std::fprintf(stderr, "[grabber] --quality must be an integer 1-100, got '%s'\n", qualityRaw ? qualityRaw : "");
    return 2;
  }
  if (dumpEvery < 1) {
    std::fprintf(stderr, "[grabber] --dump-every must be an integer 1 or greater, got '%s'\n", dumpEveryRaw ? dumpEveryRaw : "");
    return 2;
  }
  if (dumpCount < 1) {
    std::fprintf(stderr, "[grabber] --dump-count must be an integer 1 or greater, got '%s'\n", dumpCountRaw ? dumpCountRaw : "");
    return 2;
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

  // 1920x1082, not 1080. apply() sizes its filter map as
  // 1920*1080 + 1920*filter_height_half*2 with filter_height_half == 1, and the
  // scatter writes into the row above and below the image so it needs no bounds
  // check - so a 1080-row buffer is two rows short and it writes past the end.
  libfreenect2::Frame bigdepth(1920, 1082, 4);
  std::vector<int> colorDepthMap(DEPTH_PIXELS);

  // The calibration goes out as the raw structs rather than as JSON on purpose.
  // Registration builds its distortion and depth-to-colour maps from these floats
  // in its constructor, so a value that shifted by one ulp on the way through a
  // decimal round-trip would move the maps and make the harness report a
  // difference that only ever existed in the corpus reader.
  if (!dumpCorpus.empty()) {
    if (::mkdir(dumpCorpus.c_str(), 0755) != 0 && errno != EEXIST) {
      std::fprintf(stderr, "[grabber] cannot create %s: %s\n",
                   dumpCorpus.c_str(), std::strerror(errno));
      return 1;
    }
    const uint32_t head[4] = {CORPUS_MAGIC, CORPUS_VERSION,
                              (uint32_t)sizeof(ir), (uint32_t)sizeof(cp)};
    const void *parts[3] = {head, &ir, &cp};
    const size_t lens[3] = {sizeof(head), sizeof(ir), sizeof(cp)};
    if (!write_file(dumpCorpus + "/params.bin", parts, lens, 3)) return 1;
    std::fprintf(stderr, "[grabber] corpus into %s: %d frames, every %d\n",
                 dumpCorpus.c_str(), dumpCount, dumpEvery);
  }

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

  // Started with the stream rather than on the first request, because a thread parked
  // on a condition variable costs nothing and starting one on demand would put the
  // thread's own startup inside the latency of the first webcam frame. It encodes
  // only what `hd-color on` lets the loop below hand it.
  HdEncoder hdEncoder(jpegQuality);
  if (wantColor) hdEncoder.start();

  std::vector<uint8_t> depthOut(DEPTH_PIXELS * sizeof(uint16_t));
  std::vector<uint8_t> payload;

  libfreenect2::FrameMap depthFrames, colorFrames;
  bool haveColor = false;
  // Said once rather than per frame: a decoder producing something the webcam cannot
  // encode does it thirty times a second, and a log that repeats at frame rate is a
  // log nobody reads.
  bool hdFormatWarned = false;
  uint64_t frameCount = 0;
  uint64_t colorCount = 0;
  int dumped = 0;

  // Records are buffered and dumped at exit rather than printed per frame, so
  // the profiling I/O cannot land inside the loop it is measuring.
  struct ProfRecord {
    uint64_t arrival;
    uint32_t newColor, wait, acq, reg, conv, enc, asm_, write, jpegBytes, hdCopy;
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

    pollCommands(dev, pendingCommands, wantColor, &hdEncoder);

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

    // The webcam's picture, handed off before registration rather than after, because
    // nothing it needs happens downstream and every microsecond it waits here is
    // latency in somebody's video call.
    //
    // **Only on a new colour frame.** The loop reuses the last colour when none has
    // arrived - that is the whole point of the decoupled listeners - so submitting
    // every iteration would re-encode one picture at the depth rate and bill a
    // stationary webcam for 30fps of identical JPEGs. Gated this way, the output runs
    // at the colour camera's real rate, which halves to 15 in dim light and is the
    // honest number to show.
    uint64_t tHdCopied = tAcquired;
    if (newColor && rgb && hdEncoder.enabled()) {
      // Checked rather than assumed: both JPEG decoders this library can be built
      // with produce BGRX today, and a build that produced RGBX would hand the webcam
      // a picture with its red and blue swapped - wrong in a way that looks like a
      // colour-grading choice rather than a bug.
      if (rgb->format != libfreenect2::Frame::BGRX) {
        if (!hdFormatWarned) {
          std::fprintf(stderr, "[grabber] hd colour off: the colour decoder produced format %d, not BGRX\n",
                       (int)rgb->format);
          hdFormatWarned = true;
        }
      } else if ((int)rgb->width != CW || (int)rgb->height != CH) {
        if (!hdFormatWarned) {
          std::fprintf(stderr, "[grabber] hd colour off: the colour frame is %dx%d, not %dx%d\n",
                       (int)rgb->width, (int)rgb->height, CW, CH);
          hdFormatWarned = true;
        }
      } else {
        hdEncoder.submit((const uint8_t *)rgb->data, (size_t)CW * CH * 4, now_ms());
      }
      tHdCopied = now_us();
    }

    // Dumped before apply() rather than after, because these two frames are the
    // harness's input and apply() writes into buffers it also reads maps from.
    // Only frames carrying colour are usable: apply() refuses a null rgb, so a
    // depth-only frame would sit in the corpus as a case nothing can run.
    if (!dumpCorpus.empty() && rgb && frameCount % (uint64_t)dumpEvery == 0) {
      char path[1024];
      std::snprintf(path, sizeof(path), "%s/frame-%04d.bin", dumpCorpus.c_str(), dumped);
      const uint32_t head[8] = {
        CORPUS_MAGIC, CORPUS_VERSION,
        (uint32_t)depth->width, (uint32_t)depth->height,
        (uint32_t)rgb->width, (uint32_t)rgb->height,
        (uint32_t)rgb->format, (uint32_t)rgb->bytes_per_pixel};
      const void *parts[3] = {head, depth->data, rgb->data};
      const size_t lens[3] = {sizeof(head),
                              (size_t)depth->width * depth->height * depth->bytes_per_pixel,
                              (size_t)rgb->width * rgb->height * rgb->bytes_per_pixel};
      if (!write_file(path, parts, lens, 3)) return 1;
      if (++dumped >= dumpCount) {
        std::fprintf(stderr, "[grabber] corpus complete: %d frames\n", dumped);
        g_stop = 1;
      }
    }

    const float *depthSrc;
    if (rgb) {
      // The scratch buffers are passed in rather than left to apply(), which
      // otherwise new/deletes an 8.3MB filter map and an 868KB offset map on
      // every frame. Worth 0.30ms of registration's 5.71ms p50 on the Mac,
      // measured as an interleaved A/B on the real loop - a tight loop cannot
      // see it, because the allocator just hands the same block straight back.
      registration.apply(rgb, depth, &undistorted, &registered, true, &bigdepth, colorDepthMap.data());
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
      // The webcam's copy sits between acquisition and registration, so it comes out
      // of the span rather than being buried inside `reg`. A cost that hides in a
      // neighbouring segment is a cost the next person attributes to registration.
      r.hdCopy    = (uint32_t)(tHdCopied - tAcquired);
      r.reg       = (uint32_t)(tRegistered - tHdCopied);
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

  // Stopped before the listener releases its frame and before the counters below are
  // read, so the thread is quiescent rather than mid-encode when either happens.
  hdEncoder.stop();
  if (haveColor) colorListener.release(colorFrames);

  if (profile) {
    std::fprintf(stderr, "[prof] n,arrival_us,newColor,wait_us,acq_us,reg_us,conv_us,enc_us,asm_us,write_us,jpeg_bytes,hd_copy_us\n");
    for (size_t i = 0; i < prof.size(); i++) {
      const ProfRecord &r = prof[i];
      std::fprintf(stderr, "[prof] %zu,%llu,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u\n",
                   i, (unsigned long long)r.arrival,
                   r.newColor, r.wait, r.acq, r.reg, r.conv, r.enc, r.asm_, r.write, r.jpegBytes,
                   r.hdCopy);
    }
    std::fflush(stderr);
  }

  // The webcam's own cost, reported off the per-frame table because the encode does
  // not happen on the frame loop's clock. `dropped` is the number that says whether
  // this machine kept up: a colour frame arriving while the encoder was still busy is
  // one the webcam never showed, and a viewer counting a low frame rate needs to know
  // it was this and not the sensor.
  if (wantColor && hdEncoder.sent() > 0) {
    std::fprintf(stderr, "[grabber] hd colour: %llu sent, %llu dropped busy, %.2f ms mean encode\n",
                 (unsigned long long)hdEncoder.sent(), (unsigned long long)hdEncoder.dropped(),
                 (double)hdEncoder.encodeUs() / (double)hdEncoder.sent() / 1000.0);
  }

  if (jpegBuf) tjFree(jpegBuf);
  if (jpegCompressor) tjDestroy(jpegCompressor);
  dev->stop();
  dev->close();
  std::fprintf(stderr, "[grabber] stopped after %llu frames\n", (unsigned long long)frameCount);
  return 0;
}
