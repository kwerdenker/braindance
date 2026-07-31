#!/bin/bash
# Measures what threading registration is actually worth on a capture node.
#
# Run this on the Pi, with the sensor attached, once step 9 has provisioned it.
# It is not run as part of step 9 and nothing depends on it - the driver works
# either way, and this only decides whether the threading earns its place there.
#
# The Mac measurement it exists to complete is in third_party/UPSTREAM.md:
# 5.76ms to 3.69ms p50, 36%, on twelve cores. The Pi has four, and registration
# there is 13.13ms of a 15.05ms serial half, so both the scaling and the payoff
# are open questions rather than a smaller version of the same answer.
#
# Two arms, two libraries, not one binary with a thread count. Comparing
# LIBFREENECT2_REG_THREADS=1 against =4 would measure our banded scatter against
# itself; the arm that matters is upstream's own inline scatter, which is what
# would otherwise ship. So this builds two prefixes and two grabbers, exactly as
# the Mac run did, and checks with ldd that they load different libraries.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD
OUT=${OUT:-/tmp/pi-reg-ab}
ROUNDS=${ROUNDS:-3}
CHECKPOINTS=${CHECKPOINTS:-7}   # 150 frames each, so ~7 is a 35s window
THREADS=${THREADS:-4}

mkdir -p "$OUT"

# V3D has OpenGL and no OpenCL, which is the reverse of the Mac. Asking for a
# pipeline the library was not compiled with is an error rather than a silent
# fall-through, so this has to be right rather than approximately right.
CMAKE_COMMON=(-DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DENABLE_CXX11=ON
              -DENABLE_CUDA=OFF -DENABLE_OPENCL=OFF -DENABLE_OPENGL=ON)

echo "== verifying the vendored tree before building anything from it =="
node tools/vendor-check.mjs

echo "== building the upstream arm =="
rm -rf "$OUT/upstream-src"
cp -r third_party/libfreenect2 "$OUT/upstream-src"
cp third_party/oracle/registration.cpp "$OUT/upstream-src/src/registration.cpp"
cmake -S "$OUT/upstream-src" -B "$OUT/build-upstream" \
  "${CMAKE_COMMON[@]}" -DCMAKE_INSTALL_PREFIX="$OUT/prefix-upstream" > "$OUT/build-upstream.log" 2>&1
cmake --build "$OUT/build-upstream" --target install -j4 >> "$OUT/build-upstream.log" 2>&1

echo "== building the threaded arm =="
cmake -S third_party/libfreenect2 -B "$OUT/build-threaded" \
  "${CMAKE_COMMON[@]}" -DCMAKE_INSTALL_PREFIX="$OUT/prefix-threaded" > "$OUT/build-threaded.log" 2>&1
cmake --build "$OUT/build-threaded" --target install -j4 >> "$OUT/build-threaded.log" 2>&1

echo "== building both grabbers =="
cmake -S native -B "$OUT/grabber-upstream" -DFREENECT2_ROOT="$OUT/prefix-upstream" > /dev/null
cmake --build "$OUT/grabber-upstream" --target grabber -j4 > /dev/null
cmake -S native -B "$OUT/grabber-threaded" -DFREENECT2_ROOT="$OUT/prefix-threaded" > /dev/null
cmake --build "$OUT/grabber-threaded" --target grabber -j4 > /dev/null

# If both arms resolve the same library the comparison is a tautology that would
# report a clean nil result forever, so it is checked rather than assumed.
UP_LIB=$(ldd "$OUT/grabber-upstream/grabber" | grep -o '[^ ]*libfreenect2[^ ]*' | head -1)
TH_LIB=$(ldd "$OUT/grabber-threaded/grabber" | grep -o '[^ ]*libfreenect2[^ ]*' | head -1)
echo "upstream arm loads: $UP_LIB"
echo "threaded arm loads: $TH_LIB"
if [ "$UP_LIB" = "$TH_LIB" ]; then
  echo "FAIL both arms load the same library - this is not a differential measurement"
  exit 1
fi

run() { # $1=label  $2=grabber
  LIBFREENECT2_REG_THREADS=$THREADS "$2" --profile > /dev/null 2> "$OUT/$1.txt" &
  local pid=$!
  until [ "$(grep -c 'frames (' "$OUT/$1.txt" 2>/dev/null || echo 0)" -ge "$CHECKPOINTS" ]; do sleep 1; done
  kill -INT "$pid"; wait "$pid" 2>/dev/null || true
  echo "  $1 done"
}

# Interleaved, never sequential. A sequential before/after on this project's rig
# once produced a 23% figure that was really 12.9%; drift between measurement
# sessions accounted for the rest.
echo "== running $ROUNDS interleaved rounds =="
for r in $(seq 1 "$ROUNDS"); do
  run "up$r" "$OUT/grabber-upstream/grabber"
  run "th$r" "$OUT/grabber-threaded/grabber"
done

echo
echo "== results =="
BAD=0
for r in $(seq 1 "$ROUNDS"); do
  for arm in up th; do
    line=$(node tools/prof-summary.mjs "$OUT/$arm$r.txt" 60 --json)
    fps=$(echo "$line" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).fps.toFixed(2)))')
    reg=$(echo "$line" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).seg.reg.p50.toFixed(2)))')
    printf "  %-3s round %s   reg p50 %6s ms   delivered %6s fps\n" "$arm" "$r" "$reg" "$fps"
    # On four cores, four threads compete with the depth solve's own
    # AsyncPacketProcessor and the GL processor. Oversubscription shows up as
    # dropped frames, not as slower registration - so an arm that improved reg
    # while losing frames has made things worse, and reading reg alone would
    # record that as a win.
    if [ "$(echo "$fps < 29.5" | bc -l)" = "1" ]; then
      echo "         ^ below 29.5fps: this arm was dropping frames, its timings do not count"
      BAD=1
    fi
  done
done

echo
if [ "$BAD" = "1" ]; then
  echo "VERDICT  unusable - at least one arm did not sustain rate. Check for other load"
  echo "         and re-run; do not report the millisecond figures above."
  exit 1
fi
echo "VERDICT  all arms sustained rate. Compare reg p50 per round; every paired"
echo "         delta should have the same sign before this is called a result."
