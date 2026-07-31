// Runs Registration::apply over a corpus and writes its raw output planes.
//
// This is compiled twice - once linked against a pristine upstream-v0.2.1 build
// of libfreenect2 and once against ours - and the two output files are compared
// byte for byte. That is why the comparison lives outside the binary: linking
// two versions of the same symbol into one process would need the oracle
// renamed, and a renamed oracle is no longer upstream's file. Two builds of one
// source keeps the reference byte-verbatim.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <string>
#include <vector>
#include <chrono>
#include <algorithm>

#include <libfreenect2/libfreenect2.hpp>
#include <libfreenect2/registration.h>
#include <libfreenect2/frame_listener.hpp>

static const uint32_t CORPUS_MAGIC = 0x4B435250; // 'KCRP'
static const int DW = 512, DH = 424;

static std::vector<uint8_t> slurp(const std::string &path) {
  std::FILE *f = std::fopen(path.c_str(), "rb");
  if (!f) { std::fprintf(stderr, "cannot open %s\n", path.c_str()); std::exit(2); }
  std::fseek(f, 0, SEEK_END);
  long n = std::ftell(f);
  std::fseek(f, 0, SEEK_SET);
  std::vector<uint8_t> buf((size_t)n);
  if (std::fread(buf.data(), 1, (size_t)n, f) != (size_t)n) {
    std::fprintf(stderr, "short read on %s\n", path.c_str()); std::exit(2);
  }
  std::fclose(f);
  return buf;
}

int main(int argc, char **argv) {
  std::string corpus, out;
  // Persistent scratch is the call-site change under test, not a library change:
  // apply() new/deletes an 8.3MB filter map and an 868KB offset map every call
  // unless it is handed somewhere to put them.
  bool persistent = false;
  int repeats = 1;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--corpus" && i + 1 < argc) corpus = argv[++i];
    else if (a == "--out" && i + 1 < argc) out = argv[++i];
    else if (a == "--persistent") persistent = true;
    else if (a == "--repeats" && i + 1 < argc) repeats = std::atoi(argv[++i]);
    else { std::fprintf(stderr, "usage: reg-runner --corpus DIR --out FILE [--persistent] [--repeats N]\n"); return 2; }
  }
  if (corpus.empty() || out.empty()) { std::fprintf(stderr, "need --corpus and --out\n"); return 2; }

  std::vector<uint8_t> p = slurp(corpus + "/params.bin");
  libfreenect2::Freenect2Device::IrCameraParams ir;
  libfreenect2::Freenect2Device::ColorCameraParams cp;
  const uint32_t *ph = (const uint32_t *)p.data();
  if (ph[0] != CORPUS_MAGIC || ph[2] != sizeof(ir) || ph[3] != sizeof(cp)) {
    std::fprintf(stderr, "params.bin is not a corpus this build understands\n"); return 2;
  }
  std::memcpy(&ir, p.data() + 16, sizeof(ir));
  std::memcpy(&cp, p.data() + 16 + sizeof(ir), sizeof(cp));

  libfreenect2::Registration registration(ir, cp);
  libfreenect2::Frame undistorted(DW, DH, 4), registered(DW, DH, 4);

  // 1920x1082, not 1080: apply() sizes its filter map as
  // 1920*1080 + 1920*filter_height_half*2 with filter_height_half == 1, so a
  // 1080-row buffer is two rows short and it writes past the end.
  libfreenect2::Frame bigdepth(1920, 1082, 4);
  std::vector<int> colorDepthMap((size_t)DW * DH);

  std::FILE *of = std::fopen(out.c_str(), "wb");
  if (!of) { std::fprintf(stderr, "cannot write %s\n", out.c_str()); return 2; }

  std::vector<double> times;
  int frames = 0;
  for (int idx = 0;; idx++) {
    char path[1024];
    std::snprintf(path, sizeof(path), "%s/frame-%04d.bin", corpus.c_str(), idx);
    std::FILE *probe = std::fopen(path, "rb");
    if (!probe) break;
    std::fclose(probe);

    std::vector<uint8_t> f = slurp(path);
    const uint32_t *h = (const uint32_t *)f.data();
    if (h[0] != CORPUS_MAGIC) { std::fprintf(stderr, "%s: bad magic\n", path); return 2; }
    const size_t dW = h[2], dH = h[3], cW = h[4], cH = h[5], cBpp = h[7];
    const size_t depthBytes = dW * dH * 4;
    uint8_t *depthData = f.data() + 32;
    uint8_t *colorData = depthData + depthBytes;

    libfreenect2::Frame depth(dW, dH, 4, depthData);
    libfreenect2::Frame rgb(cW, cH, cBpp, colorData);
    rgb.format = (libfreenect2::Frame::Format)h[6];

    for (int r = 0; r < repeats; r++) {
      auto t0 = std::chrono::steady_clock::now();
      if (persistent) registration.apply(&rgb, &depth, &undistorted, &registered, true, &bigdepth, colorDepthMap.data());
      else registration.apply(&rgb, &depth, &undistorted, &registered);
      auto t1 = std::chrono::steady_clock::now();
      times.push_back(std::chrono::duration<double, std::milli>(t1 - t0).count());
    }

    // Both planes go out. `registered` is the colour resample everyone looks at,
    // but `undistorted` is what the grabber actually converts to u16 millimetres
    // and ships as depth, so a change that only moved depth would be invisible
    // if the harness compared the pretty one.
    std::fwrite(undistorted.data, 1, (size_t)DW * DH * 4, of);
    std::fwrite(registered.data, 1, (size_t)DW * DH * 4, of);
    frames++;
  }
  std::fclose(of);

  if (frames == 0) { std::fprintf(stderr, "no frames found in %s\n", corpus.c_str()); return 2; }

  std::sort(times.begin(), times.end());
  std::fprintf(stderr, "frames=%d calls=%zu apply_p50=%.3fms apply_p90=%.3fms persistent=%d\n",
               frames, times.size(), times[times.size() / 2],
               times[(size_t)(times.size() * 0.9)], persistent ? 1 : 0);
  return 0;
}
