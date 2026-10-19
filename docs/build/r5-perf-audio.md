# Round 5 — perf / audio: boss-arrival first use (1), audio node cost (2), reward mix (3)

Owner files: `js/boss.js`, `js/audio.js`; in `js/data.js` only `AUDIO_CUES.*` and `MUSIC.*`. Each data.js edit was an anchor-checked replacement on a fresh read of the file (`EV/tools/rep.cjs`). Other owners edited data.js, level.js, save.js, ui.js and models.js during this pass; I did not touch their edits.

`docs/DISTRICTS.md` and the DISTRICTS data needed nothing from these files. Bosses are untouched by districts (§6.3), and the banner whoosh is optional (§5). I found nothing wrong in the spec.

**Evidence root:** `E:/Temp/claude/gate-rush-evidence/r5/perf-audio/`, written `EV/` below.

**Before / after method.**
- **Baseline.** `EV/src-before/` holds the files as handed over.
- **"Before" in A/B runs** is the live tree with my three files swapped back. The tools serve it two ways:
  - with overrides from `EV/before-overrides/`;
  - as `EV/mirror-before/`, built by `EV/tools/mkmirrors.cjs`, where data.js is the live file with only its MUSIC and AUDIO_CUES sections from before.
- Every A/B below is interleaved: before, after, before, after.

**Host.** It was shared and loaded the whole time: CPU at 91 %, 30+ Chrome processes from other agents. Single frames therefore swing a lot, so I report medians of interleaved runs. The 4× runs use 390 × 844 at DPR 2.75 on Medium.

## Verdict

**(1) Boss arrival at 4× CPU: my share is fixed; the frame is at 34.7 ms, not yet ≤ 33.**
- The arrival frame's JS fell from a median of **45.2 ms to 26.0 ms**: 3 interleaved framesplit pairs, `EV/split-ab1/`.
- The frame interval was 62.5 / 48.6 / 62.5 ms before and is **62.5 / 34.6 / 34.7 ms** after. 34.7 ms is 5 vsyncs on this 144 Hz panel.
- What is left:
  - level's own cold `_fireBoss` code: 2.6 ms;
  - the fx and ui `boss:intro` / `boss:spawn` listeners;
  - `render.draw`'s normal 10–13 ms.
- These are other owners' code; see needsOtherGroup 1–3.

**(2) Audio cost: met.**

| At 4× CPU | Before | After |
|---|---|---|
| Big gate pass (`pass_up` + `hup` at C 32) | 14.3 / 15.8 ms, 46 nodes | **1.7 / 1.4 ms, 4 nodes** |
| Pad downbeat | 5.2 / 7.8 ms, 18 nodes | **0.7 / 0.8 ms, 2 nodes** |
| Full level downbeat | 10.4 / 9.9 ms, 32 nodes | 4.7 / 4.7 ms, 16 nodes |
| Boss-intro roar | 3.1 / 3.3 ms, 9 nodes | 1.1 / 0.9 ms, 2 nodes |

- Pre-rendered and live output are the same audio (§2.3).

**(3) Mix: met.**
- **Default music fader.** It is now 70: save.js already had it (ui owner), and audio's fallbacks now match.
- **New `MUSIC.rewardLift`.** It lifts the reward bus toward the music fader while music is above sound.
- **Rise of the gate-pass reward over the bed** (min / median, dB):

  | Setting | Before | After |
  |---|---|---|
  | Sound 50 / music 80 | 3.0 / 3.9 | **6.7 / 7.3** |
  | Sound 50 / music 70 | 3.7 / 4.5 | **6.3 / 7.1** |
  | Sound 50 / music 80, C 300 | — | 6.6 / 7.2 |

- **Defaults are unchanged by construction.** 100 / 70 measures 8.5 / 9.0 against 8.5 / 9.4 before, and 100 / 80 measures 7.7 / 8.5.
- **No clipping.** No sample is clipped. In the default C 300 run the master peaks at −3.3 dBFS and nothing goes over the soft-clip knee.

