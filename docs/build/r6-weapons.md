# Round 6: stored weapons and the FIRE button

Owner playtest item 1: "If I pick up a special gun for 10 seconds I should be able to use it when I want.. a lot of the time the 10 seconds gets wasted."

Status: implemented and verified. Nothing is committed; the release engineer commits.

## What changed for the player

- A weapon pickup (shotgun, minigun, rocket, railgun or laser, from a crate or an item gate) no longer starts on pickup. It goes into a **weapon slot** that holds 2 weapons, first in, first out.
- A round **FIRE** button appears bottom-right inside the safe area. It is 76 design px (at least 64 css px) and holds the next weapon's pictogram inside a ring of that weapon's colour.
- **Ready** (nothing running): the ring is full, a halo pulses (it holds still under reduced motion) and a "FIRE" tag sits under the button. A red "×2" badge shows when two weapons are stored.
- **Tap, Space or gamepad A** starts the head of the FIFO with its full `WEAPONS.*.duration`. The start goes through the existing `startWeapon`, so the J13 edge glow, the sting, the haptic and the top HUD pill all fire as before.
- **Busy** (a weapon is running): the ring drains with that weapon's time left and the pictogram dims. The pictogram is the next stored weapon, or the running one if nothing is stored. A tap is refused with a small head-shake, and the stored weapon waits.
- **Third pickup while the slot is full**: nothing is replaced. It pays `PICKUPS.replaceRefund` (25 c) through `coin:pickup 'refund'`, with the usual coin flight, and the `item:pickup` reports `duplicate: true`.
- **Boss**: stored weapons are kept through the boss intro and the fight, so a player can save a rocket for the boss.
- **Level won**: when `level.phase` turns `'won'`, each unused weapon pays 25 c `'refund'`. This happens before the commit, so it is credited.
- **Level lost** (including every endless run end): the stored weapons are cleared silently. Level ignores refunds once lost (QA LVL-20). Emitting one anyway would fly coins to the HUD that are never credited, so none is emitted.
- **RESTART, QUIT and level start**: `weapons.reset()` drops the stored weapons with no payout.
- **Gear and troops**: unchanged, still automatic.
- **Pickup feedback**: the J12 icon flight of a weapon lands on the FIRE button's pictogram (`ui.powerupIconScreenPos`, so `fx.js` was not touched). The button pops in when it first shows.
- **Hint**: `HINTS.fire` reads "TAP THE GUN BUTTON TO FIRE". It shows once ever, on the first `weapon:stored`, ahead of that weapon's name hint (the action comes first). It is text only, because the hint's touch icon has side arrows that mean "drag". In the L1 trace, `fire` showed at 19.8 s, then "SHOTGUN! …" at 21.3 s.

### The firing rule

I kept the lead's rule: a tap while a weapon runs does nothing, and the stored weapon waits. I rejected two alternatives:

- **Replace on tap**: this throws away the rest of the running weapon, which is exactly what the owner complained about.
- **Queue on tap** (the next weapon auto-starts when the current one ends): this fires the second weapon wherever the zombies happen to be, which puts the waste back.

## Interfaces (documented in ARCHITECTURE §5.1, §6.10, §6.11, §10.1–10.3 and GDD §8, §12, §14)

- New event: `weapon:stored { id, slots }`, emitted by `weapons.storeWeapon` before the pickup's `item:pickup`.
  - `slots` is the stored count after the pickup.
  - It is not emitted for a full slot or when the slot empties; ui reads `storedCount`.
- `weapon:start` remains the activation event.
- `weapons` (new): `storeWeapon(id): boolean`, `requestFire(): boolean`, `storedCount`, `storedId(i)`, `canFire`.
  - `requestFire` only sets a flag. `_stepStored()` consumes it at the top of the next `step()`, so the weapon starts inside the fixed step.
  - `_stepStored()` also polls `ctx.level.phase` for the level-end refund. `weapons` now reads `ctx.level`, and this is documented in its header.
- `startWeapon`: unchanged. Its replace-and-refund branch now serves debug and test callers only.
- `pickups.grantItem`: `'weapon.*'` now goes to `storeWeapon`, with a fallback to `startWeapon` for older weapons modules.
- `data.js` (my keys only):
  - `PICKUPS.weaponSlots: 2`
  - `HINTS.fire`
  - `STRINGS.fire { label, badge, aria, ariaBusy }`
- `level.js`: a `weapon:stored` listener, `_onWeaponStored`, which calls `showHint('fire')`. This is the only change there.
- `index.html` / `artifact.html`: `#btn-fire` markup inside `#hud`. `artifact.html` was rebuilt with `tools/build-artifact.js`; its diff is that one line.
- `css/game.css`:
  - the `#btn-fire` block
  - `#hud > :not(#btn-pause):not(#btn-fire)` and the descendant rule, so only the button itself takes pointers
  - `#hud.fire-on #hint`: the bottom hint pill moves left of the button
  - the prewarm display rule and the reduced-motion static halo
