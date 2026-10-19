# QA round 2: "audio" fixer report (AUD-4 … AUD-13)

Files edited: `js/audio.js` (whole module is ours), `js/data.js` (only `MUSIC` and `AUDIO_CUES`), `docs/GDD.md` (only §13).
Static checks: `node --check js/audio.js js/data.js` OK, `node tools/check-imports.js` reports 0 errors and 0 warnings. `js/audio.js` contains no `console.*` and no `Math.random` (it only mentions them in comments). The new paths allocate nothing per frame: only the WebAudio nodes of a starting cue, as before.
Smoke: `node tools/smoke.js --scenario all --out docs/build/qa2/fix-audio/all` is **CLEAN**. It had 0 page errors, 0 console errors or warnings and 0 failed requests, and L1 was won with 3 stars. I checked the screenshots (title, shop, levels, settings, play, result).

> **Disk warning (affects every group):** drive C: is at 100 % (40–200 MB free while I worked). One of my recordings failed with ENOSPC. I moved my raw recordings (≈ 0.5 GB of `master-*.f32` and `master.wav`) to the session scratchpad on E:
> `E:/Temp/claude/…/afb261e2-…/scratchpad/fix-audio/runs/{final-l1,final-boss,final-cues,stack,…}`.
> Only small JSON and text summaries are in `docs/build/qa2/fix-audio/summaries/`. If another fixer sees truncated writes or puppeteer timeouts, the full disk is the likely cause.

## Verification tools (docs/build/qa2/fix-audio/)
- `exp.mjs`: a copy of audio/exp.mjs. It also samples each source's **live** `detune` / `playbackRate` value just after the source starts. A re-timed lookahead note therefore counts as fixed even though it was *built* at the old rate. It also adds a delayed-cue test and the runup and boss mode switches. Output: `exp.json` (= `exp-mode.json`). Summarise it with `node docs/build/qa2/fix-audio/expsum.cjs`.
- `tune.mjs`: an offline renderer. It runs a recipe through the game's own `AudioSystem` interpreter and master chain in an `OfflineAudioContext` and reports peak, active RMS and phone-weighted loss. I used it to tune recipes; `summaries/tune-final.txt` has every cue.
- `chaincheck.mjs`: the whole master chain (compressor → limiter → clip) driven with inputs up to +18 dBFS. Output: `chaincheck.json`.
- `events.cjs`: per-event metrics on a `rec.mjs` run:
  - pass rise: peak 50 ms window in [t, t+0.4] vs the [t−0.3, t) RMS;
  - boss-death music dip;
  - roar spikes vs the 2 s median;
  - compressor reduction after boss events.
- `cuetable.cjs`: per-cue peak, RMS and phone loss with safe windows. Under load, `analyze.mjs`'s `[t, next.t)` window catches the *next* cue's onset, because the main thread's `currentTime` lags by 10–20 ms. Short cues also start before the recorded `t`. `align.cjs` confirmed that the raw capture itself is aligned.
- `t11-first-gesture.mjs` (+ `lib.mjs` with a `noAutoplayFlag` option) and `t11b-blocked-autoplay.mjs`: AUD-8 checks.

Baselines for comparison: `events.cjs` on round-2 `docs/build/qa2/audio/l1` reproduces the issue figures:
- passes +5.1 / 3.3 / 2.0 / 5.3 dB;
- boss-intro roar +20.5 dB;
- boss-death roar +13.9 dB;
- boss-death music dip −0.7 dB;
- master peak +1.9 dBFS.

---

## AUD-4: boss fanfare 617 cents flat (slow-mo detune on future starts): **FIXED**
Changes:
- **Re-time live and future sources.** `js/audio.js:1433` `setTimeScale`:
  - Each source now records its start time: `srcStart`, written in `_startLayer`, `_musicNote` and `_startDrone`.
  - Sources that are already sounding: `glideParam` (`cancelAndHoldAtTime`, or cancel + `setValueAtTime(current)`), then `setTargetAtTime(new, now, MUSIC.paramSmoothS)`.
  - Sources whose start is still in the future (cue `delayMs`, layer delays, the music lookahead): `cancelScheduledValues(start)` + `setValueAtTime(newValue, start)`.
