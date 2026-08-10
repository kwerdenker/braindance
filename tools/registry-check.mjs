// Proves that one registry drives the renderer, and that the panel is a view on it.
//
// Four claims, and they fail for different reasons, so they are checked apart.
//
// A parameter has to *land*. Setting it through the registry must reach the place
// the renderer actually reads - a uniform, a pass property, a pass `enabled` flag,
// the draw range, the drawing buffer - and several parameters do more than set a
// uniform, so the side effects are checked as side effects rather than assumed to
// come along. The landing sites are written out here rather than asked of the
// page, because a registry reporting its own values back would agree with itself
// whatever it did with them.
//
// The panel has to be a *view*. Both directions: a slider event has to move the
// registry, and a registry write has to move the slider and its readout. And the
// HTML has to carry no parameter data at all - no value, min, max, step or checked
// on a registry-owned input - or the range lives in two places again and step 6's
// headless renderer reads the copy that is wrong.
//
// The values have to *round-trip through an image*. Serialise the registry, render
// a pinned run and hash it, restore from the serialised set, render again: the
// same pixels. That is the property steps 5, 6 and 7 all rest on, so it gets a
// falsification control - every parameter is left out of the restore in turn, and
// omitting one has to change the image. Without that, the equality above would
// pass just as well against a registry wired to nothing.
//
// And nothing may have *moved*. The two built-in mode presets and the boot state
// are compared against the committed page rather than against a table typed in
// here, by serving `git show <rev>:web/{index.html,main.js}` into a second load.
// A table would only restate what the new code does.
//
//   node server/index.js --port 8080 --replay captures/sample.knct &
//   node tools/registry-check.mjs --url http://localhost:8080

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { MessageParser, TYPE_FRAME } from '../server/protocol.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

// Everything the check reads about the repo is resolved against this file rather
// than against the working directory: the panel it inspects, the capture it pins,
// and the tree `git show` reads the before-arm out of. A tool that only runs from
// one directory is a tool that gets run from the wrong one.
const REPO = fileURLToPath(new URL('..', import.meta.url));

const URL_BASE = flag('--url', 'http://localhost:8080');
// The live recorder, which `/` served until the main menu took that path. Named
// once because the page is opened at it and the before-arm's markup is
// intercepted by it, and those two have to agree or the interception misses.
const RECORDER_PATH = '/record';
const CAPTURE = flag('--capture') ?? join(REPO, 'captures/sample.knct');
// Not HEAD: once step 3 is committed, HEAD is the registry and the before-arm would
// be comparing the tree against itself. And not a literal hash either, which is what
// this was until preparing the repository for release rewrote the history - stripping
// commit trailers with `git filter-repo` moves every hash after the first rewritten
// commit, so the pinned rev named nothing and the tool died inside `git show` with
// `invalid object name` before asserting anything. That exits non-zero and reads
// exactly like a check that ran and failed.
//
// A marker is content rather than identity, so it survives a rewrite. The refusal
// below stays the control: a search that resolved to the wrong commit trips it.
const BEFORE_REV = flag('--before') ?? revBeforeMarker('const PARAMS');

function revBeforeMarker(marker) {
  const introduced = execFileSync(
    'git', ['log', '-S', marker, '--format=%H', '--reverse', '--', 'web/main.js'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 },
  ).split('\n')[0].trim();
  if (!introduced) {
    throw new Error(`no commit in this history introduces ${JSON.stringify(marker)} to web/main.js`);
  }
  return `${introduced}^`;
}
// ------------------------------------------------------------------ mutations
//
// This file had no mutations for its whole life, and the rewrite that put the readings
// in the registry is what made that untenable. The blend is arithmetic in a shader
// compiled by a driver, and the two claims this tool now rests on - that a single
// reading is the identity and that a mix is a ratio - are precisely the kind that pass
// by construction when the instrument is pointed slightly wrong. A check nobody has
// broken on purpose is a check nobody knows the sensitivity of.
//
// Each entry names the row it must redden, and they are chosen to redden *different*
// rows: a mutation that fails everything cannot say which claim is load-bearing, which
// is the same reason `expand-shifts-by-a-block` exists beside `bind-ignores-grid` in
// monitor-check.
const MUTATIONS = {
  // Section 1b, the readRgb row and only that row. Alpha is the asymmetric half of this
  // blend and the place a rewrite of it actually breaks: three readings multiply
  // `alpha` and two do not, so the two that do not have to contribute a factor of
  // exactly 1.0 to the accumulator rather than nothing at all. A build that forgot
  // renders RGB completely transparent while every other reading stays correct.
  //
  // **This replaced a mutation that was caught for the wrong reason**, which is worth
  // recording because it is the failure this repo keeps producing in the direction that
  // looks like coverage. `blend-drops-alpha` removed the `* norm` from the alpha line
  // and claimed the three alpha-writing rows of 1b; measured, it left the whole of 1b
  // passing and reddened 8b instead - because at a single reading `norm` is 1.0 and
  // dropping a multiplication by 1.0 is not a mutation at all. It was a second, weaker
  // spelling of `mix-ignores-normalisation`, indistinguishable from it by the rows that
  // went red, so it could not tell anybody which claim was load-bearing.
  'rgb-contributes-no-alpha': {
    from: '    alphaFactor += readRgb;',
    to: '    alphaFactor += 0.0;',
    fails: 'the readRgb row of 1b, alone - the other four readings are untouched',
  },
  // Section 1b, the readGhost row and only that row. The three alpha-writing readings
  // had their expressions moved verbatim out of the old branches, so what is at risk
  // there is transcription rather than arithmetic - and a check that compared only
  // colour would pass a build that dropped a term from one of them.
  'ghost-alpha-term-dropped': {
    from: '    alphaFactor += (0.25 + 0.75 * rim + 0.25 * lum) * readGhost;',
    to: '    alphaFactor += (0.25 + 0.75 * rim) * readGhost;',
    fails: 'the readGhost row of 1b, alone - so 1b compares alpha and not just colour',
  },
  // Section 8b: the mix stops being a ratio while every single reading stays exactly
  // right, because dividing by 1.0 is what dividing by the sum already does when one
  // weight is 1 and the rest are 0. This is the mutation section 1b cannot see and the
  // whole reason 8b exists.
  'mix-ignores-normalisation': {
    from: 'float norm = readSum > 0.0 ? 1.0 / readSum : 0.0;',
    to: 'float norm = readSum > 0.0 ? 1.0 : 0.0;',
    fails: 'the scale-cancels row of 8b, with every row of 1b still passing',
  },
  // Section 8's falsification sweep: one weight reaches no pixel. Dropping it from the
  // restore then changes nothing, so it lands in the no-effect bucket, which is a
  // failure unless the name is in the declared exceptions - and it is not.
  // Its reach widened when the readings grew constants of their own, and the record says
  // so rather than being left at the number it was caught with once: switching the ghost
  // block off takes `ghostRim` and `ghostFill` into the no-effect bucket with it, because
  // a per-reading term is only observable through the reading it belongs to. Three names
  // in that bucket rather than one is the right answer here, and a fourth would mean a
  // parameter had quietly become reachable only from ghost.
  'weight-ignored': {
    from: '  if (readGhost > 0.0) {',
    to: '  if (false) {',
    fails: 'readGhost, ghostRim and ghostFill in the drop-one sweep, plus readGhost\'s 1b row',
  },
  // The duotone's amount reaches no pixel, and it takes the hue, the split and the motion
  // term down with it - the `weight-ignored` shape one block up, for the same structural
  // reason. All three are only observable through the block this switches off, so four
  // names land in the no-effect bucket and none of them is declared there. Four is the
  // right answer and a fifth would mean some other parameter had quietly become reachable
  // only through the duotone.
  'duotone-ignored': {
    from: '  if (duotoneDepth > 0.0) {',
    to: '  if (false) {',
    fails: 'duotoneDepth, duotoneHue, duotoneSplit and duotoneMotion in the drop-one sweep, '
      + 'plus the planted section\'s two motion rows, which the block being off takes with it',
  },
  // The sharper half of the one above, and the reason both are kept: the duotone goes on
  // working as a flat tint, so `duotoneDepth` still moves pixels and only the split stops
  // meaning anything. That is the difference between "the term is wired up" and "the term
  // is keyed on depth", and depth is the whole claim - a duotone that is not depth-keyed
  // cannot draw the silhouette this parameter exists for, which is exactly the shape of
  // failure that ships looking like a control that works.
  'duotone-ignores-depth': {
    from: '    float k = smoothstep(duotoneSplit - w * 0.5, duotoneSplit + w * 0.5, t);',
    to: '    float k = 0.5;',
    fails: 'duotoneSplit and duotoneSpan in the drop-one sweep - the amount and the hue still '
      + 'reach pixels, and the span goes with the split because the ramp it widens is gone - '
      + 'plus the metre section\'s control row, since a ramp replaced by a constant cannot be '
      + 'widened either',
  },
  // The ramp's width promoted back to the literal it replaced, so the span is a slider that
  // lands in a uniform nothing reads. The plain shape, and the drop-one sweep is what sees
  // it: a parameter whose picture never changes when you take it away.
  'duotone-span-ignored': {
    from: '    float w = duotoneSpan / max(0.001, farClip - nearClip);',
    to: '    float w = 1.0;',
    fails: 'duotoneSpan in the drop-one sweep - every other duotone term still reaches pixels, '
      + 'since the ramp goes on running at the width it had before this parameter - and the whole '
      + 'of the metre section, whose two invariance rows read a ramp that is once again a share '
      + 'of the box and whose control row cannot widen it',
  },
  // **The one that matters, and it is built so the sweep above cannot see it.** The span is
  // divided by a frozen 5.95 instead of by the clip range the picture is actually normalised
  // against - so at the default range the two are the same number, every image in the sweep
  // is bit-identical, and the parameter goes on proving it reaches pixels. What breaks is the
  // only claim this change makes: that the ramp is a distance. Move `far` and the mutated
  // build re-grades every point while the shipped one holds still, which is the coupling this
  // parameter was added to remove, reinstated in a form nothing that renders one range can
  // detect.
  'duotone-span-against-a-frozen-range': {
    from: '    float w = duotoneSpan / max(0.001, farClip - nearClip);',
    to: '    float w = duotoneSpan / 5.95;',
    fails: 'the duotone span\'s two invariance rows, which render the same take at two clip '
      + 'ranges and hold the graded band still in metres - and nothing else, because at the '
      + 'default range this mutation is the shipped arithmetic',
  },
  // The speed never computed, so the motion half of the duotone has nothing to key on.
  // This is the plain one: a parameter whose slider moves, whose uniform lands and whose
  // pixels never change, which is what the drop-one sweep is for. It reddens the planted
  // section's motion rows too, and those are the rows that say the sweep is measuring the
  // speed rather than something else that moved with it.
  'vspeed-ignored': {
    from: '    vSpeed = paired ? abs(mmC - mmP) / spanSec : 0.0;',
    to: '    vSpeed = 0.0;',
    fails: 'duotoneMotion in the drop-one sweep and the proven-parameter count beneath it, '
      + 'plus the planted section\'s two motion rows - the one that says a planted pair moves '
      + 'the picture and the one that says it moves it toward the hot pole',
  },
  // **The one that matters.** The speed stops being divided by the pair's own gap, so it
  // is a per-frame difference wearing the name of a rate. Every picture still changes,
  // every uniform still lands, the drop-one sweep stays green, and a look graded at 30fps
  // renders differently over a degraded link - which is the one condition nobody grades
  // in. Nothing here could see it before the planted section existed, because both arms
  // of every comparison in this file run at the same frame rate by construction.
  'vspeed-unnormalised': {
    from: '    vSpeed = paired ? abs(mmC - mmP) / spanSec : 0.0;',
    to: '    vSpeed = paired ? abs(mmC - mmP) : 0.0;',
    fails: 'the same-speed-over-two-spans row of the planted section, alone - the drop-one '
      + 'sweep stays green, and so do the two rows either side of it',
  },
  // The discontinuity half of the pairing test dropped from the speed and left on the
  // blend, so a ray that crossed a silhouette reports the distance to the wall behind the
  // subject as a speed. The fixture has 52 such samples in five pairs, which is far too
  // few for any hashed run over it to notice, so the only thing that can see this is a
  // pair planted across the threshold on purpose.
  'vspeed-ignores-the-gate': {
    from: '    vSpeed = paired ? abs(mmC - mmP) / spanSec : 0.0;',
    to: '    vSpeed = mmP > 0.0 ? abs(mmC - mmP) / spanSec : 0.0;',
    fails: 'the row that says a jump past the snap threshold is a different surface, alone',
  },
  // The speed read off one fixed texel rather than the point's own, which is the failure a
  // uniformly-moving plant is invariant under - and asking what a fixture is invariant under
  // is the rule `docs/instruments.md` puts hardest. A wall planted at one speed renders
  // identically whether the varying is per point or a single number wearing a varying's name,
  // so the section grew a plant whose speed differs across the frame in order to have this
  // question at all. The blend keeps the point's own sample, so nothing about the geometry
  // moves and section 1b is untouched.
  'vspeed-reads-one-texel': {
    from: '    vSpeed = paired ? abs(mmC - mmP) / spanSec : 0.0;',
    to: '    vSpeed = paired ? abs(mmC - depthAt(depthPrev, ivec2(0))) / spanSec : 0.0;',
    fails: 'the two chequered-plant rows of the planted section - the one that says the '
      + 'chequer is neither of the uniform frames and the one that says its mean red sits '
      + 'between them',
  },
  // The term made very slightly not-inert at its default, which is the control for the row
  // that says a motion of 0 draws exactly what the block drew before this term existed. That
  // row is an equality and equalities are the ones worth pointing a mutation at: nothing else
  // in this file can fail on a default that leaks, because every other comparison here either
  // has the term raised on both sides or has the block switched off entirely.
  'motion-leaks-at-zero': {
    from: '    k = mix(k, 1.0, duotoneMotion * smoothstep(0.0, 1200.0, vSpeed));',
    to: '    k = mix(k, 1.0, (duotoneMotion + 0.02) * smoothstep(0.0, 1200.0, vSpeed));',
    fails: 'the motion-of-0-is-inert row, alone - every other row has the term raised on '
      + 'both sides or has nothing moving on either',
  },
  // The pair's gap replaced by the nominal one, which is a build that computes speeds
  // from a frame rate it assumed rather than from the frames it holds. Every picture
  // still changes and the sweep is green, because a speed scaled by a constant is still
  // a speed that reverting the parameter removes. The planted rows cannot see it either -
  // they write the span themselves, which is what makes this a probe that has to sit
  // somewhere else: on the real transport, against the times the drive reports.
  'spansec-nominal': {
    from: '    return { steps, mixT: offset / span, sinceFrameSec: offset, spanSec: span };',
    to: '    return { steps, mixT: offset / span, sinceFrameSec: offset, spanSec: 1 / 30 };',
    fails: 'the row that holds spanSec against the gaps between the pinned frames, alone',
  },
  // The unit conversion dropped, which is a defect no image comparison can see the shape
  // of: the poles still turn, the picture still changes, and every sweep row that asks
  // whether the slider reaches a pixel goes on passing. What separates the two builds is
  // the number at the uniform, so the landing row is the only thing that can fail here.
  'duotone-hue-in-degrees': {
    from: '    apply: (v) => { uniforms.duotoneHue.value = THREE.MathUtils.degToRad(v); } },',
    to: '    apply: (v) => { uniforms.duotoneHue.value = v; } },',
    fails: 'the duotoneHue row of the one-at-a-time landing sweep, reporting "landed 47 want '
      + '0.8203047484373349", and the all-at-once row beside it - that second one is the same '
      + 'comparison over the whole set rather than a separate finding',
  },
  // The toe goes back to being the literal it was promoted from. Nothing about the
  // rendered default changes - that is the point, since the default *is* the literal - so
  // the only row that can see it is the drop-one sweep, where reverting a parameter that
  // reaches nothing changes no pixel.
  'crush-ignored': {
    from: '      col = max(col - crush, 0.0) * 1.12;',
    to: '      col = max(col - 0.018, 0.0) * 1.12;',
    fails: 'crush in the drop-one sweep, alone',
  },
  // The guard around the raster's default path removed, so the general form computes what
  // the old line computed instead of reaching it. Every value stays what it was and the
  // arithmetic is algebraically the same, which is the whole difficulty: a reader deleting
  // this branch as a redundant fast path would see nothing wrong, and the shipped Blackwall
  // document would start drawing a raster a hair off the one it was graded with.
  //
  // This control is also how the guard was justified rather than assumed. Run it and read
  // the raster row: red means the general form genuinely drifts and the branch is load
  // bearing, green means it does not and the branch should come out, because a fast path
  // that is bit-identical to the slow one is the second implementation this repo refuses.
  'raster-recomputes-the-default': {
    from: '        if (scanAxis.x == 0.0 && scanAxis.y == 1.0 && scanPitch == 1.3 && scanHard == 0.0) {',
    to: '        if (false) {',
    fails: 'the raster-at-0.35 row against the pinned build, and nothing else',
  },
  // The lattice switched off at its own guard: a cell that quantises nothing.
  'lattice-ignored': {
    from: '  if (lattice > 0.0) {',
    to: '  if (false) {',
    fails: 'lattice and latticeCell in the drop-one sweep',
  },
  // The ripple switched off the same way.
  'ripple-ignored': {
    from: '  if (ripple > 0.0 && rw > 0.0) {',
    to: '  if (false) {',
    fails: 'ripple, rippleFreq and rippleSpeed in the drop-one sweep, and the ripple-alone row',
  },
  // The gate put back the way it was before the ripple existed, so the region weight is
  // only computed when one of the older three effects asks for it. **The drop-one sweep
  // cannot see this**: the scrambled set raises all four at once, so the weight is there
  // anyway and the ripple goes on working. Only the arm that raises it alone reddens.
  'ripple-outside-the-gate': {
    from: '  float rw = (regionPush != 0.0 || regionNoise > 0.0 || regionMask != 0.0 || ripple > 0.0)',
    to: '  float rw = (regionPush != 0.0 || regionNoise > 0.0 || regionMask != 0.0)',
    fails: 'the ripple-alone row, and nothing else - the drop-one sweep stays green',
  },
  // The stepped clock made continuous, which is the term's whole character: a machine
  // rebuilding a surface rather than a thing breathing. The scrambled speed is deliberately
  // off the eighths it steps in, so the smooth phase lands somewhere the stepped one never
  // does rather than agreeing with it by luck at one instant.
  'ripple-clock-continuous': {
    from: '      float cycles = dist * rippleFreq - floor(time * rippleSpeed * 8.0) * 0.125;',
    to: '      float cycles = dist * rippleFreq - time * rippleSpeed;',
    fails: 'the stepped-clock row, and nothing else - the drop-one sweep stays green',
  },
  // The band axis nailed back to the sensor's rows, which is what it was before this
  // control existed. Everything else about the tear goes on working - the same bands are
  // chosen at the same rate and shoved the same distance - so the only thing that can see
  // it is the drop-one sweep, where an axis reaching nothing changes no pixel when it is
  // reverted. A build that quietly lost it tears horizontally under a green run, which is
  // the whole of what this control was added to stop being the only option.
  'glitch-axis-ignored': {
    from: '      ? floor(mix(position.y, position.x, glitchAxis) / glitchBands)',
    to: '      ? floor(position.y / glitchBands)',
    fails: 'glitchAxis in the drop-one sweep, alone',
  },
  // The streak switched off at its own guard, which is the plainest thing that can go
  // wrong with it: a term whose slider moves and whose uniform lands and whose pixels never
  // change. The drop-one sweep is where that shows, because reverting a parameter nothing
  // reads leaves the image where it was.
  'streak-ignored': {
    from: '      if (streak > 0.0) {',
    to: '      if (false) {',
    // Six rows and not the one this first claimed, taken off the run rather than
    // predicted - and it has grown twice, which is the argument for taking it off a run
    // every time rather than reasoning about it. The drop-one sweep names both `streak`
    // and `streakAngle`, because a direction that reaches nothing is a parameter that
    // changes no pixel when it is reverted; the count beneath the sweep follows; and all
    // four rows of the direction section go, its guard first. **Three of those are the
    // fixture rather than the claim**: the pair rows compare the light two angles add, and
    // a term that adds no light at either end of a pair is not a term that pointed the
    // wrong way. The guard row is what tells them apart, and it reporting zero added
    // luminance is the whole reason it is there - without it the pair rows would be
    // differencing two empty images and could pass by arithmetic.
    fails: 'streak and streakAngle in the drop-one sweep, the proven-parameter count '
      + 'beneath it, and all four rows of the direction section - the added-light guard '
      + 'reporting zero, and the three pair rows behind it, which are the fixture going '
      + 'rather than three findings about direction',
  },
  // The gather nailed back to straight down, which is what it was before the angle
  // existed. **This replaces `streak-climbs`**, which flipped the one sign there used to
  // be and cannot be written any more because the expression it anchored on is gone - and
  // the replacement is the stronger control anyway, because a build that has lost the
  // direction entirely also has the flipped one inside it at 180. Everything else about
  // the streak goes on working: the same taps at the same decay reaching the same
  // distance, so the term still bleeds light and the picture still moves.
  //
  // It is the sharper half of `streak-ignored` above in the same way `duotone-ignores-depth`
  // is the sharper half of `duotone-ignored`: that one asks whether the term is wired up at
  // all, this one asks whether it does the thing it is named for.
  'streak-ignores-angle': {
    from: '          vec3 tap = texture2D(tDiffuse, vUv + d * texel * streakAxis).rgb;',
    to: '          vec3 tap = texture2D(tDiffuse, vUv + vec2(0.0, d * texel.y)).rgb;',
    fails: 'streakAngle in the drop-one sweep and the proven-parameter count beneath it, '
      + 'and all three of the direction section\'s pair rows - a nailed build renders the '
      + 'same frame at every angle, so each pair differs by exactly nothing',
  },
  // The degrees-to-radians conversion dropped, which is a defect **no picture comparison
  // can see the shape of**: the streak still runs at an angle, the slider still moves it,
  // and every sweep row asking whether the parameter reaches a pixel goes on passing. It is
  // `duotone-hue-in-degrees` one block over, and the row that separates the two builds is
  // the landing sweep, where the axis is compared against the arithmetic written out in
  // EXPECT rather than against whatever the page did.
  // **Predicted to redden a direction row as well, and it does not - the prediction was
  // wrong and the threshold stays where it is.** The reasoning was that a radian-fed 180
  // points up and off to one side rather than straight up, so the 0-against-180 pair would
  // drift past the ceiling on how far across the angle its light may land. Measured, that
  // pair goes from 1.06% across 7.86% along on a clean build to 1.62% across 5.67%, which
  // is 0.29 of the distance travelled against a ceiling of 0.4: moved in the predicted
  // direction and not past it. Two reasons it cannot get there, and both are structural
  // rather than a matter of margin. The pairs are anchored at 0, where the sine of zero is
  // zero in either unit, so the one angle they all share is the one angle this mutation
  // cannot move. And the frame is wider than it is tall, so a sideways drift measured as a
  // fraction of the frame is worth about six tenths of the same drift measured vertically.
  //
  // Left as it is deliberately. Tightening the ceiling until this fired would put it at
  // 0.2 against a clean build sitting at 0.135, which is a gate adjusted to make a
  // prediction come true - the failure `docs/instruments.md` records twice, both times
  // arriving with a written justification that stopped anybody looking again.
  'streak-angle-in-degrees': {
    from: '      grade.uniforms.streakAxis.value.set(Math.sin(r), Math.cos(r));',
    to: '      grade.uniforms.streakAxis.value.set(Math.sin(v), Math.cos(v));',
    fails: 'the streakAngle row of the one-at-a-time landing sweep, reporting "landed '
      + '[-0.097181906,0.995266636] want [0.920504853,-0.390731128]", and the all-at-once '
      + 'row beside it - that second one is the same comparison over the whole set rather '
      + 'than a separate finding. Nothing in the direction section moves: this is a unit '
      + 'error, and a streak running at the wrong angle is still a streak running at an '
      + 'angle',
  },
  // The raster's axis nailed back to the frame's y, which is what it was before the angle
  // existed. Everything else about the raster goes on working - the pitch still sets the
  // line frequency and the hardness still squares the wave - so the only row that can see
  // it is the drop-one sweep, where an angle that reaches nothing changes no pixel when it
  // is reverted. This is the vertical column grille the whole of D1 is for, so a build
  // that quietly lost it would be drawing television scanlines under a green run.
  'raster-ignores-angle': {
    from: '          float coord = dot(vUv * ref, scanAxis);',
    to: '          float coord = vUv.y * ref.y;',
    fails: 'scanAngle in the drop-one sweep, alone',
  },
  // The pitch back to the literal it was promoted from. Its default *is* that literal, so
  // nothing about the shipped picture moves - which is the point, and which leaves the
  // drop-one sweep as the only thing that can tell the two builds apart.
  'raster-pitch-fixed': {
    from: '          float wave = sin(coord * scanPitch + time * 2.0) * 0.5 + 0.5;',
    to: '          float wave = sin(coord * 1.3 + time * 2.0) * 0.5 + 0.5;',
    fails: 'scanPitch in the drop-one sweep, alone',
  },
  // The duty cycle dropped, leaving the sine the term has always drawn. This is the
  // control that separates "the raster rotates and crowds" from "the raster is a grille",
  // and a build without it draws rotated softness at every setting - which looks like a
  // raster right up until you compare it against a reference frame.
  'raster-hard-ignored': {
    from: '          line = mix(wave, smoothstep(0.5 - w, 0.5 + w, wave), scanHard);',
    to: '          line = wave;',
    fails: 'scanHard in the drop-one sweep, alone',
  },
  // The tempting edit, planted: `crush` joins the four terms that gate the grade pass, so
  // the pass runs whenever the toe is non-zero, which is always. This is deliberately not
  // a well-behaved control and the whole set has to be read rather than the count. It
  // reddens the pass-gate row it is aimed at; then it reddens all five reading rows of
  // section 1b, because every reading at its defaults is now drawn through a Reinhard
  // curve the pinned build never applied; and then the boot comparison, because all four
  // gating terms report their pass on where the pinned build has it off. Seven rows for
  // one fact, measured rather than predicted - the first draft of this line guessed the
  // boot failure would arrive as four separate landing rows and it arrives as one row
  // naming four terms in its detail, which is the sort of thing only a run settles.
  //
  // Note what reddening 1b's readGhost row means here, since that row is red in every run
  // of this tool: it goes from its own standing 2 of 6 frames to 6 of 6. A row already
  // failing is exactly where a new defect hides, so the count is not the reading - the
  // frame tally is.
  'crush-gates-the-grade': {
    from: '  return grade.uniforms.rgbSplit.value > 0',
    to: '  return grade.uniforms.crush.value > 0 || grade.uniforms.rgbSplit.value > 0',
    fails: 'the pass-gate row for crush, all five rows of 1b (readGhost widening from 2 of 6 '
      + 'frames to 6 of 6), and the boot comparison naming all four gating terms',
  },
};

