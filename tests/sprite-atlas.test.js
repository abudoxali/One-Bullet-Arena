import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SPRITE_ATLAS_VERSION,
  SpriteAtlas,
  animationFrame,
  enemySpriteState,
  nearestDirection,
} from '../src/render/sprite-atlas.js';

const repoRoot = new URL('../', import.meta.url);
const manifestUrl = new URL('src/assets/sprites/scout.json', repoRoot);

const readManifest = async () => JSON.parse(await readFile(manifestUrl, 'utf8'));

test('the module loads outside a browser without touching the DOM', async () => {
  assert.equal(SPRITE_ATLAS_VERSION, '3.17.0-cartoon-sprites');
  // Node has fetch but no Image, so load() must degrade rather than throw:
  // this is the same path a browser takes when an atlas 404s.
  const atlas = new SpriteAtlas('scout', new URL('src/assets/sprites/', repoRoot));
  assert.equal(atlas.ready, false);
  assert.equal(await atlas.load(), false);
  assert.equal(atlas.ready, false);
});

test('direction picking uses the baked screen angles, not an even 45 degree split', async () => {
  const manifest = await readManifest();
  const angles = manifest.screenAngles;
  assert.equal(angles.length, manifest.directions);

  // Every baked angle resolves to its own sprite.
  angles.forEach((angle, index) => {
    assert.equal(nearestDirection(angles, angle), index, `baked angle ${index}`);
  });

  // The 0.8 ground squash pulls the diagonals from 45 to about 38.7 degrees,
  // which moves the boundary between "up" and "up-right" from -67.5 to
  // -64.3. At -66 degrees the two schemes disagree, and the baked table is
  // the one that matches the pixels on screen.
  const angle = (-66 * Math.PI) / 180;
  assert.equal(nearestDirection(angles, angle), 0);
  const naive = Math.round((angle + Math.PI / 2) / (Math.PI / 4));
  assert.equal(naive, 1, 'the naive split is expected to differ here');

  // Wrapping past pi must not fall off the end of the table.
  assert.equal(nearestDirection(angles, Math.PI - 0.01), 6);
  assert.equal(nearestDirection(angles, -Math.PI + 0.01), 6);
});

test('looping states cycle and one-shot states hold their last frame', () => {
  const loop = { frames: 4, fps: 10, loop: true };
  assert.equal(animationFrame(loop, 0), 0);
  assert.equal(animationFrame(loop, 0.25), 2);
  assert.equal(animationFrame(loop, 0.4), 0, 'wraps after four frames');
  assert.equal(animationFrame(loop, 10.1), 1);

  const once = { frames: 2, fps: 10, loop: false };
  assert.equal(animationFrame(once, 0), 0);
  assert.equal(animationFrame(once, 0.1), 1);
  assert.equal(animationFrame(once, 9), 1, 'holds instead of restarting');

  // Negative and malformed input must never index outside the state.
  assert.equal(animationFrame(loop, -5), 0);
  assert.equal(animationFrame(undefined, 1), 0);
});

test('enemy animation state is derived from simulation fields only', () => {
  assert.equal(enemySpriteState({ spawnTime: 0.4 }), 'idle');
  assert.equal(enemySpriteState({ spawnTime: 0, hitFlash: 0.1 }), 'hit');
  assert.equal(enemySpriteState({ spawnTime: 0, hitFlash: 0, staggerTime: 0.2 }), 'idle');
  assert.equal(enemySpriteState({ spawnTime: 0, hitFlash: 0 }), 'run');
  assert.equal(enemySpriteState(null), 'idle');
});

test('the scout manifest agrees with the atlas image it ships beside', async () => {
  const manifest = await readManifest();
  const png = await readFile(new URL(`src/assets/sprites/${manifest.image}`, repoRoot));

  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.equal(width, manifest.columns * manifest.frameWidth);
  assert.equal(height, manifest.rows * manifest.frameHeight);

  assert.equal(manifest.radius, 17, 'scout radius comes from ENEMY_TYPES');
  assert.ok(manifest.pixelsPerUnit >= 1, 'density drives the draw-time divide');
  assert.equal(manifest.filtering, 'smooth', 'cartoon art is sampled bilinearly');

  // The frame covers this many logical world units once the runtime divides
  // by density. It has to clear the collision diameter with enough room that
  // a leaning run frame or a squashed death frame is not clipped -- baking at
  // 48 units did clip direction 4 on both.
  const unitsAcross = manifest.frameWidth / manifest.pixelsPerUnit;
  assert.ok(unitsAcross >= manifest.radius * 3, `frame covers ${unitsAcross} units`);
  assert.ok(manifest.anchorY > manifest.frameHeight / 2, 'ground point sits below centre');

  // Every cell the runtime can address must exist in the grid, or a late
  // animation frame reads transparent pixels off the end of the sheet.
  const capacity = manifest.columns * manifest.rows;
  for (const [name, state] of Object.entries(manifest.states)) {
    const last = state.start + (manifest.directions - 1) * state.frames + state.frames - 1;
    assert.ok(last < capacity, `state ${name} overruns the atlas grid`);
    assert.ok(state.frames > 0 && state.fps > 0, `state ${name} has a usable clock`);
  }
});

test('sprite assets are cached offline and sit where the deploy actually copies them', async () => {
  const manifest = await readManifest();
  const workerSource = await readFile(new URL('sw.js', repoRoot), 'utf8');
  const workflow = await readFile(new URL('.github/workflows/deploy-pages.yml', repoRoot), 'utf8');

  // cache.addAll() rejects atomically, so an uncached atlas does not degrade
  // offline play: it disables the offline shell entirely.
  for (const asset of ['src/assets/sprites/scout.json', `src/assets/sprites/${manifest.image}`]) {
    assert.ok(workerSource.includes(`'./${asset}'`), `add ${asset} to APP_SHELL in sw.js`);
    assert.ok(workflow.includes(asset), `add ${asset} to required_files in deploy-pages.yml`);
  }

  // The build step copies `src icons styles` and nothing else. An atlas under
  // a top-level assets/ would pass every test here and 404 in production.
  assert.match(workflow, /cp -R src icons styles _site\//);
});