**Static checks and smoke.**
- `node --check` passes on all 22 js files. `node tools/check-imports.js` reports 0 errors and 0 warnings.
- **Smoke runs, all CLEAN** (0 page errors, 0 console errors, 0 warnings):
  - `smoke --scenario all`, twice: L1 won, then the HOME tap lands on the title;
  - `--scenario play --boss --quality med`: worst frame 13.8 ms.
- The two `all` runs each had a 0.1–0.2 s cluster of 55–201 ms frames at a random time: 47.5 s and 36.6 s, in the run-up and not at the boss. That is the loaded host; see remaining issue 2.

## 1. Boss-arrival first-use frame

### Root cause (measured)

**Cold against repeated arrival** in the same page (`EV/base/arr-1`, `EV/tools/arrival.mjs --twice`):
- the first arrival's JS is 52.5 ms;
- a second arrival in the same page is 25.8 ms.

So about half the frame is first use.

**Split of the cold frame** (`EV/base/fs-1`, `EV/tools/framesplit2.mjs` wraps the per-system methods):

| Part | ms |
|---|---|
| `level._fireBoss` | 10.4–11.2 |
| … of which `boss.spawn` | 4.9–9.2 |
| `boss.render` (`_renderUnit` 1.9–4.2 + `_renderLight` 0.5–1.3) | 3.1–6.8 |
| `boss.step` | 1.2–2.1 |
| `audio.update` (the roar: 9 nodes + 3 shapers) | 2.6–3 |

- **boss.js.** Every function on the arrival path ran for the first time in that frame: `spawn`, the intro `step` / `_moveUnit`, `render` / `_renderUnit` / `_renderLight`, `_restoreRig` and `aimPoint`. That means lazy compilation, cold inline caches and first-use feedback. Before this pass, `render()` returned early every frame until a boss existed.
- **Rigs and archetypes.** Rig builds and archetype resolution were already boot work (round-3 `initStep`), and phase tables are data. None of them is in the frame.

### Change (`js/boss.js`)

- **`_warmArchetype(key)`** (`js/boss.js:296`) is a silent dress rehearsal. It runs, on the hidden rig or rigs:
  - `spawn`, including the intro choreography and dolly bookkeeping;
  - two intro `step`s and a `render`;
  - `_beginFight`, a fight `step` and a `render`;
  - one `damage` hit;
  - `aimPoint` and `intersectsSquad`;
  - then `reset()`, all within one call.
- **Side effects are contained:**
  - Every sink is detached for the pass: events, engine, squad, weapons, render, fx, zombies, troops and level. So there is no emit, input lock, dolly, blob shadow or minion.
  - `spawn()` keeps those sinks detached while `_warmingRig` is set (`:599`).
  - `ctx.world.bossActive / bossX / bossZ` and the core light's intensity, position and colour are put back exactly.
  - Nothing draws a random number: attacks, globs and hit jitter are not reached.
  - The rig is visible only inside the synchronous call, so it is never drawn.
  - It never runs while a boss is live, and it allocates nothing: the spec and scratch are module-level, `:109`–`:115`.
- **Boot.** `initSteps` / `initStep` (`:271` / `:275`) count one rehearsal per archetype after the rig builds, six in all; the twin keys cover the second rig of their root. main already runs `initSteps` one per painted frame, so no main change was needed.
- **Per level.** `reset()` (`:359`) re-queues the rehearsals, and `step()` (`:1097`) runs them one archetype per step, starting 45 fixed steps after a level start. This way the code is still compiled about 50 s later, however long the title sat idle (V8 flushes bytecode that has not run for a while).

### Numbers

**Framesplit, 3 interleaved pairs, boss-arrival frame** (`EV/split-ab1/`, `EV/tools/summ-split.cjs`). Values are medians in ms.

