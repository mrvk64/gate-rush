// js/audio.js — GATE RUSH AudioSystem (ARCHITECTURE §6.13 / §11, GDD §13).
//
// Everything is synthesised at runtime with WebAudio: no files, no recorded audio (round 5: some cue instances and the pad chords are
// rendered once at boot by this same synthesis code into OfflineAudioContext buffers, see below).
//
//   graph:  cue voices → [StereoPanner] → bus gain (sfx | gun → gun reward duck) ─┐
//           music notes → music bus → duck hold → duck transient → fade ─────────┤   (MUSIC.buses dB)
//                                                                              └→ DynamicsCompressor (MUSIC.compressor:
//           −18 dB, knee 6, 6:1, 3 ms / 120 ms) → bed duck (MUSIC.duck.bedOnReward) ─┐
//           reward cues (cue bus 'reward': pass_up, hup, flip, sting_*) → reward bus ──┴→ limiter (MUSIC.limiter:
//           DynamicsCompressor −1 dB 20:1 → WaveShaper soft clip, ceiling < 0 dBFS) → master gain (mute) → destination
//     The reward bus bypasses the bus compressor (round 3, AUD-10): compressed together with the gunfire, the 6:1 ratio
//     pinned the gate-pass reward 3–5 dB over the bed whatever its gain; on its own bus it keeps its designed level, and the
//     compressed bed dips under it.
//
//   • The AudioContext and the whole graph are built in init() (boot step 7, behind the boot bar): constructing a
//     context costs up to ~1 s on some Windows Chrome builds and must never land inside the first tap. Without a
//     gesture it starts 'suspended'; if construction fails at boot it is retried once inside a gesture.
//   • unlock(): engine's gesture listeners call it synchronously; it only resumes (+ primes old iOS) on every
//     call, `audio:unlocked` is emitted only once the state is 'running'. The music scheduler interval starts
//     at the first 'running'. A statechange to 'suspended'/'interrupted' sets needsGesture so engine re-arms.
//   • play(name, opts): fire-and-forget; listeners only QUEUE (ring buffer, module-level payloads),
//     update() (frame step G) starts the queued cues on AudioContext.currentTime.
//   • Cue interpreter: renders EVERY recipe of data.js AUDIO_CUES with exactly the vocabulary
//     documented at the top of that export (src, f/fEnd/fMs, ms/attack/decay, gain, delayMs, filter,
//     shaper, detune; cue-level bus, coalesceMs, stackDb, maxPerSec, rateJitter, countDb, voices,
//     ladder, pitchRule, repeatMs).
//   • Three 1 s noise buffers (white, brown, band-passed 1.2 kHz Q 0.7) rendered once with the graph.
//   • First-use warm-up (round 4): right after the graph, idle slices (MUSIC.warm) build every oscillator type once (the
//     browser computes each type's band-limited wave tables on first use, 4–10 ms each at 4× CPU) and then dry-build every
//     AUDIO_CUES recipe once into an unconnected sink (no source is started), so the first shot / gate pass / boss cue
//     no longer pays table builds, node-type first use and cold interpreter code inside a frame. WaveShapers (the only
//     node whose setup is expensive on every use: its 2× oversampler) are pooled per drive and reused.
//   • Cues started with delayMs ≥ MUSIC.queue.deferMinMs (fanfare after the boss-death roar, boss stomp landings) are
//     built MUSIC.queue.deferLeadMs before their start on the audio clock instead of in the triggering frame.
//   • Pre-rendered instances (round 5): a cue with `prerender` (hup, pass_up, the boss-intro / brute roar, fanfare) and the music
//     pad chords are rendered once through this same interpreter into an OfflineAudioContext (warm-up items after the dry
//     builds); a play that matches a rendered (pitch, stretch) at rate 1 is then ONE AudioBufferSource into the cue gain instead
//     of its layer chains (the 8-voice hup: 2 nodes instead of 33; a pad chord: 2 instead of 18). The audio is the same graph's
//     output, so the timbre is unchanged; a play with no matching buffer (another pitch, a slow-mo rate, a render not finished)
//     is synthesised live as before.
//   • Music: a live scheduler on setInterval(MUSIC.schedulerMs) with MUSIC.lookaheadMs lookahead,
//     120 BPM, 8-bar A-minor loop built from MUSIC.patterns / instruments / modes; never a buffer.
//     Mode changes between two playing modes land on the next beat (MUSIC.modeSwitch.beatSteps);
//     level:start / boss:fight / the title restart the loop at bar 0 and fade the old mode's notes out
//     over MUSIC.modeSwitch.crossfadeMs; start/stop fade over MUSIC.fadeMs.
//   • setTimeScale(s): rate r = MUSIC.rate.base + perScale·s → buffer sources playbackRate,
//     oscillators detune 1200·log2(r), scheduler step length ÷ r. Sounding sources glide (cancel + hold +
//     setTargetAtTime); sources whose start is still in the future (cue delayMs, layer delays, the music
//     lookahead) get their start value rewritten. Cues flagged `noTimeScale` (fanfare, chime3, ui_*) ignore it.
//
// Coding rules (ARCH §14): no per-frame allocation in update() except the WebAudio nodes a cue
// inherently needs (created only when a cue actually starts); every browser API guarded; no
// console.log; randomness from ctx.rngFx; private fields `_`; init() returns this; dispose()
// removes every listener. Numbers come from data.js (keys named in comments).

import { MUSIC, AUDIO_CUES, JUICE, WEAPONS, GEAR, TROOPS, FIRE } from './data.js';
import { clamp, warnOnce, mulberry32 } from './util.js';

// ---------------------------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------------------------

// DATA-MISSING: AUDIO_CUES.coin.ladder.maxSteps — the coin ladder stops climbing after one octave
// (GDD §13 gives no cap; a fast coin line would otherwise climb into a piercing 7 kHz+ range).
const LADDER_MAX_STEPS = 12;
// Boss variants of shared cues (AUDIO_CUES.roar / fanfare / thud / thip extras, GDD J16).
const BOSS_INTRO_ROAR_PITCH = AUDIO_CUES.roar.bossIntroPitch;
const BOSS_DEATH_ROAR_PITCH = AUDIO_CUES.roar.bossDeathPitch;      // J16 "roar at rate 0.4"
const BOSS_DEATH_ROAR_STRETCH = AUDIO_CUES.roar.bossDeathStretch;  // tape-speed: 600 ms → 1.5 s, fills the 1.2 s slow-mo
const BOSS_ROAR_VOLUME = AUDIO_CUES.roar.bossVolume;               // boss intro / death roars have no pos attenuation
const FANFARE_AFTER_ROAR_MS = AUDIO_CUES.fanfare.afterRoarMs;      // J16: the fanfare rides the roar's tail
const BOSS_STOMP_PITCH = AUDIO_CUES.thud.bossStompPitch;
const BOSS_HIT_PITCH = AUDIO_CUES.thip.bossPitch;
// Distance attenuation (MUSIC.pan): attenDbAt40m refers to attenRefM; it stops growing at attenMaxRatio× it.
const ATTEN_REF_M = MUSIC.pan.attenRefM;
const ATTEN_MAX_RATIO = MUSIC.pan.attenMaxRatio;
// Engine caps (MUSIC.queue): queue capacity, cues started per update, tracked live voices. Sanity caps only
// (a flood beyond them is dropped and counted in ctx.debug.dropped.audio).
const QUEUE_CAPACITY = MUSIC.queue.capacity;
const STARTS_PER_UPDATE = MUSIC.queue.startsPerUpdate;
const LIVE_CAPACITY = MUSIC.queue.liveCapacity;
// Same-frame cap for cues without coalesceMs / maxPerSec (MUSIC.queue.maxPerFrame); the extra copy is decorrelated
// (started dupOffsetMs later, pitch ± dupJitter) so identical copies never sum phase-coherently (AUD-6).
const SAME_FRAME_MAX = MUSIC.queue.maxPerFrame;
const DUP_OFFSET_MIN_MS = MUSIC.queue.dupOffsetMs[0];
const DUP_OFFSET_SPAN_MS = MUSIC.queue.dupOffsetMs[1] - MUSIC.queue.dupOffsetMs[0];
const DUP_JITTER = MUSIC.queue.dupJitter;
// DATA-MISSING: AUDIO_CUES.tick.keySlots — per-gate coalescing table size (gate pool is 12).
const KEY_SLOTS = 16;
// Gate ids are (generation << 12) | slot (gates.js): the low 12 bits index the per-gate weighted-hit
// accumulator that drives the x / ÷ tick pitch (J3).
const GATE_SLOT_MASK = 0xFFF;
// DATA-MISSING: AUDIO_CUES.pass_neutral — a zero-change gate pass (grey x1, '+0') still acknowledges
// the pass: pass_down played this much quieter (dB).
const PASS_NEUTRAL_DB = -6;
// DATA-MISSING: AUDIO_CUES.hup.spreadMs — chorus voices start up to this much apart (a crowd, not a
// single phase-locked synth).
const CHORUS_SPREAD_MS = 18;
// Equal-power StereoPanner on a mono voice: each channel gets cos/sin of the pan angle (−3 dB per channel at the centre),
// while an unpanned mono cue is up-mixed at unity into both channels. Chorus voices spread by their own panners
// (voices.spread) are lifted by √2 so a spread crowd keeps the power of the same voices played centred.
const PAN_LAW_COMP = Math.SQRT2;
// ARCH §6.13 "if the state is not running within 500 ms" (MUSIC.visibilityResumeMs).
const VISIBILITY_RESUME_MS = MUSIC.visibilityResumeMs;
// A scheduler that fell more than catchUpS behind (tab throttling with a running context) skips ahead instead of
// bursting every missed step; maxStepsPerTick guards one pass (MUSIC.scheduler).
const SCHEDULER_CATCH_UP_S = MUSIC.scheduler.catchUpS;
const SCHEDULER_MAX_STEPS = MUSIC.scheduler.maxStepsPerTick;
// The first step of a freshly started / restarted loop is placed this far ahead (MUSIC.startDelayS).
const MUSIC_START_S = MUSIC.startDelayS;
// setTargetAtTime constant for volume / mute / rate changes (MUSIC.paramSmoothS; ARCH §6.13 rate 0.02).
const PARAM_SMOOTH_S = MUSIC.paramSmoothS;
// setTargetAtTime constants of a timed duck (MUSIC.duck.attackS / releaseS).
const DUCK_ATTACK_S = MUSIC.duck.attackS;
const DUCK_RELEASE_S = MUSIC.duck.releaseS;
// Mode switches (MUSIC.modeSwitch): between two playing modes on the next beat; a restart fades the old notes out.
const BEAT_STEPS = MUSIC.modeSwitch.beatSteps;
const CROSSFADE_S = MUSIC.modeSwitch.crossfadeMs / 1000;
// Round-4 release (ARCH §14 guarded data reads; r4-level needsOtherGroup 1): the round-4 MUSIC.queue / MUSIC.warm keys
// below fall back to their shipped values, so this module still evaluates against a data.js without them (a mid-edit
// tree, or a network-first launch whose slow data.js request was answered from an older cached copy) instead of
// failing the boot at import time.
const MQ_R4 = MUSIC.queue;
const MW_R4 = MUSIC.warm || {};
// Delayed cues (MUSIC.queue): a cue whose delayMs is at least deferMinMs waits in a small deferred table (deferCapacity
// entries; a full table starts the cue at once, as before round 4) and is built deferLeadMs before its start time.
const DEFER_MIN_S = (MQ_R4.deferMinMs > 0 ? MQ_R4.deferMinMs : 200) / 1000;      // MUSIC.queue.deferMinMs
const DEFER_LEAD_S = (MQ_R4.deferLeadMs > 0 ? MQ_R4.deferLeadMs : 150) / 1000;   // MUSIC.queue.deferLeadMs
const DEFER_CAPACITY = MQ_R4.deferCapacity > 0 ? MQ_R4.deferCapacity : 8;       // MUSIC.queue.deferCapacity
// WaveShaper pool (MUSIC.queue.shaperPool): released shapers of one drive are kept for reuse, at most this many per drive.
const SHAPER_POOL_MAX = MQ_R4.shaperPool > 0 ? MQ_R4.shaperPool : 8;            // MUSIC.queue.shaperPool
// Pre-rendered instances (round 5; MUSIC.prerender, guarded like the round-4 keys): a play uses a buffer rendered at a pitch within
// ±pitchTol of its own (playbackRate = the ratio); the render runs tailMs past the last layer's end.
const MP_R5 = MUSIC.prerender || {};
const PRE_PITCH_TOL = MP_R5.pitchTol > 0 ? MP_R5.pitchTol : 0.1;                 // MUSIC.prerender.pitchTol
const PRE_TAIL_S = (MP_R5.tailMs > 0 ? MP_R5.tailMs : 30) / 1000;                // MUSIC.prerender.tailMs
// Reward lift (round 5, MUSIC.rewardLift.maxDb; guarded): while the music fader is above the sound fader, the reward bus is lifted toward
// the music fader by at most this many dB (0: no lift, the shipped behaviour).
const REWARD_LIFT_MAX = Math.pow(10, ((MUSIC.rewardLift && MUSIC.rewardLift.maxDb > 0) ? MUSIC.rewardLift.maxDb : 0) / 20);
// First-use warm-up slices (MUSIC.warm): an idle callback runs warm items while it has more than idleMinMs left (at least
// one item per callback), with timeoutMs as the idle-callback deadline; hosts without requestIdleCallback use a timer.
const WARM_IDLE_MIN_MS = MW_R4.idleMinMs > 0 ? MW_R4.idleMinMs : 2;             // MUSIC.warm.idleMinMs
const WARM_TIMEOUT_MS = MW_R4.timeoutMs > 0 ? MW_R4.timeoutMs : 200;            // MUSIC.warm.timeoutMs
const WARM_TIMER_MS = MW_R4.timerMs > 0 ? MW_R4.timerMs : 16;                   // MUSIC.warm.timerMs
// Oscillator types the cue / music recipes use: each one's wave tables are built once by the warm-up.
const OSC_TYPES = ['sine', 'square', 'sawtooth', 'triangle'];
const WARM_IDLE_OPTS = { timeout: WARM_TIMEOUT_MS };
// Live voice kinds (setTimeScale / loop restart bookkeeping).
const VOICE_CUE = 0, VOICE_MUSIC = 1, VOICE_DRONE = 2;
// Envelope floor for exponential decays: −60 dB (AUDIO_CUES vocabulary "exponential decay to −60 dB").
const ENV_FLOOR = 0.001;
// Minimum oscillator frequency for exponential ramps (the ramp target must be > 0).
const MIN_HZ = 1;
// Default layer attack when a recipe omits it (AUDIO_CUES vocabulary: "attack: ms (default 2)").
const DEFAULT_ATTACK_MS = 2;
// Scheduling offset for cues started "now" so the first envelope event is never in the past.
const START_LATENCY_S = 0.005;
// Extra time after a voice's last envelope point before its nodes are disconnected.
const RELEASE_MARGIN_S = 0.05;
// Deterministic seed for the pre-rendered noise buffers (Math.random is banned; a fixed seed keeps
// the buffers identical across sessions — they are plain noise, not gameplay).
const NOISE_SEED = 0x5EED0A0D;

// Bass degree → semitone offset (MUSIC.patterns.bass.steps: 0 rest, 1 root, 5 fifth, 8 octave).
const DEGREE_SEMITONES = { 1: 0, 5: 7, 8: 12 };

// Music geometry (MUSIC.bpm / stepsPerBar / bars): seconds per 16th step at rate 1, loop length.
const STEPS_PER_BAR = MUSIC.stepsPerBar;
const LOOP_STEPS = MUSIC.bars * STEPS_PER_BAR;
const STEP_S = 60 / MUSIC.bpm / (STEPS_PER_BAR / 4);
const FADE_S = MUSIC.fadeMs / 1000;

