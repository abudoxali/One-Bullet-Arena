# Art pipeline — working brief

This is the standing brief for the 2.5D visual overhaul. It exists so the work
stays coherent across sessions: the numbers below are a contract, and anything
that drifts from them has to be re-baked, not patched at draw time.

Read this before touching `tools/blender/` or any renderer under `src/render/`.

## Direction

Soft rounded cartoon, smooth gradient shading, bright fresnel rim on
silhouettes, grounded contact shadows. Exaggerated motion: strong squash and
stretch with volume preserved, overshoot on impacts, trailing secondary action.

Not pixel art. An earlier pass baked hard three-tone bands with a drawn 1px
contour; it was rejected. The banding machinery is gone on purpose.

## Platform decision

Everything stays in the existing vanilla-JS runtime. Blender is the art tool;
no game engine is involved.

Unity 6000.3.19f1 (`C:\Users\Abud\UnityEditors\6000.3.19f1`) and Godot 4.7.1
are both installed on the machine. Neither is used. They would solve real-time
3D rendering, which is not the problem — the problem is art, and Blender makes
the art either way. Moving would discard ~17.3k lines of working gameplay, the
test suite, the browser deploy gate, the PWA shell and the i18n layer.

Revisit only if the goal changes to real-time 3D lighting. Then Three.js inside
this codebase is the cheaper step, not an engine port.

## The contract

Numbers that must agree across every bake and the renderer. `bakelib.py` owns
the shared half.

| Thing | Value | Why |
| --- | --- | --- |
| Simulation space | 1280 x 720 logical | `src/game-data.js`; never changes |
| Camera elevation | 53.13° (3-4-5 triangle) | ground squashes by exactly 0.8, heights by 0.6 |
| `GROUND_COMPRESSION` | 0.8 | written as an exact rational, not `sin()` |
| `HEIGHT_SCALE` | 0.6 | written as an exact rational, not `cos()` |
| Bake density | 2 px per logical unit | HiDPI canvases back at 2x; density 1 is mush |
| Light rig | key upper-left, fill right, back rim | `bakelib.three_point_lights`; shared by all bakes |
| Colour management | `view_transform = 'Standard'` | AgX would pull bakes off the game palette |
| Actor frame | 128 px (64 logical units) | leaves room for lean and squash; 48 units clipped |
| Actor directions | 8 | screen angles are NOT 45° apart — see below |
| Tile pitch | 54 logical units | matches `TILE_SIZE` in `world-2d-runtime.js` |
| Wall height | 70 units → 42 on screen | must land on a whole number of screen units |

### Projection is mixed, deliberately

The simulation is 2D: `x` and `y` are both ground coordinates mapped to the
screen one to one. So the **ground is drawn top-down and never foreshortened**,
while **anything standing up is drawn three-quarter**. That is the standard
top-down convention (Gungeon, Hyper Light) and it is what the actors are baked
for.

An obstacle rectangle is its **top** face; the front face hangs below the
rectangle's lower edge. Collision therefore reads exactly where the player sees
the surface they are standing against.

### The eight directions are not evenly spaced

A 45° yaw in Blender arrives as about 38.7° in canvas space because of the 0.8
ground squash. Manifests ship `screenAngles` as rendered and the runtime matches
against that list. Rounding a heading to the nearest 45° picks the wrong sprite
for roughly a sixth of all headings.

## Phases

Ordered by how much each unblocks the next. Acceptance is always: `npm run
verify` green, the browser matrix green, and the change seen running in the
game — not just in a contact sheet.

- **0 — Camera.** Raise the `CAMERA_ZOOMS` curve. Everything baked so far is
  too small to read, which makes every later phase impossible to judge.
  Gameplay-visible: a tighter camera means less awareness, so the minimap and
  off-screen telegraphs carry more weight. *(in progress)*