- `ui.js` input handling:
  - FIRE answers on `pointerdown` (primary button only). `preventDefault` there means the button never takes focus, so keyboard steering stays on `#app`.
  - The delegated `click` is swallowed for 0.6 s after a pointer or key activation. A bare click (Enter, assistive tech) fires.
  - No `ui:button` is emitted, because the sting is the feedback.
  - Space fires while `playing` and is not repeated.
  - Gamepad A fires on a rising edge. It is polled only after `gamepadconnected` and only while the button shows; `getGamepads` is the one per-frame allocation and it happens only then, the same as engine's own pad poll.
  - The engine already ignores pointerdowns on `button`, so engine.js is unchanged.
- `ui.js` rendering:
  - The button state is read every frame from getters and the DOM is written only on change. The ring uses the cached `_ringStrings` tables; durations are cached on change because `itemEntry` slices the id.
  - The 128 px pictograms are encoded during the boot prewarm (UI-23), and the button rasters in the HUD prewarm surface.
- Not touched: `audio.js` and `fx.js`. The existing `weapon:start` sting, the J13 glow and the J12 flight now land at the right moments.
- `tools/smoke.js`: the bot presses `#btn-fire` for real.
  - It uses a touch tap on the phone viewport and a mouse click with `--desktop`.
  - It presses when `weapons.canFire` is true and a living zombie or the boss is within 25 m.
  - `report.fire.presses` records `{ t, weapon, near, started }`, where `started` means `weapons.weapon` became that weapon within 0.5 s. A press that did not start its weapon is a check failure.
  - `report.fire.stored` records the `weapon:stored` trail, and each timeline sample now has `stored`.

## Verification (evidence: `E:/Temp/claude/gate-rush-evidence/r6/weapons/`)

| Run | Result |
|---|---|
| `l1-index`: L1, bot, index shell | CLEAN; shotgun stored at 19.8 s, real tap at 19.9 s ("zombie 15 m"), started; 3★, 242 survivors (same as before the change) |
| `artifact-l1`: `--shell artifact` | CLEAN; same press and result |
| `all-sandbox`: `--scenario all --shell sandbox` | CLEAN; ui pass, play, HOME tap → title. `fire.stored` / `pickups` list the shotgun twice: `installProbes` runs once per scenario, so the listeners are attached twice (the existing `pickups` trail already did this) |
| `boss-l5`: `--boss`, rocket + railgun + laser granted | rocket and railgun stored; the laser hit a full slot, so it reported duplicate and paid a refund; rocket fired at "boss 23 m", railgun at "zombie 1 m"; both started. The 5-soldier squad then lost, as expected at C = 5 |
| `boss-win-refund`: `--boss --nobot`, C = 400, 2 weapons stored | both weapons kept through the fight; 2 × 25 c `refund` at `phase=won`, before the results; 3★ |
| `endless`: minigun + laser granted | both pressed and started at 7.1 s and 22.5 s, in FIFO order |
| `desktop-l2`: `--desktop`, minigun | a mouse click on the button started it |
| `vis-390x844`, `vis-360x740`, `vis-844x390` (dpr 3) and `vis-390x844-reduced` | see below |

What the vis runs covered, in every viewport:

- ready → ×2 → busy → denied states
- refund of 25 c on a full slot
- `weapon:start` durations 10 and 8 (full durations)
- **multi-touch**: a steering finger kept steering (`targetX` 0 → 2.1) while a second finger tapped FIRE, and the rocket started
- a drag that starts on the button does not steer (it is a button)
- with 300 soldiers steered hard right, the squad's lower-right edge stays above the button: about 70 px clear at 390×844 and about 35 px at 360×740
- the landscape button is at x 760–824, y 294–359 of 844×390, clear of the squad and the hint
- reduced motion: the ready class shows a static halo

Every run had zero page errors, console errors or warnings; the only warning is the sandbox's expected "Progress won't be saved". Frame stats were unchanged: p95 is about 7.0 ms at 144 Hz, and a long frame appears only while a screenshot is taken.

`check-imports` is OK and `validate-levels` reports 0 errors. I ran `callsites.js`, which regenerates `docs/build/CALLSITES.md`; I reverted that file because the regenerated version would also pick up other teams' in-flight changes.

## Notes for the lead

- **Hint timing**: on L1 the `fire` hint gets the 1.5 s turn because another hint is waiting. That is the existing FTUE queue rule; the pulsing ready halo and the FIRE tag carry the lesson after that. If a busier level drops the hint from the queue, it is not marked done, so it comes back the next time a weapon is stored.
- **Two weapon displays**: the top power-up pill still shows the running weapon (J13/J14 blink, ticktock), and the FIRE ring shows the same timer near the thumb. I kept both on purpose, because the eyes are on the road.
