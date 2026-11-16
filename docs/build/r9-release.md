# Round 9: release 1.5.0 (CHASE and ESCORT levels)

Release 1.5.0 finishes the owner's round-8 request for new level types. 1.4.0 shipped HORDE and NIGHT; this release ships
CHASE and ESCORT, plus four fixes from the owner's 1.4.0 playthrough of 2026-11-16: the gate glow ring that did not go all
the way round, coins kept on a lost run (the owner suggested fewer), the Hulk Twins being soft against a player who only
sweeps, and no feedback on a REPAIR tap during a repair. The night combinations wait for a later release.

## What changed for the player

| Area | 1.5.0 |
|---|---|
| CHASE | L12 (debut), 22, 27, 33, 37, 44, 49, 57 and on. A gate run turns into a pursuit: the horde breaks loose behind the squad and a gap number (metres) runs to the safe zone. The back rows push the horde back in proportion to the squad, surges close the gap. Teal » SPRINT gates and PLANK gates (barricades dropped with DROP); wrecks, narrows and rubble trip a squad that runs into them. No boss: the doors slam shut at the safe zone. A loss reads CAUGHT. |
| ESCORT | L18 (debut), 24, 28, 34, 42, 48, 54 and on. A truck of survivors drives its own lane, changing sides between gates. Climbers grab survivors when their ring fills; only soldiers in the truck's half can shoot them off. PLATE knocks off the fullest climber and armours its slot. A checkpoint halfway adds survivors (+6 on L18–44, +8 from L45) and a plate; then a gauntlet and the safe zone. Stars count delivered survivors. A loss reads TRUCK OVERRUN. |
| Map | L47 stays HORDE and L53 / L58 stay NIGHT while the night combinations wait. A cleared level that now plays CHASE or ESCORT keeps its stars, shows a ring and pays full coins on its first clear as the new type. Legend line 2 shows the four type badges. |
| Coins on a loss | Half of (picked-up coins + consolation); a run with no input at all (no gate decision, no FIRE, under the minimum steering, no mode button that did something) pays nothing. The card says "Half kept +N" or "No input: 0 coins". |
| Gate glow ring | Closes all the way round (in gold at MAX) instead of vanishing on the MAX frame. |
| Hulk Twins (Horde) | Their boss column narrows to 1.25 m. Partial fix: a sweeping player's clears fall from 10 / 14 to 7 / 11 of 32 on L29 / L39 and stay at 20 / 32 on L59; aimers are within 0.4 s of 1.4.0. See known issues. |
| REPAIR | A tap on a section that is already being repaired shows REPAIRING. |
| Railgun | Its NEW card moved to L11 (L12 is now the Chase debut). |

## How it was built

A lean process at the owner's request: one design pass, then four packages, each with one build and one independent check
before a squash merge: P1 shared hooks and the four fixes, P2 CHASE and P3 ESCORT side by side, P4 integration, balance and
an owner preview. 20 agent runs in about 6.5 hours. The package notes written at each merge are under `docs/build/r9/`.
After P4 the main session fixed two leftovers the checks found: STRINGS.gameover lost its retry / shop / home keys to a
comment, and a DROP tap with no charges counted as input for the coin rule.

## Measured

- Hands-off play loses on every chase and escort level up to L60, at the expected shop and at shop rank 10, RETRY
  included (0 clears in 1,152 idle / streak chase runs; escort idle rows 0 clears). Skilled bots clear them.
- CHASE: the design-size squad rests in the 3–8 m amber band for 91–96 % of the chase in the node simulator (64–93 % in
  engine traces), minimum gap 2.1–3.7 m, never caught. 3★ at 0.85 of 1.12 × E_boss.
- ESCORT: 3★ at 0.9 of the total survivors (13 of 14 at L18). A player who guards the truck counts as playing (follow
  windows at each lane change), so their losses build REINFORCEMENTS plates; a hands-off loss does not.
- js/ 3,182,750 B raw / 994,113 B gzip (caps raised to 3,220,000 / 1,005,000 for this release; 1.4.0 was 2,993,185 /
  932,304). Draw budget unchanged. Static tools, validate-levels (0 errors) and smoke --scenario all CLEAN.
- The owner played the preview on a phone (Chase L44, Escort L42): "everything seems great".

## Known issues (for 1.5.1)

- **Hulk Twins vs a sweeping player.** Reach alone cannot fix it: the sweeper's turn points sit next to the twins, so a
  narrower column slows a careful aimer almost as much. Lever B1 (an in-lane shooter feeds a twin only while the lane
  centre is near that twin) is written up in `docs/build/r9/P1-TWINS-DECISION.txt`.
- **Chase L57 3★.** No bot reached 3★ (best 0.995 of the need); its losses start in the run part. May want its own
  3★ fraction or a gentler pd past L57.
- **Escort readability.** With the squad right behind the truck at 360 px width, the squad count label sits over the
  tailgate and partly hides the rear climbers' rings.
- **Chase clarity.** The SURGE! banner (about 1.2 s) can cover the next gate's digits near the decision distance; the
  "+N M" sprint pill briefly overlaps the count label.
- **Field Guide.** For a player past them, the CHASE / ESCORT rows point to the next level of the type rather than the
  ringed ones already behind.
- **Escort pay.** The L18 design-bot clear pays 1.30× its RUN neighbour, exactly at the +30 % limit.
- **Assist path.** Chase barricade charges after counted fails are modelled in the generator but no engine row exercised
  them.
- Small: CAUGHT also titles a chase lost in its run part; the REPAIRING pill uses the red pill style rather than amber;
  check-save (h) prints a misleading PASS line; a follow-window comment says "ends within" where the code accepts "comes
  within"; a few code nits (a misplaced JSDoc in models.js, an unused local in escort.step, a duplicate assignment in
  weapons.js).
- **Waits for later.** Night chase, night escort, night horde; escort rescue gates and spitters. Still listed from 1.4.0:
  the Low-tier squad look.