const MUTATE = flag('--mutate');
if (MUTATE && !Object.hasOwn(MUTATIONS, MUTATE)) {
  throw new Error(`unknown mutation ${JSON.stringify(MUTATE)} - have ${Object.keys(MUTATIONS).join(', ')}`);
}

// A run that died is not a run that found something, and under `--mutate` the two are
// indistinguishable to anything reading the exit code: a Playwright page that dropped
// its execution context exits non-zero with nothing asserted, which reads exactly like
// a caught mutation. So a crash gets its own verdict and its own code.
//
// This is not hypothetical here. `rgb-contributes-no-alpha` and `ghost-alpha-term-dropped`
// both reddened their intended row and then died on `Target page, context or browser has
// been closed` on their first run, and both reproduced cleanly on the next - the same
// several-WebGL-pages flake `export-check` retries by name. Without this handler each of
// those would have exited non-zero having asserted the right thing for the wrong reason,
// and the two are indistinguishable from outside. Not retried here, deliberately: a
// check that retried would have to decide which failures are real, and the verdict line
// saying DID NOT RUN costs one re-run and no judgement.
process.on('unhandledRejection', (err) => {
  console.log(`\n[registry] DID NOT RUN - ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(2);
});
process.on('uncaughtException', (err) => {
  console.log(`\n[registry] DID NOT RUN - ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(2);
});

// The mutated module, served into every page this file opens. Refused when the anchor
// is not found exactly once, for the reason every other tool here refuses it: a
// replacement that silently matched nothing would run the unmutated page and be
// recorded as the check having missed a bug it was never shown. And a mutation is a
// piece of source text, so it stops matching the moment the code it names is edited -
// the refusal is what surfaces that rather than a silent pass.
const mutatedSource = (() => {
  if (!MUTATE) return null;
  const js = readFileSync(join(REPO, 'web/main.js'), 'utf8');
  const { from, to } = MUTATIONS[MUTATE];
  const hits = js.split(from).length - 1;
  if (hits !== 1) {
    throw new Error(`mutation ${MUTATE} matched its anchor ${hits} times, not once: ${JSON.stringify(from)}`);
  }
  return { js: js.replace(from, to), html: readFileSync(join(REPO, 'web/index.html'), 'utf8') };
})();

const HEADED = argv.includes('--headed');
const SOURCE_FRAMES = Number(flag('--frames', '6'));
const STRIDE = Number(flag('--stride', '4'));
const SUBSTEPS = Number(flag('--substeps', '3'));

const VIEW = { width: 640, height: 400 };
// The height the current editor gives its fixed application bar, and it is **measured
// off the page rather than declared here**. Historical comparison pages have no shell,
// so their viewport is shortened by the same amount to make both arms render the same
// content box rather than two different layouts - which means this number is not a
// note about the design, it is a term in the golden comparison. Written down as a
// literal it was 32 against a `web/nav.css` that says 38, and the two rows it feeds
// reddened with `renderScale: 589 -> 579` - a difference that is entirely this drift
// (`round(640 * (400-38)/400)` is 579) and reads exactly like the buffer regression
// the golden row exists to catch. So the after arm is opened first, the bar is
// measured, and the before arm is sized against what was measured.
let APP_BAR_HEIGHT = null;
let SHELL_CONTENT = null;
let COMPARISON_VIEW = null;
const shellGeometry = (barHeight) => {
  APP_BAR_HEIGHT = barHeight;
  SHELL_CONTENT = {
    width: Math.round(VIEW.width * ((VIEW.height - barHeight) / VIEW.height)),
    height: VIEW.height - barHeight,
  };
  COMPARISON_VIEW = { width: VIEW.width, height: VIEW.height + barHeight };
};
let RENDER_BUFFER = { width: VIEW.width, height: VIEW.height };
const POINTS = 512 * 424;
// THREE.NormalBlending and THREE.AdditiveBlending, by value, because the check
// reads the material rather than the registry.
const NORMAL_BLENDING = 1;
const ADDITIVE_BLENDING = 2;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (x) => JSON.stringify(x);

// Playwright is not a dependency of this project - it is a tool the proofs reach
// for - so it is resolved from wherever it happens to be installed.
async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const roots = [];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch { /* no global npm root: the local resolve below may still work */ }

  const candidates = [async () => import('playwright')];
  for (const root of roots) {
    for (const name of ['playwright', '@playwright/cli/node_modules/playwright']) {
      candidates.push(async () => import(pathToFileURL(require.resolve(join(root, name))).href));
    }
  }
  for (const load of candidates) {
    try {
      const mod = await load();
      const pw = mod.chromium ? mod : mod.default;
      if (pw?.chromium) return pw;
    } catch { /* try the next one */ }
  }
  throw new Error('playwright not found - install it globally or in this project');
}

// ------------------------------------------------------------------- fixture

// Capture frame payloads back to back, wire format unchanged apart from the colour
// block being dropped, so the page parses them with the same field offsets the
// socket path uses and the depth is real sensor depth.
function buildFixture(path) {
  const parser = new MessageParser();
  const frames = [];
  for (const msg of parser.push(readFileSync(path))) {
    if (msg.type === TYPE_FRAME) frames.push(msg.payload);
  }
  if (frames.length < SOURCE_FRAMES * STRIDE) {
    throw new Error(`${path} has ${frames.length} frames, need ${SOURCE_FRAMES * STRIDE}`);
  }
  const out = [];
  for (let i = 0; i < SOURCE_FRAMES; i++) {
    const src = frames[i * STRIDE];
    const depthBytes = src.readUInt32LE(0);
    const payload = Buffer.alloc(16 + depthBytes);
    payload.writeUInt32LE(depthBytes, 0);
    payload.writeUInt32LE(0, 4); // colour dropped: JPEG decode is asynchronous
    src.copy(payload, 8, 8, 16); // the capture timestamp, verbatim
    src.copy(payload, 16, 16, 16 + depthBytes);
    out.push(payload);
  }
  return Buffer.concat(out);
}

// ------------------------------------------------------- where each value lands
//
// Written out independently of the registry. If `apply` stopped reaching one of
// these, every other check here would still pass and this one would not.

const LANDING = {
  pointSize: 'k.uniforms.pointSize.value',
  opacity: 'k.uniforms.opacity.value',
  exposure: 'k.uniforms.exposure.value',
  additive: '[k.material.blending, k.material.depthWrite, k.uniforms.softEdge.value]',
  near: 'k.uniforms.nearClip.value',
  far: 'k.uniforms.farClip.value',
  left: 'k.uniforms.cropL.value',
  right: 'k.uniforms.cropR.value',
  bottom: 'k.uniforms.cropB.value',
  top: 'k.uniforms.cropT.value',
  crop: 'k.uniforms.cropOn.value',
  interpolate: 'k.uniforms.interpolate.value',
  snapDelta: 'k.uniforms.snapDelta.value',
  fade: '[k.uniforms.fadeTime.value, k.geometry.drawRange.count]',
  wake: '[k.uniforms.wakeTime.value, k.geometry.drawRange.count]',
  noise: 'k.uniforms.noise.value',
  noiseScale: 'k.uniforms.noiseScale.value',
  noiseSpeed: 'k.uniforms.noiseSpeed.value',
  lattice: 'k.uniforms.lattice.value',
  latticeCell: 'k.uniforms.latticeCell.value',
  // The centre and the half-extents are three sliders landing in one vector each, so
  // the component is named here rather than the uniform - an apply that wrote the
  // whole vector, or wrote y where x was meant, reads identically at `.value`.
  regionX: 'k.uniforms.regionCentre.value.x',
  regionY: 'k.uniforms.regionCentre.value.y',
  regionZ: 'k.uniforms.regionCentre.value.z',
  regionW: 'k.uniforms.regionHalf.value.x',
  regionH: 'k.uniforms.regionHalf.value.y',
  regionD: 'k.uniforms.regionHalf.value.z',
  regionRound: 'k.uniforms.regionRound.value',
  regionSoft: 'k.uniforms.regionSoft.value',
  regionPush: 'k.uniforms.regionPush.value',
  regionNoise: 'k.uniforms.regionNoise.value',
  regionMask: 'k.uniforms.regionMask.value',
  ripple: 'k.uniforms.ripple.value',
  rippleFreq: 'k.uniforms.rippleFreq.value',
  rippleSpeed: 'k.uniforms.rippleSpeed.value',
  glitch: 'k.uniforms.glitch.value',
  glitchDensity: 'k.uniforms.glitchDensity.value',
  glitchShove: 'k.uniforms.glitchShove.value',
  glitchTint: 'k.uniforms.glitchTint.value',
  glitchBands: 'k.uniforms.glitchBands.value',
  glitchAxis: 'k.uniforms.glitchAxis.value',
  glitchRate: 'k.uniforms.glitchRate.value',
  spin: 'k.controls.autoRotate',
  // The five readings land on uniforms of their own name, which is the one place in
  // this table where the parameter and the uniform were deliberately made to match:
  // the shader reads them as a set, and a landing site that renamed them on the way
  // through would be a second table to keep in step with the first.
  readRgb: 'k.uniforms.readRgb.value',
  readDepth: 'k.uniforms.readDepth.value',
  readGhost: 'k.uniforms.readGhost.value',
  readContour: 'k.uniforms.readContour.value',
  readBlackwall: 'k.uniforms.readBlackwall.value',
  rgbSaturation: 'k.uniforms.rgbSaturation.value',
  depthGamma: 'k.uniforms.depthGamma.value',
  ghostRim: 'k.uniforms.ghostRim.value',
  ghostFill: 'k.uniforms.ghostFill.value',
  contourBands: 'k.uniforms.contourBands.value',
  // The one parameter here that is not a single uniform write: it is half a band's
  // width, and the shader takes the two edges it makes. Named as the pair rather than
  // as one of them for the reason the region's components are - an apply that wrote the
  // same edge twice, or moved one and not the other, reads identically at either one.
  contourWidth: '[k.uniforms.contourLo.value, k.uniforms.contourHi.value]',
  blackwallSweep: 'k.uniforms.blackwallSweep.value',
  scan: 'k.uniforms.scanAmount.value',
  rim: 'k.uniforms.rimAmount.value',
  thermal: 'k.uniforms.thermal.value',
  edges: 'k.uniforms.edges.value',
  duotoneDepth: 'k.uniforms.duotoneDepth.value',
  // Degrees on the slider and radians at the uniform, so this row is the conversion as
  // much as the arrival. An apply that handed the shader its degrees straight through
  // would read here as a perfectly ordinary number and spin the poles fifty-seven times
  // too far, which is a look nobody authored arriving through a slider that works.
  duotoneHue: 'k.uniforms.duotoneHue.value',
  duotoneSplit: 'k.uniforms.duotoneSplit.value',
  duotoneSpan: 'k.uniforms.duotoneSpan.value',
  duotoneMotion: 'k.uniforms.duotoneMotion.value',
  bloom: '[k.bloom.strength, k.bloom.enabled]',
  trails: '[k.afterimage.uniforms.damp.value, k.afterimage.enabled]',
  rgbSplit: '[k.grade.uniforms.rgbSplit.value, k.grade.enabled]',
  scanlines: '[k.grade.uniforms.scanlines.value, k.grade.enabled]',
  // The raster's three settings, and like `crush` below none of them carries
  // `k.grade.enabled` - they are settings of the master above rather than terms beside
  // it, so the pass is the master's to gate. The angle is degrees on the slider and
  // radians at the uniform, which makes its row the conversion as well as the arrival.
  // Named as the pair rather than as an angle, because that is what the registry
  // actually writes: an apply that moved one component and not the other, or wrote the
  // sine where the cosine belongs, reads identically at either one on its own.
  scanAngle: '[k.grade.uniforms.scanAxis.value.x, k.grade.uniforms.scanAxis.value.y].map((v) => Number(v.toFixed(9)))',
  scanPitch: 'k.grade.uniforms.scanPitch.value',
  scanHard: 'k.grade.uniforms.scanHard.value',
  grain: '[k.grade.uniforms.grain.value, k.grade.enabled]',
  streak: '[k.grade.uniforms.streak.value, k.grade.enabled]',
  // The streak's direction, on the raster angle's terms exactly: degrees on the slider,
  // an axis at the uniform, so this row is the conversion as much as the arrival, and
  // named as the pair because an apply that wrote the sine where the cosine belongs reads
  // as a perfectly ordinary number at either component on its own. No `k.grade.enabled`
  // beside it, and the absence is the assertion - it is a setting of `streak` above rather
  // than a term beside it, so switching the pass on to point a streak nobody raised is the
  // no-op the gate matrix refuses by name.
  streakAngle: '[k.grade.uniforms.streakAxis.value.x, k.grade.uniforms.streakAxis.value.y].map((v) => Number(v.toFixed(9)))',
  vignette: '[k.grade.uniforms.vignette.value, k.grade.enabled]',
  // The fifth term in that pass, and **the missing `k.grade.enabled` beside it is the
  // assertion**. The four above gate the pass and so each has to carry whether it is on;
  // this one is a sub-control inside the pass and deliberately does not, because its
  // default is the literal it replaced and a gate on a non-zero default would hold the
  // grade open for every look there is. Pairing it here would make this row agree with a
  // build that gated it, which is the one build this landing site exists to refuse. What
  // proves the negative is the row in the pass-gate matrix below.
  crush: 'k.grade.uniforms.crush.value',
  denoise: 'k.uniforms.denoise.value',
  edgeTol: 'k.uniforms.edgeTol.value',
  renderScale: 'k.renderer.getContext().drawingBufferWidth',
  // The two levelling angles share one landing site, because a rotation is what they
  // are between them. `worldTilt()` answers off the cloud's own quaternion rather than
  // off the value the pair composes into, so this row is "the rotation reached the
  // object the renderer draws" rather than "the arithmetic was done". Rounded because
  // the comparison is a `JSON.stringify` equality and the expectation below rebuilds
  // the quaternion in a different order of operations - a ULP apart is not a finding.
  tilt: 'k.worldTilt().map((v) => Number(v.toFixed(9)))',
  roll: 'k.worldTilt().map((v) => Number(v.toFixed(9)))',
  camera: '[...k.programCamera.position.toArray(), ...k.programCamera.quaternion.toArray(), k.programCamera.fov]',
};

/**
 * The quaternion `tilt` and `roll` have to compose into: `Rx(tilt) * Rz(roll)`.
 *
 * Written out here rather than read back from the page on purpose. This is the one
 * place outside `web/main.js` that states the order, so the pair being composed the
 * other way round fails this row - where a tool that asked the page what order it used
 * would agree with the implementation by construction and could never see it.
 */
function levellingQuaternion(tiltDeg, rollDeg) {
  const t = (tiltDeg * (Math.PI / 180)) / 2;
  const r = (rollDeg * (Math.PI / 180)) / 2;
  const st = Math.sin(t); const ct = Math.cos(t);
  const sr = Math.sin(r); const cr = Math.cos(r);
  return [st * cr, -st * sr, ct * sr, ct * cr].map((v) => Number(v.toFixed(9)));
}

