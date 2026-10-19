# Round 3 — audio mix: AUD-10 (gate-pass reward) and the full round-2 audio re-measurement

Owner files: `js/audio.js`, and in `js/data.js` only `MUSIC.*` and `AUDIO_CUES.*`. The data.js edits were anchor-checked replacements that re-read the file just before each write; the other groups' concurrent edits in data.js, such as `STRINGS` / `LEVEL_NAME`, are untouched. Docs: `docs/GDD.md` §13, and `docs/ARCHITECTURE.md` §6.13, §8.8 (the `MUSIC` line) and §11.

**Evidence root:** `E:/Temp/claude/gate-rush-evidence/r3/audio/`, written `EV/` below.

- **`EV/src-before/`:** the pre-change `audio.js`, `data.js`, `GDD.md` and `ARCHITECTURE.md`.
- **`EV/before/`:** the baseline battery, recorded on the unmodified project.
- **`EV/after/`:** the same battery on the final code.
- **`EV/mirror-before/`:** a served copy with the old `audio.js` + `data.js`, used for baseline unit checks run later.
- **`EV/tools/`:** the round-3 audio tools. In this report, `tools/…` means this folder, except `tools/smoke.js` and `tools/check-imports.js`, which are the project's. Most were copied from `qa2/audio` and `qa2/fix-audio` and retargeted to E:. The rest are new: `rec3` (+ pass / soak / hup phases), `passan`, `cueqa`, `evrise`, `cuerise`, `duckan`, `soakan`, `musican`, `droneunit`, `stalenotes`, `slowreward` and `rewtune`.
- **Gameplay was the same in both batteries.** Between them, other groups changed only `engine` / `main` / `render` / `ui` / css / index. The gameplay modules (level, levelgen, gates, squad, zombies, weapons) were unchanged, so the before and after beds are comparable.

**How the captures were made:**

- An AudioWorklet taps the master gain, which is the post-limiter signal that reaches the destination.
- Stereo, 48 kHz, raw float32, in real time in headless Chrome on the real GPU.
- Music ON, faders at the defaults (sound 100, music 80), phone viewport, `?debug=1`.

## Verdict

- **AUD-10 is met.**
  - Every positive gate pass reads ≥ 7.4 dB over the surrounding gunfire: 58 of 58 passes at C = 5, 25, 100 and 300. The measure is the pass's loudest 50 ms against the master RMS of the 1 s before the pass, music included.
  - Medians are 8.0–9.1 dB. Before: minimum 2.5–3.3 dB, median 5.3–5.6 dB, and 44 of 58 passes under 6 dB.
  - The 8-voice `hup` is +5.0 dB louder than one voice (loudest 50 ms; +4.3 dB RMS). It is also wide: side/mid −8.8 dB and L/R correlation 0.80, while one voice is mono. Before: +4.1 dB and mono.
- **Full re-measurement: everything is within its round-2 limits.** That covers every cue in isolation, same-frame stacks, the master chain, the gameplay bed, roars and boss events, music modes and switches, ducks, slow-mo pitch, and node counts over 3 minutes.
  - 0 samples ≥ 0.999 anywhere. 0 samples above the soft-clip knee (0.8) in the eight gate-pass runs; the other runs were not scanned for the knee.
  - No node leak.
- **Five other defects were found and fixed:**
  1. The boss drone ended with a cut instead of a fade.
  2. A music restart after a full stop let up to 7 stale notes of the old loop back in.
  3. Positional cues jumped +3 dB at exactly x = 0.
  4. `sting_rail` sat 4 dB (peak) / 7 dB (RMS) under the other stings.
  5. The brute / boss `roar` lost 13.5–14.2 dB on a phone speaker, against the GDD §13 limit of 8 dB.
- **Static checks and smoke.** `node --check` passes on both files. `node tools/check-imports.js` reports 0 errors and 0 warnings. `node tools/smoke.js --scenario all` is **CLEAN**: 0 page errors, 0 console errors or warnings, 0 failed requests, and L1 was won.

## 1. AUD-10: the gate-pass reward over the gunfire

### Root cause (measured)

- **One compressor for everything.** `pass_up`, `hup` and the gate `coin` rode the sfx bus into the same 6:1 bus compressor as the gunfire, the gate ticks and the music.
- **The reward compressed itself.** The compressor detects peaks with a 3 ms attack, so it reacted to the reward's own onsets:
  - gain reduction during the reward was −4.3 to −8.0 dB;
  - the reward's loudest 50 ms stayed at −14.2 to −15.0 dBFS (run medians) whatever its gain;
  - above the threshold, +6 dB of input gives about +1 dB of output.
- **The gunfire duck could not fix it.** The 1 s bed sits at −19.6 dBFS, and the gunfire is the smaller part of it: without music the same bed measures −24.2 dBFS. The round-2 gun-bus duck acts before the compressor, so the compressor's release and makeup gain refill most of it.

### Fix (`js/audio.js`, `js/data.js`)

1. **Reward bus after the compressor.**
   - Cues with `bus: 'reward'` sum into `_rewardBus`, set by `MUSIC.buses.reward` (−7 dB) times the sound fader. It feeds the limiter directly.
   - Code: `_buildGraph` `js/audio.js:698`, cue routing `:1117`, fader `:1475`, fields `:403-404`, header graph `:5-13`.
   - Data: `MUSIC.buses` `js/data.js:1135`, and the vocabulary `bus: 'reward'` `:1270`.
