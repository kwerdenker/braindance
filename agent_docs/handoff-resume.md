# Resume: step 7's fix commit, then the own-libfreenect2 merge

Written 2026-07-31. Branch `recording-and-NLE`. HEAD is the commit that added this file;
the commit under it is `50b8d13` ("Make the takes a library, and the recorder something that
produces them" — the step-7 commit), which is also the base `own-libfreenect2` is built on,
so the merge below still applies cleanly.

Read `CLAUDE.md` first. It is not boilerplate: every rule in it exists because that exact
failure already happened in this repo, and five of them were added by the work this file
describes. Then `docs/recording-and-nle.md`, whose build order is at the end.

---

## The immediate next action

**Commit the step-7 fixes (step 1 below). Verification is complete and green.**

The final sweep on this tree: **8 clean tool runs, 87 mutations caught, nothing missed.**

One row needed chasing and is now closed. The clean `timeline` run first came back
`exit=1, pass=9, fail=0` — nine assertions passed, none failed, non-zero exit, which is a
crash wearing a catch's exit code rather than a caught failure. The log carried the
signature `CLAUDE.md` documents:

```
== 1b. clearing the accumulators empties both of them ==
page.evaluate: Execution context was destroyed, most likely because of a navigation.
    at tools/timeline-check.mjs:491:30
```

Re-run alone with nothing else driving a browser: **63 assertions, 0 failed, exit 0.** So it
was the known Playwright flake, in the same section it hit earlier in the day. It is worth
knowing that the harness classified it BROKEN rather than counting it — exit 1 with zero
failed assertions is exactly what would read as a caught failure to anything checking exit
codes.

---

## State of the working tree

Nine paths uncommitted, ~2,824 insertions. All of it is step 7's review-fix work, across
five review rounds, and it is **verified**: the last full sweep before this file was written
had eight clean tool runs and every declared mutation caught, with the single timeline crash
above as the only non-green row.

```
 M CLAUDE.md            five new method rules added by these rounds
 M server/capture.js
 M server/index.js      the route table that IS the dispatch, plus /library/writes
 M server/library.js    DocumentStore/markWrites counters
 M server/recorder.js   the drain fix — this is the important one
 M tools/library-check.mjs   158 -> 253 assertions, 18 -> 46 mutations
 M web/library.js
 M web/main.js
?? server/http-guard.js     new: requireMutation + originAllowed
```

Clean-run assertion counts to expect: index 42, registry 53, timeline 63, keyframe 131,
export 35, library 253, both determinism arms.

---

## What has to happen, in order

### 1. Commit the step-7 fixes — NOT an amend

The body is written at `agent_docs/step7-fixes-commit-message.txt` (220 lines, in the
135–291 range the other commits here occupy). Subject: *Close what review found in the
recorder, and in the checks that missed it*.

```
git add -A && git commit -F agent_docs/step7-fixes-commit-message.txt
```

**Do not amend `50b8d13`.** This was decided deliberately and reversing it breaks the merge
— see the decision log and the reasoning below.

### 2. Merge `own-libfreenect2`

Eight commits, based on `50b8d13`, vendoring libfreenect2 at upstream v0.2.1 into
`third_party/` and optimising registration twice. Body drafted at
`agent_docs/merge-commit-message.txt`.

```
git merge own-libfreenect2 --no-ff
```

**One file conflicts: `CLAUDE.md`.** Resolution is pre-planned at
`agent_docs/claudemd-merge-resolution.md` — of seven hunks only one pair collides, both
inserting into the proof-tools block. Resolve as a **union**; the two sides describe
different things and neither supersedes the other. That file also lists two corrections the
merge forces (a missing `library-check` invocation line, and a "Both tools" that must become
"all six").

### 3. Rebuild libfreenect2 — this is a trap

```
cmake -S third_party/libfreenect2 -B vendor/build -DCMAKE_INSTALL_PREFIX=vendor/prefix   # see README.md for the full flags
cmake --build vendor/build --target install -j8
```

**If you skip this nothing breaks loudly and the optimisation is silently gone.** The
grabber's new call passes two optional out-parameters any libfreenect2 0.2 accepts, so an
old prefix still links and still streams — single-threaded and reallocating per frame.
`vendor-check` will still pass, because it verifies the *source* tree, not the library built
from it. Note `vendor/` is a **symlink to a shared checkout** in this worktree, so a rebuild
here mutates what the `master` worktree uses.

### 4. Run the two new proof tools

```
node tools/vendor-check.mjs
node tools/registration-check.mjs
```

`registration-check` needs `captures/reg-corpus`, which is gitignored and **not in this
worktree** — it exists in the `own-libfreenect2` worktree (629 MB, 32 frames, provenance
recording upstream `fd64c5d9…` which matches v0.2.1). Point the check at it or copy it; it
does **not** need the sensor. Both tools take `--mutate` and must exit non-zero *having
fired assertions*. `registration-check` exits **2** for a build/runtime failure and **1**
only when assertions fired — count failed assertions, never exit codes.

### 5. Confirm the grabber still streams

The Kinect is **on the Raspberry Pi capture node, not the Mac**. So "still streams" is
provable here against the replay path and `tools/fake-grabber.mjs`, and a real sensor stream
needs the hardware moved. Say which of those you proved; do not blur them.

---

## Decisions already made — do not re-litigate

**Second commit, not an amend.** Amending `50b8d13` orphans the base `own-libfreenect2` is
built on: the merge would drag the original `50b8d13` back in through the branch and history
would carry two commits both claiming to be step 7, one containing a footage-loss
regression. The alternative was rebasing a branch that another worktree currently has
checked out. It also fixed a real problem — the amended body had reached 355 lines carrying
both what step 7 built and four rounds of what review found; split in two, each says one
thing.

**Merge, not rebase or cherry-pick.** Shared base, one-file conflict. The tiebreaker is that
in this repo the commit bodies *are* the documentation — eight bodies carrying interleaved
A/B tables with their methods is what rebasing risks for no gain. It is also ruled out
mechanically: the branch is checked out in a live worktree.

**`CLAUDE.md` resolves as a union, not by taking a side.**

**The during-drive size check was considered and rejected.** Asserting the open take's
on-disk size minus the recorder's `state.bytes` *during* the route sweep looked exact — 40
samples over a 40fps take read 0 every time — but the zero is a syscall-width window, not a
guarantee: bytes reach disk before the callback moves `bytesWritten`, so a sample inside a
write reads one frame high. The identity is asserted **after the take closes** instead,
where nothing is in flight. Do not add a during-drive copy: one exact row beats two where
the extra one can lie.

**The query-parameter plant is a known, unclosed hole**, recorded in the route sweep's own
section comment. A handler that mutates only on an undeclared query parameter is outside the
*drive* rather than the snapshot, and no enumeration of the route table can reach a parameter
the table does not declare. The only idea anyone had was a lint over `read` handlers that
touch `query` at all, which is a different kind of tool.

**Thread count is 2 on the capture node, from a sweep run there.** The Mac's answer was 4,
and 4 was the worst setting on the node. Do not change it without measuring on the node.

---

## Open items, in priority order

**`vendor-check` asserts its condition rather than enforcing it.** This is the repo's
signature failure aimed at the tool that proves the vendoring, and it is recorded in the
merge commit body rather than fixed. It proves the *source tree* is upstream plus the
declared edit, and passes identically whether the linked library was built from that tree or
from a stale prefix built from something else. The branch knows the principle and applied it
one file over — `registration-check` rebuilds both prefixes every run precisely because
"nothing about a stale library looks wrong". The falsification control it needs is a prefix
built from different source, which must FAIL.

**The sweep script belongs in `tools/`.** `agent_docs/sweep-all.mjs` enumerates each tool's
mutation list from its own refusal message (`--mutate __enumerate__` prints `have a, b, c`)
rather than a list written beside it. That matters: the hardcoded list it replaced had
eighteen library mutations when there were thirty-seven, so it would have swept 59 of 78 and
printed a clean pass. Its own commit, after the security one.

**A security commit is drafted but not written**, and deliberately kept out of every fix
round — all five reserved regions in `server/index.js` (the `upgrade` handler, both
`WebSocketServer` constructions, both `connection` handlers, and `listen`) are byte-identical
to `50b8d13` so this commit can own them. Two changes: call `originAllowed` from
`server/http-guard.js` on the WebSocket upgrade — it is exported without a response to write
to for exactly this reason, since the upgrade has a raw socket rather than a `res` — and give
`listen()` a host argument defaulting to loopback with an explicit flag to widen. No token;
the OSS framing removed the argument for one. State DNS rebinding there: it defeats host
equality generally (a name resolving to the node's LAN address makes `Origin` and `Host`
genuinely equal), which is the argument for the loopback default rather than a hole in the
guard. **`http-guard.js`'s docstring currently says `requireMutation` is its only caller —
that wording should change back when the upgrade actually calls it, not before.**

**Steps 8 and 9 remain.** Step 8 is the job queue and headless worker; a brief exists but
lives in a session scratchpad and is gone — rewrite it from `docs/recording-and-nle.md`'s
"Deferred and remote encoding" section. Two things it must carry: the namespace seam (after
the route table, `server/index.js` sends anything under
`/(capture|library|projects|presets|record)` to a 404 and everything else to the static file
server — `jobs` is not in that regex, so `/jobs/...` falls through and `/jobs/../web/main.js`
traverses; derive the list from `ROUTES`), and the fact that `server/export.js` already
writes a job record carrying `project`, `capture` and `renderer` because step 6 put those
there for step 8. Step 9 now **builds** libfreenect2 from `third_party/` rather than
provisioning it from scratch, which this merge makes true.

**This step narrows step 9 and it is written into the commit body:** the take being written
answers 409 on its capture routes, so decimated frames cannot be pulled over HTTP for a take
in progress and the spec's "negotiate decimation while recording" has to be socket-side.

---

## Dead ends — already tried, do not repeat

- **Waiting on `SUMMARY.txt` to decide a sweep finished.** It is written once, at the end, so
  the previous run's file answers immediately and you read stale totals as the current run's.
  This cost a wrong reading of 78 mutations while a run was 17 into 85. `agent_docs/sweep-all.mjs`
  now removes it at start. Wait on the process, not the artifact.
- **Narrowing `writes-take-any-method`** so each guard mutation fails only its own row. There
  is no narrower version: the first edit alone leaves the page unchanged because
  `requireMutation` still answers 405 to a GET.
- **`utimesSync` to build a write-then-restore plant.** It failed both rows for the wrong
  reason — APFS keeps nanoseconds, a `Date` carries milliseconds, so what failed was the
  0.13ms the restore could not put back. On a coarser filesystem the same plant walks
  through. The working plant is write-then-remove, which touches nothing that survives.
- **Hoisting registration's scratch buffers measured offline.** Came out *slower* in all three
  paired rounds, because two arms both hitting the allocator back to back are not an A/B of
  allocation cost. On the real loop it is worth 0.30ms of 5.71ms.

---

## How verification works here, in one paragraph

Every proof tool takes a running server and exits non-zero on failure, and every one carries
a falsification control. `--mutate <name>` serves a deliberately broken file into the running
server and **must** exit non-zero *having fired assertions*. **Count failed assertions, never
exit codes** — a refused mutation anchor, a Playwright context destruction, and a real catch
all exit non-zero, so `fails=0` is a crash to investigate rather than a success to record.
This has caught real problems twice in one day: a plant batch that came back four-for-four
exit=1 with zero assertions because a string-literal bug killed every run at import, and the
timeline crash above. A mutation is a piece of source text, so it stops anchoring the moment
the code it names is edited; both tools refuse a mutation whose text they cannot find exactly
once, and that refusal is the thing that surfaces a stale anchor rather than a silent pass.