// What that landing site must read, given the value the registry was handed. The
// ones taking `all` are the parameters that share a side effect with another.
const EXPECT = {
  pointSize: (v) => v,
  opacity: (v) => v,
  exposure: (v) => v,
  additive: (v) => [v ? ADDITIVE_BLENDING : NORMAL_BLENDING, !v, v ? 1 : 0],
  near: (v) => v,
  far: (v) => v,
  left: (v) => v,
  right: (v) => v,
  bottom: (v) => v,
  top: (v) => v,
  crop: (v) => (v ? 1 : 0),
  interpolate: (v) => (v ? 1 : 0),
  snapDelta: (v) => v,
  fade: (v, all) => [v / 1000, v > 0 || all.wake > 0 ? POINTS * 2 : POINTS],
  wake: (v, all) => [v / 1000, all.fade > 0 || v > 0 ? POINTS * 2 : POINTS],
  noise: (v) => v,
  noiseScale: (v) => v,
  noiseSpeed: (v) => v,
  lattice: (v) => v,
  latticeCell: (v) => v,
  regionX: (v) => v,
  regionY: (v) => v,
  regionZ: (v) => v,
  regionW: (v) => v,
  regionH: (v) => v,
  regionD: (v) => v,
  regionRound: (v) => v,
  regionSoft: (v) => v,
  regionPush: (v) => v,
  regionNoise: (v) => v,
  regionMask: (v) => v,
  ripple: (v) => v,
  rippleFreq: (v) => v,
  rippleSpeed: (v) => v,
  glitch: (v) => v,
  glitchDensity: (v) => v,
  glitchShove: (v) => v,
  glitchTint: (v) => v,
  glitchBands: (v) => v,
  glitchAxis: (v) => v,
  glitchRate: (v) => v,
  spin: (v) => v,
  readRgb: (v) => v,
  readDepth: (v) => v,
  readGhost: (v) => v,
  readContour: (v) => v,
  readBlackwall: (v) => v,
  rgbSaturation: (v) => v,
  depthGamma: (v) => v,
  ghostRim: (v) => v,
  ghostFill: (v) => v,
  contourBands: (v) => v,
  // Written as the same double-precision arithmetic the registry does, so the two agree
  // bit for bit rather than nearly: the whole reason the edges are computed off the GPU
  // is that a half minus this width is a different float in float32, and a check that
  // rounded its expectation differently from the build would be measuring its own
  // arithmetic.
  contourWidth: (v) => [0.5 - v, 0.5 + v],
  blackwallSweep: (v) => v,
  scan: (v) => v,
  rim: (v) => v,
  thermal: (v) => v,
  edges: (v) => v,
  duotoneDepth: (v) => v,
  // The degrees-to-radians the registry does on the way through, written out here as the
  // same double arithmetic rather than read back off the page - three's `degToRad` is a
  // multiply by `Math.PI / 180` and so is this, which makes the equality exact instead of
  // nearly exact. A tool that asked the page what conversion it used would agree with the
  // implementation by construction and could never see a wrong one.
  duotoneHue: (v) => v * (Math.PI / 180),
  duotoneSplit: (v) => v,
  // Metres straight through, which is the whole of what this landing has to say: the
  // conversion into the ramp's own units happens in the shader against the clip range,
  // so an apply that divided here would be doing it twice and against a range the
  // document may not still have by the time the frame is drawn.
  duotoneSpan: (v) => v,
  duotoneMotion: (v) => v,
  bloom: (v) => [v, v > 0],
  trails: (v) => [v, v > 0],
  // The five that share one pass, so each one's landing carries whether the pass is on
  // and every one of them has to name the other four. `vignette` joined them when it
  // stopped being a literal applied whenever the pass happened to run, and `streak` joined
  // by being written.
  //
  // **Every row here gained `streak` and not only the new one.** The scrambled set happens
  // to raise all five at once, so leaving the older four alone would have passed today and
  // gone on passing - right up until a set that raised the streak alone, where four rows
  // would expect a shut pass against an open one and read as findings about terms that had
  // not changed. The gate is one condition and each row states the whole of it.
  rgbSplit: (v, all) => [v, v > 0 || all.scanlines > 0 || all.grain > 0 || all.vignette > 0
    || all.streak > 0],
  scanlines: (v, all) => [v, all.rgbSplit > 0 || v > 0 || all.grain > 0 || all.vignette > 0
    || all.streak > 0],
  // Same double arithmetic three's `degToRad` does, so the equality is exact rather than
  // near - and written out here rather than read back off the page, because a tool that
  // asked the page what conversion it used could never see a wrong one.
  // The same double arithmetic the registry does on the way through, so the two agree bit
  // for bit rather than nearly - and stated here rather than read back off the page,
  // because a tool that asked the page which axis it built could never see a wrong one.
  // Rounded on both sides, exactly as the levelling pair above is and for its reason:
  // the comparison is a `JSON.stringify` equality and this rebuilds the cosine in a
  // different order of operations from the registry, so the two land a ULP apart -
  // 0.4539904997395468 against 0.45399049973954686 at the scrambled 63 degrees. A ULP is
  // not a finding; an axis built the wrong way round still is, and still fails here.
  scanAngle: (v) => [Math.sin(v * (Math.PI / 180)), Math.cos(v * (Math.PI / 180))]
    .map((x) => Number(x.toFixed(9))),
  scanPitch: (v) => v,
  scanHard: (v) => v,
  grain: (v, all) => [v, all.rgbSplit > 0 || all.scanlines > 0 || v > 0 || all.vignette > 0
    || all.streak > 0],
  streak: (v, all) => [v, all.rgbSplit > 0 || all.scanlines > 0 || all.grain > 0
    || all.vignette > 0 || v > 0],
  // The same double arithmetic the registry does on the way through, written out here
  // rather than read back off the page for `scanAngle`'s reason two rows up: a tool that
  // asked the page which axis it built could never see a wrong one. Rounded on both sides,
  // because this rebuilds the cosine in a different order of operations from the registry
  // and a ULP apart is not a finding, where an axis built in degrees still is.
  streakAngle: (v) => [Math.sin(v * (Math.PI / 180)), Math.cos(v * (Math.PI / 180))]
    .map((x) => Number(x.toFixed(9))),
  vignette: (v, all) => [v, all.rgbSplit > 0 || all.scanlines > 0 || all.grain > 0 || v > 0
    || all.streak > 0],
  // Reads its own value and nothing else, because it shares the pass without gating it -
  // so unlike the four above it names none of the others and none of them name it.
  crush: (v) => v,
  denoise: (v) => (v ? 1 : 0),
  edgeTol: (v) => v,
  // three floors width * pixelRatio, and the context runs at deviceScaleFactor 1.
  renderScale: (v) => Math.floor(RENDER_BUFFER.width * (v / 100)),
  // Both read the whole pair, because both land on the same rotation: a `tilt` set on
  // its own has to compose with whatever `roll` currently is, which the one-at-a-time
  // sweep leaves at its default and the all-at-once pass does not.
  tilt: (v, all) => levellingQuaternion(v, all.roll),
  roll: (v, all) => levellingQuaternion(all.tilt, v),
  camera: (v) => [...v.position, ...v.quaternion, v.fov],
};

// A scrambled but valid set: every value off its default and on its own step grid,
// every boolean flipped. This is what gets serialised, restored and hashed.
const SCRAMBLE = {
  pointSize: 9.5,
  opacity: 0.62,
  exposure: 2.05,
  additive: true,
  // Both non-zero and both off the other's axis, because the drop-one sweep reverts one
  // at a time: a scrambled set that levelled along a single axis would leave the other
  // parameter with nothing to undo, and it would land in the no-pixel bucket looking
  // like a parameter that does nothing. Off the half-degree grid's round numbers for
  // the same reason every other value here is - a step the slider can express, but not
  // one a hardcoded constant would plausibly be.
  tilt: 13.5,
  roll: -21.5,
  near: 0.35,
  far: 4.2,
  // **Left at its default, which is the one value in this table that is**, and the
  // reason is the same one the three region effects below give: it is a gate, and the
  // six faces either side of it are only observable through it. Flipped to `false` the
  // box stops biting, so `near`, `far` and the four lateral faces all render the same
  // image whatever they are set to, and six real parameters land in the no-pixel bucket
  // at once looking like parameters that do nothing.
  //
  // What that costs is this sweep's own view of `crop`: dropping it restores the value
  // it already has, so it changes nothing here and is declared in `NO_PIXEL_EFFECT`. A
  // drop-one sweep cannot see a parameter whose scrambled value is its default, and the
  // section below is where the switch is actually proven.
  crop: true,
  // The four lateral faces, placed against the same fixture the region is placed
  // against rather than picked: the cloud runs x [-2.31, 2.97] and y [-2.26, 1.63],
  // so each of these sits inside the extent on its own side and has something to cull,
  // while the box they make still contains the subject at the median (0.021, 0.019).
  // A plane outside the cloud would be a parameter the drop-one sweep below could not
  // see, which is the same trap the region's placement comment describes.
  left: -1.5,
  right: 1.5,
  bottom: -1.5,
  top: 1,
  // Flipped, and the drop-one sweep is what makes it worth stating. Reverting `crop` to
  // its default puts all six faces back to work against the four placed above and the
  // near/far pair above them - so the row it produces is a large one, and a build whose
  // switch reached the shader and nothing else, or nothing at all, cannot pass it. The
  interpolate: false,
  snapDelta: 410,
  fade: 260,
  wake: 830,
  noise: 0.08,
  noiseScale: 5.5,
  noiseSpeed: 1.45,
  // Full strength, because a partial snap is a blend of the grid and the surface and the
  // drop-one sweep would be separating that from the turbulence three rows up.
  lattice: 1,
  // Coarse enough that a cell spans several points at this pose. A cell near the point
  // spacing snaps every point to roughly where it already was, which is a lattice that
  // renders as its own absence.
  latticeCell: 0.11,
  // The master well up, because the five ceilings under it are only observable through
  // it: at a glitch of 0 no band tears, so density, shove, flare, band height and rate
  // would every one of them land in the no-pixel bucket together - the same argument the
  // region's three effects below are set for. The flare is above its default so it is
  // being raised onto the picture rather than lowered out of it.
  glitch: 0.31,
  glitchDensity: 0.62,
  glitchShove: 1.23,
  glitchTint: 4.35,
  glitchBands: 27,
  // Most of the way to the sensor's columns, so the bands cross the frame on a steep
  // diagonal rather than at either of the two axes it interpolates between. A value of 1
  // would be a second baked axis and would leave the interesting half of this control -
  // everything off the diagonal - unmeasured by the sweep.
  glitchAxis: 0.78,
  glitchRate: 13.5,
  // The region is placed rather than picked, because the sweep below drops each
  // parameter in turn and asserts the image moved - and a region floating in empty
  // space would leave all eight of its geometry parameters inert while looking like a
  // perfectly reasonable set of numbers. Measured against the six frames this fixture
  // is built from, unprojected with the take's own intrinsics and clipped to the
  // near/far above: the cloud runs x [-2.31, 2.97], y [-2.26, 1.63], z [-4.50, -0.50]
  // with its median point at (0.021, 0.019, -1.893), so the centre sits on the subject
  // and the surface passes through it rather than around it.
  //
  // What that buys, per parameter, as points whose region weight changes when that one
  // parameter alone reverts to its default - 957,783 points survive the clip:
  //
  //   regionX 14.49%   regionY 19.13%   regionZ 31.25%   regionW 27.96%
  //   regionH 44.20%   regionD 56.84%   regionRound 68.89%   regionSoft 21.31%
  //
  // The tightest is `regionX`, whose 0.05 step is one grid position off its default and
  // still moves 138,822 points. `regionSoft` is the one to watch if these are ever
  // retuned: it can only act in the shell outside the surface, so a falloff at its
  // default width against a region already swallowing the cloud would move nothing.
  regionX: 0.05,
  regionY: 0.15,
  regionZ: -1.9,
  regionW: 0.4,
  regionH: 0.4,
  regionD: 0.4,
  regionRound: 0.9,
  regionSoft: 0.6,
  // All three non-zero, because the eight above are only observable through them: with
  // push, scramble and mask all at their defaults the region has no effect to have, and
  // every geometry parameter would land in the no-pixel bucket at once. The mask is
  // well short of 1 for the same reason - a region that hid its contents outright would
  // make the displacement inside it invisible and take `regionPush` down with it.
  regionPush: 0.35,
  regionNoise: 0.5,
  regionMask: 0.4,
  ripple: 0.14,
  rippleFreq: 6.3,
  // Off the whole eighths its own clock steps in, so a phase that stopped being quantised
  // would land somewhere else rather than on the same step by luck.
  rippleSpeed: 1.35,
  spin: true,
  // All five readings live at once, which is what keeps every per-reading term in the
  // shader reachable from the one sweep this file runs. They are deliberately unequal:
  // an even split would make the normalisation divide by exactly 1.0 whichever way the
  // weights were read, so a build that summed them wrong would still agree here.
  readRgb: 0.4,
  readDepth: 0.3,
  readGhost: 0.2,
  readContour: 0.15,
  readBlackwall: 0.6,
  // The seven per-reading constants, every one off its default - and for the first two
  // that is the whole point rather than a habit. Their defaults are the identity: a
  // saturation of 1 and a gamma of 1 do nothing by construction, so leaving either at
  // its default would have the drop-one sweep below record it as a parameter that
  // cannot touch a pixel, which is true of the value and false of the parameter.
  //
  // `rgbSaturation` is also the one parameter in this table that needs an input the
  // pinned fixture does not carry. The fixture drops the colour block, so `hasColor` is
  // 0 and every point draws a flat grey - and saturation of grey is the identity at
  // every value, which is a dead zone rather than a value that does nothing. The sweep
  // plants a colour image for exactly that reason; see `plantColor` below.
  //
  // `blackwallSweep` is a speed, so it moves nothing in a frame at program time 0 and
  // the run below deliberately spans a second: at 0.9 against its default the scan plane
  // has travelled 0.62 of a period by the end of it.
  rgbSaturation: 1.6,
  depthGamma: 0.6,
  ghostRim: 1.4,
  ghostFill: 0.7,
  contourBands: 27,
  contourWidth: 0.25,
  blackwallSweep: 0.9,
  scan: 0.72,
  rim: 0.28,
  // Order matters here and nowhere else in this file: the comparison against the
  // serialised set is a JSON.stringify equality, so these keys have to sit in the order
  // PARAMS declares them. Put them anywhere else and the check fails with an empty
  // detail line, because every value matches and only the ordering does not.
  thermal: 0.6,
  edges: 0.45,
  // The duotone amount well up, because the two below are only observable through it -
  // the same argument the glitch master and the region's three effects are set on. At a
  // depth of 0 the poles never reach a pixel, so the hue and the split would both land in
  // the no-pixel bucket together looking like parameters that do nothing.
  duotoneDepth: 0.65,
  // Off the axis in both senses: a rotation big enough to move both poles well clear of
  // where they started, and not one of the right angles a hardcoded constant would
  // plausibly be. 47 degrees is on the step grid and is nobody's round number.
  duotoneHue: 47,
  // Off centre, so reverting it moves the crossover through the cloud rather than
  // symmetrically about it. The fixture's points run z [-4.50, -0.50] against a near/far
  // of 0.35/4.2, so a split at 0.36 puts the meeting plane inside the subject where the
  // default at 0.5 puts it behind them.
  duotoneSplit: 0.36,
  // A ramp much steeper than the default one, because the default is what has to be
  // observable against. `near`/`far` above make the range 3.85m, so the default span of
  // 5.95m already runs wider than the box - the crossing is spread over the whole cloud
  // and then some - and 1.15m puts it inside about a third of the range instead. Reverting
  // this parameter therefore flattens a visible edge rather than nudging one, which is
  // what the drop-one sweep needs and what a value near the default would not give.
  //
  // On the 0.05 grid and nobody's round number, for the reason `duotoneHue`'s 47 is.
  duotoneSpan: 1.15,
  // Well up, because what it has to be observable against is the depth key beside it: at
  // the split above, the middle of this cloud sits at a k of about 0.56, so there is room
  // above it for a moving point to be pushed into and reverting this parameter takes that
  // push away. A motion amount raised over a room already at the hot pole would land in
  // the no-pixel bucket looking like a parameter that does nothing.
  //
  // What it has to key on is in the fixture rather than planted, which is why this row is
  // safe at all: measured over the five pairs the six pinned frames make, 7.7% of paired
  // samples move faster than 150 mm/s, the 99th percentile is about 430 and the fastest is
  // about 1900, against a ramp that reaches its pole at 1200. The nearly-static fixture
  // still carries a subject moving through it.
  duotoneMotion: 0.83,
  bloom: 1.35,
  trails: 0.44,
  rgbSplit: 2.3,
  scanlines: 0.61,
  // Off every axis the raster has a right angle at, so a build that rounded the angle to
  // the nearest quarter turn - or dropped it - draws a visibly different grille. The
  // master above is what makes these three observable at all: at a scanlines of 0 the
  // block never runs and all three would land in the no-pixel bucket together, which is
  // the argument the glitch ceilings and the region's three effects are set on.
  scanAngle: 63,
  // Well *below* the 1.3 it defaults to, which is where the grille is: the wave is
  // expressed against 1080p, so the default is already the television artifact and the
  // wide bands live under 0.6. The registry entry in `web/main.js` carries the measurement
  // and the correction it replaced. A pitch that only moved a hair would be a parameter
  // the drop-one sweep could not separate from sampling noise, and this one is far enough
  // off the default to redraw the whole frame.
  scanPitch: 0.37,
  // High enough that the wave is a grille rather than a sine, which is the state the
  // hardness exists to reach. At its default of 0 it is the identity by construction, so
  // leaving it there would have the sweep record it as a parameter that cannot touch a
  // pixel - the trap `rgbSaturation` and `depthGamma` above are set off their defaults for.
  scanHard: 0.82,
  grain: 0.37,
  // High enough that the gather wins over the pixel it started from across a good part of
  // the frame. The taps decay with distance, so a small streak moves only what sits
  // directly under a highlight and the drop-one sweep would be separating that from the
  // grain two rows up.
  streak: 0.62,
  // Off every right angle and off both diagonals - 113 sits 22.5 degrees from 90 and from
  // 135, which are the two nearest values a build that quantised the axis could plausibly
  // land on, and it is nowhere near the 0 the sweep reverts it to. A direction a hair off
  // its default would be a parameter the drop-one sweep could not separate from sampling
  // noise; a direction on a right angle would be one a build with four choices rather than
  // an angle would answer correctly.
  streakAngle: 113,
  vignette: 0.73,
  // Well above the 0.018 it defaults to, and the four terms above hold the pass open so
  // it is reachable at all - a toe inside a pass nothing switched on is the dead zone
  // this table's `rgbSaturation` comment describes, arriving by a different route.
  // Reverting it to its default lifts every unclamped pixel by 0.044 * 1.12, which is
  // about 12.6 of 255 and nothing a sampling residual explains.
  crush: 0.062,
  denoise: false,
  edgeTol: 340,
  renderScale: 85,
  // A unit quaternion, 30 degrees about Y, so the read-back is exact.
  camera: { position: [0.4, 0.9, 1.1], quaternion: [0, 0.25881904510252074, 0, 0.9659258262890683], fov: 42 },
};

// The closed list of parameters allowed to leave the image untouched when they are
// dropped from a restore, with the reason each one cannot reach the pixels here.
// Anything else landing in that bucket is a failure, which is what stops the sweep
// growing holes as later steps add parameters.
const NO_PIXEL_EFFECT = {
  // Not a parameter that fails to reach pixels - it is a switch over all six crop faces
  // and reaches them hard. It is invisible to *this method*: the sweep drops a parameter
  // and lets it fall back to its default, and `crop` is scrambled to its default because
  // flipping it would take the six faces beside it out of the picture. A drop-one sweep
  // cannot see a parameter it cannot drop. The section that does see it is
  // "the crop switch, which the sweep above cannot see", and this entry is a hole
  // without it.
  crop: 'its scrambled value is its default, because releasing the box would make the '
    + 'six faces it gates unobservable - proven instead by the section below',
  spin: 'auto-orbit only advances when the animation loop calls controls.update, '
    + 'and a pinned run has replaced the loop',
  camera: 'nothing draws the program camera on the pinned run - the viewport is the '
    + 'free camera - so a pose reaches the camera object and no pixel',
};

// ---------------------------------------------------------------- page helpers

const PAGE_HELPERS = `
  const k = globalThis.__kinect;
  const sha256 = async (bytes) => {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  };
  const pinCamera = (cam) => {
    cam.position.set(0, 0.1, 1.6);
    cam.lookAt(0, 0, -2.2);
    cam.updateMatrixWorld(true);
  };
`;

const landingReader = `(() => {
  const k = globalThis.__kinect;
  return { ${Object.entries(LANDING).map(([n, e]) => `${n}: (${e})`).join(', ')} };
})()`;

// The same reader with every expression allowed to come back undefined, and it is used
// on exactly one page: the revision the golden comparison plays back. That build
// predates some of these parameters, so reading `k.uniforms.regionCentre.value.x` there
// is a TypeError rather than a finding, and one throw takes the whole section with it.
//
// Deliberately *not* used for the current page. A LANDING entry naming a uniform this
// build does not have is a real bug in the check, and swallowing it on both arms would
// turn every such typo into a silent `undefined === undefined` pass - the shape this
// repo keeps finding, where an instrument stops being able to fail.
const tolerantLandingReader = `(() => {
  const k = globalThis.__kinect;
  const at = (f) => { try { return f(); } catch { return undefined; } };
  return { ${Object.entries(LANDING).map(([n, e]) => `${n}: at(() => (${e}))`).join(', ')} };
})()`;

const readLanding = (page) => page.evaluate(landingReader);

// Everything the two arms of the before/after comparison can both answer. No
// `k.params` here: the committed page has none, and a snapshot that only the new
// page could produce would compare nothing.
// `mode` and the `#modes` pressed states used to be in here, and they cannot be: the
// integer uniform and the five buttons exist on one side of this comparison only, so
// the field would read `0 -> undefined` at every stage and the arm would fail on the
// change it is meant to be measuring. What replaced the mode is five ordinary look
// parameters, which arrive in `dom` and `readouts` with every other slider - and the
// claim that each of them renders what its mode rendered is not a state comparison at
// all. It is section 1b, which hashes the framebuffer.
const snapshotWith = (reader) => `(() => {
  const k = globalThis.__kinect;
  return {
    landing: ${reader},
    fog: k.scene.fog.color.getHex(),
    dom: Object.fromEntries([...document.querySelectorAll('#panel input')]
      .map((el) => [el.id, el.type === 'checkbox' ? el.checked : el.value])),
    // Range rows only. A readout is the number beside a slider, so a checkbox row has
    // none by design - and the monitor group added one in step 9, at which point this
    // map started calling .textContent on null and took the whole section down before
    // a single assertion ran. Filtering to the rows that are supposed to have a readout
    // is what the map always meant.
    //
    // The missing one is still reported rather than skipped: a *slider* that lost its
    // output is exactly the regression this map exists to catch, and it now shows up as
    // a differing value instead of as a crash.
    readouts: Object.fromEntries([...document.querySelectorAll('#panel .row')]
      .filter((r) => r.querySelector('input')?.type === 'range')
      .map((r) => [r.querySelector('input').id,
        r.querySelector('output')?.textContent ?? '(no output element)'])),
  };
})()`;

// ------------------------------------------------------------------- the pages

const { chromium } = await loadPlaywright();
// The full chromium build rather than the headless shell: the shell can land on
// SwiftShader, and a run that quietly fell back to a software rasteriser would
// agree with itself for the wrong reason.
const browser = await chromium.launch({ channel: 'chromium', headless: !HEADED });
const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });

const fixture = buildFixture(CAPTURE);