2. **Bed duck after the compressor.**
   - The compressor output passes `_bedDuck` (`js/audio.js:704`, `:716`).
   - On a positive `gate:pass`, `_duckBed()` (`:1417`, called at `:2025`) dips it by `MUSIC.duck.bedOnReward` [−4 dB, 0.35 s] (`js/data.js:1147`).
   - Because it sits after the compressor, the makeup gain cannot undo it. The round-2 gun duck (−9 dB) and music duck (−6 dB) are unchanged.
3. **`pass_up`** (`js/data.js:1347`):
   - On the reward bus.
   - Each note is held 30 ms (attack 6 ms): +5.5 dB of RMS at the same peak (isolated RMS −17.0 → −11.5 dBFS; peak −6.1 → −6.7).
   - It starts 15 ms after the pass, so its first onset no longer stacks on the gate coin's onset. Offline, the pass_up + coin peak drops from −3.5 to −5.9 dBFS.
   - `noTimeScale`, like the other reward stings, so the arpeggio stays in C major inside a slow-mo dip.
4. **`hup`** (`js/data.js:1357`):
   - On the reward bus, entering 255 ms after the pass: the crowd's answer to the arpeggio.
   - **Why the delay.** The chorus has a crest factor of about 12 dB. In a first in-game build with the hup still starting on the E5 note, the two together drove the master to −0.8 dBFS at +74 to 95 ms (`EV/tune/g-c25`). Moved after the arpeggio and trimmed to 0.7, the worst in-game master peak is −2.0 dBFS.
   - **Gain and attack.** `voices.gainExp` 0.1 → 0.2, gain 0.9 → 0.7, attack 10 ms.
   - **New `voices.spread` 0.7** (`js/audio.js:1156-1185`):
     - each chorus voice gets its own StereoPanner;
     - pan slots fill from the outside in and alternate sides, so the detunes do not line up low-left / high-right;
     - √2 pan-law compensation, `PAN_LAW_COMP` (`:89`, applied `:1159`);
     - `measureCues` counts the per-voice panners (`:352`).
5. **Docs.** GDD §13 graph, ducks, reward criterion, time-scale list, and the `pass_up` / `hup` rows. ARCH §6.13 / §11 / §8.8.

### Numbers: gate passes held at a fixed squad size

Setup:

- Runs: `EV/{before,after}/pass-c{5,25,100,300}`, each L2 → L3 → L4.
- The bot steers to the best lane.
- C is held: it is reset 1.3 s after each pass, so every pass starts at C.
- Analyser: `tools/passan.cjs`.

| C | passes | min rise (dB) | median rise | passes < 6 dB | 1 s bed (median dBFS) | reward 50 ms (median dBFS) | rise vs loudest 50 ms of bed, min | phone-band rise, min | master peak dBFS | comp. reduction min |
|---|---|---|---|---|---|---|---|---|---|---|
| 5 | 13 → 13 | 3.3 → **8.0** | 5.6 → **9.1** | 9 → **0** | −20.6 / −20.6 | −15.0 → −11.5 | −0.4 → 4.3 | 7.0 → 12.8 | −3.8 → −3.3 | −6.9 → −4.3 |
| 25 | 15 → 15 | 2.6 → **7.6** | 5.6 → **8.3** | 10 → **0** | −19.7 / −19.9 | −14.3 → −11.5 | −0.2 → 4.4 | 6.1 → 10.6 | −3.9 → −3.0 | −8.0 → −4.0 |
| 100 | 15 → 15 | 2.5 → **7.4** | 5.5 → **8.0** | 13 → **0** | −19.6 / −19.6 | −14.2 → −11.5 | −0.7 → 3.6 | 6.2 → 10.8 | −3.8 → −3.5 | −7.8 → −4.5 |
| 300 | 15 → 15 | 2.8 → **7.7** | 5.3 → **8.2** | 12 → **0** | −19.6 / −19.6 | −14.4 → −11.5 | −1.6 → 3.2 | 5.9 → 11.5 | −3.5 → −2.0 | −8.0 → −5.4 |

How to read the table:

- **Metrics.** rise = loudest 50 ms RMS window in [t, t + 0.45 s] minus the master RMS over [t − 1.0, t − 0.02), where t is the `pass_up` play time on the AudioContext clock. The phone band is a 400 Hz 4th-order high-pass.
- **Clip region.** 0 samples ≥ 0.999 and 0 samples above 0.8 (the soft-clip knee) in all eight runs. The limiter's reduction stayed ≥ −0.04 dB.
- **Bed level by squad size.** The bed is the same at every C (≈ −19.6 dBFS): the compressor holds it, and the music is its larger part.

**Cross-checks:**

