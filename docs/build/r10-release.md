# Round 10: release 1.6.0 (1.6 Challenge)

The owner plays at about level 45 with every shop line at rank 10, reads gates, dodges spit and found the game too easy.
Rank 10 is the design curve past L30, so normal mode stays as it is. This release adds HARD mode for a maxed player and
the small fixes from the owner's 1.5.0 playthrough. The trade-off gates planned for this release moved to 1.7 (see below).

## What changed for the player

| Area | 1.6.0 |
|---|---|
| HARD mode | Unlocks when L30 is cleared (a one-time HARD UNLOCKED card). Open on every cleared level from L10 and on the frontier; not L1-9, not endless. Entry: PLAY HARD on the title (the frontier) and the HARD toggle on LEVELS. Always no reinforcements and no assist, plus at least one of four modifiers: GLASS (telegraphed hazards hit harder, ×1.6 for boss attacks and acid, ×1.5 chase claws, ×1.25 faster escort grab rings; the other warnings unchanged; the sheet's GLASS line names the level's figure), TIGHT (`+` gates fill to 3× instead of 4×, `x` steps cost ×1.15), THICK (zombie HP ×1.40 at L30 falling to ×1.10 at L60; never more bodies) and FUSE (the boss enrages 3 s sooner; not on chase / escort). Same road and seed as normal. |
| HARD pay and marks | Every coin of the run × (1.15 + each modifier): GLASS +0.30, TIGHT +0.25, THICK +0.30, FUSE +0.20, all four ×2.20 (×2.00 on chase / escort). A replay pays ×0.6 unless it beats the level's best mark. The tile shows a bone skull with the number of modifiers; all of them plus 3 stars is a gold IRON skull. A HARD clear of the frontier is its normal clear too. Game over on HARD offers RETRY and NORMAL. |
| Hulk Twins (Horde) | An in-lane shooter feeds a Twin only within 0.8 m of it, so a sweeping player clears fewer Twins holds (L29 / L39 / L59: 7 / 11 / 20 of 32 in 1.5.0, now 5 / 5 / 11). Aimers are unchanged. |
| HORDE holds | Push harder from L31 (rho ceiling 0.85 at L31 rising to 1.0 at L60). |
| Escort | Each survivor dragged off shows a red "-1" at its seat, the count flashes red, a LOST tally sits under the progress bar, the checkpoint reads "6 → 12 (+6)" and the results say "Delivered 12 of 14 · lost 2". The squad count no longer sits on the truck's tailgate on a narrow phone. |
| Chase | SURGE! is a small solid pill at the top while a gate is coming up, so it never covers gate numbers. The 3-star mark on L57 (0.80) and from L62 (0.73) is set from what a skilled run reaches. |

## Not in 1.6.0: the trade-off gates (moved to 1.7)

The plan had two new gates whose right choice depends on the squad: a capped multiplier ("x3 MAX 600") and a skull gate that
weakens the boss. They were built (branch `r10/P2`, kept, never merged) but failed their model gate: a perfect gate reader
still reaches the boss with 1.39-1.54× the squad it needs on L20-50, no allowed lever brought it into the target band (best
55 % of levels against the 80 % needed), and a capped pair sized at the reader's count lifts every weaker line, the
never-steering one included, to about the cap. The owner chose on 2026-11-17 to ship the fixes and HARD now; 1.7 will size the
trade-off differently, with the maths proven in the node simulator before anything is built.

## How it was built

One design pass (PLAN-1.6.0 revision 2), then packages with one build and one independent check each before a squash merge
onto `r10-160`: P1 small items (035217a), P3 HARD (ad1ba2b), P4 integration, balance confirmation and the owner preview. After
P4 the main session fixed one leftover the check found: the HARD UNLOCKED card's button read BACK, because the generic BACK
relabel in ui.js rewrote it; it now keeps GOT IT. A final independent release check then
corrected a few doc slips and made the sheet's GLASS line name the level's own figure (claws ×1.5 on chase, grab rings ×1.25
on escort). The package notes are under `docs/build/r10/`. Commit ids and branch names here (r10-160, r10/P1, r10/P2, r10/P3)
are the local build branches; only the squashed release commit is published.