- **Reward stings ignore the time scale.** New `AUDIO_CUES.*.noTimeScale` (vocabulary documented in the AUDIO_CUES header). `fanfare`, `chime3`, `ui_tap`, `ui_buy` and `ui_star` are built at rate 1 (`_startCue` `fixed`, `_startLayer(..., fixed)`). Their voices carry `fixedRate`, and `setTimeScale` skips them.
- **Fanfare delay.** `FANFARE_AFTER_ROAR_MS` → `AUDIO_CUES.fanfare.afterRoarMs: 900`. I kept 900 ms because step 3 makes the overlap clean, and AUD-13's dip is sized to it.

Verification:
- **exp.json:**
  - All 12 fanfare layers are *built* while the rate is −617 cents. Their sampled actual pitch is **0 cents** (`notAtRate1: 0`), including the 6 that start after the scale returns at 1 200 ms.
  - Lookahead entering slow-mo: 11 notes built at rate 1 sound at −617 cents (stale 0).
  - Delayed cue: layers that start after the return to 1 sound at 0 cents. **`staleTotal` is 0** and the delayed cue has 0 stale layers.
  - Step interval: 125 → 178.6 → 125 ms.
- **`pitch.mjs` at boss:dead + 0.9, 55 ms windows:**
  - final L1 run: **523 / 659 / 784 / 1046 / 1318 / 1567 Hz** (each within −1 cent; `summaries/final-l1-fanfare-pitch.txt`);
  - boss run: the same six peaks (`summaries/final-boss-fanfare-pitch.txt`). The 587 Hz D5 there is the ducked boss-loop lead.

## AUD-5: master bus clips (knee 30, no limiter): **FIXED**
Changes:
- **Knee.** `MUSIC.compressor.knee: 6` (data.js `MUSIC.compressor`), set in `_buildGraph` (`js/audio.js:677`).
- **Bus trim.** `MUSIC.buses` sfx −12, gun −16, music −14 (−6 dB from round 1, to offset the ≈ +7 dB makeup gain).
- **Safety limiter.** `MUSIC.limiter` (new): `{ threshold −1, knee 0, ratio 20, attack 0.001, release 0.05, clip: { linear 0.8, ceiling 0.985 } }`.
  - Graph: comp → limiter `DynamicsCompressor` → `WaveShaper` soft clip (`makeClipCurve`, `js/audio.js:321`; exact identity up to |x| 0.8, odd length, oversample 'none') → master → destination.
  - `_limiter` and `_clip` are new fields; `_master` is still the post-chain mute gain, so `rec.mjs` taps the final output.
- **Docs.** GDD §13 graph sentence amended.

Verification:
- **Compressor curve.** `compcurve.mjs 6` → `compcurve-knee6.json`, max 0.00 dB difference from the round-2 knee-6 reference.
- **Limiter chain.** `chaincheck.json`: inputs up to +18 dBFS (sines, 2–60 ms square bursts, noise) give a max output of **−0.47 dBFS** and 0 samples ≥ 0.999.
- **Final L1 run (85 s, boss killed):** 0 clipped samples, master peak −3.9 dBFS.
  - Compressor reduction reaches **−7.3 / −6.6 dB** on boss:phase.
  - Gameplay-bed median RMS **−21.6 dBFS** (round 2 −22.3, within ±2 dB).
- **Final boss run:** 0 clipped samples, peak −4.0 dBFS; reduction −6.1 / −6.5 dB on the phases.
- **Partial on one point:** the reduction on boss:intro and boss:dead is only −1 to −2 dB. These are deliberately quiet now (AUD-7), and the 'reaches −6 to −10 dB on boss events' check holds on the boss:phase crash.

## AUD-6: same-frame duplicates sum coherently: **FIXED**
Changes:
- **Merge duplicates.** `ugh`, `thud`, `roar`, `pop`, `screech` and `hup` get `coalesceMs: 40, stackDb: { per: 2, cap: 6 }` (data). Duplicates merge into the first queued instance through the existing `_stack` path.
- **Other cues.** `MUSIC.queue.maxPerFrame` 4 → 2, now read through `SAME_FRAME_MAX`. All the old DATA-MISSING literals now read their existing `MUSIC.*` keys: queue, scheduler, startDelayS, paramSmoothS, duck attack / release, pan atten, visibilityResumeMs.
- **Decorrelation.** The second copy is offset by `MUSIC.queue.dupOffsetMs [5, 15]` and its pitch jittered ±`dupJitter 0.05` from `ctx.rngFx` (`js/audio.js:880`).