| Part | Before | After |
|---|---|---|
| frame JS | **45.2** | **26.0** |
| `level._fireBoss` (incl. spawn) | 10.6 | 5.3 |
| `boss.spawn` | 7.6 | 2.7 |
| `boss.render` | 6.3 | **0.2** |
| `boss.step` | 1.1 | 0 |
| `audio.update` | 3.0 | 1.7 |
| `ui.update` | 3.8 | 1.8 |
| `render.draw` | 13.1 | 12.6 |
| rAF interval (runs 1 / 2 / 3) | 62.5 / 48.6 / 62.5 | 62.5 / 34.6 / 34.7 |

- **Run after-1** had `render.draw` at 21.3 ms against 10–13 ms elsewhere: host noise.
- **What `boss.spawn`'s 2.7 ms still holds:**
  - its listeners: `boss:intro` 1.2–1.3 ms (fx `_onBossIntro` 0.6–0.8, ui, audio) and `boss:spawn` 0.3–0.4 ms (ui);
  - other modules' setters (`squad.setInvulnerable` 0.2, `render.dollyTo` 0.1–0.2);
  - `_restoreRig` 0.3.

**Whole-frame probe** (`EV/arr-ab1/`; `arrival.mjs --twice --prio`, CPU trace; summary from `EV/tools/summ-arrival.cjs`). Cold arrival JS (ms):

| Run | Before | After |
|---|---|---|
| 1 | 44.8 | 31.3 |
| 2 | 43.2 | 43.1 |
| 3 | 52.6 | 57.6 |

- Runs after-2 and after-3 carry 25 ms of `render.js:450` in the trace (the render pass), so this probe is dominated by host noise in the render pass.
- The framesplit split above is the cleaner A/B.

**Boot, 4× CPU** (`EV/throttle-boot-*.log`, the verify throttle tool, 2 interleaved pairs). The boss rehearsals add no boot gap.

| | Before | After |
|---|---|---|
| Worst painted gaps (ms) | 285 / 271 | 250 / 292 |
| Over 300 ms | none | none |
| Title frames over 50 ms | 0 | 0 |

- **Title worst frame:** 27.8 / 34.7 ms before, 41.6 / 48.7 ms after. The audio render jobs run in idle callbacks, which can be forced by their 200 ms timeout.
- **Wall time to the title:** 8.6–8.9 s before, 9.5–9.6 s after on this host.

## 2. Audio node cost: pre-rendered instances

### Change (`js/audio.js`; data `AUDIO_CUES.*.prerender`, `MUSIC.prerender`, `MUSIC.instruments.pad.prerender`)

**1. Render once, with the same code** (`_renderJob`, `js/audio.js:1064`).
- The warm-up gains one item per render job (`:1041`; jobs are built in `init`, `:637`).
- Each job swaps `_ac` (and `_musicBus` for the pad) to its own `OfflineAudioContext` for the synchronous build. It then builds the instance through the unchanged `_startCue` / `_musicNote`:
  - at rate 1;
  - with local randomness (`_rnd`), so `rngFx` is untouched;
  - with fresh WaveShapers (`_newShaper`, `:1810`), never the live pool;
  - with the lead delay trimmed through `_layerShiftS`.
- It restores everything in `finally` and calls `startRendering()`. The browser renders off the main thread.
- The voice records are dropped without disconnecting (`_forgetVoice`, `:1123`).
- **Plan** (`makePrePlan`, `:357`): one buffer per `at` entry [pitch, stretch] × chorus size 1 … `voices.max` × variant, and one per distinct pad chord. **25 buffers in all**, about 3 MB of Float32 audio, the pad chords 1.9 MB of it:

  | Cue | Buffers |
  |---|---|
  | `hup` | 15 (n = 1, plus n = 2 … 8 × 2 variants) |
  | `pass_up` | 1 |
  | `roar` at pitch 1 and 0.6 | 4 (× 2 variants) |
  | `fanfare` | 1 |
  | pad chords | 4 |