**Owner decision at release (2026-11-17):** GLASS and FUSE ship as built. For a perfect reader at L45 rank 10 each costs close
to nothing on its own (GLASS hurts a player who gets hit: a careless bot's clears fall 7 → 4 of 8; FUSE bites in combinations
and from L60), so the plan's "each modifier alone costs at least 5 %" rule is waived for both. A FUSE that bites alone at L45 is
a 1.7 design question.

## Measured

- **HARD off plays exactly as before.** The RUN digest (384 rows, `docs/build/r10/digest-160.json`) equals the P1 merge and the
  P3 check. Against 1.5.0 only 35 HORDE rows differ (the Twins lever and the stronger holds); L1-15, RUN, NIGHT, CHASE, ESCORT,
  endless and chunk scripts are identical.
- **HARD, all four modifiers, rank 10, 8 seeds, a perfect reader that dodges every warning:** L30 3/8, L45 4/8, L46 6/8, L60
  3/8 clears; the same reader without dodging 0/24. Chase L44 2/4, escort L42 5/8.
- **Single modifiers at L45** (survivors lost against the same seed on normal, perfect reader): TIGHT 21 %, THICK 11 %, GLASS
  0.2 %, FUSE 0 %.
- **Hands-off still loses.** Idle, idle-left and idle-right bots with 6-try HARD retry streaks: 0 clears on L10 / L20 / L30 /
  L45 / L46 / L60 (L10 / L20 with TIGHT, FUSE and all four), escort L42 and chase L44; assist 0 on every row.
- **Tier parity.** High and Low play identical rows with HARD on.
- **Old saves.** The owner's 1.5.0 save (L1-44 cleared) loads with HARD open on L10-44 and L45 (any save with L30 cleared
  gets HARD on its cleared levels from L10 and its frontier), and a 1.5.0 build keeps a 1.6.0 save's HARD records
  (tools/check-save.js H-a..H-g). Save format stays v2.
- js/ 3,196,874 B raw / 999,263 B gzip (caps 3,220,000 / 1,005,000, unchanged; the allowed raise was not needed). Static tools,
  smoke --scenario all and the HARD smoke cells CLEAN.

## Known issues

For 1.7 (design work, not a retune):
- **Trade-off gates.** See above; the lever study is in the round-10 evidence (P2 levers.txt).
- **FUSE alone.** Near free at L30 / L45 for every bot at 3, 6 and 9 s; bites only at L60 and in combinations (all modifiers
  against all but FUSE: L45 survivors 583 → 239). Needs a different kind of modifier if it should bite alone.
- **HORDE hold cost.** Median 6 % of the squad at rank 10 against a 10-15 % target; the next lever is the hold boss or breach
  pressure, not rho.
- **Hulk Twins vs a sweeper.** 5 / 32 on L39 and 11 / 32 on L59 against a target of at most 4; a wider lever and a solo enrage
  made it worse.

For 1.6.1 (small):
- **Early chases at rank 10.** L12 / 22 / 27 are harder at rank 10 than at the expected shop (44 / 60 clears against 59 / 60).
  Fix: CHASE_GEN.countComp 0; it re-repairs those scripts, so it needs a digest re-record and a hands-off re-check.
- **HARD frontier L46.** The perfect reader clears 6 / 8, one over the 3-5 band (pooled with L30 / L45 / L60: 50 %, inside
  40-65 %). Watch the owner's feedback before touching THICK.
- **HARD extras cut for size.** No "HARD n · IRON k" counter on LEVELS and no Field Guide row for HARD (the sheet and the card
  explain it). The sheet's chip copy in index.html repeats 1.6× / 3× / 3 s from data.js HARD: change both together.
- **Chase 3-star fractions** at L57 / L62 are per-level values rather than a gameplay fix; L49 keeps 0.85.
- **Escort results line** at 360 px wraps to two lines; each number stays with its word.
- Software GL plays L30 seed 1030 one bite apart from hardware, with HARD off too (pre-existing, not HARD's).