Verification:
- **Stack run** (`summaries/stack-cuetable.json`): peak ×4 vs ×1, all with 0 clipped samples:

  | Cue | ×4 over ×1 (peak) |
  |---|---|
  | ugh | +4.1 dB |
  | thud | +2.0 dB |
  | pop | +2.9 dB |
  | hup | +2.0 dB |
  | screech | +6.0 dB |
  | splat | −0.2 dB |

  Round 2 had ugh +10.9 dB, thud +8.3 dB with 298 clipped samples, and pop 18 clipped samples.
- **Boss run:** squad:loss groups of up to 11 in one frame produce no clipping (peak −4.0 dBFS).

## AUD-7: roar 14–20 dB over the mix: **FIXED**
Changes (data):
- **Gains.** `roar` layer gains 0.9 / 0.4 → 0.4 / 0.2.
- **Boss constants moved to data.** `bossIntroPitch` 0.6, `bossDeathPitch` 0.4, `bossDeathStretch` 2.5 and `bossVolume` **0.4** are all new keys under `AUDIO_CUES.roar`. I tuned `bossVolume` 0.6 → 0.45 → 0.4 after re-checking against the AUD-5 compressor.
- **Also moved:** `thud.bossStompPitch` and `thip.bossPitch`.

In `js/audio.js`: boss:intro and boss:dead pass `o.volume = BOSS_ROAR_VOLUME`, and the constants block now reads the data keys.

Verification (`events.cjs`, roar plays vs the 2 s median):

| Roar | Final L1 | Final boss run | Round 2 |
|---|---|---|---|
| Boss intro | **+6.4 dB** | +7.0 dB | +20.5 dB |
| Brute | +5.0 dB | +5.5 dB | +14.4 dB |
| Boss death | +2.3 dB | +4.3 dB | +13.9 dB |

- The intro roar is still the loudest block of the intro: −17.0 dBFS at +0.07 s vs ≤ −20.2 for everything else between boss:intro and boss:fight.
- The final L1 run has one 'spike' ≥ 8 dB: level start at +8.1 dB, with no cue (the music restart). The final boss run has none.

## AUD-8: first tap freezes 0.8–1.7 s (AudioContext built in the gesture): **FIXED** (audio's share)
Changes (`js/audio.js`):
- **Build at boot.** `init()` calls `_createContext(false)` (`:506`). The context and the whole graph are built at boot step 7, behind the boot bar.
- **Lazy fallback.** If construction or graph building fails at boot, nothing is flagged; `unlock()` retries once inside a gesture (`_createContext(true)`, `:584` / `:603`).
- **unlock() only resumes.** It now only primes old iOS and calls `resume()`; the needsGesture and iOS re-arm logic is unchanged.
- **Scheduler.** The interval no longer starts at creation. `_checkRunning` (`:748`) starts it at the first 'running'.
- **Context already running at boot.** If the autoplay policy lets the context run at construction, the statechange (or a cheap poll in `update()`, `:1005`) emits `audio:unlocked`, and engine removes its listeners as before.

Verification:
- **`t11b-blocked-autoplay.mjs`** simulates the real mobile policy by suspending the context at construction. Headless Chrome lets contexts run even with `--autoplay-policy=user-gesture-required`.
  - After boot: state 'suspended', no music, scheduler interval stopped.
  - **`audio.unlock()` costs 0.4 ms synchronously** (round 2: 765–873 ms).
  - After the first PLAY tap: 'running', `audio:unlocked` emitted once, `wantMode` / `activeMode` 'level', music on.
- **`t11-first-gesture.mjs`** with the harness flag and with `user-gesture-required`:
  - the context is running from boot and `unlock()` on it costs 0.0–0.1 ms;
  - the music is on after the first tap.
