# Gate Rush

The zombie gate-runner from the mobile ads, built as the real game. Your squad marches up a ruined highway while the horde marches down. Shoot the gates to push their numbers up, walk through the best one, and grow an army big enough to flatten the boss at the end of every level.

It runs in any modern phone or desktop browser and installs to the home screen like an app. Everything is generated in code: the 3D models, textures, effects and sound. There are no image, model or audio files to download.

This is version 1.3.0.

## What's in the game

- **Gates that answer every bullet.** `+N` gates count up as you shoot them until they hit MAX. Red `−N` gates count toward zero, then flip blue, and a pulsing blue ring on a gate you are shooting means it will flip before you reach it. `x2` gates climb to `x5`. The `÷` ladder climbs from `÷3` to `÷2` up to a harmless `x1`. Your lane counts from the moment you steer for it, so a late dodge holds.
- **Five zombie types.** Walkers, zig-zagging runners, lunging crawlers, brutes that keep swinging, and spitters that lob acid.
- **A boss on every level.** Each boss gets an intro, three attack phases with telegraphed attacks and a slow-motion death. Every attack is heard as it winds up, its warning mark stays visible over your squad, and the first time you meet an attack, time slows while a one-line lesson names it. There are six archetypes: Hulk, Spitter Queen, Juggernaut, Colossus (shot through its shield), Hulk Twins and Colossus Prime. The skull levels (5, 10, 15 …) are district finales with a tougher boss.
- **Specials along the road.** These come from purple gates and crates, and each gold diamond on the progress bar is one coming up. The first time you meet one, a NEW card says what it does:
  - Weapons: shotgun, minigun, rocket launcher, railgun and laser.
  - Gear: armor plates, magnet, fire-rate chip and damage booster.
  - Troops: sniper, medic, flamethrower trooper, drone turret and APC.
- **Weapons you fire when you choose.** A picked-up weapon is stored, not started. Up to two wait in the slot behind the round FIRE button at the bottom right, and each one runs its full time from the moment you fire it. A third pickup while the slot is full pays 25 coins, and so does each weapon still unused when you win a level. Save a rocket for the boss if you like.
- **A Field Guide.** The "?" on the title and in the pause panel opens a guide to every control, gate, special, zombie and boss you have met, with the real numbers, and marks what is new.
- **30 campaign levels in six districts.** Level 1 is the ad, played straight. Every five levels the road moves to a new district with its own light, fog, props and weather: Sunset Boulevard (drifting dust), Overcast Highway (rain), Night City (falling ash under neon), Toxic Industrial (spores), Ash Wasteland (embers) and Frozen Outskirts (snow).
- **Endless mode.** It unlocks after level 10. The road is generated as you go, rotates through all six districts, and sends a mini-boss every fifth stretch of road. While a mini-boss is alive, the next gates and waves wait. The horde keeps growing, in numbers more than toughness, until it overruns your squad. How far you get is your score.
- **A shop with permanent upgrades.** Start squad, fire rate, damage, coin multiplier and boss damage, ten ranks each. Each card says what a rank buys, the price of the rank after it, and how many runs away an upgrade is. The results screen shows what you earned and how many survivors each star needs. Your progress is saved on the device.
- **Juice everywhere.** Muzzle flashes, tracers, bloom, screen shake, a slot-machine count ticker, gate pops, coin flights, haptics, synthesized sound effects and a live music track.
- **Automatic quality scaling.** On Auto (the default) the game drops to a lighter quality tier on slower phones, and on a computer with no graphics chip it also renders at a lower resolution, so Auto is the fastest choice there; a manual Low keeps the full resolution. A Low saved by an earlier version on such a computer becomes Auto once. It runs at full speed down to 5 frames per second instead of slowing down. Settings has manual quality, fullscreen, reduced motion, high-contrast gates, large text, drag sensitivity and volume.

## Controls

Drag anywhere on the screen to steer, left or right. Your squad fires on its own. To use a stored weapon, tap the FIRE button at the bottom right (you can keep steering with another finger), or press Space on a computer.

On a computer you can also steer with A/D or the arrow keys, which move the squad as fast as a drag. P or Esc pauses, M mutes and F toggles fullscreen. The pause panel lists these keys. The game pauses by itself when you switch to another window during a run. With a gamepad, the left stick steers, A fires and Start pauses.

## Reporting a problem

If the game freezes or does something odd, open the browser console (F12 on a computer) and type `__gateRushDiag()`. It prints the game's state, quality and graphics details and its last 64 events: screens shown, taps and their targets, long frame gaps and errors. Copy that text into your report.

## Play it on your phone

**Option 1: install it as an app (recommended).** The game is live at **https://mrvk64.github.io/gate-rush/**. Open that address on your phone, then add it to your home screen:

- **iPhone (Safari):** tap Share, then **Add to Home Screen**.
- **Android (Chrome):** tap the menu, then **Install app** or **Add to Home screen**.

The installed app opens full screen in portrait, keeps your saves, and works offline after the first launch.

**Option 2: the claude.ai link.** Open https://claude.ai/artifact/BCGzG6hs8jdLmkwtF12nnu while signed in to claude.ai. The link is private until you share it from the page's Share menu.

**Releasing an update.** The site is GitHub Pages, deployed by `.github/workflows/pages.yml` from the `dist/` folder on every push to `main`:

1. Make the change, then run the checks: `node tools/smoke.js --scenario all` and `node tools/validate-levels.js`.
2. Bump `VERSION` in `sw.js` (and the version in `js/main.js` and `package.json`), then run `node tools/package.js --check`. The packager refuses a changed build under an unchanged `VERSION`, so installed phones always pick up the update.
3. Commit, including `dist/`, and push. The site updates about a minute later; installed apps show an "Update ready" pill and switch on the next launch.

The `dist/` folder also works on any other HTTPS static host, such as Netlify or Cloudflare Pages.

**Option 3: your own Wi-Fi.** On your computer, run `node tools/serve.js 8787` in this folder. Then open `http://<your-computer's-IP>:8787` on a phone on the same Wi-Fi. This plays fine but cannot be installed, because installing needs HTTPS.

## Project layout

| Path | What it is |
|---|---|
| `index.html` | The app page: PWA shell, import map and the full UI markup |
| `artifact.html` | The same game without the page wrapper, for embedding (generated) |
| `js/` | 22 ES modules: engine, rendering, models, gameplay systems, UI, audio, save and level generation |
| `css/game.css` | All UI styling |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and install metadata |
| `docs/GDD.md` | Game design document: every rule and number |
| `docs/ARCHITECTURE.md` | Module contracts and conventions |
| `tools/` | Dev server, packager, icon generator, level validator, headless-Chrome smoke test and static checkers |

Three.js r170 loads from the jsDelivr CDN through the import map, and the fonts come from Google Fonts. Nothing else is fetched from the network.

## Developer commands

```bash
node tools/serve.js 8787
```

```bash
node tools/smoke.js --scenario all
```

```bash
node tools/validate-levels.js
```

```bash
node tools/check-imports.js
```

```bash
node tools/check-codex.js
```

```bash
node tools/package.js --check
```

`check-imports` checks the module graph and banned calls, `check-codex` checks that the Field Guide and the lessons quote the current numbers from the data tables, and `tools/smoke.js` takes `--gpu sw` (software rendering, like a computer with no graphics chip) and `--viewport WxH`.

Add `?debug=1` to the URL for an FPS and draw-call overlay that also shows the newest diagnostics lines. `?level=N` jumps straight to a level, and `?quality=low|med|high` forces a quality tier.
