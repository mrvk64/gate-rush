// js/fx.js — GATE RUSH juice: GPU particles, digit-atlas floaters / damage numbers, the squad count
// label (GDD §5 ticker), panel shards, screen shake (trauma), slow-mo, flashes / vignette, FOV kick,
// game-over desaturation, boss-death bloom pulse, instanced ground decals (lane highlight, telegraph
// rings / arcs / stripes / x-bands, spit splats, the Colossus shield gauge), the sniper tracer line,
// coin / icon DOM flights and haptics.
//
// Contract: docs/ARCHITECTURE.md §6.12 (class shape, ownership, the count-label driver), §5.1 (event
// payloads), §9.1 / §9.2 (meshes, per-instance data), §14 (coding rules); docs/GDD.md §5 (ticker), §12
// (J1–J22). Numbers come from data.js (JUICE, SQUAD, GATE_RULES, BOSSES, WEAPONS, GEAR, TROOPS, PICKUPS,
// PALETTE, RENDER, QUALITY_TIERS, WORLD, ZOMBIES, FIRE); the visual constants data.js has no key for are
// declared below with a DATA-MISSING comment naming the intended path.
//
// Materials: particles / decals from ctx.render.materials.particle('add'|'norm') / .decal() (both built
// by ./fxmaterials.js, attribute layout documented there; fx falls back to calling the factories directly
// when the library is absent); digit-atlas quads from ctx.render.materials.glyph(true) (billboard variant:
// iGlyph vec4 atlas rect, iPopTime float, iColor vec3 linear HDR; dimming iColor below the shader's fade
// knee fades the quad out), cloned once so fx can draw its text on top (depthTest off). Every material
// has an in-file fallback so the module also runs against a stub render (ARCH §14 definition of done).
//
// Public surface (ARCH §6.12 + CALLSITES): init/reset/dispose/update, emit, burst, floater, damageNumber,
// label.{setCount, tweenTo, snapTo, showMult, setWorldPos}, addTrauma, getShake, slowmo, flash, vignette,
// fovKick, getFovKick, setDesaturate, decal, moveDecal, decalProgress, removeDecal, shatter, coinFlight,
// iconFlight, haptic, and the read-only getter `particleCount` (engine debug overlay).
//
// Time bases: GPU particles use the shared uTime (= ctx.time.elapsed, scaled, so slow-mo slows them);
// shards and decal lifetimes use the scaled frame dt (world physics / gameplay telegraph durations);
// floaters, damage numbers, the label, shake, FOV kick, flashes, the desaturation / bloom ramps and the
// DOM flights use the unscaled dt ("timings are real time", GDD §12); world-anchored text freezes while
// paused, DOM flights keep animating (§4.2).
//
// Reads:  ctx.render (scene, camera, size, uniforms.uTime, materials, textures, worldToScreen, setDesaturate,
//         gameOverCamera, setBloomStrength), ctx.engine.setTimeScale, ctx.ui (flash, vignette,
//         coinIconScreenPos, powerupIconScreenPos), ctx.audio.play ('tick' during the count roll-up),
//         ctx.save.settings (haptics, reducedMotion), ctx.quality.params.particles, ctx.world (roadSpeed,
//         squadX, bossX, bossZ, bossActive), ctx.squad (intersectsCircle, centerZ), ctx.state, ctx.time,
//         ctx.rngFx, ctx.models.geo.shard, ctx.debug.dropped.
// Writes: nothing on ctx; emits no events.
import {
  InstancedMesh, InstancedBufferAttribute, PlaneGeometry, BoxGeometry, ShaderMaterial, MeshBasicMaterial,
  Color, Vector3, Quaternion, Matrix4, DynamicDrawUsage, AdditiveBlending, NormalBlending, DoubleSide, LinearSRGBColorSpace,
  CustomBlending, MinEquation, OneFactor,
  UniformsLib, UniformsUtils,
} from 'three';
import { clamp, vibrate } from './util.js';
import {
  WORLD, SQUAD, FIRE, GATE_RULES, ZOMBIES, BOSSES, WEAPONS, GEAR, TROOPS, PICKUPS, RENDER, PALETTE, JUICE,
} from './data.js';
import {
  makeParticleMaterial, makeDecalMaterial, fxColorIndex, FX_COLOR, PARTICLE_KIND, PARTICLE_ADDITIVE, DECAL_KIND,
} from './fxmaterials.js';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------
const DEG = Math.PI / 180;
const ID_SHIFT = 12;                      // decal ids: (generation << 12) | slot (ARCH D6 style handles)
const SLOT_MASK = (1 << ID_SHIFT) - 1;
const HDR_WHITE = PALETTE.glyph.emissive; // glyph HDR gain (white floaters) — the count label and damage numbers use their own gains below
const HDR_TINT = 2.0;                     // DATA-MISSING: JUICE.text.tintGain — HDR gain of coloured text (green / red / gold)
// Count label (GDD §3.1 / pillar 5: a crisp white number with its 3 px dark outline). On High the half-res bloom
// spreads any HDR fill over the atlas outline, so the label stays near linear 1.0 and its flashes / badge peak low.
const LABEL_GAIN = JUICE.label.gain > 0 ? JUICE.label.gain : 0.82;   // JUICE.label.gain: linear white just under RENDER.bloom.threshold (0.85)
const LABEL_FLASH_PEAK = 1.1;        // DATA-MISSING: JUICE.label.flashPeak — peak component of the gain / loss flash colour
const LABEL_BADGE_PEAK = 1.0;        // DATA-MISSING: JUICE.label.badgePeak — peak component of the "x3" badge colour (luminance < bloom threshold)
const LABEL_TEXT_PEAK = 1.05;        // DATA-MISSING: JUICE.gateBurst.peak — "+17" / "−k" text beside the label (green luminance < bloom threshold)
const NUMBER_GAIN = LABEL_GAIN;       // DATA-MISSING: JUICE.damageNumber.gain — normal numbers just under the bloom threshold (no blob, outline kept)
const NUMBER_CRIT_GAIN = 1.6;        // DATA-MISSING: JUICE.damageNumber.critGain — only crits (sniper / gold) glow
const PARTICLES_PER_MESH = JUICE.caps.particlesPerMesh;   // 512 = QUALITY_TIERS.high.particles / 2 (§14 rule 3)

// Particle kinds (fxmaterials.js contract)
const K_SPARK = PARTICLE_KIND.spark, K_BLOOD = PARTICLE_KIND.blood, K_MUZZLE = PARTICLE_KIND.muzzle, K_SMOKE = PARTICLE_KIND.smoke;
const K_GOLD = PARTICLE_KIND.gold, K_CONFETTI = PARTICLE_KIND.confetti, K_DUST = PARTICLE_KIND.dust;
const K_SPLASH = PARTICLE_KIND.splash, K_COINSPARKLE = PARTICLE_KIND.coinSparkle;
const KIND_COUNT = 11;

// Decal kinds (round 7: + the brute's swipe arc)
const D_RING = DECAL_KIND.ring, D_LANE = DECAL_KIND.lane, D_SPLAT = DECAL_KIND.splat, D_XBAND = DECAL_KIND.xband;
const D_ARC = DECAL_KIND.arc, D_SWIPE = DECAL_KIND.swipe, D_LAST = DECAL_KIND.swipe;

// Colour indices (FX_COLORS)
const C_SPARK = FX_COLOR.spark, C_MUZZLE = FX_COLOR.muzzle, C_GOLD = FX_COLOR.gold, C_BLUE = FX_COLOR.blue, C_ACID = FX_COLOR.acid;
const C_FLAME = FX_COLOR.flame, C_SMOKE = FX_COLOR.smoke, C_DUST = FX_COLOR.dust, C_WHITE = FX_COLOR.white;
const C_ROCKET = FX_COLOR.rocket, C_SPLASH = FX_COLOR.splash, C_BLOOD = FX_COLOR.blood, C_CONFETTI0 = FX_COLOR.confetti0;
const C_CONFETTI_N = FX_COLOR.confettiCount, C_SHIELD = FX_COLOR.shield, C_RAIL = FX_COLOR.rail;
const C_GATE = [FX_COLOR.plus, FX_COLOR.mult, FX_COLOR.minus, FX_COLOR.div, FX_COLOR.zero, FX_COLOR.item];   // GATE_RULES.colors key order

// Per-kind emit defaults (used when emit() gets no opts): life (s), size (m), speed (m/s of the random
// velocity), up (0..1 upward bias of the random direction), gravity (m/s² +y), carry (fraction of the road
// speed the particle rides with), jitter (± fraction of life / size), colour index.
// DATA-MISSING: JUICE.particles.<kind> = { life, size, speed, up, gravity, carry, colorIdx } — the GDD J-table
// gives counts and colours only; these are the visual defaults.
const P_LIFE = new Float32Array([0.35, 0.6, FIRE.muzzleFlash.ms / 1000, 1.2, 0.8, 0.5, 2.6, 0.8, 0.4, 0.55, 0.45]);
const P_SIZE = new Float32Array([0.12, 0.17, FIRE.muzzleFlash.size, 0.5, 0.13, 0.1, 0.16, 0.38, 0.3, 0.16, 0.11]);
const P_SPEED = new Float32Array([5.0, 3.2, 0.0, 0.8, 5.0, 3.0, 7.0, 1.4, 1.0, 3.6, 1.6]);
const P_UP = new Float32Array([0.55, 0.6, 0.0, 0.8, 0.85, 0.5, 0.95, 0.35, 0.7, 0.75, 0.5]);
const P_GRAVITY = new Float32Array([-9.8, -9.8, 0, 0.6, -7.5, -9.8, -2.2, 0.3, 1.5, -9.8, -1.0]);
const P_CARRY = new Float32Array([1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1]);
const P_COLOR = new Int8Array([C_SPARK, C_BLOOD, C_MUZZLE, C_SMOKE, C_GOLD, C_BLUE, -1, C_DUST, C_FLAME, C_SPLASH, C_GOLD]);   // −1 = random confetti
// Spark defaults as module constants for the per-hit handlers (zombie / boss / gate hits arrive by the hundred per second
// under heavy fire): constant doubles reach _emitRaw as embedded numbers, typed-array loads would be boxed per call (FX-14)
const SPARK_SPEED = P_SPEED[K_SPARK], SPARK_UP = P_UP[K_SPARK], SPARK_LIFE = P_LIFE[K_SPARK], SPARK_SIZE = P_SIZE[K_SPARK];
const SPARK_GRAVITY = P_GRAVITY[K_SPARK], BOSS_SPARK_SIZE = P_SIZE[K_SPARK] * 1.2;
const GATE_HIT_Y = GATE_RULES.panel.bottom + 0.15;   // gate-hit sparks never start below the panel's bottom edge
const P_JITTER = 0.25;               // DATA-MISSING: JUICE.particles.jitter — ± life / size variation per particle

// Burst presets (JUICE.bursts counts) → kind, colour, speed multiplier, spawn height offset.
// DATA-MISSING: JUICE.burstStyle.<preset> = { kind, colorIdx, speedMult } (the GDD names counts and colours).
const B_HITSPARK = 0, B_GATESPARK = 1, B_BLOOD = 2, B_BLOODSMALL = 3, B_MAX = 4, B_FLIP = 5, B_ROCKET = 6, B_SPLAT = 7, B_BOSSDEATH = 8, B_COINFOUNTAIN = 9;
const BURST_ID = Object.freeze({ hitSpark: B_HITSPARK, gateSpark: B_GATESPARK, blood: B_BLOOD, bloodSmall: B_BLOODSMALL, max: B_MAX, flip: B_FLIP,
  rocket: B_ROCKET, splat: B_SPLAT, bossDeath: B_BOSSDEATH, coinFountain: B_COINFOUNTAIN });
const BURST_COUNT = new Int16Array([JUICE.bursts.hitSpark, JUICE.bursts.gateSpark, JUICE.bursts.blood, JUICE.bursts.bloodSmall, JUICE.bursts.max,
  JUICE.bursts.flip, JUICE.bursts.rocket, JUICE.bursts.splat, JUICE.bursts.bossDeath, JUICE.bursts.coinFountain]);
const BURST_KIND = new Int8Array([K_SPARK, K_SPARK, K_BLOOD, K_BLOOD, K_GOLD, K_SPARK, K_SPARK, K_SPLASH, K_CONFETTI, K_GOLD]);
const BURST_COLOR = new Int8Array([C_SPARK, C_SPARK, C_BLOOD, C_BLOOD, C_GOLD, C_BLUE, C_ROCKET, C_ACID, -1, C_GOLD]);
const BURST_SPEED = new Float32Array([1.0, 0.8, 1.0, 0.8, 1.1, 1.2, 2.2, 1.0, 1.0, 1.0]);
const GATE_SPARK_SPEED = SPARK_SPEED * BURST_SPEED[B_GATESPARK];   // J3 gate-hit spark speed (per-hit constant, see SPARK_SPEED)

// Visual constants the data tables do not carry (each named after the intended data.js path).
const SHAKE_HZ = 24;                 // DATA-MISSING: JUICE.shake.freqHz — noise sample rate of the camera shake (Hz)
const ICON_RISE_S = 0.25;            // DATA-MISSING: JUICE.iconFlight.rise — J12: icon rises PICKUPS.iconRise over 0.25 s …
const ICON_FLY_S = 0.35;             // DATA-MISSING: JUICE.iconFlight.fly — … then flies to the HUD pill (0.6 s total, GDD J12)
const ICON_PX = 44;                  // DATA-MISSING: JUICE.iconFlight.px — DOM icon sprite size (CSS px)
const COIN_PX = 20;                  // DATA-MISSING: JUICE.coinFlight.px — DOM coin sprite size (CSS px)
const COIN_ARC_PX = 110;             // DATA-MISSING: JUICE.coinFlight.arcPx — bezier control-point lift (CSS px)
const COIN_BIG_AMOUNT = 10;          // DATA-MISSING: JUICE.coinFlight.bigAmount — pickups ≥ 10 c launch 3 staggered sprites
const COIN_BOSS_SPRITES = 8;         // DATA-MISSING: JUICE.coinFlight.bossSprites — sprites launched by the boss coin fountain
const COIN_STAGGER_S = 0.05;         // DATA-MISSING: JUICE.coinFlight.stagger — delay between the sprites of one pickup (s)
const COIN_PUNCH_S = 0.18;           // DATA-MISSING: JUICE.coinFlight.punchSeconds — HUD coin icon punch 1.2× → 1 settle
const BADGE_SCALE = 0.6;             // DATA-MISSING: JUICE.label.badgeScale — "x3" badge glyph height relative to the label
const BADGE_IN_S = 0.15;             // DATA-MISSING: JUICE.label.badgeIn — badge pop 2 → 1 (s)
const BADGE_HOLD_EXTRA_S = 0.35;     // DATA-MISSING: JUICE.label.badgeHold — badge stays this long after the roll-up ends
const BADGE_GAP_EM = 0.18;           // DATA-MISSING: JUICE.label.badgeGap — gap between the count and the badge (em)
const LABEL_TICK_VOLUME = 0.55;      // DATA-MISSING: JUICE.label.tickVolume — roll-up tick loudness (audio 'tick' cue)
const LABEL_TICK_VALUE_SPAN = 60;    // DATA-MISSING: JUICE.label.tickPitchSpan — tick pitch climbs over the roll-up (tick pitchRule units)
const LABEL_START_BOUNCE = 1.15;     // DATA-MISSING: JUICE.label.startBounce — "5 bounces once" at level start (GDD §1.1)
const SPLAT_SECONDS = 0.5;           // DATA-MISSING: JUICE.splat.seconds — J22 green splash decal life (GDD: 0.5 s)
const DECAL_FADE_IN_S = 0.12;        // DATA-MISSING: JUICE.decals.fadeIn — every decal fades in (s)
const DECAL_FADE_OUT_S = 0.12;       // DATA-MISSING: JUICE.decals.fadeOut — finite decals fade out over their last 0.12 s
const DECAL_RESERVE = 1;             // DATA-MISSING: JUICE.caps.decalReserve — slots only the lane highlight / shield gauge may take
const DECAL_SPLAT_HEADROOM = 3;      // DATA-MISSING: JUICE.caps.splatHeadroom — cosmetic splats need this many free slots
const SHIELD_RING_SIZE = BOSSES.radius * 3;   // DATA-MISSING: JUICE.shieldGauge.size — ring gauge diameter at the boss core (m)
const BEAM_SECONDS = 0.08;           // DATA-MISSING: JUICE.sniperBeam.seconds — "red tracer line for one frame" (held ≥ 1 frame at 60 Hz)
const BEAM_THICKNESS = 0.06;         // DATA-MISSING: JUICE.sniperBeam.thickness (m)
const BEAM_POOL = 4;                 // DATA-MISSING: JUICE.caps.beams — concurrent sniper tracer lines
const BEAM_TARGET_Y = 1.0;           // = ARCH §7 sniper hit height (zombies.damage(…, 1.0, …))
const NUMBER_RISE = 1.0;             // DATA-MISSING: JUICE.damageNumber.rise (m); life / size reuse JUICE.floater
// JUICE.damageNumber.mergeSeconds — hits on one target within this window add up (0.12 s: short enough that
// constant DPS still reads as separate hits)
const NUMBER_FLUSH_S = JUICE.damageNumber.mergeSeconds > 0 ? JUICE.damageNumber.mergeSeconds : 0.12;
const NUMBER_FLUSH_JITTER = 0.35;    // DATA-MISSING: JUICE.damageNumber.mergeJitter — ± fraction of the window per number (varied totals)
const NUMBER_ACC_SLOTS = 8;          // DATA-MISSING: JUICE.caps.numberTargets — targets tracked for damage-number merging
const NUMBER_CRIT_SCALE = 1.45;      // DATA-MISSING: JUICE.damageNumber.critScale — sniper / crit numbers are larger
// Tracked-target numbers (boss −2 / brute ids, round-2 QA FX-12): a per-target slot grid — slot k sits in column k & 1
// (left / right of the target, inner edge NUMBER_SIDE from it) and row k >> 1 (NUMBER_ROW_EM glyph heights apart along the
// camera's up axis); the next number takes the slot after the target's newest one and retires that slot's occupant, so
// two live numbers of one target never share a slot and their boxes never meet (rise < row gap − glyph ink).
const NUMBER_BOSS_SCALE = JUICE.damageNumber.bossScale;   // boss numbers read at 10–12 m
const NUMBER_SIDE = JUICE.damageNumber.bossSide;          // half-gap (m) between the two columns of a target's numbers
const NUMBER_TRACK_RISE = JUICE.damageNumber.bossRise;    // tracked numbers rise this far (m) along the camera's up axis
const NUMBER_ROWS = Math.max(1, JUICE.damageNumber.bossSlots | 0);                                    // rows per column
const NUMBER_TRACK_SLOTS = Math.max(1, Math.min(JUICE.caps.bossNumbers | 0, 2 * NUMBER_ROWS));        // live numbers per target
// Round 4 (r3-ftue residual 4): the boss's own grid is capped at JUICE.damageNumber.bossRows rows per side. At high fire rates every
// merge window used to flush a number, so all 2 × 3 slots stayed full and each slot's number was retired the moment it faded in the
// next round (≈ 8 numbers / s): a busy, flickering stack. The boss accumulator now merges for at least floater.life / slots, so a
// slot's number has run its whole life before the slot comes round again — fewer, larger totals, never retired early. Brutes keep
// NUMBER_ROWS / NUMBER_TRACK_SLOTS and NUMBER_FLUSH_S.
const NUMBER_BOSS_ROWS = Math.max(1, Math.min(NUMBER_ROWS, JUICE.damageNumber.bossRows > 0 ? JUICE.damageNumber.bossRows | 0 : NUMBER_ROWS));
const NUMBER_BOSS_SLOTS = Math.max(1, Math.min(NUMBER_TRACK_SLOTS, 2 * NUMBER_BOSS_ROWS));             // live numbers on the boss
const NUMBER_BOSS_WIN = Math.max(NUMBER_FLUSH_S, (JUICE.floater.life > 0 ? JUICE.floater.life : 0.7) / NUMBER_BOSS_SLOTS);   // boss merge window (s)
const NUMBER_ROW_EM = 1.3;           // DATA-MISSING: JUICE.damageNumber.rowPitch — row pitch in glyph heights of the target's base size
                                     // (a 0.75-em ink box + a ×1.45 crit + bossRise still clear the row above)
const BOSS_ANCHOR_SNAP = BOSSES.radius * 2;   // DATA-MISSING: JUICE.damageNumber.anchorSnap — a boss hit this close to ctx.world.bossX
                                              // anchors its number on the boss (stable grid); a farther twin keeps the hit x
// The atlas has no 'K' glyph, so a number shows at most 4 digits. Round 7 (r7 "9999" numbers, the tester's L15): a shown number is
// never a clamped value — a merge that would pass NUMBER_MAX shows its total so far and starts a fresh number (_accDamage), and a
// single hit above it reads "9999+" (the atlas has the '+'; writeNumberGlyphs)
const NUMBER_MAX = 9999;
const SHARD_SPIN = 14;               // DATA-MISSING: JUICE.shatter.spin — max angular speed (rad/s)
const SHARD_SPEED_MIN = 3;           // DATA-MISSING: JUICE.shatter.speed[0] — toward / away from the camera (m/s)
const SHARD_SPEED_MAX = 6;           // DATA-MISSING: JUICE.shatter.speed[1]
const SHARD_GRAVITY = WORLD.gravity;           // (m/s²) (data key; wired round-2 cross-group)
const SHARD_GLOW = 1.0;              // DATA-MISSING: JUICE.shatter.hdrGain — shards in the panel tint (no bloom blob over the squad)
const SHARD_OPACITY = 0.8;           // DATA-MISSING: JUICE.shatter.opacity — folded into the additive colour, faded by (1 − u)²
const SHARD_SIZE = 0.55;             // DATA-MISSING: JUICE.shatter.size — shard size relative to its panel cell
const SHARD_POS_FWD = 0.35;          // DATA-MISSING: JUICE.shatter.towardCamera — positive pass: fraction of the speed toward the camera
const SHARD_POS_VY = [2, 4];         // DATA-MISSING: JUICE.shatter.vy — positive pass: upward launch (m/s)
const SHARD_POS_OUT = [2, 4];        // DATA-MISSING: JUICE.shatter.out — positive pass: lateral speed at the panel edge (m/s)
const SHARD_BOX = [0.5, 0.4, 0.05];  // = ARCH §6.12 shard geometry BoxGeometry(0.5, 0.4, 0.05) (fallback when models has none)
const SHATTER_AWAY = 0, SHATTER_TOWARD = 1, SHATTER_NEUTRAL = 2;   // shard flight modes (J8 / J7 / neutral grey pass)
const BLOOD_Y_FRACTION = 0.55;       // DATA-MISSING: JUICE.bursts.bloodYFraction — blood bursts at 55 % of the zombie height
const LOSS_FLOATER_Y = 1.9;          // DATA-MISSING: JUICE.floater.lossY — "−1" fallback height when the label has no anchor (m)
const LOSS_GAP_EM = 0.25;            // DATA-MISSING: JUICE.floater.lossGap — gap between the label's left edge and the "−k" (label em)
const LOSS_SIZE_EM = 0.62;           // DATA-MISSING: JUICE.floater.lossSize — "−k" glyph height beside the label (label em)
const LOSS_DRIFT = 0.45;             // DATA-MISSING: JUICE.floater.lossDrift — "−k" drifts this far left while rising (m)
const ROCKET_FLASH_SIZE = 4.5;       // DATA-MISSING: JUICE.rocket.flashSize — J21 orange blast flash quad (m)
const ROCKET_FLASH_LIFE = 0.3;       // DATA-MISSING: JUICE.rocket.flashLife (s)
const SCORCH_SIZE = 2.5;             // DATA-MISSING: JUICE.rocket.scorchSize — dark ground scorch diameter (m)
const SCORCH_SECONDS = 1.5;          // DATA-MISSING: JUICE.rocket.scorchSeconds
const SCORCH_POOL = 6;               // DATA-MISSING: JUICE.caps.scorches (rocket every 0.6 s × 1.5 s + APC blasts)
const SCORCH_HEX = 0x14100C;         // DATA-MISSING: PALETTE.fx.scorch
const SCORCH_ALPHA = 0.92;           // DATA-MISSING: JUICE.rocket.scorchAlpha
const SCORCH_HEAT_S = 0.6;           // DATA-MISSING: JUICE.rocket.scorchHeat — the ember rim cools over this time (s)
const SCORCH_EMBER_GAIN = 1.6;       // DATA-MISSING: JUICE.rocket.emberGain — HDR of the ember rim (blooms briefly)
const FOUNTAIN_VY_MIN = 6;           // DATA-MISSING: JUICE.coinFountain.vy[0] — J16 60-coin fountain launch speed (m/s)
const FOUNTAIN_VY_MAX = 9.5;         // DATA-MISSING: JUICE.coinFountain.vy[1]
const CONFETTI_Y = 2.0;              // DATA-MISSING: JUICE.confetti.yAboveCore — boss-death confetti bursts above the core (m)
const BLOOM_PULSE_UP = RENDER.bloom.deathRise;           // fraction of RENDER.bloom.deathTime spent rising to the peak (data key; wired round-2 cross-group)
const FOV_KICK_ATTACK = 0.15;        // DATA-MISSING: JUICE.fovKick.attack — fraction of the kick spent ramping in
const REDUCED_DIM_ALPHA = 0.35;      // DATA-MISSING: JUICE.flashes.reducedDimAlpha — reduced-motion "150 ms dim" strength
const HAPTIC_GAP_MS = 60;            // DATA-MISSING: JUICE.haptics.minGapMs — single-pulse haptics closer than this are dropped
const HIT_SPARK_BURSTS_PER_FRAME = 24;   // DATA-MISSING: JUICE.caps.hitSparkBurstsPerFrame — beyond this a hit gets 1 spark (laser / rail floods)
// quads per floater / number (JUICE.caps.floaterQuads / floaters). Round 7: 4 → 5, so a 4-digit "−k" / "+N" keeps its sign and an
// overflowing hit has room for its "9999+" mark
const MAX_TEXT = 5;
// Round 7 (r7 teaching:1): the loss "−k" beside the label is JUICE.floater.lossScale × its old size, lossScaleBig from k ≥ lossBigFrom
const FLOATER_SIZE = JUICE.floater.size;
const LOSS_SCALE = JUICE.floater.lossScale > 0 ? JUICE.floater.lossScale : 1;
const LOSS_SCALE_BIG = JUICE.floater.lossScaleBig > 0 ? JUICE.floater.lossScaleBig : LOSS_SCALE;
const LOSS_BIG_FROM = JUICE.floater.lossBigFrom > 0 ? JUICE.floater.lossBigFrom | 0 : 3;
// Count-label backing plate (round-2 QA FX-10): one dark rounded quad under the digits so beams, flashes and same-font
// gate glyphs behind the label never merge with it (GDD §3.1 / pillar 5: the count is the most legible thing on screen).
const PLATE_ALPHA = JUICE.label.plateAlpha;   // opacity of PALETTE.glyph.outline over the world
const PLATE_PAD = JUICE.label.platePad;       // padding around the digit ink (label em)
const PLATE_INK_EM = 0.74;           // shape constant: digit ink + atlas outline height / glyph quad height (RENDER.atlas: (cap ≈ 72 + stroke 18) / 124 px)
const PLATE_RADIUS = 0.5;            // DATA-MISSING: JUICE.label.plateRadius — corner radius as a fraction of the plate's half height
const PLATE_INFLATE = 1.12;          // the quad is this much larger than the plate so the anti-aliased rim is never clipped
const PLATE_CEIL = 0.16;             // DATA-MISSING: JUICE.label.plateCeiling — linear cap of every colour channel under the plate
                                     // (HDR beams / tracers / flashes behind the digits; the plain road is darker and unaffected)