- **First-tap frames vs the < 50 ms target:**
  - Earlier quiet-machine run: [124.9, 27.9, 27.8] ms with the flag, and [7.2, 7.1, 7.1] ms without it; second PLAY 7.1 ms.
  - Final runs on a heavily loaded machine: first PLAY [62–201] ms, second PLAY [35–55] ms. In those runs the AudioContext constructor itself took 0.35–3.6 s at boot, which shows how loaded the machine was.
  - In these runs no audio work happens in the tap: the context is already running (or resumes in 0.4 ms). So the remaining first-PLAY hitch is level-start work plus machine load, not audio. See needsOtherGroup.
- **Boot cost.** Boot grows by exactly the constructor (128–426 ms on a quiet machine; 2–3.6 s measured under load) plus the graph, which was already being built in the gesture before.
- **Console warning.** On real browsers with a blocked autoplay policy, Chrome logs its standard "AudioContext was not allowed to start" warning at boot. It is a browser message, not ours, and does not appear under the harness flag (smoke CLEAN).

## AUD-9: shotgun sting and flip nearly silent: **FIXED**
Changes (data and GDD §13):
- **sting_shotgun:** 1.2 kHz 'band' noise → low-pass 2.5 kHz, attack 2, held to 30 ms, gain 1.0, plus a sine 140 → 60 Hz layer at 0.45. 'brown' as suggested measured −9 dB on a phone speaker, so I used 'band'.
- **flip:** attack 10, decay 110, q 0.8, gain 1.0.

Verification (final cues run, `summaries/final-cues-cuetable.json`):

| Cue | Peak | Active RMS | Phone loss | Round 2 |
|---|---|---|---|---|
| flip | −9.0 dBFS | **−22.0 dBFS** | −0.5 dB | RMS −37.9 dBFS |
| sting_shotgun | **−7.0 dBFS** | −18.3 dBFS | −1.7 dB | peak −21.3 dBFS |
| sting_minigun (reference) | −7.2 dBFS | | | |

- flip's active RMS ≥ −22 dBFS is met exactly.
- sting_shotgun's peak is within 0.2 dB of sting_minigun's.

## AUD-10: gate pass barely over gunfire; 8-voice hup quieter than one: **PARTIAL**
Changes:
- **Gun-bus duck.** A new `_gunDuck` gain sits between the gun bus and the compressor. `_duckGun()` reuses the timed-dip helper `_dipGain` (also used by `duck()`) with new `MUSIC.duck.gunOnReward` **[−9 dB, 0.45 s]**. It fires on gate:pass, weapon:start (stings) and gate:flip (`js/audio.js:1917`, `:1946`, `:1963`).
- **pass_up** layer gains 0.45 → **0.8**.
- **hup:** gain 0.9, attack 5, decay 40. Its per-voice gain is new vocabulary `voices.gainExp` = **0.1**; 0.2 measured only +2.8 dB after the compressor.

Verification:
- **Passes, final L1 run:** **+5.9 / +5.3 / +5.8 / +10.7 dB** (round 2, same metric: +5.1 / 3.3 / 2.0 / 5.3).
- **Across six L1 recordings** the minimum rise was 4.4–5.5 dB and the median ≈ 6.5 dB. Typically 2–3 of 4 passes are ≥ 6 dB, so "every pass ≥ 6 dB" is not met.
- **What limits it:** the AUD-5 6:1 compressor pins the pass at ≈ −14.5 dBFS (50 ms RMS) whatever its gain (pass_up 0.65 / 0.8 / 1.0 all measured −14.1 to −14.8). The 300 ms before a pass sits at −19.6 to −21 dBFS: gate-hit ticks plus shots. Lowering the gun bus by another 2 dB, or the tick gain 0.5 → 0.35, did not move the minimum, so I reverted both.
- **What would close it** is a design call for the lead:
  - a post-compressor "reward" bus for pass_up / hup / stings; or
  - a pre-duck of the gun and sfx buses ~150 ms *before* the squad reaches the gate, which gates.js knows; or
  - a lower bed than the −22 dBFS that AUD-5 asks to keep.
- **hup:** ×8 (count 32) vs ×1 is **+3.5 dB** RMS in the recording (+4.4 dB offline) and +1.4 dB peak. Round 2 had ×8 quieter than ×1 (−0.3 dB). The target is ≥ +4 dB, so this is marginal.