// Power-up countdown (J14): `ticktock` every repeatMs during the last JUICE.powerup.pillBlinkLast s.
const TICK_PERIOD_S = AUDIO_CUES.ticktock.repeatMs / 1000;
const TICK_WINDOW_S = JUICE.powerup.pillBlinkLast;
const CHIP_ID = GEAR.chip.id;
const BOOSTER_ID = GEAR.booster.id;

// Music modes that state:change selects (ARCH §11: menu on title / shop / levels).
const MENU_STATES = { title: true, shop: true, levels: true };

// Reusable event payload for audio:unlocked (listeners must not retain it).
const UNLOCKED_PAYLOAD = {};

// Reusable play() options object for the internal listeners (play() copies every field).
// Fraction-holding fields are created from 0.5 and reset right below (round-2 cross-group, FX-14 item 2: a Double
// representation from the start, so the first fractional volume / value does not deprecate the map mid-play).
const OPTS = { volume: 0.5, pitch: 0.5, pos: null, detune: 0.5, count: 0, value: 0.5, key: 0, keyed: false, delayMs: 0.5, stretch: 0.5 };
const POS = { x: -0, z: -0 };

function resetOpts() {
  OPTS.volume = 1; OPTS.pitch = 1; OPTS.pos = null; OPTS.detune = 0;
  OPTS.count = 0; OPTS.value = 0; OPTS.key = 0; OPTS.keyed = false; OPTS.delayMs = 0; OPTS.stretch = 1;
  return OPTS;
}

resetOpts();

function withPos(x, z) {
  POS.x = x; POS.z = z;
  OPTS.pos = POS;
  return OPTS;
}

function noop() { /* swallow */ }

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/** dB → linear gain. */
function dbToGain(db) { return Math.pow(10, db / 20); }

/** MIDI note → Hz (A4 = 69 = 440 Hz). */
function midiHz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

/** Settings fader 0–100 → gain multiplier. Round 4 (lead decision, GDD §13): an audio taper linear in amplitude, so
 *  50 is −6 dB and 80 is −1.9 dB (the squared law made 50 −12 dB, which sank every sfx — the gate-pass reward included —
 *  under the music at its default 80). The floor is soft: 10 → −20 dB, 1 → −40 dB, 0 → silent. MUSIC.buses.music
 *  carries the −1.9 dB that keeps the default mix (sound 100 / music 80) where the squared law had it. */
function faderGain(v) {
  return clamp((v | 0) / 100, 0, 1);
}

/**
 * Round 5 (GDD §13: the gate-pass reward reads ≥ 6 dB over the bed, music included): the reward bus's fader gain. It follows the sound
 * fader, but while the music fader is higher it is lifted toward it, by at most MUSIC.rewardLift.maxDb — at sound 50 / music 80 the bed
 * is mostly music, and a reward that dropped the full −6 dB of the sound fader rose only ≈ 4 dB over it. Sound 0 stays silent (the lift
 * multiplies the sound fader); sound ≥ music (the defaults) is unchanged. musicOn false (?nomusic / no bed): no lift.
 */
function rewardFaderGain(sound, music, musicOn) {
  const s = faderGain(sound);
  const m = musicOn ? faderGain(music) : 0;
  if (!(m > s) || s <= 0) return s;
  const lifted = s * REWARD_LIFT_MAX;
  return lifted < m ? lifted : m;
}

/** ms helper on the host clock (used only when ctx.time is not available yet). */
function hostNowMs() {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  } catch (_) { /* fall through */ }
  return Date.now();
}

/** Finite number or the fallback. */
function num(v, fallback) { return typeof v === 'number' && v === v ? v : fallback; }

// gate:pass sound classes (J7 positive / J8 negative / neutral zero-change / item lane)
const PASS_NEUTRAL = 0, PASS_UP = 1, PASS_DOWN = -1, PASS_ITEM = 2;

/** Classifies a gate:pass by its effective op / value: '+' N>0 up; '-' (unflipped; a flipped '-' is
 *  reported as '+') N>0 down; 'x' N>1 up; '/' flipped (x2) up, divisor > 1 down; x1 / '+0' neutral. */
function passKind(op, value, flipped) {
  if (op === 'item') return PASS_ITEM;
  if (op === '+') return value > 0 ? PASS_UP : PASS_NEUTRAL;
  if (op === '-') return value > 0 ? PASS_DOWN : PASS_NEUTRAL;
  if (op === 'x') return value > 1 ? PASS_UP : value < 1 ? PASS_DOWN : PASS_NEUTRAL;
  if (op === '/') {
    if (flipped) return value > 1 ? PASS_UP : PASS_NEUTRAL;
    return value > 1 ? PASS_DOWN : PASS_NEUTRAL;
  }
  return PASS_NEUTRAL;
}

/**
 * Renders the three 1 s noise buffers (MUSIC.noise): white, brown (leaky integrator of white),
 * band-passed white (RBJ biquad band-pass at MUSIC.noise.band.f / q). Peak-normalised to 0.9.
 * @param {AudioContext} ac
 * @returns {{ noise: AudioBuffer, brown: AudioBuffer, band: AudioBuffer }}
 */
function renderNoiseBuffers(ac) {
  const sr = ac.sampleRate;
  const n = Math.max(1, Math.floor(sr * MUSIC.noise.seconds));
  const white = ac.createBuffer(1, n, sr);
  const brown = ac.createBuffer(1, n, sr);
  const band = ac.createBuffer(1, n, sr);
  const w = white.getChannelData(0);
  const b = brown.getChannelData(0);
  const p = band.getChannelData(0);
  const rnd = mulberry32(NOISE_SEED);

  // white
  for (let i = 0; i < n; i++) w[i] = rnd() * 2 - 1;

  // brown: leaky integration (−6 dB/oct), normalised afterwards
  let acc = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    acc = (acc + 0.02 * w[i]) / 1.02;
    b[i] = acc;
    const a = Math.abs(acc);
    if (a > peak) peak = a;
  }
  const bScale = peak > 0 ? 0.9 / peak : 1;
  for (let i = 0; i < n; i++) b[i] *= bScale;

  // band-pass (RBJ cookbook, constant 0 dB peak gain)
  const f0 = MUSIC.noise.band.f;
  const q = MUSIC.noise.band.q;
  const w0 = 2 * Math.PI * f0 / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = alpha, b1 = 0, b2 = -alpha;
  const a0 = 1 + alpha, a1 = -2 * Math.cos(w0), a2 = 1 - alpha;
  const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0, na1 = a1 / a0, na2 = a2 / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  peak = 0;
  for (let i = 0; i < n; i++) {
    const x0 = w[i];
    const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    p[i] = y0;
    const a = Math.abs(y0);
    if (a > peak) peak = a;
  }
  const pScale = peak > 0 ? 0.9 / peak : 1;
  for (let i = 0; i < n; i++) p[i] *= pScale;

  // Scale the white buffer too so the three sit at a comparable level.
  for (let i = 0; i < n; i++) w[i] *= 0.9;

  return { noise: white, brown, band };
}

/**
 * WaveShaper transfer curve for a 0..1 drive (tanh-style soft clip; drive 0 → identity).
 * @param {number} drive
 * @returns {Float32Array}
 */
function makeShaperCurve(drive) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1 + drive * 40;   // drive 0.6 → k 25: a saturated, growly roar
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = drive <= 0 ? x : Math.tanh(k * x) / norm;
  }
  return curve;
}

/** OfflineAudioContext constructor of this browser (null without one: every cue stays live-synthesised). */
function offlineContextCtor() {
  try {
    if (typeof window !== 'undefined') return window.OfflineAudioContext || window.webkitOfflineAudioContext || null;
  } catch (_) { /* fall through */ }
  return null;
}

/**
 * Pre-render plan of one cue (AUDIO_CUES[name].prerender = { variants, at: [[pitch, stretch], …] }, round 5), or null.
 * One buffer per (at entry, chorus size n = 1 … voices.max, variant); a deterministic instance (n = 1 without noise layers) gets
 * one variant. lead = the earliest layer delay (trimmed: the buffer starts that much after t0), span = the rendered length.
 */
function makePrePlan(cue) {
  const pr = cue.prerender;
  if (!pr || !cue.layers || cue.layers.length === 0) return null;
  const at = Array.isArray(pr.at) && pr.at.length > 0 ? pr.at : [[1, 1]];
  const A = at.length;
  const nMax = cue.voices ? Math.max(1, cue.voices.max | 0) : 1;
  const variants = Math.max(1, pr.variants | 0);
  let noisy = false;
  for (let i = 0; i < cue.layers.length; i++) {
    const s = cue.layers[i].src;
    if (s === 'noise' || s === 'brown' || s === 'band') noisy = true;
  }
  const plan = {
    atN: A, nMax, variants, noisy,
    pitch: new Float64Array(A), stretch: new Float64Array(A), lead: new Float64Array(A), span: new Float64Array(A),
    varN: new Uint8Array(nMax),          // variants rendered for chorus size n (index n − 1)
    channels: cue.voices && cue.voices.spread > 0 && nMax > 1 ? 2 : 1,
    bufs: new Array(A * nMax * variants),
  };
  for (let i = 0; i < plan.bufs.length; i++) plan.bufs[i] = null;
  for (let n = 1; n <= nMax; n++) plan.varN[n - 1] = (n > 1 || noisy || cue.rateJitter) ? variants : 1;
  for (let k = 0; k < A; k++) {
    const p = at[k][0] > 0 ? at[k][0] : 1, st = at[k][1] > 0 ? at[k][1] : 1;
    let lead = Infinity, end = 0;
    for (let i = 0; i < cue.layers.length; i++) {
      const L = cue.layers[i];
      const d = (L.delayMs || 0) * st / 1000;
      if (d < lead) lead = d;
      const e = d + Math.max(0.005, (L.ms * st) / 1000) + 0.02;   // _startLayer's end
      if (e > end) end = e;
    }
    plan.pitch[k] = p; plan.stretch[k] = st; plan.lead[k] = lead;
    plan.span[k] = end - lead + (nMax > 1 ? CHORUS_SPREAD_MS / 1000 : 0) + PRE_TAIL_S;
  }
  return plan;
}

/** Builds the per-cue runtime state table (one plain object per AUDIO_CUES key, created once). */
function makeCueState(name) {
  const s = {
    name,
    recipe: AUDIO_CUES[name],
    lastLimitMs: -1e9,    // last start admitted by the maxPerSec limiter
    lastPlayMs: -1e9,     // last start (ladder / global coalesce)
    ladderStep: 0,        // coin ladder position
    frameMs: -0.5,        // same-frame cap: frame time of the last admitted play (-1 below; seeded as a Double)
    frameCount: 0,        //                 plays admitted in that frame
    pendingEntry: null,   // queued (not yet started) instance, for stackDb
    liveGain: null,       // cue GainNode of the last started instance (for stackDb bumps)
    liveGainBase: 0.5,    // its base gain value (0 below; seeded as a Double)
    liveStack: 0,         // extra stacked instances applied to it
    pre: null,            // round 5: pre-render plan + rendered buffers (makePrePlan), null for a live-only cue
  };
  s.frameMs = -1; s.liveGainBase = 0;
  return s;
}

/** Queue entry factory (QUEUE_CAPACITY plain objects, created once in init). */
function makeQueueEntry() {
  // fraction-holding fields seeded with 0.5, then reset (Double representation from the start; round-2 cross-group)
  const e = { name: '', st: null, volume: 0.5, pitch: 0.5, hasPos: false, x: 0.5, z: 0.5, detune: 0.5, count: 0, value: 0.5,
              delayMs: 0.5, stretch: 0.5, stack: 0, at: 0.5 };
  e.volume = 1; e.pitch = 1; e.x = 0; e.z = 0; e.detune = 0; e.value = 0; e.delayMs = 0; e.stretch = 1; e.at = 0;
  return e;
}

/** Copies a queue entry's play parameters into another entry (the deferred table keeps its own copies). */
function copyEntry(dst, src) {
  dst.name = src.name; dst.st = src.st; dst.volume = src.volume; dst.pitch = src.pitch; dst.hasPos = src.hasPos;
  dst.x = src.x; dst.z = src.z; dst.detune = src.detune; dst.count = src.count; dst.value = src.value;
  dst.delayMs = src.delayMs; dst.stretch = src.stretch; dst.stack = src.stack; dst.at = src.at;
}

/** Live voice record factory (LIVE_CAPACITY records, created once in init). */
function makeVoice(maxNodes, maxSrcs) {
  const nodes = new Array(maxNodes);
  for (let i = 0; i < maxNodes; i++) nodes[i] = null;
  const srcs = new Array(maxSrcs);
  for (let i = 0; i < maxSrcs; i++) srcs[i] = null;
  return {
    active: false,
    endTime: 0,
    startTime: 0,                           // earliest source start (context time)
    kind: VOICE_CUE,                        // VOICE_CUE | VOICE_MUSIC | VOICE_DRONE
    fixedRate: false,                       // noTimeScale cue: setTimeScale leaves it alone
    env: null,                              // music note envelope GainNode (loop-restart fade-out)
    nodeCount: 0, nodes,
    nodeDrive: new Float64Array(maxNodes),  // > 0: a pooled WaveShaper of that drive (the exact recipe number), returned on release
    srcCount: 0, srcs,
    srcBuf: new Uint8Array(maxSrcs),        // 1 = AudioBufferSourceNode (playbackRate), 0 = OscillatorNode (detune)
    srcBase: new Float32Array(maxSrcs),     // base playbackRate / base detune (cents) before the time-scale rate
    srcStart: new Float64Array(maxSrcs),    // context time the source starts (future starts are re-valued by setTimeScale)
    cueGain: null,
    cueState: null,
  };
}

/** WaveShaper curve of the master soft clip (MUSIC.limiter.clip): identity up to |x| = linear, then a tanh
 *  shoulder towards `ceiling` (< 1). Odd length so x = 0 maps exactly to 0; inputs beyond ±1 hold the end value. */
function makeClipCurve(linear, ceiling) {
  const n = 4097;
  const curve = new Float32Array(n);
  const span = Math.max(1e-3, ceiling - linear);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= linear ? a : linear + span * Math.tanh((a - linear) / span);
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

/** Largest node / source count any AUDIO_CUES recipe needs (layers × chorus voices). */
function measureCues() {
  let maxSrcs = 1;
  let maxNodes = 6;                               // music: the drone needs osc + filter + gain + lfo + lfo gain (5)
  for (const name in AUDIO_CUES) {
    const cue = AUDIO_CUES[name];
    const voices = cue.voices ? cue.voices.max : 1;
    const s = cue.layers.length * voices;
    if (s > maxSrcs) maxSrcs = s;
    // per source: src + shaper + filter + envelope; per chorus voice: its StereoPanner (voices.spread); per cue: cue gain + panner
    const nodes = s * 4 + (voices > 1 ? voices : 0) + 2;
    if (nodes > maxNodes) maxNodes = nodes;
  }
  return { maxSrcs, maxNodes };
}

/** Cancels automation on a param from `now` and holds its current value (guarded per browser). */
function holdParam(param, now) {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    try { param.cancelAndHoldAtTime(now); return; } catch (_) { /* fall through */ }
  }
  const v = param.value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(v, now);
}

/** Smoothly moves a param to `value` (setTargetAtTime with time constant `tc`). */
function glideParam(param, value, now, tc) {
  holdParam(param, now);
  param.setTargetAtTime(value, now, tc);
}

// ---------------------------------------------------------------------------------------------
// AudioSystem
// ---------------------------------------------------------------------------------------------

