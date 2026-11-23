import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CINEMATIC_COMBAT_ART_VERSION, cinematicCombatTokens } from '../src/render/cinematic-combat-art.js';

test('cinematic combat art is a render-only replacement for geometric combat shapes', () => {
  const tokens = cinematicCombatTokens();
  assert.equal(CINEMATIC_COMBAT_ART_VERSION, '3.15.1-cinematic-combat-art');
  assert.equal(tokens.version, CINEMATIC_COMBAT_ART_VERSION);
  assert.equal(tokens.renderOnly, true);
  assert.equal(tokens.gameplayGeometryChanged, false);
  assert.equal(tokens.collisionGeometryChanged, false);
  assert.equal(tokens.replacesGeometricCombatShapes, true);
  assert.equal(tokens.animatedEffects, true);
  assert.equal(tokens.silhouetteDrivenEnemies, true);
  assert.equal(tokens.groundedEntityShadows, true);
  assert.equal(tokens.creatureDetailPass, true);
  assert.equal(tokens.archetypeSurfaceDetails, true);
  assert.equal(tokens.combatFacingCorrection, true);
  assert.equal(tokens.bakedSpriteAtlases, true);
  assert.deepEqual([...tokens.bakedArchetypes], ['scout']);
  assert.equal(tokens.runtimeOwner, 'OneBulletGlobalUiRuntime');
});

test('baked archetypes fall through to procedural art when their atlas is unavailable', async () => {
  const source = await readFile(new URL('../src/render/cinematic-combat-art.js', import.meta.url), 'utf8');

  // The bake is additive. drawScout must attempt the atlas and then continue
  // into the procedural body on a false return, so a failed or still-loading
  // atlas costs fidelity rather than drawing nothing at all.
  assert.match(source, /drawScout\(ctx, runtime, enemy\) \{\s*if \(this\.drawBakedEnemy\(ctx, runtime, enemy\)\) return;/);
  assert.match(source, /if \(!atlas\?\.ready \|\| enemy\?\.guardian\) return false;/);

  // Archetypes without a bake must not consult the atlas table at all.
  for (const archetype of ['drawBrute', 'drawSniper', 'drawCharger', 'drawWarden', 'drawSplitter']) {
    const body = source.slice(source.indexOf(`  ${archetype}(ctx`));
    assert.doesNotMatch(body.slice(0, 200), /drawBakedEnemy/, `${archetype} has no bake yet`);
  }
});

test('terminal runtime owns the cinematic combat renderer and bypasses legacy geometric combat drawing', async () => {
  const runtimeSource = await readFile(new URL('../src/core/ui-repair-runtime.js', import.meta.url), 'utf8');
  assert.match(runtimeSource, /new CinematicCombatArt\(\)/);
  assert.match(runtimeSource, /cinematicCombatArtActive: true/);
  assert.match(runtimeSource, /combatArtGameplayGeometryChanged: false/);
  assert.match(runtimeSource, /combatArtCollisionGeometryChanged: false/);
  assert.match(runtimeSource, /cinematicCombatArt: cinematicCombatTokens\(\)/);
  assert.match(runtimeSource, /cinematicCombatArt\?\.drawEnemy/);
  assert.match(runtimeSource, /cinematicCombatArt\?\.drawBullet/);
  assert.doesNotMatch(runtimeSource, /drawBullet\(\) \{\s*super\.drawBullet\(\)/);
  assert.doesNotMatch(runtimeSource, /drawEnemies\(\) \{\s*super\.drawEnemies\(\)/);
  assert.doesNotMatch(runtimeSource, /drawEnemyShots\(\) \{\s*[\s\S]{0,140}super\.drawEnemyShots\(\)/);
});

test('enemy body facing follows the player except during locked charge telegraphs', async () => {
  const source = await readFile(new URL('../src/render/cinematic-combat-art.js', import.meta.url), 'utf8');
  assert.match(source, /function directionToPlayer/);
  assert.match(source, /function lockedChargeDirection/);
  assert.match(source, /lockedChargeDirection\(enemy\) \|\| directionToPlayer\(runtime, enemy\)/);
  assert.match(source, /drawBrute[\s\S]*ctx\.rotate\(Math\.atan2\(toPlayer\.y, toPlayer\.x\)\)/);
  assert.match(source, /drawSplitter[\s\S]*Math\.atan2\(toPlayer\.y, toPlayer\.x\)/);
});

test('combat effects now use animated ember and ribbon primitives instead of triangle fragments', async () => {
  const source = await readFile(new URL('../src/render/combat-vfx.js', import.meta.url), 'utf8');
  assert.match(source, /soft embers, ribbons, and fragments/);
  assert.match(source, /quadraticCurveTo/);
  assert.match(source, /ctx\.ellipse/);
  assert.doesNotMatch(source, /lineTo\(s\.x - sin \* size \* 0\.5/);
});
