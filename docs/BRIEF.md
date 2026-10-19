# GATE RUSH — Product Brief (source of truth for the design phase)

## What we are building
A polished, mobile-first 3D web game that IS the game shown in those mobile ads (the "fake ad" zombie gate-runner):
a squad of soldiers marches up a road, zombies march DOWN the screen toward them, the squad auto-fires upward,
numbered gates ("+17", "x2", "-8", "÷2") slide toward the player, bullets that hit a gate push its number UP, and
walking through a gate applies it to the squad (e.g. +17 → 17 more soldiers). Along the way the squad picks up special
guns, gear and troops. Boss at the end of each level. Think of the ad gameplay of "Last War: Survival" / "Mob Control" /
"Count Masters" style runners, but as a complete, real, satisfying game.

Working title: **Gate Rush**. (Original brand; do not use any real game's name or assets.)

## Platform & delivery (hard constraints)
- Portrait phone first (also works on desktop with mouse/keyboard). Touch: drag anywhere left/right to steer the squad.
- Pure web: HTML + CSS + ES-module JavaScript. Three.js r170 (pinned `three@0.170.0`) loaded from
  `https://cdn.jsdelivr.net/npm/three@0.170.0/...` via an import map (`three` and `three/addons/`).
  Allowed script hosts ONLY: cdnjs.cloudflare.com, cdn.jsdelivr.net/npm/, unpkg.com. Fonts only from fonts.googleapis.com.
- NO external asset files (no .glb, .png textures, .mp3). Every model is procedural geometry; every texture is
  generated on a canvas at runtime; every sound is synthesized with WebAudio. Everything must be self-contained.
- Must run inside a sandboxed iframe (the claude.ai artifact viewer): no service worker there, fullscreen may be refused,
  `alert/confirm/prompt` do nothing, localStorage may throw (wrap every access). It must ALSO run as a standalone PWA
  from a local folder (manifest + service worker + icons) — the same code, two thin HTML shells.
- Performance target: 60 fps on a mid-range 2021 Android phone; auto quality scaling (device pixel ratio cap,
  shadow map size, bloom on/off, particle counts). Never allocate per-frame garbage in hot loops (object pools, reused vectors).
- Save data (coins, upgrades, unlocks, level reached, settings) persists in localStorage (guarded).

## Core gameplay (must-haves)
1. **Road & camera**: endless scrolling road segment system; camera behind/above the squad looking toward the horizon with fog.
2. **Squad**: starts with N soldiers in a tight formation; count shown as a big number above the squad. Soldiers auto-fire
   forward; fire rate and damage scale with upgrades; the formation re-flows as the count changes (grow/shrink animations).
3. **Gates**: appear in pairs (left/right halves of the road) and sometimes singles/triples. Types: `+N`, `xN`, `-N`, `÷N`.
   Positive gates are blue/green, negative gates are red. Each bullet that hits a gate raises its value (the "shoot the sign
   and the number goes up" mechanic). A red gate shot enough becomes 0 then positive (and recolors). Passing through applies the
   value to the soldier count. Clear text, big and readable on a phone. Gates slide toward the player at road speed.
4. **Zombies**: walkers, runners, crawlers, brutes, spitters; HP bars; hit-flash; death with particles. They march toward the
   squad; contact kills soldiers (one per hit, brutes more). Waves/hordes scripted per level segment; boss at level end with
   a big HP bar, phases and a satisfying death.
5. **Specials picked up along the way** (via special gates/crates): weapons (shotgun, minigun, laser, rocket launcher, railgun —
   timed power-ups that change the whole squad's fire), gear (armor plates = soldiers survive one bite, fire-rate chip, damage
   booster, magnet for coins), troops (hero sniper, flamethrower trooper, drone turret, APC that absorbs hits, medic that
   regrows soldiers over time).
6. **Economy & meta**: coins earned per kill/gate/level; shop with permanent upgrades (start squad size, fire rate, damage,
   coin multiplier, boss damage); level select/progression with increasing difficulty; results screen (stars, coins, best).
7. **Game feel ("juice")**: muzzle flashes, tracers, hit sparks, blood puffs, floating damage numbers, gate number pop
   animation on every hit, squad-count ticker animation, screen shake on big hits, slow-mo + flash on boss kill, bloom glow
   on gates/lasers/tracers, haptics (navigator.vibrate guarded), satisfying synthesized sound design + music loop.
8. **UI**: title screen, HUD (soldier count, level progress bar with boss marker, coins, active power-up timers), pause,
   settings (sound, music, quality, haptics), shop, level complete / game over, tutorial hints on first run.

## Visual direction
High-quality stylized low-poly (think polished mobile 3D, NOT programmer-art): PBR materials via MeshStandardMaterial,
directional sun with soft shadows, hemisphere fill, fog to horizon, bloom post-processing, color-graded warm/cool palette
(sunset apocalypse: orange sky band, teal shadows, red/blue gate glow). Environment props: cracked asphalt road with lane
paint, barricades, wrecked cars, sandbags, ruined buildings, dead trees, smoke columns, dust motes. Characters: readable
silhouettes (soldiers: olive uniforms, helmets, rifles; zombies: green/grey skin, torn clothes, hunched walk; brute: huge;
boss: unique). Simple procedural animation (walk cycles via bone-less limb swing, recoil, death topple).

## Non-goals
No multiplayer, no server, no ads, no IAP. No external art pipeline.
