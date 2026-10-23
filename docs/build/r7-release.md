# Round 7: release 1.3.0 (the first outside playtest)

Release 1.3.0 answers a 31-issue playtest report on v1.2.1, sent 2026-10-20. The tester ("Gamer") played on a Linux box
without a GPU, in a ~1024x594 window. The round ran in four stages, with every finding re-checked in real Chrome:

1. Seven investigators root-caused every report line, and a critic checked their coverage.
2. Four work packages were built in parallel git worktrees:
   - A: engine, rendering and input
   - B: balance
   - C: gates, effects and audio
   - D: UI, done in three steps (layout, then flow/coins/shop, then teaching/codex)
3. The packages were integrated into one candidate.
4. Adversarial verifiers covered each issue cluster, a HUD/regression auditor compared against 1.2.2, and a report
   walker went through the report line by line. Four fix-and-verify rounds followed, plus a final blocker pass.

## What the report found, and what changed

| Report item | Root cause | 1.3.0 |
|---|---|---|
| #6 #10 slow motion, game speed tied to fps | The clamp of 0.05 s per frame made game time = fps × 0.05 below 20 fps. On software GL that meant 0.2–0.48× speed. | The dt clamp follows the sustained frame time: clamp(1.25 × EMA, 0.05, 0.2) s, with up to 12 sub-steps. The game runs in real time down to 5 fps. |
| #8 Auto should pick Low | Software GL matched no rule. It kept 4× canvas AA and an auto ceiling of Med. The auto-scaler discarded every frame over 250 ms. | Software GL is detected by renderer string and by a major-performance-caveat probe. It gets Low with no AA and a Low ceiling. Render-scale rungs 1 → 0.85 → 0.7 → 0.6 → 0.5 run on software GL only. The hitch filter is relative and the scaler window is time-based. |
| #1 #16 #24 results "freeze", NEXT needed two clicks | Results, shop and levels redrew the full scene every frame, so on software GL a click waited 1–6 s. Clicks queued meanwhile landed on the next screen. A context loss that was never restored left a modal overlay up. | Menus stop redrawing on slow devices. The screen switch happens inside the click task, with a 250 ms timer fallback. A stale-click guard drops presses aimed at a replaced screen, and the HUD arms 1 s into a run. Level generation runs in timer slices behind a spinner. After 12 s of context loss, a "Graphics stopped working… reload" box appears. `__gateRushDiag()` dumps a diagnostics ring buffer. |
| #18 #24 #25 coin wobble, "+0", 1K | A purchase was animated twice from a stale header value: 737 → 342 → 448 → 327 are frames of that curve. The count-up ran on the clamped clock. | One wallet model drives every coin pill. The results count runs in real time and drives the header ("Earned +N"). Coins show as full numbers with separators. |
| #15 #22 #29 stars | Stars depend on a per-level target (0.5 / 0.8 × E_boss, +8 %/level) that was never shown. The L11/L12 data points cannot come from the code. | The results line shows the targets ("172 survivors · ★★★ at 176"), and so does the title caption. Both use one helper, `starNeed`. |
| #11 boss slam, tutorial | The slam ring had a 3 m radius against ±2.1 m of steering, so from the centre it could not be escaped. There was no wind-up cue and no lesson. | The ring is 1.8 m, escapable from anywhere. Each attack plays a wind-up sound and its telegraph draws over the formation. A first-time slow-mo lesson names each attack. The name card shows a tagline and the boss bar shows the phase. |
| #17 L9 spike, S5 L11 | Red lanes were sized on the designer's E(z), so a squad below the curve met a −A as large as itself. Waves and bosses were solved at E. Brute swings took 3 soldiers each. | Campaign red lanes are capped at 0.5 / 0.4 × the live count, keeping the authored flip value. The low side is eased (max(0.35, C/E)^0.8). Boss HP scales down to ×0.6, inside a fight-length band. Brute kills scale with squad size. |
| #30 Colossus | The shield broke in ~1 s and the boss attacked once every 6 s. | Shield 120 hits (Prime 160), attack cycle 4.5 / 3 s, slam 5 % of the squad, 12 / 16 s minimum fight. |
| #20 #21 gates and keys | The lane committed on the lagging squad centre. Keys ramped to 9 m/s and drifted on release. | The lane follows `input.targetX`. Ring gauges and a reach projection appear on +/− gates. Keys move at 12 m/s with no ramp; the last key pressed wins, and a tap latch catches short taps. |
| #2 #14 #13 layout, zoom, fullscreen | The levels grid shrank to its content (312 px), so the wheel missed it. There was no 8-column rule for 594 px windows. Every resize re-allocated the canvas. The letterbox stayed up for the whole fight. | Stretch plus 8/6/4 columns, wheel and keyboard forwarders, safe-scroll screens, and two-column shop/settings up to 720 px tall. No same-size re-allocation, and a synchronous draw after each resize. The letterbox retracts at boss:fight. Fullscreen is in Settings and on F. |
| #3 #4 #19 #27 #28 S5 acid teaching | Captions were short and far from the action. Bites showed only as "−1". Items were unexplained before the choice. The ÷ hint promised an unreachable ×2. The acid decal carried a centre "+". | Longer, toned, held hints with a pulsing subject gate and first-time slow-mo. Bite vignette and merged loss numbers. NEW cards and a FIELD GUIDE (49 entries, numbers from data, checked by tools/check-codex.js). The ÷ hint reads "÷2 → ×1 (NO LOSS)". The acid decal is a hazard "×". |
| #12 #23 #31 skull and district banner | Milestones mean district finale, but were labelled "Boss level". The banner was one small pill at every start, missed at low fps and suppressed on retries. | Legend "DISTRICT FINALE · TOUGHER BOSS". A NEW DISTRICT card on the first level and a "NAME · k/5" tag elsewhere. |
| #5 #26 shop | "+1 run" was unlabelled. Prices grew 40 % per rank. | "~N runs away" with a legend, the price after next, a "what it buys" line, and growth 1.35. |
| S2 idle L1 win | Only a hidden tab paused the game. | The game pauses on window blur once the player has given input. Lessons are marked read only after trusted input within 20 s. |
| #7 ReadPixels warnings | Chrome's software compositor reads each WebGL frame back. | No game readback exists. Documented in ARCH §9. |

