# Round 6: procedural textures go blank after a long background (owner's bug 3)

Owner: render core (js/render.js, TextureFactory). Files changed: `js/render.js` (TextureFactory and two lines in
RenderSystem), `docs/ARCHITECTURE.md` (§6.3 RenderSystem.rebuild and the TextureFactory interface, the fonts note,
§9.5, §9.6). Nothing else changed: no changes to gates.js, fx.js, materials.js, fxmaterials.js, environment.js or data.js.
Evidence: `E:/Temp/claude/gate-rush-evidence/r6/textures/` (harness scripts, report.json files, PNGs).

## 1. Report

The owner paused the game, turned the phone off, and came back 2 h later. Every digit and glyph was gone: gate values,
the MAX text and the count-plate digits. The panels, frames, chevrons, the gold MAX pill and the count plate were still
drawn. Closing the app fully fixed it.

## 2. Diagnosis (verified, not assumed)

**What was actually lost: every procedural texture, not just the atlas.** Look again at the owner's screenshot. The road
has no centre dashes and no edge lines, and the building facades have no windows. The road texture was blank as well,
but it is dark asphalt on a black base, so nobody noticed. All ten TextureFactory canvases were affected: road,
digitAtlas, glow, particle, dust, smoke, windows, facade, muzzle and icons. The digits were simply the most visible
loss. DOM HUD icons and pills are data / blob URLs, so they were not affected.

**Mechanism, reproduced end to end in headless Chrome on 1.2.1 code** (`old-crash/`, harness `repro.mjs --steps gpucrash --noread`):

1. CDP `Browser.crashGpuProcess` stands in for Android reclaiming the GPU process during a long sleep.
2. Chrome GPU-backs these 2D canvases by default, even the 32×32 dust canvas. All ten fired `contextlost` in the same
   millisecond as `webglcontextlost`.
3. About 0.5 s later all ten fired `contextrestored` with a **blank** bitmap. This is spec behaviour: a 2D context loss
   does not keep its pixels.
4. About 0.5 s after that, `webglcontextrestored` fired. `RenderSystem.rebuild()` called `textures.markAllNeedsUpdate()`,
   which assumed "the canvases persist". three then re-uploaded the ten blank canvases.
5. GPU readback of each texture: 0 inked pixels everywhere. The screenshot `old-crash/01-gpucrash-after.png` looks the
   same as the owner's phone: blank gate panels, an empty count plate, no lane paint, no windows (`old-vs-phone.png`).

Answers to the lead's questions:

- **Size.** Not a factor. Every canvas was GPU-backed and lost.
- **Accelerated vs. software canvas.** This is the whole story. A canvas that had been read back with getImageData
  before the crash had been switched to software by Chrome's readback heuristic, and it survived. My first crash run
  read every canvas for stats and wrongly "passed".
- **The round-3 late-font redraw.** Not the cause. It only repaints into the same canvas.
- **ImageBitmap / disposed texture.** Neither is involved.

**Why closing the app fixed it:** a fresh boot redraws every canvas.

**Second finding, from the fix work** (`crashvariants.mjs`, `crashvariants.txt`). A `willReadFrequently` (CPU) canvas
survives a GPU crash if it is painted directly or with `putImageData`. It is turned back into a GPU-backed canvas, and
lost again, the moment a GPU canvas is `drawImage`d into it. In that state every 1-px read also costs a 0.4 ms GPU round
trip.

## 3. Fix (root cause plus self-healing; all in TextureFactory)

1. **The kept canvases are CPU-backed** (`getContext('2d', { willReadFrequently: true })`), so they have no GPU state to
   lose. To keep the boot fast, each recipe is rasterised on a scratch canvas with the default (GPU) context and then
   copied in as pixels (`getImageData` → `putImageData`). The un-premultiply / re-premultiply round trip is exact: ink
   counts match 1.2.1 to the pixel (atlas 88 448, muzzle 2 220, icons 9 195). If the scratch is lost or the copy
   throws, the recipe paints directly into the kept canvas. Smoke, which is made with putImageData, always paints
   directly.
2. **Every canvas keeps its recipe** in a record `{ canvases, texes, paint, probe px/py, expect, lostMask }`. The road,
   windows and atlas have fixed seeds, so a redraw is pixel-identical. Each paint starts from `ctx.reset()`, with a
   manual fallback.
3. **`webglcontextrestored`**: `rebuild()` → `textures.restoreAll()`. It re-checks the font, redraws EVERY canvas from
   code, then sets `needsUpdate`. This replaces the plain `markAllNeedsUpdate()`.
4. **2D `contextlost` / `contextrestored` on every kept canvas.** This covers a browser that ignores the hint. Lost marks
   the canvas. It does not call `preventDefault`, because on a 2D context that forbids the restore. Restored redraws
   that recipe and sets `needsUpdate`. The two paths work in either order relative to the WebGL restore.
