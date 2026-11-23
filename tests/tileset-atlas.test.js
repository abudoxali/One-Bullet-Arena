import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TILESET_ATLAS_VERSION, TilesetAtlas, floorPieceName } from '../src/render/tileset-atlas.js';

const repoRoot = new URL('../', import.meta.url);
const manifestUrl = new URL('src/assets/sprites/arena-tileset.json', repoRoot);

const readManifest = async () => JSON.parse(await readFile(manifestUrl, 'utf8'));

test('the tileset degrades instead of throwing where there is no DOM', async () => {
  assert.equal(TILESET_ATLAS_VERSION, '3.17.0-cartoon-sprites');
  const tiles = new TilesetAtlas('arena-tileset', new URL('src/assets/sprites/', repoRoot));
  assert.equal(tiles.ready, false);
  assert.equal(await tiles.load(), false);
  assert.equal(tiles.wallScreenHeight, 0, 'callers read this before load');
  assert.equal(tiles.piece('wallTop'), null);
  assert.equal(tiles.logicalSize('wallTop'), null);
});

test('floor piece names wrap and never index outside the baked set', async () => {
  const manifest = await readManifest();
  const count = manifest.floorVariants;
  for (let variant = 0; variant < count; variant += 1) {
    const name = floorPieceName(variant, count);
    assert.ok(manifest.pieces[name], `${name} is baked`);
  }
  // floorTileVariant() is bounded today, but a wrap here is cheaper than a
  // missing piece drawing nothing at all.
  assert.equal(floorPieceName(count, count), 'floor0');
  assert.equal(floorPieceName(-1, count), `floor${count - 1}`);
  assert.equal(floorPieceName(undefined, count), 'floor0');
});

test('the tileset manifest agrees with the image it ships beside', async () => {
  const manifest = await readManifest();
  const png = await readFile(new URL(`src/assets/sprites/${manifest.image}`, repoRoot));

  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);

  for (const [name, piece] of Object.entries(manifest.pieces)) {
    assert.ok(piece.x >= 0 && piece.y >= 0, `${name} starts inside the atlas`);
    assert.ok(piece.x + piece.w <= width, `${name} fits horizontally`);
    assert.ok(piece.y + piece.h <= height, `${name} fits vertically`);
  }

  // A wall standing `wallHeight` units tall shows `heightScale` of that on
  // screen, and the face strip has to be baked at exactly that height or the
  // block's front face will not meet its top panel.
  const expected = manifest.wallHeight * manifest.heightScale;
  assert.equal(manifest.wallScreenHeight, expected);
  assert.equal(manifest.pieces.wallFace.h / manifest.pixelsPerUnit, expected);

  // The camera is the 3-4-5 triangle, shared with the actor bake.
  assert.equal(manifest.heightScale, 0.6);
  assert.equal(manifest.groundCompression, 0.8);

  // Floor and wall-top panels are square and sit on the TILE_SIZE pitch that
  // world-2d-runtime.js lays the floor grid out on.
  for (const name of ['floor0', 'wallTop']) {
    const piece = manifest.pieces[name];
    assert.equal(piece.w, piece.h, `${name} is square`);
    assert.equal(piece.w / manifest.pixelsPerUnit, manifest.tile, `${name} is one tile across`);
  }
  assert.equal(manifest.tile, 54, 'matches TILE_SIZE in world-2d-runtime.js');
});

test('the baked map is additive and the procedural floor and blocks survive', async () => {
  const source = await readFile(new URL('src/core/world-2d-runtime.js', repoRoot), 'utf8');

  // drawObstacle must attempt the bake and then continue into the procedural
  // block on a false return, so a failed atlas costs fidelity, not the map.
  assert.match(source, /drawObstacle\(obstacle\) \{\s*if \(this\.drawBakedObstacle\(obstacle\)\) return;/);
  assert.match(source, /if \(!tiles\?\.ready\) return false;/);
  // The procedural floor path is still reachable when the atlas is absent.
  assert.match(source, /const baked = Boolean\(tiles\?\.ready\);/);
  assert.match(source, /floorTileVariant\(column, row, stage\)/);
});

test('tileset assets are cached offline and land where the deploy copies them', async () => {
  const manifest = await readManifest();
  const workerSource = await readFile(new URL('sw.js', repoRoot), 'utf8');
  const workflow = await readFile(new URL('.github/workflows/deploy-pages.yml', repoRoot), 'utf8');

  for (const asset of ['src/assets/sprites/arena-tileset.json', `src/assets/sprites/${manifest.image}`]) {
    assert.ok(workerSource.includes(`'./${asset}'`), `add ${asset} to APP_SHELL in sw.js`);
    assert.ok(workflow.includes(asset), `add ${asset} to required_files in deploy-pages.yml`);
  }
});