// A page with no source of its own is this tree's page, which under `--mutate` means
// the mutated one. The arms that name a source are the historical revisions, and they
// are deliberately left alone: mutating the thing a comparison is measured *against*
// would move both sides and prove nothing.
async function openPage({
  source = mutatedSource,
  pin = false,
  viewportSize = VIEW,
  comparisonShell = false,
} = {}) {
  const page = await context.newPage();
  if (viewportSize.width !== VIEW.width || viewportSize.height !== VIEW.height) {
    await page.setViewportSize(viewportSize);
  }
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`${msg.text()} @ ${JSON.stringify(msg.location())}`); });
  // A console error names no URL, so the response is recorded alongside it - a
  // 404 on the module and a 404 on the tab icon read identically otherwise, and
  // one of those is the check silently measuring a page that never loaded.
  page.on('response', (res) => { if (!res.ok()) errors.push(`${res.status()} ${res.url()}`); });

  // No frame may arrive. The look values under test do not depend on the stream,
  // and letting the server decide whether one lands would make a verdict that
  // flips between runs on an unchanged tree.
  await page.routeWebSocket(/.*/, () => { /* accepted, never connected */ });

  // The tab icon, answered rather than left to 404. The server has never served
  // one, and the console error it produces is indistinguishable from a real
  // failure to load - which would either be ignored by hand here, hiding the real
  // ones with it, or left to fail the run for a reason that is not about the page.
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));

  let servedHtml = false;
  if (source) {
    // The panel and the module are served as one pair. The committed page reads
    // its ranges out of its own HTML, so pairing the old module with the new
    // markup would boot it on whatever a range input defaults to and the
    // comparison would be against a page that never existed.
    //
    // The predicate and the `goto` below read one constant rather than each
    // spelling the path. They used to name `/` and `/index.html` while the page
    // was opened at `/`, and the recorder has since moved to `/record` - two
    // places that must agree about a path and do not is how the before arm ends
    // up quietly loading the tree's own markup and printing two matching columns
    // under a heading that says they came from different code.
    await page.route((url) => url.pathname === RECORDER_PATH,
      (route) => { servedHtml = true; return route.fulfill({ contentType: 'text/html; charset=utf-8', body: source.html }); });
    await page.route('**/main.js', (route) => route.fulfill({
      contentType: 'text/javascript; charset=utf-8', body: source.js,
    }));
  }
  if (pin) {
    await page.route('**/__pinned.bin', (route) => route.fulfill({
      status: 200, contentType: 'application/octet-stream', body: fixture,
    }));
  }

  await page.goto(URL_BASE + RECORDER_PATH, { waitUntil: 'load' });
  // Proof the interception held, for the same reason the focal reading below is
  // here. A predicate that stops matching pairs the old module with today's
  // markup, which throws at boot on the first parameter this tree has renamed -
  // and that arrives as a 30-second `waitForFunction` timeout naming nothing,
  // which is a wrong URL wearing the shape of a missing feature.
  if (source && !servedHtml) {
    throw new Error(`the page markup was never intercepted - landed on ${new URL(page.url()).pathname}, `
      + `so the ${BEFORE_REV} arm loaded the tree's own page`);
  }
  await page.waitForFunction(() => !!globalThis.__kinect);
  if (comparisonShell) {
    // The comparison build predates the fixed application bar. Canonicalise both
    // revisions onto its existing bottom-strip allocation before changing target
    // aspect, so the comparison viewport gives both the same 640x400 content box
    // through the same layout mechanism. The real current shell is measured separately
    // below and by editor-check; this arm is about shader identity across the old mode
    // boundary, at the fixed 640x400 frame it was originally calibrated against.
    await page.evaluate((height) => {
      const appBar = document.getElementById('appBar');
      if (appBar) appBar.style.display = 'none';
      const timeline = document.getElementById('timeline');
      timeline.hidden = false;
      timeline.style.height = `${height}px`;
      timeline.style.minHeight = `${height}px`;
      timeline.style.maxHeight = `${height}px`;
      dispatchEvent(new Event('resize'));
    }, APP_BAR_HEIGHT);
  }
  // **The page frames at the stage this tool asked for.** The editor letterboxes
  // itself to the export aspect now, so a viewport alone no longer decides the
  // drawing buffer: a 640x400 stage is 1.6, the menu's default is 16:9, and the fit
  // makes the buffer 640x360 with a 20px offset unless told otherwise. That moves
  // every buffer-size expectation and every pointer coordinate in this file.
  await page.evaluate('globalThis.__kinect.setTargetSize?.("640x400")');

  // Proof the interception held, independent of the readings it protects. The
  // sensor's hello carries fx as 366.031494 and the uniform defaults to exactly
  // 366, so the default still standing means nothing came over the socket.
  const focal = await page.evaluate('globalThis.__kinect.uniforms.focal.value.x');
  if (focal !== 366) throw new Error(`websocket interception failed - intrinsics arrived (focal.x=${focal})`);

  return { page, errors };
}

// =============================================================== 1. before/after

console.log(`[registry] nothing moved: boot state against ${BEFORE_REV}`);

const beforeSource = {
  js: execFileSync('git', ['show', `${BEFORE_REV}:web/main.js`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }),
  html: execFileSync('git', ['show', `${BEFORE_REV}:web/index.html`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }),
};
// Once step 3 is committed, a bare --before HEAD would serve the registry into
// both arms and print two matching columns under a heading that says they came
// from different code. Refusing beats that.
if (beforeSource.js.includes('const PARAMS')) {
  throw new Error(`${BEFORE_REV}:web/main.js already contains the registry - pass an earlier rev with --before`);
}

// This used to walk every mode, then Blackwall and out of it twice, because the
// interesting case was the transition rather than the state: entering wrote twelve
// look values and leaving wrote them back. There is no such transition to walk any
// more, and its absence is the change rather than a gap in the check - selecting a
// reading writes the reading and nothing else, which is what "look and shading are
// one thing" cost the mode. A walk asserting that entering Blackwall still rewrites
// twelve sliders would be asserting the weld that was removed.
//
// So this arm compares boot state alone, and the claim it used to make about the
// readings is made properly one section down: not "the sliders agree" but "the
// framebuffer is identical", which is the equality the old walk was standing in for.

// The program pose at a few positions, read in the same task as the render so the
// live loop cannot re-render at 0 underneath the reading. Nothing draws the
// program camera here, which is exactly why it is worth reading: the pose moved
// from a mutation to a value the registry applies, and three orients cameras down
// -Z where it orients everything else down +Z, so a slip would be invisible until
// something drew the frustum.
//
// **This is no longer compared against the earlier revision, and the reason is a
// deletion rather than a tolerance.** At that revision the pose came from a
// placeholder orbit - a slow revolution, one turn per hundred seconds - which step
// 5 replaced with the camera track the design always called for. There is nothing
// left to compare it to: with no camera keys the pose is now a clip's single
// static value, which is the deliberate behaviour and is asserted as such below.
// The moving case is proved in `keyframe-check`, against a track rather than
// against a placeholder.
const readPoses = `(() => {
  const k = globalThis.__kinect;
  const out = {};
  for (const t of [0.7, 1.9]) {
    k.renderProgramFrame(t);
    out[t] = {
      position: k.programCamera.position.toArray(),
      quaternion: k.programCamera.quaternion.toArray(),
      fov: k.programCamera.fov,
    };
  }
  return out;
})()`;

async function bootState(opts, reader = landingReader) {
  const { page, errors } = await openPage(opts);
  const out = { boot: await page.evaluate(snapshotWith(reader)) };
  const poses = await page.evaluate(readPoses);
  return { out, poses, errors, page };
}

// **The after arm goes first, because it is what says how tall the bar is.** The
// before arm's viewport is derived from that measurement, so the order is a
// dependency rather than a preference.
const afterArm = await bootState({});
const measuredBar = await afterArm.page.evaluate(
  "Math.round(document.getElementById('appBar').getBoundingClientRect().height)");
await afterArm.page.close();
if (!Number.isFinite(measuredBar) || measuredBar <= 0) {
  throw new Error(`the application bar measured ${measuredBar}px - the shell this arm is compared against is not on the page`);
}
shellGeometry(measuredBar);
console.log(`  the shell's application bar measures ${APP_BAR_HEIGHT}px, `
  + `so the content box both arms render is ${SHELL_CONTENT.width}x${SHELL_CONTENT.height}`);

const beforeArm = await bootState(
  { source: beforeSource, viewportSize: SHELL_CONTENT },
  tolerantLandingReader,
);
await beforeArm.page.close();

// The camera is left out of the landing comparison, alone among the twenty-five,
// and only here. Every other parameter lands on the same uniform it landed on
// before the registry existed, so an equality is a regression test. The camera's
// landing site at that revision was a placeholder orbit computed from `t` inside
// the render, and step 5 deleted it - so the two arms are being asked to agree
// about a value one of them derives from something the other does not have. The
// pose is still swept, still restored and still checked against what the camera
// object holds, further down; it is only this one before/after that has nothing
// left to say.
const GOLDEN_SKIP = new Set(['camera']);

// The one value that legitimately moved, and it is rescaled rather than skipped.
//
// Step 6 made every screen-space term relative to a 1080p reference, which changed
// what `pointSize` *means*: it is pixels at 1080p now, where it used to be pixels
// at whatever buffer the look happened to be graded against - the 600-tall one the
// design document's resolution A/B calls the good size. So both presets and the
// registry default took the factor 1080/600, and comparing the raw number across
// that change would be comparing two different quantities.
//
// Skipping it the way the camera is skipped would have been weaker than what this
// replaces. The camera has nothing left to compare against, because the placeholder
// orbit it used to come from was deleted; `pointSize` has an exact expected value,
// so the equality becomes an equality against that instead of going away. A value
// that moved by any other factor still fails here.
const POINT_SIZE_REBASE = 1080 / 600;
const GOLDEN_RESCALE = { pointSize: POINT_SIZE_REBASE };

// Parameters that did not exist at BEFORE_REV, so there is no earlier value to hold
// them to. This is the `camera` case rather than the `pointSize` case - nothing left to
// compare against - but it is not a skip, and the difference is what keeps it honest:
// a name is only excused here if the *earlier* arm answered `undefined`, which is the
// signature of a uniform, a slider and a readout that genuinely were not there. Put a
// name in this set that did exist at that revision and it still fails, because its old
// value is a number and a number is not undefined.
//
// What that leaves proven is the claim worth making about an added look parameter: the
// twenty-five that were already here render and read back exactly as they did, so
// twelve new sliders at their defaults changed no image. Whether the new ones reach the
// pixels at all is section 9's question, not this one's.
const GOLDEN_ABSENT = new Set([
  'noise', 'noiseScale', 'noiseSpeed',
  'lattice', 'latticeCell',
  'regionX', 'regionY', 'regionZ', 'regionW', 'regionH', 'regionD',
  'regionRound', 'regionSoft', 'regionPush', 'regionNoise', 'regionMask',
  'ripple', 'rippleFreq', 'rippleSpeed',
  'thermal', 'edges',
  // The four lateral crop faces. They are excused here on the same terms as the rest -
  // the pinned revision has no such control, so there is nothing on that side to hold
  // them to - and the excuse costs nothing, because the defaults are the bounds: a
  // build with these planes wide open renders exactly what a build without them
  // renders. That equality is the row above, and it is the reason this arm still means
  // something with four more parameters in it.
  'left', 'right', 'bottom', 'top',
  // The switch over all six of them, and it is excused on the strongest version of the
  // terms the four faces above are: not merely that the pinned revision has no such
  // control, but that its default is the state that revision was permanently in. A build
  // whose box always bites renders exactly what a build with a switch defaulting to
  // biting renders, so this arm is unchanged by the switch existing. What happens when
  // it is *off* is not excused anywhere - it is asserted three ways in "the crop switch,
  // which the sweep above cannot see".
  'crop',
  // The two levelling angles, excused on exactly the crop faces' terms and for exactly
  // their reason: the pinned revision has no such control, and the default is the
  // identity rotation, so a build that levels the room by nothing renders what a build
  // that cannot level it at all renders. That equality is what the row above is
  // asserting, and it is why this arm still means something with two more parameters
  // in it. Whether they reach the pixels when they are *not* zero is section 9's
  // question, and the drop-one sweep there answers it.
  'tilt', 'roll',
  // Not registry parameters at all - the monitor's stream controls, which arrived with
  // step 9 and carry their own bounds in the markup. They are in this set for the same
  // reason as the rest: the earlier revision has no such control, so there is nothing
  // to hold them to here. What they *are* held to is `monitor-check`.
  'monDivisor', 'monStride', 'monAcceptCost',
  // The five readings, which are the parameters this comparison exists to be honest
  // about. At that revision the reading was an integer uniform behind five buttons,
  // so there is no earlier slider, readout or value to hold these to - the `camera`
  // case, not the `pointSize` case. What makes the excuse safe rather than convenient
  // is that their defaults are the boot mode: `readRgb` at 1 with the other four at 0
  // is what `mode == 0` was, so a build with them renders exactly what a build without
  // them rendered, which is precisely the equality the rest of this arm is measuring.
  // That the equality actually holds is not taken on trust here either - section 1b
  // hashes the framebuffer of each reading against the mode it replaced.
  'readRgb', 'readDepth', 'readGhost', 'readContour', 'readBlackwall',
  // The seven constants each reading is made of, excused on exactly the terms above and
  // for a reason that is the same sentence twice over. At the pinned revision every one
  // of these was a literal inside a mode branch, so there is no earlier slider, readout
  // or value to hold them to - and each one defaults to the literal it replaced, so a
  // build with them renders precisely what a build without them rendered. That is the
  // equality this arm measures, and section 1b is where it stops being an excuse and
  // becomes a framebuffer hash: every one of these lives inside a reading, so a default
  // that drifted moves that reading's image and fails there by name.
  'rgbSaturation', 'depthGamma', 'ghostRim', 'ghostFill',
  'contourBands', 'contourWidth', 'blackwallSweep',
  // The five ceilings under the glitch master, on exactly those terms: at the pinned
  // revision each was a literal inside the vertex stage's glitch block, and each
  // defaults to the literal it replaced, so a build carrying them tears identically to
  // one without them. What holds them to that is section 1b, which renders at parameter
  // defaults - a default that drifted off its literal would move whichever readings the
  // torn bands reach and fail there by name rather than being excused here.
  'glitchDensity', 'glitchShove', 'glitchTint', 'glitchBands', 'glitchRate',
  // The band axis, which had no control at the pinned revision because the tear was cut
  // along the sensor's rows and nothing else. It defaults to 0 and the block reaches the
  // old division textually at that value, so a build carrying it draws what a build
  // without it drew.
  'glitchAxis',
  // `vignette` is here on different terms from everything above it, and the difference
  // is worth the sentence. It was a literal too, but it is the one promoted literal that
  // does NOT keep its old value: the behaviour it replaces is conditional - 0.55 while
  // some other grade term held the pass open, 0 while none did - so no default can
  // reproduce both branches. It defaults to the branch the parameter defaults are in,
  // which is why section 1b still agrees with a build from before it existed. The look
  // that did carry a vignette, `blackwall.json`, now names 0.55 for itself.
  'vignette',
  // The duotone's four, on the plainest version of these terms: nothing at the pinned
  // revision resembles them, and all four default to the identity - a depth of 0 never
  // enters the block, so a build carrying them draws precisely what a build without them
  // drew. That equality is what this arm measures, and section 1b is where it stops being
  // an excuse and becomes a framebuffer hash, since the duotone sits after the blend and
  // would move every one of the five readings if its default reached a pixel.
  //
  // **`duotoneMotion` is the one of the four that section 1b cannot vouch for**, and the
  // difference is worth the sentence rather than being carried along with its neighbours.
  // 1b renders at parameter defaults, where the depth is 0 and the block never executes,
  // so a term added *inside* it is unreached by that hash whichever way its own default
  // behaves - which is exactly the hole the glitch flare's compensating default fell
  // through. What holds this one instead is the planted section at the foot of this file,
  // where the block is entered with the depth up and a pair carrying real motion, and the
  // frame at a motion of 0 has to come back bit-identical to the frame with no motion in
  // it at all.
  //
  // **`duotoneSpan` is excused on the strongest version of these terms and is the only one
  // of the five that can say so.** The rest are excused because the pinned revision has no
  // such control; this one is excused because its default *is* the arithmetic that
  // revision ran. The ramp used to span the clip range, and the default here is the clip
  // range's own default width, so the division that converts it lands on exactly 1.0 and
  // the expression is the one the pinned build compiled. That is a claim about two float
  // literals rounding to the same value rather than about the derivation, so it is not
  // taken on trust: the commit that added this parameter carries the five readings'
  // hashes either side of the change, and section 1b is where a drift in it would show.
  'duotoneDepth', 'duotoneHue', 'duotoneSplit', 'duotoneSpan', 'duotoneMotion',
  // `crush` is here on `vignette`'s terms turned the other way up, and the contrast is
  // the reason it gets its own sentence. It was a literal too, and unlike the vignette it
  // *keeps* the value it replaced - so the excuse is the strong one rather than the
  // conditional one: 0.018 is what the grade always subtracted, and a build whose toe is
  // a uniform sitting at 0.018 draws what a build with the literal drew. What it cannot
  // be excused for is gating the pass, which nothing here would see and the pass-gate
  // matrix asserts directly.
  'crush',
  // The raster's three, on the terms the glitch ceilings are excused by: at the pinned
  // revision the pitch was a literal inside the wave and the other two did not exist in
  // any form, and each defaults to the behaviour that build had - an angle of zero along
  // the frame's y, the pitch's own 1.3, and a hardness whose zero is the identity. So a
  // build carrying them draws precisely what a build without them drew, which is the
  // equality this arm measures. That it holds is not taken on trust: section 1b renders
  // at parameter defaults, where the raster block does not run at all, and the drop-one
  // sweep is where the three are shown to reach pixels once the master is up.
  'scanAngle', 'scanPitch', 'scanHard',
  // The streak, which had no control and no uniform at the pinned revision. It defaults to
  // zero and the block is guarded on that, so a build carrying it draws exactly what a
  // build without it drew - the same argument the three above are excused by, and held to
  // the same standard: the pass-gate row below has it opening the grade on its own, and
  // the drop-one sweep has it reaching pixels once it is up.
  'streak',
  // And its direction, which is excused twice over: there was no streak at the pinned
  // revision to point anywhere, and the axis it defaults to is the one the gather ran
  // along when it ran one way only. That second half is the stronger claim and it is not
  // taken on trust here either - the gather's own comment carries the hash comparison, and
  // section 1b renders at parameter defaults, where a streak of 0 keeps the block shut
  // whichever way the axis points.
  'streakAngle',
  // The program-out size, on the same terms and for the same reason: not a registry
  // parameter, no such control at the earlier revision, and its own bounds live in the
  // handler that parses it rather than in the markup. What it is held to is
  // `vcam-check`, whose section 5 asserts the drawing buffer really is the size this
  // box says and not the window's. `progMode` is not here because it is a `select`
  // and the snapshot walks `#panel input` - if it ever becomes an input it will
  // arrive here as a failure, which is the right way round.
  'progSize',
  // A file chooser is a control over a document, not a registry parameter. It arrived
  // with look import and has no earlier value to hold against the pre-registry page;
  // section 12 of editor-check drives the file through validation and back into the
  // renderer, while this tool's markup scan still refuses any parameter data in HTML.
  'tPresetFile',
]);
const absentBefore = (name, before) => GOLDEN_ABSENT.has(name) && before === undefined;

// The mirror, and it needs the mirrored evidence. `warp` and `warpSpeed` drove a fixed
// three-term sine field; the noise field replaced them, so their old values describe a
// displacement this build cannot produce and there is no rescale that recovers one from
// the other - the sine's amplitude and the noise's are both metres, but of different
// fields. A name is only excused if the *current* arm answers undefined, so putting one
// here that still exists fails on its own value.
const GOLDEN_REMOVED = new Set(['warp', 'warpSpeed']);
const removedSince = (name, after) => GOLDEN_REMOVED.has(name) && after === undefined;

const rescaled = (name, before, after) => {
  const factor = GOLDEN_RESCALE[name];
  if (!factor) return false;
  const x = Number(before);
  const y = Number(after);
  return Number.isFinite(x) && Number.isFinite(y) && y === x * factor;
};

for (const stage of Object.keys(beforeArm.out)) {
  const a = beforeArm.out[stage];
  const b = afterArm.out[stage];
  const unexplained = (field) => (typeof a[field] === 'object' && a[field]
    // Keyed off the union rather than the earlier arm's keys, because a parameter this
    // build added is absent from `a` entirely - iterating `a` alone would step straight
    // past every new name and call that agreement.
    ? [...new Set([...Object.keys(a[field]), ...Object.keys(b[field] ?? {})])]
      .filter((sub) => !eq(a[field][sub], b[field][sub])
        && !GOLDEN_SKIP.has(sub) && !rescaled(sub, a[field][sub], b[field][sub])
        && !absentBefore(sub, a[field][sub]) && !removedSince(sub, b[field][sub]))
    : []);
  const differing = Object.keys(a).filter((field) => {
    if (eq(a[field], b[field])) return false;
    if (typeof a[field] !== 'object' || !a[field]) return true;
    return unexplained(field).length > 0;
  });
  const detail = differing.map((field) => {
    const keys = unexplained(field);
    return keys.length
      ? `${field}{${keys.map((s) => `${s}: ${show(a[field][s])} -> ${show(b[field][s])}`).join(', ')}}`
      : `${field}: ${show(a[field])} -> ${show(b[field])}`;
  }).join('; ');
  check(differing.length === 0, `${stage.padEnd(10)} identical to ${BEFORE_REV}`, detail);
}

// And the rescale is asserted rather than assumed, at every stage of the walk and
// on all three views of the value - the uniform it lands on, the slider and the
// readout - so a preset re-tuned by hand to something near 1.8 would fail here.
{
  const wrong = [];
  const seen = [];
  for (const stage of Object.keys(beforeArm.out)) {
    for (const field of ['landing', 'dom', 'readouts']) {
      const x = Number(beforeArm.out[stage][field]?.pointSize);
      const y = Number(afterArm.out[stage][field]?.pointSize);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (field === 'landing') seen.push(`${stage} ${x}->${y}`);
      if (y !== x * POINT_SIZE_REBASE) wrong.push(`${stage}.${field} ${x} -> ${y}`);
    }
  }
  check(wrong.length === 0,
    `and pointSize moved by exactly 1080/600 everywhere it appears, because its unit did`,
    wrong.length ? wrong.join('; ') : seen.join(', '));
}

// The fixed shell gives the renderer 32 fewer vertical pixels. With the proof's
// 640x400 target aspect that content box is 589x368. The historical page has no target
// fit, so it is opened directly at that content size; both arms must then land on the
// same exact buffer rather than gaining a layout exception in the golden comparison.
check(
  beforeArm.out.boot.landing.renderScale === SHELL_CONTENT.width
    && afterArm.out.boot.landing.renderScale === SHELL_CONTENT.width,
  'and renderScale lands on exactly the fixed shell content fit',
  `${beforeArm.out.boot.landing.renderScale}->${afterArm.out.boot.landing.renderScale}, `
    + `wanted ${SHELL_CONTENT.width}->${SHELL_CONTENT.width}`,
);

// With no camera keys the pose is a single value the clip holds, so two renders at
// different program times land on the same place. That is the whole of the
// locked-off case and it is worth asserting rather than assuming: a render that
// still computed a pose from `t` would move here, which is the placeholder coming
// back by accident.
check(eq(afterArm.poses['0.7'], afterArm.poses['1.9']),
  'with no camera keys the program pose is the clip\'s single value at every program time',
  eq(afterArm.poses['0.7'], afterArm.poses['1.9']) ? '' : show(afterArm.poses));
console.log(`  pose at 0.7s ${show(afterArm.poses['0.7'].position.map((x) => +x.toFixed(6)))} `
  + `q ${show(afterArm.poses['0.7'].quaternion.map((x) => +x.toFixed(6)))}`);

if (beforeArm.errors.length || afterArm.errors.length) {
  console.log(`  page errors: ${[...beforeArm.errors, ...afterArm.errors].join(' | ')}`);
  failures++;
}

// ================================ 1b. each reading renders what its mode rendered

