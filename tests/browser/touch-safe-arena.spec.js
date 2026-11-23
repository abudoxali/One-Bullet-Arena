import { expect, test } from '@playwright/test';

async function loadGame(page) {
  await page.goto('/?qa=1');
  await page.waitForFunction(() => Boolean(window.__ONE_BULLET_ARENA__));
}

/*
 * Touch controls reserve rectangles of the SCREEN for the player's thumbs, and
 * nothing in combat may end up underneath them.
 *
 * The check therefore has to happen in screen space. An earlier version of
 * this test placed entities at the snapshot's screen-space zone coordinates,
 * treated those as world coordinates, and asserted against the screen zones
 * again -- which only holds while the camera zoom is exactly 1. It was, for
 * sectors 0 to 2, until the camera curve was raised; the game was pushing
 * entities out of the correct world region the whole time.
 */
test('touch controls reserve clear rectangular combat zones', async ({ page }) => {
  await loadGame(page);
  const result = await page.evaluate(() => {
    const game = window.__ONE_BULLET_ARENA__;
    game.startRun();
    game.touchMode = true;
    game.wave = 8;
    game.startNextWave();

    const screenZones = game.getSnapshot().touchSafeZones;
    const worldZones = game.worldCombatSafeZones();

    // Inverse of screenToWorld: the camera scales about the viewport centre.
    const toScreen = (point, radius) => {
      const camera = game.worldCamera;
      const zoom = Math.max(0.01, Number(camera?.zoom) || 1);
      return {
        x: (point.x - (camera?.x ?? 640)) * zoom + 640,
        y: (point.y - (camera?.y ?? 360)) * zoom + 360,
        radius: radius * zoom,
      };
    };

    const overlaps = (entity, zone) => entity.x + entity.radius >= zone.x
      && entity.x - entity.radius <= zone.x + zone.w
      && entity.y + entity.radius >= zone.y
      && entity.y - entity.radius <= zone.y + zone.h;

    const clearOnScreen = (entity) => {
      const screen = toScreen(entity, entity.radius);
      return screenZones.every((zone) => !overlaps(screen, zone));
    };

    // Drop the player into the middle of each reserved zone in turn; every
    // one has to push it back out.
    let playerClear = true;
    for (const zone of worldZones) {
      game.player.x = zone.x + zone.w / 2;
      game.player.y = zone.y + zone.h / 2;
      game.constrainCombatCircle(game.player);
      if (!clearOnScreen(game.player)) playerClear = false;
    }

    game.enemies = worldZones.map((zone, index) => ({
      id: 9000 + index, type: 'scout', x: zone.x + zone.w / 2, y: zone.y + zone.h / 2,
      radius: 17, speed: 0, health: 1, maxHealth: 1, score: 0, color: '#ff5f78',
      attackCooldown: 99, shotTelegraph: 0, chargeTelegraph: 0, chargeRemaining: 0,
      chargeDirection: { x: 0, y: 0 }, phase: 0, spawnTime: 0, hitFlash: 0, mini: false,
    }));
    game.updateEnemies(0);

    return {
      zones: screenZones.length,
      // combatSafeZones() reserves more than the thumb rectangles the
      // snapshot reports -- it covers the HUD bands too -- so this is a
      // containment check, not an equality one.
      coversThumbZones: worldZones.length >= screenZones.length,
      playerClear,
      enemiesClear: game.enemies.every(clearOnScreen),
    };
  });
  expect(result).toEqual({
    zones: 4, coversThumbZones: true, playerClear: true, enemiesClear: true,
  });
});