const PLATE_HALO_EM = 0.6;           // DATA-MISSING: JUICE.label.plateHalo — clamp margin around the plate (label em) …
const PLATE_HALO_CEIL = RENDER.bloom.threshold * 0.9;   // … where every channel is capped just under the bloom threshold, so a beam
                                     // passing the label seeds no bloom that would spill over the digits (the cap fades out over the
                                     // halo's outer 40 %)
const PLATE_HALO_FRAC = PLATE_HALO_EM / (PLATE_INK_EM + 2 * PLATE_PAD + 2 * PLATE_HALO_EM);   // halo / clamp-quad height
const PLATE_CEIL_OFF = 64;           // a cap this high leaves the scene untouched (fade-out: the cap rises with 1 − fade)
// fx text draw order (integers: a fractional renderOrder would generalise Object3D.renderOrder Smi → Double on the shared
// InstancedMesh map and deoptimise every module's code that touches an InstancedMesh, see F64): damage numbers 40, plate
// clamp 41 + plate 42 (above the world and the numbers), floaters 43 ("+N" / "−k" beside the label stay undimmed), label 44
const ORDER_NUMBERS = 40, ORDER_PLATE_CLAMP = 41, ORDER_PLATE = 42, ORDER_FLOATERS = 43, ORDER_LABEL = 44;
const PRIME_FRAMES = 900;            // _primeFeedback: simulated frames on the first title screen (15 s of fx time; see _primeMs)
const PRIME_WAVE = 45;               // … a spawn wave every 45 frames …
const PRIME_TAIL = 120;              // … none in the last 2 s, so every finite effect (scorch 1.5 s) has aged out
const LABEL_HIDE_S = 0.25;           // DATA-MISSING: JUICE.label.hideSeconds — label + plate fade out as the results / game-over panel opens (FX-11)
// V8 fixes an object field's representation from its first value: a field created from a Smi (0, −1) that later receives a
// fraction is generalised Smi → Double, which deprecates the object's map and deoptimises every function compiled against it
// (round-2 QA FX-14: fx then ran in baseline code, boxing every double ≈ 110 KB/s). Every field that holds fractions is created
// from this non-Smi seed first, so its representation is Double from the start (−0 behaves as 0 everywhere fx uses it).
const F64 = -0;
// Typed-OM sprite values: integer CSS px (Smis) and scale / opacity quantised to 1/256 and taken from this table of boxed
// numbers (PACKED_ELEMENTS: element loads return the existing HeapNumber, so passing one to the Typed-OM setter boxes nothing).
const SPRITE_Q = 256;
const SPRITE_Q_MAX = 4 * SPRITE_Q;   // scale ≤ 4
const SPRITE_QV = [''];
SPRITE_QV.length = 0;
for (let i = 0; i <= SPRITE_Q_MAX; i++) SPRITE_QV.push(i / SPRITE_Q);
const LABEL_DIGITS = JUICE.caps.labelQuads;   // 6
const LABEL_BADGE = JUICE.caps.badgeQuads;    // 3

// Glyph indices: 0–9 digits, then RENDER.atlas.rows[1] in order ('+', '−', '×', '÷', 'M', 'A', 'X', '.', '★', '⚡')
const GLYPH_CHARS = RENDER.atlas.rows[0].concat(RENDER.atlas.rows[1]);
const GLYPH_COUNT = GLYPH_CHARS.length;   // 20
const G_PLUS = 10, G_MINUS = 11, G_TIMES = 12, G_DIV = 13;

/** Character code → glyph index (−1 when the atlas has no glyph). Allocation-free. */
function glyphOfCode(code) {
  if (code >= 48 && code <= 57) return code - 48;                        // '0'–'9'
  switch (code) {
    case 43: return G_PLUS;                                               // '+'
    case 45: case 0x2212: return G_MINUS;                                 // '-' / '−'
    case 120: case 88: case 0xD7: case 42: return G_TIMES;                // 'x' / 'X' / '×' / '*' (the badge wants ×)
    case 47: case 0xF7: return G_DIV;                                     // '/' / '÷'
    case 77: return 14; case 65: return 15;                               // 'M' 'A'
    case 46: return 17; case 0x2605: return 18; case 0x26A1: return 19;   // '.' '★' '⚡'
    default: return -1;
  }
}

/**
 * Writes a signed integer as glyph indices into `out` at `o` (sign glyph first when `sign` ≥ 0).
 * Round 7: a value above NUMBER_MAX writes NUMBER_MAX followed by a '+' ("9999+", never a bare clamped 9999); when sign + digits
 * (+ that '+') exceed `max` quads the sign is dropped first. Returns the count.
 */
function writeNumberGlyphs(out, o, value, sign, max) {
  let v = Math.round(Math.abs(value));
  const over = v > NUMBER_MAX ? 1 : 0;
  if (over === 1) v = NUMBER_MAX;
  let digits = 1;
  for (let t = v; t >= 10; t = Math.floor(t / 10)) digits++;
  const useOver = over === 1 && digits + 1 <= max;
  const useSign = sign >= 0 && digits + 1 + (useOver ? 1 : 0) <= max;
  let n = 0;
  if (useSign) out[o + n++] = sign;
  for (let d = digits - 1; d >= 0; d--) {
    out[o + n + d] = v % 10;
    v = Math.floor(v / 10);
  }
  n += digits;
  if (useOver) out[o + n++] = G_PLUS;
  return n;
}

// ---------------------------------------------------------------------------------------------
// Fallback glyph shader (only when render.materials.glyph is unavailable — stub harness). Same layout.
// ---------------------------------------------------------------------------------------------
const FB_GLYPH_VERT = /* glsl */`
  attribute vec4 iGlyph; attribute float iPopTime; attribute vec3 iColor;
  varying vec2 vUv; varying vec3 vColor;
  void main() {
    vUv = vec2(mix(iGlyph.x, iGlyph.z, uv.x), mix(iGlyph.y, iGlyph.w, uv.y));
    vColor = iColor;
    #ifdef USE_INSTANCING
      mat4 im = instanceMatrix;
    #else
      mat4 im = mat4(1.0);
    #endif
    vec4 mv = modelViewMatrix * vec4(im[3].xyz, 1.0);
    mv.xy += position.xy * vec2(length(im[0].xyz), length(im[1].xyz));
    gl_Position = projectionMatrix * mv;
  }
`;
const FB_GLYPH_FRAG = /* glsl */`
  uniform sampler2D uAtlas; uniform float uHasAtlas;
  varying vec2 vUv; varying vec3 vColor;
  void main() {
    vec4 t = uHasAtlas > 0.5 ? texture2D(uAtlas, vUv) : vec4(1.0);
    float peak = max(vColor.r, max(vColor.g, vColor.b));
    float a = t.a * clamp(peak / 0.2, 0.0, 1.0);
    if (a < 0.004) discard;
    gl_FragColor = vec4(t.rgb / max(t.a, 0.0001) * vColor, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------------------------------------
// Count-label plate (FX-10): view-space billboard (same placement as the glyph quads) with a rounded-rectangle SDF.
// The instance scale is the quad size; the plate is that size / uInflate, corner radius uRadius × its half height.
// ---------------------------------------------------------------------------------------------
const PLATE_VERT = /* glsl */`
  varying vec2 vUv; varying vec2 vSize;
  void main() {
    vUv = uv;
    #ifdef USE_INSTANCING
      mat4 im = instanceMatrix;
    #else
      mat4 im = mat4(1.0);
    #endif
    vSize = vec2(length(im[0].xyz), length(im[1].xyz));
    vec4 mv = modelViewMatrix * vec4(im[3].xyz, 1.0);
    mv.xy += position.xy * vSize;
    gl_Position = projectionMatrix * mv;
  }