## AUD-11: sub-bass cues inaudible on phone speakers: **FIXED**
Changes (data and GDD §13):
- **whomp:** sines 0.35 / 0.25 + sawtooth 180 → 153 Hz band-passed 600 Hz (0.8) + 60 ms 'band' thump (0.5).
- **thud:** 60 Hz sine with shaper 0.3 at 0.5 + 90 ms 'band' knock low-passed 1.8 kHz (1.0).
- **drone_down:** low-pass 1 200 Hz, 0.45, plus a square 220 → 110 Hz band-passed 800 Hz (0.5).
- **explosion:** brown 0.6, sine 0.4, + 'band' noise low-passed 1.8 kHz → 400 Hz (1.0).
- **rail:** sine 0.45 + sawtooth 480 → 200 Hz low-passed 1.5 kHz (0.4).
- **sting_rocket:** sine 0.45, 'band' noise, + sawtooth 600 → 240 Hz (0.35).
- **Kick:** `MUSIC.instruments.kick.click` (2 ms high-passed noise at 0.2), played with every kick (`_scheduleStep`).

Verification (final cues run, 400 Hz 4th-order high-pass loss):

| Cue | Phone loss | Round 2 | Full-band peak (dBFS) | Round 2 peak (dBFS) |
|---|---|---|---|---|
| whomp | **−6.9 dB** | −32.7 dB | −5.6 | −1.4 |
| thud | **−4.7 dB** | −29.7 dB | −6.3 | −5.3 |
| boss stomp | **−4.7 dB** | −30.3 dB | −6.2 | −5.5 |
| explosion | **−4.6 dB** | −16.2 dB | −6.0 | −1.9 |
| rail | **−7.4 dB** | −16.3 dB | −6.2 | −4.5 |
| drone_down | **−4.7 dB** | −15.3 dB | −7.5 | −7.5 |
| sting_rocket | **−6.5 dB** | −13.1 dB | −6.5 | −6.2 |

- Each listed cue loses ≤ 8 dB.
- No full-band peak is higher than in round 2 except sting_rocket, by 0.3 dB (within run-to-run noise).
- Not in scope and unchanged: `rocket` (−10.6 dB), `roar` (−13.5 dB) and `shot` (−8.7 dB) still lose more than 8 dB.

## AUD-12: music mode switches wait up to 2 s: **FIXED**
Changes (`js/audio.js`):
- **Beat switch.** Switches between playing modes land on the next beat (`step % MUSIC.modeSwitch.beatSteps`, new key, = 4).
- **Restart.** level:start, boss:fight and entering a menu state from another mode use `_requestMusic(mode, true)` (`:1319`). `setMusic(mode)` is unchanged as a public API and delegates to it. The next scheduler pass runs `_restartLoop` (`:1557`):
  - music notes that have not started yet are released;
  - sounding notes fade out over `MUSIC.modeSwitch.crossfadeMs` 120 ms (per-voice envelope ramp; the music voice now keeps its `env`);
  - `_step = 0`, `_nextT = now + MUSIC.startDelayS`, `_applyDrone(_nextT)`.

Verification (exp.json `modeLatency`):

| Switch | Mode reached | First new-mode step audible | Round 2 |
|---|---|---|---|
| level:start | 0 ms | 49 ms (bar 0) | 1.56–1.99 s |
| runup (beat) | 269 ms | 341 ms | 1.18 s |
| boss:fight | 11 ms | 60 ms (bar 0) | 1.89 s |
| quit → menu | 0 ms | 60 ms (bar 0) | 1.54 s |

- The worst beat switch I measured was 499 ms.
- Recordings show 'level' at level start and 'boss' at boss:fight.

## AUD-13: boss-death dip ends before the fanfare: **FIXED**
Changes:
- **Duck.** `MUSIC.duck.bossDead` → **[−10 dB, 2.0 s]**.
- **Held dip, then fade-out.** boss:dead calls `_duckBossDeath()` (`:1361`). It dips the duck-transient gain without a scheduled release and sets `_pendingStopT = now + 2.0`. The scheduler then sets `wantMode 'none'`, so the loop fades out (`fadeMs`) instead of returning at full level ("'none' after the fanfare").
- **Releasing the dip.** Any explicit `setMusic` / `_requestMusic` (≠ 'none') and `duck(0, 0)` release the held duck and cancel the pending stop; so does a fresh loop start. Restart and quit during the window are therefore safe.