- No new random draws at play time beyond one `rngFx` draw for the variant choice.

**2. Play** (`_startCue` `:1539` → `_startPre` `:1614`).
- A play whose stretch matches and whose pitch is within `MUSIC.prerender.pitchTol` (±10 %) is **one AudioBufferSource** into the cue gain. The condition is rate 1, or a `noTimeScale` cue.
  - The cue gain, panner and stackDb bookkeeping are unchanged.
  - playbackRate is the pitch ratio, and the source is registered in the voice's source table, so `setTimeScale` re-times it like any buffer source.
- Anything else is built by the layer chains as before (`_startLayers`, `:1553`). That covers another pitch, slow-mo on a cue that follows it, a render not finished yet, no `OfflineAudioContext`, and the dry builds themselves.
- **The boss-death roar** (pitch 0.4, stretched, under the slow-mo rate) stays live.

**3. Pad** (`_scheduleStep` `:2201` → `_padChord` `:2305`).
- A downbeat plays the rendered chord at the music rate through one envelope GainNode set to the mode's pad level. The chord was rendered at a bar's hold plus release at rate 1, so under slow-mo its hold still spans the scheduler's lengthened bar.
- That GainNode is the voice's `env`, so a loop restart fades it like any note.
- Until the render is done, the notes are built live.

### Numbers

**Node count and JS per call on a fresh page at 4×** (`EV/audio-ab1/audiocost-*`, `EV/tools/audiocost.mjs`).
- Every `BaseAudioContext.create*` on the live context is counted.
- 15 repetitions per item; median ms of 2 interleaved runs per side.

| Item | Before | After |
|---|---|---|
| big pass: `pass_up` + `hup` (C 32 → 8 voices) | 14.3 / 15.8 ms, **46 nodes** | **1.7 / 1.4 ms, 4 nodes** |
| `hup` C 32 alone | 8.1 / 7.8 ms, 33 nodes | 0.6 / 0.8 ms, 2 nodes |
| `pass_up` alone | 5.1 / 3.7 ms, 13 nodes | 0.8 / 0.8 ms, 2 nodes |
| boss-intro roar | 3.1 / 3.3 ms, 9 nodes + 3 pooled shapers | 1.1 / 0.9 ms, 2 nodes |
| brute roar (positional) | 3.3 / 3.4 ms, 10 nodes | 0.9 / 1.2 ms, 3 nodes |
| downbeat, menu (pad only) | 5.2 / 7.8 ms, **18 nodes** | **0.7 / 0.8 ms, 2 nodes** |
| downbeat, level (kick, hat, bass, lead, pad) | 10.4 / 9.9 ms, 32 nodes | 4.7 / 4.7 ms, 16 nodes |
| step 4, level (no pad, control) | 3.0 / 2.7 ms, 8 nodes | 2.4 / 2.5 ms, 8 nodes |