// The claim the whole look/shading merge rests on, and the only one in this file that
// compares two revisions by their pixels rather than by their state.
//
// Dissolving `mode` into five weights rewrote the arithmetic every fragment goes
// through: what was one branch of a five-way `if` is now a weighted sum divided by
// the sum of the weights. The intent is that a single reading at 1.0 is arithmetically
// the identity - `x * 1.0 / 1.0` - so every look ever authored, every saved project and
// every preset renders the pixels it always did. That is an argument, and an argument
// about floating point in a shader compiled by a driver is worth exactly nothing until
// it is hashed.
//
// **Why this is not section 1 with another field bolted on.** Section 1 compares
// uniforms, slider values and readouts. It cannot answer this: the mode and the five
// weights exist on opposite sides of the comparison, so there is no field the two arms
// could both fill in. And its before-arm is deliberately a *pre-registry* revision -
// `--before` refuses any rev containing `const PARAMS` - which is a page with no
// `k.drive` and therefore no way to read a pixel at all.
//
// So this arm takes its own revision. `--against` wants the commit before the readings
// landed, which is a rev that has both the registry and the drive harness: exactly the
// rev `--before` will not accept. Two flags because they are two different questions.
// Before the readings are committed there is no commit introducing them, so the
// marker resolves to nothing and HEAD is the correct answer - that is the whole of
// the working-tree case, where the change under test is exactly what is uncommitted.
// Falling back is only safe because of the refusal below: if this ever silently
// resolved to a rev that already has the readings, the arm would compare the tree
// against itself and print five matching hashes as a pass.
const AGAINST_REV = flag('--against')
  ?? (execFileSync('git', ['log', '-S', 'readBlackwall', '--format=%H', '--', 'web/main.js'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }).trim()
    ? revBeforeMarker('readBlackwall')
    : 'HEAD');

// Each reading, and the mode it was. The old build selects by writing the integer
// uniform directly rather than by clicking its button, and that is the point of the
// arm rather than a shortcut: `setMode(4)` applied a hardcoded twelve-value preset on
// the way past, so a click would be comparing the reading *plus a look* against the
// reading alone, and the whole reason this change exists is that those were welded.
// What is under test is the reading.
const READING_WAS = { readRgb: 0, readDepth: 1, readGhost: 2, readContour: 3, readBlackwall: 4 };

console.log(`\n[registry] each reading renders what its mode rendered, at ${AGAINST_REV}`);

{
  const againstSource = {
    js: execFileSync('git', ['show', `${AGAINST_REV}:web/main.js`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }),
    html: execFileSync('git', ['show', `${AGAINST_REV}:web/index.html`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }),
  };
  // The mirror of section 1's refusal, and it runs the other way. That one refuses a rev
  // that already has the registry; this one refuses a rev that already has the readings,
  // because serving today's page into both arms would print five matching hashes under a
  // heading claiming they came from different code - which is the failure mode this file
  // has recorded happening once already.
  if (againstSource.js.includes('readBlackwall')) {
    throw new Error(`${AGAINST_REV}:web/main.js already contains the readings - pass an earlier rev with --against`);
  }
  if (!againstSource.js.includes('uniforms.mode.value')) {
    throw new Error(`${AGAINST_REV}:web/main.js has no mode uniform to compare against`);
  }

  // **The old arm is the old readings, not the old geometry.** The unprojection's x sign
  // changed after this rev: the sensor's frames arrive horizontally mirrored and this build
  // undoes them, which `unproject` in `web/main.js` carries the reasoning for. Left alone,
  // the pinned build draws the room reflected and every row below reports 6 of 6 frames
  // differing over a change that has nothing to do with a reading - measured, before this
  // was here: all five rows plus the raster, uniformly, where at HEAD five of the six pass.
  //
  // **This is the rule the raster arm below already states, arriving at a divergence that
  // has no parameter to express it.** That one hands the two builds different `vignette`
  // values because a promotion in `40ab241` baked the corner falloff into one of them, on
  // the principle that each build has to be given the values that mean the same picture in
  // its own vocabulary rather than the same numbers. A geometry difference has no value to
  // hand over, so the vocabulary is the source text and the patch goes here.
  //
  // Guarded the way the mutations are, and for the same reason: the text has to appear
  // exactly once or this refuses to run. A rev where it stopped matching would otherwise
  // quietly become a comparison against un-normalised geometry that reports differences as
  // findings about the readings, which is the one failure this whole section is arranged to
  // avoid. It is one entry because there has been one intentional geometry change; a second
  // belongs beside it rather than folded into it, so the list stays a readable account of
  // how this build differs from the one it is held against.
  const OLD_UNPROJECT_X = '     (pixel.x + 0.5 - center.x) / focal.x * z,';
  const MIRRORED_UNPROJECT_X = '    -(pixel.x + 0.5 - center.x) / focal.x * z,';
  const xHits = againstSource.js.split(OLD_UNPROJECT_X).length - 1;
  if (xHits !== 1) {
    throw new Error(`${AGAINST_REV}:web/main.js states the unprojection's x ${xHits} times, expected exactly 1`
      + ' - refusing to compare a mirrored build against an unmirrored one and report it as a reading');
  }
  againstSource.js = againstSource.js.replace(OLD_UNPROJECT_X, MIRRORED_UNPROJECT_X);

  // Both arms are pinned to the same frames and the same camera, so the only thing
  // that differs between them is the shader. `params.reset()` first on each, because a
  // reading has to be measured against the same defaults the other arm booted with.
  const hashesFor = async (opts, select, cases = READING_WAS, extra = '') => {
    const { page: p, errors } = await openPage({ ...opts, pin: true });
    await p.evaluate(async () => {
      const buffer = await (await fetch('/__pinned.bin')).arrayBuffer();
      globalThis.__kinect.drive.pin(buffer);
    });
    const at = await p.evaluate(`(() => {
      const times = globalThis.__kinect.drive.times();
      return times.slice(0, ${SOURCE_FRAMES});
    })()`);
    const meta = await p.evaluate(`(() => {
      const k = globalThis.__kinect;
      const gl = k.renderer.getContext();
      const box = k.renderer.domElement.getBoundingClientRect();
      return {
        window: [innerWidth, innerHeight],
        canvas: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        css: [box.x, box.y, box.width, box.height],
        composer: [k.composer.renderTarget1.width, k.composer.renderTarget1.height],
        afterimage: [k.afterimage._textureComp.width, k.afterimage._textureComp.height],
        cameraAspect: k.freeCamera.aspect,
        bufferHeight: k.uniforms.bufferHeight.value,
      };
    })()`);
    const out = {};
    for (const [reading, mode] of Object.entries(cases)) {
      out[reading] = await p.evaluate(`(async () => {
        ${PAGE_HELPERS}
        k.params.reset();
        ${select}
        ${extra}
        k.drive.reset();
        pinCamera(k.freeCamera);
        const hashes = [];
        for (const t of ${JSON.stringify(at)}) {
          k.drive.stepTo(t);
          hashes.push(await sha256(k.drive.readPixels()));
        }
        return hashes;
      })()`.replace(/\$MODE/g, String(mode)).replace(/\$READING/g, JSON.stringify(reading)));
    }
    await p.close();
    return { out, errors, meta };
  };

  const oldArm = await hashesFor(
    { source: againstSource, viewportSize: COMPARISON_VIEW, comparisonShell: true },
    'k.uniforms.mode.value = $MODE;',
  );
  const newArm = await hashesFor(
    { viewportSize: COMPARISON_VIEW, comparisonShell: true },
    'k.readings().forEach((n) => k.params.set(n, 0)); k.params.set($READING, 1);',
  );
  console.log(`  comparison geometry old ${JSON.stringify(oldArm.meta)} new ${JSON.stringify(newArm.meta)}`);

  for (const [reading, mode] of Object.entries(READING_WAS)) {
    const a = oldArm.out[reading];
    const b = newArm.out[reading];
    const first = a.findIndex((h, i) => h !== b[i]);
    check(eq(a, b),
      `${reading.padEnd(13)} at 1.0 is bit-identical to mode ${mode} at ${AGAINST_REV}`,
      // **Which frames, not which frame.** Reporting only the first mismatch cannot
      // tell a transient from a divergence, and those are different findings: one
      // frame out of a walk is a warm-up the two builds enter differently, while every
      // frame from some index on is a term that has actually changed. `readGhost` is
      // the row that needed asking - it disagrees at exactly one frame of however many
      // are walked - and the old detail line looked identical either way.
      first < 0
        ? `${a.length} frames`
        : `${a.filter((h, i) => h !== b[i]).length} of ${a.length} frames differ, first at `
          + `${first}: ${a[first].slice(0, 12)} vs ${b[first].slice(0, 12)} `
          + `(mismatched: ${a.map((h, i) => (h === b[i] ? null : i)).filter((i) => i !== null).join(', ')})`);
  }

  // ---- the grade term whose default is not zero, at the value the shipped look uses.
  //
  // **The five rows above cannot see the raster at all, and that is worth saying plainly
  // rather than leaving as a gap somebody finds later.** They render at parameter
  // defaults, `scanlines` defaults to 0, and the whole raster block sits behind
  // `if (scanlines > 0.0)` - so a run that came back bit-identical has measured the
  // branch being added and not one line of the arithmetic inside it. Every mutation in
  // this file's table is likewise blind to it, because the drop-one sweep compares arms
  // of one build against each other rather than against a build from before.
  //
  // What makes that a hole rather than a nicety is `presets-builtin/blackwall.json`,
  // which names `scanlines: 0.35`. The generalisation replaced an inline expression with
  // a coordinate through a local, which is exactly the substitution `docs/measurement.md`
  // records producing a third image out of two that were each bit-identical - so "the
  // defaults reach the old expression" is a claim about a compiler, and the shipped look
  // is what pays if it is wrong. `determinism-check` and `export-check` both read that
  // file and deliberately *follow* it rather than pinning it, so neither would notice.
  //
  // One reading, so the raster is the only thing that can differ between the arms, and
  // **Blackwall rather than colour, which is a correction rather than a preference.**
  // Written on `readRgb` first, this arm was an arm lit by a single source: the pinned
  // build selects a reading by integer mode and cannot mix, so one reading is all either
  // side gets, and `--mutate rgb-contributes-no-alpha` then renders black on both of them.
  // They compare identical, the control reports `0 of 6 frames differ with the master
  // off`, and the whole section fires against a mutation with nothing to do with the
  // raster - which is the last entry in `docs/instruments.md`, reproduced in the tool that
  // entry is about. Blackwall writes its own alpha and the readRgb block is guarded on a
  // weight this arm leaves at zero, so no reading's mutation can switch this probe off.
  //
  // It is also the more faithful choice: `blackwall.json` is the document that names a
  // scanlines of 0.35, so this arm now stands where the shipped look actually stands.
  //
  // **The two arms are handed different values on purpose, and the first version of this
  // row was wrong for exactly the reason that sounds like a bug.** Raising the raster
  // opens the grade pass on both builds, and the pinned one bakes its corner falloff into
  // that pass as `mix(1.0, vig, 0.55)` where this one reads a `vignette` parameter that
  // defaults to 0. So the obvious arrangement - the same look on both sides - compares a
  // frame with a vignette against a frame without one, and reports 6 of 6 frames differing
  // over a promotion that landed in `40ab241` and has nothing to do with the raster. Named
  // here, the two arms draw the same corner falloff and the raster is what is left.
  //
  // This is the units error `export-check`'s cross-build arm already records, arriving
  // from the other direction: **each build has to be given the values that mean the same
  // picture in its own vocabulary**, not the same numbers. `blackwall.json` names 0.55 for
  // precisely this reason.
  const RASTER_LOOK = "k.params.set('scanlines', 0.35);";
  const RASTER_NEW_LOOK = `${RASTER_LOOK} k.params.set('vignette', 0.55);`;
  {
    const rasterOld = await hashesFor(
      { source: againstSource, viewportSize: COMPARISON_VIEW, comparisonShell: true },
      'k.uniforms.mode.value = $MODE;',
      { readBlackwall: 4 },
      RASTER_LOOK,
    );
    const rasterNew = await hashesFor(
      { viewportSize: COMPARISON_VIEW, comparisonShell: true },
      'k.readings().forEach((n) => k.params.set(n, 0)); k.params.set($READING, 1);',
      { readBlackwall: 4 },
      RASTER_NEW_LOOK,
    );
    const a = rasterOld.out.readBlackwall;
    const b = rasterNew.out.readBlackwall;
    const first = a.findIndex((h, i) => h !== b[i]);
    check(eq(a, b),
      `and the raster at the shipped look's 0.35 is bit-identical to the one line it replaced, at ${AGAINST_REV}`,
      first < 0
        ? `${a.length} frames, angle 0 pitch 1.3 hardness 0`
        : `${a.filter((h, i) => h !== b[i]).length} of ${a.length} frames differ, first at `
          + `${first}: ${a[first].slice(0, 12)} vs ${b[first].slice(0, 12)}`);
    // The control, and this row is the reason the one above is not vacuous. Two arms that
    // both drew no raster at all would compare bit-identical just as happily, so the
    // sweep has to be shown to have something in it: raising the master has to move the
    // picture on the build under test.
    const flat = rasterNew.out.readBlackwall;
    const lit = (await hashesFor(
      { viewportSize: COMPARISON_VIEW, comparisonShell: true },
      'k.readings().forEach((n) => k.params.set(n, 0)); k.params.set($READING, 1);',
      { readBlackwall: 4 },
      "k.params.set('scanlines', 0.0); k.params.set('vignette', 0.55);",
    )).out.readBlackwall;
    check(!eq(flat, lit),
      'and the raster is actually drawing at that value, so the equality above is about something',
      `${flat.filter((h, i) => h !== lit[i]).length} of ${flat.length} frames differ with the master off`);
  }

  // The falsification control, and it is the reason the five rows above mean anything.
  // Five hashes agreeing across two revisions would agree just as well if the pinned
  // run rendered nothing at all, or rendered the same thing whatever was selected - a
  // black frame is bit-identical to a black frame. So the readings have to differ from
  // *each other*: five distinct images on each side, which is what makes "identical
  // across the revisions" a statement about the readings rather than about the harness.
  for (const [armName, arm] of [['old', oldArm], ['new', newArm]]) {
    const distinct = new Set(Object.values(arm.out).map((hs) => hs.join('|'))).size;
    check(distinct === Object.keys(READING_WAS).length,
      `and the ${armName} arm's five readings are five different images`,
      `${distinct} distinct of ${Object.keys(READING_WAS).length}`);
  }

  if (oldArm.errors.length || newArm.errors.length) {
    console.log(`  page errors: ${[...oldArm.errors, ...newArm.errors].join(' | ')}`);
    failures++;
  }
}

// ============================================================ the working page

const main = await openPage({ pin: true });
const { page } = main;
RENDER_BUFFER = await page.evaluate(`(() => {
  const gl = globalThis.__kinect.renderer.getContext();
  return { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
})()`);

const declared = await page.evaluate(`(() => {
  const k = globalThis.__kinect;
  return Object.fromEntries(k.params.names().map((n) => [n, k.params.spec(n)]));
})()`);

// `LANDING` gets a coverage row of its own below; `SCRAMBLE` had none, and a
// parameter the registry declares but this table has never heard of arrives as
// `Error: left is a scalar: it takes a finite number, got undefined` from three
// frames inside `params.set`. That names the parameter and nothing about the reason,
// and it is a crash rather than a finding - so the tool exits 2 having tested
// nothing while looking like it failed. Refused here instead, in a sentence.
//
// Exit 2 rather than a failed assertion because a scrambled set missing a parameter
// cannot sweep the registry it claims to sweep: the run did not happen.
{
  const missing = Object.keys(declared).filter((n) => !(n in SCRAMBLE));
  if (missing.length) {
    console.log(`[registry] DID NOT RUN - the registry declares ${missing.join(', ')} and SCRAMBLE has no `
      + 'value for them, so the scrambled set is not the whole registry. Add one on its own step grid, '
      + 'in the order PARAMS declares it - the serialised comparison below is a JSON.stringify equality '
      + 'and is sensitive to key order.');
    process.exit(2);
  }
}

// =========================================================== 2. the declaration

console.log('\n[registry] the declaration');
{
  const names = Object.keys(declared);
  check(eq(names.sort(), Object.keys(LANDING).sort()),
    `every declared parameter has a landing site here (${names.length})`,
    show(names.filter((n) => !(n in LANDING))));

  const kinds = { scalar: [], step: [], pose: [] };
  const tags = { look: [], composition: [], view: [] };
  let bad = [];
  for (const [name, spec] of Object.entries(declared)) {
    if (!kinds[spec.kind]) bad.push(`${name} kind=${spec.kind}`);
    else kinds[spec.kind].push(name);
    if (!tags[spec.tag]) bad.push(`${name} tag=${spec.tag}`);
    else tags[spec.tag].push(name);
    // Every checkbox holds until the next key, because lerping a boolean is
    // meaningless - so a boolean declared scalar is a keyframe bug waiting for
    // step 5 rather than a cosmetic slip.
    if (typeof spec.default === 'boolean' && spec.kind !== 'step') bad.push(`${name} is boolean but kind=${spec.kind}`);
    // Keyed off the type of the default rather than off the kind: `normalise`
    // sends every non-boolean, non-pose value down the scalar branch, so a
    // future numeric step-kind parameter declared without a range would clamp
    // against undefined and store NaN.
    if (typeof spec.default === 'number' && !(spec.min < spec.max && spec.step > 0)) {
      bad.push(`${name} is numeric but has no usable range`);
    }
  }
  check(bad.length === 0, 'every parameter carries a usable kind, tag and range', bad.join('; '));
  check(kinds.scalar.length > 0 && kinds.step.length > 0 && kinds.pose.length > 0,
    'all three interpolation kinds are in use',
    `scalar ${kinds.scalar.length}, step ${kinds.step.length} (${kinds.step.join(',')}), pose ${kinds.pose.join(',')}`);
  console.log(`        look ${tags.look.length}: ${tags.look.join(' ')}`);
  console.log(`        composition ${tags.composition.length}: ${tags.composition.join(' ')}`);
  console.log(`        view ${tags.view.length}: ${tags.view.join(' ')}`);

  // This row used to assert the opposite: `!('mode' in declared)`, on the reasoning
  // that a mode key would rewrite twelve other tracks at the instant it fired. That
  // reasoning was about the twelve values `setMode` bundled in, not about the reading,
  // and unbundling it removed both the bundle and the objection. The row is inverted
  // rather than deleted because the property is still worth pinning down - it is just
  // the other property now, and a build that reintroduced an integer mode beside the
  // weights would fail here.
  check(!('mode' in declared), 'there is no mode parameter left to keyframe against');
  const readings = await page.evaluate('globalThis.__kinect.readings()');
  const missing = readings.filter((n) => !(n in declared));
  check(readings.length > 0 && missing.length === 0,
    'every reading is a registry parameter',
    missing.length ? `not declared: ${missing.join(', ')}` : readings.join(' '));
  // Scalar and look, both load-bearing and for different reasons. `step` would hold
  // until the next key, which is a reading that snaps rather than dissolves - the one
  // capability this change exists to add. And `view` would keep them out of a preset
  // and out of the undo snapshot, which is where the mode effectively sat.
  const wrongSpec = readings.filter((n) => declared[n].kind !== 'scalar' || declared[n].tag !== 'look');
  check(wrongSpec.length === 0,
    'and each one is a look-tagged scalar, so it presets and it dissolves',
    wrongSpec.length ? wrongSpec.map((n) => `${n} kind=${declared[n].kind} tag=${declared[n].tag}`).join('; ')
      : `${readings.length} readings`);
}

// ================================== 2b. the write path refuses what it cannot hold

// `params.apply(JSON.parse(projectFile))` is the path this registry advertises, so
// the values that arrive there are the ones worth being hostile about. A coercion
// that turns a truncated or hand-edited project into a plausible-looking look is
// worse than a throw, because nothing downstream can tell it happened.
console.log('\n[registry] bad values are refused rather than coerced');
{
  // Each case is JS source evaluated in the page rather than a value serialised
  // into it. That is not fussiness: JSON.stringify turns NaN and undefined into
  // null, so a table of literals would quietly test null three times over while its
  // labels claimed otherwise - an instrument lying about what it just proved.
  const REJECT = [
    ['camera', '{ position: [1, 2], quaternion: [0, 0, 0, 1], fov: 50 }', 'a short position'],
    ['camera', '{ position: [1, 2, 3], quaternion: [0, 0, 0], fov: 50 }', 'a short quaternion'],
    ['camera', '{ position: [1, 2, 3], quaternion: [0, 0, 0, 1] }', 'no fov at all'],
    ['camera', "{ position: ['1', '2', '3'], quaternion: [0, 0, 0, 1], fov: 50 }", 'strings for a position'],
    ['camera', '{ position: [1, 2, NaN], quaternion: [0, 0, 0, 1], fov: 50 }', 'a NaN component'],
    ['camera', '{ position: [1, 2, 3], quaternion: [0, 0, 0, 1], fov: NaN }', 'a NaN fov'],
    ['camera', 'null', 'null for a pose'],
    ['bloom', 'null', 'null for a scalar'],
    ['bloom', "''", 'an empty string for a scalar'],
    ['bloom', "'1.5'", 'a numeric string for a scalar'],
    ['bloom', 'NaN', 'NaN for a scalar'],
    ['bloom', 'undefined', 'a missing value for a scalar'],
    ['additive', 'null', 'null for a step'],
    ['additive', "'false'", 'the string "false" for a step'],
    ['additive', '1', 'a number for a step'],
    ['additive', 'undefined', 'a missing value for a step'],
  ];
  const ACCEPT = [
    ['camera', JSON.stringify(SCRAMBLE.camera)],
    ['bloom', '1.5'],
    ['additive', 'true'],
  ];
  const asCases = (rows) => rows
    .map(([name, expr]) => `{ name: ${JSON.stringify(name)}, value: ${expr} }`)
    .join(', ');

  const outcome = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const out = { rejected: [], leaked: [], accepted: [], camera: null };
    for (const { name, value } of [${asCases(REJECT)}]) {
      const before = JSON.stringify(k.params.get(name));
      let threw = false;
      try { k.params.set(name, value); } catch { threw = true; }
      out.rejected.push(threw);
      // A refusal that had already written half of itself would be worse than the
      // coercion it replaced, so the stored value has to be untouched.
      if (JSON.stringify(k.params.get(name)) !== before) out.leaked.push(name);
    }
    for (const { name, value } of [${asCases(ACCEPT)}]) {
      let ok = false;
      try { k.params.set(name, value); ok = true; } catch (e) { ok = String(e); }
      out.accepted.push(ok);
    }
    out.camera = [...k.programCamera.position.toArray(), k.programCamera.fov, k.programCamera.projectionMatrix.elements[0]];
    k.params.reset();
    return out;
  })()`);

  const missed = REJECT.filter((_, i) => !outcome.rejected[i]).map(([n, , why]) => `${n}: ${why}`);
  check(missed.length === 0, `all ${REJECT.length} malformed values throw`, missed.join('; '));
  check(outcome.leaked.length === 0, 'and a refusal writes nothing at all', outcome.leaked.join(' '));
  check(outcome.accepted.every((x) => x === true), 'while well-formed values still go through',
    outcome.accepted.filter((x) => x !== true).join('; '));
  // NaN reaching the pose is the specific failure this guards: it never throws, it
  // just poisons the projection matrix, and live viewing hides it because the next
  // frame rewrites the pose from program time.
  check(outcome.camera.every(Number.isFinite), 'and nothing left NaN on the camera', show(outcome.camera));
}

console.log('\n[registry] a serialised project is document state, never view state');
{
  const sets = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    return {
      byDefault: Object.keys(k.params.values()),
      everything: Object.keys(k.params.values(k.params.names())),
      look: k.params.names('look'),
      view: k.params.names('view'),
      composition: k.params.names('composition'),
    };
  })()`);
  const leaked = sets.view.filter((n) => sets.byDefault.includes(n));
  check(leaked.length === 0,
    'values() leaves view state out, so an undo snapshot cannot swallow it', leaked.join(' '));
  check(sets.composition.every((n) => sets.byDefault.includes(n))
    && sets.look.every((n) => sets.byDefault.includes(n)),
    `and carries all ${sets.look.length} look and ${sets.composition.length} composition parameters`);
  check(sets.everything.length === sets.byDefault.length + sets.view.length,
    'while view state is still reachable by naming it', `${sets.everything.length} named explicitly`);
}

