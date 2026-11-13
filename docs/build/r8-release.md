# Round 8: release 1.4.0 (harder campaign, boss enrage, HORDE and NIGHT levels)

Release 1.4.0 answers the owner's round-8 request of 2026-10-28: the game was too easy ("I'm on level 43 and I can leave
the game running and pass the level"), and every level played the same way. The owner chose a Horde type that is "run,
then hold", new types mixed into the campaign, a difficulty where leaving the game running fails from about level 3, and
Chase, Escort and Night as further types. This release ships the harder campaign, HORDE and NIGHT. Chase, Escort and the
night combinations wait for 1.5.0; their slots on the level map already exist and play as RUN, NIGHT or HORDE for now.

## What changed for the player

| Area | 1.4.0 |
|---|---|
| Difficulty | The campaign keeps rising with the real level number past L30 (it used to freeze). Bosses have an HP floor when the squad arrives under the curve, so a squad that walked itself there loses. Three stars need 0.80 / 0.90 / 0.95 of the expected squad at the boss (L1–5 / L6–9 / L10+). |
| Boss enrage | A clock beside the boss bar: 20 s, 26 s on district finales. When it runs out the boss is ENRAGED and eats more soldiers every second. ENRAGED means only that; phase 3 reads PHASE 3. |
| HORDE | First on L4, then L9, 13, 19, 23, 29, 32, 39, 43, 47, 52, 59 and on. A short gate run, then the squad holds a four-section barricade against three surges and a boss. Drag to sweep the fire lane, hold still 0.8 s to focus it (50 % → 100 % of the soldiers in the lane), REPAIR spends a kit on a section. Supply crates, an airstrike and stored weapons help; stored weapons add to the rifles and never lower output. The crowd simulates 2,048 + 256 units the same way on every quality tier; drawn caps are 2,048 / 1,400 / 800 / 500 (High / Medium / Low / software). After two failed Hordes the help is extra repair kits, never soldiers. |
| NIGHT | First on L7; L45 is the first BLACKOUT finale (Night City). The generated level is identical to its day version; only the rendering changes: flashlights, eye sprites on heads that dim with distance (runner eyes never dim), flares from crates. Variants FULL / LITE / MIN by tier. |
| Level grid | Type badges (planks, crescent), a ring on cleared levels that now play a new type, and a one-time briefing card the first time a type is met. A re-typed level keeps its stars and pays full coins on its first clear as the new type. |
| First meeting | The first Horde a player meets is eased to 85 % threat, per surge, and only while the player is acting. |
| Save | Schema v2, additive and keyed by level type; a 1.3.0 save migrates, and a 1.3.0 build still reads a v2 save. |
| Field Guide | New sections LEVEL TYPES, THE HOLD and NIGHT. |
| Update pill | Reads "Update — tap to reload" and fits a 320 px screen. |

## How it was built

Fifteen packages in parallel git worktrees on an integration branch, each checked by an independent verifier before a
squash merge: foundation and determinism (P0), hooks (P2), difficulty core and its measurement (P1, P1M), the crowd
engine (P4), the Horde generator and its node simulator (P3), level types and save v2 (P1T), night (P5), the hold
runtime (P6), the types UI and HUD kit (P7), integration (P8), balance (P9) and a final wrap-up fix round (V1F). The
package notes written at each merge are kept under `docs/build/r8/`.

A planned five-lens adversarial pass (V1) was stopped early at the owner's request: it had become slow and costly and
was finding polish only. Its recorded findings were triaged; four player-visible ones were fixed in V1F and the rest are
listed below.

## Measured

- Hands-off play (no input, real retry sequences with assist): 0 clears in 1,224 attempts on L10–60 at the expected shop.
  L5 0/24. L3 3/24 single attempts and 0/12 as a real retry sequence. A steering bot and a human-like bot still clear
  (L3 8/8 and 8/8, L5 5/8 and 8/8).
- Horde: every surge peak on High shows at least 1,035 zombies within 40 m (96 peaks); swipe-only play clears L4 0/24.
- Download: `js/` is 2,993,185 B raw and 932,304 B gzip (1.3.0: 2,505,012 / 755,743). Boot to the title at 4× CPU is
  1.01–1.06× of 1.3.0.
- Owner's phone (Galaxy S24 Ultra, Chrome 156, over USB): the release candidate holds 60 fps at High with 1,843 zombies
  within 40 m, on L43 Horde, L7 night and the L45 BLACKOUT finale; a three-minute hold with about 1,800 zombies did not
  drift. Chrome ran the page at 60 Hz. The `?debug=1` overlay alone costs about a quarter of the frame rate there, so
  phone performance is never measured with it on.
- Update flow (1.3.0 → 1.4.0 on one origin): the pill appears once, the save survives, offline works after one online
  launch. Software GL keeps real-time speed.
- The RUN reference digest for L1–30 after balance: `b2127e66…e68832`; script digest `e9f63587…51046`.

## Decisions and defaults taken

The owner did not answer the preview questions, so the defaults ship:

- FOCUS FIRE stays on; REPAIR stays at the bottom left with the left-handed option in SETTINGS; the hold is lost 3 s
  after all four sections are down; no "Bright" night setting.
- Re-typed levels that a maxed shop can still clear hands-off keep their ring and full first-clear pay.
- L5 takes the boss floor (`BOSSES.ttkBand.under` from L3, `tAt { 3: 9.5, 5: 10.5 }`).
- Download caps were raised to 3,000,000 B raw and 945,000 B gzip (the Horde came in larger than planned).
- On machines without a GPU, Auto may run a hold at up to 1.4× the RUN frame time while the game clock stays real-time.
- Horde pays more than its RUN neighbours on L4 (+59 to +77 %) and L9 (+21 to +28 %); accepted.

## Known issues, for 1.4.1

- A mindless back-and-forth wipe clears the Hulk Twins holds too often (L39 14/32, L59 20/32, against 2/32 on other
  holds): two bosses 2.2 m either side of centre can be hit from about 88 % of the wall. It needs a small code change in
  `hold.js` `_bossColumn`; raising the Twins' HP would punish aiming players instead.
- A lost attempt with no input still keeps its coins (127 on L4, about 1,000 on L43); endless left running pays about
  13 coins a second at a maxed shop.
- With a maxed shop, replaying L3–L8 hands-off clears within 3–7 attempts (L3 13/24, L5 8/24 single attempts).
- Low quality draws a 320-soldier squad as a 40-soldier block with stragglers.
- REPAIR gives no feedback during its 1.5 s cool-down. In a landscape hold the lesson pill can cover the squad count,
  and section labels can touch at 585 × 340.
- The six THE HOLD Field Guide rows without an icon of their own share one badge. The BLACKOUT tile badge is not in the
  LEVELS legend. The enrage lesson is long (4–5 lines on small screens).
- At night, brute and spitter HP bars glow beyond the flashlight on High and Medium.
- A level start waiting behind the tile spinner goes ahead during a WebGL context loss and plays undrawn until the
  context returns.
- `tools/smoke.js --matrix` can score a cell from an old report and has no timeout.
- Nothing was measured on a mid-range or old phone.

## Waits for 1.5.0

CHASE and ESCORT with their generators, the night combinations (night Horde, night Chase, night Escort), endless night
chunks and the band-lit crowd at night.
