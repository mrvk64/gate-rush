# Gate Rush

The zombie gate-runner from the mobile ads, built as the real game. Your squad marches up a ruined highway while the horde marches down. Shoot the gates to push their numbers up, walk through the best one, and grow an army big enough to flatten the boss at the end of every level.

It runs in any modern phone or desktop browser and installs to the home screen like an app. Everything is generated in code: the 3D models, textures, effects and sound. There are no image, model or audio files to download.

This is version 1.2.1.

## What's in the game

- **Gates that answer every bullet.** `+N` gates count up as you shoot them until they hit MAX. Red `−N` gates count toward zero, then flip blue. `x2` gates climb to `x5`. The `÷` ladder climbs from `÷3` to `÷2` to `x1` to `x2`.
- **Five zombie types.** Walkers, zig-zagging runners, lunging crawlers, brutes that keep swinging, and spitters that lob acid.
- **A boss on every level.** Each boss gets an intro, three attack phases with telegraphed attacks and a slow-motion death. There are six archetypes: Hulk, Spitter Queen, Juggernaut, Colossus (shot through its shield), Hulk Twins and Colossus Prime.
- **Specials along the road.** These come from purple gates and crates:
  - Weapons: shotgun, minigun, rocket launcher, railgun and laser.
  - Gear: armor plates, magnet, fire-rate chip and damage booster.
  - Troops: sniper, medic, flamethrower trooper, drone turret and APC.
- **30 campaign levels in six districts.** Level 1 is the ad, played straight. Every five levels the road moves to a new district with its own light, fog, props and weather: Sunset Boulevard (drifting dust), Overcast Highway (rain), Night City (falling ash under neon), Toxic Industrial (spores), Ash Wasteland (embers) and Frozen Outskirts (snow).
- **Endless mode.** It unlocks after level 10. The road is generated as you go, rotates through all six districts, and sends a mini-boss every fifth stretch of road. While a mini-boss is alive, the next gates and waves wait. The horde keeps growing, in numbers more than toughness, until it overruns your squad. How far you get is your score.
- **A shop with permanent upgrades.** Start squad, fire rate, damage, coin multiplier and boss damage, ten ranks each. Your progress is saved on the device.
- **Juice everywhere.** Muzzle flashes, tracers, bloom, screen shake, a slot-machine count ticker, gate pops, coin flights, haptics, synthesized sound effects and a live music track.
- **Automatic quality scaling.** The game drops to a lighter quality tier on slower phones, and Settings has manual quality, reduced motion, high-contrast gates, large text, drag sensitivity and volume.

## Controls

Drag anywhere on the screen to steer, left or right. Your squad fires on its own. On a computer you can also use A/D or the arrow keys, P or Esc to pause, and M to mute.

## Play it on your phone

**Option 1: the claude.ai link.** Open https://claude.ai/artifact/BCGzG6hs8jdLmkwtF12nnu on your phone while signed in to claude.ai. That is the fastest way to play. The link is private until you share it from the page's Share menu.

**Option 2: install it as an app (recommended).** Put the `dist/` folder (or the contents of `gate-rush-dist.zip`) on any free HTTPS static host, then add it to your home screen:

1. Build the folder: `node tools/package.js --check`. This writes `dist/`. `gate-rush-dist.zip` is a ready-made copy.
2. Host it. The simplest way is Netlify Drop: open app.netlify.com/drop in a desktop browser and drag the `dist` folder onto the page. GitHub Pages and Cloudflare Pages also work.
3. Open the site on your phone.
   - **iPhone (Safari):** tap Share, then **Add to Home Screen**.
   - **Android (Chrome):** tap the menu, then **Install app** or **Add to Home screen**.

The installed app opens full screen in portrait, keeps your saves, and works offline after the first launch.

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
node tools/package.js --check
```

Add `?debug=1` to the URL for an FPS and draw-call overlay. `?level=N` jumps straight to a level, and `?quality=low|med|high` forces a quality tier.