// ================================================== 3. the HTML holds no data

console.log('\n[registry] the panel carries no parameter data of its own');
{
  // The strong form of this row, and it had to become the strong form: the panel's rows
  // are generated from the registry now, so no registry-owned input appears in the
  // markup at all - and the old row, which kept the inputs whose id is a parameter and
  // asserted none of them carried a range, passed on an empty set having examined
  // nothing. A row that cannot fail is worse than no row, because it reads as coverage.
  //
  // So the claim is the one generation actually makes, with the count printed beside it
  // and a floor under the scan for the same reason `syntax-check` refuses to pass on
  // finding no files: a regex that stopped matching `<input` would otherwise report a
  // clean panel about nothing. What the markup still legitimately carries is the sensor
  // and monitor controls, the retime slider, the export name and the preset file picker -
  // eight, none of them registry-owned - and the floor sits well under that deliberately,
  // because this row is about the scan working rather than about the number. A gate set at
  // exactly today's count would fail the next honest markup edit, which is the zero-margin
  // threshold this repo has already been bitten by once.
  //
  // The second clause is the sharper half. `id="..."` is matched with double quotes, so an
  // input written with single quotes would parse as having no id, drop out of the owned
  // comparison, and be reported as a clean panel - the regex failing in precisely the
  // direction that looks like a pass. Every input tag has to yield an id or the scan is
  // not reading what it claims to read.
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  const owned = new Set(Object.keys(declared));
  const tags = html.match(/<input[^>]*>/g) ?? [];
  const ids = tags.map((tag) => tag.match(/id="([^"]+)"/)?.[1]).filter(Boolean);
  const MARKUP_INPUT_FLOOR = 4;
  check(tags.length >= MARKUP_INPUT_FLOOR && ids.length === tags.length,
    `the markup scan found the inputs it is supposed to read (${tags.length} of at least ${MARKUP_INPUT_FLOOR}, all with ids)`,
    `${ids.join(' ')}`);
  const inMarkup = ids.filter((id) => owned.has(id));
  check(inMarkup.length === 0,
    `no registry-owned input is written in the markup at all - every one of the ${owned.size} `
    + 'is generated from the registry, so there is no second copy of a range to drift',
    inMarkup.join(' '));

  const stamped = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const out = {};
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el) { out[name] = null; continue; }
      out[name] = el.type === 'checkbox'
        ? { checked: el.checked }
        : { min: el.min, max: el.max, step: el.step, value: el.value,
            out: el.parentElement.querySelector('output')?.textContent };
    }
    return out;
  })()`);
  const wrong = [];
  for (const [name, spec] of Object.entries(declared)) {
    const el = stamped[name];
    if (spec.tag === 'composition') {
      if (el !== null) wrong.push(`${name} is composition but has a control`);
      continue;
    }
    if (el === null) { wrong.push(`${name} has no control`); continue; }
    if ('checked' in el) {
      if (el.checked !== spec.default) wrong.push(`${name} checked=${el.checked} want ${spec.default}`);
      continue;
    }
    if (el.min !== String(spec.min) || el.max !== String(spec.max) || el.step !== String(spec.step)) {
      wrong.push(`${name} range ${el.min}..${el.max}/${el.step} want ${spec.min}..${spec.max}/${spec.step}`);
    }
    if (el.value !== String(spec.default)) wrong.push(`${name} value=${el.value} want ${spec.default}`);
    if (el.out !== String(spec.default)) wrong.push(`${name} readout=${el.out} want ${spec.default}`);
  }
  check(wrong.length === 0, 'every control has its range, default and readout stamped from the registry', wrong.join('; '));
}

// ========================================================== 4. every value lands

console.log('\n[registry] every parameter round-trips to where the renderer reads it');
{
  const probe = async (values) => page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    k.params.apply(${JSON.stringify(values)});
    return { values: k.params.values(k.params.names()), landing: ${landingReader} };
  })()`);

  const wrong = [];
  for (const [name, value] of Object.entries(SCRAMBLE)) {
    const { values, landing } = await probe({ [name]: value });
    if (!eq(values[name], value)) {
      wrong.push(`${name} stored ${show(values[name])} not ${show(value)}`);
      continue;
    }
    const want = EXPECT[name](values[name], values);
    if (!eq(landing[name], want)) wrong.push(`${name} landed ${show(landing[name])} want ${show(want)}`);
  }
  check(wrong.length === 0, `all ${Object.keys(SCRAMBLE).length} parameters land one at a time`, wrong.join('; '));

  // The whole set at once, so a parameter that only lands when nothing else moved
  // does not slip through.
  const { values, landing } = await probe(SCRAMBLE);
  const together = Object.keys(SCRAMBLE)
    .filter((n) => !eq(landing[n], EXPECT[n](values[n], values)))
    .map((n) => `${n}=${show(landing[n])}`);
  check(together.length === 0, 'and all of them at once', together.join('; '));
}

console.log('\n[registry] the side effects that are not a uniform write');
{
  const setAndRead = async (values) => page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    k.params.apply(${JSON.stringify(values)});
    return {
      drawRange: k.geometry.drawRange.count,
      bloom: k.bloom.enabled, trails: k.afterimage.enabled, grade: k.grade.enabled,
      blending: k.material.blending, depthWrite: k.material.depthWrite, softEdge: k.uniforms.softEdge.value,
      buffer: [k.renderer.getContext().drawingBufferWidth, k.renderer.getContext().drawingBufferHeight],
    };
  })()`);

  // The ghost half of the geometry is drawn when either persistence term can shed
  // and left out of the draw range when neither can, so the matrix is the test.
  const range = [];
  for (const [fade, wake, want] of [[0, 0, POINTS], [10, 0, POINTS * 2], [0, 10, POINTS * 2], [120, 550, POINTS * 2]]) {
    const r = await setAndRead({ fade, wake });
    if (r.drawRange !== want) range.push(`fade=${fade} wake=${wake} -> ${r.drawRange} want ${want}`);
  }
  check(range.length === 0, 'fade and wake move the draw range together', range.join('; '));

  const gates = [];
  for (const [values, want] of [
    [{ bloom: 0, trails: 0, rgbSplit: 0, scanlines: 0, grain: 0, vignette: 0 }, { bloom: false, trails: false, grade: false }],
    [{ bloom: 0.05 }, { bloom: true, trails: false, grade: false }],
    [{ trails: 0.01 }, { bloom: false, trails: true, grade: false }],
    [{ rgbSplit: 0.05 }, { bloom: false, trails: false, grade: true }],
    [{ scanlines: 0.01 }, { bloom: false, trails: false, grade: true }],
    [{ grain: 0.01 }, { bloom: false, trails: false, grade: true }],
    // The fourth term sharing that pass, and the one that used to ride on the other
    // three: raised on its own it has to bring the pass up by itself, or the vignette
    // is back to being a thing you can only have by asking for something else.
    [{ vignette: 0.01 }, { bloom: false, trails: false, grade: true }],
    // The streak, which gates for the plain reason rather than by exception: its default
    // is zero, so a look that never asks for it pays nothing. This row is the one that
    // separates it from `crush` below - both share the pass, and only the one whose off
    // state is actually off is allowed to switch it on.
    [{ streak: 0.02 }, { bloom: false, trails: false, grade: true }],
    // The fifth term in that pass, and the only one whose expectation is `false`. `crush`
    // shares the grade and deliberately does not gate it, so this row is the negative
    // asserted rather than left as an omission - an omission would pass on a build that
    // gated it, and gating it is the tempting edit, because every neighbour above does.
    //
    // What it would cost is why the row is worth its line. The toe defaults to 0.018 and
    // not to 0, so `crush > 0` is true of every document there has ever been: the pass
    // would run for the four shipped presets that ask for no grade at all, each paying a
    // full-screen read and write to be put through a Reinhard curve nobody graded them
    // through, and section 1b would redden on all five readings at once against a build
    // from before the registry existed.
    [{ crush: 0.5 }, { bloom: false, trails: false, grade: false }],
    // The raster's three settings, on `crush`'s terms and each for its own reason. The
    // pitch is the one that would fail loudest if it gated, since it defaults to 1.3 and
    // so is non-zero in every document there has ever been; the angle and the hardness
    // would merely switch a full-screen pass on to rotate and square a raster whose master
    // is off, which is the no-op this row exists to refuse. All three are settings of
    // `scanlines`, and the pass is the master's to gate.
    [{ scanAngle: 90 }, { bloom: false, trails: false, grade: false }],
    [{ scanPitch: 0.3 }, { bloom: false, trails: false, grade: false }],
    [{ scanHard: 1 }, { bloom: false, trails: false, grade: false }],
    // The streak's direction, on the raster angle's terms: a setting of the term above it
    // rather than a term beside it, so pointing a streak nobody raised has to leave the
    // pass shut. Gating it would switch a full-screen read and write on to aim an effect
    // whose amount is zero, which is precisely the no-op the gate exists to refuse.
    [{ streakAngle: 90 }, { bloom: false, trails: false, grade: false }],
  ]) {
    const r = await setAndRead(values);
    const got = { bloom: r.bloom, trails: r.trails, grade: r.grade };
    if (!eq(got, want)) gates.push(`${show(values)} -> ${show(got)} want ${show(want)}`);
  }
  check(gates.length === 0, 'a zero value switches its pass off rather than running it as a no-op', gates.join('; '));

  const blend = [];
  for (const on of [true, false]) {
    const r = await setAndRead({ additive: on });
    const want = { blending: on ? ADDITIVE_BLENDING : NORMAL_BLENDING, depthWrite: !on, softEdge: on ? 1 : 0 };
    const got = { blending: r.blending, depthWrite: r.depthWrite, softEdge: r.softEdge };
    if (!eq(got, want)) blend.push(`additive=${on} -> ${show(got)} want ${show(want)}`);
  }
  check(blend.length === 0, 'additive drives blending, depth write and the sprite falloff together', blend.join('; '));

  const scales = [];
  for (const v of [40, 100, 200]) {
    const r = await setAndRead({ renderScale: v });
    const want = [
      Math.floor(RENDER_BUFFER.width * v / 100),
      Math.floor(RENDER_BUFFER.height * v / 100),
    ];
    if (!eq(r.buffer, want)) scales.push(`renderScale=${v} -> ${show(r.buffer)} want ${show(want)}`);
  }
  check(scales.length === 0, 'render scale resizes the drawing buffer', scales.join('; '));

  await page.evaluate('globalThis.__kinect.params.reset()');
}

// ============================================================ 5. the UI is a view

console.log('\n[registry] the panel is a view, in both directions');
{
  // Direction one: the control moves, the registry follows. The event is the one a
  // drag produces - `input` on a range, `change` on a checkbox - so this exercises
  // the listener the user reaches, not a function the check picked.
  const fromControl = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const wrong = [];
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el) continue;
      const spec = k.params.spec(name);
      if (el.type === 'checkbox') {
        el.checked = !spec.default;
        el.dispatchEvent(new Event('change'));
        if (k.params.get(name) !== !spec.default) wrong.push(name + ' -> ' + k.params.get(name));
        continue;
      }
      const target = ${JSON.stringify(SCRAMBLE)}[name];
      el.value = String(target);
      el.dispatchEvent(new Event('input'));
      if (k.params.get(name) !== target) wrong.push(name + ' -> ' + k.params.get(name));
    }
    return wrong;
  })()`);
  check(fromControl.length === 0, 'moving a control writes the registry', fromControl.join('; '));

  // Direction two: the registry moves, the control and its readout follow. This is
  // the direction a keyframe, a preset and a restored project all arrive from, and
  // a panel that did not follow would show the previous look while rendering the
  // new one.
  const fromRegistry = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const wrong = [];
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el) continue;
      const value = ${JSON.stringify(SCRAMBLE)}[name];
      k.params.set(name, value);
      if (el.type === 'checkbox') {
        if (el.checked !== value) wrong.push(name + ' checkbox=' + el.checked);
        continue;
      }
      if (el.value !== String(value)) wrong.push(name + ' slider=' + el.value + ' want ' + value);
      const out = el.parentElement.querySelector('output');
      if (out && out.textContent !== String(value)) wrong.push(name + ' readout=' + out.textContent);
    }
    return wrong;
  })()`);
  check(fromRegistry.length === 0, 'writing the registry moves the control and its readout', fromRegistry.join('; '));

  // Out of range and off the step grid, from both sides. The registry has to do the
  // clamping and snapping itself rather than lean on the DOM for it, or a value set
  // headlessly by step 6 lands on the uniform unsnapped while the same value set
  // through a slider lands snapped, and the panel and the image disagree.
  const clamped = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const wrong = [];
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el || el.type === 'checkbox') continue;
      const spec = k.params.spec(name);
      // Below, above, a value that rounds down, and a tie that has to round up -
      // the tie is the one where the registry's arithmetic and the browser's
      // step alignment could part company without either looking wrong.
      for (const raw of [spec.min - 1000, spec.max + 1000, spec.min + spec.step * 0.4, spec.min + spec.step * 6.5]) {
        const stored = k.params.set(name, raw);
        if (stored < spec.min || stored > spec.max) wrong.push(name + ' ' + raw + ' -> ' + stored);
        else if (el.value !== String(stored)) wrong.push(name + ' ' + raw + ' -> registry ' + stored + ', slider ' + el.value);
      }
    }
    return wrong;
  })()`);
  check(clamped.length === 0, 'out-of-range and off-grid values clamp and snap the same way the slider does', clamped.join('; '));

  await page.evaluate('globalThis.__kinect.params.reset()');
}

// ================================================ 6. presets are user actions only

console.log('\n[registry] a preset can only be applied by a user action');
{
  // A look to apply, written here rather than taken from the page. It used to be
  // `k.presets.BLACKWALL`, a hardcoded constant the module exported for this and for
  // `setMode` to bundle in - and the bundling is what the readings replaced, so the
  // constant went with it. A preset is a document now, and what this section is about
  // is the guard rather than any particular look, so two values are enough.
  const A_LOOK = { bloom: 0.5, trails: 0.5 };

  const guard = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();

    // Outside evaluation it has to work, or the check below would pass on a
    // preset path that was simply broken.
    let outside = 'applied';
    try { k.applyPreset(${JSON.stringify(A_LOOK)}); } catch (e) { outside = String(e); }
    const applied = k.params.get('bloom');
    k.params.reset();

    // Inside one, it has to refuse. The probe rides three's own pre-render hook,
    // which fires from inside renderProgramFrame, so this is the timeline calling
    // rather than the check pretending to be it.
    const seen = {};
    k.scene.onBeforeRender = () => {
      k.scene.onBeforeRender = () => {};
      try { k.applyPreset(${JSON.stringify(A_LOOK)}); seen.preset = 'applied'; }
      catch (e) { seen.preset = 'refused'; }
      // An ordinary parameter write must stay legal: that is exactly what step 5's
      // tracks do every frame, and what the camera already does.
      try { k.params.set('bloom', 0.25); seen.param = 'written'; }
      catch (e) { seen.param = String(e); }
      // And a reading is one of those writes now. This row used to be its opposite -
      // "selecting a mode during evaluation is refused" - and the inversion is the
      // capability rather than a relaxed guard: a mode was refused *because* selecting
      // one applied a twelve-value preset behind it, so it could never be a track. A
      // reading writes one number, which is what a track does every frame, so refusing
      // it here would be refusing the dissolve this change exists to allow.
      try { k.params.set('readBlackwall', 1); seen.reading = 'written'; }
      catch (e) { seen.reading = String(e); }
    };
    k.drive.stepTo(0);
    k.scene.onBeforeRender = () => {};

    return { outside, applied, seen, bloomAfter: k.params.get('bloom'), readingAfter: k.params.get('readBlackwall') };
  })()`);

  check(guard.outside === 'applied' && guard.applied === 0.5,
    'applying a preset outside evaluation writes it', `bloom=${guard.applied}`);
  check(guard.seen.preset === 'refused', 'applying a preset during evaluation is refused', show(guard.seen.preset));
  check(guard.seen.param === 'written' && guard.bloomAfter === 0.25,
    'an ordinary parameter write during evaluation still works', `bloom=${guard.bloomAfter}`);
  check(guard.seen.reading === 'written' && guard.readingAfter === 1,
    'and a reading is an ordinary write, so a track can dissolve one under the playhead',
    `readBlackwall=${guard.readingAfter}`);

  // What a preset carries is the look tag and nothing else, so the tag has to be
  // the thing that selects it rather than a label beside a hand-written list.
  const selection = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const chosen = k.params.names('look');
    k.params.set('camera', ${JSON.stringify(SCRAMBLE.camera)});
    k.params.set('renderScale', 60);
    const captured = k.params.values(chosen);

    // Move everything, then apply the captured look back. A preset that moved the
    // camera would not be a preset, it would be a saved project.
    k.params.apply(${JSON.stringify(SCRAMBLE)});
    k.applyPreset(captured);
    return {
      chosen,
      captured: Object.keys(captured),
      camera: k.params.get('camera'),
      renderScale: k.params.get('renderScale'),
      bloom: k.params.get('bloom'),
      near: k.params.get('near'),
    };
  })()`);

  check(!selection.captured.includes('camera') && !selection.captured.includes('spin')
    && !selection.captured.includes('renderScale'),
    'the default preset selection is the look tag, so composition and view stay out',
    `${selection.captured.length} parameters`);
  check(selection.captured.includes('near') && selection.captured.includes('far'),
    'and the depth clip is in it, as a look control whose default selection can be unpicked');
  check(eq(selection.camera, SCRAMBLE.camera),
    'applying a look leaves the camera exactly where it was', show(selection.camera.position));
  check(selection.renderScale === 85, 'and leaves view state to the viewer', `renderScale=${selection.renderScale}`);
  check(selection.bloom === 0 && selection.near === 0.05,
    'while the look values it does carry are written', `bloom=${selection.bloom} near=${selection.near}`);

  await page.evaluate('globalThis.__kinect.params.reset()');
}

// ============================================ 7. the render path writes the camera