export class AudioSystem {
  /** @param {object} ctx shared context (ARCH §3) */
  constructor(ctx) {
    this._ctx = ctx;

    // context + graph (built in init(); retried inside a gesture if construction failed at boot)
    this._ac = null;
    this._failed = false;
    this._disposed = false;
    this._master = null;          // mute gain → destination
    this._comp = null;            // DynamicsCompressor (MUSIC.compressor)
    this._limiter = null;         // DynamicsCompressor (MUSIC.limiter) → soft clip
    this._clip = null;            // WaveShaper soft clip (MUSIC.limiter.clip)
    this._sfxBus = null;          // MUSIC.buses.sfx · sound fader
    this._gunBus = null;          // MUSIC.buses.gun · sound fader
    this._gunDuck = null;         // gun bus reward duck (MUSIC.duck.gunOnReward)
    this._rewardBus = null;       // MUSIC.buses.reward · sound fader → limiter (bypasses the compressor, round 3 AUD-10)
    this._bedDuck = null;         // compressor output dip under the reward cues (MUSIC.duck.bedOnReward, round 3 AUD-10)
    this._musicBus = null;        // MUSIC.buses.music · music fader
    this._duckHold = null;        // duck(db, 0): held until duck(0, 0)
    this._duckTr = null;          // duck(db, seconds): transient, recovers by itself
    this._musicFade = null;       // music start / stop fade (MUSIC.fadeMs)
    this._buffers = null;         // { noise, brown, band } pre-rendered at unlock
    this._silent = null;          // 1-sample buffer used to prime old iOS inside the gesture
    this._curves = null;          // shaper drive → Float32Array curve (built with the graph)
    this._shaperPools = null;     // shaper drive → free WaveShaperNodes (curve + oversample set; round 4)
    this._hasPanner = false;

    // first-use warm-up (round 4): oscillator types, then one dry build per cue, in idle slices after the graph
    this._warmSink = null;        // unconnected GainNode the dry builds end in (nothing reaches the destination)
    this._warmNames = null;       // AUDIO_CUES names, in recipe order
    this._warmIdx = 0;            // next warm item: [0, OSC_TYPES.length) oscillator types, then cue names
    this._warmLeft = 0;           // items still to warm (0 = done)
    this._warming = false;        // a dry build is running: no source start, no live bookkeeping, local randomness
    this._warmHandle = 0;
    this._warmIdle = false;       // _warmHandle is a requestIdleCallback id (else a timer id)
    this._warmEntry = null;       // the queue entry the dry builds use
    this._onWarm = null;

    // pre-rendered instances (round 5): render jobs run as warm items after the dry builds
    this._preJobs = null;         // [{ st | pad chord, at index, n, variant, slot, span, lead, channels }], created in init
    this._preReady = 0;           // buffers rendered so far (diagnostics)
    this._padBufs = null;         // MUSIC.chords index → rendered pad chord buffer (null until rendered / without prerender)
    this._rendering = false;      // a render build is running: the swapped OfflineAudioContext, rate 1, local randomness
    this._renderDest = null;      // the offline destination the render build ends in
    this._layerShiftS = 0;        // the render's trimmed lead (s): layer starts move this much earlier

    // deferred delayed cues (round 4): built DEFER_LEAD_S before their start time
    this._deferred = null;        // DEFER_CAPACITY queue entries
    this._deferCount = 0;

    // unlock / lifecycle state
    this._needsGesture = false;
    this._unlockedEmitted = false;
    this._hiddenSuspend = false;
    this._visTimer = 0;
    this._interval = 0;
    this._visListening = false;

    // mix state (settings / M key / pause / slow-mo)
    this._muted = false;
    this._sound = 100;
    this._music = 70;             // round 5 (lead decision): save's default music fader is 70 (was 80)
    // seeded with 0.5 first: Double fields from the start (round-2 cross-group, FX-14 item 2 — the first slow-mo
    // used to deprecate AudioSystem's map mid-play)
    this._holdDb = 0.5; this._holdDb = 0;
    this._timeScale = 0.5; this._timeScale = 1;
    this._rate = 0.5; this._rate = 1;
    this._rateCents = 0.5; this._rateCents = 0;
    this._nomusic = false;

    // cue state
    this._cueStates = null;
    this._queue = null;
    this._qHead = 0;
    this._qCount = 0;
    this._voices = null;
    this._voiceCursor = 0;
    this._gunLastMs = -1e9;
    this._rewardLastMs = -1e9;    // last reward-bus moment (_rewardVolume, round 4)
    this._keyIds = null;
    this._keyMs = null;
    this._keyUsed = null;
    this._gateHits = null;        // Float32Array(GATE_SLOT_MASK + 1): weighted hits per gate slot (x / ÷ tick pitch)
    this._stings = null;
    this._tickSlot = -1;
    this._rand = null;

    // music scheduler state
    this._wantMode = 'none';
    this._activeMode = 'none';
    this._musicOn = false;
    this._fadingOut = false;
    this._stopAt = 0;
    this._step = 0;
    this._nextT = 0;
    this._restartReq = false;     // the next scheduler pass restarts the loop at bar 0 (level:start / boss:fight / title)
    this._pendingStopT = 0.5; this._pendingStopT = 0;       // boss death: the loop fades to 'none' at this context time (MUSIC.duck.bossDead)
    this._duckStuck = false;      // the boss-death duck is held (no scheduled release) until the music restarts
    this._droneVoice = null;
    this._droneGain = null;
    this._droneOsc = null;
    this._droneLfo = null;
    this._droneLfoGain = null;    // LFO depth gain (faded with the drone in _stopDrone)

    // bound handlers (created in init)
    this._unsubs = null;
    this._onAcState = null;
    this._onResumeOk = null;
    this._onVisibility = null;
    this._onVisibleCheck = null;
    this._onSchedulerTick = null;
  }

  /** Allocates every pool, subscribes to the gameplay events and builds the AudioContext + graph (boot step 7,
   *  behind the boot bar; 'suspended' until a gesture). Installs no gesture listener (that belongs to engine). */
  init() {
    const ctx = this._ctx;

    // settings (save §12) and URL params (?nomusic=1)
    const save = ctx.save;
    let settings = null;
    try { settings = save ? (save.settings || (save.data && save.data.settings) || null) : null; } catch (_) { settings = null; }
    if (settings) {
      this._sound = clamp(num(settings.sound, 100), 0, 100);
      this._music = clamp(num(settings.music, 70), 0, 100);
    }
    this._nomusic = !!(ctx.config && ctx.config.nomusic);

    // per-cue state
    this._cueStates = {};
    for (const name in AUDIO_CUES) this._cueStates[name] = makeCueState(name);
    this._preJobs = [];
    for (const name in AUDIO_CUES) {
      const st = this._cueStates[name];
      const plan = makePrePlan(st.recipe);
      if (plan === null) continue;
      st.pre = plan;
      const vc = st.recipe.voices;
      for (let a = 0; a < plan.atN; a++) {
        for (let n = 1; n <= plan.nMax; n++) {
          for (let k = 0; k < plan.varN[n - 1]; k++) {
            this._preJobs.push({ st, pad: null, bars: null, a, n, count: vc ? n * vc.perN : 0, slot: (a * plan.nMax + n - 1) * plan.variants + k,
              span: plan.span[a], lead: plan.lead[a], channels: plan.channels });
          }
        }
      }
    }
    // the pad chords (MUSIC.instruments.pad.prerender): one job per distinct chord, its buffer shared by every bar that plays it
    const padInst = MUSIC.instruments.pad;
    if (padInst && padInst.prerender) {
      const chords = MUSIC.chords;
      this._padBufs = new Array(chords.length);
      const seen = {};
      for (let b = 0; b < chords.length; b++) {
        this._padBufs[b] = null;
        const key = chords[b].join(',');
        if (seen[key] !== undefined) { seen[key].bars.push(b); continue; }
        const job = { st: null, pad: chords[b], bars: [b], a: 0, n: 1, count: 0, slot: 0,
          span: STEPS_PER_BAR * STEP_S + (padInst.releaseMs || DEFAULT_ATTACK_MS) / 1000 + PRE_TAIL_S, lead: 0, channels: 1 };
        seen[key] = job;
        this._preJobs.push(job);
      }
    }

    // queue + live voices (allocated once, at the full capacity)
    this._queue = new Array(QUEUE_CAPACITY);
    for (let i = 0; i < QUEUE_CAPACITY; i++) this._queue[i] = makeQueueEntry();
    this._deferred = new Array(DEFER_CAPACITY);
    for (let i = 0; i < DEFER_CAPACITY; i++) this._deferred[i] = makeQueueEntry();
    this._warmEntry = makeQueueEntry();
    this._warmNames = Object.keys(AUDIO_CUES);
    const m = measureCues();
    this._voices = new Array(LIVE_CAPACITY);
    for (let i = 0; i < LIVE_CAPACITY; i++) this._voices[i] = makeVoice(m.maxNodes, m.maxSrcs);

    // per-gate tick coalescing table
    this._keyIds = new Float64Array(KEY_SLOTS);
    this._keyMs = new Float64Array(KEY_SLOTS);
    this._keyUsed = new Uint8Array(KEY_SLOTS);
    // per-gate cumulative weighted hits (x / ÷ tick pitch climbs with the ring progress, J3)
    this._gateHits = new Float32Array(GATE_SLOT_MASK + 1);

    // weapon id → sting cue (WEAPONS[*].sting)
    this._stings = {};
    for (const k in WEAPONS) {
      const w = WEAPONS[k];
      if (w && w.id && w.sting && AUDIO_CUES[w.sting]) this._stings[w.id] = w.sting;
    }

    // fallback cosmetic randomness before ctx.rngFx exists (boot) — never Math.random
    this._rand = mulberry32(NOISE_SEED ^ 0x2545F491);

    // bound handlers (one closure each, created once)
    this._onAcState = () => this._acStateChanged();
    this._onResumeOk = () => this._checkRunning();
    this._onVisibility = () => this._visibilityChanged();
    this._onVisibleCheck = () => this._visibleCheck();
    this._onSchedulerTick = () => this._schedulerTick();
    this._onWarm = (deadline) => this._warmTick(deadline);

    this._subscribe();
    // AUD-8: the context (≈ 0.8–1 s on some Windows Chrome builds) and the graph are built here, never in the first tap.
    // A failure at boot is retried once inside a gesture (unlock()).
    this._createContext(false);
    return this;
  }

  /** Clears queued cues, coalescing windows and the power-up countdown. Idempotent, allocation-free.
   *  Music and the mix are untouched (they follow setMusic / duck / settings). */
  reset() {
    this._clearQueue();
    this._resetRunState();
  }

  /** Coalescing windows, ladder, limiter clocks and the countdown slot (level:start). Queued cues are
   *  kept: the PLAY button's ui_tap shares the frame with level:start. */
  _resetRunState() {
    if (this._keyUsed) this._keyUsed.fill(0);
    if (this._gateHits) this._gateHits.fill(0);
    this._tickSlot = -1;
    this._gunLastMs = -1e9;
    this._rewardLastMs = -1e9;
    const states = this._cueStates;
    if (states) {
      for (const name in states) {
        const st = states[name];
        st.lastLimitMs = -1e9; st.lastPlayMs = -1e9; st.ladderStep = 0;
        st.frameMs = -1; st.frameCount = 0;
        st.liveGain = null; st.liveGainBase = 0; st.liveStack = 0;
      }
    }
  }

  /** Removes every listener (events, statechange, visibilitychange), stops the scheduler, releases
   *  every node and closes the context. */
  dispose() {
    this._disposed = true;
    const unsubs = this._unsubs;
    if (unsubs) {
      for (let i = 0; i < unsubs.length; i++) { try { unsubs[i](); } catch (_) { /* ignore */ } }
      unsubs.length = 0;
    }
    if (this._interval) { try { clearInterval(this._interval); } catch (_) { /* ignore */ } this._interval = 0; }
    if (this._visTimer) { try { clearTimeout(this._visTimer); } catch (_) { /* ignore */ } this._visTimer = 0; }
    this._cancelWarm();
    if (this._visListening) {
      try { document.removeEventListener('visibilitychange', this._onVisibility, false); } catch (_) { /* ignore */ }
      this._visListening = false;
    }
    const ac = this._ac;
    if (ac) {
      try {
        if (typeof ac.removeEventListener === 'function') ac.removeEventListener('statechange', this._onAcState);
        else ac.onstatechange = null;
      } catch (_) { /* ignore */ }
      this._stopDroneNow();
      if (this._voices) for (let i = 0; i < this._voices.length; i++) if (this._voices[i].active) this._releaseVoice(this._voices[i]);
      try { const p = ac.close(); if (p && typeof p.catch === 'function') p.catch(noop); } catch (_) { /* ignore */ }
    }
    this._clearQueue();
    this._ac = null;
    this._musicOn = false;
    this._fadingOut = false;
  }

  // -------------------------------------------------------------------------------------------
  // Public getters
  // -------------------------------------------------------------------------------------------

  /** True while the AudioContext exists and is running (cues are dropped otherwise). */
  get unlocked() { return this._ac !== null && this._ac.state === 'running'; }

  /** True after the context lost its running state to the OS (iOS call / Siri) or failed to resume
   *  after the tab became visible; engine polls it every frame and re-arms its gesture listeners. */
  get needsGesture() { return this._needsGesture; }

  /** Current music mode requested by setMusic (diagnostics). */
  get musicMode() { return this._wantMode; }

  // -------------------------------------------------------------------------------------------
  // Unlock (§6.2 / §6.13): called synchronously from engine's capture gesture listeners
  // -------------------------------------------------------------------------------------------

  unlock() {
    if (this._disposed) return;
    if (this._ac === null) {
      if (this._failed) return;
      this._createContext(true);   // lazy fallback: construction failed at boot
      if (this._ac === null) return;
    }
    const ac = this._ac;
    if (ac.state === 'closed') return;
    if (ac.state !== 'running') this._primeSilent();
    try {
      const p = ac.resume();
      if (p && typeof p.then === 'function') p.then(this._onResumeOk, noop);
    } catch (_) { /* resume unsupported / rejected synchronously */ }
    this._checkRunning();
  }

  /** Creates the context and the whole graph once (boot; `inGesture` = the lazy retry from unlock()). A failure at
   *  boot leaves the retry to the first gesture; a failure inside a gesture leaves audio permanently silent. */
  _createContext(inGesture) {
    let AC = null;
    try {
      if (typeof window !== 'undefined') AC = window.AudioContext || window.webkitAudioContext || null;
    } catch (_) { AC = null; }
    if (!AC) {
      this._failed = true;
      warnOnce('audio.noContext', 'WebAudio is unavailable; the game runs silent.');
      return;
    }
    let ac = null;
    try { ac = new AC({ latencyHint: 'interactive' }); } catch (_) {
      try { ac = new AC(); } catch (__) { ac = null; }
    }
    if (!ac) {
      if (inGesture) {
        this._failed = true;
        warnOnce('audio.noContext', 'AudioContext could not be created; the game runs silent.');
      }
      return;
    }
    try {
      this._buildGraph(ac);
    } catch (e) {
      if (inGesture) {
        this._failed = true;
        warnOnce('audio.graph', 'Audio graph setup failed: ' + (e && e.message ? e.message : e));
      }
      try { const p = ac.close(); if (p && typeof p.catch === 'function') p.catch(noop); } catch (_) { /* ignore */ }
      return;
    }
    this._ac = ac;

    try {
      if (typeof ac.addEventListener === 'function') ac.addEventListener('statechange', this._onAcState);
      else ac.onstatechange = this._onAcState;
    } catch (_) { /* no statechange: the resume promise still detects 'running' */ }

    try {
      if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', this._onVisibility, false);
        this._visListening = true;
      }
    } catch (_) { this._visListening = false; }