`;
const PLATE_FRAG = /* glsl */`
  uniform float uRadius;
  #ifdef PLATE_CLAMP
    uniform float uCeil; uniform float uCeilHalo; uniform float uHaloFrac;
  #else
    uniform vec3 uColor; uniform float uAlpha; uniform float uInflate;
  #endif
  varying vec2 vUv; varying vec2 vSize;
  void main() {
    #ifdef PLATE_CLAMP
      float halo = vSize.y * uHaloFrac;               // the quad = plate + a halo margin on every side
      vec2 hs = vSize * 0.5 - halo;
    #else
      vec2 hs = vSize * (0.5 / uInflate);
    #endif
    float r = min(hs.x, hs.y) * uRadius;
    vec2 q = abs((vUv - 0.5) * vSize) - (hs - r);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    float aa = max(fwidth(d), 1e-5);
    #ifdef PLATE_CLAMP
      // MIN blending: result = min(scene, cap). Under the plate the cap is uCeil; in the halo it is just under the bloom
      // threshold (nothing next to the digits seeds bloom over them) and rises to no cap at all over the halo's outer 40 %
      if (d > halo) discard;
      float t = max(0.0, d / halo - 0.6) / 0.4;
      float capOut = uCeilHalo * exp2(t * 7.0);
      gl_FragColor = vec4(vec3(mix(uCeil, capOut, smoothstep(-aa, aa, d))), 1.0);
    #else
      float cov = 1.0 - smoothstep(-aa, aa, d);
      if (cov < 0.003) discard;
      gl_FragColor = vec4(uColor, uAlpha * cov);
    #endif
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------------------------------------
// Rocket scorch (J21): dark, irregular ground mark with a glowing ember rim that cools in the first ~0.5 s.
// Normal blending — the shared decal material is additive and cannot darken the road. iScorch = (alpha, seed, heat).
// ---------------------------------------------------------------------------------------------
const SCORCH_VERT = /* glsl */`
  attribute vec3 iScorch;
  varying vec2 vUv; varying vec3 vS;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv; vS = iScorch;
    #ifdef USE_INSTANCING
      vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    #else
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    #endif
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;
const SCORCH_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform vec3 uEmber;
  varying vec2 vUv; varying vec3 vS;
  #include <fog_pars_fragment>
  void main() {
    vec2 c = (vUv - 0.5) * 2.0;
    float r = length(c);
    float s = vS.y * 6.2831853;
    float ang = atan(c.x, c.y);
    float rr = 0.8 + 0.1 * sin(ang * 5.0 + s) + 0.06 * sin(ang * 11.0 + s * 1.9) + 0.04 * sin(ang * 17.0 + s * 3.1);
    float q = r / rr;
    float blob = 1.0 - smoothstep(0.55, 1.0, q);                        // solid soot core, soft ragged edge
    float rays = 0.5 + 0.5 * sin(ang * 23.0 + s * 4.0);                 // streaks thrown out by the blast
    float streak = rays * (1.0 - smoothstep(0.9, 1.25, q)) * step(0.7, q) * 0.6;
    float a = max(blob, streak) * vS.x;
    float rim = smoothstep(0.35, 0.75, q) * (1.0 - smoothstep(0.8, 1.05, q));
    float heat = vS.z * rim;
    a = max(a, heat * 0.9);
    if (a < 0.003) discard;
    vec3 col = mix(uColor * (0.7 + 0.3 * q), uEmber, clamp(heat, 0.0, 1.0));
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

// ---------------------------------------------------------------------------------------------
// Module-level scratch (never retained across calls; §14 rule 2)
// ---------------------------------------------------------------------------------------------
const _color = new Color();
const _v = new Vector3();
const _q = new Quaternion();
const _m4 = new Matrix4();
const _axis = new Vector3();
const _pos = new Vector3();
const _scale = new Vector3();
const UV_OUT = { u0: -0, v0: -0, u1: 1, v1: 1, advance: 0.62 };
const SCREEN_OUT = { x: F64, y: F64 };       // worldToScreen output (Double fields from the start, see F64)
const TARGET_OUT = { x: F64, y: F64 };
const ICON_OUT = { x: F64 };                 // round 7: _clearOfLabel result (icon sprite x clear of the count label)
const ICON_LABEL_GAP_PX = 6;                 // round 7: gap kept between a rising J12 icon and the count label's plate (CSS px)
const ICON_TROOP_Y = 0.9;                    // round 7: a troop icon drops into the squad at this height (m) of its centre
const PRIME_TROOP_ITEM = PICKUPS.items.find((id) => id.indexOf('troop.') === 0) || null;   // round 7: warm-up of that path
const TICK_OPTS = { volume: LABEL_TICK_VOLUME, pitch: 1, value: 0 };
const LIN = new Float32Array(3);                 // hexToLinear output
const TRS = new Float64Array(6);                 // writeTRS inputs (x, y, z, sx, sy, sz)
const ROW = new Float32Array(7);                 // _writeRow inputs (ax, ay, az, h, r, g, b): no boxed double arguments per frame
const RS = new Uint32Array(1);                   // local xorshift32 state, seeded from ctx.rngFx at every reset (level start)

/** Local cosmetic random in [0, 1) (xorshift32 on RS; seeded from ctx.rngFx by Fx._reseed). Tiny so it inlines. */
function lrnd() {
  let s = RS[0];
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
  RS[0] = s;
  return (s >>> 0) / 4294967296;
}
const CAM = new Float32Array(12);                // camera basis: right(0..2) up(3..5) fwd(6..8) pos(9..11)
const DECAL_SLOTS = JUICE.caps.decals;

/** sRGB hex → linear RGB into LIN (scaled by gain). */
function hexToLinear(hex, gain) {
  _color.setHex(hex);
  LIN[0] = _color.r * gain; LIN[1] = _color.g * gain; LIN[2] = _color.b * gain;
}

/** sRGB hex → linear RGB into LIN, scaled so its largest component equals `peak` (bounded HDR / bloom). */
function hexToPeak(hex, peak) {
  _color.setHex(hex);
  const m = Math.max(_color.r, _color.g, _color.b);
  const k = m > 1e-4 ? peak / m : 0;
  LIN[0] = _color.r * k; LIN[1] = _color.g * k; LIN[2] = _color.b * k;
}

/**
 * Writes a translation + axis-aligned scale matrix (what the billboard glyph shader and the decal shader read) from
 * TRS = (x, y, z, sx, sy, sz): the doubles travel in the scratch array, so a call this function is not inlined into
 * boxes nothing (§14 rule 2; round-2 QA FX-14).
 */
function writeTRS(arr, o) {
  arr[o] = TRS[3]; arr[o + 1] = 0; arr[o + 2] = 0; arr[o + 3] = 0;
  arr[o + 4] = 0; arr[o + 5] = TRS[4]; arr[o + 6] = 0; arr[o + 7] = 0;
  arr[o + 8] = 0; arr[o + 9] = 0; arr[o + 10] = TRS[5]; arr[o + 11] = 0;
  arr[o + 12] = TRS[0]; arr[o + 13] = TRS[1]; arr[o + 14] = TRS[2]; arr[o + 15] = 1;
}

// Easing curves (same as util.js ease.*): module-level and tiny, so TurboFan / Maglev always inline them and no double
// argument or result is boxed on fx's per-frame paths (round-2 QA FX-14).
const BACK_S = 1.70158;               // Penner overshoot (util ease.outBack default)
function eOutQuad(t) { const u = 1 - t; return 1 - u * u; }
function eOutCubic(t) { const u = 1 - t; return 1 - u * u * u; }
function eInOutCubic(t) { if (t < 0.5) return 4 * t * t * t; const v = 2 - 2 * t; return 1 - v * v * v * 0.5; }
function eOutBack(t, s) { const u = t - 1; return 1 + u * u * ((s + 1) * u + s); }

/**
 * Shake noise: util.noise1 (C¹ value noise in [−1, 1]) with a 30-bit integer lattice hash, evaluated for SHAKE_N's three
 * sample points into SHAKE_N (no double crosses a call; hash30 returns a Smi).
 */
function hash30(i) {
  let h = Math.imul(i | 0, 0x27D4EB2D) ^ 0x165667B1;
  h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D);
  h = Math.imul(h ^ (h >>> 12), 0x297A2D39);
  h ^= h >>> 15;
  return h >>> 2;                     // 30 bits: always a Smi
}
const SHAKE_OFF = new Float64Array([0, 37.1, 71.7]);   // x, y, roll noise offsets (as before)
const SHAKE_N = new Float64Array(3);
const INV_2P30 = 1 / 1073741824;

/** Zero-scale matrix (an instance that draws nothing). */
function writeHidden(arr, o) {
  for (let k = 0; k < 16; k++) arr[o + k] = 0;
  arr[o + 15] = 1;
}

/**
 * Installed as a tagged attribute's clearUpdateRanges(): WebGLAttributes calls it after every ranged upload,
 * and emptying the array (length = 0) lets V8 drop its backing store, so the next push re-allocates. The one
 * persistent range record stays in updateRanges for the attribute's lifetime instead (same as models.js).
 */
function keepUpdateRanges() {}

/** Installed as onUploadCallback (called by WebGLAttributes after every upload): the pending range was consumed. */
function rangeUploaded() { this._grPending = false; }

/** Gives an attribute one persistent update-range object so per-frame uploads allocate nothing. */
function tagRange(attr) {
  attr._grRange = { start: 0, count: 0 };
  attr._grPending = false;
  attr.clearUpdateRanges = keepUpdateRanges;
  attr.onUploadCallback = rangeUploaded;
  return attr;
}

/**
 * needsUpdate + an update range covering items [lo, hi] (inclusive) without allocating: the attribute's own
 * range record lives permanently in updateRanges (pushed once); after an upload it is re-pointed at the new
 * range, while still pending (mesh hidden / not drawn yet) it is widened.
 */
function markItems(attr, lo, hi) {
  const s = attr.itemSize;
  const start = lo * s, end = (hi + 1) * s;
  const r = attr._grRange;
  const ranges = attr.updateRanges;
  if (ranges.length !== 1 || ranges[0] !== r) { ranges.length = 0; ranges.push(r); attr._grPending = false; }   // once
  if (!attr._grPending) {
    r.start = start; r.count = end - start;
    attr._grPending = true;
  } else {
    const e0 = r.start + r.count;
    if (start < r.start) r.start = start;
    r.count = (end > e0 ? end : e0) - r.start;
  }
  attr.needsUpdate = true;
}

/** Instance count + visibility: an empty pooled mesh is not projected, sorted or drawn at all. */
function setDrawCount(mesh, n) {
  mesh.count = n;
  mesh.visible = n > 0;
}

/** InstancedBufferAttribute (dynamic, tagged for markItems). */
function dynAttr(count, itemSize) {
  return tagRange(new InstancedBufferAttribute(new Float32Array(count * itemSize), itemSize).setUsage(DynamicDrawUsage));
}

/** Instanced mesh helper: dynamic matrix, count 0, never frustum-culled (§9.2). */
function makeInstanced(geo, mat, capacity, renderOrder) {
  const mesh = new InstancedMesh(geo, mat, capacity);
  tagRange(mesh.instanceMatrix.setUsage(DynamicDrawUsage));
  setDrawCount(mesh, 0);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/** prefers-reduced-motion media query (guarded, §14 rule 4); returns the MediaQueryList or null. */
function reducedMotionQuery() {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') return window.matchMedia('(prefers-reduced-motion: reduce)');
  } catch (_) { /* sandboxed frames may deny matchMedia */ }
  return null;
}

/** Increments ctx.debug.dropped[key] (debug overlay pool counters). */
function dropped(ctx, key) {
  const d = ctx.debug && ctx.debug.dropped;
  if (d) d[key] = (d[key] | 0) + 1;
}

// ---------------------------------------------------------------------------------------------
// DomSprite — one absolutely positioned DOM element moved every frame without JS garbage: CSS Typed OM
// (preallocated CSSUnitValues mutated in place) where available, string transforms otherwise (Safari < 16.4;
// documented fallback). Construction / show / hide happen on events, never per frame.
// ---------------------------------------------------------------------------------------------
class DomSprite {
  constructor(el, manageDisplay) {
    this._manage = manageDisplay !== false;   // false: an element fx only scales (the HUD coin icon), never hides
    this.el = el;
    this.shown = false;
    this._typed = false;
    // last written quantised values (Smis): an unchanged sprite writes no style (no Blink invalidation)
    this._qx = -1e6 | 0; this._qy = -1e6 | 0; this._qs = -1; this._qa = -1;
    try {
      const g = typeof globalThis !== 'undefined' ? globalThis : null;
      if (g && typeof g.CSSTranslate === 'function' && typeof g.CSSScale === 'function' && typeof g.CSSTransformValue === 'function'
          && g.CSS && typeof g.CSS.px === 'function' && typeof g.CSS.number === 'function' && el.attributeStyleMap) {
        this._tx = g.CSS.px(0); this._ty = g.CSS.px(0); this._s = g.CSS.number(1); this._o = g.CSS.number(1);
        this._tv = new g.CSSTransformValue([new g.CSSTranslate(this._tx, this._ty), new g.CSSScale(this._s, this._s)]);
        el.attributeStyleMap.set('transform', this._tv);
        el.attributeStyleMap.set('opacity', this._o);
        this._typed = true;
      }
    } catch (_) { this._typed = false; }
    if (this._manage) this.hide();
  }

  show() { if (!this.shown) { this.shown = true; if (this._manage) this.el.style.display = 'block'; } }
  hide() { this.shown = false; if (this._manage) this.el.style.display = 'none'; }

  /**
   * Moves the sprite centre to (x, y) CSS px (container space) at scale s and opacity a. Positions round to whole px and
   * scale / opacity to 1/SPRITE_Q, all handed to Typed OM as Smis or pre-boxed table numbers (no per-frame allocation,
   * round-2 QA FX-14); a sprite whose quantised values did not change writes nothing.
   */
  move(x, y, s, a) {
    const xi = Math.round(x) | 0, yi = Math.round(y) | 0;
    let si = Math.round(s * SPRITE_Q) | 0, ai = Math.round(a * SPRITE_Q) | 0;
    if (si < 0) si = 0; else if (si > SPRITE_Q_MAX) si = SPRITE_Q_MAX;
    if (ai < 0) ai = 0; else if (ai > SPRITE_Q) ai = SPRITE_Q;
    if (xi === this._qx && yi === this._qy && si === this._qs && ai === this._qa) return;
    const opacityChanged = ai !== this._qa;
    this._qx = xi; this._qy = yi; this._qs = si; this._qa = ai;
    if (this._typed) {
      try {
        this._tx.value = xi; this._ty.value = yi; this._s.value = SPRITE_QV[si];
        const m = this.el.attributeStyleMap;
        m.set('transform', this._tv);
        if (opacityChanged) { this._o.value = SPRITE_QV[ai]; m.set('opacity', this._o); }
        return;
      } catch (_) { this._typed = false; }
    }
    // string fallback (allocates a short string per moving sprite per frame; only where Typed OM is missing)
    this.el.style.transform = 'translate3d(' + xi + 'px,' + yi + 'px,0) scale(' + (si / SPRITE_Q).toFixed(3) + ')';
    if (opacityChanged) this.el.style.opacity = (ai / SPRITE_Q).toFixed(3);
  }
}

// ---------------------------------------------------------------------------------------------
// CountLabel — the squad count ticker (GDD §5). Display D chases the true count C: gains roll up with an
// ease-out-cubic tween (one tick per JUICE.label.tickMs), a 1.4× punch settling on a 0.25 s spring and a
// green flash; losses snap with a 0.8× punch and a red flash; multiplier passes show an "x3" badge beside
// the number before the roll-up. Six digit quads + three badge quads, one draw, drawn on top of the world
// at a constant screen size (SQUAD.label.px). Driven ONLY by Fx's event listeners; squad only calls
// setWorldPos (once per frame, from squad.render), which is also where the quads are written.
// ---------------------------------------------------------------------------------------------
class CountLabel {
  constructor(fx) {
    this._fx = fx;
    // fraction-holding fields are created from F64 (Double representation from the start, see F64)
    this.target = 0;            // true count C (latest value the driver asked for)
    this.shown = F64;           // display D (float while tweening)
    this.from = F64;
    this.tweenT = F64;
    this.tweenDur = F64;        // > 0 while rolling up
    this.now = F64;             // label clock (real seconds, frozen while paused)
    this.punchT = F64; this.punchT = 1;   // normalised spring time (≥ 1 = settled)
    this.punchAmp = F64;        // punch − 1 (+0.4 up, −0.2 down)
    this.flashT = F64;
    this.flashDur = F64;
    this.flashRGB = new Float32Array(3);
    this.badgeN = 0;
    this.badgeGlyph = new Uint8Array(LABEL_BADGE);
    this.badgeT = F64;          // seconds since the badge appeared
    this.badgeHideAt = F64; this.badgeHideAt = -1;   // label clock time the badge pops out (−1 = hidden)
    this.tickAcc = F64;
    this.lastTickInt = -1;
    this.x = F64; this.y = F64; this.z = F64;
    this.hasPos = false;
    this.mPerPx = 0.01;         // metres per CSS px at the label (shared with the "+N" burst floaters)
    this.height = 0.5;          // current glyph height (m)
    this.width = 0.5;           // round-3 FTUE: plate width (m: digit run + padding) — gates' label-yield test reads it
    this.plateH = 0.5;          // round-3 FTUE: plate height (m)
    this.digits = new Uint8Array(LABEL_DIGITS);
    this.nDigits = 1;
    this.shownInt = -1;
    this.glyphDirty = true;
  }

  /** Absolute count, no roll-up (level start): a gentle bounce, no flash (GDD §1.1 "5 bounces once"). */
  setCount(n) {
    const v = clamp(Math.round(n) || 0, 0, SQUAD.countCap);
    this.target = v; this.shown = v; this.from = v;
    this.tweenDur = 0; this.tweenT = 0;
    this.flashDur = 0;
    if (this.badgeN > 0) { this.badgeN = 0; this.glyphDirty = true; }
    this.badgeHideAt = -1;
    this._punch(LABEL_START_BOUNCE);
    this._fx._labelPending = -1;
  }

  /** Gain: roll D up to n over min(tweenMax, tweenPer·|n − D|), punch 1.4×, green flash (GDD §5). */
  tweenTo(n) {
    const v = clamp(Math.round(n) || 0, 0, SQUAD.countCap);
    if (v < this.shown - 1e-6) { this.snapTo(v); return; }
    this.target = v;
    const d = v - this.shown;
    if (d <= 1e-6) return;
    const J = JUICE.label;
    this.from = this.shown;
    this.tweenT = 0;
    this.tweenDur = Math.max(1 / 60, Math.min(J.tweenMax, J.tweenPer * d));
    this.tickAcc = 0;
    this._punch(J.punchUp);
    this._flash(PALETTE.flash.gain, J.flashUp);
    if (this.badgeHideAt >= 0) {
      const end = this.now + this.tweenDur + BADGE_HOLD_EXTRA_S;
      if (end > this.badgeHideAt) this.badgeHideAt = end;
    }
  }

  /** Loss: D snaps to n, punch 0.8×, red flash (GDD §5). While a roll-up is still below n it retargets. */
  snapTo(n) {
    const v = clamp(Math.round(n) || 0, 0, SQUAD.countCap);
    if (v === this.target && this.tweenDur === 0 && v === Math.round(this.shown)) return;
    this.target = v;
    if (this.tweenDur > 0 && v > this.shown) {
      this.from = this.shown; this.tweenT = 0;
      this.tweenDur = Math.max(1 / 60, Math.min(JUICE.label.tweenMax, JUICE.label.tweenPer * (v - this.shown)));
    } else {
      this.shown = v; this.from = v; this.tweenDur = 0;
    }
    this._punch(JUICE.label.punchDown);
    this._flash(PALETTE.flash.loss, JUICE.label.flashDown);
  }

  /** "x3" badge beside the number for `seconds` (+ the roll-up that follows). `text` like 'x3' / '×2'. */
  showMult(text, seconds) {
    const s = typeof text === 'string' ? text : String(text);
    let n = 0;
    for (let i = 0; i < s.length && n < LABEL_BADGE; i++) {
      const g = glyphOfCode(s.charCodeAt(i));
      if (g >= 0) this.badgeGlyph[n++] = g;
    }
    this._badge(n, seconds);
  }

  /** Allocation-free showMult for the driver: × + the multiplier value. */
  _showMultValue(value, seconds) {
    this.badgeGlyph[0] = G_TIMES;
    const n = 1 + writeNumberGlyphs(this.badgeGlyph, 1, value, -1, LABEL_BADGE - 1);
    this._badge(n, seconds);
  }

  _badge(n, seconds) {
    this.badgeN = n;
    this.badgeT = 0;
    this.badgeHideAt = n > 0 ? this.now + Math.max(0, seconds) + BADGE_HOLD_EXTRA_S : -1;
    this.glyphDirty = true;
  }

  _punch(scale) { this.punchAmp = scale - 1; this.punchT = 0; }

  _flash(hex, seconds) {
    hexToPeak(hex, LABEL_FLASH_PEAK);   // bounded: a 2.0 HDR flash blooms over the outline on High (FX-1)
    this.flashRGB[0] = LIN[0]; this.flashRGB[1] = LIN[1]; this.flashRGB[2] = LIN[2];
    this.flashDur = seconds; this.flashT = 0;
  }

  /** Clears every animation (Fx.reset); the count itself is re-set by squad's 'start' event. */
  _clear() {
    this.target = 0; this.shown = 0; this.from = 0; this.tweenDur = 0; this.tweenT = 0;
    this.punchT = 1; this.punchAmp = 0; this.flashDur = 0; this.flashT = 0;
    this.badgeN = 0; this.badgeHideAt = -1; this.tickAcc = 0; this.lastTickInt = -1;
    this.shownInt = -1; this.glyphDirty = true;
  }

  /** Advances tween / spring / flash / badge on the label clock (rdt = real seconds, 0 while paused). */
  _advance(rdt) {
    this.now += rdt;
    if (this.tweenDur > 0) {
      this.tweenT += rdt;
      const u = this.tweenT >= this.tweenDur ? 1 : this.tweenT / this.tweenDur;
      this.shown = this.from + (this.target - this.from) * eOutCubic(u);
      // roll-up ticks: at most one per tickMs, only while the displayed integer is changing
      this.tickAcc += rdt;
      const tickS = JUICE.label.tickMs / 1000;
      if (this.tickAcc >= tickS) {
        this.tickAcc -= tickS * Math.floor(this.tickAcc / tickS);
        const ti = Math.round(this.shown);
        if (ti !== this.lastTickInt) {
          this.lastTickInt = ti;
          this._fx._labelTick(u);
        }
      }
      if (u >= 1) { this.shown = this.target; this.tweenDur = 0; }
    }
    if (this.punchT < 1) this.punchT += rdt / JUICE.label.spring;
    if (this.flashDur > 0) {
      this.flashT += rdt;
      if (this.flashT >= this.flashDur) this.flashDur = 0;
    }
    if (this.badgeHideAt >= 0) {
      this.badgeT += rdt;
      if (this.now >= this.badgeHideAt && this.tweenDur === 0) { this.badgeHideAt = -1; this.badgeN = 0; this.glyphDirty = true; }
    }
    const si = Math.round(this.shown);
    if (si !== this.shownInt) {
      this.shownInt = si;
      this.nDigits = writeNumberGlyphs(this.digits, 0, si, -1, LABEL_DIGITS);
      this.glyphDirty = true;
    }
  }

  /** Current punch scale (damped spring: 1 + a·e^(−5u)·cos(3πu) over JUICE.label.spring). */
  _scale() {
    const u = this.punchT;
    if (u >= 1) return 1;
    return 1 + this.punchAmp * Math.exp(-5 * u) * Math.cos(3 * Math.PI * u);
  }

  /** World anchor from squad.render (every frame); writes the label quads. */
  setWorldPos(x, y, z) {
    if (!(x === x && y === y && z === z)) return;   // NaN guard (a bad anchor would poison mPerPx for the "+N" bursts)
    this.x = x; this.y = y; this.z = z;
    this.hasPos = true;
    this._fx._writeLabel(this);
  }
}

// ---------------------------------------------------------------------------------------------
// Fx
// ---------------------------------------------------------------------------------------------
const GATE_KEYS = ['plus', 'mult', 'minus', 'div', 'zero', 'item'];   // GATE_RULES.colors key order
const PANEL_CENTER_Y = GATE_RULES.panel.bottom + GATE_RULES.panel.h * 0.5;
const SH_STRIDE = 18;   // shard SoA stride: x y z vx vy vz ax ay az ang spin age life sx sy r g b

export class Fx {
  constructor(ctx) {
    this.ctx = ctx;
    // the label object exists from construction on: squad caches ctx.fx.label in its init()
    this.label = new CountLabel(this);
    this._inited = false;
    this._priming = false;      // true only inside _primeFeedback (boot warm-up)
    this._primed = false;       // the warm-up runs once, on the first 'title' state
    this._primeMs = F64;
    this._cam = null;           // render.camera / render.size, cached by _camera()
    this._rsize = null;
    this._offs = null;
    this._labelPending = F64; this._labelPending = -1;   // real seconds until the delayed roll-up after a multiplier badge (−1 = none)
    this._labelHideT = F64; this._labelHideT = -1;       // FX-11: seconds into the results / game-over fade-out (−1 = none)
    this._introFade = F64; this._introFade = 1;          // round-3 FTUE: label opacity while the boss-intro dolly runs (1 = shown)
    this._renderRef = null;                              // ctx.render, cached on first use (render.dollying)
    this._lastCount = 0;        // latest squad:count.count
  }

  // ===========================================================================================
  // init — every pool at its High capacity (§14 rule 3), GPU objects, DOM sprites, listeners
  // ===========================================================================================
  init() {
    const ctx = this.ctx;
    const render = ctx.render || null;
    this._scene = render && render.scene ? render.scene : null;
    const sharedTime = render && render.uniforms && render.uniforms.uTime ? render.uniforms.uTime : null;
    this._uTime = sharedTime || { value: 0 };
    this._ownTime = sharedTime === null;
    this._ownGeos = [];
    this._ownMats = [];
    this._meshes = [];

    // clocks / camera / screen state
    // fraction-holding fields are created from F64 (Double representation from the start, see F64)
    this._real = F64;               // real seconds since init (DOM flights, merge windows)
    this._shakeT = F64;
    this._trauma = F64;
    this._fovAmp = F64; this._fovT = F64; this._fovDur = F64;
    this._desatT = F64; this._desatT = -1;
    this._bloomT = F64; this._bloomT = -1;
    this._hitBudget = HIT_SPARK_BURSTS_PER_FRAME;
    this._lastHaptic = F64; this._lastHaptic = -1e9;
    this._boosterOn = false;
    this._labelVisible = false;
    this._lossF = -1; this._lossTime = F64; this._lossTime = -1e9; this._lossK = 0;
    this._biteVigAt = F64; this._biteVigAt = -1e9;   // round 7: real time of the last bite / spit vignette (JUICE.flashes.biteVignetteGap)
    this._lastHitDmg = F64; this._lastHitStamp = -1; this._lastHitAcc = -1; this._hitStamp = 0;
    this._shieldDecal = -1;
    this._pCap = PARTICLES_PER_MESH;
    this._fallbackSeed = 0x9E3779B9 >>> 0;

    this._buildParticles(render);
    this._buildGlyphs(render);
    this._buildDecals(render);
    this._buildShards();
    this._buildBeams();
    this._buildScorch();
    this._buildDom();
    if (this._scene) for (let i = 0; i < this._meshes.length; i++) this._scene.add(this._meshes[i]);

    // colour / pattern tables (init-time allocations)
    this._weaponColor = new Map();
    const wk = Object.keys(WEAPONS);
    for (let i = 0; i < wk.length; i++) this._weaponColor.set(WEAPONS[wk[i]].id, WEAPONS[wk[i]].color);
    const gk = Object.keys(GEAR);
    for (let i = 0; i < gk.length; i++) this._weaponColor.set(GEAR[gk[i]].id, GEAR[gk[i]].color);
    const gapMs = Math.max(0, Math.round(JUICE.ui.starStagger * 1000) - JUICE.haptics.star);
    this._starPatterns = [null, [JUICE.haptics.star], [JUICE.haptics.star, gapMs, JUICE.haptics.star],
      [JUICE.haptics.star, gapMs, JUICE.haptics.star, gapMs, JUICE.haptics.star]];
    // count label: plain white at JUICE.label.gain (not the glyph HDR gain) so the atlas outline stays crisp under bloom
    hexToLinear(PALETTE.glyph.fill, LABEL_GAIN);
    this._white = new Float32Array([LIN[0], LIN[1], LIN[2]]);
    hexToPeak(PALETTE.gate.mult.tint, LABEL_BADGE_PEAK);
    this._badgeRGB = new Float32Array([LIN[0], LIN[1], LIN[2]]);

    this._readSettings();
    this._applyQuality(ctx.quality && ctx.quality.params ? ctx.quality.params : null);
    this._labelVisible = this._labelStateOk(ctx.state && ctx.state.current);
    this._subscribe();
    this._inited = true;
    this.reset();
    return this;
  }

  /**
   * Type-feedback / JIT warm-up (round-2 QA FX-14), the analogue of render's shader warm-up, run once from _onState on the
   * first 'title' state (every system exists then): PRIME_FRAMES simulated frames exercise every per-frame branch of
   * fx's pools (particles of each kind incl. confetti, the three shatter modes, scorch, beam, every
   * decal kind with fade-in / fade-out / free, floaters, tracked + untracked numbers, the label roll-up / flash / badge,
   * shake, FOV kick, coin and icon flights) and ages them all out. Without it, the first boss death, first gate pass,
   * first rocket … reaches a branch the optimised code has no feedback for and deoptimises it, and fx then runs for
   * seconds in baseline code, where every double is boxed. Internal methods only (no events, haptics, audio or ui
   * calls; the DOM flight sprites it moves are hidden again before the browser paints); the caller resets right after.
   */
  _primeFeedback() {
    const L = this.label;
    const wasVisible = this._labelVisible;
    this._priming = true;
    try {
      // PRIME_FRAMES simulated 60 Hz frames: a spawn wave every PRIME_WAVE frames, the rest ages everything out; the
      // per-frame paths also run often enough to reach optimised code before the first level (≈ 30–60 ms at boot)
      const sh = { x: F64, y: F64, roll: F64 };
      let lane = -1;
      for (let f = 0; f < PRIME_FRAMES; f++) {
        if (f % PRIME_WAVE === 0 && f < PRIME_FRAMES - PRIME_TAIL) lane = this._primeWave(f);
        if (lane >= 0 && f % PRIME_WAVE === PRIME_WAVE >> 1) { this.removeDecal(lane); lane = -1; }
        this.update(1 / 60, 1 / 60);
        this._labelVisible = (f & 7) !== 7;   // both _writeLabel paths (squad also renders it while hidden, e.g. on the title)
        L.setWorldPos(0.5 + f * 0.001, 2.6, 0.8);
        this.getShake(sh);
        this.getFovKick();
        if ((f & 15) === 0) void this.particleCount;
      }
    } catch (err) { this._primeError = err; /* best effort: the warm-up never blocks boot (kept for the debug console) */ }
    this._priming = false;
    this._labelVisible = wasVisible;
    this._trauma = 0; this._fovDur = 0; this._fovAmp = 0;
  }

  /** One _primeFeedback spawn wave (every pool, every branch); returns the lane-highlight decal id to remove later. */
  _primeWave(f) {
    const L = this.label;
    for (let m = 0; m < 2; m++) { const pm = this._pm[m]; if (f === PRIME_WAVE) pm.next = this._pCap - 1; }   // ring wrap-around path
    for (let k = 0; k < KIND_COUNT; k++) this._emitRaw(k, 2, 0.5, 1.5, -6.5, 0, 0.5, 0, 1.5, 0.5, 0.25, 0.15, -9.8, 0.5, k === K_CONFETTI ? -1 : C_SPARK);
    for (let b = 0; b < BURST_COUNT.length; b++) this._burstColored(b, 0.5, 1.5, -6.5, BURST_COLOR[b], 0.05);
    this._shatter(0.5, -6.5, GATE_RULES.panel.w, GATE_RULES.panel.h, PALETTE.flash.gain, SHATTER_TOWARD);
    this._shatter(0.5, -6.5, GATE_RULES.panel.w, GATE_RULES.panel.h, PALETTE.flash.loss, SHATTER_AWAY);
    this._shatter(0.5, -6.5, GATE_RULES.panel.w, GATE_RULES.panel.h, PALETTE.flash.loss, SHATTER_NEUTRAL);
    this._spawnScorch(0.5, -6.5, SCORCH_SIZE);
    this._spawnBeam(0.5, 1.5, 2.5, 0.5, 1.0, -8.5);
    const ring = this._allocDecal(D_RING, 0.5, -6.5, 2, 0.6, C_SPARK, false, false);
    this._allocDecal(D_LANE, 0.5, -6.5, 2, 0.6, C_SPARK, false, true);
    this._allocDecal(D_SPLAT, 0.5, -6.5, 2, 0.6, C_ACID, false, true);
    this._allocDecal(D_XBAND, 0.5, -6.5, 2, 0.6, C_SPARK, false, false);
    // round 7: the over-the-formation mesh (fx.decalsTop) and the brute swipe kind
    this._allocDecal(D_RING, 0.5, -6.5, 2, 0.6, C_SPARK, false, false, 1);
    this._allocDecal(D_ARC, 0.5, -6.5, 2, 0.6, C_ACID, false, false, 1);
    this._allocDecal(D_SWIPE, 0.5, -6.5, 2, 0.6, FX_COLOR.brute, false, false, 1);
    const lane = this._allocDecal(D_LANE, 0.5, -6.5, 2, Infinity, C_SPARK, true, false);
    this.moveDecal(ring, 0.7, -6.4); this.decalProgress(ring, 0.5 + f * 1e-3);
    this._floaterNum(12, G_PLUS, 0.5, 1.5, -6.5, PALETTE.flash.gain, 1.2, 0.7, 0.6, LABEL_TEXT_PEAK);
    this.floater('-3', 0.5, 1.5, -6.5, PALETTE.glyph.fill);
    const lf = this._floaterNum(1, G_MINUS, 0.5, LOSS_FLOATER_Y, -6.5, PALETTE.flash.loss, JUICE.floater.rise, JUICE.floater.life, JUICE.floater.size, LABEL_TEXT_PEAK);
    if (lf >= 0) { this._fFollow[lf] = 1; this._fSide[lf] = (f & 1) === 0 ? this._lossSide() : 1; }   // "−k" beside the label, both sides
    this._numberSpawn(37.5, 0.5, 2.5, -6.5, PALETTE.glyph.fill, NUMBER_BOSS_SCALE, NUMBER_GAIN, -2);
    this._numberSpawn(12.5, 0.5, 2.5, -6.5, PALETTE.glyph.fill, 1, NUMBER_GAIN, 0);
    this._numberSpawn(88.5, 0.5, 2.5, -6.5, PALETTE.gate.max, NUMBER_CRIT_SCALE, NUMBER_CRIT_GAIN, -1);
    this._numberSpawn(12345.5, 0.5, 2.5, -6.5, PALETTE.gate.max, NUMBER_CRIT_SCALE, NUMBER_CRIT_GAIN, -1);   // round 7: the "9999+" path
    this._accDamage(0, true, 3.5, 0.5, 2.5, -6.5);   // flushed by update's merge-window check
    this._accDamage(1, false, 2.5, 0.5, 2.5, -6.5);
    this._accDamage(1, false, 9998.5, 0.5, 2.5, -6.5);   // round 7: a merge past NUMBER_MAX flushes first
    this._labelVisible = true;
    L.setCount(5); L.tweenTo(23 + (f & 7)); L._showMultValue(3, 0.05); L.snapTo(21);
    this.addTrauma(0.5);
    this.fovKick(1, 0.2);
    if (this._coinSprites.length > 0) this._launchCoins(0.5, 1, -6.5, 2, 0);
    if (this._iconSprites.length > 0 && PICKUPS.items.length > 0) this.iconFlight(PICKUPS.items[0], 0.5, 0.8, -6.5);
    if (this._iconSprites.length > 1 && PRIME_TROOP_ITEM) this.iconFlight(PRIME_TROOP_ITEM, 0.5, 0.8, -6.5);   // round 7: the troop drop path
    return lane;
  }

  // ---- particles ------------------------------------------------------------------------------
  _buildParticles(render) {
    const mats = render && render.materials ? render.materials : null;
    this._pm = [null, null];   // 0 additive, 1 normal
    for (let m = 0; m < 2; m++) {
      const variant = m === 0 ? 'add' : 'norm';
      let mat = null;
      if (mats && typeof mats.particle === 'function') { try { mat = mats.particle(variant); } catch (_) { mat = null; } }
      if (!mat) { mat = makeParticleMaterial(this.ctx, variant); this._ownMats.push(mat); }
      this._linkTime(mat);
      mat.forceSinglePass = true;   // camera-facing quads: three's DoubleSide+transparent two-pass path would re-resolve the program twice a frame
      const N = PARTICLES_PER_MESH;
      const geo = new PlaneGeometry(1, 1);
      this._ownGeos.push(geo);
      const p0 = dynAttr(N, 3), v0 = dynAttr(N, 3), life = dynAttr(N, 4), kind = dynAttr(N, 4);
      const deathMs = new Int32Array(N);   // CPU copy of each particle's death time (ms, Smi): particleCount reads no doubles
      geo.setAttribute('p0', p0); geo.setAttribute('v0', v0); geo.setAttribute('pLife', life); geo.setAttribute('pKind', kind);
      const mesh = makeInstanced(geo, mat, N, m === 0 ? 31 : 30);
      mesh.name = m === 0 ? 'fx.particlesAdd' : 'fx.particlesNorm';
      this._meshes.push(mesh);
      this._pm[m] = { mesh, aP0: p0, aV0: v0, aLife: life, aKind: kind, p0: p0.array, v0: v0.array, life: life.array, kind: kind.array, next: 0, high: 0, liveUntil: F64, deathMs };
    }
    this.particlesAdd = this._pm[0].mesh;
    this.particlesNorm = this._pm[1].mesh;
  }

  /** Makes sure a (possibly library-cached) fx material reads THE shared uTime (built before render.uniforms existed → re-link). */
  _linkTime(mat) {
    if (mat && mat.uniforms && mat.uniforms.uTime && mat.uniforms.uTime !== this._uTime) mat.uniforms.uTime = this._uTime;
  }

  // ---- digit-atlas quads: floaters, damage numbers, the count label --------------------------
  _buildGlyphs(render) {
    // glyph UV / advance / aspect cache (TextureFactory.glyphUV, or the ARCH §6.3 layout as fallback)
    this._gUV = new Float32Array(GLYPH_COUNT * 4);
    this._gAdv = new Float32Array(GLYPH_COUNT);
    this._gAsp = new Float32Array(GLYPH_COUNT);
    const tex = render && render.textures ? render.textures : null;
    const atlasW = RENDER.textures.digitAtlas[0], atlasH = RENDER.textures.digitAtlas[1];
    const cellW = RENDER.atlas.cell[0], cellH = RENDER.atlas.cell[1], inset = RENDER.atlas.insetPx;
    for (let g = 0; g < GLYPH_COUNT; g++) {
      const ch = GLYPH_CHARS[g];
      let ok = false;
      if (tex && typeof tex.glyphUV === 'function') {
        try { tex.glyphUV(ch, UV_OUT); ok = Number.isFinite(UV_OUT.u0) && UV_OUT.u1 > UV_OUT.u0; } catch (_) { ok = false; }
      }
      if (!ok) {
        const row = g < 10 ? 0 : 1, col = g < 10 ? g : g - 10;
        UV_OUT.u0 = (col * cellW + inset) / atlasW;
        UV_OUT.u1 = ((col + 1) * cellW - inset) / atlasW;
        UV_OUT.v1 = 1 - (row * cellH + inset) / atlasH;
        UV_OUT.v0 = 1 - ((row + 1) * cellH - inset) / atlasH;
        const adv = RENDER.atlas.advance;
        UV_OUT.advance = g < 10 ? adv.digit : (adv[ch] !== undefined ? adv[ch] : adv.digit);
      }
      this._gUV[g * 4] = UV_OUT.u0; this._gUV[g * 4 + 1] = UV_OUT.v0; this._gUV[g * 4 + 2] = UV_OUT.u1; this._gUV[g * 4 + 3] = UV_OUT.v1;
      this._gAdv[g] = UV_OUT.advance > 0 ? UV_OUT.advance : RENDER.atlas.advance.digit;
      const du = Math.abs(UV_OUT.u1 - UV_OUT.u0) * atlasW, dv = Math.abs(UV_OUT.v1 - UV_OUT.v0) * atlasH;
      this._gAsp[g] = dv > 0 ? du / dv : (cellW - 2 * inset) / (cellH - 2 * inset);
    }

    // one fx glyph material (billboard), drawn on top of the world (text is HUD-like information)
    const mats = render && render.materials ? render.materials : null;
    let mat = null;
    if (mats && typeof mats.glyph === 'function') {
      try {
        const base = mats.glyph(true);
        if (base && base.uniforms && base.uniforms.uBillboard) {
          mat = base.clone();
          if (base.uniforms.uTime) mat.uniforms.uTime = base.uniforms.uTime;               // re-link the shared clock
          if (base.uniforms.uAtlas) mat.uniforms.uAtlas = base.uniforms.uAtlas;            // share the atlas (no texture clone)
          mat.uniforms.uBillboard.value = 1;
        }
      } catch (_) { mat = null; }
    }
    if (!mat) {
      const atlas = tex && tex.digitAtlas ? tex.digitAtlas : null;
      mat = new ShaderMaterial({
        name: 'gr.fx.glyph.fallback', vertexShader: FB_GLYPH_VERT, fragmentShader: FB_GLYPH_FRAG,
        uniforms: { uAtlas: { value: atlas }, uHasAtlas: { value: atlas ? 1 : 0 } },
        transparent: true, side: DoubleSide,
      });
    }
    mat.depthTest = false;
    mat.forceSinglePass = true;
    mat.depthWrite = false;
    mat.transparent = true;
    this._ownMats.push(mat);
    this._glyphMat = mat;

    const mk = (capacity, order, name) => {
      const geo = new PlaneGeometry(1, 1);
      this._ownGeos.push(geo);
      const iGlyph = dynAttr(capacity, 4), iColor = dynAttr(capacity, 3);
      const iPop = new InstancedBufferAttribute(new Float32Array(capacity), 1);   // static 0: never pops
      geo.setAttribute('iGlyph', iGlyph); geo.setAttribute('iColor', iColor); geo.setAttribute('iPopTime', iPop);
      const mesh = makeInstanced(geo, mat, capacity, order);
      mesh.name = name;
      this._meshes.push(mesh);
      return { mesh, aGlyph: iGlyph, aColor: iColor, glyph: iGlyph.array, color: iColor.array, mat4: mesh.instanceMatrix.array };
    };
    // every floater / number owns MAX_TEXT consecutive quads (round 7: 5), so a mesh never holds fewer than pool × MAX_TEXT
    this._fl = mk(Math.max(JUICE.caps.floaterQuads, JUICE.caps.floaters * MAX_TEXT), ORDER_FLOATERS, 'fx.floaters');
    this._nb = mk(Math.max(JUICE.caps.numberQuads, JUICE.caps.damageNumbers * MAX_TEXT), ORDER_NUMBERS, 'fx.numbers');
    this._lb = mk(LABEL_DIGITS + LABEL_BADGE, ORDER_LABEL, 'fx.label');
    this.floaters = this._fl.mesh; this.numbers = this._nb.mesh; this.labelMesh = this._lb.mesh;
    this._buildPlate();
    // Round-2 FX-10 residual (cross-group): the count label and its plate draw in render's post-bloom overlay pass
    // (render.overlayLayer), so the bloom haze of an HDR beam behind the label never lands on the digits. The HDR
    // clamp draws in BOTH passes: in the main pass (as before) it keeps the scene under / around the plate from seeding
    // bloom, and again after bloom it caps whatever haze still reached the plate. Floaters stay on layer 0 too (their
    // HDR tint still blooms in the main pass) and are drawn again in the overlay pass, above the plate and undimmed by
    // the clamp (the "−k" sits inside the clamp halo). Without the layer (an older render.js) everything stays in the
    // main pass as before.
    const ol = render && typeof render.overlayLayer === 'number' ? render.overlayLayer : -1;
    if (ol >= 0) {
      this.labelClamp.layers.enable(ol);
      this.labelPlate.layers.set(ol);
      this.labelMesh.layers.set(ol);
      this.floaters.layers.enable(ol);
    }

    // floater pool (SoA)
    const F = JUICE.caps.floaters;
    this._fAlive = new Uint8Array(F); this._fN = new Uint8Array(F); this._fGlyph = new Uint8Array(F * MAX_TEXT);
    this._fX = new Float32Array(F); this._fY = new Float32Array(F); this._fZ = new Float32Array(F);
    this._fRise = new Float32Array(F); this._fLife = new Float32Array(F); this._fSize = new Float32Array(F); this._fAge = new Float32Array(F);
    this._fRGB = new Float32Array(F * 3);
    this._fFollow = new Uint8Array(F);   // 1 = "−k" anchored beside the count label (offsets recomputed per frame)
    this._fSide = new Int8Array(F);      // −1 = left of the label (default), +1 = right (label near the left screen edge)
    this._fTop = 0;
    // damage-number pool (SoA)
    const D = JUICE.caps.damageNumbers;
    this._nAlive = new Uint8Array(D); this._nN = new Uint8Array(D); this._nGlyph = new Uint8Array(D * MAX_TEXT);
    this._nX = new Float32Array(D); this._nY = new Float32Array(D); this._nZ = new Float32Array(D);
    this._nScale = new Float32Array(D); this._nAge = new Float32Array(D); this._nRGB = new Float32Array(D * 3);
    this._nRise = new Float32Array(D);   // rise height (m): boss numbers rise further
    this._nBoss = new Uint8Array(D);     // 1 = a tracked-target number (boss / brute: one per grid slot, NUMBER_TRACK_SLOTS per target)
    this._nTargetId = new Int32Array(D); // −2 = boss, ≥ 0 = brute id
    this._nBorn = new Float64Array(D);   // spawn sequence number — a target's newest number picks the next slot
    this._nSeq = 0;
    this._nSlot = new Uint8Array(D);     // grid slot of a tracked number (column = slot & 1, row = slot >> 1)
    this._nFollow = new Uint8Array(D);   // rides along with its target: 1 = the boss (ctx.world.bossX / bossZ), 2 = a brute (zombies.position)
    this._nAX = new Float32Array(D); this._nAZ = new Float32Array(D);   // boss anchor at spawn (follow offset base)
    this._bossLX = F64; this._bossLZ = F64;                             // boss anchor this frame (last known once it is gone)
    this._nTop = 0;
    // damage-number merge accumulators (per target)
    this._naId = new Int32Array(NUMBER_ACC_SLOTS).fill(-1);
    this._naSum = new Float32Array(NUMBER_ACC_SLOTS);
    this._naX = new Float32Array(NUMBER_ACC_SLOTS); this._naY = new Float32Array(NUMBER_ACC_SLOTS); this._naZ = new Float32Array(NUMBER_ACC_SLOTS);
    this._naT0 = new Float64Array(NUMBER_ACC_SLOTS);
    this._naBoss = new Uint8Array(NUMBER_ACC_SLOTS);
    this._naWin = new Float32Array(NUMBER_ACC_SLOTS);   // this accumulation's merge window (jittered around NUMBER_FLUSH_S)
  }

  /**
   * Count-label backing plate (FX-10): two camera-facing rounded rectangles (InstancedMesh of 1 each, billboarded like the
   * glyphs, sharing one instance matrix; depthTest off). First `fx.labelClamp` (MIN blending) caps every colour channel
   * under the plate at PLATE_CEIL, so an HDR laser / tracer / flash behind the digits can neither shine through nor seed
   * bloom there; then `fx.labelPlate` lays PALETTE.glyph.outline over it at uAlpha (JUICE.label.plateAlpha). The instance
   * scale carries the quad size (the shader derives the rounded-rect size from it); both hide with the label.
   */
  _buildPlate() {
    const geo = new PlaneGeometry(1, 1);
    this._ownGeos.push(geo);
    hexToLinear(PALETTE.glyph.outline, 1);
    const mat = new ShaderMaterial({
      name: 'gr.fx.labelPlate', vertexShader: PLATE_VERT, fragmentShader: PLATE_FRAG,
      uniforms: {
        uColor: { value: new Color().setRGB(LIN[0], LIN[1], LIN[2], LinearSRGBColorSpace) }, uAlpha: { value: PLATE_ALPHA },
        uInflate: { value: PLATE_INFLATE }, uRadius: { value: PLATE_RADIUS },
      },
      transparent: true, depthTest: false, depthWrite: false, blending: NormalBlending,
    });
    const clampMat = new ShaderMaterial({
      name: 'gr.fx.labelClamp', vertexShader: PLATE_VERT, fragmentShader: PLATE_FRAG, defines: { PLATE_CLAMP: 1 },
      uniforms: { uCeil: { value: PLATE_CEIL }, uCeilHalo: { value: PLATE_HALO_CEIL }, uHaloFrac: { value: PLATE_HALO_FRAC }, uRadius: { value: PLATE_RADIUS } },
      transparent: true, depthTest: false, depthWrite: false,
      blending: CustomBlending, blendEquation: MinEquation, blendEquationAlpha: MinEquation, blendSrc: OneFactor, blendDst: OneFactor,
    });
    mat.forceSinglePass = true; clampMat.forceSinglePass = true;
    this._ownMats.push(mat, clampMat);
    const mesh = makeInstanced(geo, mat, 1, ORDER_PLATE);
    mesh.name = 'fx.labelPlate';
    const clampMesh = makeInstanced(geo, clampMat, 1, ORDER_PLATE_CLAMP);
    clampMesh.name = 'fx.labelClamp';
    this._meshes.push(clampMesh, mesh);
    this.labelPlate = mesh;
    this.labelClamp = clampMesh;
    this._plateAlpha = mat.uniforms.uAlpha;   // { value } — written per frame (Double field from the 0.45 seed)
    this._plateCeil = clampMat.uniforms.uCeil;
    this._plateCeilHalo = clampMat.uniforms.uCeilHalo;
    this._plateFade = F64; this._plateFade = 1;   // fade the plate uniforms were last written for
  }

  /** Draw count of the plate pair (0 = hidden, 1 = drawn). */
  _plateCount(n) {
    setDrawCount(this.labelPlate, n);
    setDrawCount(this.labelClamp, n);
  }

  // ---- decals -----------------------------------------------------------------------------------
  _buildDecals(render) {
    const mats = render && render.materials ? render.materials : null;
    let mat = null;
    if (mats && typeof mats.decal === 'function') { try { mat = mats.decal(); } catch (_) { mat = null; } }
    if (!mat) { mat = makeDecalMaterial(this.ctx); this._ownMats.push(mat); }
    this._linkTime(mat);
    mat.forceSinglePass = true;   // flat ground quads: one pass (no back/front double draw + program churn)
    const N = DECAL_SLOTS;
    const geo = new PlaneGeometry(1, 1);
    this._ownGeos.push(geo);
    const iDecal = dynAttr(N, 4), iDecalB = dynAttr(N, 4);
    geo.setAttribute('iDecal', iDecal); geo.setAttribute('iDecalB', iDecalB);
    const mesh = makeInstanced(geo, mat, N, 1);
    mesh.name = 'fx.decals';
    this._meshes.push(mesh);
    this.decals = mesh;
    this._dAttr = iDecal; this._dAttrB = iDecalB;
    // Round 7 (r7 boss telegraph visibility: "the slam ring and the stripes must stay visible over a big formation"): telegraphs
    // that sit ON the formation (decal(…, onTop = true): slam ring, charge stripe, car band, acid marks, the brute swipe) draw in a
    // second mesh whose material is a clone of the same decal material with depthTest off — the same shaders, so the same program
    // (no new variant), sharing the uniform objects (clock, fog, colours). A 150-soldier squad's bodies no longer hide the ring's
    // rim and fill. Additive, drawn with the other renderOrder-1 transparents, so particles and numbers still draw over it. The
    // lane highlight, splats, the shield gauge and the stomp ring stay depth-tested in `fx.decals`.
    const topMat = mat.clone();
    topMat.uniforms = mat.uniforms;
    topMat.depthTest = false;
    topMat.depthWrite = false;
    topMat.forceSinglePass = true;
    topMat.name = 'gr.fx.decals.top';
    this._ownMats.push(topMat);
    const geoT = new PlaneGeometry(1, 1);
    this._ownGeos.push(geoT);
    const iDecalT = dynAttr(N, 4), iDecalBT = dynAttr(N, 4);
    geoT.setAttribute('iDecal', iDecalT); geoT.setAttribute('iDecalB', iDecalBT);
    const meshT = makeInstanced(geoT, topMat, N, 1);
    meshT.name = 'fx.decalsTop';
    this._meshes.push(meshT);
    this.decalsTop = meshT;
    this._dAttrT = iDecalT; this._dAttrBT = iDecalBT;
    this._dActive = new Uint8Array(N); this._dGen = new Uint32Array(N).fill(1); this._dKind = new Uint8Array(N);
    this._dX = new Float32Array(N); this._dZ = new Float32Array(N); this._dSize = new Float32Array(N); this._dProg = new Float32Array(N);
    this._dSec = new Float32Array(N); this._dAge = new Float32Array(N); this._dSeed = new Float32Array(N); this._dColor = new Uint8Array(N);
    this._dReserved = new Uint8Array(N); this._dRoad = new Uint8Array(N); this._dAuto = new Uint8Array(N);
    this._dTop = new Uint8Array(N);      // round 7: 1 = drawn in fx.decalsTop (over the formation)
  }

  // ---- panel shards -------------------------------------------------------------------------------
  _buildShards() {
    const N = JUICE.caps.shards;
    const models = this.ctx.models;
    let geo = models && models.geo && models.geo.shard ? models.geo.shard : null;
    if (!geo) { geo = new BoxGeometry(SHARD_BOX[0], SHARD_BOX[1], SHARD_BOX[2]); this._ownGeos.push(geo); }
    const mat = new MeshBasicMaterial({
      color: 0xFFFFFF, transparent: true, opacity: 1, depthWrite: false, side: DoubleSide, toneMapped: false, blending: AdditiveBlending,
    });
    mat.name = 'gr.fx.shards';
    // additive: the per-instance colour carries the (1 − u)² fade (MeshBasicMaterial has no per-instance alpha) and
    // the draw is order-independent, so one pass is enough — transparent + DoubleSide without forceSinglePass takes
    // three's back-then-front path (2 draws, material.version bumped twice → program re-resolution every frame)
    mat.forceSinglePass = true;
    this._ownMats.push(mat);
    const mesh = makeInstanced(geo, mat, N, 32);
    mesh.instanceColor = dynAttr(N, 3);
    mesh.name = 'fx.shards';
    this._meshes.push(mesh);
    this.shards = mesh;
    this._sh = new Float32Array(N * SH_STRIDE);
    this._shAlive = new Uint8Array(N);
    this._shNext = 0;
  }

  // ---- rocket scorch marks (normal-blend ground decals, J21) ---------------------------------------
  _buildScorch() {
    const geo = new PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);   // lies on the road, faces up
    this._ownGeos.push(geo);
    const iScorch = dynAttr(SCORCH_POOL, 3);
    geo.setAttribute('iScorch', iScorch);
    hexToLinear(SCORCH_HEX, 1);
    const uniforms = UniformsUtils.merge([UniformsLib.fog, { uColor: { value: new Color(LIN[0], LIN[1], LIN[2]) }, uEmber: { value: new Color() } }]);
    hexToLinear(PALETTE.fx.rocket !== undefined ? PALETTE.fx.rocket : 0xFF7A2F, SCORCH_EMBER_GAIN);
    uniforms.uEmber.value.setRGB(LIN[0], LIN[1], LIN[2], LinearSRGBColorSpace);
    const mat = new ShaderMaterial({
      name: 'gr.fx.scorch', vertexShader: SCORCH_VERT, fragmentShader: SCORCH_FRAG, uniforms,
      transparent: true, depthWrite: false, depthTest: true, blending: NormalBlending, fog: true,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    this._ownMats.push(mat);
    const mesh = makeInstanced(geo, mat, SCORCH_POOL, 0);
    mesh.name = 'fx.scorch';
    this._meshes.push(mesh);
    this.scorch = mesh;
    this._scAttr = iScorch;
    this._scAlive = new Uint8Array(SCORCH_POOL);
    this._scX = new Float32Array(SCORCH_POOL); this._scZ = new Float32Array(SCORCH_POOL);
    this._scSize = new Float32Array(SCORCH_POOL); this._scAge = new Float32Array(SCORCH_POOL); this._scSeed = new Float32Array(SCORCH_POOL);
  }

  // ---- sniper tracer lines -------------------------------------------------------------------------
  _buildBeams() {
    const geo = new BoxGeometry(1, 1, 1);
    this._ownGeos.push(geo);
    const mat = new MeshBasicMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false });
    const t = PALETTE.tracer.sniper;
    mat.color.setRGB(t[0], t[1], t[2], LinearSRGBColorSpace);   // HDR triplet is already linear (never double-converted)
    mat.name = 'gr.fx.beams';
    this._ownMats.push(mat);
    const mesh = makeInstanced(geo, mat, BEAM_POOL, 33);
    mesh.name = 'fx.beams';
    this._meshes.push(mesh);
    this.beams = mesh;
    this._bAlive = new Uint8Array(BEAM_POOL);
    this._bP = new Float32Array(BEAM_POOL * 6);
    this._bAge = new Float32Array(BEAM_POOL);
  }

  // ---- DOM coin / icon sprites (inside #coin-flights) -------------------------------------------
  _buildDom() {
    this._coinSprites = [];
    this._iconSprites = [];
    this._iconItem = [];
    this._iconUrl = new Map();
    this._hudCoin = null;
    this._domOffX = F64; this._domOffY = F64;
    const CF = JUICE.caps.coinFlights, IF = JUICE.caps.iconFlights;
    this._cfAlive = new Uint8Array(CF); this._cfT = new Float32Array(CF); this._cfDur = new Float32Array(CF);
    this._cfN = new Uint16Array(CF);         // coins carried by this sprite (pool full → merged into the youngest flight)
    this._cfAmt = new Float32Array(CF);      // credited coins this sprite carries to the HUD (ui holds them back until it lands)
    this._coinsInFlight = F64;               // Σ _cfAmt of live sprites (read by ui through the coinsInFlight getter)
    this._cfP = new Float32Array(CF * 6);     // sx sy cx cy tx ty
    this._ifAlive = new Uint8Array(IF); this._ifPhase = new Uint8Array(IF); this._ifT = new Float32Array(IF);
    this._ifP = new Float32Array(IF * 7);     // wx wy wz sx sy tx ty
    this._ifBorn = new Float64Array(IF);
    this._ifTroop = new Uint8Array(IF);       // round 7: 1 = a troop (no HUD pill) — its icon drops into the squad
    this._ifDx = new Float32Array(IF);        // round 7: sideways offset (CSS px) that keeps the rising icon clear of the count label
    this._ifDxSet = new Uint8Array(IF);       // … decided once, on the flight's first frame
    this._punchT = F64; this._punchT = -1;
    let doc = null;
    try { doc = typeof document !== 'undefined' ? document : null; } catch (_) { doc = null; }
    if (!doc) return;
    let box = null;
    try { box = doc.getElementById('coin-flights'); } catch (_) { box = null; }
    if (!box) return;
    this._domBox = box;
    const hexCss = (hex) => '#' + (hex >>> 0).toString(16).padStart(6, '0');
    const coinBg = 'radial-gradient(circle at 35% 30%, #FFF6C8 0%, ' + hexCss(PALETTE.props.coin) + ' 48%, ' + hexCss(PALETTE.props.coinEmissive) + ' 100%)';
    for (let i = 0; i < CF; i++) {
      const el = doc.createElement('div');
      el.className = 'fx-coin';
      el.setAttribute('aria-hidden', 'true');
      const s = el.style;
      s.position = 'absolute'; s.left = '0'; s.top = '0';
      s.width = COIN_PX + 'px'; s.height = COIN_PX + 'px';
      s.marginLeft = (-COIN_PX / 2) + 'px'; s.marginTop = (-COIN_PX / 2) + 'px';
      s.borderRadius = '50%'; s.background = coinBg;
      s.boxShadow = '0 0 8px rgba(255,210,63,0.85), inset 0 -2px 0 rgba(0,0,0,0.28), inset 0 0 0 2px ' + hexCss(PALETTE.ui.primaryBorder);
      s.pointerEvents = 'none'; s.willChange = 'transform, opacity';
      box.appendChild(el);
      this._coinSprites.push(new DomSprite(el, true));
    }
    const tex = this.ctx.render && this.ctx.render.textures ? this.ctx.render.textures : null;
    for (let i = 0; i < IF; i++) {
      const el = doc.createElement('img');
      el.className = 'fx-icon';
      el.alt = '';
      el.setAttribute('aria-hidden', 'true');
      el.draggable = false;
      const s = el.style;
      s.position = 'absolute'; s.left = '0'; s.top = '0';
      s.width = ICON_PX + 'px'; s.height = ICON_PX + 'px';
      s.marginLeft = (-ICON_PX / 2) + 'px'; s.marginTop = (-ICON_PX / 2) + 'px';
      s.pointerEvents = 'none'; s.willChange = 'transform, opacity';
      s.filter = 'drop-shadow(0 2px 4px rgba(0,0,0,0.55))';
      box.appendChild(el);
      this._iconSprites.push(new DomSprite(el, true));
      this._iconItem.push('');
    }
    // icon data URLs drawn once now (TextureFactory caches them; no canvas work during play)
    if (tex && typeof tex.iconDataURL === 'function') {
      const items = PICKUPS.items;
      for (let i = 0; i < items.length; i++) {
        let url = '';
        try { url = tex.iconDataURL(items[i], ICON_PX * 2) || ''; } catch (_) { url = ''; }
        if (url) this._iconUrl.set(items[i], url);
      }
    }
    try {
      const app = this.ctx.app || null;
      const hud = app && typeof app.querySelector === 'function' ? app.querySelector('#coins .coin-icon') : doc.querySelector('#coins .coin-icon');
      if (hud) this._hudCoin = new DomSprite(hud, false);
    } catch (_) { this._hudCoin = null; }
    this._measureDom();
  }

  /** Container offset inside #app (flight coordinates are app-space CSS px). Event-time only (resize). */
  _measureDom() {
    const box = this._domBox, app = this.ctx.app;
    if (!box || !app || typeof box.getBoundingClientRect !== 'function' || typeof app.getBoundingClientRect !== 'function') return;
    try {
      const a = app.getBoundingClientRect(), b = box.getBoundingClientRect();
      this._domOffX = b.left - a.left; this._domOffY = b.top - a.top;
    } catch (_) { this._domOffX = 0; this._domOffY = 0; }
  }

  // ---- settings / quality ---------------------------------------------------------------------------
  _readSettings() {
    const s = this.ctx.save && this.ctx.save.settings ? this.ctx.save.settings : null;
    this._haptics = s ? s.haptics !== false : true;
    this._rmSetting = s && (s.reducedMotion === true || s.reducedMotion === false) ? s.reducedMotion : null;
    if (!this._mq) {
      this._mq = reducedMotionQuery();
      if (this._mq) {
        const self = this;
        this._mqFn = function onReducedMotionQuery() { self._updateReduced(); };
        try {
          if (typeof this._mq.addEventListener === 'function') this._mq.addEventListener('change', this._mqFn);
          else if (typeof this._mq.addListener === 'function') this._mq.addListener(this._mqFn);
        } catch (_) { /* old engines */ }
      }
    }
    this._updateReduced();
  }

  _updateReduced() {
    let mq = false;
    try { mq = !!(this._mq && this._mq.matches); } catch (_) { mq = false; }
    this._reduced = this._rmSetting === null ? mq : this._rmSetting;
    if (this._reduced) { this._fovDur = 0; }
  }

  _applyQuality(params) {
    const p = params && typeof params.particles === 'number' ? params.particles : PARTICLES_PER_MESH * 2;
    let cap = Math.floor(p / 2);
    if (cap < 16) cap = 16;
    if (cap > PARTICLES_PER_MESH) cap = PARTICLES_PER_MESH;
    this._pCap = cap;
    for (let m = 0; m < 2; m++) {
      const pm = this._pm[m];
      if (!pm) continue;
      if (pm.next >= cap) pm.next = 0;
      setDrawCount(pm.mesh, pm.high < cap ? pm.high : cap);
    }
  }

  /** States that show the count label: play and pause only — the results / game-over panels show no gameplay HUD
   *  numbers (GDD §9.3 / §14; round-2 QA FX-11). Entering 'complete' / 'gameover' fades it out (_onState). */
  _labelStateOk(state) {
    return state === 'playing' || state === 'paused';
  }

  /** Hides the label quads and their plate now (no fade). */
  _hideLabel() {
    this._labelHideT = -1;
    setDrawCount(this._lb.mesh, 0);
    this._plateCount(0);
  }

  // ===========================================================================================
  // reset — level-start state, allocation-free, idempotent (§6 common shape)
  // ===========================================================================================
  reset() {
    if (!this._inited) return;
    // particles: drop the drawn range (old attribute data is never drawn again: count covers new writes only)
    for (let m = 0; m < 2; m++) { const pm = this._pm[m]; pm.next = 0; pm.high = 0; pm.liveUntil = 0; setDrawCount(pm.mesh, 0); }
    // text
    this._fAlive.fill(0); this._fTop = 0; setDrawCount(this._fl.mesh, 0);
    this._nAlive.fill(0); this._nTop = 0; setDrawCount(this._nb.mesh, 0);
    this._naId.fill(-1);
    this._lossF = -1; this._lossK = 0; this._lossTime = -1e9; this._biteVigAt = -1e9;
    this._lastHitStamp = -1; this._lastHitAcc = -1;
    this.label._clear();
    this._labelPending = -1;
    this._lastCount = 0;
    this._hideLabel();
    // decals (every live id becomes stale)
    for (let i = 0; i < DECAL_SLOTS; i++) if (this._dActive[i]) this._freeDecal(i);
    setDrawCount(this.decals, 0);
    setDrawCount(this.decalsTop, 0);
    this._shieldDecal = -1;
    // shards / beams
    this._shAlive.fill(0); this._shNext = 0; setDrawCount(this.shards, 0);
    this._bAlive.fill(0); setDrawCount(this.beams, 0);
    this._scAlive.fill(0); setDrawCount(this.scorch, 0);
    // DOM flights
    this._cfAlive.fill(0); this._ifAlive.fill(0);
    this._cfAmt.fill(0); this._coinsInFlight = 0;
    for (let i = 0; i < this._coinSprites.length; i++) this._coinSprites[i].hide();
    for (let i = 0; i < this._iconSprites.length; i++) this._iconSprites[i].hide();
    if (this._punchT >= 0 && this._hudCoin) this._hudCoin.move(0, 0, 1, 1);
    this._punchT = -1;
    // camera / screen
    this._trauma = 0; this._fovDur = 0; this._fovAmp = 0; this._fovT = 0;
    this._desatT = -1;
    if (this._bloomT >= 0) {
      this._bloomT = -1;
      const r = this.ctx.render;
      // round 5 (docs/DISTRICTS.md §8.7): no argument = the district's bloom base (RENDER.bloom.strength is District 1's)
      if (r && typeof r.setBloomStrength === 'function') r.setBloomStrength();
    }
    this._hitBudget = HIT_SPARK_BURSTS_PER_FRAME;
    this._boosterOn = false;
    // the cosmetic xorshift stream is seeded once per run from the level's rngFx (a draw per emit returned a boxed double)
    this._reseed();
  }

  // ===========================================================================================
  // dispose — listeners, scene objects, owned GPU resources, DOM sprites
  // ===========================================================================================
  dispose() {
    if (this._offs) { for (let i = 0; i < this._offs.length; i++) { try { this._offs[i](); } catch (_) { /* ignore */ } } this._offs = null; }
    if (this._mq && this._mqFn) {
      try {
        if (typeof this._mq.removeEventListener === 'function') this._mq.removeEventListener('change', this._mqFn);
        else if (typeof this._mq.removeListener === 'function') this._mq.removeListener(this._mqFn);
      } catch (_) { /* ignore */ }
      this._mq = null; this._mqFn = null;
    }
    if (this._meshes) {
      for (let i = 0; i < this._meshes.length; i++) {
        const m = this._meshes[i];
        if (m.parent) m.parent.remove(m);
        if (typeof m.dispose === 'function') m.dispose();
      }
      this._meshes.length = 0;
    }
    if (this._ownGeos) { for (let i = 0; i < this._ownGeos.length; i++) this._ownGeos[i].dispose(); this._ownGeos.length = 0; }
    if (this._ownMats) { for (let i = 0; i < this._ownMats.length; i++) this._ownMats[i].dispose(); this._ownMats.length = 0; }
    const sprites = this._coinSprites ? this._coinSprites.concat(this._iconSprites) : [];
    for (let i = 0; i < sprites.length; i++) { const el = sprites[i].el; if (el && el.parentNode) el.parentNode.removeChild(el); }
    if (this._hudCoin) { try { this._hudCoin.move(0, 0, 1, 1); } catch (_) { /* ignore */ } }
    this._coinSprites = []; this._iconSprites = []; this._hudCoin = null; this._domBox = null;
    this._inited = false;
  }

  // ===========================================================================================
  // update — step C of the frame (§4.2). dt = scaled frame dt (0 while paused), unscaledDt = real.
  // ===========================================================================================
  update(dt, unscaledDt) {
    if (!this._inited) return;
    const ctx = this.ctx;
    const udt = unscaledDt > 0 ? unscaledDt : 0;
    const sdt = dt > 0 ? dt : 0;
    const rdt = sdt > 0 ? udt : 0;          // real time that freezes while paused (world-anchored text, shake)
    this._real += udt;
    this._hitBudget = HIT_SPARK_BURSTS_PER_FRAME;
    if (this._ownTime) this._uTime.value = ctx.time ? ctx.time.elapsed : this._uTime.value + sdt;
    this._readCamera();
    // particle meshes whose every particle has died stop drawing (and the ring restarts at 0)
    const tm = ctx.time;
    const simNow = tm && typeof tm.elapsed === 'number' ? tm.elapsed : this._uTime.value;
    for (let m = 0; m < 2; m++) {
      const pm = this._pm[m];
      if (pm.high > 0 && simNow >= pm.liveUntil) { pm.high = 0; pm.next = 0; setDrawCount(pm.mesh, 0); }
    }

    // shake / FOV kick (real time)
    if (this._trauma > 0 && rdt > 0) {
      this._trauma -= JUICE.shake.decay * rdt;
      if (this._trauma < 0) this._trauma = 0;
    }
    this._shakeT += rdt;
    if (this._fovDur > 0) { this._fovT += rdt; if (this._fovT >= this._fovDur) { this._fovDur = 0; this._fovAmp = 0; } }

    // count label: delayed roll-up after a multiplier badge, then the ticker itself
    if (this._labelPending >= 0) {
      this._labelPending -= rdt;
      if (this._labelPending < 0) { this._labelPending = -1; this.label.tweenTo(this._lastCount); }
    }
    this.label._advance(rdt);
    if (this._labelHideT >= 0) {            // FX-11 fade-out on the results / game-over screen (real time: the panel may pause the world)
      this._labelHideT += udt;
      if (this._labelHideT >= LABEL_HIDE_S) { this._labelVisible = false; this._hideLabel(); }
    }
    // round-3 FTUE: the boss-intro dolly swings the camera to the boss and drops the squad under the letterbox bar, which
    // clipped the label into a stray digit in the corner — it fades out (LABEL_HIDE_S) while render.dollying and back in
    // once the camera has returned (the fight starts with it); reduced motion has no dolly, so the label stays
    let rr = this._renderRef;
    if (rr === null) { rr = this.ctx.render || null; this._renderRef = rr; }
    const introTarget = rr !== null && rr.dollying === true ? 0 : 1;
    if (this._introFade !== introTarget) {
      const st = udt / LABEL_HIDE_S;
      this._introFade = introTarget > this._introFade ? Math.min(1, this._introFade + st) : Math.max(0, this._introFade - st);
    }
    if (!this._labelVisible || !this.label.hasPos) { setDrawCount(this._lb.mesh, 0); this._plateCount(0); }

    // boss-anchored numbers ride along with the boss; a mirror switch to the other twin (a jump) re-bases them in place
    const wb = ctx.world;
    if (wb && wb.bossActive) {
      const jx = wb.bossX - this._bossLX, jz = wb.bossZ - this._bossLZ;
      if (jx * jx + jz * jz > BOSS_ANCHOR_SNAP * BOSS_ANCHOR_SNAP) {
        for (let k = 0; k < this._nTop; k++) if (this._nFollow[k] === 1) { this._nAX[k] += jx; this._nAZ[k] += jz; }
      }
      this._bossLX = wb.bossX; this._bossLZ = wb.bossZ;
    }
    this._flushNumbers(false);
    this._updateFloaters(rdt);
    this._updateNumbers(rdt);
    this._updateDecals(sdt);
    this._updateShards(sdt);
    this._updateBeams(udt);
    this._updateScorch(sdt);
    this._updateFlights(udt, sdt);
    this._updateRamps(udt);
  }

  /** Camera basis (right, up, forward, position) from the camera's world matrix (last frame's: render.update runs after). */
  _readCamera() {
    const cam = this._camera();
    if (!cam) { CAM[0] = 1; CAM[1] = 0; CAM[2] = 0; CAM[3] = 0; CAM[4] = 1; CAM[5] = 0; CAM[6] = 0; CAM[7] = 0; CAM[8] = -1; CAM[9] = 0; CAM[10] = 10; CAM[11] = 12; return; }
    const e = cam.matrixWorld.elements;
    CAM[0] = e[0]; CAM[1] = e[1]; CAM[2] = e[2];
    CAM[3] = e[4]; CAM[4] = e[5]; CAM[5] = e[6];
    CAM[6] = -e[8]; CAM[7] = -e[9]; CAM[8] = -e[10];
    CAM[9] = e[12]; CAM[10] = e[13]; CAM[11] = e[14];
  }

  /**
   * render.camera, cached on first use (render builds it once in init): the per-frame paths read the camera and
   * render.size through these cached references, not through the RenderSystem object, so a field generalisation on
   * render's own map (it has several, round-2 QA FX-14 notes) does not deoptimise fx.
   */
  _camera() {
    let cam = this._cam;
    if (cam === null) {
      const r = this.ctx.render;
      cam = r && r.camera ? r.camera : null;
      this._cam = cam;
      if (this._rsize === null && r && r.size) this._rsize = r.size;
    }
    return cam;
  }

  /** Simulation clock that matches the shared uTime (ctx.time.elapsed). Event-time / tooling only: per-frame paths
   *  read it inline (SIM_NOW pattern) so the double is never returned across a call. */
  _simNow() {
    const t = this.ctx.time;
    return t && typeof t.elapsed === 'number' ? t.elapsed : this._uTime.value;
  }

  /** Cosmetic random in [0, 1): ctx.rngFx (re-seeded per run by level), else a private LCG (stub harness). */
  _rnd() {
    const r = this.ctx.rngFx;
    if (r && typeof r.next === 'function') return r.next();
    this._fallbackSeed = (Math.imul(this._fallbackSeed, 1664525) + 1013904223) >>> 0;
    return this._fallbackSeed / 4294967296;
  }

  /** Seeds the local xorshift (lrnd) from the cosmetic stream: one rngFx draw per reset (level start), never per emit. */
  _reseed() {
    const v = (this._rnd() * 4294967296) >>> 0;
    RS[0] = v !== 0 ? v : 0x9E3779B9;
  }

  /** Coins credited by coin:pickup whose J19 sprite has not reached the HUD icon yet (ui counts them up on arrival). */
  get coinsInFlight() { return this._coinsInFlight > 0 ? this._coinsInFlight : 0; }

  /** Read-only live particle count (engine debug overlay, 4 Hz; not a hot path). */
  get particleCount() {
    if (!this._inited) return 0;
    const tm = this.ctx.time;
    const now = tm && typeof tm.elapsed === 'number' ? tm.elapsed : this._uTime.value;
    const nowMs = (now * 1000) | 0;
    let n = 0;
    for (let m = 0; m < 2; m++) {
      const pm = this._pm[m];
      const top = pm.mesh.count;
      const DM = pm.deathMs;   // integer ms (births are ≤ now: a particle is born when it is emitted)
      for (let i = 0; i < top; i++) if (DM[i] > nowMs) n++;
    }
    return n;
  }

  // ===========================================================================================
  // GPU particles — CPU writes the attributes once per spawned particle into a ring buffer
  // ===========================================================================================

  /**
   * Spawns `count` particles of `kind` at (x, y, z). Without opts every kind uses its visual defaults
   * (random direction biased upward, the kind's speed / life / size / gravity, riding the road scroll).
   * opts (all optional): vx, vy, vz base velocity (m/s; when any is given the caller owns the velocity and
   * no road carry is added), spread (m/s of random velocity added), size (m), colorIdx (FX colour index),
   * life (s), gravity (m/s² along +y). The opts object is read, never retained.
   */
  emit(kind, x, y, z, count, opts) {
    if (!this._inited) return;
    const k = typeof kind === 'number' ? kind : PARTICLE_KIND[kind];
    if (k === undefined || k < 0 || k >= KIND_COUNT) return;
    const n = count | 0;
    if (n <= 0) return;
    const has = opts !== undefined && opts !== null;
    const life = has && typeof opts.life === 'number' && opts.life > 0 ? opts.life : P_LIFE[k];
    const size = has && typeof opts.size === 'number' && opts.size > 0 ? opts.size : P_SIZE[k];
    const spread = has && typeof opts.spread === 'number' ? opts.spread : P_SPEED[k];
    const grav = has && typeof opts.gravity === 'number' ? opts.gravity : P_GRAVITY[k];
    const hasVx = has && typeof opts.vx === 'number', hasVy = has && typeof opts.vy === 'number', hasVz = has && typeof opts.vz === 'number';
    const explicit = hasVx || hasVy || hasVz;
    const road = this.ctx.world ? this.ctx.world.roadSpeed : 0;
    const carry = explicit ? 0 : P_CARRY[k] * road;
    const col = has && typeof opts.colorIdx === 'number' && opts.colorIdx >= 0 ? opts.colorIdx | 0 : P_COLOR[k];
    this._emitRaw(k, n, x, y, z, hasVx ? opts.vx : 0, hasVy ? opts.vy : 0, hasVz ? opts.vz : 0, spread, explicit ? 0 : P_UP[k], life, size, grav, carry, col);
  }

  /** Low-level spawn (no defaults). colorIdx −1 = a random confetti colour per particle. */
  _emitRaw(k, count, x, y, z, bvx, bvy, bvz, spread, up, life, size, grav, carry, colorIdx) {
    const pm = this._pm[PARTICLE_ADDITIVE[k] ? 0 : 1];
    const cap = this._pCap;
    const n = count > cap ? cap : count;
    const tm = this.ctx.time;
    const birth = tm && typeof tm.elapsed === 'number' ? tm.elapsed : this._uTime.value;
    const P = pm.p0, V = pm.v0, L = pm.life, K = pm.kind, DM = pm.deathMs;
    const jitterPos = k === K_MUZZLE ? 0 : size * 0.3;
    let i = pm.next >= cap ? 0 : pm.next;
    const lo = i;
    let wrapped = false;
    for (let c = 0; c < n; c++) {
      const theta = lrnd() * Math.PI * 2;
      const u2 = lrnd();
      const cy = (2 * u2 - 1) * (1 - up) + u2 * up;
      const sy = Math.sqrt(Math.max(0, 1 - cy * cy));
      const sp = spread * (0.35 + 0.65 * lrnd());
      const o3 = i * 3, o4 = i * 4;
      P[o3] = x + (lrnd() - 0.5) * jitterPos;
      P[o3 + 1] = y + (lrnd() - 0.5) * jitterPos;
      P[o3 + 2] = z + (lrnd() - 0.5) * jitterPos;
      V[o3] = bvx + Math.cos(theta) * sy * sp;
      V[o3 + 1] = bvy + cy * sp;
      V[o3 + 2] = bvz + Math.sin(theta) * sy * sp;
      L[o4] = birth;
      const lf = life * (1 + (lrnd() * 2 - 1) * P_JITTER);
      L[o4 + 1] = lf;
      DM[i] = ((birth + lf) * 1000) | 0;
      L[o4 + 2] = size * (1 + (lrnd() * 2 - 1) * P_JITTER);
      L[o4 + 3] = colorIdx >= 0 ? colorIdx : C_CONFETTI0 + Math.floor(lrnd() * C_CONFETTI_N);
      K[o4] = k; K[o4 + 1] = grav; K[o4 + 2] = lrnd(); K[o4 + 3] = carry;
      i++;
      if (i >= cap) { i = 0; wrapped = true; }
    }
    pm.next = i;
    const hiItem = wrapped ? cap - 1 : i - 1;
    const loItem = wrapped ? 0 : lo;
    if (hiItem >= loItem) {
      markItems(pm.aP0, loItem, hiItem); markItems(pm.aV0, loItem, hiItem);
      markItems(pm.aLife, loItem, hiItem); markItems(pm.aKind, loItem, hiItem);
    }
    const top = wrapped ? cap : i;
    if (top > pm.high) pm.high = top;
    const until = birth + life * (1 + P_JITTER);   // latest death in this mesh (the mesh hides once it passes)
    if (until > pm.liveUntil) pm.liveUntil = until;
    setDrawCount(pm.mesh, pm.high < cap ? pm.high : cap);
  }

  /** Named burst presets (JUICE.bursts counts): hitSpark, gateSpark, blood, bloodSmall, max, flip, rocket, splat, bossDeath, coinFountain. */
  burst(preset, x, y, z) {
    if (!this._inited) return;
    const b = typeof preset === 'number' ? preset : BURST_ID[preset];
    if (b === undefined || b < 0 || b >= BURST_COUNT.length) return;
    this._burstColored(b, x, y, z, BURST_COLOR[b], 1);
  }

  /** Burst with an explicit colour index (−1 = preset / random confetti) and a count multiplier. */
  _burstColored(b, x, y, z, colorIdx, countMult) {
    const n = Math.max(1, Math.round(BURST_COUNT[b] * countMult));
    const k = BURST_KIND[b];
    const road = this.ctx.world ? this.ctx.world.roadSpeed : 0;
    const col = colorIdx;
    if (b === B_COINFOUNTAIN) {
      for (let i = 0; i < n; i++) {
        const vy = FOUNTAIN_VY_MIN + (FOUNTAIN_VY_MAX - FOUNTAIN_VY_MIN) * lrnd();
        this._emitRaw(K_GOLD, 1, x, y, z, 0, vy, 0, P_SPEED[K_GOLD] * 0.6, 0, 1.6, P_SIZE[K_GOLD] * 1.4, P_GRAVITY[K_GOLD], road * 0.5, C_GOLD);
      }
      return;
    }
    if (b === B_BOSSDEATH) {
      this._emitRaw(K_CONFETTI, n, x, y, z, 0, 4.5, 0, P_SPEED[K_CONFETTI], 0.9, P_LIFE[K_CONFETTI], P_SIZE[K_CONFETTI], P_GRAVITY[K_CONFETTI], road * 0.3, -1);
      return;
    }
    if (b === B_ROCKET) {
      this._emitRaw(K_SPARK, n, x, y, z, 0, 0, 0, P_SPEED[K_SPARK] * BURST_SPEED[b], 0.45, P_LIFE[K_SPARK] * 1.4, P_SIZE[K_SPARK] * 1.3, P_GRAVITY[K_SPARK], road, col);
      this._emitRaw(K_MUZZLE, 2, x, y, z, 0, 0, 0, 0, 0, ROCKET_FLASH_LIFE, ROCKET_FLASH_SIZE, 0, road, C_ROCKET);   // J21 "orange burst"
      this._emitRaw(K_SMOKE, Math.max(2, n >> 2), x, y, z, 0, 1.2, 0, 1.6, 0.6, P_LIFE[K_SMOKE], P_SIZE[K_SMOKE] * 1.6, P_GRAVITY[K_SMOKE], road, C_SMOKE);
      this._emitRaw(K_DUST, Math.max(2, n >> 2), x, 0.1, z, 0, 0, 0, 3.0, 0.1, P_LIFE[K_DUST], P_SIZE[K_DUST] * 1.4, P_GRAVITY[K_DUST], road, C_DUST);
      return;
    }
    this._emitRaw(k, n, x, y, z, 0, 0, 0, P_SPEED[k] * BURST_SPEED[b], P_UP[k], P_LIFE[k], P_SIZE[k], P_GRAVITY[k], P_CARRY[k] * road, col >= 0 ? col : P_COLOR[k]);
  }

  // ===========================================================================================
  // Floaters ("−1", "−k", "+n", "+17") and damage numbers — digit-atlas billboards
  // ===========================================================================================

  /** Public floater: `text` parsed glyph by glyph (≤ 4 glyphs), coloured, rising. */
  floater(text, x, y, z, colorHex, opts) {
    if (!this._inited) return;
    const s = typeof text === 'string' ? text : String(text);
    const i = this._allocFloater();
    if (i < 0) return;
    let n = 0;
    for (let c = 0; c < s.length && n < MAX_TEXT; c++) {
      const g = glyphOfCode(s.charCodeAt(c));
      if (g >= 0) this._fGlyph[i * MAX_TEXT + n++] = g;
    }
    const has = opts !== undefined && opts !== null;
    this._initFloater(i, n, x, y, z, colorHex,
      has && typeof opts.rise === 'number' ? opts.rise : JUICE.floater.rise,
      has && typeof opts.life === 'number' ? opts.life : JUICE.floater.life,
      has && typeof opts.size === 'number' ? opts.size : JUICE.floater.size);
  }

  /** Allocation-free signed-number floater (sign glyph G_PLUS / G_MINUS, or −1 for none). Returns the index. */
  _floaterNum(value, sign, x, y, z, colorHex, rise, life, size, peak) {
    const i = this._allocFloater();
    if (i < 0) return -1;
    const n = writeNumberGlyphs(this._fGlyph, i * MAX_TEXT, value, sign, MAX_TEXT);
    this._initFloater(i, n, x, y, z, colorHex, rise, life, size, peak);
    return i;
  }

  _allocFloater() {
    const F = this._fAlive.length;
    for (let i = 0; i < F; i++) if (!this._fAlive[i]) return i;
    dropped(this.ctx, 'fx.floaters');
    return -1;
  }

  _initFloater(i, n, x, y, z, colorHex, rise, life, size, peak) {
    this._fAlive[i] = n > 0 ? 1 : 0;
    this._fN[i] = n;
    this._fX[i] = x; this._fY[i] = y; this._fZ[i] = z;
    this._fRise[i] = rise; this._fLife[i] = life > 0.05 ? life : 0.05; this._fSize[i] = size; this._fAge[i] = 0;
    this._fFollow[i] = 0;
    if (peak > 0) hexToPeak(colorHex, peak);   // label-adjacent text: bounded so it does not bloom next to the crisp label
    else hexToLinear(colorHex, colorHex === PALETTE.glyph.fill ? HDR_WHITE : HDR_TINT);
    this._fRGB[i * 3] = LIN[0]; this._fRGB[i * 3 + 1] = LIN[1]; this._fRGB[i * 3 + 2] = LIN[2];
    if (i + 1 > this._fTop) this._fTop = i + 1;
  }

  /** Damage number (brutes / bosses): value = round(w·d), ≤ 4 digits, pops in, rises, shrinks out. */
  damageNumber(value, x, y, z, colorHex) {
    if (!this._inited) return;
    this._numberSpawn(value, x, y, z, colorHex === undefined ? PALETTE.glyph.fill : colorHex, 1, NUMBER_GAIN, -1);
  }

  /**
   * Spawns one damage number. gain = peak linear component (NUMBER_GAIN ≤ 1 keeps the atlas outline readable under
   * bloom; crits use NUMBER_CRIT_GAIN). target: −1 = untracked, −2 = the boss, ≥ 0 = a brute id. Tracked targets lay
   * their numbers out on a slot grid (see NUMBER_TRACK_SLOTS): the new number takes the slot after the target's newest
   * live one and retires that slot's occupant, so a target's live numbers never overlap (round-2 QA FX-12). Boss numbers
   * anchor on ctx.world.bossX / bossZ when the hit is within BOSS_ANCHOR_SNAP of it (the grid does not jitter with the hit x).
   */
  _numberSpawn(value, x, y, z, colorHex, scale, gain, target) {
    const v = Math.round(value);
    if (!(v >= 1)) return;
    const D = this._nAlive.length;
    let slot = 0;
    if (target !== -1) {
      // the target's newest live number → the next slot; that slot's occupant retires now
      let newest = -1, newestBorn = -1;
      for (let k = 0; k < D; k++) {
        if (this._nAlive[k] && this._nBoss[k] === 1 && this._nTargetId[k] === target && this._nBorn[k] > newestBorn) { newestBorn = this._nBorn[k]; newest = k; }
      }
      if (newest >= 0) slot = (this._nSlot[newest] + 1) % (target === -2 ? NUMBER_BOSS_SLOTS : NUMBER_TRACK_SLOTS);
      for (let k = 0; k < D; k++) {
        if (this._nAlive[k] && this._nBoss[k] === 1 && this._nTargetId[k] === target && this._nSlot[k] === slot) this._nAlive[k] = 0;
      }
    }
    let i = -1;
    for (let k = 0; k < D; k++) if (!this._nAlive[k]) { i = k; break; }
    if (i < 0) { dropped(this.ctx, 'fx.numbers'); return; }
    const n = writeNumberGlyphs(this._nGlyph, i * MAX_TEXT, v, -1, MAX_TEXT);
    this._nN[i] = n;
    this._nAlive[i] = 1;
    if (target !== -1) {
      let ax = x, az = z;
      // anchor on the target itself (not the hit point, which wanders across its body) and ride along with it, so the
      // grid never shears while the target walks: the boss via ctx.world.bossX / bossZ, a brute via zombies.position(id)
      this._nFollow[i] = 0;
      if (target === -2) {
        // the boss's current anchor, or its last one once it is gone (the boss:dead flush must land on the same grid)
        const w = this.ctx.world;
        const active = !!(w && w.bossActive);
        const bx = active ? w.bossX : this._bossLX, bz = active ? w.bossZ : this._bossLZ;
        if (Math.abs(bx - x) <= BOSS_ANCHOR_SNAP) {
          ax = bx; az = bz;
          this._nFollow[i] = 1;
          this._bossLX = ax; this._bossLZ = az;
        }
      } else {
        const zs = this.ctx.zombies;
        if (zs && typeof zs.position === 'function') {
          _pos.set(x, 0, z);
          zs.position(target, _pos);
          ax = _pos.x; az = _pos.z;
          this._nFollow[i] = 2;
        }
      }
      this._nAX[i] = ax; this._nAZ[i] = az;
      const h = JUICE.floater.size * scale;                         // this number's glyph height (m)
      let wid = 0;
      for (let k = 0; k < n; k++) wid += this._gAdv[this._nGlyph[i * MAX_TEXT + k]] * h;
      const side = (slot & 1) === 0 ? -1 : 1;                       // even slots left of the target, odd slots right
      const off = side * (NUMBER_SIDE + wid * 0.5);                 // inner edge NUMBER_SIDE from the anchor
      // rows centred on the anchor height (row 0 below it, the top row above): the grid stays clear of the HUD boss bar
      const rows = target === -2 ? NUMBER_BOSS_ROWS : NUMBER_ROWS;
      const lift = ((slot >> 1) - (rows - 1) * 0.5) * JUICE.floater.size * (target === -2 ? NUMBER_BOSS_SCALE : 1) * NUMBER_ROW_EM;
      this._nX[i] = ax + CAM[0] * off + CAM[3] * lift;
      this._nY[i] = y + CAM[1] * off + CAM[4] * lift;
      this._nZ[i] = az + CAM[2] * off + CAM[5] * lift;
      this._nRise[i] = NUMBER_TRACK_RISE;
      this._nSlot[i] = slot;
    } else {
      this._nFollow[i] = 0;
      this._nX[i] = x + (this._rnd() - 0.5) * 1.0; this._nY[i] = y + this._rnd() * 0.3; this._nZ[i] = z;
      this._nRise[i] = NUMBER_RISE;
    }
    this._nBoss[i] = target !== -1 ? 1 : 0;
    this._nTargetId[i] = target;
    this._nBorn[i] = ++this._nSeq;
    this._nScale[i] = scale; this._nAge[i] = 0;
    hexToPeak(colorHex, gain > 0 ? gain : NUMBER_GAIN);
    this._nRGB[i * 3] = LIN[0]; this._nRGB[i * 3 + 1] = LIN[1]; this._nRGB[i * 3 + 2] = LIN[2];
    if (i + 1 > this._nTop) this._nTop = i + 1;
  }

  /** Adds damage to the per-target accumulator (merged numbers: one number per target per merge window). */
  _accDamage(id, boss, amount, x, y, z) {
    let slot = -1, oldest = 0, oldestT = Infinity;
    for (let s = 0; s < NUMBER_ACC_SLOTS; s++) {
      const sid = this._naId[s];
      if (sid === id && this._naBoss[s] === (boss ? 1 : 0)) { slot = s; break; }
      if (sid < 0 && slot === -1) slot = -2 - s;   // remember the first free slot, keep looking for a match
      if (sid >= 0 && this._naT0[s] < oldestT) { oldestT = this._naT0[s]; oldest = s; }
    }
    if (slot >= 0) {
      // round 7 (r7 "9999" numbers): a merge that would carry the total past NUMBER_MAX shows the total so far as its own number
      // and starts a fresh one with this hit, so a merged number is always the exact sum of real hits, never a clamped 9999
      if (!(this._naSum[slot] + amount > NUMBER_MAX) || this._naSum[slot] < 0.5) {
        this._naSum[slot] += amount; this._naX[slot] = x; this._naY[slot] = y; this._naZ[slot] = z;
        return slot;
      }
      this._flushSlot(slot);
    } else if (slot <= -2) slot = -2 - slot;
    else { this._flushSlot(oldest); slot = oldest; }
    this._naId[slot] = id; this._naBoss[slot] = boss ? 1 : 0;
    this._naSum[slot] = amount; this._naX[slot] = x; this._naY[slot] = y; this._naZ[slot] = z; this._naT0[slot] = this._real;
    // jittered window: under constant DPS consecutive totals differ ("275 275" read as a stuck number)
    // (boss: jitter only lengthens NUMBER_BOSS_WIN, so a boss slot is never reused before its number has faded)
    this._naWin[slot] = boss ? NUMBER_BOSS_WIN * (1 + this._rnd() * NUMBER_FLUSH_JITTER)
      : NUMBER_FLUSH_S * (1 + (this._rnd() * 2 - 1) * NUMBER_FLUSH_JITTER);
    return slot;
  }

  _flushSlot(s) {
    if (this._naId[s] < 0) return;
    const boss = this._naBoss[s] === 1;
    const color = this._boosterOn ? GEAR.booster.numberColor : PALETTE.glyph.fill;
    this._numberSpawn(this._naSum[s], this._naX[s], this._naY[s], this._naZ[s], color, boss ? NUMBER_BOSS_SCALE : 1, NUMBER_GAIN,
      boss ? -2 : this._naId[s]);
    this._naId[s] = -1; this._naSum[s] = 0;
  }

  /** Flushes accumulators older than their merge window (or all of them). */
  _flushNumbers(all) {
    for (let s = 0; s < NUMBER_ACC_SLOTS; s++) {
      if (this._naId[s] >= 0 && (all || this._real - this._naT0[s] >= this._naWin[s])) this._flushSlot(s);
    }
  }

  /** Writes one centred row of glyph quads along the camera right axis. Returns nothing; colour × fade. */
  _writeRow(buf, quad0, glyphs, g0, n, max) {
    const ax = ROW[0], ay = ROW[1], az = ROW[2], h = ROW[3], r = ROW[4], g = ROW[5], b = ROW[6];
    let total = 0;
    for (let k = 0; k < n; k++) total += this._gAdv[glyphs[g0 + k]] * h;
    let cx = -total * 0.5;
    const M = buf.mat4, G = buf.glyph, C = buf.color;
    for (let k = 0; k < max; k++) {
      const q = quad0 + k;
      if (k >= n) { writeHidden(M, q * 16); continue; }
      const gi = glyphs[g0 + k];
      const adv = this._gAdv[gi] * h;
      const off = cx + adv * 0.5;
      cx += adv;
      TRS[0] = ax + CAM[0] * off; TRS[1] = ay + CAM[1] * off; TRS[2] = az + CAM[2] * off; TRS[3] = h * this._gAsp[gi]; TRS[4] = h; TRS[5] = 1;
      writeTRS(M, q * 16);
      G[q * 4] = this._gUV[gi * 4]; G[q * 4 + 1] = this._gUV[gi * 4 + 1]; G[q * 4 + 2] = this._gUV[gi * 4 + 2]; G[q * 4 + 3] = this._gUV[gi * 4 + 3];
      C[q * 3] = r; C[q * 3 + 1] = g; C[q * 3 + 2] = b;
    }
  }

  /**
   * "−k" loss floater anchored beside the count label (GDD §5 / J10): its right edge sits LOSS_GAP_EM left of the
   * label's digits at the label's height (right of it when the label is near the left edge), then it rises and drifts
   * outward, so the label (drawn after the floaters)
   * never covers it. Writes ROW 0..3 (anchor + unscaled glyph height); false when the label has no anchor.
   */
  /** Side of the label a new "−k" goes: left (−1), or right (+1) when the label sits in the left third of the screen —
   *  or (round-3 FTUE) whenever the floater would not fit left of a wide label: a 3-digit count left of centre pushed a
   *  "−4" half off the left edge of a phone screen. */
  _lossSide() {
    const L = this.label;
    if (!L.hasPos) return -1;
    const dx = L.x - CAM[9], dy = L.y - CAM[10], dz = L.z - CAM[11];
    const rel = dx * CAM[0] + dy * CAM[1] + dz * CAM[2];
    const depth = dx * CAM[6] + dy * CAM[7] + dz * CAM[8];
    const r = this.ctx.render;
    const cam = r && r.camera ? r.camera : null;
    const fov = cam && cam.fov ? cam.fov : 55;
    const aspect = r && r.size && r.size.h > 0 ? r.size.w / r.size.h : JUICE.ui.refBox[0] / JUICE.ui.refBox[1];
    const halfW = (depth > 0.1 ? depth : 0.1) * Math.tan(fov * DEG * 0.5) * aspect;
    if (rel < -0.35 * halfW) return 1;
    // room left of the label centre vs what a "−kk" needs there (half the digit run, the gap, its own width, the drift)
    const hb = SQUAD.label.px * L.mPerPx;
    let lw = 0;
    for (let k = 0; k < L.nDigits; k++) lw += this._gAdv[L.digits[k]] * hb;
    const fw = (this._gAdv[G_MINUS] + 2 * this._gAdv[0]) * hb * LOSS_SIZE_EM * LOSS_SCALE_BIG;   // round 7: room for the big "−k"
    return lw * 0.5 + LOSS_GAP_EM * hb + fw + LOSS_DRIFT > (rel + halfW) * 0.97 ? 1 : -1;
  }

  _followLoss(i, eu) {
    const L = this.label;
    if (!L.hasPos || !this._labelVisible) return false;
    const hb = SQUAD.label.px * L.mPerPx;          // label glyph height without the punch (m)
    let lw = 0;
    for (let k = 0; k < L.nDigits; k++) lw += this._gAdv[L.digits[k]] * hb;
    const fh = hb * LOSS_SIZE_EM * (this._fSize[i] / FLOATER_SIZE);   // round 7: × the floater's loss scale (_onSquadLoss)
    const g0 = i * MAX_TEXT, n = this._fN[i];
    let fw = 0;
    for (let k = 0; k < n; k++) fw += this._gAdv[this._fGlyph[g0 + k]] * fh;
    const off = this._fSide[i] * (lw * 0.5 + LOSS_GAP_EM * hb + fw * 0.5 + LOSS_DRIFT * eu);
    const lift = this._fRise[i] * eu;
    ROW[0] = L.x + CAM[0] * off; ROW[1] = L.y + CAM[1] * off + lift; ROW[2] = L.z + CAM[2] * off;
    ROW[3] = fh;
    return true;
  }

  _updateFloaters(rdt) {
    const top = this._fTop;
    let newTop = 0;
    for (let i = 0; i < top; i++) {
      if (!this._fAlive[i]) { this._writeRow(this._fl, i * MAX_TEXT, this._fGlyph, 0, 0, MAX_TEXT); continue; }
      const age = this._fAge[i] + rdt;
      this._fAge[i] = age;
      const u = age / this._fLife[i];
      if (u >= 1) {
        this._fAlive[i] = 0;
        if (this._lossF === i) this._lossF = -1;
        this._writeRow(this._fl, i * MAX_TEXT, this._fGlyph, 0, 0, MAX_TEXT);
        continue;
      }
      newTop = i + 1;
      // pop in (outBack over the first 18 %), shrink out over the last 25 %, colour fade over the last 35 %
      let s = u < 0.18 ? eOutBack(u / 0.18, BACK_S) : 1;
      if (u > 0.75) s *= 1 - eInOutCubic((u - 0.75) / 0.25) * 0.6;
      const fade = u > 0.65 ? 1 - (u - 0.65) / 0.35 : 1;
      const eu = eOutCubic(u);
      const o = i * 3;
      if (this._fFollow[i] === 1 && this._followLoss(i, eu)) {
        ROW[3] *= s;   // _followLoss wrote the anchor (ROW 0..2) and the unscaled glyph height (ROW 3)
      } else {
        ROW[0] = this._fX[i]; ROW[1] = this._fY[i] + this._fRise[i] * eu; ROW[2] = this._fZ[i]; ROW[3] = this._fSize[i] * s;
      }
      ROW[4] = this._fRGB[o] * fade; ROW[5] = this._fRGB[o + 1] * fade; ROW[6] = this._fRGB[o + 2] * fade;
      this._writeRow(this._fl, i * MAX_TEXT, this._fGlyph, i * MAX_TEXT, this._fN[i], MAX_TEXT);
    }
    this._fTop = newTop;
    this._commitGlyphs(this._fl, newTop * MAX_TEXT, top * MAX_TEXT);
  }

  _updateNumbers(rdt) {
    const top = this._nTop;
    const zsRef = this.ctx.zombies;
    const zs = zsRef && typeof zsRef.position === 'function' ? zsRef : null;
    const life = JUICE.floater.life;
    let newTop = 0;
    for (let i = 0; i < top; i++) {
      if (!this._nAlive[i]) { this._writeRow(this._nb, i * MAX_TEXT, this._nGlyph, 0, 0, MAX_TEXT); continue; }
      const age = this._nAge[i] + rdt;
      this._nAge[i] = age;
      const u = age / life;
      if (u >= 1) { this._nAlive[i] = 0; this._writeRow(this._nb, i * MAX_TEXT, this._nGlyph, 0, 0, MAX_TEXT); continue; }
      newTop = i + 1;
      let s = u < 0.15 ? 0.4 + 0.6 * eOutBack(u / 0.15, 2.4) : 1;
      if (u > 0.7) s *= 1 - eInOutCubic((u - 0.7) / 0.3) * 0.7;
      const fade = u > 0.6 ? 1 - (u - 0.6) / 0.4 : 1;
      const rise = this._nRise[i] * eOutCubic(u);   // straight up on screen (camera up axis): the slot grid's rows stay apart
      const o = i * 3;
      let bx = 0, bz = 0;
      const follow = this._nFollow[i];
      if (follow === 1) { bx = this._bossLX - this._nAX[i]; bz = this._bossLZ - this._nAZ[i]; }
      else if (follow === 2 && zs !== null) {
        _pos.set(this._nAX[i], 0, this._nAZ[i]);
        zs.position(this._nTargetId[i], _pos);   // a stale id leaves _pos at the anchor (offset 0)
        bx = _pos.x - this._nAX[i]; bz = _pos.z - this._nAZ[i];
      }
      ROW[0] = this._nX[i] + bx + CAM[3] * rise; ROW[1] = this._nY[i] + CAM[4] * rise; ROW[2] = this._nZ[i] + bz + CAM[5] * rise;
      ROW[3] = JUICE.floater.size * this._nScale[i] * s;
      ROW[4] = this._nRGB[o] * fade; ROW[5] = this._nRGB[o + 1] * fade; ROW[6] = this._nRGB[o + 2] * fade;
      this._writeRow(this._nb, i * MAX_TEXT, this._nGlyph, i * MAX_TEXT, this._nN[i], MAX_TEXT);
    }
    this._nTop = newTop;
    this._commitGlyphs(this._nb, newTop * MAX_TEXT, top * MAX_TEXT);
  }

  /** mesh.count + update ranges for a glyph buffer (covers the quads hidden this frame too). */
  _commitGlyphs(buf, count, prevCount) {
    setDrawCount(buf.mesh, count);
    const n = count > prevCount ? count : prevCount;
    if (n <= 0) return;
    markItems(buf.mesh.instanceMatrix, 0, n - 1);
    markItems(buf.aGlyph, 0, n - 1);
    markItems(buf.aColor, 0, n - 1);
  }

  /** Count-label quads (called from label.setWorldPos, i.e. squad.render — step D). */
  _writeLabel(L) {
    const buf = this._lb;
    if (!this._inited || !buf) return;
    if (!this._labelVisible) { setDrawCount(buf.mesh, 0); this._plateCount(0); return; }
    const cam = this._camera();
    const size = this._rsize;
    this._readCamera();
    // screen-space size: SQUAD.label.px CSS px at the anchor's view depth
    const dx = L.x - CAM[9], dy = L.y - CAM[10], dz = L.z - CAM[11];
    let depth = dx * CAM[6] + dy * CAM[7] + dz * CAM[8];
    if (depth < WORLD.camera.near) depth = WORLD.camera.near;
    const fov = cam && cam.fov ? cam.fov : 55;
    const viewH = size !== null && size.h > 0 ? size.h : JUICE.ui.refBox[1];
    const mPerPx = 2 * depth * Math.tan(fov * DEG * 0.5) / viewH;
    L.mPerPx = mPerPx;
    const pu = L.punchT;   // = L._scale(), inline (no boxed return)
    const punch = pu >= 1 ? 1 : 1 + L.punchAmp * Math.exp(-5 * pu) * Math.cos(3 * Math.PI * pu);
    const h = SQUAD.label.px * mPerPx * punch;
    L.height = h;
    // results / game-over fade (FX-11): label colour and plate alpha go to 0 over LABEL_HIDE_S (the glyph shader fades a
    // quad out once its colour drops below its knee)
    const vis0 = this._labelHideT >= 0 ? 1 - this._labelHideT / LABEL_HIDE_S : 1;
    const vis = vis0 < this._introFade ? vis0 : this._introFade;   // round-3 FTUE: hidden during the boss-intro dolly too
    const fade = vis > 0 ? vis : 0;
    // colour: LDR white (FX-1), flashing toward gain / loss
    const W = this._white;
    let cr = W[0], cg = W[1], cb = W[2];
    if (L.flashDur > 0) {
      const k = 1 - eOutQuad(L.flashT / L.flashDur);
      cr += (L.flashRGB[0] - cr) * k; cg += (L.flashRGB[1] - cg) * k; cb += (L.flashRGB[2] - cb) * k;
    }
    ROW[0] = L.x; ROW[1] = L.y; ROW[2] = L.z; ROW[3] = h; ROW[4] = cr * fade; ROW[5] = cg * fade; ROW[6] = cb * fade;
    this._writeRow(buf, 0, L.digits, 0, L.nDigits, LABEL_DIGITS);
    let total = 0;
    for (let k = 0; k < L.nDigits; k++) total += this._gAdv[L.digits[k]] * h;
    // backing plate (FX-10): digit run + PLATE_PAD em each side, ink height + PLATE_PAD em top and bottom
    const pad = PLATE_PAD * h;
    L.width = total + 2 * pad;          // round-3 FTUE: the plate's world size, for gates' label-yield test
    L.plateH = h * PLATE_INK_EM + 2 * pad;
    const PM = this.labelPlate.instanceMatrix.array;
    TRS[0] = L.x; TRS[1] = L.y; TRS[2] = L.z; TRS[3] = (total + 2 * pad) * PLATE_INFLATE; TRS[4] = (h * PLATE_INK_EM + 2 * pad) * PLATE_INFLATE; TRS[5] = 1;
    writeTRS(PM, 0);
    const halo = PLATE_HALO_EM * h;   // the clamp quad: plate + halo margin (PLATE_HALO_FRAC of its height)
    TRS[3] = total + 2 * pad + 2 * halo; TRS[4] = h * PLATE_INK_EM + 2 * pad + 2 * halo;
    writeTRS(this.labelClamp.instanceMatrix.array, 0);
    if (fade !== this._plateFade) {   // uniform { value } fields are Tagged (a double stored there is boxed): write on change only
      this._plateFade = fade;
      this._plateAlpha.value = PLATE_ALPHA * fade;
      const lift = fade < 1 ? (1 - fade) * PLATE_CEIL_OFF : 0;   // the caps lift as the plate fades
      this._plateCeil.value = PLATE_CEIL + lift;
      this._plateCeilHalo.value = PLATE_HALO_CEIL + lift;
    }
    this._plateCount(1);
    markItems(this.labelPlate.instanceMatrix, 0, 0);
    markItems(this.labelClamp.instanceMatrix, 0, 0);
    // badge ("x3") beside the number, popping 2 → 1
    if (L.badgeN > 0 && L.badgeHideAt >= 0) {
      let bs = L.badgeT < BADGE_IN_S ? 2 - eOutCubic(L.badgeT / BADGE_IN_S) : 1;
      const left = L.badgeHideAt - L.now;
      if (left < 0.1 && L.tweenDur === 0) bs *= left > 0 ? left / 0.1 : 0;
      const bh = h * BADGE_SCALE * bs;
      let bw = 0;
      for (let k = 0; k < L.badgeN; k++) bw += this._gAdv[L.badgeGlyph[k]] * bh;
      const off = total * 0.5 + BADGE_GAP_EM * h + bw * 0.5;
      const lift = h * 0.18;
      const BC = this._badgeRGB;
      ROW[0] = L.x + CAM[0] * off + CAM[3] * lift; ROW[1] = L.y + CAM[1] * off + CAM[4] * lift; ROW[2] = L.z + CAM[2] * off + CAM[5] * lift;
      ROW[3] = bh; ROW[4] = BC[0] * fade; ROW[5] = BC[1] * fade; ROW[6] = BC[2] * fade;
      this._writeRow(buf, LABEL_DIGITS, L.badgeGlyph, 0, L.badgeN, LABEL_BADGE);
    } else {
      this._writeRow(buf, LABEL_DIGITS, L.badgeGlyph, 0, 0, LABEL_BADGE);
    }
    L.glyphDirty = false;
    this._commitGlyphs(buf, LABEL_DIGITS + LABEL_BADGE, LABEL_DIGITS + LABEL_BADGE);
  }

  /** Roll-up tick (GDD §5 "one tick every 20 ms during the tween"): audio 'tick' with a climbing pitch. */
  _labelTick(u) {
    if (this._priming) return;   // boot warm-up: silent
    const audio = this.ctx.audio;
    if (!audio || typeof audio.play !== 'function') return;
    TICK_OPTS.value = Math.round(u * LABEL_TICK_VALUE_SPAN);
    try { audio.play('tick', TICK_OPTS); } catch (_) { /* audio reports its own errors */ }
  }

  // ===========================================================================================
  // Decals — 12 instanced ground decals, stable generation-tagged ids
  // ===========================================================================================

  /**
   * Ground decal. kind 'ring' | 'arc' | 'lane' | 'splat' | 'xband' | 'swipe' (round 7: the brute's frontal arc); size = diameter
   * (ring / arc / splat / swipe) or stripe width (lane / xband); seconds = Infinity keeps it until removeDecal. Round 7: `onTop`
   * (optional, default false) = a telegraph that sits on the formation (slam ring, charge stripe, car band, acid marks, brute swipe):
   * drawn without the depth test (fx.decalsTop) so the squad's bodies never hide it. Returns an id ≥ 0, or −1 when the pool is full
   * (callers retry / tolerate). Cosmetic splats yield their slots to gameplay telegraphs, and DECAL_RESERVE slots stay free for the
   * lane highlight (seconds = Infinity) and the shield gauge.
   */
  decal(kind, x, z, size, seconds, colorHex, onTop) {
    if (!this._inited) return -1;
    const k = typeof kind === 'number' ? kind : DECAL_KIND[kind];
    if (k === undefined || k < 0 || k > D_LAST) return -1;
    const reserved = k === D_LANE && seconds === Infinity;
    return this._allocDecal(k, x, z, size, seconds, fxColorIndex(colorHex), reserved, false, onTop === true ? 1 : 0);
  }

  _allocDecal(k, x, z, size, seconds, colorIdx, reserved, roadAttached, top = 0) {
    let free = 0, slot = -1;
    for (let i = 0; i < DECAL_SLOTS; i++) if (!this._dActive[i]) { free++; if (slot < 0) slot = i; }
    if (k === D_SPLAT && !reserved) {
      if (free < DECAL_SPLAT_HEADROOM) { dropped(this.ctx, 'fx.decals'); return -1; }
    } else if (!reserved && free <= DECAL_RESERVE) {
      const ev = this._oldestSplat();
      if (ev < 0) { dropped(this.ctx, 'fx.decals'); return -1; }
      this._freeDecal(ev);
      slot = ev;
    } else if (slot < 0) {
      const ev = this._oldestSplat();
      if (ev < 0) { dropped(this.ctx, 'fx.decals'); return -1; }
      this._freeDecal(ev);
      slot = ev;
    }
    this._dActive[slot] = 1;
    this._dKind[slot] = k;
    this._dX[slot] = x; this._dZ[slot] = z;
    this._dSize[slot] = size > 0 ? size : 1;
    this._dProg[slot] = 0;
    this._dSec[slot] = seconds > 0 ? seconds : 0.0001;
    this._dAge[slot] = 0;
    this._dSeed[slot] = this._rnd();
    this._dColor[slot] = colorIdx;
    this._dReserved[slot] = reserved ? 1 : 0;
    this._dRoad[slot] = roadAttached ? 1 : 0;
    this._dAuto[slot] = k === D_SPLAT ? 1 : 0;
    this._dTop[slot] = top === 1 ? 1 : 0;
    return ((this._dGen[slot] & 0x7FFFF) << ID_SHIFT) | slot;
  }

  _oldestSplat() {
    let best = -1, bestAge = -1;
    for (let i = 0; i < DECAL_SLOTS; i++) {
      if (this._dActive[i] && this._dKind[i] === D_SPLAT && this._dAge[i] > bestAge) { bestAge = this._dAge[i]; best = i; }
    }
    return best;
  }

  _freeDecal(i) {
    this._dActive[i] = 0;
    this._dGen[i] = (this._dGen[i] + 1) & 0x7FFFF;
    if (this._dGen[i] === 0) this._dGen[i] = 1;
  }

  /** Slot of a live decal id, or −1 (stale / expired / foreign ids are tolerated everywhere). */
  _decalSlot(id) {
    if (typeof id !== 'number' || !(id >= 0)) return -1;
    const slot = id & SLOT_MASK;
    if (slot >= DECAL_SLOTS || !this._dActive[slot]) return -1;
    return ((this._dGen[slot] & 0x7FFFF) === (id >>> ID_SHIFT)) ? slot : -1;
  }

  moveDecal(id, x, z) {
    const s = this._decalSlot(id);
    if (s < 0) return;
    this._dX[s] = x; this._dZ[s] = z;
  }

  decalProgress(id, t01) {
    const s = this._decalSlot(id);
    if (s < 0) return;
    this._dProg[s] = t01 < 0 ? 0 : (t01 > 1 ? 1 : t01);
  }

  removeDecal(id) {
    const s = this._decalSlot(id);
    if (s < 0) return;
    this._freeDecal(s);
    if (id === this._shieldDecal) this._shieldDecal = -1;
  }

  _updateDecals(dt) {
    const world = this.ctx.world;
    const road = world ? world.roadSpeed : 0;
    // the shield gauge rides the boss core
    if (this._shieldDecal >= 0) {
      const s = this._decalSlot(this._shieldDecal);
      if (s < 0) this._shieldDecal = -1;
      else if (world && world.bossActive) { this._dX[s] = world.bossX; this._dZ[s] = world.bossZ; }
    }
    const M0 = this.decals.instanceMatrix.array, A0 = this._dAttr.array, B0 = this._dAttrB.array;
    const M1 = this.decalsTop.instanceMatrix.array, A1 = this._dAttrT.array, B1 = this._dAttrBT.array;
    let n = 0, nt = 0;
    for (let i = 0; i < DECAL_SLOTS; i++) {
      if (!this._dActive[i]) continue;
      const age = this._dAge[i] + dt;
      this._dAge[i] = age;
      const sec = this._dSec[i];
      const finite = sec !== Infinity;
      if (finite && age >= sec) { this._freeDecal(i); continue; }
      if (this._dRoad[i]) this._dZ[i] += road * dt;
      if (this._dAuto[i] && finite) this._dProg[i] = age / sec;
      let fade = age < DECAL_FADE_IN_S ? age / DECAL_FADE_IN_S : 1;
      if (finite && sec - age < DECAL_FADE_OUT_S) fade *= (sec - age) / DECAL_FADE_OUT_S;
      // round 7: a telegraph on the formation goes to fx.decalsTop (no depth test), everything else to fx.decals
      const top = this._dTop[i];
      const j = top === 1 ? nt : n;
      const M = top === 1 ? M1 : M0, A = top === 1 ? A1 : A0, B = top === 1 ? B1 : B0;
      TRS[0] = this._dX[i]; TRS[1] = 0; TRS[2] = this._dZ[i]; TRS[3] = 1; TRS[4] = 1; TRS[5] = 1;
      writeTRS(M, j * 16);
      const o = j * 4;
      A[o] = this._dKind[i]; A[o + 1] = this._dProg[i]; A[o + 2] = this._dSize[i]; A[o + 3] = this._dColor[i];
      B[o] = fade; B[o + 1] = age; B[o + 2] = this._dSeed[i]; B[o + 3] = 0;
      if (top === 1) nt++; else n++;
    }
    setDrawCount(this.decals, n);
    if (n > 0) {
      markItems(this.decals.instanceMatrix, 0, n - 1);
      markItems(this._dAttr, 0, n - 1);
      markItems(this._dAttrB, 0, n - 1);
    }
    setDrawCount(this.decalsTop, nt);
    if (nt > 0) {
      markItems(this.decalsTop.instanceMatrix, 0, nt - 1);
      markItems(this._dAttrT, 0, nt - 1);
      markItems(this._dAttrBT, 0, nt - 1);
    }
  }

  // ===========================================================================================
  // Shards — gate panel shatter (J7 / J8), CPU-integrated InstancedMesh
  // ===========================================================================================

  /**
   * Shatters a panel of width × height (bottom edge at GATE_RULES.panel.bottom) centred at (x, z) into
   * JUICE.shatter.shards tinted shards for JUICE.shatter.seconds; towardCamera = positive pass, else the
   * shards fly away (−z). Shards ride the road scroll.
   */
  shatter(x, z, width, height, colorHex, towardCamera) {
    this._shatter(x, z, width, height, colorHex, towardCamera ? SHATTER_TOWARD : SHATTER_AWAY);
  }

  /**
   * mode SHATTER_TOWARD (J7): small shards burst sideways and up, drifting only 0.35·speed toward the camera so the
   * soldiers, the count tween and the "+N" burst stay visible; SHATTER_AWAY (J8): away from the camera;
   * SHATTER_NEUTRAL: half the shards crumble down in place (grey zero-change pass). Every shard is SHARD_SIZE of
   * its panel cell, additive, and fades by (1 − u)².
   */
  _shatter(x, z, width, height, colorHex, mode) {
    if (!this._inited) return;
    const n = mode === SHATTER_NEUTRAL ? JUICE.shatter.shards >> 1 : JUICE.shatter.shards;
    const w = width > 0 ? width : GATE_RULES.panel.w, h = height > 0 ? height : GATE_RULES.panel.h;
    const cols = Math.max(1, Math.round(Math.sqrt(n * w / h)));
    const rows = Math.max(1, Math.ceil(n / cols));
    const cw = w / cols, ch = h / rows;
    const y0 = GATE_RULES.panel.bottom;
    const road = this.ctx.world ? this.ctx.world.roadSpeed : 0;
    hexToLinear(colorHex, SHARD_GLOW * SHARD_OPACITY);
    const r = LIN[0], g = LIN[1], b = LIN[2];
    const S = this._sh;
    const N = this._shAlive.length;
    for (let i = 0; i < n; i++) {
      let slot = -1;
      for (let t = 0; t < N; t++) {
        const c = (this._shNext + t) % N;
        if (!this._shAlive[c]) { slot = c; break; }
      }
      if (slot < 0) { dropped(this.ctx, 'fx.shards'); return; }
      this._shNext = (slot + 1) % N;
      const col = i % cols, row = Math.floor(i / cols);
      const px = x - w * 0.5 + (col + 0.5) * cw + (lrnd() - 0.5) * cw * 0.3;
      const py = y0 + (row + 0.5) * ch + (lrnd() - 0.5) * ch * 0.3;
      const out = (px - x) / (w * 0.5);
      const sp = SHARD_SPEED_MIN + (SHARD_SPEED_MAX - SHARD_SPEED_MIN) * lrnd();
      const o = slot * SH_STRIDE;
      S[o] = px; S[o + 1] = py; S[o + 2] = z + (lrnd() - 0.5) * 0.1;
      if (mode === SHATTER_TOWARD) {
        S[o + 3] = out * (SHARD_POS_OUT[0] + (SHARD_POS_OUT[1] - SHARD_POS_OUT[0]) * lrnd());
        S[o + 4] = SHARD_POS_VY[0] + (SHARD_POS_VY[1] - SHARD_POS_VY[0]) * lrnd();
        S[o + 5] = SHARD_POS_FWD * sp + road;
      } else if (mode === SHATTER_AWAY) {
        S[o + 3] = out * (1 + 2 * lrnd());
        S[o + 4] = 0.5 + 3 * lrnd() + (py - y0) * 0.4;
        S[o + 5] = road - sp;
      } else {
        S[o + 3] = out * (0.3 + 0.7 * lrnd());
        S[o + 4] = 0.3 + 1.2 * lrnd();
        S[o + 5] = road - 0.5 * lrnd();
      }
      // random unit axis
      let ax = lrnd() * 2 - 1, ay = lrnd() * 2 - 1, az = lrnd() * 2 - 1;
      const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
      ax /= al; ay /= al; az /= al;
      S[o + 6] = ax; S[o + 7] = ay; S[o + 8] = az;
      S[o + 9] = lrnd() * Math.PI * 2;
      S[o + 10] = (lrnd() * 2 - 1) * SHARD_SPIN;
      S[o + 11] = 0;
      S[o + 12] = JUICE.shatter.seconds * (0.8 + 0.4 * lrnd());
      S[o + 13] = cw / SHARD_BOX[0] * SHARD_SIZE * (0.6 + 0.45 * lrnd());
      S[o + 14] = ch / SHARD_BOX[1] * SHARD_SIZE * (0.6 + 0.45 * lrnd());
      S[o + 15] = r; S[o + 16] = g; S[o + 17] = b;
      this._shAlive[slot] = 1;
    }
  }

  _updateShards(dt) {
    const mesh = this.shards;
    const N = this._shAlive.length;
    const S = this._sh;
    const M = mesh.instanceMatrix.array, C = mesh.instanceColor.array;
    let n = 0;
    for (let i = 0; i < N; i++) {
      if (!this._shAlive[i]) continue;
      const o = i * SH_STRIDE;
      const age = S[o + 11] + dt;
      S[o + 11] = age;
      const u = age / S[o + 12];
      if (u >= 1) { this._shAlive[i] = 0; continue; }
      S[o + 4] += SHARD_GRAVITY * dt;
      S[o] += S[o + 3] * dt; S[o + 1] += S[o + 4] * dt; S[o + 2] += S[o + 5] * dt;
      if (S[o + 1] < 0.03) { S[o + 1] = 0.03; S[o + 4] = -S[o + 4] * 0.3; }
      S[o + 9] += S[o + 10] * dt;
      const k = u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4 * 0.5;   // shrink to half while the colour fades out
      const f = (1 - u) * (1 - u);                         // additive colour = opacity fade
      _axis.set(S[o + 6], S[o + 7], S[o + 8]);
      _q.setFromAxisAngle(_axis, S[o + 9]);
      _pos.set(S[o], S[o + 1], S[o + 2]);
      _scale.set(S[o + 13] * k, S[o + 14] * k, k);
      _m4.compose(_pos, _q, _scale);
      _m4.toArray(M, n * 16);
      C[n * 3] = S[o + 15] * f; C[n * 3 + 1] = S[o + 16] * f; C[n * 3 + 2] = S[o + 17] * f;
      n++;
    }
    setDrawCount(mesh, n);
    if (n > 0) { markItems(mesh.instanceMatrix, 0, n - 1); markItems(mesh.instanceColor, 0, n - 1); }
  }

  // ===========================================================================================
  // Rocket scorch marks — dark ground decal under each blast for SCORCH_SECONDS, riding the road
  // ===========================================================================================
  _spawnScorch(x, z, size) {
    let slot = -1, oldest = 0, oldestAge = -1;
    for (let i = 0; i < SCORCH_POOL; i++) {
      if (!this._scAlive[i]) { slot = i; break; }
      if (this._scAge[i] > oldestAge) { oldestAge = this._scAge[i]; oldest = i; }
    }
    if (slot < 0) slot = oldest;   // the oldest mark is almost faded out: recycle it
    this._scAlive[slot] = 1;
    this._scX[slot] = x; this._scZ[slot] = z; this._scSize[slot] = size; this._scAge[slot] = 0; this._scSeed[slot] = this._rnd();
  }

  _updateScorch(dt) {
    const mesh = this.scorch;
    const M = mesh.instanceMatrix.array, A = this._scAttr.array;
    const road = this.ctx.world ? this.ctx.world.roadSpeed : 0;
    let n = 0;
    for (let i = 0; i < SCORCH_POOL; i++) {
      if (!this._scAlive[i]) continue;
      const age = this._scAge[i] + dt;
      this._scAge[i] = age;
      const u = age / SCORCH_SECONDS;
      if (u >= 1) { this._scAlive[i] = 0; continue; }
      this._scZ[i] += road * dt;
      const a = SCORCH_ALPHA * (age < 0.06 ? age / 0.06 : 1) * (u > 0.55 ? 1 - (u - 0.55) / 0.45 : 1);
      const s = this._scSize[i] * (age < 0.1 ? 0.6 + 4 * age : 1);
      TRS[0] = this._scX[i]; TRS[1] = 0.025; TRS[2] = this._scZ[i]; TRS[3] = s; TRS[4] = 1; TRS[5] = s;
      writeTRS(M, n * 16);
      A[n * 3] = a; A[n * 3 + 1] = this._scSeed[i];
      A[n * 3 + 2] = age < SCORCH_HEAT_S ? 1 - age / SCORCH_HEAT_S : 0;   // ember rim cools down
      n++;
    }
    setDrawCount(mesh, n);
    if (n > 0) { markItems(mesh.instanceMatrix, 0, n - 1); markItems(this._scAttr, 0, n - 1); }
  }

  // ===========================================================================================
  // Sniper tracer lines (troop:fire { id:'troop.sniper' }) — HDR red, held BEAM_SECONDS
  // ===========================================================================================
  _spawnBeam(x0, y0, z0, x1, y1, z1) {
    let slot = -1, oldest = 0, oldestAge = -1;
    for (let i = 0; i < BEAM_POOL; i++) {
      if (!this._bAlive[i]) { slot = i; break; }
      if (this._bAge[i] > oldestAge) { oldestAge = this._bAge[i]; oldest = i; }
    }
    if (slot < 0) slot = oldest;
    const o = slot * 6;
    this._bP[o] = x0; this._bP[o + 1] = y0; this._bP[o + 2] = z0; this._bP[o + 3] = x1; this._bP[o + 4] = y1; this._bP[o + 5] = z1;
    this._bAge[slot] = 0;
    this._bAlive[slot] = 1;
  }

  _updateBeams(udt) {
    const mesh = this.beams;
    const M = mesh.instanceMatrix.array;
    let n = 0;
    for (let i = 0; i < BEAM_POOL; i++) {
      if (!this._bAlive[i]) continue;
      const age = this._bAge[i] + udt;
      this._bAge[i] = age;
      if (age >= BEAM_SECONDS) { this._bAlive[i] = 0; continue; }
      const o = i * 6;
      let dx = this._bP[o + 3] - this._bP[o], dy = this._bP[o + 4] - this._bP[o + 1], dz = this._bP[o + 5] - this._bP[o + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-4) { this._bAlive[i] = 0; continue; }
      dx /= len; dy /= len; dz /= len;
      // x axis = up × dir (fallback world x when the beam is vertical), y = dir × x
      let xx = dz, xy = 0, xz = -dx;
      let xl = Math.sqrt(xx * xx + xz * xz);
      if (xl < 1e-4) { xx = 1; xz = 0; xl = 1; }
      xx /= xl; xz /= xl;
      const yx = dy * xz - dz * xy, yy = dz * xx - dx * xz, yz = dx * xy - dy * xx;
      const th = BEAM_THICKNESS * (1 - 0.6 * age / BEAM_SECONDS);
      const e = n * 16;
      M[e] = xx * th; M[e + 1] = xy * th; M[e + 2] = xz * th; M[e + 3] = 0;
      M[e + 4] = yx * th; M[e + 5] = yy * th; M[e + 6] = yz * th; M[e + 7] = 0;
      M[e + 8] = dx * len; M[e + 9] = dy * len; M[e + 10] = dz * len; M[e + 11] = 0;
      M[e + 12] = (this._bP[o] + this._bP[o + 3]) * 0.5; M[e + 13] = (this._bP[o + 1] + this._bP[o + 4]) * 0.5; M[e + 14] = (this._bP[o + 2] + this._bP[o + 5]) * 0.5; M[e + 15] = 1;
      n++;
    }
    setDrawCount(mesh, n);
    if (n > 0) markItems(mesh.instanceMatrix, 0, n - 1);
  }

  // ===========================================================================================
  // Coin / icon flights (DOM sprites inside #coin-flights)
  // ===========================================================================================

  /** J19: coin(s) fly from the world point to the HUD coin icon over JUICE.coinFlight.seconds; ≤ JUICE.caps.coinFlights concurrent; when the pool is full a coin merges into the youngest flight. */
  coinFlight(x, y, z, amount) {
    if (!this._inited || this._coinSprites.length === 0) return;
    this._launchCoins(x, y, z, amount >= COIN_BIG_AMOUNT ? 3 : 1, amount);
  }

  /** `amount` coins are split over the sprites (each lands its share on the HUD); 0 = cosmetic only. */
  _launchCoins(x, y, z, sprites, amount = 0) {
    const r = this.ctx.render;
    if (!r || typeof r.worldToScreen !== 'function') return;
    _v.set(x, y, z);
    try { r.worldToScreen(_v, SCREEN_OUT); } catch (_) { return; }
    if (!Number.isFinite(SCREEN_OUT.x) || !Number.isFinite(SCREEN_OUT.y)) return;
    this._coinTarget(TARGET_OUT);
    const N = this._cfAlive.length;
    const share = amount > 0 && sprites > 0 ? amount / sprites : 0;
    for (let k = 0; k < sprites; k++) {
      let slot = -1;
      for (let i = 0; i < N; i++) if (!this._cfAlive[i]) { slot = i; break; }
      if (slot < 0) { this._mergeCoin(share); continue; }   // never dropped: the youngest flight now carries one more coin
      const sx = SCREEN_OUT.x - this._domOffX + (this._rnd() - 0.5) * 20;
      const sy = SCREEN_OUT.y - this._domOffY + (this._rnd() - 0.5) * 20;
      const tx = TARGET_OUT.x - this._domOffX, ty = TARGET_OUT.y - this._domOffY;
      const o = slot * 6;
      this._cfP[o] = sx; this._cfP[o + 1] = sy;
      this._cfP[o + 2] = (sx + tx) * 0.5 + (this._rnd() - 0.5) * 80;
      this._cfP[o + 3] = (sy < ty ? sy : ty) - COIN_ARC_PX * (0.7 + 0.6 * this._rnd());
      this._cfP[o + 4] = tx; this._cfP[o + 5] = ty;
      this._cfT[slot] = -k * COIN_STAGGER_S;
      this._cfDur[slot] = JUICE.coinFlight.seconds;
      this._cfAlive[slot] = 1;
      this._cfN[slot] = 1;
      this._cfAmt[slot] = share;
      this._coinsInFlight += share;
    }
  }

  /** Pool full: the youngest in-flight coin (latest start, so most of its flight is ahead) carries one more coin. */
  _mergeCoin(share = 0) {
    const N = this._cfAlive.length;
    let best = -1, bestT = Infinity;
    for (let i = 0; i < N; i++) if (this._cfAlive[i] && this._cfT[i] < bestT) { bestT = this._cfT[i]; best = i; }
    if (best < 0) return;
    if (this._cfN[best] < 65535) this._cfN[best]++;
    this._cfAmt[best] += share;
    this._coinsInFlight += share;
  }

  _coinTarget(out) {
    const ui = this.ctx.ui;
    out.x = NaN; out.y = NaN;
    if (ui && typeof ui.coinIconScreenPos === 'function') { try { ui.coinIconScreenPos(out); } catch (_) { out.x = NaN; } }
    if (!Number.isFinite(out.x) || !Number.isFinite(out.y)) {
      const size = this.ctx.render && this.ctx.render.size;
      out.x = (size && size.w > 0 ? size.w : JUICE.ui.refBox[0]) - 56; out.y = 34;   // top-right coin pill fallback
    }
  }

  /** J12: the item icon rises PICKUPS.iconRise metres, then flies to the HUD pill (DOM sprite). */
  iconFlight(item, x, y, z) {
    if (!this._inited || this._iconSprites.length === 0) return;
    const url = this._iconUrl.get(item);
    if (!url) return;
    const N = this._ifAlive.length;
    let slot = -1, oldest = 0, oldestBorn = Infinity;
    for (let i = 0; i < N; i++) {
      if (!this._ifAlive[i]) { slot = i; break; }
      if (this._ifBorn[i] < oldestBorn) { oldestBorn = this._ifBorn[i]; oldest = i; }
    }
    if (slot < 0) slot = oldest;
    const sp = this._iconSprites[slot];
    if (this._iconItem[slot] !== item) { this._iconItem[slot] = item; sp.el.src = url; }
    const o = slot * 7;
    this._ifP[o] = x; this._ifP[o + 1] = y; this._ifP[o + 2] = z;
    this._ifAlive[slot] = 1; this._ifPhase[slot] = 0; this._ifT[slot] = 0; this._ifBorn[slot] = this._real;
    this._ifTroop[slot] = typeof item === 'string' && item.indexOf('troop.') === 0 ? 1 : 0;
    this._ifDx[slot] = 0; this._ifDxSet[slot] = 0;
  }

  /**
   * Round 7 (r7 S5 "flame gate: burn icon on the count"): a rising J12 icon is never drawn over the count label — an item lane is
   * passed at the squad, so its icon used to pop up right under the count and read as a status on it (the flamer's flame as
   * "burning"). Called once per flight (its first frame) with the icon's screen point and full half size: when the rise column
   * (the point and up to PICKUPS.iconRise above it) meets the label's plate on screen, ICON_OUT.x is the sideways offset (CSS px)
   * that keeps it just clear, toward the side the icon already leans to (the screen centre when it starts right under the label);
   * else 0. Reads fx.label's anchor / size; event-rate (≤ 4 sprites).
   */
  _clearOfLabel(sx, sy, half) {
    ICON_OUT.x = 0;
    const L = this.label;
    const r = this.ctx.render;
    if (!this._labelVisible || !L.hasPos || !(L.width > 0) || !(L.mPerPx > 0) || !r || typeof r.worldToScreen !== 'function') return;
    _v.set(L.x, L.y, L.z);
    try { r.worldToScreen(_v, SCREEN_OUT); } catch (_) { return; }
    const lx = SCREEN_OUT.x - this._domOffX, ly = SCREEN_OUT.y - this._domOffY;
    const hw = L.width * 0.5 / L.mPerPx, hh = L.plateH * 0.5 / L.mPerPx;
    const top = sy - PICKUPS.iconRise / L.mPerPx;                  // ≈ the top of the rise (same depth as the label)
    if (Math.abs(sx - lx) >= hw + half || top - half > ly + hh || sy + half < ly - hh) return;
    const size = this._rsize;
    const midX = size !== null && size.w > 0 ? size.w * 0.5 : lx;
    const side = sx > lx + 2 ? 1 : (sx < lx - 2 ? -1 : (lx < midX ? 1 : -1));
    ICON_OUT.x = lx + side * (hw + half + ICON_LABEL_GAP_PX) - sx;
  }

  _updateFlights(udt, sdt) {
    // coins
    const N = this._cfAlive.length;
    for (let i = 0; i < N; i++) {
      if (!this._cfAlive[i]) continue;
      const sp = this._coinSprites[i];
      const t = this._cfT[i] + udt;
      this._cfT[i] = t;
      if (t < 0) continue;
      const u = t / this._cfDur[i];
      if (u >= 1) {
        this._cfAlive[i] = 0;
        sp.hide();
        this._punchT = 0;
        this._coinsInFlight -= this._cfAmt[i];   // landed: the HUD may count these coins up now
        if (this._coinsInFlight < 1e-3) this._coinsInFlight = 0;
        this._cfAmt[i] = 0;
        continue;
      }
      sp.show();
      const e = eInOutCubic(u), ie = 1 - e;
      const o = i * 6;
      const x = ie * ie * this._cfP[o] + 2 * ie * e * this._cfP[o + 2] + e * e * this._cfP[o + 4];
      const y = ie * ie * this._cfP[o + 1] + 2 * ie * e * this._cfP[o + 3] + e * e * this._cfP[o + 5];
      const big = this._cfN[i] > 1 ? 1 + 0.12 * Math.min(4, this._cfN[i] - 1) : 1;   // merged coins read slightly bigger
      const s = big * (u < 0.2 ? 0.6 + 2 * u : 1) * (u > 0.8 ? 1 - (u - 0.8) * 1.25 : 1);
      sp.move(x, y, s, 1);
    }
    // HUD coin icon punch (JUICE.coinFlight.punch → 1)
    if (this._punchT >= 0 && this._hudCoin) {
      this._punchT += udt;
      if (this._punchT >= COIN_PUNCH_S) { this._punchT = -1; this._hudCoin.move(0, 0, 1, 1); }
      else this._hudCoin.move(0, 0, 1 + (JUICE.coinFlight.punch - 1) * (1 - eOutQuad(this._punchT / COIN_PUNCH_S)), 1);
    } else if (this._punchT >= 0) this._punchT = -1;
    // icons
    const r = this.ctx.render;
    const road = this.ctx.world ? this.ctx.world.roadSpeed : 0;
    const M = this._ifAlive.length;
    for (let i = 0; i < M; i++) {
      if (!this._ifAlive[i]) continue;
      const sp = this._iconSprites[i];
      const o = i * 7;
      const t = this._ifT[i] + udt;
      this._ifT[i] = t;
      if (this._ifPhase[i] === 0) {
        // rise above the crate / gate, riding the road
        this._ifP[o + 2] += road * sdt;
        const u = t >= ICON_RISE_S ? 1 : t / ICON_RISE_S;
        _v.set(this._ifP[o], this._ifP[o + 1] + PICKUPS.iconRise * eOutCubic(u), this._ifP[o + 2]);
        let ok = false;
        if (r && typeof r.worldToScreen === 'function') { try { r.worldToScreen(_v, SCREEN_OUT); ok = Number.isFinite(SCREEN_OUT.x) && Number.isFinite(SCREEN_OUT.y); } catch (_) { ok = false; } }
        if (!ok) { this._ifAlive[i] = 0; sp.hide(); continue; }
        const sy = SCREEN_OUT.y - this._domOffY;
        const sc = 0.5 + 0.5 * eOutBack(u, BACK_S);
        const rx = SCREEN_OUT.x - this._domOffX;
        // round 7: never over the count label — the sideways offset is decided once and eased in over the first 30 % of the rise
        if (this._ifDxSet[i] === 0) { this._ifDxSet[i] = 1; this._clearOfLabel(rx, sy, ICON_PX * 0.5); this._ifDx[i] = ICON_OUT.x; }
        const sx = rx + this._ifDx[i] * eOutCubic(u < 0.3 ? u / 0.3 : 1);
        sp.show();
        sp.move(sx, sy, sc, u < 0.3 ? u / 0.3 : 1);
        if (u >= 1) {
          this._ifPhase[i] = 1; this._ifT[i] = 0;
          this._ifP[o + 3] = sx; this._ifP[o + 4] = sy;
          // round 7: a troop has no HUD pill (it flew to an empty spot at the top) — its icon drops into the squad it joins
          if (this._ifTroop[i] === 1) this._squadTarget(sx, sy, TARGET_OUT);
          else this._iconTarget(this._iconItem[i], TARGET_OUT);
          this._ifP[o + 5] = TARGET_OUT.x - this._domOffX; this._ifP[o + 6] = TARGET_OUT.y - this._domOffY;
        }
      } else {
        const u = t / ICON_FLY_S;
        if (u >= 1) { this._ifAlive[i] = 0; sp.hide(); continue; }
        const e = eInOutCubic(u);
        const troop = this._ifTroop[i] === 1;
        const x = this._ifP[o + 3] + (this._ifP[o + 5] - this._ifP[o + 3]) * e;
        const y = this._ifP[o + 4] + (this._ifP[o + 6] - this._ifP[o + 4]) * e - Math.sin(Math.PI * u) * (troop ? 12 : 30);
        if (troop) sp.move(x, y, 1 - 0.65 * e, u > 0.6 ? (1 - u) / 0.4 : 1);
        else sp.move(x, y, 1 - 0.45 * e, u > 0.85 ? (1 - u) / 0.15 : 1);
      }
    }
  }

  /** Round 7: screen point (app px, before the #coin-flights offset) of the squad's centre for a troop icon; (sx, sy) when unknown. */
  _squadTarget(sx, sy, out) {
    out.x = sx + this._domOffX; out.y = sy + this._domOffY;
    const r = this.ctx.render, w = this.ctx.world, sq = this.ctx.squad;
    if (!r || typeof r.worldToScreen !== 'function' || !w) return;
    _v.set(w.squadX, ICON_TROOP_Y, sq && typeof sq.centerZ === 'number' ? sq.centerZ : 0);
    try { r.worldToScreen(_v, SCREEN_OUT); } catch (_) { return; }
    if (Number.isFinite(SCREEN_OUT.x) && Number.isFinite(SCREEN_OUT.y)) { out.x = SCREEN_OUT.x; out.y = SCREEN_OUT.y; }
  }

  _iconTarget(item, out) {
    const ui = this.ctx.ui;
    out.x = NaN; out.y = NaN;
    if (ui && typeof ui.powerupIconScreenPos === 'function') { try { ui.powerupIconScreenPos(item, out); } catch (_) { out.x = NaN; } }
    if (!Number.isFinite(out.x) || !Number.isFinite(out.y)) {
      const size = this.ctx.render && this.ctx.render.size;
      out.x = (size && size.w > 0 ? size.w : JUICE.ui.refBox[0]) * 0.5; out.y = 70;   // power-up pill row fallback (GDD §14: safe-top + 70)
    }
  }

  // ===========================================================================================
  // Camera / time / screen
  // ===========================================================================================

  /** Adds trauma (0..1); the shake is trauma², decaying JUICE.shake.decay per second. */
  addTrauma(t) {
    if (!(t > 0)) return;
    this._trauma = Math.min(1, this._trauma + t);
  }

  /** Camera shake offset (m) and roll (rad) for render.update; zero under reduced motion. */
  getShake(out) {
    if (this._reduced || !(this._trauma > 0)) { out.x = 0; out.y = 0; out.roll = 0; return out; }
    const s = this._trauma * this._trauma;
    const n0 = this._shakeT * SHAKE_HZ;
    for (let k = 0; k < 3; k++) {
      const t = n0 + SHAKE_OFF[k];
      const fi = Math.floor(t);
      const f = t - fi;
      const i = fi | 0;
      const a = hash30(i) * INV_2P30 * 2 - 1;
      const b = hash30(i + 1) * INV_2P30 * 2 - 1;
      SHAKE_N[k] = a + (b - a) * (f * f * (3 - 2 * f));
    }
    let x = JUICE.shake.x * s * SHAKE_N[0];
    let y = JUICE.shake.y * s * SHAKE_N[1];
    const len = Math.sqrt(x * x + y * y);
    const cap = JUICE.shake.clamp;
    if (len > cap) { x *= cap / len; y *= cap / len; }
    out.x = x; out.y = y;
    out.roll = JUICE.shake.rollDeg * DEG * s * SHAKE_N[2];
    return out;
  }

  /** Time dip → engine.setTimeScale (clamped to WORLD.timeScaleMin); a weaker dip never overrides a stronger running one. */
  slowmo(scale, seconds) {
    const eng = this.ctx.engine;
    if (!eng || typeof eng.setTimeScale !== 'function') return;
    const s = clamp(Number.isFinite(scale) ? scale : 1, WORLD.timeScaleMin, 1);
    const t = this.ctx.time;
    if (t && t.slowmoLeft > 0 && t.scale < s) return;
    eng.setTimeScale(s, seconds);
  }

  /** Full-screen flash via ui.flash; reduced motion → a short dim instead (GDD §7 / §12). */
  flash(colorHex, seconds, alpha) {
    const ui = this.ctx.ui;
    if (!ui || typeof ui.flash !== 'function') return;
    if (this._reduced) ui.flash(PALETTE.ui.pauseDim, JUICE.flashes.reducedDimMs / 1000, REDUCED_DIM_ALPHA);
    else ui.flash(colorHex, seconds, alpha === undefined ? 1 : alpha);
  }

  /**
   * Screen-edge vignette pulse via ui.vignette. Round 7 (contract C → D, DECISIONS §6): `alpha` (0..1, optional) is passed through
   * as ui.vignette's third argument — it scales the vignette's edge alpha (the bite / spit pulse is fainter than a red-gate pass);
   * omitted = full strength.
   */
  vignette(colorHex, seconds, alpha) {
    const ui = this.ctx.ui;
    if (ui && typeof ui.vignette === 'function') ui.vignette(colorHex, seconds, alpha);
  }

  /** FOV kick (degrees added by render.update): quick ramp in, ease out over `seconds`; none under reduced motion. */
  fovKick(deg, seconds) {
    if (this._reduced || !(seconds > 0)) return;
    const cur = this.getFovKick();
    this._fovAmp = deg > cur ? deg : cur;
    this._fovT = 0;
    this._fovDur = seconds;
  }

  getFovKick() {
    if (this._fovDur <= 0 || this._reduced) return 0;
    const u = this._fovT / this._fovDur;
    if (u >= 1) return 0;
    const env = u < FOV_KICK_ATTACK ? u / FOV_KICK_ATTACK : 1 - eOutQuad((u - FOV_KICK_ATTACK) / (1 - FOV_KICK_ATTACK));
    return this._fovAmp * env;
  }

  /** Game-over grade → render.setDesaturate (no-op on Low inside render). */
  setDesaturate(t01) {
    const r = this.ctx.render;
    if (r && typeof r.setDesaturate === 'function') r.setDesaturate(t01 < 0 ? 0 : (t01 > 1 ? 1 : t01));
  }

  /** Real-time ramps: game-over desaturation (JUICE.gameOverDesat) and the boss-death bloom pulse. */
  _updateRamps(udt) {
    if (this._desatT >= 0) {
      this._desatT += udt;
      const u = this._desatT / JUICE.gameOverDesat;
      if (u >= 1) { this.setDesaturate(1); this._desatT = -1; }
      else this.setDesaturate(eOutQuad(u));
    }
    if (this._bloomT >= 0) {
      const r = this.ctx.render;
      this._bloomT += udt;
      const B = RENDER.bloom;
      // round 5 (docs/DISTRICTS.md §8.7): the pulse rides the district's bloom base — it peaks at base + (deathPeak −
      // RENDER.bloom.strength) and hands back to the base (setBloomStrength() with no argument); District 1 is unchanged
      const base = r && Number.isFinite(r.bloomBase) ? r.bloomBase : B.strength;
      const peak = base + (B.deathPeak - B.strength);
      const u = this._bloomT / B.deathTime;
      if (u >= 1) {
        this._bloomT = -1;
        if (r && typeof r.setBloomStrength === 'function') r.setBloomStrength();
      } else {
        const v = u < BLOOM_PULSE_UP
          ? base + (peak - base) * eOutQuad(u / BLOOM_PULSE_UP)
          : peak + (base - peak) * eInOutCubic((u - BLOOM_PULSE_UP) / (1 - BLOOM_PULSE_UP));
        if (r && typeof r.setBloomStrength === 'function') r.setBloomStrength(v);
      }
    }
  }

  /** Guarded vibration, honouring settings.haptics; single pulses closer than HAPTIC_GAP_MS are dropped. */
  haptic(pattern) {
    if (!this._haptics || pattern === undefined || pattern === null) return;
    if (typeof pattern === 'number') {
      const t = this.ctx.time;
      const now = t && typeof t.now === 'number' ? t.now : this._real * 1000;
      if (now - this._lastHaptic < HAPTIC_GAP_MS) return;
      this._lastHaptic = now;
    }
    vibrate(pattern);
  }

  // ===========================================================================================
  // Event wiring — GDD §12 J1–J22 + ARCH §6.12 extras. Payloads are reused scratch objects: every
  // handler copies what it needs immediately and never retains the payload (§5).
  // ===========================================================================================
  _subscribe() {
    const ev = this.ctx.events;
    this._offs = [];
    if (!ev || typeof ev.on !== 'function') return;
    const self = this;
    const on = (name, fn) => { self._offs.push(ev.on(name, fn)); };
    // engine / ui / level lifecycle
    on('state:change', function (p) { self._onState(p); });
    on('resize', function () { self._measureDom(); });
    on('quality:change', function (p) { self._applyQuality(p && p.params ? p.params : null); });
    on('settings:change', function (p) { self._onSettings(p); });
    on('level:start', function () { self._onLevelStart(); });
    on('level:complete', function (p) { self._onLevelComplete(p); });
    on('level:failed', function () { self._onRunLost(); });
    on('endless:end', function () { self._onRunLost(); });
    // squad
    on('squad:count', function (p) { self._onSquadCount(p); });
    on('squad:spawn', function (p) { self._onSquadSpawn(p); });
    on('squad:loss', function (p) { self._onSquadLoss(p); });
    on('armor:change', function (p) { self._onArmor(p); });
    // gates
    on('gate:hit', function (p) { self._onGateHit(p); });
    on('gate:max', function (p) { self._onGateMax(p); });
    on('gate:flip', function (p) { self._onGateFlip(p); });
    on('gate:step', function (p) { self._onGateStep(p); });
    on('gate:pass', function (p) { self._onGatePass(p); });
    // weapons / troops
    on('weapon:start', function (p) { self._onPowerup(p); });
    on('gear:start', function (p) { self._onPowerup(p); });
    on('gear:end', function (p) { if (p && p.id === GEAR.booster.id) self._boosterOn = false; });
    on('weapon:fire', function (p) { self._onWeaponFire(p); });
    on('explosion', function (p) { self._onExplosion(p); });
    on('troop:fire', function (p) { self._onTroopFire(p); });
    // zombies
    on('zombie:hit', function (p) { self._onZombieHit(p); });
    on('zombie:die', function (p) { self._onZombieDie(p); });
    on('zombie:bite', function (p) { self._onZombieBite(p); });
    on('zombie:stagger', function (p) { self._onZombieStagger(p); });
    on('spit:impact', function (p) { self._onSpitImpact(p); });
    // boss
    on('boss:intro', function (p) { self._onBossIntro(p); });
    on('boss:phase', function (p) { self._onBossPhase(p); });
    on('boss:hit', function (p) { self._onBossHit(p); });
    on('boss:shield', function (p) { self._onBossShield(p); });
    on('boss:dead', function (p) { self._onBossDead(p); });
    // pickups / economy
    on('crate:open', function (p) { self._onCrateOpen(p); });
    on('item:pickup', function (p) { if (p && p.item !== 'coins') self.iconFlight(p.item, p.x, 0.8, p.z); });
    on('coin:pickup', function (p) { self._onCoinPickup(p); });
  }

  // ---- lifecycle -------------------------------------------------------------------------------
  _onState(p) {
    const to = p ? p.to : null;
    // JIT / type-feedback warm-up once every system exists (the first title screen), before any gameplay; synchronous,
    // so reset() hides everything it spawned before the frame renders
    if (to === 'title' && !this._primed) {
      this._primed = true;
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      this._primeFeedback();
      this.reset();
      this._primeMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;   // debug console: warm-up cost
    }
    if (this._labelStateOk(to)) { this._labelVisible = true; this._labelHideT = -1; return; }
    if ((to === 'complete' || to === 'gameover') && this._labelVisible) {
      if (this._labelHideT < 0) this._labelHideT = 0;   // fade over LABEL_HIDE_S, then hidden (update)
      return;
    }
    this._labelVisible = false;
    this._hideLabel();
  }

  _onSettings(p) {
    if (!p) return;
    if (p.key === 'haptics') this._haptics = p.value !== false;
    else if (p.key === 'reducedMotion') {
      this._rmSetting = p.value === true || p.value === false ? p.value : null;
      this._updateReduced();
    }
  }

  /** level:start → fx cancels the game-over grade (ARCH §6.12; level also resets render itself). */
  _onLevelStart() {
    this._desatT = -1;
    this.setDesaturate(0);
    const r = this.ctx.render;
    if (r && typeof r.gameOverCamera === 'function') r.gameOverCamera(false);
  }

  /** J17: one haptic tap per star, on the star stagger. */
  _onLevelComplete(p) {
    const stars = p && p.stars > 0 ? Math.min(3, p.stars | 0) : 0;
    this.haptic(stars > 0 ? this._starPatterns[stars] : JUICE.haptics.complete);
  }

  /** J18: desaturate over JUICE.gameOverDesat + the game-over camera; also the endless "run over" (decision). */
  _onRunLost() {
    this._desatT = 0;
    const r = this.ctx.render;
    if (r && typeof r.gameOverCamera === 'function') r.gameOverCamera(true);
    this.haptic(JUICE.haptics.gameover);
  }

  // ---- squad -----------------------------------------------------------------------------------
  /** Count-label driver (ARCH §6.12 — fx is the only caller of tweenTo / snapTo / showMult / setCount). */
  _onSquadCount(p) {
    if (!p) return;
    const count = p.count, reason = p.reason;
    this._lastCount = count;
    const L = this.label;
    if (reason === 'start') { L.setCount(count); return; }
    if (reason === 'gate') return;                         // the label follows gate:pass (which carries the op)
    if (p.delta > 0) {
      if (this._labelPending < 0) L.tweenTo(count);         // else the pending multiplier roll-up goes to _lastCount
      if (reason === 'medic') this._labelBurst(p.delta, G_PLUS, PALETTE.flash.gain);   // GDD §8.3 green "+n" tick
    } else if (p.delta < 0) {
      if (this._labelPending >= 0 && count > L.shown) {     // a multiplier roll-up is about to start: keep the theatre
        L._punch(JUICE.label.punchDown);
        L._flash(PALETTE.flash.loss, JUICE.label.flashDown);
        return;
      }
      L.snapTo(count);
    }
  }

  /** "+17" / "−15" burst at the label, rising JUICE.gateBurst.risePx over JUICE.gateBurst.life (GDD §5). */
  _labelBurst(value, sign, colorHex) {
    const L = this.label;
    if (!L.hasPos || !(value > 0)) return;
    const h = L.height > 0 ? L.height : 0.5;
    this._floaterNum(value, sign, L.x, L.y + h * 0.95, L.z, colorHex, JUICE.gateBurst.risePx * L.mPerPx, JUICE.gateBurst.life, h * 0.72, LABEL_TEXT_PEAK);
  }

  /** squad:spawn → burst at the spawn origin (gate footprint / blob centre). */
  _onSquadSpawn(p) {
    if (!p) return;
    this._emitRaw(K_SPARK, JUICE.bursts.flip >> 1, p.x, 0.7, p.z, 0, 1.5, 0, 3.5, 0.6, P_LIFE[K_SPARK], P_SIZE[K_SPARK], P_GRAVITY[K_SPARK], 0, C_WHITE);
    this._emitRaw(K_DUST, 5, p.x, 0.1, p.z, 0, 0, 0, 2.2, 0.15, P_LIFE[K_DUST], P_SIZE[K_DUST], P_GRAVITY[K_DUST], 0, C_DUST);
  }

  /**
   * J10: soldier dies — 6 blood particles, "−1" floater (merged into "−k" within JUICE.floater.mergeMs), haptic. Round 7 (r7
   * teaching:1, the tester's "zombie threat not obvious … the only feedback is small −1 popups"): deaths within 300 ms merge, the
   * "−k" reads lossScale × its old size (lossScaleBig from k ≥ lossBigFrom), the haptic is 25 ms, and a bite or spit loss pulses the
   * red edge vignette (JUICE.flashes.biteVignette*, at most once per biteVignetteGap s, stronger for a bigger "−k").
   */
  _onSquadLoss(p) {
    if (!p) return;
    const x = p.x, z = p.z;
    this._burstColored(B_BLOODSMALL, x, 0.9, z, C_BLOOD, 1);
    const merge = this._lossF >= 0 && this._fAlive[this._lossF] && (this._real - this._lossTime) * 1000 <= JUICE.floater.mergeMs
      && this._lossK < NUMBER_MAX;
    if (merge) {
      const i = this._lossF;
      this._lossK++;
      this._fN[i] = writeNumberGlyphs(this._fGlyph, i * MAX_TEXT, this._lossK, G_MINUS, MAX_TEXT);
      this._fAge[i] = Math.min(this._fAge[i], this._fLife[i] * 0.1);   // re-pop the merged number
      this._fSize[i] = FLOATER_SIZE * (this._lossK >= LOSS_BIG_FROM ? LOSS_SCALE_BIG : LOSS_SCALE);
    } else {
      this._lossK = 1;
      // world position = fallback while the label has no anchor; otherwise it reads beside the label (_followLoss)
      this._lossF = this._floaterNum(1, G_MINUS, x, LOSS_FLOATER_Y, z, PALETTE.flash.loss, JUICE.floater.rise, JUICE.floater.life, FLOATER_SIZE * LOSS_SCALE, LABEL_TEXT_PEAK);
      if (this._lossF >= 0) { this._fFollow[this._lossF] = 1; this._fSide[this._lossF] = this._lossSide(); }
      this._lossTime = this._real;
    }
    const cause = p.cause;
    if ((cause === 'bite' || cause === 'spit') && this._real - this._biteVigAt >= JUICE.flashes.biteVignetteGap) {
      this._biteVigAt = this._real;
      const a = JUICE.flashes.biteVignetteAlpha + JUICE.flashes.biteVignetteAlphaPer * (this._lossK - 1);
      this.vignette(PALETTE.flash.red, JUICE.flashes.biteVignette, a < 1 ? a : 1);
    }
    this.haptic(JUICE.haptics.loss);
  }

  /** Armour plate shatters with a blue spark (GDD §8.2). */
  _onArmor(p) {
    if (!p || !(p.delta < 0)) return;
    const w = this.ctx.world, sq = this.ctx.squad;
    const x = w ? w.squadX : 0;
    const z = sq && typeof sq.centerZ === 'number' ? sq.centerZ : (w ? w.squadDepth * 0.5 : 0);
    this._emitRaw(K_SPARK, Math.min(12, -p.delta * 3), x, 1.2, z, 0, 1.0, 0, 4.0, 0.5, P_LIFE[K_SPARK], P_SIZE[K_SPARK], P_GRAVITY[K_SPARK], 0, C_BLUE);
  }

  // ---- gates -----------------------------------------------------------------------------------
  /** Gate type index (GATE_RULES.colors key order) for the colour a gate currently shows. */
  _gateType(op, value, gate) {
    if (op === 'item') return 5;
    if (op === '+') return 0;
    if (op === 'x') return value > 1 ? 1 : 4;
    if (op === '-') return gate && gate.flipped ? 0 : 2;
    if (op === '/') return gate && gate.flipped ? 1 : (value > 1 ? 3 : 4);
    return 0;
  }

  /** J3: 3 sparks at the impact, in the gate's colour (budgeted against laser / rail floods). */
  _onGateHit(p) {
    if (!p) return;
    const g = p.gate;
    const t = g ? this._gateType(g.op, g.value, g) : 0;
    const y = p.y > GATE_RULES.panel.bottom ? p.y : GATE_HIT_Y;
    const n = this._hitBudget > 0 ? JUICE.bursts.gateSpark : 1;
    this._hitBudget--;
    this._emitRaw(K_SPARK, n, p.x, y, p.z, 0, 0.5, 2.0, GATE_SPARK_SPEED, SPARK_UP, SPARK_LIFE, SPARK_SIZE, SPARK_GRAVITY, 0, C_GATE[t]);
  }

  /** J4: 12 gold sparks + haptic. */
  _onGateMax(p) {
    const g = p && p.gate;
    if (!g) return;
    this._burstColored(B_MAX, g.x, PANEL_CENTER_Y, g.z, C_GOLD, 1);
    this.haptic(JUICE.haptics.max);
  }

  /** J5: 16 sparks in the colour the gate flips to + haptic (the panel flash / recolour is gates'): a red '−'
   *  turning into a blue '+' bursts blue, a ÷ ladder reaching x2 (GDD §4.1 green x type) bursts green. */
  _onGateFlip(p) {
    const g = p && p.gate;
    if (!g) return;
    this._burstColored(B_FLIP, g.x, PANEL_CENTER_Y, g.z, C_GATE[this._gateType(g.op, g.value, g)], 1);
    this.haptic(JUICE.haptics.flip);
  }

  /** J6: multiplier step — haptic plus a small green ring of sparks (the punch / ring wipe are gates'). */
  _onGateStep(p) {
    const g = p && p.gate;
    if (!g) return;
    this._emitRaw(K_SPARK, 6, g.x, PANEL_CENTER_Y, g.z, 0, 0, 1.0, 3.0, 0.3, P_LIFE[K_SPARK], P_SIZE[K_SPARK], P_GRAVITY[K_SPARK] * 0.5, 0, C_GATE[1]);
    this.haptic(JUICE.haptics.step);
  }

  /**
   * Pass classification by the gate's effective op / value (never by before/after, which are equal at C = 1 or at
   * the cap): 1 = positive (J7: blue '+n', green x>1, flipped ÷ x2, item), −1 = negative (J8: red '−n' not flipped,
   * '/' with divisor > 1), 0 = neutral (grey x1, value 0, flipped '+0'). gate:pass reports a flipped '−' as '+'.
   * Shared contract with audio's pass sound (AUD-3).
   */
  _passKind(op, value, g, before, after) {
    const flipped = !!(g && g.flipped);
    if (op === 'item') return 1;
    if (op === '+') return value > 0 ? 1 : 0;
    if (op === '-') return value === 0 ? 0 : (flipped ? 1 : -1);
    if (op === 'x') return value > 1 ? 1 : (value > 0 && value < 1 ? -1 : 0);
    if (op === '/') return flipped ? (value > 1 ? 1 : 0) : (value > 1 ? -1 : 0);
    return after > before ? 1 : (after < before ? -1 : 0);
  }

  /** J7 / J8 / neutral pass + the count-label driver for passes (ARCH §6.12). */
  _onGatePass(p) {
    if (!p) return;
    const g = p.gate, op = p.op, before = p.before, after = p.after;
    const L = this.label;
    const kind = this._passKind(op, p.value, g, before, after);
    // ---- label ----
    if ((op === 'x' || (op === '/' && g && g.flipped)) && kind > 0) {
      L._showMultValue(p.value, JUICE.label.multShow);
      this._labelPending = JUICE.label.multShow;
    } else if (op === '+') {
      L.tweenTo(after);
    } else if (op === '-' || op === '/' || op === 'x') {
      if (after > before) L.tweenTo(after); else L.snapTo(after);   // neutral x1 / '/1': no badge, no change
    }
    // ---- panel shatter + juice ----
    const triple = g && g.layout === 'triple';
    const w = triple ? GATE_RULES.panel.wTriple : GATE_RULES.panel.w;
    const t = kind === 0 ? 4 : this._gateType(op, p.value, g);
    const tint = GATE_RULES.colors[GATE_KEYS[t]].tint;
    if (kind > 0) {
      this._shatter(p.x, p.z, w, GATE_RULES.panel.h, tint, SHATTER_TOWARD);
      this.addTrauma(JUICE.trauma.gatePass);
      this.haptic(JUICE.haptics.passUp);
      if (after > before) {
        this._labelBurst(after - before, G_PLUS, PALETTE.flash.gain);
        this._emitRaw(K_SPARK, 10, p.x, PANEL_CENTER_Y, p.z, 0, 0, 3.0, 4.0, 0.4, P_LIFE[K_SPARK], P_SIZE[K_SPARK], P_GRAVITY[K_SPARK], 0, C_GATE[t]);
      }
    } else if (kind < 0) {
      this._shatter(p.x, p.z, w, GATE_RULES.panel.h, tint, SHATTER_AWAY);
      this.vignette(PALETTE.flash.red, JUICE.flashes.negVignette);
      this.haptic(JUICE.haptics.passDown);
      this._labelBurst(before - after, G_MINUS, PALETTE.flash.loss);
    } else {
      // neutral: the grey panel crumbles in place with a small dust / smoke puff — no reward theatre, no trauma / haptic
      this._shatter(p.x, p.z, w, GATE_RULES.panel.h, tint, SHATTER_NEUTRAL);
      const road = this.ctx.world ? this.ctx.world.roadSpeed : 0;
      this._emitRaw(K_SMOKE, 4, p.x, PANEL_CENTER_Y, p.z, 0, 0.4, 0, 1.0, 0.5, P_LIFE[K_SMOKE] * 0.6, P_SIZE[K_SMOKE], P_GRAVITY[K_SMOKE], road, C_SMOKE);
      this._emitRaw(K_DUST, 6, p.x, PANEL_CENTER_Y, p.z, 0, 0, 0, 1.6, 0.4, P_LIFE[K_DUST] * 0.5, P_SIZE[K_DUST], P_GRAVITY[K_DUST], road, C_DUST);
    }
  }

  // ---- weapons / troops ---------------------------------------------------------------------------
  /** J13: screen-edge glow in the power-up colour + haptic (weapons and gear). */
  _onPowerup(p) {
    if (!p) return;
    const c = this._weaponColor.get(p.id);
    this.vignette(c !== undefined ? c : PALETTE.flash.weaponEdge, JUICE.powerup.edgeGlow);
    this.haptic(JUICE.haptics.powerup);
    if (p.id === GEAR.booster.id) this._boosterOn = true;
  }

  /** J21 haptics only. weapons.js applies the rest of J21 itself at the moment it happens (rocket
   *  detonation: fx.addTrauma(WEAPONS.rocket.trauma) + fx.fovKick; rail bolt: fx.flash(white, railgun.flash)
   *  + muzzle sparks), so adding them here again would double the shake (T² → 4×) and the flash
   *  (integration decision: one owner per effect). */
  _onWeaponFire(p) {
    if (!p) return;
    if (p.id === WEAPONS.rocket.id) this.haptic(JUICE.haptics.rocket);
    else if (p.id === WEAPONS.railgun.id) this.haptic(JUICE.haptics.rail);
  }

  /** Rocket / APC explosion: 30 orange sparks, blast flash, smoke, dust; the APC also shakes (troops report). */
  _onExplosion(p) {
    if (!p) return;
    const scale = p.radius > 0 ? p.radius / WEAPONS.rocket.splash : 1;
    const k = scale < 0.6 ? 0.6 : (scale > 2 ? 2 : scale);
    this._burstColored(B_ROCKET, p.x, 0.6, p.z, C_ROCKET, k);
    this._spawnScorch(p.x, p.z, SCORCH_SIZE * k);
    if (p.kind === 'apc') {
      this.addTrauma(JUICE.trauma.rocket);
      this.fovKick(JUICE.fovKick.rocket, JUICE.fovKick.seconds);
      this.haptic(JUICE.haptics.rocket);
    }
  }

  /** Sniper: red tracer line + crit number with the damage of the hit it just landed (ARCH §6.6). */
  _onTroopFire(p) {
    if (!p || p.id !== TROOPS.sniper.id) return;
    // the muzzle height troops reports (CHR-14: the posed, 1.4×-scaled rifle); the crate + soldier muzzle offset otherwise
    const y0 = typeof p.y === 'number' && p.y === p.y ? p.y : TROOPS.sniper.crateH + FIRE.muzzleOffset[1];
    const y1 = typeof p.ty === 'number' && p.ty === p.ty ? p.ty : BEAM_TARGET_Y;
    this._spawnBeam(p.x, y0, p.z, p.tx, y1, p.tz);
    if (this._lastHitStamp === this._hitStamp && this._lastHitDmg > 0) {
      // the hit was just merged into a brute / boss accumulator: take it back out so it shows once, as the crit
      const s = this._lastHitAcc;
      if (s >= 0 && this._naId[s] >= 0) {
        this._naSum[s] -= this._lastHitDmg;
        if (this._naSum[s] <= 0.5) { this._naId[s] = -1; this._naSum[s] = 0; }
      }
      this._numberSpawn(this._lastHitDmg, p.tx, BEAM_TARGET_Y + 1.2, p.tz, PALETTE.gate.max, NUMBER_CRIT_SCALE, NUMBER_CRIT_GAIN, -1);
      this._lastHitStamp = -1;
    }
  }

  // ---- zombies ---------------------------------------------------------------------------------
  /** J2: 4 sparks at the hit (budgeted); damage numbers on brutes (merged per target). */
  _onZombieHit(p) {
    if (!p) return;
    const n = this._hitBudget > 0 ? JUICE.bursts.hitSpark : 1;
    this._hitBudget--;
    this._emitRaw(K_SPARK, n, p.x, p.y, p.z, 0, 0.4, 1.5, SPARK_SPEED, SPARK_UP, SPARK_LIFE, SPARK_SIZE, SPARK_GRAVITY, 0, C_SPARK);
    this._hitStamp++;
    this._lastHitStamp = this._hitStamp;
    this._lastHitDmg = p.damage > 0 ? p.damage : 0;
    this._lastHitAcc = -1;
    if (p.type === 'brute' && p.damage > 0) {
      this._lastHitAcc = this._accDamage(p.id, false, p.damage, p.x, ZOMBIES.brute.height + 0.4, p.z);
      if (p.killed) { this._flushSlot(this._lastHitAcc); this._lastHitAcc = -1; }
    }
  }

  /** J9 blood + J20 near-miss (zombie dies within JUICE.nearMissRadius of the squad: time dip + dust puff). */
  _onZombieDie(p) {
    if (!p || p.cause === 'cleanup') return;
    const def = ZOMBIES[p.type];
    const h = def ? def.height : 1.6;
    const y = h * BLOOD_Y_FRACTION;
    if (p.cause === 'bite') { this._burstColored(B_BLOODSMALL, p.x, y, p.z, C_BLOOD, 1); return; }
    this._burstColored(B_BLOOD, p.x, y, p.z, C_BLOOD, p.type === 'brute' ? 2 : 1);
    const sq = this.ctx.squad;
    if (sq && typeof sq.intersectsCircle === 'function' && sq.intersectsCircle(p.x, p.z, JUICE.nearMissRadius)) {
      this.slowmo(JUICE.slowmo.nearMiss[0], JUICE.slowmo.nearMiss[1]);
      this._emitRaw(K_DUST, 6, p.x, 0.1, p.z, 0, 0, 0, 2.0, 0.2, P_LIFE[K_DUST], P_SIZE[K_DUST], P_GRAVITY[K_DUST], this.ctx.world ? this.ctx.world.roadSpeed : 0, C_DUST);
    }
  }

  /** J11: brute swing lands — trauma + haptic + dust (the ring telegraph is zombies' decal). */
  _onZombieBite(p) {
    if (!p || p.type !== 'brute') return;
    this.addTrauma(JUICE.trauma.brute);
    this.haptic(JUICE.haptics.brute);
    this._emitRaw(K_DUST, 8, p.x, 0.1, p.z + 0.6, 0, 0, 0, 3.0, 0.15, P_LIFE[K_DUST], P_SIZE[K_DUST] * 1.3, P_GRAVITY[K_DUST], 0, C_DUST);
  }

  /** Brute stagger: white flash sparks at the chest. */
  _onZombieStagger(p) {
    if (!p) return;
    this._emitRaw(K_SPARK, 8, p.x, ZOMBIES.brute.height * 0.65, p.z, 0, 0.5, 0.5, 4.0, 0.4, P_LIFE[K_SPARK], P_SIZE[K_SPARK] * 1.2, P_GRAVITY[K_SPARK], 0, C_WHITE);
  }

  /** J22: green splash decal (radius → diameter) + 10 green particles + haptic when it cost soldiers. */
  _onSpitImpact(p) {
    if (!p) return;
    const r = p.radius > 0 ? p.radius : ZOMBIES.spitter.spit.splash;
    this._allocDecal(D_SPLAT, p.x, p.z, r * 2, SPLAT_SECONDS, C_ACID, false, true);
    this._burstColored(B_SPLAT, p.x, 0.15, p.z, C_ACID, 1);
    if (p.kills > 0) this.haptic(JUICE.haptics.spit);
  }

  // ---- boss ------------------------------------------------------------------------------------
  /** Boss intro (GDD §7): trauma 0.3 + haptic 80 ms (mini-bosses emit duration 0: no theatre). */
  _onBossIntro(p) {
    if (!p || !(p.duration > 0)) return;
    this.addTrauma(JUICE.trauma.bossIntro);
    this.haptic(JUICE.haptics.bossIntro);
  }

  /** J15: phase 2 / 3 — white flash 0.1 s, trauma 0.25, haptic (plates / sparks are boss'). */
  _onBossPhase(p) {
    if (!p || !(p.phase >= 2)) return;
    this.flash(PALETTE.flash.white, JUICE.flashes.bossPhase, 1);
    this.addTrauma(JUICE.trauma.bossPhase);
    this.haptic(JUICE.haptics.bossPhase);
  }

  /** Boss hit: sparks (budgeted) + merged damage numbers; crits show at once, larger and gold. */
  _onBossHit(p) {
    if (!p) return;
    const n = this._hitBudget > 0 ? JUICE.bursts.hitSpark : 1;
    this._hitBudget--;
    this._emitRaw(K_SPARK, n, p.x, p.y, p.z, 0, 0.4, 1.5, SPARK_SPEED, SPARK_UP, SPARK_LIFE, BOSS_SPARK_SIZE, SPARK_GRAVITY, 0, C_SPARK);
    this._hitStamp++;
    this._lastHitStamp = this._hitStamp;
    this._lastHitDmg = p.damage > 0 ? p.damage : 0;
    this._lastHitAcc = -1;
    if (!(p.damage > 0)) return;
    if (p.crit) { this._numberSpawn(p.damage, p.x, BOSSES.coreY + 1.6, p.z, PALETTE.gate.max, NUMBER_CRIT_SCALE, NUMBER_CRIT_GAIN, -2); this._lastHitStamp = -1; return; }
    this._lastHitAcc = this._accDamage(0, true, p.damage, p.x, BOSSES.coreY + 1.6, p.z);
  }

  /** Colossus shield: ring gauge decal at the boss core kept while `up`, progress hits/needed (ARCH §6.12). */
  _onBossShield(p) {
    if (!p) return;
    if (p.up) {
      let s = this._decalSlot(this._shieldDecal);
      if (s < 0) {
        this._shieldDecal = this._allocDecal(D_RING, p.x, p.z, SHIELD_RING_SIZE, Infinity, C_SHIELD, true, false);
        s = this._decalSlot(this._shieldDecal);
      }
      if (s >= 0) {
        this._dX[s] = p.x; this._dZ[s] = p.z;
        this._dProg[s] = p.needed > 0 ? clamp(p.hits / p.needed, 0, 1) : 0;
      }
    } else if (this._shieldDecal >= 0) {
      this.removeDecal(this._shieldDecal);
      this._shieldDecal = -1;
      this._emitRaw(K_SPARK, JUICE.bursts.flip, p.x, BOSSES.coreY * 0.25, p.z, 0, 1.0, 0, 6.0, 0.3, P_LIFE[K_SPARK], P_SIZE[K_SPARK] * 1.3, P_GRAVITY[K_SPARK], 0, C_SHIELD);
    }
  }

  /** J16: white flash, 200 confetti, bloom 0.6 → 1.6 → 0.6, haptic (slow-mo + trauma are boss'; coins below). */
  _onBossDead(p) {
    if (!p) return;
    this._flushNumbers(true);
    this.flash(PALETTE.flash.white, JUICE.flashes.bossDeath, 1);
    this._burstColored(B_BOSSDEATH, p.x, BOSSES.coreY + CONFETTI_Y, p.z, -1, 1);
    this._bloomT = 0;
    this.haptic(JUICE.haptics.bossDeath);
    if (this._shieldDecal >= 0) { this.removeDecal(this._shieldDecal); this._shieldDecal = -1; }
  }

  // ---- pickups / economy -------------------------------------------------------------------------
  /** J12: crate opened — gold sparkle + dust + haptic (the icon flight follows from item:pickup). */
  _onCrateOpen(p) {
    if (!p) return;
    const y = PICKUPS.crate.size * 0.6;
    this._burstColored(B_MAX, p.x, y, p.z, C_GOLD, 1);
    this._emitRaw(K_DUST, 6, p.x, 0.1, p.z, 0, 0, 0, 2.0, 0.2, P_LIFE[K_DUST], P_SIZE[K_DUST], P_GRAVITY[K_DUST], this.ctx.world ? this.ctx.world.roadSpeed : 0, C_DUST);
    this.haptic(JUICE.haptics.crate);
  }

  /** J19 coin flight (the boss credit is the J16 60-coin fountain + a sprite stream; the level bonus has no world origin). */
  _onCoinPickup(p) {
    if (!p || p.source === 'bonus' || !(p.amount > 0)) return;
    const y = typeof p.y === 'number' ? p.y : 1;
    if (p.source === 'boss') {
      this._burstColored(B_COINFOUNTAIN, p.x, y, p.z, C_GOLD, 1);
      if (this._coinSprites.length > 0) this._launchCoins(p.x, y, p.z, COIN_BOSS_SPRITES, p.amount);
      return;
    }
    if (p.source === 'pile') this._emitRaw(K_COINSPARKLE, 3, p.x, y, p.z, 0, 0.6, 0, 1.2, 0.5, P_LIFE[K_COINSPARKLE], P_SIZE[K_COINSPARKLE], P_GRAVITY[K_COINSPARKLE], 0, C_GOLD);
    this.coinFlight(p.x, y, p.z, p.amount);
  }
}