console.log('\n[registry] the camera pose goes in through the registry, not around it');
{
  // Two keys a metre apart, so "moves with program time" is a claim about a track
  // rather than about a placeholder that happened to animate. The wild pose is
  // written first and has to lose: with keys on the track the evaluator overwrites
  // it, which is the property that makes a keyed parameter keyed at all.
  const camera = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const wild = ${JSON.stringify(SCRAMBLE.camera)};
    k.params.set('camera', wild);
    const written = [k.params.get('camera'), k.programCamera.position.toArray()];

    const q = [0, 0, 0, 1];
    k.keyframes.setTracks({ camera: [
      { t: 0, value: { position: [-1, 0.2, 1], quaternion: q, fov: 50 } },
      { t: 2, value: { position: [1, 0.2, 1], quaternion: q, fov: 50 } },
    ] });

    k.drive.reset();
    k.drive.stepTo(0.4);
    const stored = k.params.get('camera');
    const onCamera = {
      position: k.programCamera.position.toArray(),
      quaternion: k.programCamera.quaternion.toArray(),
      fov: k.programCamera.fov,
    };
    k.drive.stepTo(0.9);
    const later = k.params.get('camera');
    k.keyframes.setTracks({});
    return { written, stored, onCamera, later };
  })()`);

  check(eq(camera.written[0], SCRAMBLE.camera) && eq(camera.written[1], SCRAMBLE.camera.position),
    'a pose written through the registry reaches the camera object');
  // The load-bearing one. If the render path posed the camera directly, the
  // registry would still be holding the wild pose while the camera had moved -
  // so agreement here is what says the write goes through the registry.
  check(eq(camera.stored, camera.onCamera),
    'after a render the registry holds the pose the camera is actually at',
    `${show(camera.stored.position)} vs ${show(camera.onCamera.position)}`);
  check(!eq(camera.stored.position, SCRAMBLE.camera.position),
    'and it is the pose the track asked for, not the one the check wrote');
  check(!eq(camera.stored.position, camera.later.position),
    'and it moves with program time', `${show(camera.stored.position)} -> ${show(camera.later.position)}`);
}

// ============================== 8. serialise, restore, and the same pixels back

console.log('\n[registry] serialise, restore, and the image comes back byte for byte');

// The reading the sweep runs in is now part of the scrambled set rather than a click
// that precedes it, and that is a repair rather than a translation. This used to click
// the Blackwall button, because `scan` and `rim` reach the shader only inside that
// branch and a sweep run in RGB would have found them inert - a real hole, correctly
// closed for the parameters that existed then. The same hole reopened wider the moment
// the readings became parameters: `params.reset()` boots `readRgb` at 1, so a sweep
// that did not say otherwise would run entirely in RGB and record `scan`, `rim` and
// every future per-reading term as unable to touch a pixel.
//
// So `SCRAMBLE` carries all five readings non-zero, and every reading's block is live
// in every image the sweep hashes. That is the "what do all my arms agree about"
// question asked of this file's own sweep, which had exactly one arm and one answer.
await page.evaluate(async () => {
  const buffer = await (await fetch('/__pinned.bin')).arrayBuffer();
  globalThis.__kinect.drive.pin(buffer);
});

// And a colour image, because one parameter is only observable through one.
//
// `pin` above switches colour off - a JPEG decode is asynchronous and a pinned run that
// raced it would hash a frame whose colour had or had not arrived - so every point in
// every arm below draws the flat `vec3(0.7)` the shader falls back to. Saturation of a
// uniform grey is the identity at every value, so `rgbSaturation` would have come out of
// the drop-one sweep as a parameter that cannot reach a pixel: a probe standing in a
// dead zone, reporting a clean pass on a build that had the term backwards.
//
// Four saturated pixels rather than a photograph, and the bytes live here rather than in
// the page so this arm owns its own input. Both samplers are pointed at the one texture,
// so nothing depends on which side of the pair `mixT` favours at a given position.
await page.evaluate(`globalThis.__kinect.drive.plantColor(${JSON.stringify([
  220, 30, 40, 255, 30, 200, 90, 255,
  40, 70, 230, 255, 230, 200, 40, 255,
])}, 2, 2)`);
// Asserted rather than assumed, because the arm it exists for is a *negative* result
// otherwise: a plant that silently failed leaves the grey behind, `rgbSaturation` lands
// in the no-effect bucket, and the sweep reports a parameter that cannot reach a pixel
// as though it had measured one.
{
  const planted = await page.evaluate('globalThis.__kinect.uniforms.hasColor.value');
  check(planted === 1,
    'the sweep runs against a colour image, so a colour term is not measured on grey',
    `hasColor ${planted}`);
}

const positions = await page.evaluate(`(() => {
  const times = globalThis.__kinect.drive.times();
  const out = [];
  for (let i = 0; i < times.length - 1; i++) {
    for (let r = 0; r < ${SUBSTEPS}; r++) out.push(times[i] + (times[i + 1] - times[i]) * (r / ${SUBSTEPS}));
  }
  return out;
})()`);

const runWith = `async ({ values, positions }) => {
  ${PAGE_HELPERS}
  k.params.reset();
  k.params.apply(values);
  k.drive.reset();
  pinCamera(k.freeCamera);
  const out = [];
  for (const t of positions) {
    k.drive.stepTo(t);
    out.push(await sha256(k.drive.readPixels()));
  }
  return out;
}`;
const run = (values) => page.evaluate(`(${runWith})(${JSON.stringify({ values, positions })})`);

const serialised = await page.evaluate(`(() => {
  const k = globalThis.__kinect;
  k.params.reset();
  k.params.apply(${JSON.stringify(SCRAMBLE)});
  return JSON.parse(JSON.stringify(k.params.values(k.params.names())));
})()`);

const defaults = await page.evaluate(
  "(() => { const k = globalThis.__kinect; k.params.reset(); return JSON.parse(JSON.stringify(k.params.values(k.params.names()))); })()");

const scrambledRun = await run(SCRAMBLE);
const defaultRun = await run(defaults);
const restoredRun = await run(serialised);

console.log(`  ${positions.length} images per run over `
  + `${positions[0].toFixed(3)}s to ${positions[positions.length - 1].toFixed(3)}s, `
  + `${new Set(scrambledRun).size} of them distinct`);

check(eq(scrambledRun, restoredRun),
  'the restored set reproduces the run exactly',
  eq(scrambledRun, restoredRun) ? '' : `first divergence at image ${scrambledRun.findIndex((h, i) => h !== restoredRun[i])}`);
// Strictly equal, not merely the same size: every value here is already on its
// own step grid, so anything the registry did to one of them on the way in and
// back out is a normalisation bug rather than a rounding it was asked for.
check(eq(serialised, JSON.parse(JSON.stringify(SCRAMBLE))),
  `the serialised set is the scrambled set, value for value (${Object.keys(serialised).length} parameters)`,
  Object.keys(SCRAMBLE).filter((n) => !eq(serialised[n], SCRAMBLE[n]))
    .map((n) => `${n}: ${show(serialised[n])} not ${show(SCRAMBLE[n])}`).join('; '));
// The blunt control: if the registry were not driving the renderer at all, the
// defaults would render the same images as the scrambled set and the equality
// above would be arithmetic rather than evidence.
check(!eq(scrambledRun, defaultRun), 'and the defaults do not - the registry is what the image depends on');
check(new Set(scrambledRun).size > positions.length / 2, 'the input moves across the run');

// =================================== 8b. the mix is a mix, and it normalises

// **The one property this file could not otherwise fail on, and it needed an oracle
// nothing else here provides.** Section 1b compares each reading against the revision
// before the weights existed, which is the strongest evidence available for a *single*
// reading - and it is silent about mixing by construction, because a single reading at
// 1.0 divides by 1.0 and any normalisation whatsoever is the identity there. Section 8
// above compares a build against itself, so a build that mixed wrongly but consistently
// reproduces its own run exactly and passes. The old build cannot mix at all, so there
// is no earlier revision to hash against either.
//
// What is left is an identity the correct implementation satisfies and a wrong one does
// not: the weights are a ratio, so scaling all of them by any constant must render the
// *same image*. sum(k*w*c) / sum(k*w) cancels the k. A build dividing by a constant
// instead of by the sum, or by the number of live readings, changes brightness the
// moment the scale changes - while staying bit-identical on every single-reading arm,
// which is exactly the shape section 1b cannot see.
console.log('\n[registry] the readings mix as a ratio, so their scale cancels');
{
  // Deliberately not equal to each other and deliberately not summing to 1, so neither
  // a build that ignored the denominator nor one that assumed the weights were already
  // normalised can agree with the correct answer by luck.
  const RATIO = { readRgb: 0.4, readDepth: 0.3, readGhost: 0.2, readContour: 0, readBlackwall: 0 };
  const scaled = (k) => Object.fromEntries(Object.entries(RATIO).map(([n, v]) => [n, v * k]));

  const atOne = await run(scaled(1));
  const atTwo = await run(scaled(2));
  check(eq(atOne, atTwo),
    'doubling every weight renders the identical image, because a ratio has no scale',
    eq(atOne, atTwo) ? `${atOne.length} frames` : `first divergence at image ${atOne.findIndex((h, i) => h !== atTwo[i])}`);

  // And the control for that row, because two identical images prove nothing if the
  // weights reach no pixel: the mix has to differ from each of the readings it is made
  // of. Without this, a build that ignored the weights entirely would pass the row
  // above perfectly - it renders the same image for every input, which is the strongest
  // possible form of "the scale cancels".
  const solo = {};
  for (const name of Object.keys(RATIO)) {
    solo[name] = await run({ ...Object.fromEntries(Object.keys(RATIO).map((n) => [n, 0])), [name]: 1 });
  }
  const sameAsSolo = Object.keys(RATIO).filter((n) => eq(atOne, solo[n]));
  check(sameAsSolo.length === 0,
    'and the mix is none of the readings it is made of',
    sameAsSolo.length ? `identical to ${sameAsSolo.join(', ')} alone` : 'distinct from all five');
}

console.log('\n[registry] the falsification control: each parameter left out of the restore in turn');
{
  const noEffect = [];
  const changed = [];
  for (const name of Object.keys(serialised)) {
    const partial = { ...serialised };
    delete partial[name];
    const hashes = await run(partial);
    if (eq(hashes, scrambledRun)) noEffect.push(name);
    else changed.push(name);
  }
  console.log(`  omitting any of these changed the image: ${changed.join(' ')}`);
  const unexplained = noEffect.filter((n) => !(n in NO_PIXEL_EFFECT));
  for (const name of noEffect.filter((n) => n in NO_PIXEL_EFFECT)) {
    console.log(`  ${name} left the image unchanged, as declared: ${NO_PIXEL_EFFECT[name]}`);
  }
  check(unexplained.length === 0,
    `every parameter outside the declared exceptions changes the image when it is dropped`,
    unexplained.length ? `unexplained: ${unexplained.join(' ')}` : '');
  check(changed.length > 0 && noEffect.length === Object.keys(NO_PIXEL_EFFECT).length,
    `${changed.length} of ${Object.keys(serialised).length} parameters are proven to reach the pixels`);
}

// The switch that gates the crop, which the sweep above declares it cannot see: it is
// scrambled to its default so the six faces it gates stay observable, and dropping a
// parameter that is already at its default changes nothing. So it is proven here
// instead, and the second row is the one that carries the design decision.
//
// **`crop` covers all six faces and not the four lateral ones.** That was very nearly
// got wrong on the grounds that `nearClip`/`farClip` also normalise the depth ramp, so
// releasing them would re-grade every point still inside the box - which is true of a
// switch that opened the values and false of this one, because it gates the discard and
// leaves the uniforms where the document put them. The second row is what keeps the
// design honest under a later edit: it authors nothing but the depth pair, so the only
// thing the switch has left to release is `near` and `far`.
console.log('\n[registry] the crop switch, which the sweep above cannot see');
{
  const released = await run({ ...SCRAMBLE, crop: false });
  check(!eq(scrambledRun, released),
    'releasing the crop changes the image, against the six faces the scrambled set authors',
    eq(scrambledRun, released) ? 'identical' : `first divergence at image ${scrambledRun.findIndex((h, i) => h !== released[i])}`);

  // The scrambled set with the four lateral faces put back to their own defaults, which
  // are their bounds - so the only thing the switch has left to release is the depth
  // pair. The bounds are read off the registry rather than named here, which would be
  // this file carrying a second copy of `CROP_LIMIT`.
  //
  // **The rest of the scrambled look comes along, and that is a repair.** The arm was
  // written as `{ near, far }` alone, which leaves every reading at its default - one
  // source, `readRgb`, carrying the whole image. `--mutate rgb-contributes-no-alpha`
  // then renders black on both arms, they compare identical, and this row fired against
  // a mutation that has nothing to do with the crop. A probe lit by five readings cannot
  // be switched off by one of them.
  const depthOnly = {
    ...SCRAMBLE,
    left: defaults.left,
    right: defaults.right,
    bottom: defaults.bottom,
    top: defaults.top,
  };
  const depthBiting = await run(depthOnly);
  const depthReleased = await run({ ...depthOnly, crop: false });
  check(!eq(depthBiting, depthReleased),
    'and it reaches the depth pair, not only the four lateral faces',
    eq(depthBiting, depthReleased) ? 'identical with only near/far authored' : 'the box releases in depth too');

  // The control for both rows. Two images that differ prove the switch does something;
  // they do not prove it does the *right* thing, and the thing it must not do is move
  // the planes. A build whose release opened `nearClip`/`farClip` instead of skipping
  // the test would pass both rows above and fail this one, because the depth ramp is
  // normalised against those two uniforms and every surviving point would be recoloured.
  const landing = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.set('near', ${SCRAMBLE.near});
    k.params.set('far', ${SCRAMBLE.far});
    k.params.set('crop', false);
    const off = [k.uniforms.nearClip.value, k.uniforms.farClip.value];
    k.params.set('crop', true);
    return { off, on: [k.uniforms.nearClip.value, k.uniforms.farClip.value] };
  })()`);
  check(eq(landing.off, landing.on) && eq(landing.on, [SCRAMBLE.near, SCRAMBLE.far]),
    'and it releases by not testing rather than by moving the planes, so the depth ramp is unchanged',
    `nearClip/farClip released ${JSON.stringify(landing.off)}, applied ${JSON.stringify(landing.on)}`);
}

// The streak's direction, which the drop-one sweep cannot see either, and for a sharper
// reason than the crop switch's. That sweep asks whether reverting a parameter changes the
// image; a streak pointed the wrong way changes it just as much as one pointed the right
// way, so the sweep is green on a build that runs every streak the same direction whatever
// the slider says. Where the light goes is the entire claim the term makes, and nothing
// above this line tests it.
//
// **This is a probe placed where its answer is different rather than where it was
// convenient.** It exists because the direction was got wrong once already, from a
// derivation about which way v grows in the grade pass, and that build had every uniform
// landing, every image changing and a green suite. What caught it was somebody looking at a
// picture, and this is the arm that means the next one does not have to.
//
// **The arm calibrates its own axes rather than asserting them, and that is a repair rather
// than a design.** It was first written comparing row indices against a stated convention -
// `readPixels` reads from the lower-left, so light that falls lands at lower indices - and
// it went red on a build whose rendered frames plainly show the light falling. Rather than
// flip the comparison until it agreed, which is changing the code under test to satisfy the
// probe, both axes are measured here. The crop's four lateral faces cut in world metres,
// and the pinned camera looks along -z with world up on screen and world +x off to its
// right, so cutting the top removes light that is high on screen by construction and
// cutting the right face removes light that is over on one side of it. Which index each cut
// takes its light from is which way the rows and the columns run, read off this framebuffer
// on this build rather than remembered.
//
// **Each row is a difference between two opposite angles rather than a displacement from
// the picture, and that is a measurement rather than a preference.** The displacement form
// is what this section shipped with, and it carries a bias the size of the answer. The
// light a streak adds is only ever near the bright things, so its centroid sits where the
// highlights are as much as where the streak took them - measured on this fixture, the
// light added at 0 and the light added at 180 both sit about fifty columns to the *right*
// of the source's own centroid, so a row written that way would report a streak running
// rightward at both of the two angles that have no sideways component at all. The bias is
// common to both arms of a pair and cancels term by term, which is the same subtraction
// `level-check` makes when it reads its inset once with an empty depth grid.
//
// It buys an unambiguous control as well as an honest statistic: a build that ignores the
// angle renders the *same frame* at both ends of every pair, so each difference is exactly
// zero rather than merely small.
console.log('\n[registry] the streak goes where the angle points');
{
  const fall = await page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    const gl = k.renderer.getContext();
    const lum = (px, i) => px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
    // The same program position the runs above use, so this is measured on a frame the
    // rest of the section has already shown to carry a picture rather than on one picked
    // here for being convenient.
    const at = ${JSON.stringify(positions[positions.length - 1])};
    const shot = (over) => {
      k.params.reset();
      k.params.apply(${JSON.stringify(SCRAMBLE)});
      k.params.apply(over);
      k.drive.reset();
      pinCamera(k.freeCamera);
      k.drive.stepTo(at);
      return k.drive.readPixels();
    };
    // The size is taken after the first render rather than before it, because the
    // scrambled set carries a render scale: a buffer read before anything applied it
    // describes a drawing buffer this block never looks at, and every index below would be
    // out by the ratio between the two. It used to be read at the top and was right only
    // because a neighbouring section happened to leave the page scrambled.
    const base = shot({ streak: 0 });
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    // The luminance-weighted mean position of the light in a that is not in b, so one
    // helper reads the light a term adds and the light a crop face takes away.
    const meanPos = (a, b) => {
      let sr = 0, sc = 0, weight = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const v = b ? Math.max(0, lum(a, i) - lum(b, i)) : lum(a, i);
          sr += v * y;
          sc += v * x;
          weight += v;
        }
      }
      return { row: weight > 0 ? sr / weight : -1, col: weight > 0 ? sc / weight : -1, weight };
    };
    // The scrambled crop window runs -1.5 to 1 in y and -1.5 to 1.5 in x, so each face
    // brought to the value below takes roughly half the room off its own side of the
    // picture and leaves the other half standing.
    const cut = (over) => meanPos(base, shot({ streak: 0, ...over }));
    const added = {};
    for (const a of [0, 180, 90, -90, 45, -135]) {
      added[a] = meanPos(shot({ streak: 0.9, streakAngle: a }), base);
    }
    return {
      added,
      upper: cut({ top: -0.2 }),
      lower: cut({ bottom: -0.2 }),
      starboard: cut({ right: 0 }),
      port: cut({ left: 0 }),
      width: W,
      height: H,
    };
  })()`);

  check(fall.added[0].weight > 0,
    'the streak adds light at all, so the rows below are about something',
    `added luminance ${fall.added[0].weight.toFixed(0)} at an angle of 0`);

  // Each calibration has to have worked before its answer means anything: both cuts must
  // remove light, and they must remove it from opposite ends. A pair that agreed would be
  // two arms that cannot measure the quantity they were placed to measure.
  const upSpread = fall.upper.row - fall.lower.row;
  check(fall.upper.weight > 0 && fall.lower.weight > 0 && Math.abs(upSpread) > fall.height * 0.05,
    'cropping the room\'s top and its bottom take light from opposite ends, so the rows are calibrated',
    `top cut removes light at row ${fall.upper.row.toFixed(1)}, bottom cut at `
    + `${fall.lower.row.toFixed(1)} of ${fall.height}`);

  const acrossSpread = fall.starboard.col - fall.port.col;
  check(fall.starboard.weight > 0 && fall.port.weight > 0 && Math.abs(acrossSpread) > fall.width * 0.05,
    'and its right and its left do the same across the frame, so the columns are as well',
    `right cut removes light at column ${fall.starboard.col.toFixed(1)}, left cut at `
    + `${fall.port.col.toFixed(1)} of ${fall.width}`);

  // Screen-up is whichever way the top cut's light lies and screen-right whichever way the
  // right cut's does, so the two signs turn a pair of index differences into a direction on
  // the glass. What it has to agree with is the direction the slider names: the registry
  // lands (sin, cos) of the angle and the gather reads *along* that axis, so the light
  // travels the other way, -(sin, cos) in screen right and up.
  const up = Math.sign(upSpread);
  const rightward = Math.sign(acrossSpread);
  // The two gates are set between a clean build and a nailed one rather than chosen for
  // looking round. Measured on this fixture at a 492x307 drawing buffer: the three pairs
  // separate by 7.86%, 7.55% and 7.05% of the frame along the angle against a floor of 3%,
  // and drift 1.06%, 0.47% and 0.45% across it, which is 0.13, 0.06 and 0.06 of the
  // distance travelled against a ceiling of 0.4. `--mutate streak-ignores-angle` renders
  // one frame at every angle, so it answers 0.00% along and 0.00% across and fails both
  // terms of all three rows.
  //
  // Both terms earn their place: the floor is what a build that lost the direction fails,
  // and the ceiling is what a build that has a direction but the wrong one fails - a
  // streak running at 45 degrees to the angle its slider names clears the first and not
  // the second.
  for (const [a, b, sentence] of [
    [0, 180, 'the light at 0 lands below the light at 180, so an angle of zero is straight down'],
    [90, -90, 'and the light at 90 lands to the left of the light at -90, so a right angle runs across the frame'],
    [45, -135, 'and the light at 45 lands on the diagonal between them, so this is an angle rather than four choices'],
  ]) {
    const sx = ((fall.added[a].col - fall.added[b].col) / fall.width) * rightward;
    const sy = ((fall.added[a].row - fall.added[b].row) / fall.height) * up;
    const r = a * (Math.PI / 180);
    const ex = -Math.sin(r); const ey = -Math.cos(r);
    const along = sx * ex + sy * ey;
    const across = Math.abs(sx * ey - sy * ex);
    check(along > 0.03 && across < along * 0.4, sentence,
      `${a} against ${b}: ${(100 * along).toFixed(2)}% of the frame along the angle, `
      + `${(100 * across).toFixed(2)}% across it, with screen-up at `
      + `${up > 0 ? 'rising' : 'falling'} rows and screen-right at `
      + `${rightward > 0 ? 'rising' : 'falling'} columns`);
  }
}

// The ripple raised on its own, which is the one arrangement that can see whether the
// region's gate learned about it. **The scrambled set raises all four region effects at
// once**, so a gate that never names the ripple still computes a weight for the other
// three and the ripple still works - the drop-one sweep goes green over a term that is
// inert the moment it is used the way anybody would use it, which is alone. The failure
// this closes is not "the ripple does nothing" but "the ripple does nothing unless
// something else is already on", and only a look with nothing else on can tell them apart.
console.log('\n[registry] the ripple opens the region by itself');
{
  const alone = { ...SCRAMBLE, regionPush: 0, regionNoise: 0, regionMask: 0 };
  const still = await run({ ...alone, ripple: 0 });
  const moving = await run(alone);
  check(!eq(still, moving),
    'raising the ripple alone moves the picture, so the gate names it',
    eq(still, moving)
      ? 'identical with every other region effect at zero - the gate does not name the ripple'
      : `${still.filter((h, i) => h !== moving[i]).length} of ${still.length} frames differ`);
}

// The lattice snaps in the levelled frame and gets back with the transpose, which is the
// inverse **only while the cloud's matrix is a pure rotation**. That is currently true
// because the world tilt is the only transform ever written on it, and using the matrix
// three already provides is what keeps the shader from carrying a second copy of the same
// rotation that could drift from it. But "currently true" is an assumption, and an
// assumption a comment states is one nothing enforces: a scale or an offset added to the
// cloud later would leave the transpose silently not the inverse, and the lattice would
// shear the room instead of stepping it.
console.log('\n[registry] the cloud carries a rotation and nothing else');
{
  const m = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    let cloud = null;
    k.scene.traverse((o) => { if (o.geometry === k.geometry) cloud = o; });
    if (!cloud) return { found: false };
    cloud.updateMatrixWorld(true);
    const pos = new (cloud.position.constructor)();
    const quat = new (cloud.quaternion.constructor)();
    const scale = new (cloud.scale.constructor)();
    cloud.matrixWorld.decompose(pos, quat, scale);
    return {
      found: true,
      position: [pos.x, pos.y, pos.z].map((v) => Number(v.toFixed(9))),
      scale: [scale.x, scale.y, scale.z].map((v) => Number(v.toFixed(9))),
    };
  })()`);
  check(m.found, 'the point cloud is reachable from the scene, so the row below is about it');
  check(m.found && eq(m.position, [0, 0, 0]) && eq(m.scale, [1, 1, 1]),
    'and its world matrix is a pure rotation, so the lattice\'s transpose is its inverse',
    m.found ? `position ${JSON.stringify(m.position)} scale ${JSON.stringify(m.scale)}` : '');
}