    // round 4: warm every oscillator type and every cue recipe in idle slices (boot, behind the bar; or right after a lazy
    // construction inside the first gesture), so no gameplay frame pays a first use
    this._warmIdx = 0;
    this._warmLeft = OSC_TYPES.length + this._warmNames.length + this._preJobs.length;
    this._scheduleWarm();
    // the scheduler interval starts with the first 'running' (_checkRunning); a context the autoplay policy lets
    // run at construction reports it through statechange (or update()'s poll)
  }

  /** Buses → compressor → bed duck → limiter (+ the reward bus) → master → destination; noise buffers; shaper curves. */
  _buildGraph(ac) {
    const now = ac.currentTime;

    const master = ac.createGain();
    master.gain.setValueAtTime(this._muted ? 0 : 1, now);
    master.connect(ac.destination);

    // safety limiter (AUD-5): fast 20:1 compressor at −1 dB, then a soft clip whose ceiling is < 0 dBFS
    const L = MUSIC.limiter;
    const clip = ac.createWaveShaper();
    clip.curve = makeClipCurve(L.clip.linear, L.clip.ceiling);
    clip.oversample = 'none';
    clip.connect(master);
    const lim = ac.createDynamicsCompressor();
    lim.threshold.setValueAtTime(L.threshold, now);
    lim.knee.setValueAtTime(L.knee, now);
    lim.ratio.setValueAtTime(L.ratio, now);
    lim.attack.setValueAtTime(L.attack, now);
    lim.release.setValueAtTime(L.release, now);
    lim.connect(clip);

    // reward bus (round 3, AUD-10): cues with bus 'reward' (pass_up, hup) skip the bus compressor and meet the compressed
    // bed at the limiter, so the 6:1 ratio no longer pins the gate-pass reward to the gunfire's level
    const reward = ac.createGain();
    reward.gain.setValueAtTime(dbToGain(MUSIC.buses.reward) * rewardFaderGain(this._sound, this._music, !this._nomusic), now);
    reward.connect(lim);

    // bed duck (round 3, AUD-10): the compressed mix dips MUSIC.duck.bedOnReward under the reward (after the compressor,
    // so the makeup gain cannot undo it)
    const bedDuck = ac.createGain();
    bedDuck.gain.setValueAtTime(1, now);
    bedDuck.connect(lim);

    // bus compressor (MUSIC.compressor; the knee must be set: Chrome's 30 dB default makes it ≈ 1.1:1)
    const C = MUSIC.compressor;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.setValueAtTime(C.threshold, now);
    comp.knee.setValueAtTime(C.knee, now);
    comp.ratio.setValueAtTime(C.ratio, now);
    comp.attack.setValueAtTime(C.attack, now);
    comp.release.setValueAtTime(C.release, now);
    comp.connect(bedDuck);

    const sfx = ac.createGain();
    sfx.gain.setValueAtTime(dbToGain(MUSIC.buses.sfx) * faderGain(this._sound), now);
    sfx.connect(comp);

    const gunDuck = ac.createGain();
    gunDuck.gain.setValueAtTime(1, now);
    gunDuck.connect(comp);
    const gun = ac.createGain();
    gun.gain.setValueAtTime(dbToGain(MUSIC.buses.gun) * faderGain(this._sound), now);
    gun.connect(gunDuck);

    const fade = ac.createGain();
    fade.gain.setValueAtTime(0, now);
    fade.connect(comp);
    const duckTr = ac.createGain();
    duckTr.gain.setValueAtTime(1, now);
    duckTr.connect(fade);
    const duckHold = ac.createGain();
    duckHold.gain.setValueAtTime(dbToGain(this._holdDb), now);
    duckHold.connect(duckTr);
    const music = ac.createGain();
    music.gain.setValueAtTime(dbToGain(MUSIC.buses.music) * faderGain(this._music), now);
    music.connect(duckHold);

    this._buffers = renderNoiseBuffers(ac);
    this._silent = ac.createBuffer(1, 1, ac.sampleRate);

    // one curve per distinct shaper drive used by the recipes, and one (initially empty) WaveShaper pool per drive
    this._curves = new Map();
    this._shaperPools = new Map();
    for (const name in AUDIO_CUES) {
      const layers = AUDIO_CUES[name].layers;
      for (let i = 0; i < layers.length; i++) {
        const d = layers[i].shaper;
        if (typeof d === 'number' && d > 0 && !this._curves.has(d)) {
          this._curves.set(d, makeShaperCurve(d));
          const nodes = new Array(SHAPER_POOL_MAX);
          for (let k = 0; k < SHAPER_POOL_MAX; k++) nodes[k] = null;
          this._shaperPools.set(d, { n: 0, nodes });
        }
      }
    }

    // the warm-up's dry builds end here; never connected, so nothing of them is rendered or heard
    this._warmSink = ac.createGain();

    this._hasPanner = typeof ac.createStereoPanner === 'function';

    this._master = master;
    this._comp = comp;
    this._limiter = lim;
    this._clip = clip;
    this._sfxBus = sfx;
    this._gunBus = gun;
    this._gunDuck = gunDuck;
    this._rewardBus = reward;
    this._bedDuck = bedDuck;
    this._musicBus = music;
    this._duckHold = duckHold;
    this._duckTr = duckTr;
    this._musicFade = fade;
  }

  /** Old iOS only unlocks output when a source starts inside the gesture: a 1-sample silent buffer. */
  _primeSilent() {
    const ac = this._ac;
    if (!ac || !this._silent) return;
    try {
      const s = ac.createBufferSource();
      s.buffer = this._silent;
      s.connect(ac.destination);
      s.start(0);
    } catch (_) { /* ignore */ }
  }

  // -------------------------------------------------------------------------------------------
  // First-use warm-up (round 4; MUSIC.warm): idle slices right after the graph is built
  // -------------------------------------------------------------------------------------------

  /** Queues the next warm slice: an idle callback (deadline-driven, MUSIC.warm.timeoutMs at the latest), else a timer. */
  _scheduleWarm() {
    if (this._warmHandle || this._warmLeft <= 0 || this._disposed) return;
    try {
      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        this._warmHandle = window.requestIdleCallback(this._onWarm, WARM_IDLE_OPTS);
        this._warmIdle = true;
        return;
      }
    } catch (_) { /* fall through to the timer */ }
    try {
      this._warmHandle = setTimeout(this._onWarm, WARM_TIMER_MS);
      this._warmIdle = false;
    } catch (_) {
      this._warmHandle = 0;
      this._warmLeft = 0;     // no scheduler at all: the cues warm themselves on first use, as before round 4
    }
  }

  _cancelWarm() {
    const h = this._warmHandle;
    this._warmHandle = 0;
    this._warmLeft = 0;
    if (!h) return;
    try {
      if (this._warmIdle) window.cancelIdleCallback(h);
      else clearTimeout(h);
    } catch (_) { /* ignore */ }
  }

  /** One warm slice: at least one item, more while the idle deadline has more than MUSIC.warm.idleMinMs left. */
  _warmTick(deadline) {
    this._warmHandle = 0;
    if (this._disposed || this._ac === null) return;
    let n = 0;
    while (this._warmLeft > 0) {
      if (n > 0 && !(deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() > WARM_IDLE_MIN_MS)) break;
      this._warmItem();
      n++;
    }
    if (this._warmLeft > 0) this._scheduleWarm();
  }

  /** Warm item i: an oscillator of OSC_TYPES[i] (the context caches that type's wave tables), then a dry build of each
   *  AUDIO_CUES recipe — every node of the cue (the full chorus, the panner, pooled WaveShapers) created, scheduled and
   *  connected into the unconnected _warmSink, no source started — released at once. Nothing is rendered or heard. */
  _warmItem() {
    const ac = this._ac;
    const i = this._warmIdx++;
    this._warmLeft--;
    if (ac === null) return;
    const nt = OSC_TYPES.length;
    if (i < nt) {
      try { const o = ac.createOscillator(); o.type = OSC_TYPES[i]; } catch (_) { /* ignore */ }
      return;
    }
    const nc = nt + this._warmNames.length;
    if (i >= nc) { this._renderJob(this._preJobs[i - nc]); return; }
    const st = this._cueStates[this._warmNames[i - nt]];
    if (st === undefined) return;
    const vc = st.recipe.voices;
    const e = this._warmEntry;
    e.name = st.name; e.st = st; e.volume = 1; e.pitch = 1; e.hasPos = true; e.x = 0; e.z = 0; e.detune = 0;
    e.count = vc ? vc.max * vc.perN : 0; e.value = 0; e.delayMs = 0; e.stretch = 1; e.stack = 0; e.at = 0;
    this._warming = true;
    let v = null;
    try { v = this._startCue(e, st, ac.currentTime + START_LATENCY_S); } catch (_) { v = null; }
    this._warming = false;
    e.st = null;
    if (v !== null) this._releaseVoice(v);
  }

  /**
   * Round 5: renders one pre-render job (a cue instance, or a pad chord) into its own OfflineAudioContext through THIS interpreter
   * (_startCue / _musicNote with the context, the destination and the rate swapped for the synchronous build, restored right after),
   * then stores the rendered buffer when the browser finishes it (off the main thread). Cue renders run at volume 1, unpanned (the
   * play's cue gain and panner come after the buffer, as after the layer chains); pad chords at gain 1 per chord (the mode's pad
   * level is the play's envelope gain). Boot / first-gesture warm-up only (allocates its closure). Nothing reaches the live graph.
   */
  _renderJob(job) {
    const live = this._ac;
    const OAC = offlineContextCtor();
    if (live === null || OAC === null || job === undefined || this._disposed) return;
    const sr = live.sampleRate;
    let off = null;
    try { off = new OAC(job.channels, Math.max(1, Math.ceil(job.span * sr)), sr); } catch (_) { off = null; }
    if (off === null) return;
    const saveMusic = this._musicBus, saveRate = this._rate, saveCents = this._rateCents;
    let built = false;
    this._ac = off; this._rate = 1; this._rateCents = 0;
    this._rendering = true; this._renderDest = off.destination; this._layerShiftS = job.lead;
    try {
      if (job.pad !== null) {
        const pad = MUSIC.instruments.pad;
        const nv = pad.voices || 1;
        this._musicBus = off.destination;
        for (let c = 0; c < job.pad.length; c++) {
          const f = midiHz(job.pad[c]);
          for (let k = 0; k < nv; k++) {
            const det = nv > 1 ? pad.detuneCents * ((2 * k) / (nv - 1) - 1) : 0;
            const v = this._musicNote(pad, f, 0, STEPS_PER_BAR * STEP_S, 1, 1 / nv, det);
            if (v !== null) { built = true; this._forgetVoice(v); }
          }
        }
      } else {
        const st = job.st;
        const e = this._warmEntry;
        e.name = st.name; e.st = st; e.volume = 1; e.pitch = st.pre.pitch[job.a]; e.hasPos = false; e.x = 0; e.z = 0; e.detune = 0;
        e.count = job.count; e.value = 0; e.delayMs = 0; e.stretch = st.pre.stretch[job.a]; e.stack = 0; e.at = 0;
        const v = this._startCue(e, st, 0);
        e.st = null;
        if (v !== null) { built = true; this._forgetVoice(v); }
      }
    } catch (_) {
      built = false;
    } finally {
      this._ac = live; this._musicBus = saveMusic; this._rate = saveRate; this._rateCents = saveCents;
      this._rendering = false; this._renderDest = null; this._layerShiftS = 0;
    }
    if (!built) return;
    const done = (buf) => {
      if (this._disposed || !buf) return;
      if (job.pad !== null) {
        if (this._padBufs[job.bars[0]] !== null) return;          // oncomplete and the promise both report
        for (let i = 0; i < job.bars.length; i++) this._padBufs[job.bars[i]] = buf;
      } else if (job.st.pre.bufs[job.slot] === null) {
        job.st.pre.bufs[job.slot] = buf;
      } else return;
      this._preReady++;
    };
    try {
      off.oncomplete = (ev) => done(ev ? ev.renderedBuffer : null);       // old WebKit: event only
      const p = off.startRendering();
      if (p && typeof p.then === 'function') p.then(done, noop);
    } catch (_) { /* this instance stays live-synthesised */ }
  }

  /** Drops a voice record built for a render without disconnecting its (offline) nodes: the offline graph renders on. */
  _forgetVoice(v) {
    for (let i = 0; i < v.nodeCount; i++) { v.nodes[i] = null; v.nodeDrive[i] = 0; }
    for (let i = 0; i < v.srcCount; i++) v.srcs[i] = null;
    v.nodeCount = 0; v.srcCount = 0; v.cueGain = null; v.cueState = null; v.env = null; v.fixedRate = false; v.active = false;
  }

  /** Emits audio:unlocked once per transition into 'running' and clears needsGesture. */
  _checkRunning() {
    const ac = this._ac;
    if (!ac || ac.state !== 'running') return;
    this._needsGesture = false;
    if (!this._interval && !this._disposed) {
      try { this._interval = setInterval(this._onSchedulerTick, MUSIC.schedulerMs); } catch (_) { this._interval = 0; }
    }
    if (!this._unlockedEmitted) {
      this._unlockedEmitted = true;
      const events = this._ctx.events;
      if (events) events.emit('audio:unlocked', UNLOCKED_PAYLOAD);
      this._schedulerTick();   // start the requested music right away
    }
  }

  _acStateChanged() {
    const ac = this._ac;
    if (!ac) return;
    const s = ac.state;
    if (s === 'running') {
      this._checkRunning();
    } else if (s === 'suspended' || s === 'interrupted') {
      if (this._hiddenSuspend) return;               // our own suspend for a hidden tab
      if (this._unlockedEmitted) {
        this._unlockedEmitted = false;
        this._needsGesture = true;                   // engine re-arms its gesture listeners
      }
      this._clearQueue();
    }
  }

  _visibilityChanged() {
    const ac = this._ac;
    if (!ac) return;
    let hidden = false;
    try { hidden = document.visibilityState === 'hidden'; } catch (_) { hidden = false; }
    if (hidden) {
      if (this._visTimer) { try { clearTimeout(this._visTimer); } catch (_) { /* ignore */ } this._visTimer = 0; }
      if (ac.state === 'running') {
        this._hiddenSuspend = true;
        try { const p = ac.suspend(); if (p && typeof p.catch === 'function') p.catch(noop); } catch (_) { /* ignore */ }
      }
      this._clearQueue();
      return;
    }
    if (!this._hiddenSuspend) return;
    try {
      const p = ac.resume();
      if (p && typeof p.then === 'function') p.then(this._onResumeOk, noop);
    } catch (_) { /* ignore */ }
    if (this._visTimer) { try { clearTimeout(this._visTimer); } catch (_) { /* ignore */ } }
    try { this._visTimer = setTimeout(this._onVisibleCheck, VISIBILITY_RESUME_MS); } catch (_) { this._visTimer = 0; this._visibleCheck(); }
  }

  /** 500 ms after the tab became visible: still not running → wait for a gesture. */
  _visibleCheck() {
    this._visTimer = 0;
    this._hiddenSuspend = false;
    const ac = this._ac;
    if (!ac) return;
    if (ac.state === 'running') {
      this._checkRunning();
    } else if (ac.state !== 'closed') {
      this._unlockedEmitted = false;
      this._needsGesture = true;
    }
  }

  // -------------------------------------------------------------------------------------------
  // play(): admission (limiters, coalescing, ladder) at event time; nodes are built in update()
  // -------------------------------------------------------------------------------------------

  /**
   * Fire-and-forget cue. Silently dropped before unlock, while suspended/muted or with the sound
   * fader at 0. opts: { volume = 1, pitch = 1, pos?:{x,z}, detune?:cents, count?, value? } (+ internal
   * key/keyed for per-gate coalescing, delayMs for a scheduled start, stretch for a tape-slow cue).
   */
  play(name, opts) {
    const ac = this._ac;
    if (ac === null || ac.state !== 'running' || this._muted) return;
    const states = this._cueStates;
    const st = states ? states[name] : undefined;
    if (st === undefined) {
      warnOnce('audio.cue.' + name, 'unknown audio cue ' + name);
      return;
    }
    const cue = st.recipe;
    if (this._sound <= 0) return;                           // sfx + gun buses share the sound fader

    // read options (defaults per the §6.13 signature)
    let volume = 1, pitch = 1, detune = 0, count = 0, value = 0, delayMs = 0, stretch = 1;
    let hasPos = false, px = 0, pz = 0, keyed = false, key = 0;
    if (opts) {
      volume = num(opts.volume, 1);
      pitch = num(opts.pitch, 1);
      detune = num(opts.detune, 0);
      count = num(opts.count, 0);
      value = num(opts.value, 0);
      delayMs = num(opts.delayMs, 0);
      stretch = num(opts.stretch, 1);
      const pos = opts.pos;
      if (pos) { hasPos = true; px = num(pos.x, 0); pz = num(pos.z, 0); }
      if (opts.keyed === true) { keyed = true; key = num(opts.key, 0); }
    }
    if (volume <= 0 || pitch <= 0) return;
    if (stretch <= 0) stretch = 1;

    const nowMs = this._nowMs();

    // coalesceMs (+ stackDb): one instance per window per key (tick: per gate; crunch: global)
    const coalesce = cue.coalesceMs;
    if (coalesce) {
      if (keyed) {
        if (!this._admitKey(key, nowMs, coalesce)) return;
      } else if (nowMs - st.lastPlayMs < coalesce) {
        if (cue.stackDb) this._stack(st, cue.stackDb);
        return;
      }
    }

    // maxPerSec voice limiter: evenly spaced starts, ≤ maxPerSec in any second
    if (cue.maxPerSec && nowMs - st.lastLimitMs < 1000 / cue.maxPerSec) return;
    // gun bus limiter (MUSIC.gunVoices voiced starts per second across the bus)
    const gun = cue.bus === 'gun';
    if (gun && nowMs - this._gunLastMs < 1000 / MUSIC.gunVoices) return;

    // same-frame cap (cues without maxPerSec / coalesce): a burst of identical events plays at most SAME_FRAME_MAX
    // copies, each extra copy decorrelated (offset start + pitch jitter) so they never sum phase-coherently (AUD-6)
    if (!coalesce && !cue.maxPerSec) {
      if (st.frameMs === nowMs) {
        if (st.frameCount >= SAME_FRAME_MAX) return;
        st.frameCount++;
        delayMs += DUP_OFFSET_MIN_MS * (st.frameCount - 1) + this._rnd() * DUP_OFFSET_SPAN_MS;
        pitch *= 1 + DUP_JITTER * (this._rnd() * 2 - 1);
      } else {
        st.frameMs = nowMs;
        st.frameCount = 1;
      }
    }

    // queue slot (a full queue drops the newest request)
    if (this._qCount >= QUEUE_CAPACITY) { this._dropped(); return; }

    // admitted: commit limiter / ladder state
    if (cue.maxPerSec) st.lastLimitMs = nowMs;
    if (gun) this._gunLastMs = nowMs;
    if (cue.ladder) {
      if (nowMs - st.lastPlayMs <= cue.ladder.windowMs) {
        st.ladderStep = st.ladderStep < LADDER_MAX_STEPS ? st.ladderStep + 1 : LADDER_MAX_STEPS;
      } else {
        st.ladderStep = 0;
      }
      if (st.ladderStep > 0) pitch *= Math.pow(2, st.ladderStep * cue.ladder.semitones / 12);
    }
    st.lastPlayMs = nowMs;

    const e = this._queue[(this._qHead + this._qCount) % QUEUE_CAPACITY];
    this._qCount++;
    e.name = name;
    e.st = st;
    e.volume = volume;
    e.pitch = pitch;
    e.hasPos = hasPos;
    e.x = px;
    e.z = pz;
    e.detune = detune;
    e.count = count;
    e.value = value;
    e.delayMs = delayMs > 0 ? delayMs : 0;
    e.stretch = stretch;
    e.stack = 0;
    if (cue.stackDb) {
      st.pendingEntry = e;
      st.liveStack = 0;
    }
  }

  /** stackDb: a coalesced extra instance adds `per` dB to the pending or the live instance (capped). */
  _stack(st, stackDb) {
    const maxStack = stackDb.per > 0 ? Math.floor(stackDb.cap / stackDb.per) : 0;
    const pending = st.pendingEntry;
    if (pending !== null) {
      if (pending.stack < maxStack) pending.stack++;
      return;
    }
    const g = st.liveGain;
    const ac = this._ac;
    if (g === null || ac === null || st.liveStack >= maxStack) return;
    st.liveStack++;
    try {
      glideParam(g.gain, st.liveGainBase * dbToGain(Math.min(stackDb.cap, st.liveStack * stackDb.per)), ac.currentTime, PARAM_SMOOTH_S * 0.25);
    } catch (_) { /* node already released */ }
  }

  /** Per-key coalescing table (tick per gate id). Returns false while the key's window is open. */
  _admitKey(key, nowMs, windowMs) {
    const ids = this._keyIds, ms = this._keyMs, used = this._keyUsed;
    let oldest = 0;
    let oldestMs = Infinity;
    for (let i = 0; i < KEY_SLOTS; i++) {
      if (used[i] === 1 && ids[i] === key) {
        if (nowMs - ms[i] < windowMs) return false;
        ms[i] = nowMs;
        return true;
      }
      const t = used[i] === 1 ? ms[i] : -Infinity;
      if (t < oldestMs) { oldestMs = t; oldest = i; }
    }
    used[oldest] = 1;
    ids[oldest] = key;
    ms[oldest] = nowMs;
    return true;
  }

  _nowMs() {
    const t = this._ctx.time;
    return t && typeof t.now === 'number' ? t.now : hostNowMs();
  }

  _rnd() {
    if (this._warming || this._rendering) return this._rand();   // dry builds / renders never advance the shared cosmetic stream
    const r = this._ctx.rngFx;
    return r && typeof r.next === 'function' ? r.next() : this._rand();
  }

  _dropped() {
    const d = this._ctx.debug;
    if (d && d.dropped) d.dropped.audio = (d.dropped.audio | 0) + 1;
  }

  _clearQueue() {
    const q = this._queue;
    if (q) {
      for (let i = 0; i < this._qCount; i++) {
        const e = q[(this._qHead + i) % QUEUE_CAPACITY];
        if (e.st !== null && e.st.pendingEntry === e) e.st.pendingEntry = null;
        e.st = null;
      }
    }
    this._qHead = 0;
    this._qCount = 0;
    const d = this._deferred;
    if (d) {
      for (let i = 0; i < this._deferCount; i++) {
        const e = d[i];
        if (e.st !== null && e.st.pendingEntry === e) e.st.pendingEntry = null;
        e.st = null;
      }
    }
    this._deferCount = 0;
  }

  // -------------------------------------------------------------------------------------------
  // update(): frame step G
  // -------------------------------------------------------------------------------------------

  /** Starts the queued cues on AudioContext.currentTime, polls the power-up countdown (J14) and
   *  releases finished voices. Allocation-free apart from the WebAudio nodes a starting cue needs.
   *  @param {number} unscaledDt frame dt (unused: every timing runs on the audio clock) */
  update(unscaledDt) {
    const ac = this._ac;
    if (ac === null || unscaledDt < 0) return;
    if (ac.state !== 'running') {
      if (this._qCount > 0) this._clearQueue();
      return;
    }
    // a context the autoplay policy let run at construction (boot) without a statechange reaching us yet
    if (!this._unlockedEmitted && !this._hiddenSuspend) this._checkRunning();
    const now = ac.currentTime;
    const t0 = now + START_LATENCY_S;
    let started = 0;
    const q = this._queue;
    while (this._qCount > 0 && started < STARTS_PER_UPDATE) {
      const e = q[this._qHead];
      this._qHead = (this._qHead + 1) % QUEUE_CAPACITY;
      this._qCount--;
      const st = e.st;
      e.st = null;
      if (st === null) continue;
      const delayS = e.delayMs / 1000;
      // round 4: a cue that starts deferMinMs or more from now is built DEFER_LEAD_S before its start (the fanfare 0.9 s after
      // the boss-death roar no longer shares the roar's frame); its start time stays exact on the audio clock
      if (delayS >= DEFER_MIN_S && this._deferCount < DEFER_CAPACITY) {
        const d = this._deferred[this._deferCount++];
        copyEntry(d, e);
        d.st = st;
        d.at = t0 + delayS;
        if (st.pendingEntry === e) st.pendingEntry = d;   // coalesced duplicates keep stacking on it until it starts
        continue;
      }
      if (st.pendingEntry === e) st.pendingEntry = null;
      this._startCue(e, st, t0 + delayS);
      started++;
    }
    if (this._deferCount > 0) this._startDeferred(now, t0);
    this._pollTicktock();
    this._sweepVoices(now);
  }

  /** Builds the deferred cues whose start time is within DEFER_LEAD_S; a late frame starts them at t0 at the latest. */
  _startDeferred(now, t0) {
    const d = this._deferred;
    let i = 0;
    while (i < this._deferCount) {
      const e = d[i];
      if (e.at - now > DEFER_LEAD_S) { i++; continue; }
      const st = e.st;
      // swap-remove: the last entry moves into slot i (its fields are copied, so the pending pointer follows it)
      const last = --this._deferCount;
      if (st !== null) {
        if (st.pendingEntry === e) st.pendingEntry = null;
        this._startCue(e, st, e.at > t0 ? e.at : t0);
      }
      e.st = null;
      if (i !== last) {
        const m = d[last];
        copyEntry(e, m);
        if (m.st !== null && m.st.pendingEntry === m) m.st.pendingEntry = e;
        m.st = null;
      }
    }
  }

  /** J14: `ticktock` every AUDIO_CUES.ticktock.repeatMs during the last JUICE.powerup.pillBlinkLast s of
   *  the weapon or a finite gear timer (chip / booster), polled from weapons; Infinity gear never ticks. */
  _pollTicktock() {
    const ctx = this._ctx;
    const state = ctx.state;
    const w = ctx.weapons;
    if (!state || !w || !state.is('playing')) { this._tickSlot = -1; return; }
    let left = Infinity;
    const wt = w.weaponTimeLeft;
    if (wt > 0 && wt < left) left = wt;
    const gear = w.gear;
    if (gear) {
      const c = gear[CHIP_ID];
      if (c > 0 && c < left) left = c;
      const b = gear[BOOSTER_ID];
      if (b > 0 && b < left) left = b;
    }
    if (left > 0 && left <= TICK_WINDOW_S) {
      const slot = Math.ceil(left / TICK_PERIOD_S);
      if (slot !== this._tickSlot) {
        this._tickSlot = slot;
        this.play('ticktock', resetOpts());
      }
    } else {
      this._tickSlot = -1;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Cue interpreter (AUDIO_CUES vocabulary)
  // -------------------------------------------------------------------------------------------

  /** Builds and schedules one cue instance at context time t0; returns its voice (null when dropped). */
  _startCue(e, st, t0) {
    const ac = this._ac;
    const cue = st.recipe;
    const v = this._allocVoice();
    if (v === null) { this._dropped(); return null; }

    // cue-level gain: volume · countDb · stackDb · distance attenuation
    let gain = e.volume;
    const cdb = cue.countDb;
    if (cdb && e.count > 0 && cdb.per > 0) gain *= dbToGain(Math.min(cdb.cap, Math.floor(e.count / cdb.per) * cdb.db));
    const sdb = cue.stackDb;
    if (sdb && e.stack > 0) gain *= dbToGain(Math.min(sdb.cap, e.stack * sdb.per));
    let pan = 0;
    if (e.hasPos) {
      pan = clamp(e.x * MUSIC.pan.perX, -MUSIC.pan.maxPan, MUSIC.pan.maxPan);
      // noAtten (round 4): a reward cue keeps its pan but not the distance attenuation (a flip 35 m ahead lost 5 dB)
      if (cue.noAtten !== true) gain *= dbToGain(MUSIC.pan.attenDbAt40m * Math.min(ATTEN_MAX_RATIO, Math.abs(e.z) / ATTEN_REF_M));
    }
    const warm = this._warming;

    let cueGain = null;
    try {
      cueGain = ac.createGain();
      cueGain.gain.setValueAtTime(gain, t0);
      v.nodes[v.nodeCount++] = cueGain;
      const bus = this._rendering ? this._renderDest : warm ? this._warmSink : cue.bus === 'gun' ? this._gunBus : cue.bus === 'reward' ? this._rewardBus : this._sfxBus;
      // every positional cue goes through its panner, x = 0 included: the equal-power pan law sits 3 dB under the unity
      // up-mix of an unpanned mono cue, so skipping the panner at exactly x = 0 made a centred squad's shots 3 dB louder
      if (e.hasPos && this._hasPanner) {
        const p = ac.createStereoPanner();
        p.pan.setValueAtTime(pan, t0);
        v.nodes[v.nodeCount++] = p;
        cueGain.connect(p);
        p.connect(bus);
      } else {
        cueGain.connect(bus);
      }
    } catch (_) {
      this._releaseVoice(v);
      return null;
    }
    v.cueGain = cueGain;
    v.cueState = st;
    v.kind = VOICE_CUE;
    v.startTime = t0;
    // reward / UI stings (noTimeScale) are built at rate 1 and never re-pitched by slow-mo (AUD-4)
    const fixed = cue.noTimeScale === true;
    v.fixedRate = fixed;

    // round 5: a pre-rendered instance (AUDIO_CUES[*].prerender) is one AudioBufferSource into the cue gain; anything without a
    // matching buffer (another pitch / stretch, slow-mo on a cue that follows it, a render not finished) and the warm-up / render
    // builds themselves take the layer chains
    let end = -1;
    if (st.pre !== null && !warm && !this._rendering && (fixed || this._rate === 1)) end = this._startPre(v, st, e, t0, cueGain);
    if (end < 0) end = this._startLayers(v, cue, e, t0, cueGain, fixed);
    v.endTime = end;

    // stackDb bookkeeping: later coalesced plays bump this instance's gain (a dry build is released right away)
    if (sdb && !warm && !this._rendering) {
      st.liveGain = cueGain;
      st.liveGainBase = gain;
      st.liveStack = 0;
    }
    return v;
  }

  /** Builds every layer of a cue instance (chorus voices × layers) into cueGain; returns the context time it is silent. */
  _startLayers(v, cue, e, t0, cueGain, fixed) {
    const ac = this._ac;
    // pitch: opts.pitch (incl. the coin ladder) · rateJitter (± fraction, ctx.rngFx)
    let pitch = e.pitch;
    if (cue.rateJitter) pitch *= 1 + cue.rateJitter * (this._rnd() * 2 - 1);

    // pitchRule replaces the layers' f
    let fRule = 0;
    const pr = cue.pitchRule;
    if (pr) fRule = clamp(pr.base + pr.perUnit * e.value, pr.min, pr.max);

    // voices (chorus): n = min(max, ceil(count / perN)) copies spread over ± detune
    let n = 1;
    const vc = cue.voices;
    if (vc) n = Math.min(vc.max, Math.max(1, Math.ceil(e.count / vc.perN)));
    // chorus width (voices.spread, round 3 AUD-10): each voice gets its own StereoPanner across ±spread, so a crowd reads
    // wide and a single voice stays centred
    const spread = n > 1 && this._hasPanner && typeof vc.spread === 'number' ? vc.spread : 0;
    // per-voice gain 1/n^gainExp (incoherent sum ≈ n^(1 − 2·gainExp) in power): thicker and louder, never n× louder
    // (× √2 behind the per-voice panners: the pan-law compensation, PAN_LAW_COMP)
    const vGain = n > 1 ? (spread > 0 ? PAN_LAW_COMP : 1) / Math.pow(n, typeof vc.gainExp === 'number' ? vc.gainExp : 0.35) : 1;

    let end = t0;
    const layers = cue.layers;
    const stretch = e.stretch;
    for (let k = 0; k < n; k++) {
      let mul = 1;
      let dt = 0;
      let dest = cueGain;
      if (n > 1) {
        mul = 1 + vc.detune * ((2 * k) / (n - 1) - 1) + vc.detune * 0.25 * (this._rnd() * 2 - 1);
        if (k > 0) dt = this._rnd() * CHORUS_SPREAD_MS / 1000;
        if (spread > 0) {
          // slots from the outside in, alternating sides (k 0, 1, 2, 3 → slot 0, n−1, 1, n−2): the detuned voices do not
          // line up low-left / high-right
          const slot = (k & 1) === 0 ? k >> 1 : n - 1 - (k >> 1);
          try {
            const vp = ac.createStereoPanner();
            vp.pan.setValueAtTime(spread * ((2 * slot) / (n - 1) - 1), t0);
            vp.connect(cueGain);
            v.nodes[v.nodeCount++] = vp;
            dest = vp;
          } catch (_) { dest = cueGain; }
        }
      }
      for (let i = 0; i < layers.length; i++) {
        const L = layers[i];
        // a render trims its lead (_layerShiftS): every layer starts that much earlier, never before t0 + dt
        const lt = t0 + dt + Math.max(0, (L.delayMs ? L.delayMs * stretch / 1000 : 0) - this._layerShiftS);
        const le = this._startLayer(v, L, lt, pitch * mul, fRule, e.detune, vGain, stretch, dest, fixed);
        if (le > end) end = le;
      }
    }
    return end;
  }

  /**
   * Round 5: starts a pre-rendered instance — the buffer rendered for this play's (pitch, stretch) entry, chorus size and a random
   * variant — as one AudioBufferSource into cueGain (playbackRate = the pitch ratio, within MUSIC.prerender.pitchTol; time-scaled
   * through the voice's source table like any buffer source). Returns the context time it is silent, or −1 when no buffer matches.
   */
  _startPre(v, st, e, t0, dest) {
    const P = st.pre;
    let a = -1, ratio = 1;
    for (let k = 0; k < P.atN; k++) {
      if (Math.abs(e.stretch - P.stretch[k]) > 1e-6) continue;
      const r = e.pitch / P.pitch[k];
      if (r >= 1 - PRE_PITCH_TOL && r <= 1 + PRE_PITCH_TOL) { a = k; ratio = r; break; }
    }
    if (a < 0) return -1;
    if (e.detune !== 0) ratio *= Math.pow(2, e.detune / 1200);
    let n = 1;
    const vc = st.recipe.voices;
    if (vc) n = Math.min(vc.max, Math.max(1, Math.ceil(e.count / vc.perN)));
    if (n > P.nMax) n = P.nMax;
    const nv = P.varN[n - 1];
    const variant = nv > 1 ? Math.min(nv - 1, (this._rnd() * nv) | 0) : 0;
    const buf = P.bufs[(a * P.nMax + n - 1) * P.variants + variant];
    if (buf === null) return -1;
    const start = t0 + P.lead[a];
    const rate = v.fixedRate ? 1 : this._rate;
    let s = null;
    try {
      s = this._ac.createBufferSource();
      s.buffer = buf;
      s.playbackRate.setValueAtTime(ratio * rate, start);
      s.connect(dest);
      s.start(start);
    } catch (_) {
      if (s !== null) { try { s.disconnect(); } catch (__) { /* ignore */ } }
      return -1;
    }
    v.nodes[v.nodeCount++] = s;
    if (v.srcCount < v.srcs.length) {
      v.srcs[v.srcCount] = s; v.srcBuf[v.srcCount] = 1; v.srcBase[v.srcCount] = ratio; v.srcStart[v.srcCount] = start; v.srcCount++;
    }
    return start + buf.duration / (ratio * rate) + 0.02;
  }

  /**
   * One Layer: source (oscillator or pre-rendered noise buffer) → [shaper] → [filter] → envelope → dest.
   * `fixed` (noTimeScale cue): built at rate 1. Returns the context time at which the layer is silent.
   */
  _startLayer(v, L, t, pitch, fRule, detuneCents, vGain, stretch, dest, fixed) {
    const ac = this._ac;
    const dur = Math.max(0.005, (L.ms * stretch) / 1000);
    const rate = fixed ? 1 : this._rate;
    const rateCents = fixed ? 0 : this._rateCents;
    const isBuf = L.src === 'noise' || L.src === 'brown' || L.src === 'band';
    let src = null;
    try {
      if (isBuf) {
        const buf = this._buffers[L.src];
        const s = ac.createBufferSource();
        src = s;
        s.buffer = buf;
        s.loop = true;
        const base = pitch * Math.pow(2, ((L.detune || 0) + detuneCents) / 1200);
        s.playbackRate.setValueAtTime(base * rate, t);
        v.nodes[v.nodeCount++] = s;
        if (v.srcCount < v.srcs.length) {
          v.srcs[v.srcCount] = s; v.srcBuf[v.srcCount] = 1; v.srcBase[v.srcCount] = base; v.srcStart[v.srcCount] = t; v.srcCount++;
        }
        this._chain(v, L, t, dur, s, dest, vGain);
        const offset = this._rnd() * buf.duration * 0.9;
        if (!this._warming) {                  // a dry build never starts its sources
          s.start(t, offset);
          s.stop(t + dur + 0.01);
        }
      } else {
        const o = ac.createOscillator();
        src = o;
        o.type = L.src;
        const f0 = fRule > 0 ? fRule : L.f;
        o.frequency.setValueAtTime(Math.max(MIN_HZ, f0 * pitch), t);
        if (L.fEnd) {
          const fe = fRule > 0 ? L.fEnd * (fRule / L.f) : L.fEnd;
          const rampS = L.fMs ? (L.fMs * stretch) / 1000 : dur;
          o.frequency.exponentialRampToValueAtTime(Math.max(MIN_HZ, fe * pitch), t + rampS);
        }
        const base = (L.detune || 0) + detuneCents;
        o.detune.setValueAtTime(base + rateCents, t);
        v.nodes[v.nodeCount++] = o;
        if (v.srcCount < v.srcs.length) {
          v.srcs[v.srcCount] = o; v.srcBuf[v.srcCount] = 0; v.srcBase[v.srcCount] = base; v.srcStart[v.srcCount] = t; v.srcCount++;
        }
        this._chain(v, L, t, dur, o, dest, vGain);
        if (!this._warming) {
          o.start(t);
          o.stop(t + dur + 0.01);
        }
      }
    } catch (_) {
      if (src) { try { src.disconnect(); } catch (__) { /* ignore */ } }
      return t;
    }
    return t + dur + 0.02;
  }

  /** src → [WaveShaper (shaper drive)] → [Biquad (filter, fEnd sweep)] → envelope GainNode → dest. */
  _chain(v, L, t, dur, src, dest, vGain) {
    const ac = this._ac;
    let node = src;
    if (L.shaper && this._curves) {
      const rendering = this._rendering;
      const ws = rendering ? this._newShaper(L.shaper) : this._takeShaper(L.shaper);
      if (ws !== null) {
        if (!rendering) v.nodeDrive[v.nodeCount] = L.shaper;   // returned to its pool by _releaseVoice (a render's shaper is its own)
        v.nodes[v.nodeCount++] = ws;
        node.connect(ws);
        node = ws;
      }
    }
    const F = L.filter;
    if (F) {
      const bq = ac.createBiquadFilter();
      bq.type = F.type;
      bq.frequency.setValueAtTime(F.f, t);
      if (F.fEnd) bq.frequency.exponentialRampToValueAtTime(Math.max(MIN_HZ, F.fEnd), t + dur);
      bq.Q.setValueAtTime(F.q !== undefined ? F.q : 1, t);
      v.nodes[v.nodeCount++] = bq;
      node.connect(bq);
      node = bq;
    }
    // envelope: linear attack → hold until `decay` → exponential decay to −60 dB at `ms`
    const env = ac.createGain();
    v.nodes[v.nodeCount++] = env;
    const peak = (L.gain !== undefined ? L.gain : 1) * vGain;
    const stretch = dur / Math.max(0.005, L.ms / 1000);
    const atkMs = L.attack !== undefined ? L.attack : DEFAULT_ATTACK_MS;
    const attack = Math.min(dur * 0.9, Math.max(0.0005, (atkMs * stretch) / 1000));
    const decMs = L.decay !== undefined ? L.decay : atkMs;
    const decayAt = Math.min(dur * 0.95, Math.max(attack, (decMs * stretch) / 1000));
    const g = env.gain;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(peak, t + attack);
    if (decayAt > attack) g.setValueAtTime(peak, t + decayAt);
    g.exponentialRampToValueAtTime(Math.max(peak * ENV_FLOOR, 1e-6), t + dur);
    g.setValueAtTime(0, t + dur + 0.005);
    node.connect(env);
    env.connect(dest);
  }

  // -------------------------------------------------------------------------------------------
  // Live voice pool (LIVE_CAPACITY records allocated in init)
  // -------------------------------------------------------------------------------------------

  _allocVoice() {
    const voices = this._voices;
    const n = voices.length;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const idx = (this._voiceCursor + i) % n;
        const v = voices[idx];
        if (!v.active) {
          this._voiceCursor = (idx + 1) % n;
          v.active = true;
          v.endTime = Infinity;
          v.startTime = 0;
          v.kind = VOICE_CUE;
          v.fixedRate = false;
          v.env = null;
          v.nodeCount = 0;
          v.srcCount = 0;
          v.cueGain = null;
          v.cueState = null;
          return v;
        }
      }
      // pool full: release finished voices once, then retry
      if (pass === 0 && this._ac) this._sweepVoices(this._ac.currentTime);
    }
    return null;
  }

  _sweepVoices(now) {
    const voices = this._voices;
    if (!voices) return;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (v.active && v.endTime + RELEASE_MARGIN_S < now) this._releaseVoice(v);
    }
  }

  /** A WaveShaper of drive `d` with its curve and 2× oversampling set: from the drive's pool, or new (round 4: the
   *  oversampler setup costs ≈ 1–3 ms at 4× CPU on every new node, so released shapers are reused). Null without a curve. */
  _takeShaper(d) {
    const pool = this._shaperPools ? this._shaperPools.get(d) : undefined;
    if (pool !== undefined && pool.n > 0) {
      const ws = pool.nodes[--pool.n];
      pool.nodes[pool.n] = null;
      return ws;
    }
    return this._newShaper(d);
  }

  /** A new WaveShaper of drive `d` on the current context (curve + 2× oversampling), or null without a curve. */
  _newShaper(d) {
    const curve = this._curves.get(d);
    if (!curve) return null;
    const ws = this._ac.createWaveShaper();
    ws.curve = curve;
    ws.oversample = '2x';
    return ws;
  }

  /** Returns a disconnected WaveShaper to its drive's pool (dropped when the pool is full). */
  _giveShaper(d, ws) {
    const pool = this._shaperPools ? this._shaperPools.get(d) : undefined;
    if (pool !== undefined && pool.n < SHAPER_POOL_MAX) pool.nodes[pool.n++] = ws;
  }

  /** Disconnects every node of a voice (its sources already stopped on schedule) and frees it; pooled WaveShapers go back
   *  to their pool. */
  _releaseVoice(v) {
    const nodes = v.nodes;
    const drive = v.nodeDrive;
    for (let i = 0; i < v.nodeCount; i++) {
      const node = nodes[i];
      if (node !== null) {
        try { node.disconnect(); } catch (_) { /* ignore */ }
        if (drive[i] > 0) this._giveShaper(drive[i], node);
      }
      drive[i] = 0;
      nodes[i] = null;
    }
    const srcs = v.srcs;
    for (let i = 0; i < v.srcCount; i++) srcs[i] = null;
    const st = v.cueState;
    if (st !== null && st.liveGain === v.cueGain) st.liveGain = null;
    v.nodeCount = 0;
    v.srcCount = 0;
    v.cueGain = null;
    v.cueState = null;
    v.env = null;
    v.fixedRate = false;
    v.active = false;
  }

  // -------------------------------------------------------------------------------------------
  // Mix API (§6.13)
  // -------------------------------------------------------------------------------------------

  /** 'none' | 'menu' | 'level' | 'runup' | 'boss' (MUSIC.modes). Between two playing modes the switch
   *  lands on the next beat; from / to 'none' the loop fades in / out over MUSIC.fadeMs. */
  setMusic(mode) {
    this._requestMusic(mode, false);
  }

  /** setMusic with an optional loop restart (level:start / boss:fight / the title: bar 0 right away, the old
   *  mode's notes fade out over MUSIC.modeSwitch.crossfadeMs). Any explicit request cancels the boss-death stop. */
  _requestMusic(mode, restart) {
    if (MUSIC.modes[mode] === undefined) {
      warnOnce('audio.music.' + mode, 'unknown music mode ' + mode);
      return;
    }
    this._pendingStopT = 0;
    if (mode !== 'none') this._releaseStuckDuck();
    this._wantMode = mode;
    if (restart && mode !== 'none') this._restartReq = true;
    this._schedulerTick();
  }

  /** Releases the held boss-death duck (the music is starting again). */
  _releaseStuckDuck() {
    if (!this._duckStuck) return;
    this._duckStuck = false;
    const ac = this._ac;
    if (!ac || !this._duckTr) return;
    try { glideParam(this._duckTr.gain, 1, ac.currentTime, PARAM_SMOOTH_S); } catch (_) { /* ignore */ }
  }

  /** Timed dip of a gain node: down to `db` (DUCK_ATTACK_S), back to 1 after `seconds` (DUCK_RELEASE_S). */
  _dipGain(node, db, seconds) {
    const ac = this._ac;
    if (!ac || !node || ac.state !== 'running') return;
    try {
      const now = ac.currentTime;
      const p = node.gain;
      holdParam(p, now);
      p.setTargetAtTime(dbToGain(db), now, DUCK_ATTACK_S);
      p.setTargetAtTime(1, now + seconds, DUCK_RELEASE_S);
    } catch (_) { /* ignore */ }
  }

  /** Gun-bus duck on reward moments (gate:pass / weapon:start / gate:flip; MUSIC.duck.gunOnReward, AUD-10). */
  _duckGun() {
    const d = MUSIC.duck.gunOnReward;
    this._dipGain(this._gunDuck, d[0], d[1]);
  }

  /** The compressed bed (gunfire, sfx, music) dips under the reward bus (positive gate pass, round 3 AUD-10; weapon sting
   *  and gate flip, round 4; MUSIC.duck.bedOnReward). Post-compressor, so the compressor's release and makeup gain cannot fill the dip back in. */
  _duckBed() {
    const d = MUSIC.duck.bedOnReward;
    this._dipGain(this._bedDuck, d[0], d[1]);
  }

  /** Boss death (J16, AUD-13): the music dips MUSIC.duck.bossDead[0] dB under the roar + fanfare and is NOT
   *  released; after MUSIC.duck.bossDead[1] s the loop fades to 'none' (the scheduler checks _pendingStopT). */
  _duckBossDeath() {
    const d = MUSIC.duck.bossDead;
    const ac = this._ac;
    if (!ac || !this._duckTr || ac.state !== 'running') return;
    try {
      const now = ac.currentTime;
      const p = this._duckTr.gain;
      holdParam(p, now);
      p.setTargetAtTime(dbToGain(d[0]), now, DUCK_ATTACK_S);
      this._duckStuck = true;
      this._pendingStopT = now + d[1];
    } catch (_) { /* ignore */ }
  }

  /** duck(db, 0): immediate and held (pause) until duck(0, 0); duck(db, seconds > 0): a transient dip
   *  (gate pass, boss death) that recovers on its own after `seconds`. duck(0, 0) restores both. */
  duck(db, seconds) {
    const d = num(db, 0);
    const s = num(seconds, 0);
    const ac = this._ac;
    if (s <= 0) {
      this._holdDb = d;
      if (d === 0) { this._duckStuck = false; this._pendingStopT = 0; }   // duck(0, 0) restores everything
      if (!ac || !this._duckHold) return;
      try {
        const now = ac.currentTime;
        glideParam(this._duckHold.gain, dbToGain(d), now, PARAM_SMOOTH_S);
        if (d === 0) glideParam(this._duckTr.gain, 1, now, PARAM_SMOOTH_S);
      } catch (_) { /* ignore */ }
      return;
    }
    this._duckStuck = false;
    this._dipGain(this._duckTr, d, s);
  }

  /** { sound, music } faders 0–100 (either may be omitted). sound → sfx + gun + reward buses, music → music bus. */
  setVolumes(v) {
    if (!v) return;
    this._applyVolumes(v.sound, v.music);
  }

  _applyVolumes(sound, music) {
    if (typeof sound === 'number' && sound === sound) this._sound = clamp(sound, 0, 100);
    if (typeof music === 'number' && music === music) this._music = clamp(music, 0, 100);
    const ac = this._ac;
    if (!ac || !this._sfxBus) return;
    try {
      const now = ac.currentTime;
      const s = faderGain(this._sound);
      glideParam(this._sfxBus.gain, dbToGain(MUSIC.buses.sfx) * s, now, PARAM_SMOOTH_S);
      glideParam(this._gunBus.gain, dbToGain(MUSIC.buses.gun) * s, now, PARAM_SMOOTH_S);
      glideParam(this._rewardBus.gain, dbToGain(MUSIC.buses.reward) * rewardFaderGain(this._sound, this._music, !this._nomusic), now, PARAM_SMOOTH_S);
      glideParam(this._musicBus.gain, dbToGain(MUSIC.buses.music) * faderGain(this._music), now, PARAM_SMOOTH_S);
    } catch (_) { /* ignore */ }
    if (this._sound <= 0) this._clearQueue();
    this._schedulerTick();   // music fader 0 stops the loop, > 0 restarts it
  }

  /** Master mute (M key). Muted cues are dropped; the music clock keeps running silently. */
  setMuted(m) {
    this._muted = !!m;
    if (this._muted) this._clearQueue();
    const ac = this._ac;
    if (!ac || !this._master) return;
    try { glideParam(this._master.gain, this._muted ? 0 : 1, ac.currentTime, PARAM_SMOOTH_S); } catch (_) { /* ignore */ }
  }

  /** Slow-mo (engine.setTimeScale → every change incl. the return to 1): rate r = MUSIC.rate.base +
   *  MUSIC.rate.perScale·s; buffer sources → playbackRate, oscillators → detune 1200·log2(r), the music
   *  scheduler's step length ÷ r. Sounding sources glide from their current value (cancel + hold +
   *  setTargetAtTime, so no older automation overrides it); sources that start later (cue / layer delays,
   *  the music lookahead) get their start value rewritten at their start time (AUD-4). noTimeScale cues
   *  (fanfare, chime3, ui_*) are skipped. */
  setTimeScale(s) {
    const scale = clamp(num(s, 1), 0, 1);
    this._timeScale = scale;
    const r = scale >= 1 ? 1 : MUSIC.rate.base + MUSIC.rate.perScale * scale;
    this._rate = r;
    this._rateCents = r === 1 ? 0 : 1200 * Math.log2(r);
    const ac = this._ac;
    const voices = this._voices;
    if (!ac || !voices) return;
    const now = ac.currentTime;
    const cents = this._rateCents;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (!v.active || v.fixedRate) continue;
      for (let k = 0; k < v.srcCount; k++) {
        const node = v.srcs[k];
        if (node === null) continue;
        try {
          const buf = v.srcBuf[k] === 1;
          const p = buf ? node.playbackRate : node.detune;
          const value = buf ? v.srcBase[k] * r : v.srcBase[k] + cents;
          const start = v.srcStart[k];
          if (start > now) {
            p.cancelScheduledValues(start);
            p.setValueAtTime(value, start);
          } else {
            glideParam(p, value, now, PARAM_SMOOTH_S);
          }
        } catch (_) { /* source already stopped */ }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Music scheduler (setInterval(MUSIC.schedulerMs), MUSIC.lookaheadMs lookahead)
  // -------------------------------------------------------------------------------------------

  _effectiveMode() {
    if (this._nomusic || this._music <= 0) return 'none';
    return this._wantMode;
  }

  _schedulerTick() {
    const ac = this._ac;
    if (ac === null || ac.state !== 'running' || this._musicFade === null) return;
    const now = ac.currentTime;
    // boss death: the held duck ends in a fade to 'none' (MUSIC.duck.bossDead, AUD-13)
    if (this._pendingStopT > 0 && now >= this._pendingStopT) {
      this._pendingStopT = 0;
      this._wantMode = 'none';
    }
    const want = this._effectiveMode();

    if (!this._musicOn) {
      if (want === 'none') return;
      // fresh start: bar 0, fade in
      this._musicOn = true;
      this._fadingOut = false;
      this._restartReq = false;
      this._releaseStuckDuck();
      this._releaseOldMusic();
      this._activeMode = want;
      this._step = 0;
      this._nextT = now + MUSIC_START_S;
      try {
        const p = this._musicFade.gain;
        holdParam(p, now);
        p.setValueAtTime(0, now);
        p.linearRampToValueAtTime(1, now + FADE_S);
      } catch (_) { /* ignore */ }
      this._applyDrone(this._nextT);
    } else if (want === 'none') {
      if (!this._fadingOut) {
        this._fadingOut = true;
        this._stopAt = now + FADE_S;
        try {
          const p = this._musicFade.gain;
          holdParam(p, now);
          p.linearRampToValueAtTime(0, this._stopAt);
        } catch (_) { /* ignore */ }
      }
    } else if (this._fadingOut) {
      // revived before the fade-out finished: fade back in, switch on the next beat
      this._fadingOut = false;
      try {
        const p = this._musicFade.gain;
        holdParam(p, now);
        p.linearRampToValueAtTime(1, now + FADE_S);
      } catch (_) { /* ignore */ }
    }

    if (this._fadingOut && now >= this._stopAt) {
      this._musicOn = false;
      this._fadingOut = false;
      this._restartReq = false;
      this._stopDrone(now);
      return;
    }

    // level:start / boss:fight / the title: the requested mode starts at bar 0 right away (AUD-12)
    if (this._restartReq) {
      this._restartReq = false;
      if (!this._fadingOut && want !== 'none') this._restartLoop(now, want);
    }

    // a stalled scheduler (throttled timers) skips ahead instead of bursting the missed steps
    if (this._nextT < now - SCHEDULER_CATCH_UP_S) this._nextT = now + START_LATENCY_S;

    const horizon = now + MUSIC.lookaheadMs / 1000;
    let guard = 0;
    while (this._nextT < horizon && guard < SCHEDULER_MAX_STEPS) {
      if (this._step % BEAT_STEPS === 0 && want !== 'none' && want !== this._activeMode) {
        this._activeMode = want;                 // switch on the next beat (≤ 0.5 s at 120 BPM)
        this._applyDrone(this._nextT);
      }
      this._scheduleStep(this._step, this._nextT);
      this._nextT += STEP_S / this._rate;
      this._step = (this._step + 1) % LOOP_STEPS;
      guard++;
    }
    this._sweepVoices(now);
  }

  /** Restarts the loop at bar 0 in mode `want`: music notes that have not started yet are dropped, sounding ones
   *  fade out over CROSSFADE_S, the first step of the new loop lands MUSIC_START_S from now. */
  _restartLoop(now, want) {
    const voices = this._voices;
    const fadeEnd = now + CROSSFADE_S;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (!v.active || v.kind !== VOICE_MUSIC) continue;
      if (v.startTime > now + START_LATENCY_S) { this._releaseVoice(v); continue; }
      const env = v.env;
      if (env === null || v.endTime <= fadeEnd) continue;
      try {
        holdParam(env.gain, now);
        env.gain.linearRampToValueAtTime(0, fadeEnd);
      } catch (_) { /* already stopped */ }
      v.endTime = fadeEnd;                      // swept (disconnected) once silent
    }
    this._activeMode = want;
    this._step = 0;
    this._nextT = now + MUSIC_START_S;
    this._applyDrone(this._nextT);
  }

  /** A fresh start after a full stop (round 3): the stopped loop's notes and a stopping drone can still be sounding under the
   *  closed fade gain (a bar-long pad lasts 2.5 s; RETRY / NEXT restart within ~1 s of the fade-out) and would come back up
   *  with the new fade-in over the new bar 0. The fade gain is 0 here, so disconnecting them is silent. */
  _releaseOldMusic() {
    const voices = this._voices;
    if (!voices) return;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (v.active && (v.kind === VOICE_MUSIC || (v.kind === VOICE_DRONE && v !== this._droneVoice))) this._releaseVoice(v);
    }
  }

  /** Schedules every instrument of the active mode for one 16th step at context time t. */
  _scheduleStep(step, t) {
    if (this._muted) return;                     // keep time, build nothing
    const mode = MUSIC.modes[this._activeMode];
    if (!mode) return;
    const bar = (step / STEPS_PER_BAR) | 0;
    const s = step % STEPS_PER_BAR;
    const stepDur = STEP_S / this._rate;
    const P = MUSIC.patterns;
    const I = MUSIC.instruments;

    if (mode.drums) {
      const set = mode.drums;
      const bm = P.barMap[set];
      const variant = bm ? bm[bar] | 0 : 0;
      const kick = P.kick[set], snare = P.snare[set], hat = P.hat[set];
      if (kick) {
        const vel = kick[Math.min(variant, kick.length - 1)][s];
        if (vel > 0) {
          this._musicNote(I.kick, I.kick.f, t, 0, vel, 1, 0);
          if (I.kick.click) this._musicNote(I.kick.click, 0, t, 0, vel, 1, 0);   // phone-speaker click (AUD-11)
        }
      }
      if (snare) {
        const vel = snare[Math.min(variant, snare.length - 1)][s];
        if (vel > 0) {
          this._musicNote(I.snare, 0, t, 0, vel, 1, 0);
          if (I.snare.tone) this._musicNote(I.snare.tone, I.snare.tone.f, t, 0, vel, 1, 0);
        }
      }
      if (hat) {
        const vel = hat[Math.min(variant, hat.length - 1)][s];
        if (vel > 0) this._musicNote(I.hat, 0, t, 0, vel, 1, 0);
      }
    }

    if (mode.bass) {
      const steps = P.bass.steps;
      const pat = steps[Math.min(P.bass.barMap[bar] | 0, steps.length - 1)];
      const deg = pat[s];
      if (deg > 0) {
        const semis = DEGREE_SEMITONES[deg] || 0;
        const note = MUSIC.bassRoots[bar] + semis + (mode.bassOctave || 0);
        this._musicNote(I.bass, midiHz(note), t, (I.bass.gateSteps || 1) * stepDur, 1, 1, 0);
      }
    }

    if (mode.lead) {
      const lead = P.lead;
      const g = (bar / 2) | 0;
      const phrase = lead.steps[Math.min(lead.groupMap[g % lead.groupMap.length] | 0, lead.steps.length - 1)];
      const note = phrase[(bar % 2) * STEPS_PER_BAR + s];
      if (note > 0) this._musicNote(I.lead, midiHz(note), t, lead.gateSteps * stepDur, 1, 1, 0);
    }

    // round 5: a pre-rendered chord (MUSIC.instruments.pad.prerender) is one buffer source + envelope gain instead of 3 notes × voices
    // × (oscillator, low-pass, envelope); played at the music rate, so its hold spans the bar under slow-mo like the scheduler's steps
    if (mode.pad && s === 0 && !(this._padBufs !== null && this._padChord(this._padBufs[bar], t, mode.pad))) {
      const chord = MUSIC.chords[bar];
      const pad = I.pad;
      const nv = pad.voices || 1;
      const gm = mode.pad / nv;
      for (let c = 0; c < chord.length; c++) {
        const f = midiHz(chord[c]);
        for (let k = 0; k < nv; k++) {
          const det = nv > 1 ? pad.detuneCents * ((2 * k) / (nv - 1) - 1) : 0;
          this._musicNote(pad, f, t, STEPS_PER_BAR * stepDur, 1, gm, det);
        }
      }
    }
  }

  /**
   * One music note on the music bus. Percussive instruments (`ms`) decay exponentially over ms;
   * sustained ones (`attackMs`/`releaseMs`) hold for holdS then release. Kick: fStart → f over pitchMs.
   */
  _musicNote(inst, freq, t, holdS, vel, gainMul, detuneCents) {
    const ac = this._ac;
    const v = this._allocVoice();
    if (v === null) { this._dropped(); return null; }
    v.kind = VOICE_MUSIC;
    v.startTime = t;
    try {
      const isBuf = inst.src === 'noise' || inst.src === 'brown' || inst.src === 'band';
      let src;
      if (isBuf) {
        const s = ac.createBufferSource();
        const buf = this._buffers[inst.src];
        s.buffer = buf;
        s.loop = true;
        s.playbackRate.setValueAtTime(this._rate, t);
        v.srcs[v.srcCount] = s; v.srcBuf[v.srcCount] = 1; v.srcBase[v.srcCount] = 1; v.srcStart[v.srcCount] = t; v.srcCount++;
        src = s;
      } else {
        const o = ac.createOscillator();
        o.type = inst.src;
        if (inst.fStart) {
          o.frequency.setValueAtTime(inst.fStart, t);
          o.frequency.exponentialRampToValueAtTime(Math.max(MIN_HZ, freq), t + (inst.pitchMs || 1) / 1000);
        } else {
          o.frequency.setValueAtTime(Math.max(MIN_HZ, freq), t);
        }
        o.detune.setValueAtTime(detuneCents + this._rateCents, t);
        v.srcs[v.srcCount] = o; v.srcBuf[v.srcCount] = 0; v.srcBase[v.srcCount] = detuneCents; v.srcStart[v.srcCount] = t; v.srcCount++;
        src = o;
      }
      v.nodes[v.nodeCount++] = src;
      let node = src;
      const F = inst.filter;
      if (F) {
        const bq = ac.createBiquadFilter();
        bq.type = F.type;
        bq.frequency.setValueAtTime(F.f, t);
        bq.Q.setValueAtTime(F.q !== undefined ? F.q : 1, t);
        node.connect(bq);
        node = bq;
        v.nodes[v.nodeCount++] = bq;
      }
      const env = ac.createGain();
      const g = env.gain;
      const peak = (inst.gain !== undefined ? inst.gain : 1) * vel * gainMul;
      let end;
      if (inst.ms) {
        const dur = inst.ms / 1000;
        const atk = Math.min(dur * 0.5, (inst.attack !== undefined ? inst.attack : DEFAULT_ATTACK_MS) / 1000);
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(peak, t + atk);
        g.exponentialRampToValueAtTime(Math.max(peak * ENV_FLOOR, 1e-6), t + dur);
        g.setValueAtTime(0, t + dur + 0.005);
        end = t + dur;
      } else {
        const atk = Math.max(0.001, (inst.attackMs || DEFAULT_ATTACK_MS) / 1000);
        const rel = Math.max(0.005, (inst.releaseMs || DEFAULT_ATTACK_MS) / 1000);
        const hold = Math.max(holdS, atk);
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(peak, t + atk);
        g.setValueAtTime(peak, t + hold);
        g.exponentialRampToValueAtTime(Math.max(peak * ENV_FLOOR, 1e-6), t + hold + rel);
        g.setValueAtTime(0, t + hold + rel + 0.005);
        end = t + hold + rel;
      }
      node.connect(env);
      env.connect(this._musicBus);
      v.nodes[v.nodeCount++] = env;
      v.env = env;
      if (isBuf) src.start(t, this._rnd() * src.buffer.duration * 0.9);
      else src.start(t);
      src.stop(end + 0.01);
      v.endTime = end + 0.02;
    } catch (_) {
      this._releaseVoice(v);
      return null;
    }
    return v;
  }

  /**
   * Round 5: one pre-rendered pad chord (rendered at gain 1 per chord, rate 1, a bar's hold + release) at context time t: buffer source
   * at the music rate → envelope GainNode at the mode's pad level → music bus. The GainNode is the voice's `env`, so a loop restart
   * fades it like any music note. False (nothing built) without a buffer; the caller then builds the notes live.
   */
  _padChord(buf, t, gain) {
    if (buf === null || buf === undefined) return false;
    const ac = this._ac;
    const v = this._allocVoice();
    if (v === null) { this._dropped(); return true; }
    v.kind = VOICE_MUSIC;
    v.startTime = t;
    try {
      const s = ac.createBufferSource();
      s.buffer = buf;
      s.playbackRate.setValueAtTime(this._rate, t);
      v.nodes[v.nodeCount++] = s;
      v.srcs[v.srcCount] = s; v.srcBuf[v.srcCount] = 1; v.srcBase[v.srcCount] = 1; v.srcStart[v.srcCount] = t; v.srcCount++;
      const env = ac.createGain();
      env.gain.setValueAtTime(gain, t);
      v.nodes[v.nodeCount++] = env;
      s.connect(env);
      env.connect(this._musicBus);
      v.env = env;
      s.start(t);
      v.endTime = t + buf.duration / this._rate + 0.02;
    } catch (_) {
      this._releaseVoice(v);
      return false;
    }
    return true;
  }

  /** Starts / stops the persistent boss drone to match the active mode, at context time t. */
  _applyDrone(t) {
    const mode = MUSIC.modes[this._activeMode];
    const want = !!(mode && mode.drone);
    if (want && this._droneVoice === null) this._startDrone(t);
    else if (!want && this._droneVoice !== null) this._stopDrone(t);
  }

  /** Drone: sawtooth MUSIC.instruments.drone.note → low-pass, slow LFO tremolo (lfo.f, ±lfo.depth). */
  _startDrone(t) {
    const ac = this._ac;
    const inst = MUSIC.instruments.drone;
    const v = this._allocVoice();
    if (v === null) { this._dropped(); return; }
    v.kind = VOICE_DRONE;
    v.startTime = t;
    try {
      const o = ac.createOscillator();
      o.type = inst.src;
      o.frequency.setValueAtTime(midiHz(inst.note), t);
      o.detune.setValueAtTime(this._rateCents, t);
      v.srcs[v.srcCount] = o; v.srcBuf[v.srcCount] = 0; v.srcBase[v.srcCount] = 0; v.srcStart[v.srcCount] = t; v.srcCount++;
      v.nodes[v.nodeCount++] = o;
      let node = o;
      if (inst.filter) {
        const bq = ac.createBiquadFilter();
        bq.type = inst.filter.type;
        bq.frequency.setValueAtTime(inst.filter.f, t);
        bq.Q.setValueAtTime(inst.filter.q !== undefined ? inst.filter.q : 1, t);
        node.connect(bq);
        node = bq;
        v.nodes[v.nodeCount++] = bq;
      }
      const g = ac.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(inst.gain, t + FADE_S);
      node.connect(g);
      g.connect(this._musicBus);
      v.nodes[v.nodeCount++] = g;
      let lfo = null;
      let lg = null;
      if (inst.lfo) {
        lfo = ac.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.setValueAtTime(inst.lfo.f, t);
        lg = ac.createGain();
        lg.gain.setValueAtTime(inst.gain * inst.lfo.depth, t);
        lfo.connect(lg);
        lg.connect(g.gain);
        v.nodes[v.nodeCount++] = lfo;
        v.nodes[v.nodeCount++] = lg;
        lfo.start(t);
      }
      o.start(t);
      v.endTime = Infinity;                       // held until _stopDrone
      this._droneVoice = v;
      this._droneGain = g;
      this._droneOsc = o;
      this._droneLfo = lfo;
      this._droneLfoGain = lg;
    } catch (_) {
      this._releaseVoice(v);
    }
  }

  _stopDrone(t) {
    const v = this._droneVoice;
    if (v === null) return;
    const ac = this._ac;
    const at = ac ? Math.max(t, ac.currentTime) : t;
    try {
      const p = this._droneGain.gain;
      holdParam(p, at);
      p.linearRampToValueAtTime(0, at + FADE_S);
      // the LFO tremolo is summed into the same gain param: its depth fades too, or the drone would still sit at ±depth
      // (−20 dB) when the oscillator stops and end with a cut instead of a fade (round 3)
      if (this._droneLfoGain) {
        const q = this._droneLfoGain.gain;
        holdParam(q, at);
        q.linearRampToValueAtTime(0, at + FADE_S);
      }
      this._droneOsc.stop(at + FADE_S + 0.02);
      if (this._droneLfo) this._droneLfo.stop(at + FADE_S + 0.02);
    } catch (_) { /* ignore */ }
    v.endTime = at + FADE_S + 0.05;
    this._droneVoice = null;
    this._droneGain = null;
    this._droneOsc = null;
    this._droneLfo = null;
    this._droneLfoGain = null;
  }

  _stopDroneNow() {
    const v = this._droneVoice;
    if (v === null) return;
    try { this._droneOsc.stop(); } catch (_) { /* ignore */ }
    try { if (this._droneLfo) this._droneLfo.stop(); } catch (_) { /* ignore */ }
    this._releaseVoice(v);
    this._droneVoice = null;
    this._droneGain = null;
    this._droneOsc = null;
    this._droneLfo = null;
    this._droneLfoGain = null;
  }

  // -------------------------------------------------------------------------------------------
  // Event → cue mapping (ARCH §11, GDD §12 J-table). Listeners only queue (play) or set modes.
  // -------------------------------------------------------------------------------------------

  /** J5 gate flip: `flip` on the reward bus (panned, not distance-attenuated) over the gun-bus and bed ducks (round 4, lead
   *  decision 1a: it reads ≥ 6 dB over the gunfire bed like the gate pass). */
  _onGateFlip(p) {
    resetOpts().volume = this._rewardVolume();
    const g = p ? p.gate : null;
    this.play('flip', g ? withPos(g.x, g.z) : OPTS);
    this._duckGun();
    this._duckBed();
  }

  /** J13 weapon pickup: WEAPONS[*].sting on the reward bus over the gun-bus and bed ducks (round 4, lead decision 1a). */
  _onWeaponStart(p) {
    const sting = p ? this._stings[p.id] : undefined;
    if (!sting) return;
    resetOpts().volume = this._rewardVolume();
    this.play(sting, OPTS);
    this._duckGun();
    this._duckBed();
  }

  /** Volume of a reward-bus moment (positive gate pass, flip, sting) starting now: 1, or MUSIC.duck.rewardStack[0] dB when another
   *  one started less than rewardStack[1] s ago (round 4: a crate's weapon sting landing on a gate-pass chorus summed to −0.8 dBFS,
   *  into the soft clip; the later reward still reads, the sum stays clear of the limiter). */
  _rewardVolume() {
    const nowMs = this._nowMs();
    const d = MUSIC.duck.rewardStack;
    if (!d) return 1;               // guarded (ARCH §14): a data.js without the round-4 key trims nothing, as before round 4
    const stacked = nowMs - this._rewardLastMs < d[1] * 1000;
    this._rewardLastMs = nowMs;
    return stacked ? dbToGain(d[0]) : 1;
  }

  _subscribe() {
    const events = this._ctx.events;
    this._unsubs = [];
    if (!events) return;
    const unsubs = this._unsubs;
    const on = (name, fn) => {
      const off = events.on(name, fn);
      unsubs.push(typeof off === 'function' ? off : () => events.off(name, fn));
    };

    // ---- gunfire / hits ----
    // J1: +1 dB per 8 shooters (countDb), ≤ 12 voiced/s (maxPerSec + MUSIC.gunVoices). The shooters are
    // the visible soldiers min(C, FIRE.shooters) (GDD §3.3); p.count is only the shots of this fixed step.
    on('shot', (p) => {
      const o = resetOpts();
      const sq = this._ctx.squad;
      const c = sq ? num(sq.count, 0) : 0;
      o.count = c > 0 ? Math.min(c, FIRE.shooters) : num(p.count, 0);
      this.play('shot', withPos(p.x, p.z));
    });
    // J2: thip on non-lethal hits, ≤ 20/s (AUDIO_CUES.thip.maxPerSec)
    on('zombie:hit', (p) => {
      if (p.killed) return;
      resetOpts();
      this.play('thip', withPos(p.x, p.z));
    });
    on('boss:hit', (p) => {
      const o = resetOpts();
      o.pitch = BOSS_HIT_PITCH;
      this.play('thip', withPos(p.x, p.z));
    });
    // J9: crunch shared per 50 ms, +3 dB per extra kill (coalesceMs + stackDb); cleanup kills are silent
    on('zombie:die', (p) => {
      if (p.cause === 'cleanup') return;
      resetOpts();
      this.play('crunch', withPos(p.x, p.z));
    });
    // J10
    on('squad:loss', (p) => {
      resetOpts();
      this.play('ugh', withPos(p.x, p.z));
    });
    // round 7 (r7 teaching:6): the medic's tick (fx shows its green "+n") is heard too — a soft heal chirp
    on('squad:count', (p) => {
      if (p.reason !== 'medic' || !(p.delta > 0)) return;
      this.play('heal', resetOpts());
    });
    // J11 brute swing: roar on the ring telegraph, thud on the bite; screech telegraph
    on('zombie:telegraph', (p) => {
      if (p.kind === 'ring') { resetOpts(); this.play('roar', withPos(p.x, p.z)); }
      else if (p.kind === 'screech') { resetOpts(); this.play('screech', withPos(p.x, p.z)); }
    });
    on('zombie:bite', (p) => {
      if (p.type !== 'brute') return;
      resetOpts();
      this.play('thud', withPos(p.x, p.z));
    });
    // J22
    on('spit:impact', (p) => {
      resetOpts();
      this.play('splat', withPos(p.x, p.z));
    });

    // ---- gates ----
    // J3: tick coalesced per gate (≤ 1 per JUICE.caps.tickCoalesceMs), f = 620 + 6·(value − base) with
    // base = the SPAWN value: + / − gates use the signed value (view.base is a magnitude, so a −15 gate's
    // base is −15 → 620 Hz climbing to ≈ 800 Hz at +15); x / ÷ gates climb with their cumulative weighted
    // hits (the ring progress), since their shown value moves only once per step.
    on('gate:spawn', (p) => {
      const g = p.gate;
      if (g) this._gateHits[g.id & GATE_SLOT_MASK] = 0;
    });
    on('gate:hit', (p) => {
      const g = p.gate;
      if (!g) return;
      const o = resetOpts();
      o.keyed = true;
      o.key = g.id;
      const op = g.op;
      if (op === '+' || op === '-') {
        o.value = p.value - (op === '-' ? -g.base : g.base);
      } else {
        const slot = g.id & GATE_SLOT_MASK;
        const acc = this._gateHits[slot] + num(p.weight, 0);
        this._gateHits[slot] = acc;
        o.value = acc;
      }
      this.play('tick', withPos(p.x, p.z));
    });
    on('gate:max', (p) => { resetOpts(); const g = p.gate; this.play('max', g ? withPos(g.x, g.z) : OPTS); });
    on('gate:flip', (p) => { this._onGateFlip(p); });
    on('gate:step', (p) => { resetOpts(); const g = p.gate; this.play('whomp', g ? withPos(g.x, g.z) : OPTS); });
    // J7 / J8 + the music duck (MUSIC.duck.gate). Classified by the pass's effective op / value (the
    // fx shatter rule), not by the count delta: a red gate at C = 1 still sounds negative, and a neutral
    // grey x1 / '+0' still acknowledges the pass (pass_down, PASS_NEUTRAL_DB quieter).
    on('gate:pass', (p) => {
      const g = p.gate;
      if (g) this._gateHits[g.id & GATE_SLOT_MASK] = 0;
      const kind = passKind(p.op, num(p.value, 0), !!(g && g.flipped));
      if (kind === PASS_ITEM) {
        resetOpts();
        this.play('jingle', OPTS);
      } else if (kind === PASS_UP) {
        const vol = this._rewardVolume();
        resetOpts().volume = vol;
        this.play('pass_up', OPTS);
        const o = resetOpts();
        const gain = p.after - p.before;
        o.count = gain > 0 ? gain : 0;         // hup chorus: min(8, N/4) voices (at least 1), spread across the stereo field
        o.volume = vol;
        this.play('hup', OPTS);
        this._duckBed();                       // reward bus over a dipped bed: ≥ 6 dB over the gunfire (round 3 AUD-10)
      } else if (kind === PASS_DOWN) {
        resetOpts();
        this.play('pass_down', OPTS);
      } else {
        const o = resetOpts();
        o.volume = dbToGain(PASS_NEUTRAL_DB);
        this.play('pass_down', OPTS);
      }
      this.duck(MUSIC.duck.gate[0], MUSIC.duck.gate[1]);
      this._duckGun();                         // the pass reads ≥ 6 dB over the gunfire bed (AUD-10)
    });

    // ---- pickups / specials ----
    on('crate:open', (p) => {                  // J12
      resetOpts();
      this.play('pop', withPos(p.x, p.z));
      resetOpts();
      this.play('jingle', withPos(p.x, p.z));
    });
    on('coin:pickup', () => {                  // J19: semitone ladder within MUSIC.coinLadderMs
      this.play('coin', resetOpts());
    });
    on('weapon:start', (p) => { this._onWeaponStart(p); });
    on('weapon:fire', (p) => {                 // J21 + hero sniper
      const id = p.id;
      let cue = null;
      if (id === WEAPONS.rocket.id) cue = 'rocket';
      else if (id === WEAPONS.railgun.id) cue = 'rail';
      else if (id === TROOPS.sniper.id) cue = 'crack';
      if (cue === null) return;
      resetOpts();
      this.play(cue, withPos(p.x, p.z));
    });
    on('explosion', (p) => {                   // APC blast (the rocket blast is the `rocket` cue)
      if (p.kind === 'rocket') return;
      resetOpts();
      this.play('explosion', withPos(p.x, p.z));
    });

    // ---- boss ----
    on('boss:intro', () => {
      const o = resetOpts();
      o.pitch = BOSS_INTRO_ROAR_PITCH;
      o.volume = BOSS_ROAR_VOLUME;
      this.play('roar', o);
    });
    on('boss:attack', (p) => {
      const kind = p.kind;
      // round 7 (r7 teaching:3 item 5): the wind-up — every telegraphed attack (slam / charge / lane / car / stomp) sounds a
      // rising warning the moment its telegraph starts, so it is heard before it lands (the spit / rain / chew have their own)
      if (kind === 'slam' || kind === 'stomp' || kind === 'charge' || kind === 'lane' || kind === 'car') {
        resetOpts();
        this.play('warn', withPos(p.x, p.z));
      }
      if (kind !== 'slam' && kind !== 'stomp') return;   // the slam / stomp lands after its telegraph delay (kept)
      const o = resetOpts();
      o.delayMs = Math.max(0, num(p.delay, 0)) * 1000;
      o.pitch = BOSS_STOMP_PITCH;
      this.play('thud', withPos(p.x, p.z));
    });
    on('boss:phase', () => {                   // J15
      this.play('crash', resetOpts());
    });
    on('boss:dead', () => {                    // J16: roar at rate 0.4, then the fanfare (noTimeScale) over a dipped bed
      const o = resetOpts();
      o.pitch = BOSS_DEATH_ROAR_PITCH;
      o.stretch = BOSS_DEATH_ROAR_STRETCH;
      o.volume = BOSS_ROAR_VOLUME;
      this.play('roar', o);
      const f = resetOpts();
      f.delayMs = FANFARE_AFTER_ROAR_MS;
      this.play('fanfare', f);
      this._duckBossDeath();                   // −10 dB held, then the loop fades out (MUSIC.duck.bossDead)
    });

    // ---- results / meta ----
    on('level:complete', () => {               // J17
      this.play('chime3', resetOpts());
      this.setMusic('none');
    });
    on('level:failed', () => {                 // J18
      this.play('drone_down', resetOpts());
      this.setMusic('none');
    });
    on('endless:end', () => {
      this.play('drone_down', resetOpts());
      this.setMusic('none');
    });
    on('ui:button', () => { this.play('ui_tap', resetOpts()); });
    on('shop:buy', () => { this.play('ui_buy', resetOpts()); });

    // ---- music modes ----
    // level:start / boss:fight / entering the menus from elsewhere restart the loop at bar 0 (AUD-12);
    // runup switches on the next beat
    on('level:start', () => {
      this._resetRunState();
      this._requestMusic('level', true);
    });
    on('level:runup', () => { this.setMusic('runup'); });
    on('boss:fight', () => { this._requestMusic('boss', true); });
    on('state:change', (p) => {
      if (MENU_STATES[p.to] === true) this._requestMusic('menu', this._wantMode !== 'menu');
    });

    // ---- settings (sound / music faders 0–100) ----
    on('settings:change', (p) => {
      if (p.key !== 'sound' && p.key !== 'music') return;
      const val = typeof p.value === 'number' ? p.value : Number(p.value);
      if (p.key === 'sound') this._applyVolumes(num(val, this._sound), undefined);
      else this._applyVolumes(undefined, num(val, this._music));
    });
  }
}