- **1 — Map.** Arena border and perimeter walls, outer deck and void, centre
  platform, per-sector floor treatment, props (light strips, vents, hazard
  markings). The floor panels and wall surfaces are already baked.
- **2 — Actors.** `brute`, `sniper`, `charger`, `warden`, `splitter`, the
  player, and the three sector guardians. `scout` is done and is the reference
  for silhouette, frame budget and animation feel.
- **3 — Bullet and combat VFX.** The bullet is the most important object on
  screen and is still procedural. Impacts, ricochet sparks, recall trail,
  spawn and death effects.
- **4 — Depth and lighting.** Decide the y-sort rule between walls and actors
  (today the arena always draws under every actor), ambient occlusion where
  walls meet the floor, a unified lighting overlay.
- **5 — HUD.** The DOM/SVG interface still reads as the old flat direction.
- **6 — Budget.** See below; do this before shipping, not after.

## Asset budget

`scout.png` alone is 1.27 MB (256 frames at 128 px). Nine more actors lands
near 12 MB, which is a lot for a PWA whose `APP_SHELL` is cached atomically.

Levers, cheapest first:

1. **WebP instead of PNG.** Blender can write it; expect 25–35% off.
2. **Trim cells to their content bounding box** and store per-cell offsets in
   the manifest. Content fills roughly half of each 128 px cell today.
3. **Lazy-load actors past wave 1** into a runtime cache instead of the
   install-time shell, so first load stays small.
4. Only then reduce frame counts.

## Traps already hit

Each of these cost a bake cycle. They are easy to repeat.

- **Blender dithers 8-bit output by default.** `dither_intensity = 0` for flat
  colour work. It sprayed ±1 noise and turned an 11-colour palette into 61.
- **Bevel width is measured in the mesh's own space.** Scaling an object and
  then adding a bevel modifier applies the width to the *unscaled* primitive —
  1.8 on a 2-unit cube ate the corners and turned deck plates into octagons.
  Apply the scale to the mesh first.
- **Atlas row order.** Writing cell rows in reverse silently transposes the
  sheet while each cell still looks upright, so the art gives nothing away.
  The game asked for `idle` frame 0 and got a `death` frame. Verify by picking
  two frames that must be mathematically identical and checking they are.
- **Volume-preserving squash explodes.** `1/sqrt(amount)` at a 0.12 collapse
  wants a 2.9x spread; it threw frames clean out of the cell. Clamp both ends.
- **`cos(atan2(4,3))` is 0.6000000000000001.** Use exact rationals for the
  3-4-5 ratios or consistency checks on whole-pixel heights fail.
- **The deploy workflow copies `src icons styles` and nothing else.** Assets
  anywhere outside those three work locally and 404 on Pages. That is why
  atlases live under `src/assets/`. `tests/tileset-atlas.test.js` holds it.
- **`cache.addAll()` rejects atomically.** One asset missing from `APP_SHELL`
  disables offline mode entirely, and nothing catches it until after release.

## Verification loop

1. Bake, then read the contact sheet the bake writes. Judge silhouette and
   readability before anything else.
2. Check the reported content bounds: zero margin means frames are clipped.
3. `npm run verify` — 173 Node tests.
4. `npx playwright test --workers=1` — the browser matrix is the deploy gate
   and a single failure blocks release entirely. The default worker count
   saturates this machine; always pass `--workers=1`.
5. Open the game and look at it. A contact sheet is not evidence that the
   runtime picked the right cell.

## Invariants

- Rendering quality tiers are visual-only: DPR, particles, shadows. Never
  enemy count, AI, damage, collision or wave progression.
- Every new file under `src/` goes in the `check` script and in `APP_SHELL`.
- Baked art is always optional. Every renderer that uses an atlas keeps its
  procedural path and falls through when the atlas is missing or still loading.
- Display text goes through `src/i18n.js`. No hardcoded strings.
- Version lives only in `src/release-config.js`; `package.json` and the SW
  cache name derive from it.
