import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { arenaStageForWave } from '../src/arena.js';
import { waveEncounterForWave } from '../src/game-data.js';
import {
  WORLD_EXPANSION_RUNTIME_VERSION,
  cameraClampAxis,
  cameraZoomForStage,
} from '../src/core/world-expansion-runtime.js';

test('world expansion runtime exposes progressive camera zoom levels', () => {
  assert.equal(WORLD_EXPANSION_RUNTIME_VERSION, '3.4.0-expanding-world');
  assert.equal(cameraZoomForStage(0), 1.42);
  assert.equal(cameraZoomForStage(3), 1.25);
  assert.equal(cameraZoomForStage(4), 1.21);
  assert.equal(cameraZoomForStage(7), 1.11);
  assert.equal(cameraZoomForStage(99), 1.11);

  // The curve only ever loosens. A sector that zoomed back in on the player
  // after the world expanded would read as the camera lurching, and the
  // expansion beat is supposed to feel like the room opening up.
  for (let stage = 1; stage <= 7; stage += 1) {
    assert.ok(
      cameraZoomForStage(stage) < cameraZoomForStage(stage - 1),
      `stage ${stage} must not zoom in on its predecessor`,
    );
  }
});

test('the opening sector stays wholly visible at its camera zoom', () => {
  // Sector 0 is the ricochet tutorial: both pillars and every wall the bullet
  // can bounce off have to be on screen at once, so its zoom is capped by its
  // own size.
  //
  // The baked perimeter in world-2d-runtime.js adds a 22 unit band on each
  // side and the near wall's face hangs 42 units below it, so the room is
  // larger than its floor. Measuring the floor alone let the zoom reach 1.70,
  // which cropped the new walls straight off the frame.
  const PERIMETER_BAND = 22;
  const NEAR_WALL_FACE = 42;
  const stage = arenaStageForWave(1);
  const zoom = cameraZoomForStage(stage.id);
  const roomWidth = stage.bounds.w + PERIMETER_BAND * 2;
  const roomHeight = stage.bounds.h + PERIMETER_BAND * 2 + NEAR_WALL_FACE;

  assert.ok(1280 / zoom >= roomWidth, 'sector 0 fits horizontally, walls included');
  assert.ok(720 / zoom >= roomHeight, 'sector 0 fits vertically, walls included');
});

test('camera clamping follows the player only when the world is larger than the viewport', () => {
  assert.equal(cameraClampAxis(100, 0, 500, 800), 250);
  assert.equal(cameraClampAxis(-999, -650, 2580, 1280), -10);
  assert.equal(cameraClampAxis(9999, -650, 2580, 1280), 1290);
});

test('late-game stages are materially larger than the original fixed viewport', () => {
  const stage9 = arenaStageForWave(9);
  const stage18 = arenaStageForWave(18);
  const stage35 = arenaStageForWave(35);
  assert.ok(stage18.bounds.w > 1280);
  assert.ok(stage18.bounds.h > 720);
  assert.ok(stage35.bounds.w > stage9.bounds.w * 2);
  assert.ok(stage35.bounds.h > stage9.bounds.h * 2);
});

test('late-game encounter cycle stays varied at high waves', () => {
  const firstCycle = Array.from({ length: 5 }, (_, index) => waveEncounterForWave(15 + index).id);
  const nextCycle = Array.from({ length: 5 }, (_, index) => waveEncounterForWave(40 + index).id);
  assert.equal(new Set(firstCycle).size, 5);
  assert.equal(new Set(nextCycle).size, 5);
});

test('runtime source keeps camera, exploration, near-player spawning, minimap, and unified HUD enabled', async () => {
  const source = await readFile(new URL('../src/core/world-expansion-runtime.js', import.meta.url), 'utf8');
  assert.match(source, /screenToWorld/);
  assert.match(source, /updateWorldCamera/);
  assert.match(source, /recordExplorationPoint/);
  assert.match(source, /this\.player\.x \+ Math\.cos\(angle\) \* ring/);
  assert.match(source, /drawMiniMap/);
  assert.match(source, /unifiedCombatHud: true/);
  assert.match(source, /gameplayGeometryChanged: true/);
  assert.match(source, /collisionGeometryChanged: true/);
});

test('page CSS uses the entire viewport instead of a centered 16:9 card', async () => {
  const css = await readFile(new URL('../game.css', import.meta.url), 'utf8');
  assert.match(css, /\.game-shell[\s\S]*position: fixed;[\s\S]*inset: 0;/);
  assert.match(css, /\.game-frame[\s\S]*width: 100vw;[\s\S]*height: 100dvh;/);
  assert.doesNotMatch(css, /aspect-ratio:\s*16\s*\/\s*9/);
});