## Verification

The final candidate is r7/INT fc17f83. The final pass ran one browser at a time.

- **Render scale and recovery.**
  - The render scale stays at 1 on a CPU-bound hardware GPU (cpusession seeds 777–780, 300 s each).
  - Recovery after a 10× CPU throttle reached Med in 19.9 s and High in 40.4 s, against 19.9 s and 40.3 s on 1.2.2.
- **Software GL.** At 1024x594 it runs at 22–26 fps with a clock ratio of 0.99–1.00; 1.2.2 ran at 8.5 fps with a ratio
  of 0.43. A 400 ms hitch is still clamped to 50 ms.
- **Test battery: all CLEAN.**
  - check-imports
  - check-codex
  - validate-levels: identical to 1.2.2 apart from timings
  - package --check
  - smoke `--scenario all` on phone, desktop, the artifact shell and the sandbox shell
  - smoke `--endless`, plus L5, L15 and L20 boss runs
- **Real GPU.** Tier High, 144 fps, 58 programs, draw calls within the ARCH §9.1 budgets.

## Accepted residuals (documented in GDD)

- On software GL, Auto may render at scale 0.5 with no AA. Real-time speed is worth the softer look.
- A few pixels of extra shop height in Large-text landscape and with fallback fonts (GDD §9.2).
- A never-steering player usually loses the canonical L11 on the first attempt and clears the retry. A perfect dodger
  pays little at the Colossus (GDD §10).
- A focused but unattended window still plays on. Lessons shown to an idle screen come back.