- **Round-2 metric on L1.** With round 2's own metric (`tools/events.cjs`: loudest 50 ms over the 300 ms before), the L1 passes go from +5.5 / 4.9 / 6.6 / 9.1 to **+9.9 / 8.4 / 10.0 / 10.1** dB (`EV/*/l1/events.json`).
- **All gameplay captures.** `tools/evrise.cjs` over every capture gives `pass_up`: minimum 2.5 → **7.4**, median 5.3 → **8.5** dB (n 51 → 50).
- **The fader is not a confound.** Same L2 run at C = 25 (`EV/tune/s100m0-after`, `s50m0-after`):

  | Faders | Bed | Reward rise (median) |
  |---|---|---|
  | sound 100, music 0 | −24.2 dBFS | 12.6 dB |
  | sound 50, music 0 | −36.3 dBFS | 12.7 dB |

  So the post-compressor reward does not lose ground against the gunfire when the sound fader drops.

**Note: sound 50 / music 80.** At that setting every sfx sits under the music, before and after alike. The pass reward rises −0.5 dB (after) and +1.1 dB (before) (`EV/tune/f50-*`). The cause is the squared fader law: sound 50 is −12 dB. That is a settings matter; see needsOtherGroup 2.

### Numbers: hup, one voice against eight

Isolation captures: `EV/{before,after}/hup`, three repeats per count, analysed by `tools/cueqa.cjs`.

| count (voices) | before: 50 ms / RMS / peak / width | after: 50 ms / RMS / peak / width (side/mid; L/R corr) |
|---|---|---|
| 1–4 (1) | −18.5 / −18.9 / −7.0 / mono | −22.9 / −23.4 / −11.0 / mono |
| 8 (2) | −17.0 / −17.8 / −4.9 / mono | −21.2 / −22.0 / −8.5 / −4.1 dB (0.4) |
| 16 (4) | −16.2 / −17.0 / −5.0 / mono | −19.2 / −20.2 / −6.5 / −8.7 dB (0.8) |
| 32 (8) | −14.5 / −15.8 / −5.1 / mono | −17.9 / −19.1 / −7.1 / −8.8 dB (0.8) |
| **8 voices over 1** | +4.1 / +3.1 / +1.9, no width | **+5.0 / +4.3 / +3.9, wide** |

**The whole reward in isolation:**

| Reward | Loudest 50 ms, before → after |
|---|---|
| pass_up + hup(4) | −17.3 → −11.6 dBFS |
| pass_up + hup(32) | −14.8 → −11.6 dBFS |