5. **Resume check.** On `visibilitychange` → visible, `pageshow` and the lifecycle `resume`, `verify()` takes one 1×1
   `getImageData` per canvas at a pixel its recipe always inks:

   | Canvas | Probe pixel |
   |---|---|
   | Atlas | Centre of the ÷ bar (a shape, so it is inked whatever the font) |
   | Icons | First inked pixel of cell 0, found once at boot |
   | Discs, smoke, muzzle | Centre |
   | Road, windows, facade | (1, 1) |

   If any canvas reads blank, everything is redrawn. Cost: 0.04 ms (1×) / 0.26 ms (4× CPU) for all ten.
6. **Fonts.**
   - Every redraw first checks `document.fonts` for a loaded Lilita One face. If none is loaded, `_ensureFont` asks for
     it again (one request at a time) and redraws the atlas when it arrives. Until then the existing system-ui fallback
     is used.
   - New: a `document.fonts` `loadingdone` listener redraws the atlas when the font arrives after build()'s 1.5 s wait.
     Before this fix the atlas kept the fallback face for the whole session.
   - `verify()` also upgrades a fallback atlas.
7. **Two smaller changes.**
   - `setRoadAnisotropy` (tier change) redraws the road first if its probe reads blank, so a re-upload can never upload
     a lost canvas.
   - `onRepaint` sets `render.dirty`, so a paused game redraws its frame.
   - `_wrapY` now skips seam copies that lie wholly outside the canvas. The pixels are identical.

New public surface: `restoreAll()`, `verify()`, `onRepaint`, and `repaints` / `lastRepaint` / `lastRepaintMs` for
debugging. `markAllNeedsUpdate()` is kept and has no callers. ARCHITECTURE §14 is respected: listeners and closures are
created at init, nothing runs per frame, every browser API is guarded, there is no console.log and no Math.random.

## 4. Verification (headless Chrome, RX 6800 / ANGLE, 390×844 @2 touch, level 6 Overcast, game paused like the owner)

Harness: `repro.mjs`. For every texture it reads the canvas ink and the GPU ink (framebuffer readback of three's
texture), checks `renderer.info.programs` and samples rAF frame times. Each step ends with a scene shot and a play shot
with forced floater, damage numbers and an icon flight. Results below are from the live tree (`live/`), with the same
results on a HEAD + render.js snapshot (`final/`) and on Low tier (`final-low/`).

| Step | What it does | Result |
|---|---|---|
| normal | hidden → CDP frozen → active → visible, nothing lost | no redraw; max frame 7.2 ms over 3 s (≤ 50 ms) |
| (i) | `WEBGL_lose_context` lose → 0.8 s → restore, mid-level | redraw all (`all:webgl`, 51 ms desktop, behind the overlay); all GPU textures = canvas |
| (ii) | clear every canvas, dispatch `contextlost` then `contextrestored` | each recipe redrawn on restored (`<name>:2d`, ≤ 3 ms each); canvases are back to full ink |
| (iii) | clear every canvas AND upload the blanks (exactly the phone state), then hidden / frozen / active / visible | `verify()` on resume → `all:blank:road`, 51–54 ms (one longer frame, only because something really was lost); digits back; later frames ≤ 7.1 ms |
| (iv) | 2D lost + WebGL lost, WebGL restored, then 2D restored | healed |
| GPU crash | `Browser.crashGpuProcess` (the real thing) | **no 2D events at all** (CPU canvases survived); WebGL restore redraws; healed |

- `renderer.info.programs` stayed at 58 throughout (42 on Low).
- Screenshots in `final-montage.png` and `live/*.png`: gate digits, MAX badge, count label, floaters (+25), damage
  numbers (120 / 127 / 134), the icon flight and the HUD all come back after every step.
- In (iii), particle / smoke read GPU = 0 right after the heal only because three uploads lazily on first use. They are
  full after play.
- Fonts (`fonttest.mjs`):
  - Lilita One delayed 12 s: atlas drawn with the fallback, then redrawn with Lilita One when it arrived (`loadingdone`).
  - Font blocked: fallback, no errors.
  - Resume with a forced `_atlasWithFont = false`: atlas redrawn (`font`).
- Boot (`timing.mjs`, `bootcmp*.mjs`, 4× CPU):
  - Paint + upload of all canvases: 142 ms, against 113 ms for GPU-only canvases and 197 ms for rasterising on the CPU.
  - The build's road / atlas steps become ≈ 95–145 ms tasks (1.2.1: 22–56 ms main thread, but the deferred GPU raster
    and the uploads landed later in the warm-up).
  - Time to title is unchanged within noise: 3.9–5.8 s new vs 4.0–6.1 s HEAD.
  - Max boot task 221–303 ms new vs 226–588 ms HEAD; no gap over 300 ms in the acceptance sense.
- `tools/smoke.js --scenario all` on the live tree: CLEAN; programs 58 / 58; p99 7.1 ms; level complete; HOME → title.
  `check-imports` OK.

## 5. Notes for the release engineer / others

- `dist/` and `artifact.html` need the usual rebuild to pick up js/render.js. sw.js is not touched by this change.
- On the phone, restoreAll / the resume heal will cost roughly 3× the desktop figures, so about 150 ms. That is one frame
  behind "Reloading graphics…", or the first frame after a real loss. A normal resume costs < 1 ms.
- Not in my files: if Chrome ever kills the whole renderer, the PWA reloads (a normal boot). No action needed.