**In game at 4×, music on** (`EV/audio-ab1/af-*`, r4's `audioframes.mjs`: L1 for 25 s with the lane bot, then the boss). Values are `audio.update` ms in the frame, runs 1 / 2.

| Moment | Before | After |
|---|---|---|
| first gate pass | 8.6 / 9.4 | **3.2 / 4.2** |
| worst gate-pass frame | 13.7 / 9.4 | gate passes no longer among the top 12 audio frames (all ≤ 7.6, shots and pickups) |
| boss intro | 2.4 / 2.7 | 0.9 / 0.6 |
| music scheduler, worst ticks in level mode (a task outside rAF) | 10.9 / 15.0 | 6.9 / 7.9 |
| music scheduler, boss mode (drone + drums; no pad) | — | 5.6 / 10.1 |

### Same sound (`EV/after/preverify-final.json`, `EV/tools/preverify.mjs`)

**Method.** In the game page, each instance is rendered twice through the game's own AudioSystem into an OfflineAudioContext: the live layer chains (pre-render plan disabled), then the pre-rendered path.

| Instance | Nodes live → pre | RMS live / pre (dB) | Result |
|---|---|---|---|
| `fanfare` | 31 → 2 | −24.49 / −24.49 | correlation 1.0, difference 152 dB down |
| pad downbeat | 18 → 2 | −18.19 / −18.19 | correlation 1.0, difference 144 dB down |
| `pass_up` | 13 → 2 | −15.55 / −15.55 | peak −0.25 both; correlation 0.999 after an 8-frame shift |
| `hup` n = 1 | 4 → 2 | −32.52 / −32.49 | peak −4.59 both; correlation 0.999 after a 48-frame shift |
| `hup` n = 4 | 17 → 2 | −29.98 / −28.62 | peak −3.7 / +0.9 dBFS |
| `hup` n = 8 | 33 → 2 | −27.04 / −27.66 | peak −0.1 / −1.7 dBFS |
| roar, pitch 0.6 | 12 → 2 | −17.40 / −17.38 | peak +1.56 both (before bossVolume 0.4) |
| roar, pitch 1, positional | 13 → 3 | −23.44 / −23.41 | |

- **The shift on `pass_up` and `hup` n = 1** is an oscillator start-phase offset. Chrome's oscillator phase depends on the start time (0 in the render against 0.015 s / 0.255 s live), and every live play has its own start phase anyway. Onsets are identical to within 2 frames.
- **Chorus and roar instances** differ by their random onsets, detune and noise offsets, like any two live plays. Every value here is pre-bus at gain 1.
- **Hot variants.** Some variants peak higher than others, for example `hup` n = 4 at +0.9 dBFS pre-bus. In the master captures that never reached the soft-clip knee:
  - default mix at C 300: master peak −3.3 dBFS, no knee sample (`kneewhere.cjs`);
  - r4's C 300 run peaked at −1.8 dBFS with 4 knee samples.

## 3. Mix: music 70 and the reward lift

### Change

- **Default music fader.** It is 70 (lead decision). The save default is in `js/save.js:64`, owned by ui, and was already changed by its owner this round. audio.js's fallbacks (`:567`, `:630`) now say 70 as well.
- **Why the default alone does not reach 6 dB.** At sound 50 the bed is almost all music. Music 80 → 70 lowered the 1 s bed by only 0.8 dB (`EV/before/passan.txt`: −20.9 → −21.7 dBFS), so 50 / 70 reached 4.5 dB median and 3.7 dB minimum.
- **The two data-only options both failed:**
  - a lower music bus needs about 4 dB to fix the minimum, which changes the default mix a lot;
  - a louder reward bus pushes the default-mix reward peaks (−4.3 dBFS) toward the −1.9 dBFS knee.
- **`rewardFaderGain`** (`js/audio.js:232`), with data key `MUSIC.rewardLift.maxDb = 6` (`js/data.js:1541`, read guarded at `:140`). It is used for the reward bus at `:887` and `:1964`.
  - The reward bus (pass, flip, stings) follows the sound fader, but while the music fader is higher it is lifted toward the music fader, by at most 6 dB.
  - Sound 0 stays silent: the lift multiplies the sound fader.
  - Sound ≥ music, which includes the defaults 100 / 70 and 100 / 80, is bit-identical to before.
  - `?nomusic` gets no lift.
  - At 50 / 80 the reward sits where sound 80 would put it, so its peaks are never above the default mix's.

### Numbers

`EV/before/passan.txt`, `EV/after/passan.txt`, `EV/after/s100-m70-c300/passan.json`. Tools: r4's `rec4.mjs --phase pass` on the A/B mirrors (C 25, L2–L3, 60 s) and `passan.cjs`, the AUD-10 metric (loudest 50 ms of the reward minus the master RMS of the 1 s before).

| Sound / music | Rise min / median, before | Rise min / median, after | Master peak, after | Clipped samples |
|---|---|---|---|---|
| 50 / 80 | 3.0 / 3.9 | **6.7 / 7.3** | −5.0 dBFS | 0 |
| 50 / 70 | 3.7 / 4.5 | **6.3 / 7.1** | −6.3 dBFS | 0 |
| 50 / 80, C 300 | — | **6.6 / 7.2** | −4.4 dBFS | 0 |
| 100 / 70 (new default) | 8.5 / 9.4 | 8.5 / 9.0 | −3.5 dBFS | 0 |
| 100 / 70, C 300 | — | 8.1 / 8.6 | −3.3 dBFS, 0 knee samples | 0 |
| 100 / 80 | (r4: 7.7 / 8.2) | 7.7 / 8.5 | −3.2 dBFS | 0 |

- **0 passes under 6 dB** in every after run.
- **Through a phone speaker** (400 Hz high-pass) the rise is now at least 11.0 dB at sound 50, against 7.0 before.

## 4. Coding rules (ARCH §14)

- **No per-frame allocation.**
  - The pre-rendered play path creates only the WebAudio nodes the cue needs.
  - The rehearsal uses module-level spec and scratch.
  - Render jobs and their completion closures are created once, in the boot / first-gesture warm-up.
- **Every browser API is guarded:**
  - the `OfflineAudioContext` constructor (with webkit and legacy `oncomplete` fallbacks);
  - `startRendering`;
  - node creation, in try/catch, falling back to the live path.
- **No `console.log`, no `Math.random`.**
- **New data keys are read guarded:** `MUSIC.prerender` and `MUSIC.rewardLift` fall back to the shipped behaviour against an older data.js.

## 5. Files changed

| File:line | Change |
|---|---|
| `js/boss.js:14` | header note |
| `js/boss.js:107`–`115` | rehearsal spec, scratch, `WARM_AFTER_RESET_STEPS` |
| `js/boss.js:219`, `:256` | rehearsal state, key list |
| `js/boss.js:271`–`332` | `initSteps` / `initStep` and `_warmArchetype` |
| `js/boss.js:359` | `reset()` re-queues the rehearsals |
| `js/boss.js:599` | `spawn` keeps the sinks detached while rehearsing |
| `js/boss.js:1097` | the per-step re-warm |
| `js/audio.js:3`, `:28` | header |
| `js/audio.js:136`–`140` | `PRE_PITCH_TOL`, `PRE_TAIL_S`, `REWARD_LIFT_MAX` |
| `js/audio.js:232` | `rewardFaderGain` |
| `js/audio.js:345`, `:357` | `offlineContextCtor`, `makePrePlan` |
| `js/audio.js:567`, `:630` | music fallback 70 |
| `js/audio.js:637` | the render jobs |
| `js/audio.js:887`, `:1964` | reward bus gain |
| `js/audio.js:1041`, `:1064`, `:1123` | warm dispatch, `_renderJob`, `_forgetVoice` |
| `js/audio.js:1539`, `:1553`, `:1614` | `_startCue` split into `_startPre` / `_startLayers` |
| `js/audio.js:1810` | `_newShaper` |
| `js/audio.js:2201`, `:2305` | pad chord |
| `js/data.js:1537`–`1541` | `MUSIC.rewardLift` |
| `js/data.js:1573`–`1576` | `MUSIC.prerender` |
| `js/data.js:1624`–`1627` | `MUSIC.instruments.pad.prerender` |
| `js/data.js:1715` | the `prerender` vocabulary |
| `js/data.js:1763`, `:1793`, `:1806`, `:1858` | `roar`, `pass_up`, `hup`, `fanfare` `prerender` |
| `docs/GDD.md` §13 | music 70, reward lift, pre-rendered instances, measured numbers |
| `docs/ARCHITECTURE.md` §6.8 | boss `initSteps` rehearsals |
| `docs/ARCHITECTURE.md` §6.13 | pre-render path, reward lift, music fallback |
| `docs/ARCHITECTURE.md` §8.8 | MUSIC line |
| `docs/ARCHITECTURE.md` §11 | settings |
| `docs/ARCHITECTURE.md` save schema | `music: 70` |

- **No rebuild needed:** `artifact.html` loads the js by URL.
- md5s are in `EV/md5-final.txt`. Line numbers are as of this hand-off.

## needsOtherGroup

1. **level (boss arrival).**
   - `_fireBoss`'s own code is still cold at the first boss: 2.6 ms of the arrival frame at 4× (archetypePhases, unionMinionUnits, solveWaveHp, levelgen `unitStats`, `_bossHpScale`).
   - Requested: resolve the boss spec once at level start (everything but the count-dependent `hpScale`), or dry-run those helpers then. Level already has a levelgen JIT warm-up slice to extend.
2. **fx / ui (boss arrival).** Their first `boss:intro` / `boss:spawn` handling is cold:
   - fx `_onBossIntro`: 0.6–0.8 ms;
   - ui `_onBossIntro` / `_onBossSpawn`: 0.2–0.5 ms;
   - `ui.update` in the frame: 1.6–1.8 ms (letterbox, name card, boss bar).
   - Requested: warm them through the same paths silently at boot, as boss and audio now do.
3. **render / lead (the ≤ 33 ms target).**
   - After this pass the arrival frame is 26 ms of JS (median) and 34.6–34.7 ms frame interval on this loaded 144 Hz host.
   - `render.draw` is 10–13 ms of it, its normal cost for that scene.
   - Items 1–2 would take about 4–5 ms more off, which should bring the interval to the 27.8 ms step. I could not get there from boss.js / audio.js alone without changing the event contract.
   - Re-measure on a quiet host with `EV/tools/batch-split.sh` and `EV/tools/batch-arrival.sh`.
4. **ui / save: nothing to do.** `js/save.js:64` already defaults music to 70, and audio's fallbacks and ARCH's save schema now match. Please keep the slider label / tests in line if they assume 80.
5. **lead (decision record).** I met the 6 dB rule with the reward lift: an audio-side rule, sound fader ≥ music unchanged, documented in GDD §13. The data-only alternative was about 4 dB less music bus, which changes the default mix a lot. Revert = `MUSIC.rewardLift.maxDb: 0`.
6. **QA / verify.** On a quiet host, re-run:
   - `EV/tools/batch-audio.sh`, `batch-mix-after.sh`, `batch-split.sh` and `batch-arrival.sh`;
   - `EV/tools/preverify.mjs` (the same-sound proof);
   - the throttled boot.

## Remaining issues (honest)

1. **The arrival frame is not yet ≤ 33 ms at 4×.** It is at 34.7 ms in 2 of 3 runs on this host. The remainder is level / fx / ui / render (needsOtherGroup 1–3).
2. **Host noise in smoke.** Each `--scenario all` run had a 0.1–0.2 s cluster of long frames at a random mid-level time: 47.5 s with 90–201 ms frames, and 36.6 s with 55–111 ms. No boss, audio warm item or render job falls there:
   - the boss rehearsal runs 0.75 s after the level starts;
   - the audio warm items and render jobs finish at the title.
   This matches the loaded host. A quiet-host matrix should confirm it.
3. **Memory.** The pre-rendered buffers cost about 3 MB of audio memory, the pad chords 1.9 MB of it.
4. **The warm-up takes longer.** At the title it is still running for a few seconds after boot (`warmLeft` 9 at title in one run). It runs in idle callbacks; the title's worst frame went from 28–35 ms to 42–49 ms at 4×, and none is over 50 ms.
5. **Not reached by the boss rehearsal.** Attack starts, globs and the car use `ctx.rng` and fx decals, so their first use is still at the first attack, about 2.4 s after the arrival.