**Offline render** (`EV/*/units/rewtune.txt`, the game's own interpreter and chain in an OfflineAudioContext):

| Reward | Loudest 50 ms, before → after | Peak, before → after |
|---|---|---|
| +4 | −17.8 → −11.7 dBFS | −4.8 → −5.9 dBFS |
| +32 | −14.3 → −11.7 dBFS | −4.8 → −5.0 dBFS |

**In game.** The 8-voice `hup` window (+265…355 ms) measures −18 to −21 dBFS with side/mid −8 to −14 dB, over a bed that is ducked to about −23.6 dBFS. A one-voice hup (gains of +1 to +4) is deliberately small. It sits about at the ducked bed, and the arpeggio carries those passes.

**Peak tail.** Over 48 offline seeds, the 8-voice chorus peaks at a mean of −5.9 dBFS, a 90th percentile of −2.9 and a worst case of −0.8 dBFS. The worst case is caught by the limiter. The worst in-game master peak in the four pass runs was −2.0 dBFS (C = 300, ×5 pass).

## 2. The full round-2 audio re-measurement (before → after)

Batch: `tools/batch-all.sh` and `tools/batch-units.sh`. Every number below is from `EV/before` → `EV/after` unless noted.

### 2.1 Every cue in isolation

Run: `EV/*/cues`, analysed by `tools/cueqa.cjs`. Menu music is stopped and the floor is silent: −200 dBFS between cues. Window per cue: [t − 40 ms, next − 60 ms].

**Columns:**

- **Dur:** onset to the last 5 ms block above the cue's loudest − 50 dB. It is never longer than the recipe (nominal = max(delayMs + ms)), so **no ringing tail** survives the envelopes.
- **Onset step:** the largest sample step in the first 1 ms, relative to the peak. For sine and triangle cues it stays at the waveform's own slope under its 2 ms attack: −17 dB for the 2.2 kHz tick, −22 to −47 dB for the rest. No cue starts with a step, so there are no onset clicks. Sawtooth, square and noise sources read high by nature, because their waveforms have sharp edges. The value also moves between runs with the compressor's state at the onset; chime3, for example, reads −26.3 in one run and −21.8 in another.
- **End level:** the last audible 1 ms relative to the loudest 1 ms. Every cue is ≤ −54 dB, so **no end cuts**.
- **Phone loss:** 400 Hz 4th-order high-pass.
- **hup rows:** their nominal length includes the new 255 ms delay. Their duration is measured from their own onset.

| Cue | Peak dBFS | RMS (active) | Max 50 ms | Dur / nominal ms | Onset step re peak | End level re max | Phone loss | Clip |
|---|---|---|---|---|---|---|---|---|
| shot | -10.3 | -23.2 → -23.8 | -24.7 | 55 / 60 | -10.9 | -66.4 | -8.5 | 0 / 0 |
| thip | -17.9 | -33.6 | -38.9 | 20 / 20 | -16.5 | -64.6 | 0 | 0 / 0 |
| crunch | -11.6 | -24.9 | -25.4 | 70 / 80 | -30.4 | -70.8 → -69.2 | -8.1 | 0 / 0 |
| ugh | -10 | -23.8 | -23.8 | 80 / 90 | -39.7 | -91.6 | -5.9 | 0 / 0 |
| splat | -13.4 | -28.6 → -28.1 | -28.6 | 75 / 100 | -26.6 | -73.3 → -73.8 | -1 | 0 / 0 |
| screech | -15.4 → -15.5 | -27 → -27.2 | -23.1 → -23.4 | 215 → 210 / 250 | -21.2 → -10.7 | -61.2 → -66.2 | -0.1 | 0 / 0 |
| roar | -9 → -5.7 | -13.4 → -16.2 | -11.5 → -14.2 | 545 → 550 / 600 | -26.9 → -31.4 | -67.1 → -65.4 | -13.5 → -7.3 | 0 / 0 |
| thud | -6.2 | -18.5 → -18.8 | -16.5 | 130 / 150 | -24.4 | -59.2 → -63.8 | -4.9 | 0 / 0 |
| tick | -9.6 | -18.7 | -21.7 | 35 / 40 | -27.7 | -63.1 | -1.4 | 0 / 0 |
| max | -8.5 | -21.8 → -21.4 | -20.2 | 190 → 185 / 200 | -25.7 | -65.2 | -0.2 | 0 / 0 |
| flip | -9.3 | -22.1 → -22.3 | -20 | 145 / 150 | -43 | -64.3 → -59.4 | -0.5 | 0 / 0 |
| whomp | -5.6 | -22.3 | -18.1 | 245 / 300 | -15.7 | -70.8 → -66 | -7.3 | 0 / 0 |
| pass_up | -6.1 → -6.7 | -17 → -11.5 | -18.3 → -11.6 | 235 / 255 | -37.1 → -46.9 | -62.6 → -63.7 | -0.9 | 0 / 0 |
| pass_down | -9 | -20.7 → -20.3 | -19.2 | 225 / 240 | -37.3 | -63.5 | -5.6 | 0 / 0 |
| hup | -7 → -11 | -18.9 → -23.3 | -18.5 → -22.9 | 65 / 325 | -57.8 → -62.5 | -61.8 → -84.9 | -3 | 0 / 0 |
| pop | -8.4 | -19.7 | -21.3 | 55 / 60 | -27.5 | -62.3 | -1.4 | 0 / 0 |
| jingle | -9.8 | -23.3 → -22.9 | -22.9 | 260 / 270 | -30 | -64.5 → -73.9 | -0.6 | 0 / 0 |
| sting_shotgun | -6.5 | -18.7 | -17 | 105 / 120 | -21.9 → -22.1 | -64.8 → -64.6 | -1.7 | 0 / 0 |
| sting_minigun | -6.8 | -21.2 | -22.2 | 205 / 210 | -12.7 → -21.6 | -70.6 → -70.2 | -8.7 | 0 / 0 |
| sting_rocket | -6.7 | -21.3 → -21.4 | -16.3 | 340 / 400 | -29.8 | -93.3 → -77.8 | -6.6 | 0 / 0 |
| sting_rail | -10.8 → -7.1 | -27.7 → -20.2 | -23.7 → -16.7 | 205 → 215 / 300 | -10.2 → -9.4 | -86.2 → -83.4 | 0 | 0 / 0 |
| sting_laser | -7 | -13.9 → -13.8 | -10.3 | 350 / 400 | -35.1 → -35.3 | -65.6 → -65.5 | -0.1 | 0 / 0 |
| ticktock | -11.8 | -23.3 | -27.3 | 30 / 30 | -25.9 → -25.8 | -73.4 → -73.2 | -0.2 | 0 / 0 |
| rocket | -5.7 | -18.6 | -13.8 | 300 / 350 | -33.7 | -62.5 | -11.2 | 0 / 0 |
| rail | -6.6 | -21.4 → -21.5 | -17.6 | 215 / 260 | -11.5 | -60.4 → -64.7 | -7.1 | 0 / 0 |
| crack | -6.3 | -20.7 → -21.1 | -21.1 | 75 / 80 | -21.1 | -74.9 → -63.8 | -0.5 | 0 / 0 |
| explosion | -6.3 | -20.9 → -20.8 | -15.9 → -15.8 | 395 / 500 | -32.8 | -88 → -77.1 | -4 | 0 / 0 |
| crash | -4.1 | -20.3 | -15.1 | 370 / 400 | -10.2 | -64.5 | -0.9 | 0 / 0 |
| fanfare | -6.9 | -22.2 | -18.9 | 740 / 770 | -35.3 | -66.5 | -1.7 | 0 / 0 |
| chime3 | -9.9 | -22.9 | -20.9 | 430 → 425 / 450 | -26.3 → -21.8 | -60.4 → -60.2 | -0.2 | 0 / 0 |
| drone_down | -7.5 | -17 | -15.3 | 1100 / 1200 | -58 | -90.9 → -73.6 | -4.7 | 0 / 0 |
| coin | -7.4 | -21.5 | -21.9 | 70 / 80 | -23.5 | -65.1 → -61.5 | 0 | 0 / 0 |
| ui_tap | -11.8 | -23.2 | -26.2 | 40 / 40 | -26.4 | -84.3 | -0.4 | 0 / 0 |
| ui_buy | -9.9 | -22.9 | -22.5 | 190 / 200 | -33 | -65.4 | -1.8 | 0 / 0 |
| ui_star | -10.1 | -22.9 | -21.8 | 105 / 120 | -24.7 | -59.9 | -0.1 | 0 / 0 |
| shot count40 | -7.2 → -7.7 | -18.9 → -19.8 | -20.5 → -20.7 | 55 / 60 | -12.2 → -10.7 | -56.8 → -72.4 | -8.8 → -8.1 | 0 / 0 |
| hup count4 (1 voice) | -7 → -11 | -18.9 → -23.3 | -18.5 → -22.9 | 65 / 325 | -57.8 → -62.7 | -61.8 → -62.8 | -3 | 0 / 0 |
| hup count32 (8 voices) | -4.6 → -8.6 | -16.6 → -20.3 | -15.4 → -18.7 | 85 / 325 | -61.9 → -65.9 | -68.2 → -72.7 | -2.2 → -3.3 | 0 / 0 |
| tick value300 (2200Hz) | -9.6 | -19.5 → -18.7 | -21.7 | 40 → 35 / 40 | -17.3 | -64 | 0 | 0 / 0 |
| roar boss-death | -15.2 → -10.1 | -21.1 → -22.2 | -19.2 → -20.4 | 1365 → 1355 / 1500 | -36.8 → -43.6 | -65.9 → -66.4 | -14 → -6.1 | 0 / 0 |
| roar boss-intro | -15.7 → -10.1 | -21.3 → -22.4 | -19.4 → -20.5 | 545 → 550 / 600 | -28.3 → -35.6 | -67.5 → -67.6 | -14.2 → -6.8 | 0 / 0 |
| thud boss-stomp | -5.4 | -19.4 | -17.2 | 140 → 135 / 150 | -22 | -64.4 | -4.9 | 0 / 0 |
| thip boss-hit | -19.7 → -16.6 | -33.7 → -32.6 | -39 → -39.6 | 20 → 15 / 20 | -12.7 → -8.7 | -67.7 → -64.6 | 0 | 0 / 0 |
| pass_down neutral(-6dB) | -15 | -26.4 → -26.6 | -25.2 | 225 → 220 / 240 | -37.3 → -22.1 | -63 → -63.6 | -5.6 → -5.8 | 0 / 0 |
| crunch x6 in 120ms (stack) | -11.9 → -9.7 | -24.9 → -22.8 | -24.4 → -21.8 | 145 → 200 / 80 | -39.5 → -41.7 | -54.7 → -64.4 | -8.3 → -10 | 0 / 0 |
| coin ladder x14 | -7 | -21.5 → -21.6 | -21.9 | 1050 → 1000 / 80 | -23.9 | -63.2 | 0 | 0 / 0 |
| tick 25 hits/s 1s (one gate) | -9.6 | -18.7 → -18.8 | -19 → -18.9 | 1225 / 40 | -27.7 → -21.9 | -62.4 → -67.1 | -1.4 | 0 / 0 |
| pass_up+hup32 (gate pass) | -4.6 | -16.5 → -12.6 | -14.8 → -11.6 | 235 → 325 / – | -29.8 → -26.3 | -62.6 → -80.3 | -1.4 → -1 | 0 / 0 |
| boss:dead roar0.4+fanfare | -6.8 → -6.9 | -21 → -21.8 | -18.8 | 1640 → 1630 / – | -45.4 → -45.1 | -61.9 → -62.2 | -7.2 → -4.3 | 0 / 0 |

What changed, and why:

- **Changed by design:**
  - `pass_up`: about +5.5 dB RMS.
  - `hup`: reward bus, now quieter alone and wide in chorus.
  - `roar`: phone loss −13.5 → −7.3, boss −14.2 → −6.8 / −14.0 → −6.1; see §3.5.
  - `sting_rail`: peak −10.8 → −7.1, against the sting median of −6.8.
- **Run-to-run variation, not a change:** the other small differences. These sources start at a random offset into the noise buffer, have a random onset phase, or depend on main-thread jitter in the burst tests.
- **Still over 8 dB of phone loss:** `rocket` −11.2, `shot` −8.5, `crunch` −8.1 and `sting_minigun` −8.7. They are noise-band or weapon-fire cues, not gameplay-critical "low cues" under the GDD rule, and they keep their identity. They were not changed.

### 2.2 Same-frame stacks (AUD-6)

Run: `EV/*/stack`. Figures are the ×4 peak over the ×1 peak, all with 0 clipped samples:

| Cue | Before | After |
|---|---|---|
| ugh | +5.9 | +5.5 |
| splat | +0.5 | +4.9 |
| screech | +6.0 | +6.0 |
| thud | +2.2 | +2.9 |
| pop | +2.9 | +4.7 |
| hup | +2.0 | +6.0 (its stackDb cap, now uncompressed) |

Every cue stays within the AUD-6 limit of +6 dB.

### 2.3 Gameplay bed, roars and boss events (AUD-5 / AUD-7 / AUD-13)

Runs: `EV/*/l1` (100 s) and `EV/*/boss`, analysed by `tools/events.cjs` and `tools/analyze.mjs`.

| Check | L1 before → after | Boss run before → after |
|---|---|---|
| Gameplay bed, median RMS (AUD-5: within ±2 dB of −22) | −21.3 → −21.5 dBFS | — |
| Master peak, clipped samples | −3.9 → −3.1, 0 / 0 | −4.2 → −4.5, 0 / 0 |
| Roar over the 2 s median (≤ +8): intro / brute / death | +7.4 / +5.6 / +1.2 → +6.1 / +3.5 / +0.2 | +6.3 / +5.1 / +2.2 → +6.5 / +3.7 / +1.4 |
| Intro roar vs the loudest other intro block | −18.5 vs −21.2 → −19.9 vs −21.6 | −18.4 vs −20.2 → −18.4 vs −21.4 |
| Comp. reduction on boss:phase (−6 to −10) | −7.0 / −5.5 → −6.4 / −6.3 | −6.0 / −6.2 → −6.6 / −5.6 |
| boss:dead music dip (≥ 8 dB), music at +2.6–3.2 s | −10.2 → −11.3, silent | −9.5 → −9.6, silent |
| Fanfare pitch, boss:dead + 0.9 s (`tools/pitch.mjs`, 55 ms windows) | C5 523 / E5 659 / G5 784 / C6 1046 / E6 1318 / G6 1567 Hz at −1 cent, before and after | same |

The only analyze.mjs "spikes ≥ 8 dB" left in L1 are the gate-pass reward itself, at +10 to +12 dB over a quiet 2 s median. The AUD-7 spike rule is for the roar.

### 2.4 Music modes, switches and tempo (AUD-12)

Runs: `EV/*/music` with `tools/musican.cjs`, and `EV/*/exp.json` with `tools/exp3.mjs`.

| Check | Before | After |
|---|---|---|
| Music-tap level: menu / level / runup / boss / menu after quit (dBFS) | −34.3 / −29.8 / −40.7 / −29.7 / −34.4 | −34.5 / −29.8 / −40.7 / −29.7 / −34.4 |
| Pause duck | −29.5 → −41.9 (−12.4 dB) | identical |
| Step length: normal / slow-mo 0.25 / back | 125 / 178.6 / 125 ms | identical |
| Stale lookahead notes / delayed-cue layers | 0 / 0 | 0 / 0 |
| Fanfare layers not at rate 1 | 0 of 12 | 0 of 12 |
| Mode latency, mode reached / first step audible | level:start 11 / 60 ms, runup 499 / 581 (beat switch), boss:fight 11 / 60, quit 0 / 60 | 40 / 49, 509 / 581, 0 / 60, 8 / 60 |
| Hidden tab → visible | suspended → running | identical |
| Master peak, clipped samples | −4.5, 0 | −3.2, 0 |

### 2.5 Ducks at gate passes

Runs: `EV/*/pass-c25`, `pass-c300`, analysed by `tools/duckan.cjs`.

| Duck | Before | After |
|---|---|---|
| Music (MUSIC.duck.gate −6) | −6.1 / −6.4 dB median | −6.0 / −6.1 dB median |
| Gun bus | −9 dB | −9 dB |
| Bed (new) | — | −4 dB, back to ≥ 95 % after 0.7 s |

### 2.6 Slow-mo pitch (AUD-4)

- **`exp3`:** all stale counts are 0 and the fanfare stays at 0 cents (§2.4).
- **`tools/slowreward.mjs`:** plays cues inside a 0.25 slow-mo and reads each source's live detune (`EV/*/units/slowreward.json`).

  | Cue | Before | After |
  |---|---|---|
  | `pass_up` | −617 cents | **0 cents** (`noTimeScale`) |
  | `hup` | −617 cents | −617 cents (follows the slow-mo, by design) |
  | `pop` | −617 cents | −617 cents |

  Once the scale returns to 1, every source reads 0 cents.

### 2.7 Node counts over 3 minutes (no leaks)

Run: `EV/*/soak`, analysed by `tools/soakan.cjs`. L2 → L3 → L4 chained at C = 60, with one pause and one slow-mo per level, then quit to the title.

| Check | Before | After |
|---|---|---|
| Live WebAudio nodes per 30 s window: min / max / mean | 11–60 / 84–125 / 50–68 | 13–46 / 58–136 / 45–66 |
| Nodes at each level start | 61 / 43 / 43 | 63 / 45 / 45 (+2 = reward bus and bed duck) |
| 6 s after quit | 47 nodes, 12 voices (menu pad) | 49 nodes, 12 voices |
| Nodes created / disconnected | 29 666 / 29 619 | 27 753 / 27 704 |
| Dropped cues | 0 | 0 |

- **JS heap after:** flat at 22.6–28.3 MB.
- **Heap before:** it grew 36 → 103 MB, but that was the capture tap holding raw audio in the page. The tap is disabled for soak runs since then, so the before heap figure is not comparable.

### 2.8 Master chain (AUD-5)

`tools/chaincheck.mjs` builds the game's own graph offline and drives sines, square bursts and noise up to +18 dBFS into it. Maximum output is −0.47 dBFS with 0 samples ≥ 0.999, before and after. The reward bus enters the same limiter and soft clip.

### 2.9 Headline cues over the bed in gameplay (observation)

`tools/evrise.cjs` over all gameplay captures gives the loudest 50 ms over the 1 s bed:

| Cue | Before | After |
|---|---|---|
| flip | 2.1 | 3.1 |
| sting_minigun | 2.0 | 3.2 |
| sting_shotgun | 3.9 | 4.0 |
| max | 3.4 | 3.5 |
| whomp | 3.2 | 3.3 |
| jingle | 3.9 | 3.9 |
| crash | 5.7 | 5.1 |
| chime3 | 6.4 | 5.8 |

These cues have no ≥ 6 dB target; see needsOtherGroup 1.

## 3. Other defects found by the re-measurement, and fixed

### 3.1 The boss drone ended with a cut, not a fade

- **Cause.** The LFO tremolo is summed into the drone's gain param. `_stopDrone` faded only the param's own value, so the gain still swung by ±depth (−20 dB) when the oscillator stopped. This happens at a boss → menu or level restart, while the music fade is up.
- **Fix.** The LFO depth fades too: `_droneLfoGain` at `js/audio.js:465`, `:1866`, `:1883`.
- **Check.** `tools/droneunit.mjs` (offline, 8 LFO phases): the residual at the oscillator stop goes from −23 to −51 dB re the full drone (a cut) to −178 dB (silent).

### 3.2 A music restart after a full stop brought old notes back

- **Cause.** With RETRY or NEXT within about 1 s of the fade-out, the old loop's notes were still sounding under the closed fade: a bar-long pad lasts 2.5 s. The new fade-in brought them back over the new bar 0, and the same happened to the old drone in boss mode.
- **Fix.** `_releaseOldMusic()` (`:1646`, called in the fresh-start branch at `:1557`). The fade gain is 0 there, so disconnecting the notes is silent.
- **Check.** `tools/stalenotes.mjs`: stale voices at the restart go from 7 / 7 / 0 / 1 + drone / 0 to **0 / 0 / 0 / 0 / 0**.

### 3.3 Pan-law jump at x = 0

- **Cause.** Positional cues skipped their StereoPanner when pan === 0. The equal-power pan law sits 3 dB under the unity up-mix of an unpanned mono cue, so a squad standing exactly at x = 0 fired its shots 3 dB louder.
- **Fix.** Every positional cue now passes its panner (`:1120`).

### 3.4 `sting_rail` sat under the other stings

- **Before:** peak −10.8 / RMS −27.7, against the other stings' −6.5 to −7.0 peak and −14 to −21 RMS.
- **Fix:** held 60 ms, Q 2 → 1.2, gain 0.8 → 1.0 (`js/data.js:1374`).
- **After:** −7.1 / −20.2, within 0.6 dB of the sting median peak. That meets AUD-9's "within 3 dB".

### 3.5 `roar` broke the GDD §13 phone-band rule

- **Before.** The brute telegraph (J11) and the boss roars lost 13.5 / 14.2 / 14.0 dB through the phone high-pass, against the GDD §13 limit of 8 dB.
- **Fix** (`js/data.js:1324`):
  - sub sawtooth 0.4 → 0.3;
  - the noise is band-passed at 900 Hz (Q 0.6) instead of low-passed, 0.2 → 0.36;
  - a new saturated 140 Hz sawtooth layer, band-passed at 800 Hz (0.42).
- **Isolated result.** Phone loss is now 7.3 / 6.8 / 6.1 dB. Phone-band level is up 3 to 7 dB. Full-band RMS is −2.8 dB for the brute and −1 dB for the boss roars.
- **The trade-off was checked in gameplay.** The script injected roars at x 1, z −5 every 3.1 s into an L2 run at C = 25 (`EV/tune/roar/V*`, `tools/cuerise.cjs`, 16 to 17 roars each):

  | Recipe | Full-band rise (median) | Phone-band rise (median) |
  |---|---|---|
  | Round 2 | +6.6 dB | +3.6 dB |
  | Shipped | +5.3 dB | +5.2 dB |
  | V6 (sub kept at 0.4) | +6.4 dB | +5.2 dB |

  V6 keeps the full-band level, but its isolated phone loss is 8.7 dB, just over the rule. I shipped the recipe that meets the rule. The lead can trade back to V6, a one-line change; see needsOtherGroup 1.
- **AUD-7 still holds:** roar events stay ≤ +8 dB over the 2 s median, and the intro roar is still the loudest intro block (§2.3).

## 4. Verification commands

Run from `E:/Temp/claude/gate-rush-evidence/r3/audio/`. Every tool serves the project root; `GR_SERVE=<dir>` serves a mirror instead.

**Gate-pass reward**

```
./tools/batch-pass.sh after
node tools/passan.cjs after/pass-c5 after/pass-c25 after/pass-c100 after/pass-c300
```

`batch-pass.sh` runs `node tools/rec3.mjs --phase pass --count C --levels 2,3,4` for C = 5, 25, 100 and 300.

**The full battery**

```
./tools/batch-all.sh after
```

It runs, in order:

- isolation: `rec3 --phase cues|stack|hup`, then `cueqa.cjs`;
- music: `rec3 --phase music`, then `musican.cjs`;
- L1 and the boss: `rec3 --phase l1|boss`, then `events.cjs`, `passan.cjs` and `pitch.mjs`;
- the soak: `rec3 --phase soak --seconds 180`, then `soakan.cjs`;
- `exp3.mjs` and `expsum.cjs`;
- `chaincheck.mjs`;
- `evrise.cjs`.

**Unit checks, after and baseline**

```
./tools/batch-units.sh after/units
./tools/batch-units.sh before/units E:/Temp/claude/gate-rush-evidence/r3/audio/mirror-before
```

These run `droneunit`, `stalenotes`, `rewtune` and `chaincheck`.

**Single checks**

- Slow-mo pitch of the rewards: `node tools/slowreward.mjs`, and the same with `GR_SERVE=…/mirror-before` for the baseline.
- Ducks at gate passes: `node tools/duckan.cjs after/pass-c25 after/pass-c300`.
- A before / after digest: `node tools/collect.cjs` → `EV/digest.json`, and `EV/cuetable.md`.

**Project checks** (from the project root)

- `node --check js/audio.js`
- `node --check js/data.js`
- `node tools/check-imports.js`
- `node tools/smoke.js --scenario all --bootTimeout 60 --out E:/Temp/claude/gate-rush-evidence/r3/audio/smoke-all`: **CLEAN**.

**Frame A/B under the shared host's load.** `EV/mirror-ab` is the current project with only the old `audio.js`, run with the same smoke play scenario. Both runs are CLEAN.

| Run | Frames over 50 ms | Worst |
|---|---|---|
| Old audio | 14 | 479 ms |
| New audio | 24 | 305 ms |

The long frames come from the other groups' concurrent runs on this host. They do not line up with gate passes. The audio change adds no per-frame work: the new nodes are created at cue start and per gate pass only.

**Coding rules (ARCH §14).** No per-frame allocation: per-voice panners are created only when a chorus cue starts, and `_duckBed` runs once per pass event. Every browser call is guarded with try/catch. No `console.*` and no `Math.random`. Randomness comes from `ctx.rngFx`. The public API is unchanged, so `tools/callsites.js` was not needed.

## 5. Doc and data changes

**`docs/GDD.md` §13**

- Line 465: graph and the reward bus (−7 dB); bed −20 to −22 dBFS; bed duck −4 dB / 0.35 s; the reward criterion "≥ 6 dB over the surrounding 1 s of gunfire at every squad size (measured ≥ 7.4)"; `pass_up` added to the time-scale exception list; the phone-band rule now names the `roar`.
- Rows: `pass_up` 475, `hup` 477, `roar` 480, rail sting 484.

**`docs/ARCHITECTURE.md`**

- §6.13 (`noTimeScale` list, line 646). The graph note at 650 gains the reward bus, the bed duck, the fresh-start note release and the drone LFO fade.
- §8.8 `MUSIC` line 974: refreshed to the current buses, knee and ducks. It was still showing round-1 values.
- §11, line 1180: round-3 amendments (reward bus, bed duck, `voices.spread`, the pan law at x = 0).

**`js/data.js`**

| Key | Line | Change |
|---|---|---|
| `MUSIC.buses.reward` | 1135 | new |
| `MUSIC.duck.bedOnReward` | 1147 | new |
| vocabulary `bus: 'reward'`, `voices.spread` | 1270 / 1279 | new |
| `AUDIO_CUES.roar` | 1324 | recipe changed |
| `AUDIO_CUES.pass_up` | 1347 | recipe changed |
| `AUDIO_CUES.hup` | 1357 | recipe changed |
| `AUDIO_CUES.sting_rail` | 1374 | recipe changed |

The data line numbers are as of this hand-off; other groups' edits may shift them.

`artifact.html` needs no rebuild for these changes: it loads `js/audio.js` and `js/data.js` by URL.

## needsOtherGroup

1. **Lead (design decisions), no code needed from other groups:**
   - **(a) Stings and flips.** Should J13 stings and the J5 flip also read ≥ 6 dB over the bed? Today they rise +3 to +4 dB (§2.9). I reworded the old GDD sentence, which tied the gun duck to "≥ 6 dB", to the gate pass that AUD-10 actually specifies.
     - Moving them to the reward bus is easy.
     - Each recipe needs a hold / level retune first, because their crest factors are 11–14 dB. Without that they would drive the limiter.
     - I can do it in a follow-up on request.
   - **(b) Roar recipe.** Keep the shipped roar (phone-first: +5.2 dB phone-band, +5.3 dB full-band in the bed), or switch to V6 (+6.4 / +5.2) and accept an isolated phone loss of 8.7 dB against the GDD's 8 dB. V6 means changing the sub layer back to 0.4 in `AUDIO_CUES.roar`.
2. **ui / settings (optional): the fader law.** The sound fader is squared (`faderGain`, audio's code), so sound 50 is −12 dB, while music at its default 80 is only −3.9 dB.
   - At sound 50 every sfx, the pass reward included, sits under the music, before and after this change alike.
   - If the settings screen wants "half sound" to keep the sfx above the music, two options:
     - a gentler fader curve, which I can do in `audio.js`;
     - a lower music default, which belongs to save / ui.
3. **Integrator: nothing to rebuild.** `artifact.html` loads both changed modules by URL.