Verification (music-tap RMS in [boss:dead + 0.9, + 1.7] s vs the 2 s before):

| Run | Dip | Music at +2.6–3.2 s | Round 2 |
|---|---|---|---|
| Final L1 | **−11.0 dB** | silent | −0.7 dB, loop back at full level |
| Final boss | −9.6 dB | silent | |

The target was a dip ≥ 8 dB.

---

## Data and doc keys added or changed (for the integrator)
**MUSIC**
- `buses` {sfx −12, gun −16, music −14};
- `compressor.knee` 6;
- `limiter` {…, clip {linear, ceiling}} (new);
- `duck.bossDead` [−10, 2.0];
- `duck.gunOnReward` [−9, 0.45] (new);
- `queue.maxPerFrame` 2, `queue.dupOffsetMs`, `queue.dupJitter` (new);
- `modeSwitch` {beatSteps 4, crossfadeMs 120} (new);
- `instruments.kick.click` (new).

**AUDIO_CUES**
- vocabulary `noTimeScale`, `voices.gainExp`;
- roar {coalesce / stack, `bossIntroPitch`, `bossDeathPitch`, `bossDeathStretch`, `bossVolume`, gains};
- fanfare {`noTimeScale`, `afterRoarMs`};
- chime3 / ui_* `noTimeScale`;
- thud {coalesce / stack, `bossStompPitch`, recipe};
- thip `bossPitch`;
- ugh / screech / pop coalesce / stack;
- hup {coalesce / stack, `gainExp` 0.1, gain / env};
- recipes changed: flip, whomp, pass_up, sting_shotgun, sting_rocket, rail, explosion, drone_down.

**GDD §13:** graph, bus levels, boot-time context, boss-death dip, gun duck, duplicate merging, mode switches, the time-scale rule, the phone-band rule and the affected recipe rows.

**Public API:** unchanged. `setMusic(mode)`, `duck`, `setTimeScale`, `unlock` and `init` keep their signatures. Behaviour changes that ARCH §6.13 still describes the old way:
- the context is created in `init()`, and `unlock()` only resumes;
- the scheduler interval starts at the first 'running', not at unlock;
- mode switches land on the beat, with a restart on level:start / boss:fight / menu.

## needsOtherGroup
1. **docs/ARCHITECTURE.md §6.13 (architecture or docs owner).** Update the `unlock()` contract line to say:
   - "the context and graph are created in `init()` (boot step 7, 'suspended' until a gesture; construction failure is retried once in `unlock()`)";
   - "`unlock()` calls `resume()` (and primes old iOS) on every invocation";
   - "the music scheduler `setInterval` starts at the first 'running'".

   Update the `setTimeScale` line to add: "sounding sources: cancel + hold + setTargetAtTime; sources scheduled to start later get their start value rewritten; `noTimeScale` cues are skipped". The §6.13 graph note should match GDD §13 (compressor knee 6 → limiter → soft clip). Also note under §11 that level:start, boss:fight and menu entry restart the loop at bar 0, and other switches land on the next beat.
2. **js/main.js (boot owner).** Nothing is required: `ctx.audio.init()` at step 7 already does the work. Optionally, mention in the boot-step comment that step 7 now builds the AudioContext (up to ~1 s on some Windows Chrome builds), so the boot-bar weight `PROGRESS.audio` could be raised.
3. **Level start (level.js / render warm-up owner).** The first PLAY tap still shows 62–201 ms frames on this heavily loaded machine (second PLAY: 35–55 ms; on a quiet machine first PLAY was 125 ms with no audio work in the tap). Audio's synchronous share is now 0.4 ms, so the remainder is first-level-start work. That is outside audio, and worth a profile on a quiet machine.
4. **Gate-pass reward ≥ 6 dB (AUD-10, design decision).** Optional: if the lead wants every pass ≥ 6 dB over the 300 ms before it, gates.js could emit an "approach" event ~150 ms before the squad crosses the gate line, and audio would pre-duck the gun and sfx buses on it. Alternatively, approve a post-compressor reward bus, which I can add in audio.js on request.
5. **Disk space (everyone).** C: is full (≈ 40 MB free at the end). Raw audio recordings and screenshots should go to E: (the scratchpad) until someone frees space.