// The ripple's clock steps rather than slides, which is the term's whole character and
// which **no mutation of it was caught by until this arm existed**. The drop-one sweep asks
// whether reverting `rippleSpeed` changes the picture, and it does either way - a smooth
// wave moves when you change its speed exactly as a stepped one does - so a build whose
// ripple breathed instead of ratcheting went green through the entire suite. Written after
// running `--mutate ripple-clock-continuous` and watching it be missed.
//
// **The probe holds the clock still and moves the speed, which is the opposite of the
// obvious arrangement and the reason this one works.** Comparing two program times inside
// one step was tried first and failed on a build that steps correctly, because moving the
// time moves everything else with it - which source frames are bound, the gap handed to
// the state pass, the turbulence field that `regionNoise` keeps alive even with `noise` at
// zero. Every one of those had to be chased down and the arm was still red. Holding the
// time fixed removes the entire class: the two renders differ in one uniform, and a phase
// that quantises cannot tell them apart.
//
// At a fixed time the phase is `floor(t * speed * 8) / 8`, so speeds that land inside one
// eighth have to render the same frame and a speed that crosses into the next has to
// render a different one. The second row is the control: two identical frames prove
// quantisation only if the clock is running at all.
console.log('\n[registry] the ripple advances in steps, not smoothly');
{
  const AT = 0.5;
  const at = async (rippleSpeed) => page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    k.params.reset();
    k.params.apply(${JSON.stringify(SCRAMBLE)});
    k.params.set('rippleSpeed', ${rippleSpeed});
    k.drive.reset();
    pinCamera(k.freeCamera);
    k.drive.stepTo(${AT});
    return await sha256(k.drive.readPixels());
  })()`);

  // floor(0.5 * speed * 8) is 4 at both 1.00 and 1.20, and 5 at 1.30.
  const inStep = await at(1.0);
  const alsoInStep = await at(1.2);
  const nextStep = await at(1.3);
  check(inStep === alsoInStep,
    'two speeds inside one step render the same frame, so the phase is quantised',
    inStep === alsoInStep ? `both ${inStep.slice(0, 12)} at 1.00 and 1.20`
      : `${inStep.slice(0, 12)} vs ${alsoInStep.slice(0, 12)} - the phase slid inside a step`);
  check(inStep !== nextStep,
    'and a speed in the next step renders a different one, so the clock is running',
    inStep === nextStep ? 'identical across a step boundary at 1.30' : 'differs at 1.30');
}

// The duotone's motion half, which is the only term in this file whose input the fixture
// cannot be relied on to supply. Every other parameter here is read off a value the
// registry holds; this one is read off the difference between two depth frames, and the
// six frames this file pins are of a nearly static room - the median sample moves 31 mm/s,
// which is the sensor's own jitter. The drop-one sweep does see it, because a subject
// moves through those frames and 7.7% of samples clear 150 mm/s, but what the sweep sees
// is "reverting this changed something" and the claims worth making are all sharper than
// that. So the input is planted rather than found.
//
// **The plant is a pair, and it is the only way to make one.** `injectDepth` is called
// twice because `bindDepth` swaps the two textures and then writes, so the first call is
// what becomes `depthPrev` and the second is `depthCurr` - the same idiom `monitor-check`
// uses to reach both halves of the door. What the door does not touch is the three numbers
// that describe the pair rather than its pixels, so `mixT`, `sinceFrameSec` and `spanSec`
// are written here by hand, and a section that forgot would be dividing a planted
// difference by whatever gap the last real frame arrived with.
//
// And nothing may call `drive.stepTo` afterwards: that re-enters the transport, which
// binds real frames over the plant and hands the shader a span to match. Everything below
// renders straight through `renderer.render`, which is what `renderProgramFrame` does
// itself at these parameter values, since none of the post passes are on.
//
// **Every arm plants the same current frame and differs only in the previous one**, with
// `mixT` held at 1 so the blend is the identity on it. That is what makes these rows about
// the speed and nothing else: the geometry, the neighbour spread, the point size and the
// surface memory are identical across all four, and the only thing that can move a pixel
// is the varying. The numbers are chosen so the arithmetic is exact in float32 - 240mm over
// a quarter second and 60mm over a sixteenth are both exactly 960 mm/s - because a row
// asking for bit-identity cannot afford a quotient that lands one ulp apart on two paths
// that are supposed to agree.
console.log('\n[registry] a pair planted with a known speed in it');
{
  // 1100mm puts the wall at a t of 0.15 through the default clip range, so the depth key
  // leaves it near the cold pole with the whole of the ramp above it for motion to reach
  // into. A plant at the far end of the room would sit at a k already close to 1, where
  // pushing toward 1 is arithmetically almost the identity - a probe placed where its
  // answer cannot be different.
  const CURR_MM = 1100;
  // The look the plant is read through. The depth is up because the block is guarded on
  // it, and the two shedding windows are at zero for two reasons: the ghost half leaves
  // the draw range, so nothing renders from a surface memory this section never advances,
  // and vFade takes the ternary's 1.0 rather than a value that depends on how long ago a
  // frame notionally arrived.
  const LOOK = { duotoneDepth: 1, fade: 0, wake: 0 };

  // The previous frame is built from a rule rather than filled with a value, so one helper
  // plants both a uniform wall and a chequered one: a block size of 0 is the plane, and any
  // other size alternates `prevMm` with the current depth in squares of that many texels.
  // **Block (0, 0) is deliberately one of the moving ones**, so a build reading a single
  // fixed texel reads a moving sample and renders the chequer as the all-moving frame -
  // which is what gives the rows below something to separate.
  const shot = ({ prevMm, spanSec, motion, block = 0 }) => page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    k.params.reset();
    k.params.apply(${JSON.stringify(LOOK)});
    k.params.set('duotoneMotion', ${motion});
    k.drive.reset();
    pinCamera(k.freeCamera);
    const plane = (mm) => new Uint16Array(512 * 424).fill(mm);
    const previous = () => {
      const block = ${block};
      if (block === 0) return plane(${prevMm});
      const a = new Uint16Array(512 * 424);
      for (let row = 0; row < 424; row++) {
        for (let col = 0; col < 512; col++) {
          const moving = (((col / block) | 0) + ((row / block) | 0)) % 2 === 0;
          a[row * 512 + col] = moving ? ${prevMm} : ${CURR_MM};
        }
      }
      return a;
    };
    k.drive.injectDepth(previous());
    k.drive.injectDepth(plane(${CURR_MM}));
    k.uniforms.mixT.value = 1;
    k.uniforms.sinceFrameSec.value = 0;
    k.uniforms.spanSec.value = ${spanSec};
    k.renderer.render(k.scene, k.freeCamera);
    const px = k.drive.readPixels();
    let red = 0, lit = 0;
    for (let i = 0; i < px.length; i += 4) {
      red += px[i];
      if (px[i] + px[i + 1] + px[i + 2] > 12) lit++;
    }
    const n = px.length / 4;
    return { hash: await sha256(px), red: red / n, lit: lit / n };
  })()`);

  const QUARTER = 0.25, SIXTEENTH = 0.0625;
  const still = { prevMm: CURR_MM, spanSec: QUARTER };
  // 240mm across a quarter of a second, which is inside the 250mm snap threshold.
  const fast = { prevMm: CURR_MM - 240, spanSec: QUARTER };
  // The same 960 mm/s built the other way round: a quarter of the movement over a
  // quarter of the time. A build reporting millimetres rather than millimetres per
  // second reads these as 240 and 60 and cannot make them agree.
  const brief = { prevMm: CURR_MM - 60, spanSec: SIXTEENTH };
  // 300mm, which is past the threshold, so the pair is two surfaces rather than one that
  // moved. Ungated it would read 1200 mm/s, which is exactly the top of the ramp.
  const jumped = { prevMm: CURR_MM - 300, spanSec: QUARTER };
  // The same 240mm, on half the frame. Every arm above moves the whole wall at once, and a
  // wall that moves at one speed is invariant under any permutation of its texels - so all
  // of them render identically on a build whose speed is one number rather than a value per
  // point, which is the question `docs/instruments.md` says to ask of a fixture before
  // trusting what it did not catch. 16-texel squares are coarse enough to survive the
  // projection at this pose without any row here needing to know where they land on screen.
  const chequer = { prevMm: CURR_MM - 240, spanSec: QUARTER, block: 16 };

  const off = { still: await shot({ ...still, motion: 0 }), fast: await shot({ ...fast, motion: 0 }) };
  const on = {
    still: await shot({ ...still, motion: 1 }),
    fast: await shot({ ...fast, motion: 1 }),
    brief: await shot({ ...brief, motion: 1 }),
    jumped: await shot({ ...jumped, motion: 1 }),
    chequer: await shot({ ...chequer, motion: 1 }),
  };

  // The guard the four rows below stand on, and it is the streak section's lesson applied
  // here: three of them are equalities, and two black frames are equal. A plant that
  // silently failed to render would satisfy them all.
  check(on.still.lit > 0.2 && on.still.red > 0,
    'the planted wall renders, so the rows below are comparing pictures rather than black',
    `${(100 * on.still.lit).toFixed(1)}% of the frame is lit, mean red ${on.still.red.toFixed(2)}`);

  // The default is the picture without the term, bit for bit, and it is measured here
  // because it cannot be measured where the rest of the defaults are. Section 1b renders
  // against the pinned build at parameter defaults, where duotoneDepth is 0 and this whole
  // block is skipped - so a term added inside it is unreached by that hash however its own
  // default behaves. That is the hole the glitch flare's compensating default fell through,
  // and this is the same hole one block over.
  check(off.still.hash === off.fast.hash,
    'at a motion of 0 a fast pair and a still one are bit-identical, so the default is inert',
    off.still.hash === off.fast.hash ? `both ${off.still.hash.slice(0, 12)}`
      : `${off.still.hash.slice(0, 12)} vs ${off.fast.hash.slice(0, 12)}`);

  check(on.still.hash !== on.fast.hash,
    'and raised, the same two pairs render differently, so the speed reaches the colour',
    on.still.hash === on.fast.hash ? 'identical with a planted 960 mm/s'
      : `${on.still.hash.slice(0, 12)} vs ${on.fast.hash.slice(0, 12)}`);

  // Which way, rather than whether - the streak's lesson again, and it is worth a row of
  // its own for the same reason. "Pushed toward the hot pole" is the term's whole claim,
  // and a build that keyed the speed the other way, or onto the hue, or onto the split,
  // changes the picture exactly as much as the correct one does and passes the row above.
  // The poles run from a near-black blue to an orange, so the direction is legible as the
  // mean red channel over the frame.
  check(on.fast.red > on.still.red * 1.2,
    'and it moves toward the hot pole rather than merely somewhere else',
    `mean red ${on.fast.red.toFixed(2)} moving against ${on.still.red.toFixed(2)} still`);

  // **The row this section exists for.** A build handing the raw per-frame difference on
  // is correct in every picture anybody grades, because grading happens at one frame rate;
  // it is wrong the moment the link slows down, and it is wrong silently. Nothing else in
  // this file can see it, because both arms of every other comparison here run over the
  // same pairs at the same spacing by construction.
  check(on.fast.hash === on.brief.hash,
    'the same speed over two different spans renders the same frame, so the varying is mm/s',
    on.fast.hash === on.brief.hash
      ? `240mm over ${QUARTER}s and 60mm over ${SIXTEENTH}s both ${on.fast.hash.slice(0, 12)}`
      : `${on.fast.hash.slice(0, 12)} vs ${on.brief.hash.slice(0, 12)} - a per-frame difference, `
        + 'not a rate');

  // The discontinuity gate, which the vertex stage shares with the interpolation blend. A
  // ray that crossed a silhouette carries the distance from a subject to the wall behind
  // it, and reading that as a speed sets every edge in the room alight on every frame. The
  // fixture has 52 samples past the threshold in five pairs, far too few for a hashed run
  // to notice, so the only place this can be asked is a pair planted across it.
  check(on.jumped.hash === on.still.hash,
    'a jump past the snap threshold reads as a different surface, not as fast motion',
    on.jumped.hash === on.still.hash ? `both ${on.still.hash.slice(0, 12)} at a 300mm jump`
      : `${on.jumped.hash.slice(0, 12)} vs ${on.still.hash.slice(0, 12)} - the gate is off the speed`);

  // **The speed is a value per point and not one number for the frame.** Every row above is
  // satisfied by a build that computes one speed and hands it to everybody, because every
  // plant above moves the whole wall at once - and a uniformly moving fixture is invariant
  // under any permutation of its texels. The chequer is the asymmetry that breaks that
  // invariance, and the row is stated without any reference to where a block lands on screen:
  // half moving and half still can be neither of the two uniform frames.
  check(on.chequer.hash !== on.fast.hash && on.chequer.hash !== on.still.hash,
    'a chequered pair is neither of the uniform frames, so the speed is per point',
    on.chequer.hash === on.fast.hash ? 'identical to the all-moving frame - one speed for everybody'
      : on.chequer.hash === on.still.hash ? 'identical to the still frame - the speed reached nobody'
        : `${on.chequer.hash.slice(0, 12)}, distinct from both`);

  // And the quantitative half, which is what makes the row above a measurement rather than an
  // inequality: half a frame at 960 mm/s has to warm half as much of it, so the mean sits
  // between the two. A build reading one texel lands *on* one of the ends rather than between
  // them, and this says which end it landed on.
  check(on.still.red < on.chequer.red && on.chequer.red < on.fast.red,
    'and its mean red sits between them, because half the wall is moving',
    `still ${on.still.red.toFixed(2)}, chequer ${on.chequer.red.toFixed(2)}, `
    + `moving ${on.fast.red.toFixed(2)}`);
}

// The span the speed above is divided by, held against the transport rather than against a
// number this section wrote. **The planted rows cannot ask this**: they set `spanSec`
// themselves, which is what makes them able to isolate the varying and what makes them
// blind to where the value comes from on a real run. A build computing speeds from an
// assumed frame rate renders a perfectly plausible picture, moves when the parameter is
// reverted, and is wrong by whatever the link is doing.
//
// The probe walks every pair the pinned fixture has and lands in the middle of each rather
// than on its head, because a build reporting the *first* gap forever would be satisfied by
// a row that only ever asked about the first pair. The second row is what stops a constant
// passing at all: these five gaps are genuinely unequal, so no single number is right for
// more than one of them.
console.log('\n[registry] and the span it is divided by is the gap between the bound frames');
{
  const spans = await page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    k.params.reset();
    k.drive.reset();
    pinCamera(k.freeCamera);
    const times = k.drive.times();
    const out = [];
    for (let i = 0; i < times.length - 1; i++) {
      k.drive.stepTo(times[i] + (times[i + 1] - times[i]) * 0.5);
      out.push({ want: times[i + 1] - times[i], got: k.uniforms.spanSec.value });
    }
    return out;
  })()`);

  const wrong = spans.filter((s) => s.got !== s.want);
  check(spans.length > 1 && wrong.length === 0,
    'every pair the fixture holds hands the shader its own gap',
    wrong.length
      ? wrong.map((s) => `wanted ${s.want.toFixed(6)}s, got ${s.got.toFixed(6)}s`).join('; ')
      : `${spans.length} pairs at ${spans.map((s) => (s.want * 1000).toFixed(0)).join('/')}ms`);
  check(new Set(spans.map((s) => s.want)).size > 1,
    'and no two of those gaps are the same, so a constant cannot satisfy the row above',
    `${new Set(spans.map((s) => s.want)).size} distinct gaps in ${spans.length} pairs`);
}

// The duotone's ramp is a distance, and this is the only section that can say so.
//
// **Nothing above this line can.** Every arm in this file renders at one clip range, and
// `duotoneSpan` reaches the pixels through `duotoneSpan / (farClip - nearClip)` - so a
// build dividing by a frozen 5.95 instead produces the identical number at the default
// range, lands the parameter in its uniform, moves the picture when it is reverted, and
// satisfies the drop-one sweep completely. What it gets wrong is only visible from two
// ranges at once, which is what this section is: the whole point of the parameter is that
// the grade stopped following the framing, and a probe that never moves a crop face is a
// probe placed where its answer cannot be different.
//
// **The crossing plane is held at 1.5m in both arms while the range changes underneath
// it**, which is what makes the comparison about the width alone. `duotoneSplit` is a
// fraction of the range by design, so the two arms name different splits to describe the
// same plane - 0.5 through 0.5..2.5m and 0.25 through 0.5..4.5m. Every number here is
// exact in float32, on the planted section's reasoning: a row asking for equality cannot
// afford two quotients landing an ulp apart.
//
// The walls sit at 1.25m and 1.75m, a quarter of the way out from the plane on each side
// of a 1m ramp. Not on the plane itself, which is where the two builds agree by
// construction - k is 0.5 there whatever the width - and not outside the ramp either,
// where the shipped build saturates and the difference would be a clamp rather than a
// reading.
console.log('\n[registry] the duotone span is metres, held across two clip ranges');
{
  const PLANE_M = 1.5;
  const SPAN_M = 1;
  const RANGES = [
    { near: 0.5, far: 2.5 },
    { near: 0.5, far: 4.5 },
  ].map((r) => ({ ...r, split: (PLANE_M - r.near) / (r.far - r.near) }));
  const WALLS_MM = [1250, 1750];

  // One planted wall, read through a duotone at a stated range, span and split. The
  // planting idiom is the section above's - `injectDepth` twice because `bindDepth` swaps
  // and writes, and nothing may call `stepTo` afterwards or the transport binds real
  // frames over the plant.
  const wallAt = ({ mm, near, far, split, span }) => page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    k.params.reset();
    k.params.apply({ duotoneDepth: 1, fade: 0, wake: 0,
      near: ${near}, far: ${far}, duotoneSplit: ${split}, duotoneSpan: ${span} });
    k.drive.reset();
    pinCamera(k.freeCamera);
    const plane = new Uint16Array(512 * 424).fill(${mm});
    k.drive.injectDepth(plane);
    k.drive.injectDepth(plane);
    k.uniforms.mixT.value = 1;
    k.uniforms.sinceFrameSec.value = 0;
    k.uniforms.spanSec.value = 0.25;
    k.renderer.render(k.scene, k.freeCamera);
    const px = k.drive.readPixels();
    let red = 0, lit = 0;
    for (let i = 0; i < px.length; i += 4) {
      red += px[i];
      if (px[i] + px[i + 1] + px[i + 2] > 12) lit++;
    }
    const n = px.length / 4;
    return { hash: await sha256(px), red: red / n, lit: lit / n };
  })()`);

  const shots = [];
  for (const range of RANGES) {
    const row = [];
    for (const mm of WALLS_MM) row.push(await wallAt({ mm, ...range, span: SPAN_M }));
    shots.push(row);
  }

  // The guard the equalities stand on, and it is the planted section's lesson repeated
  // because it has to be: two black frames are equal, and every row below this one is an
  // equality. A wall that failed to plant, or a clip range that culled it, would satisfy
  // all of them.
  const dimmest = Math.min(...shots.flat().map((s) => s.lit));
  check(dimmest > 0.2,
    'both walls render at both ranges, so the rows below are comparing pictures rather than black',
    `${shots.map((row, i) => row.map((s, j) => `${WALLS_MM[j]}mm at far ${RANGES[i].far}: `
      + `${(100 * s.lit).toFixed(1)}% lit, red ${s.red.toFixed(2)}`).join('; ')).join(' | ')}`);

  // The second guard, and the sharper one: the probe has to be able to see the span at
  // all. A build whose ramp had collapsed to a step would render both walls saturated at
  // opposite poles and match across the ranges for a reason that has nothing to do with
  // metres - so the two walls are required to be genuinely mid-ramp and distinct.
  const [nearWall, farWall] = shots[0];
  check(farWall.red - nearWall.red > 2 && nearWall.red > 0 && farWall.red < 255,
    'and the two walls land either side of the crossing without saturating, so the ramp is being read',
    `1250mm mean red ${nearWall.red.toFixed(2)}, 1750mm ${farWall.red.toFixed(2)}`);

  // The claim. A metre from the crossing plane is a metre at either range, so the wall
  // renders the same colour in both - and it is asserted as a bit-identical frame rather
  // than as two means within a tolerance, because the geometry, the pose and the plant are
  // all identical between the arms and only three uniforms differ. A build dividing by a
  // frozen range renders 1250mm fully cold at far 2.5 and part-way up the ramp at far 4.5,
  // which is where this goes red.
  for (const [j, mm] of WALLS_MM.entries()) {
    const a = shots[0][j], b = shots[1][j];
    check(a.hash === b.hash,
      `a wall ${((mm / 1000 - PLANE_M) * 100).toFixed(0)}cm from the crossing renders the same `
      + `through a ${(RANGES[0].far - RANGES[0].near).toFixed(1)}m range and a `
      + `${(RANGES[1].far - RANGES[1].near).toFixed(1)}m one`,
      a.hash === b.hash
        ? `mean red ${a.red.toFixed(2)} at both, ${a.hash.slice(0, 12)}`
        : `${a.hash.slice(0, 12)} at far ${RANGES[0].far} against ${b.hash.slice(0, 12)} at far `
          + `${RANGES[1].far}; mean red ${a.red.toFixed(2)} against ${b.red.toFixed(2)}, so the `
          + 'ramp is a share of the box rather than a distance');
  }

  // And the control for those two, which is the row that stops them passing on a build
  // where the span reaches nothing: widen the ramp at one fixed range and the same wall
  // has to move. Two frames that agree prove the width is invariant under the range; this
  // is what proves the width exists.
  const wide = await wallAt({ mm: WALLS_MM[1], ...RANGES[0], span: 3 });
  check(wide.hash !== shots[0][1].hash,
    'while widening the ramp at one range does move it, so the equalities above are not '
    + 'a parameter that reaches nothing',
    `${SPAN_M}m gives mean red ${shots[0][1].red.toFixed(2)}, 3m gives ${wide.red.toFixed(2)}`);
}

// ------------------------------------------------------------------- verdict

if (main.errors.length) {
  console.log(`\n[registry] page errors:\n  ${main.errors.join('\n  ')}`);
  failures++;
}

await browser.close();

if (MUTATE) {
  // Three outcomes, three exit codes, because two of them are routinely confused for
  // each other. `registration-check` reserves 2 for "the harness did not run" on the
  // same reasoning and this joins it rather than inventing a fourth convention: a
  // mutation that failed to compile, or a Playwright page that died, is not a mutation
  // that was caught, and the difference is invisible to anything reading exit codes
  // alone. The rows above are the answer - read which ones fired, not how many.
  const caught = failures > 0;
  console.log(`\n[registry] mutation ${MUTATE} ${caught
    ? `caught, as required (${failures} assertions fired)`
    : 'NOT CAUGHT'}`);
  console.log(`           it should redden: ${MUTATIONS[MUTATE].fails}`);
  process.exit(caught ? 0 : 1);
}

console.log(`\n[registry] ${failures ? `FAIL (${failures})` : 'PASS'}`);
process.exit(failures ? 1 : 0);
