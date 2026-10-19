# Round 4 — audio: reward stings / flip (1a), fader law (2), first-use cost (3)

Owner files: `js/audio.js`; in `js/data.js` only `MUSIC.*` and `AUDIO_CUES.*`. Every data.js edit was an anchor-checked replacement, made on a fresh read just before writing. Other groups edited data.js (JUICE, HINTS, STRINGS) during this round; those edits are untouched. Docs: GDD §13, and ARCHITECTURE §6.13, §8.8 and §11.

Lead decision 1b (keep the shipped roar) needed no change.

**Evidence root:** `E:/Temp/claude/gate-rush-evidence/r4/audio/`, written `EV/` below.

| Path | Contents |
|---|---|
| `EV/src-before/` | `audio.js`, `data.js`, `GDD.md` and `ARCHITECTURE.md` as handed over |
| `EV/mirror-before/`, `EV/mirror-after/` | A/B mirrors, built by `tools/mkmirrors.cjs` from the live tree. They differ only in `audio.js` and in data.js's MUSIC and AUDIO_CUES sections (`mirrors-*.txt` holds the md5s) |
| `EV/before-overrides/` | The same old pair, for the tools that serve the live tree with overrides |
| `EV/tools/` | `rec4.mjs` (rec3 plus a `stings` phase), `stingrise.cjs`, `kneewhere.cjs`, `rewtune4.mjs` (offline: the game's own interpreter and chain), `cuecost.mjs`, `nodecost*.mjs`, `audioframes.mjs`, `throttle.mjs` (the verify copy), the `batch-*.sh` runners and the r3 analysers (`passan`, `cueqa`, `soakan`) |

All captures: music ON, phone viewport, post-limiter master tap, real-time headless Chrome on the real GPU. Throttled runs: 4× CPU, 390 × 844 at DPR 2.75, Medium. The host was shared with other agents throughout (≈ 70 Chrome processes), so every A/B below is interleaved (before, after, before, after…).

## Verdict

- **(1a) Met.** J13 stings and the J5 flip now read ≥ 6 dB over the 1 s gunfire bed.
  - Minimum 6.2 dB, medians 7.0–8.4 dB, at C = 25 and C = 300. Before: medians 2.9–5.6 dB, and 41 of 46 plays were under 6 dB (the laser already passed).
  - The limiter never acts in a sting window: 0 samples over the soft-clip knee and 0.0 dB of limiter reduction.
  - Two reward moments that overlap are now trimmed (−5 dB on the later one). A crate sting landing on a gate-pass chorus had summed to −0.8 dBFS.
- **(2) Met.** The fader law is now linear amplitude, so 50 = −6 dB on both faders.
  - At sound 50 / music 80 the gate-pass reward rises **+3.8 dB** (median; minimum +2.7) above the music bed. Before: +0.1 dB median, minimum −2.1.
  - The default mix (100 / 80) is unchanged: same bed, and the pass reward still reads 7.6–8.2 dB as in r3.
- **(3) Met.** At 4× CPU, a cue's first use now costs no more than its later uses.
  - `audio.update` (median of 3 interleaved runs per side):

    | Moment | Before | After |
    |---|---|---|
    | Boss-death frame | 14.4 ms | 4.1 ms |
    | First gate pass | 11.8 ms | 8.4 ms |
    | Worst gate-pass frame | 18.4 ms | 11.7 ms |
    | First shot | 4.5 ms | 2.0 ms |
    | Boss intro | 5.0 ms | 3.4 ms |

  - Per cue on a fresh page: the first shot drops from 10.1 to 3.5 ms, `whomp` from 10.3 to 2.5 ms and `pass_up` from 10.7 to 4.2 ms.
  - The boot shows no new gap: worst 222 ms against 201 ms before, well under 300 ms.
- **Static checks and smoke.**
  - `node --check` passes on both files, and `check-imports` reports 0 errors and 0 warnings.
  - `node tools/smoke.js --scenario all` is **CLEAN**, both mid-round and on the final code (`EV/smoke-all-final.json`): 0 page errors, 0 failed requests, L1 won, worst frame 27.9 ms.

## 1. (1a) Weapon stings and the gate flip read ≥ 6 dB over the gunfire

### Change

1. **Routing** (`js/data.js`):
   - `flip` (`:1403`) and all five `sting_*` (`:1437`, `:1443`, `:1450`, `:1456`, `:1460`) now have `bus: 'reward'`. They skip the 6:1 bus compressor, which had held them 3–4 dB over the bed whatever their gain.
   - New cue key `noAtten` (vocabulary at `:1332`; read at `js/audio.js:1302`). `flip` keeps its pan but drops the distance attenuation; a flip at z = −35 m was losing 5.3 dB to distance.
2. **Bed duck.** The listeners became methods, `_onGateFlip` (`js/audio.js:2145`) and `_onWeaponStart` (`:2154`). Like a positive pass, they dip `_bedDuck` (`MUSIC.duck.bedOnReward`) as well as the gun bus.
3. **Recipes retuned so the limiter is never needed** (data.js comments carry the reasoning):
   - The noise-led round-2 recipes had a 10–15 dB crest (peak over loudest 50 ms). At the needed loudness they would have peaked at −1 to +1 dBFS.
   - Each sting got longer holds and a tonal layer that carries the level:
     - shotgun: a square 320 → 140 Hz "chk", noise and body held 60 ms;
     - minigun: a square 220 → 660 Hz spin-up whine, shots held 25 ms;
     - rocket: holds of 100–150 ms;
     - rail: a triangle 1 760 → 220 Hz fall;
     - flip: a triangle 330 → 1 320 Hz under the noise sweep.
   - Offline results (`EV/tune/after-shipped2.txt`, `tools/rewtune4.mjs`, 6–12 seeds):
     - every sting: loudest 50 ms −12.4 to −14.0 dBFS, peaks ≤ −4.8 dBFS;
     - flip: −11.1 dBFS unpanned, which is about −13.5 behind its centred panner.
   - Tuning steps: `EV/tune/candA…D.txt` and `mini-*.txt`.
4. **Reward stack.**
   - **Problem:** the first C = 300 capture caught a laser sting landing on a gate pass's 8-voice `hup`, which put the master at **−0.83 dBFS** (24 samples over the knee; `kneewhere.cjs`).
   - **Fix:** `_rewardVolume()` (`js/audio.js:2166`; used at `:2146`, `:2157`, `:2272`). A reward moment (positive pass, flip or sting) that starts less than `MUSIC.duck.rewardStack[1]` (0.45 s) after another plays at `rewardStack[0]` (−5 dB). Key: `js/data.js:1193`.

### Numbers (gameplay)

Setup:

- Runs: `rec4.mjs --phase stings`, L2 → L3 at a held C. Every 3.3 s one reward is injected through audio's own handler; a pre-round-4 build has no handler, so the old listener body is mimicked.
- Analyser: `stingrise.cjs`, the r3 AUD-10 metric. rise = loudest 50 ms in the cue window minus the master RMS of the 1 s before. Plays with a gate pass or another reward in that span are skipped.

| Cue | before C25 min / median | before C300 | after C25 | after C300 | after C300 (final, with rewardStack) |
|---|---|---|---|---|---|
| flip | 1.9 / 4.4 | 2.2 / 3.4 | 7.5 / 7.9 | 6.5 / 7.3 | 6.2 / 7.2 |
| sting_shotgun | 2.8 / 4.0 | 1.8 / 2.9 | 6.9 / 7.1 | 6.4 / 7.0 | 6.2 / 7.3 |
| sting_minigun | 2.8 / 3.0 | 1.7 / 3.3 | 7.6 / 7.9 | 7.6 / 8.1 | 7.6 / 7.8 |
| sting_rocket | 5.0 / 5.6 | 3.6 / 4.0 | 7.1 / 8.1 | 7.3 / 7.5 | 6.8 / 8.4 |
| sting_rail | 3.4 / 4.1 | 3.4 / 3.8 | 8.0 / 8.2 | 7.5 / 8.1 | 7.6 / 7.9 |
| sting_laser | 7.8 / 9.1 | 7.3 / 7.3 | 7.8 / 7.9 | 7.1 / 7.8 | 7.0 / 7.0 |
| pass_up (reference) | 7.7 / 8.7 | 7.8 / 8.0 | 7.8 / 8.6 | 8.0 / 8.8 | 7.8 / 8.7 |

Evidence: `EV/{before,after}/stings-c{25,300}.rise.json` and `EV/after/stings-c300-final.rise.json`.

**Sting windows:** 0 samples over the 0.8 knee and 0.0 dB of limiter reduction in every run. Window peaks are −2.3 to −4.9 dBFS.

**Whole-run master:**

- **after C25:** −2.1 dBFS, 0 knee samples.
- **after C300 final:** −1.8 dBFS, 4 knee samples. The trimmed overlaps (6 rewards at −5 dB) had no knee excursion.
  - The only excursion is a plain gate pass with the 8-voice `hup`, which is pre-existing and within r3's offline tail.
  - The before C300 run had the same kind of excursion at −0.56 dBFS, with limiter reduction −0.4 dB.

**Isolated cues** (`EV/after/cues.cueqa.txt`, compared with r3 `after/cues.cueqa.txt`):

- Peaks are −5.2 to −9.1 dBFS; loudest 50 ms is −11.1 to −13.8 dBFS.
- 0 clipped samples; no onset or end clicks: every end level is ≤ −58 dB.
- Phone-band loss:

  | Cue | Before | After |
  |---|---|---|
  | shotgun | −1.7 | −7.8 |
  | minigun | −8.7 | −4.9 |
  | rocket | −6.6 | −8.0 |
  | rail | 0 | −0.1 |
  | flip | −0.5 | −2.1 |

  All are within GDD §13's 8 dB. Shotgun and rocket now sit at the edge.

## 2. (2) Fader law: linear amplitude, 50 = −6 dB on both faders

### Change

- **Fader law.** `faderGain(v) = v / 100`, clamped (`js/audio.js:201`). It applies to sound (sfx, gun and reward buses) and to music.

  | Fader | dB |
  |---|---|
  | 80 | −1.9 |
  | 50 | −6.0 |
  | 10 | −20 |
  | 1 | −40 |
  | 0 | silent |

  That is the "soft floor": no hard cut-off before 0.
- **Default mix kept.** `MUSIC.buses.music` −14 → **−15.94 dB** (`js/data.js:1179`), which is −14 + 20·log10(0.64 / 0.8). At the default music 80 the music bus sits exactly where the squared law had it. Sound defaults to 100, which is unchanged under either law.
- **No ui or save change needed.** The sliders still send 0–100 and the defaults are unchanged.

### Numbers

Pass runs at C = 25 (`rec4 --phase pass`, `passan.cjs`, `EV/passan-r4.txt`):

| Run | Passes | Rise min / median | Phone-band rise min | 1 s bed median | Reward 50 ms median |
|---|---|---|---|---|---|
| sound 50 / music 80, before (`EV/before/f50-c25`) | 9 | −2.1 / **+0.1** | 1.7 | −21.1 | −21.8 |
| sound 50 / music 80, after (`EV/after/f50-c25`) | 9 | +2.7 / **+3.8** | 7.1 | −20.7 | −17.3 |
| defaults, after, C = 25 (`EV/after/pass-c25`, L2–L4) | 15 | **7.7 / 8.2** (r3: 7.6 / 8.3) | 11.6 | −19.7 (r3 −19.9) | −11.5 |
| defaults, after, C = 300 (`EV/after/pass-c300`) | 15 | **7.6 / 8.0** (r3: 7.7 / 8.2) | 11.5 | −19.6 (r3 −19.6) | −11.5 |

- At sound 50 / music 80 the reward now rises above the music bed: +3.8 dB median, and +7.1 dB at minimum through a phone speaker.
- It does not reach 6 dB. The bed there is mostly music, which this setting leaves at −1.9 dB.
- At the defaults nothing moved: 0 passes under 6 dB, 0 clipped samples, master peak −2.9 / −2.4 dBFS.

## 3. (3) First-use cost: warm-up, WaveShaper pool, deferred delayed cues

### Root cause (measured)

Measured on a blank page at 4× (`EV/before/nodecost-4x.json`, `nodecost2-4x.json`; 5 + 4 fresh pages):

- **Oscillator types.** The first OscillatorNode of each type costs **4–24 ms**, against 0.1–0.4 ms for later nodes. The browser builds that type's band-limited wave tables once per context.
- **Other node kinds on first use:** BiquadFilter 1–4 ms, StereoPanner up to 5 ms, WaveShaper 2× 1–6 ms.
- **WaveShaper on every use.** Every new WaveShaper with `oversample = '2x'` costs 0.4–3 ms; the oversampler setup (`shaperOsOnly`) is the expensive part.
  - `roar` has 3 shaped layers and `thud` has 1.
  - The r3 soak created 24 WaveShapers in 3 minutes.
- **Delayed cues build in the triggering frame.** `boss:dead` built the roar and the 12-layer fanfare in the same frame, although the fanfare starts 0.9 s later.

### Change (`js/audio.js`; data keys `MUSIC.queue.*`, `MUSIC.warm`)

1. **Warm-up right after the graph is built.**
   - `_createContext` schedules it (`:731`), so it runs at boot behind the bar, or right after a lazy construction inside the first gesture.
   - Idle slices: `_scheduleWarm`, `_cancelWarm`, `_warmTick` and `_warmItem` (`:860`–`:926`). They run on `requestIdleCallback`, with a 200 ms deadline (`MUSIC.warm`, `js/data.js:1210`). Each slice runs at least one item, more while > 2 ms of idle is left. Without `requestIdleCallback` a 16 ms timer runs one item per tick.
   - **Items 0–3** create one oscillator per type: sine, square, sawtooth, triangle. The context caches the tables.
   - **Then one item per `AUDIO_CUES` recipe:** a dry build through the real `_startCue` into an unconnected `_warmSink` (`:824`), with `_warming` set.
     - It builds the full chorus, the panner and the pooled shapers.
     - No source is started (`:1422`, `:1444`), and there is no live stackDb bookkeeping (`:1388`).
     - Randomness is local, so the shared `rngFx` stream is untouched (`:1150`).
     - The voice is released at once.
   - **Result:** nothing is rendered or heard, and every cue's node kinds and code paths are warm before the first tap.
   - `_startCue` now returns its voice (`:1286` / `:1393`).
   - In every probe run the warm-up had finished by the title (`warmLeft` 0).
2. **WaveShaper pool.**
   - `_takeShaper` and `_giveShaper` (`:1542` / `:1558`) keep one pool per drive, up to `MUSIC.queue.shaperPool` = 8 (`data.js:1206`).
   - `voice.nodeDrive` (Float64Array, `:358`) marks pooled shapers. `_releaseVoice` (`:1565`) disconnects them and returns them to the pool.
   - The warm-up seeds the pools.
   - The 150 s soak created **5** WaveShapers in total, against r3's 24 in 180 s.
3. **Deferred delayed cues.**
   - A queued cue with `delayMs` ≥ `MUSIC.queue.deferMinMs` (200) moves into an 8-entry table (`:1212`). It is built `deferLeadMs` (150) before its start by `_startDeferred` (`:1230`).
   - The start time stays exact on the audio clock; a late frame starts the cue at t0 at the latest.
   - stackDb keeps working, because the pending pointer follows the entry. `_clearQueue` (`:1171`) drops deferred entries like queued ones.
   - This covers the fanfare after the boss-death roar and the boss stomp landings.

### Numbers

**Fresh page, per cue** (`tools/cuecost.mjs`; `EV/perf/cuecost-{before,after}-{1,2,3}.json`, summary `EV/perf/cuecost-summary.txt`):

- Setup: 4× CPU, music on; `play` + `update` timed for every cue, three passes per page; 3 interleaved fresh pages per side.
- Values are medians in ms.

| Cue | First use: before | First use: after | Later uses: before | Later uses: after |
|---|---|---|---|---|
| shot | 10.1 | **3.5** | 2.4 | 2.0 |
| whomp | 10.3 | **2.5** | 3.0 | 3.5 |
| pass_up | 10.7 | **4.2** | 4.2 | 4.9 |
| hup (8 voices) | 11.2 | 10.3 | 9.6 | 10.1 |
| roar | 6.0 | **4.4** | 6.1 | **3.4** (shaper pool) |
| thud | 3.2 | 1.7 | 2.9 | 2.8 |
| fanfare (in the boss-death frame) | 12.3 | **0.8** | 8.7 | **0.1** (built ~0.75 s later in a frame of its own) |
| sting_minigun | 7.0 | 5.9 | 4.0 | 5.7 (new whine layer) |
| all 35 cues, first pass | 128–135 | **89–96** | 84–98 (later passes) | 68–87 (later passes) |

**In game** (`tools/audioframes.mjs`; `EV/perf/af-{before,after}-{1,2,3}.txt`):

- Setup: 4× CPU, music on (the title pad has played), L1 for 25 s with smoke's lane bot, then a jump to the boss at C = 140 and on to the results.
- Values are `audio.update` ms in that frame, then the frame's JS ms in parentheses, for runs 1 / 2 / 3.

| Moment | Before | After |
|---|---|---|
| first shot | 3.7 / 4.5 / 5.7 (13.8 / 14.8 / 22.2) | 3.6 / 2.0 / 1.9 (26.5 / 13.6 / 11.1) |
| first gate pass | 11.8 / 11.5 / 13.0 (26.2 / 24.9 / 25.1) | 8.4 / 10.3 / 8.1 (23.2 / 25.3 / 22.8) |
| worst gate-pass frame | 18.4 / 13.4 / 20.7 | 12.2 / 11.7 / 11.5 |
| first pickup (crate + sting + shot) | 3.9 / 5.8 / 3.5 | 4.9 / 5.0 / 4.9 (the stings now carry a tonal layer) |
| boss:intro (roar) | 4.5 / 5.0 / 5.1 | 2.6 / 3.4 / 3.5 |
| boss:phase | 5.0 / 4.5 / 3.6 | 4.8 / 5.1 / 3.8 |
| **boss:dead** | **14.8 / 14.4 / 12.0** (24.2 / 24.7 / 22.1) | **5.1 / 4.1 / 2.7** (23.0 / 13.4 / 13.2) |
| first level-mode scheduler tick (a `setInterval` task, not in rAF) | 17.6 / 17.8 / 17.5 | 15.7 / 15.3 / 10.7 |

**The verify throttle tool** (`tools/throttle.mjs`, `--prio`, nomusic; `EV/throttle/`):

- L1 at 4×, 100 s, 2 interleaved pairs. Values are frame interval ms (JS ms of the frame before).

  | Moment | Before | After |
  |---|---|---|
  | first gate (8.7 s) | 34.8 (32.1) / 34.7 (30.6) | **< 27.8 / 27.8 (23.7)** |
  | gate 2 (14 s) | < 27.8 / 34.8 (32.4) | < 27.8 / < 27.8 |
  | boss arrival (50.0 s) | 41.7 (36.1) / 55.5 (42.7) | 48.5 (38.3) / 41.8 (36.4) |
  | results | 69.4 / 34.9 | 41.7 / 41.6 |

  - The boss arrival is dominated by `_fireBoss` and `boss.render`; see needsOtherGroup 2.
  - Whole runs:

    | Run | fps mean | Frame p99 (ms) | JS mean (ms) |
    |---|---|---|---|
    | Before | 120.5 / 120.8 | 20.7 / 14.0 | 5.6 / 5.55 |
    | After | 118.6 / 118.6 | 20.8 / 20.8 | 5.65 / 5.68 |

    These are equal within host noise.
  - after-1 also has one 128 ms long task outside rAF at 58.2 s, mid boss fight (12.9 ms JS in the frame before). It is the same signature as the verify pass's GC-like 107 ms task; no audio event falls there.
  - 0 errors; every run cleared L1.
- **Boot only,** 2 interleaved pairs (`EV/throttle/boot-*.log`):

  | | Worst painted gaps (ms) | AudioContext step |
  |---|---|---|
  | Before | 201 / 194 | 201 / 188 |
  | After | 201 / 222 | 201 / 174 |

  - The 222 ms gap is at the 93.4 % prewarm step, inside verify's 180–230 ms range for it.
  - 0 gaps over 300 ms; title frames are fine. The warm-up's idle slices add no boot gap.

**Leaks and coding rules:**

- 150 s soak (`EV/after/soak.soakan.txt`):
  - created 24 587, disconnected 24 533;
  - 54 live nodes 6 s after quit, against r3's 49. The +5 are the 4 type-warming oscillators and the warm sink; they are created once and do not grow.
  - level-start baselines 68 / 50 (r3: 63 / 45);
  - 0 dropped cues.
- ARCH §14:
  - **No allocation per frame.** `_startDeferred` and the reward-stack check only copy numbers between preallocated entries. The warm-up closure, entries and pools are created in `init` / `_buildGraph`.
  - Every browser call is guarded, including `requestIdleCallback` and `cancelIdleCallback`.
  - No `console.*` and no `Math.random`.

### Per-use costs that remain (not first use)

- **`hup` chorus** at a big positive pass: 8 voices × (sawtooth, band-pass, envelope, panner), about **10 ms at 4×** on every such pass. It is the bulk of the 8–12 ms gate-pass frames.
- **Music downbeat:** 8–9 ms at 4×, every bar (2 s). The level loop's bar 0 is 11–16 ms in a scheduler task. The cost is the pad chord: 3 notes × 2 voices × (oscillator, low-pass, envelope).
- **Possible fix:** share one stereo filter per chorus or chord. That is an audio-owned change but a small sound change, so I left it out of this round; see needsOtherGroup 1.

## 4. Docs

- **GDD §13:**
  - the reward bus also carries flip and stings;
  - the slider law and the music bus value;
  - the bed duck on flip and stings, and the reward stack;
  - the measured ≥ 6 dB for flip and stings;
  - first-use warm-up, shaper reuse and deferred builds;
  - the `flip` and `sting_*` rows.
- **ARCHITECTURE:**
  - §6.13 graph note: round-4 listeners, `noAtten`, `rewardStack`, linear faders, warm-up, shaper pool, deferred table;
  - §8.8 `MUSIC` line: music −15.94, `rewardStack`, the round-4 extras;
  - §11: round-4 amendments, and settings `sound` → sfx/gun/reward, linear.
- **`js/data.js` keys:**

  | Line | Key | Change |
  |---|---|---|
  | 1179 | `MUSIC.buses.music` | −15.94 |
  | 1193 | `MUSIC.duck.rewardStack` | new, [−5, 0.45] |
  | 1206 | `MUSIC.queue.deferMinMs` / `deferLeadMs` / `deferCapacity` / `shaperPool` | new, 200 / 150 / 8 / 8 |
  | 1210 | `MUSIC.warm` | new |
  | 1332 | vocabulary `noAtten` | new |
  | 1403 | `AUDIO_CUES.flip` | recipe changed |
  | 1437–1460 | `AUDIO_CUES.sting_*` | recipes changed |

  Line numbers are as of this hand-off.
- **artifact.html:** no rebuild needed; it loads `js/audio.js` and `js/data.js` by URL.

## needsOtherGroup

1. **Lead (decision, audio-owned work):**
   - **(a) Per-use node cost.** Should the `hup` chorus and the music pad share one filter per chorus or chord? That would cut about 25–35 % of their nodes: ≈ 3 ms off a big gate-pass frame and the bar-downbeat task at 4×. It is a small timbre change (filter after envelope instead of before). It is my code; I would do it on request.
   - **(b) Sound 50 / music 80 reaches +3.8 dB, not 6 dB.** The bed there is mostly music, at −1.9 dB. If the lead wants ≥ 6 dB at that setting too, there are two options:
     - a lower default music fader (save / ui; 70 would give about +1.2 dB);
     - a music-only duck under positive passes deeper than the current −6 dB (audio).
2. **level / boss (unchanged from boot-polish needsOtherGroup 4).**
   - The boss-arrival frame is still 42–56 ms at 4×, with 36–43 ms of JS.
   - Audio's share fell from 4.5–5.1 ms to 2.6–3.5 ms. The rest is `_fireBoss` (9–10 ms) and `boss.render` (≈ 4 ms).
3. **main (optional).** Audio warms itself in idle slices, because it is boot step 7 and not one of main's `SYSTEMS` with `initSteps` / `initStep()`. If main wants one boot-slice protocol for everything, audio can expose the same pair; no change is needed today.
4. **QA / verify.** Re-run the audio battery with `EV/tools/rec4.mjs` (a superset of rec3) when convenient. The commands are in `EV/tools/batch-*.sh`.
5. **Integrator:** nothing to rebuild.
