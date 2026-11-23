import { clamp, normalize } from '../arena.js';
import { GAME_HEIGHT as HEIGHT, GAME_WIDTH as WIDTH } from '../game-data.js';
import { RELEASE_VERSION } from '../release.js';
import { UI_COLORS, polygon, roundedRect } from '../ui-renderer.js';
import { TilesetAtlas, floorPieceName } from '../render/tileset-atlas.js';
import { OneBulletWardenRuntime } from './warden-runtime.js';

export const WORLD_2D_RUNTIME_VERSION = '3.2.0-true-2d';

const TILE_SIZE = 54;
const ECHO_LIFETIME = 0.24;
/*
 * One accent per sector, in sector order.
 *
 * This was a three-entry table indexed with `stage % length`, so sectors 0/3/6
 * and 1/4/7 shared a palette and the world visibly reset every third sector.
 * The progression now runs cool-structural to warm-industrial and back to a
 * cold endgame, so a glance at the floor tells you roughly how deep you are.
 *
 * Cyan stays the structural/system colour throughout and gold is never used
 * here — it belongs to the bullet.
 */
const STAGE_ACCENTS = Object.freeze([
  Object.freeze({ primary: '#39d9ff', secondary: '#2a67bd', warm: '#ffd66b' }), // 0 chamber
  Object.freeze({ primary: '#4ce0e0', secondary: '#236f9e', warm: '#ffca69' }), // 1 wings
  Object.freeze({ primary: '#63f4c4', secondary: '#227ca4', warm: '#ffca69' }), // 2 corridors
  Object.freeze({ primary: '#7fe0a4', secondary: '#2f6f9c', warm: '#ffc46a' }), // 3 bowl
  Object.freeze({ primary: '#c8b972', secondary: '#4a6394', warm: '#ffb45f' }), // 4 cascade
  Object.freeze({ primary: '#ff9f6b', secondary: '#6a5590', warm: '#ffab52' }), // 5 industrial
  Object.freeze({ primary: '#a989ff', secondary: '#3e67c9', warm: '#ffb45f' }), // 6 matrix
  Object.freeze({ primary: '#7ea8ff', secondary: '#2b3f86', warm: '#ffd2a0' }), // 7 belt
]);

// Top-of-gradient floor value per sector, paired with STAGE_ACCENTS.
const FLOOR_TOPS = Object.freeze([
  '#121e35', '#141f38', '#16233c', '#18213a', '#1b2138', '#20202f', '#1d1c33', '#141a30',
]);

export function smoothVisualValue(current, target, dt, response = 14) {
  const safeCurrent = Number(current) || 0;
  const safeTarget = Number(target) || 0;
  const safeDt = Math.max(0, Number(dt) || 0);
  const safeResponse = Math.max(0, Number(response) || 0);
  const alpha = 1 - Math.exp(-safeDt * safeResponse);
  return safeCurrent + (safeTarget - safeCurrent) * alpha;
}

export function floorTileVariant(column, row, stage = 0) {
  const seed = Math.abs((Number(column) || 0) * 17 + (Number(row) || 0) * 31 + (Number(stage) || 0) * 13);
  return seed % 4;
}

export function world2DThemeTokens() {
  return Object.freeze({
    version: WORLD_2D_RUNTIME_VERSION,
    style: 'layered-top-down-2d',
    tileSize: TILE_SIZE,
    stageCount: STAGE_ACCENTS.length,
    stableHud: true,
    deterministicShake: true,
    gameplayGeometryChanged: false,
  });
}

export class OneBulletWorld2DRuntime extends OneBulletWardenRuntime {
  constructor(canvas, liveRegion = null) {
    super(canvas, liveRegion);
    this.world2DRuntimeVersion = WORLD_2D_RUNTIME_VERSION;
    this.visualMotion = 0;
    this.visualLean = 0;
    this.visualDirection = { x: 0, y: 0 };
    this.previousPlayerPosition = { x: this.player.x, y: this.player.y };
    this.playerEchoes = [];
    this.echoCooldown = 0;
    this.renderFrame = 0;
    // The baked map is additive: every floor and obstacle below keeps its
    // procedural path and uses it until this resolves, or forever if the
    // atlas cannot be fetched.
    this.arenaTileset = new TilesetAtlas('arena-tileset', new URL('../assets/sprites/', import.meta.url));
    this.arenaTileset.load();
    // Default to true for the vibrant 2D cartoon animation tiles map
    this.preferCartoon2DMap = true;
  }

  update(dt) {
    const safeDt = Math.max(0, Number(dt) || 0);
    const previousX = this.player.x;
    const previousY = this.player.y;

    super.update(safeDt);

    const dx = this.player.x - previousX;
    const dy = this.player.y - previousY;
    const travelled = Math.hypot(dx, dy);
    const targetMotion = safeDt > 0 ? clamp(travelled / (safeDt * 340), 0, 1.25) : 0;
    const direction = travelled > 0.05 ? normalize(dx, dy) : { x: 0, y: 0 };

    this.visualMotion = smoothVisualValue(
      this.visualMotion,
      targetMotion,
      safeDt,
      targetMotion > this.visualMotion ? 18 : 11,
    );
    this.visualDirection.x = smoothVisualValue(this.visualDirection.x, direction.x, safeDt, 16);
    this.visualDirection.y = smoothVisualValue(this.visualDirection.y, direction.y, safeDt, 16);
    this.visualLean = smoothVisualValue(this.visualLean, direction.x * targetMotion, safeDt, 13);

    this.echoCooldown = Math.max(0, this.echoCooldown - safeDt);
    if (
      this.state === 'playing'
      && !this.reducedMotion
      && travelled > 4
      && this.echoCooldown <= 0
    ) {
      this.playerEchoes.push({
        x: previousX,
        y: previousY,
        angle: Math.atan2(this.pointer.y - previousY, this.pointer.x - previousX),
        life: ECHO_LIFETIME,
        maxLife: ECHO_LIFETIME,
      });
      this.echoCooldown = this.player.dashRemaining > 0 ? 0.025 : 0.065;
    }

    for (const echo of this.playerEchoes) echo.life -= safeDt;
    this.playerEchoes = this.playerEchoes.filter((echo) => echo.life > 0).slice(-8);
    this.previousPlayerPosition = { x: this.player.x, y: this.player.y };
  }

  draw() {
    const ctx = this.ctx;
    this.uiRegions = [];
    this.renderFrame += 1;

    const shakeStrength = this.reducedMotion ? 0 : Math.max(0, this.shake || 0);
    const phase = this.elapsed * 71 + this.renderFrame * 0.41;
    const shakeX = Math.sin(phase) * shakeStrength * 0.34;
    const shakeY = Math.cos(phase * 1.37) * shakeStrength * 0.28;

    ctx.save();
    ctx.translate(shakeX, shakeY);
    this.drawArena();
    if (this.state !== 'menu') {
      this.drawBullet();
      this.drawEnemies();
      this.drawEnemyShots();
      this.drawPlayer();
      this.drawParticles();
      this.drawFloatingTexts();
      this.drawWorldLighting();
    }
    ctx.restore();

    if (this.state === 'menu') {
      this.drawMenu();
    } else {
      if (!this.touchMode && this.state === 'playing') this.drawTargetReticle();
      this.drawHud();
      if (this.touchMode && this.state === 'playing') this.drawTouchControls();
      if (this.banner && this.state === 'playing') this.drawBanner();
      if (this.state === 'upgrade') this.drawUpgradeSelection();
      if (this.state === 'paused') this.drawPause();
      if (this.state === 'gameover') this.drawGameOver();
    }

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255, 45, 82, ${this.flash * 0.16})`;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
    }
  }

  drawArena() {
    const ctx = this.ctx;
    const stage = this.arenaStage?.id ?? 0;
    const accent = STAGE_ACCENTS[stage % STAGE_ACCENTS.length];
    const bounds = this.arenaStage.bounds;

    const backdrop = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    backdrop.addColorStop(0, '#081021');
    backdrop.addColorStop(0.56, '#040915');
    backdrop.addColorStop(1, '#02040b');
    ctx.fillStyle = backdrop;
    ctx.fillRect(-40, -40, WIDTH + 80, HEIGHT + 80);

    this.drawOuterDeck(accent);
    this.drawArenaDropShadow(bounds, accent);
    this.drawFloorBase(bounds, accent, stage);
    this.drawFloorTiles(bounds, accent, stage);
    this.drawCombatLanes(bounds, accent);
    this.drawCenterPlatform(bounds, accent, stage);
    this.drawFloorDetails(bounds, accent, stage);

    if (this.state !== 'menu') {
      this.drawLockedSpace2D(bounds);
      for (const obstacle of this.arenaStage.obstacles) this.drawObstacle(obstacle);
      this.drawArenaBorder();
    } else {
      this.drawMenuArenaPreview(bounds, accent);
    }

    const vignette = ctx.createRadialGradient(
      WIDTH / 2,
      HEIGHT / 2,
      220,
      WIDTH / 2,
      HEIGHT / 2,
      820,
    );
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(0.7, 'rgba(0,0,0,0.12)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.7)');
    ctx.fillStyle = vignette;
    ctx.fillRect(-20, -20, WIDTH + 40, HEIGHT + 40);
  }

  drawOuterDeck(accent) {
    const ctx = this.ctx;
    const parallaxX = (this.player.x - WIDTH / 2) * 0.018;
    const parallaxY = (this.player.y - HEIGHT / 2) * 0.018;

    ctx.save();
    ctx.translate(-parallaxX, -parallaxY);
    ctx.globalAlpha = 0.46;
    ctx.strokeStyle = 'rgba(74, 102, 151, 0.18)';
    ctx.lineWidth = 1;

    for (let y = -TILE_SIZE; y <= HEIGHT + TILE_SIZE; y += TILE_SIZE) {
      for (let x = -TILE_SIZE; x <= WIDTH + TILE_SIZE; x += TILE_SIZE) {
        const column = Math.floor(x / TILE_SIZE);
        const row = Math.floor(y / TILE_SIZE);
        const variant = floorTileVariant(column, row, 0);
        ctx.fillStyle = variant === 0 ? 'rgba(18, 29, 52, 0.26)' : 'rgba(7, 14, 29, 0.2)';
        ctx.fillRect(x + 2, y + 2, TILE_SIZE - 4, TILE_SIZE - 4);
        ctx.strokeRect(x + 2, y + 2, TILE_SIZE - 4, TILE_SIZE - 4);
      }
    }

    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = accent.secondary;
    ctx.lineWidth = 3;
    for (let index = -2; index <= 2; index += 1) {
      const offset = index * 148 + Math.sin(this.elapsed * 0.35 + index) * 4;
      ctx.beginPath();
      ctx.moveTo(WIDTH / 2 + offset, -30);
      ctx.lineTo(WIDTH / 2 + offset, HEIGHT + 30);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawArenaDropShadow(bounds, accent) {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    ctx.shadowBlur = 36;
    ctx.fillStyle = 'rgba(0,0,0,0.68)';
    roundedRect(ctx, bounds.x + 9, bounds.y + 18, bounds.w, bounds.h, 18);
    ctx.fill();

    ctx.shadowColor = accent.primary;
    ctx.shadowBlur = 34;
    ctx.globalAlpha = 0.14;
    roundedRect(ctx, bounds.x, bounds.y, bounds.w, bounds.h, 18);
    ctx.strokeStyle = accent.primary;
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.restore();
  }

  drawFloorBase(bounds, accent, stage) {
    const ctx = this.ctx;
    ctx.save();
    roundedRect(ctx, bounds.x, bounds.y, bounds.w, bounds.h, 14);
    ctx.clip();

    // Floor value darkens as sectors get deeper, so later sectors read as
    // further underground rather than as the same room with a wider boundary.
    const depth = Math.min(1, Math.max(0, stage) / 7);
    const top = FLOOR_TOPS[Math.min(FLOOR_TOPS.length - 1, Math.max(0, stage))];
    const floor = ctx.createLinearGradient(bounds.x, bounds.y, bounds.x, bounds.y + bounds.h);
    floor.addColorStop(0, top);
    floor.addColorStop(0.52, depth > 0.5 ? '#091120' : '#0b1428');
    floor.addColorStop(1, depth > 0.5 ? '#050a15' : '#080f20');
    ctx.fillStyle = floor;
    ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);

    const glow = ctx.createRadialGradient(
      bounds.x + bounds.w / 2,
      bounds.y + bounds.h / 2,
      20,
      bounds.x + bounds.w / 2,
      bounds.y + bounds.h / 2,
      Math.max(bounds.w, bounds.h) * 0.65,
    );
    glow.addColorStop(0, `${accent.secondary}38`);
    glow.addColorStop(0.55, `${accent.primary}12`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    ctx.restore();
  }

  drawFloorTiles(bounds, accent, stage) {
    const ctx = this.ctx;
    ctx.save();
    roundedRect(ctx, bounds.x, bounds.y, bounds.w, bounds.h, 14);
    ctx.clip();

    const tiles = this.arenaTileset;
    const baked = Boolean(tiles?.ready);
    const useBaked = baked && !this.preferCartoon2DMap;
    const startX = Math.floor(bounds.x / TILE_SIZE) * TILE_SIZE;
    const startY = Math.floor(bounds.y / TILE_SIZE) * TILE_SIZE;
    for (let y = startY; y < bounds.y + bounds.h + TILE_SIZE; y += TILE_SIZE) {
      for (let x = startX; x < bounds.x + bounds.w + TILE_SIZE; x += TILE_SIZE) {
        const column = Math.floor(x / TILE_SIZE);
        const row = Math.floor(y / TILE_SIZE);
        const variant = floorTileVariant(column, row, stage);
        if (useBaked) {
          tiles.draw(ctx, floorPieceName(variant, tiles.manifest.floorVariants), x, y, TILE_SIZE, TILE_SIZE);
          continue;
        }

        // Vibrant 2D Cartoon Tile Grid
        // 1. Base cartoon tile plate
        ctx.fillStyle = variant === 3 ? 'rgba(24, 38, 64, 0.42)' : variant === 1 ? 'rgba(18, 30, 52, 0.48)' : 'rgba(14, 24, 42, 0.45)';
        ctx.fillRect(x + 1.5, y + 1.5, TILE_SIZE - 3, TILE_SIZE - 3);

        // 2. Comic ink tile seam stroke
        ctx.strokeStyle = 'rgba(45, 75, 120, 0.38)';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(x + 1.5, y + 1.5, TILE_SIZE - 3, TILE_SIZE - 3);

        // 3. Crisp glossy cartoon top edge highlight
        ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
        ctx.fillRect(x + 3.5, y + 3.5, TILE_SIZE - 7, 1.8);

        // 4. Subtle corner bolt studs
        ctx.fillStyle = 'rgba(100, 150, 220, 0.3)';
        ctx.fillRect(x + 4, y + 4, 2, 2);
        ctx.fillRect(x + TILE_SIZE - 6, y + 4, 2, 2);
        ctx.fillRect(x + 4, y + TILE_SIZE - 6, 2, 2);
        ctx.fillRect(x + TILE_SIZE - 6, y + TILE_SIZE - 6, 2, 2);

        // 5. Stylized 2D cartoon tile variants
        if (variant === 1) {
          // Cartoon Neon Circuit Tile
          const pulse = 0.35 + Math.sin(this.elapsed * 3.2 + column * 0.8 + row * 0.9) * 0.22;
          ctx.strokeStyle = `${accent.primary}${Math.round(clamp(pulse, 0, 1) * 255).toString(16).padStart(2, '0')}`;
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(x + 12, y + TILE_SIZE / 2);
          ctx.lineTo(x + TILE_SIZE / 2, y + TILE_SIZE / 2);
          ctx.lineTo(x + TILE_SIZE / 2, y + 12);
          ctx.stroke();
          ctx.fillStyle = accent.secondary;
          ctx.beginPath();
          ctx.arc(x + TILE_SIZE / 2, y + TILE_SIZE / 2, 2.5, 0, Math.PI * 2);
          ctx.fill();
        } else if (variant === 2) {
          // Cartoon Cooling Vent Tile
          ctx.fillStyle = 'rgba(4, 8, 16, 0.55)';
          const ventY = y + 16;
          for (let v = 0; v < 3; v += 1) {
            ctx.fillRect(x + 14, ventY + v * 8, TILE_SIZE - 28, 3.5);
          }
        } else if (variant === 3) {
          // Cartoon Sector Accent / Hazard Tile
          ctx.fillStyle = `${accent.warm}22`;
          ctx.beginPath();
          ctx.moveTo(x + 4, y + 18);
          ctx.lineTo(x + 18, y + 4);
          ctx.lineTo(x + 24, y + 4);
          ctx.lineTo(x + 4, y + 24);
          ctx.closePath();
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(x + TILE_SIZE - 4, y + TILE_SIZE - 18);
          ctx.lineTo(x + TILE_SIZE - 18, y + TILE_SIZE - 4);
          ctx.lineTo(x + TILE_SIZE - 24, y + TILE_SIZE - 4);
          ctx.lineTo(x + TILE_SIZE - 4, y + TILE_SIZE - 24);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    if (useBaked) {
      // The panels bake neutral so one atlas serves all eight sectors; the
      // sector's own colour goes on here, as a wash rather than a fill, so
      // the baked bevel lighting still shows through.
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = accent.secondary;
      ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    }
    ctx.restore();
  }

  drawCombatLanes(bounds, accent) {
    const ctx = this.ctx;
    const centerX = bounds.x + bounds.w / 2;
    const centerY = bounds.y + bounds.h / 2;

    ctx.save();
    roundedRect(ctx, bounds.x, bounds.y, bounds.w, bounds.h, 14);
    ctx.clip();

    // Sleek subtle cartoon arena guide tracks
    ctx.strokeStyle = `${accent.primary}25`;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([14, 16]);
    const dashOffset = (this.elapsed * 18) % 30;
    ctx.lineDashOffset = -dashOffset;
    ctx.beginPath();
    ctx.moveTo(bounds.x, centerY);
    ctx.lineTo(bounds.x + bounds.w, centerY);
    ctx.moveTo(centerX, bounds.y);
    ctx.lineTo(centerX, bounds.y + bounds.h);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.restore();
  }

  drawCenterPlatform(bounds, accent, stage) {
    const ctx = this.ctx;
    const centerX = bounds.x + bounds.w / 2;
    const centerY = bounds.y + bounds.h / 2;

    ctx.save();
    ctx.translate(centerX, centerY);

    // 2D Cartoon Combat Ring Emblem (Open, clear, zero visual obstruction)
    // Outer animated cartoon energy ring
    ctx.strokeStyle = `${accent.secondary}48`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 80 + stage * 3, 0, Math.PI * 2);
    ctx.stroke();

    // Rotating dashed combat ring
    ctx.strokeStyle = `${accent.primary}55`;
    ctx.lineWidth = 2;
    ctx.setLineDash([16, 14]);
    const rot = (this.elapsed * 18) % 30;
    ctx.lineDashOffset = -rot;
    ctx.beginPath();
    ctx.arc(0, 0, 56, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Sleek central target crosshair emblem flush on floor
    ctx.strokeStyle = `${accent.warm}50`;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(-18, 0);
    ctx.lineTo(18, 0);
    ctx.moveTo(0, -18);
    ctx.lineTo(0, 18);
    ctx.stroke();

    // Small central glowing cartoon hub
    ctx.fillStyle = `${accent.primary}35`;
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  drawFloorDetails(bounds, accent, stage) {
    const ctx = this.ctx;
    const centerX = bounds.x + bounds.w / 2;
    const centerY = bounds.y + bounds.h / 2;
    const corners = [
      { x: bounds.x + 46, y: bounds.y + 46, rotation: 0 },
      { x: bounds.x + bounds.w - 46, y: bounds.y + 46, rotation: Math.PI / 2 },
      { x: bounds.x + bounds.w - 46, y: bounds.y + bounds.h - 46, rotation: Math.PI },
      { x: bounds.x + 46, y: bounds.y + bounds.h - 46, rotation: -Math.PI / 2 },
    ];

    ctx.save();
    for (const corner of corners) {
      ctx.save();
      ctx.translate(corner.x, corner.y);
      ctx.rotate(corner.rotation);
      ctx.fillStyle = 'rgba(6, 13, 27, 0.82)';
      ctx.strokeStyle = `${accent.primary}68`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-26, -13);
      ctx.lineTo(18, -13);
      ctx.lineTo(26, -5);
      ctx.lineTo(26, 13);
      ctx.lineTo(-26, 13);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = accent.warm;
      ctx.globalAlpha = 0.45 + Math.sin(this.elapsed * 3 + corner.x) * 0.1;
      ctx.fillRect(-18, -2, 27, 4);
      ctx.restore();
    }

    ctx.globalAlpha = 0.15;
    ctx.strokeStyle = accent.secondary;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(centerX - Math.min(220, bounds.w * 0.22), centerY);
    ctx.lineTo(centerX - 88, centerY);
    ctx.moveTo(centerX + 88, centerY);
    ctx.lineTo(centerX + Math.min(220, bounds.w * 0.22), centerY);
    ctx.moveTo(centerX, centerY - Math.min(160, bounds.h * 0.2));
    ctx.lineTo(centerX, centerY - 88);
    ctx.moveTo(centerX, centerY + 88);
    ctx.lineTo(centerX, centerY + Math.min(160, bounds.h * 0.2));
    ctx.stroke();
    ctx.restore();
  }

  drawLockedSpace2D(bounds) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 2, 8, 0.72)';
    ctx.fillRect(0, 0, WIDTH, bounds.y);
    ctx.fillRect(0, bounds.y + bounds.h, WIDTH, HEIGHT - bounds.y - bounds.h);
    ctx.fillRect(0, bounds.y, bounds.x, bounds.h);
    ctx.fillRect(bounds.x + bounds.w, bounds.y, WIDTH - bounds.x - bounds.w, bounds.h);
    ctx.restore();
  }

  drawMenuArenaPreview(bounds, accent) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.38;
    ctx.strokeStyle = accent.primary;
    ctx.lineWidth = 2;
    ctx.setLineDash([18, 16]);
    roundedRect(ctx, bounds.x, bounds.y, bounds.w, bounds.h, 14);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /*
   * A baked block: cast shadow, front face, top panel, lit cap.
   *
   * The rectangle is the TOP face and the front face hangs below its lower
   * edge, which is the convention the procedural block already used, so
   * collision keeps reading exactly where the player sees the surface they
   * are standing against.
   *
   * Returns false when there is no usable tileset, so drawObstacle falls
   * through to the procedural block in the same frame.
   */
  drawBakedObstacle(obstacle) {
    const tiles = this.arenaTileset;
    if (!tiles?.ready) return false;
    if (this.preferCartoon2DMap !== false) return false;

    const ctx = this.ctx;
    const faceHeight = tiles.wallScreenHeight;
    const stage = this.arenaStage?.id ?? 0;
    const accent = STAGE_ACCENTS[stage % STAGE_ACCENTS.length];

    // The shared bake rig keys from the upper left, so every shadow in the
    // game falls down and to the right -- walls and creatures alike.
    ctx.save();
    ctx.globalAlpha = 0.46;
    ctx.fillStyle = '#000';
    roundedRect(ctx, obstacle.x + 10, obstacle.y + 14, obstacle.w, obstacle.h + faceHeight, 9);
    ctx.fill();
    ctx.restore();

    // Face first; the top panel then covers its upper edge cleanly.
    tiles.tileRect(
      ctx, 'wallFace',
      obstacle.x, obstacle.y + obstacle.h, obstacle.w, faceHeight,
      obstacle.x, obstacle.y + obstacle.h,
    );
    // Anchored to the world grid, not to the block, so adjacent obstacles
    // share one continuous panel pitch.
    tiles.tileRect(ctx, 'wallTop', obstacle.x, obstacle.y, obstacle.w, obstacle.h, 0, 0);

    ctx.save();
    // The cap: the bright line where the top surface breaks into the face.
    ctx.strokeStyle = 'rgba(208, 233, 255, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(obstacle.x, obstacle.y + obstacle.h);
    ctx.lineTo(obstacle.x + obstacle.w, obstacle.y + obstacle.h);
    ctx.stroke();

    // Cyan stays the structural colour throughout the game; gold is never
    // used here because it belongs to the bullet.
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = accent.primary;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(obstacle.x + 3, obstacle.y + obstacle.h + faceHeight * 0.42);
    ctx.lineTo(obstacle.x + obstacle.w - 3, obstacle.y + obstacle.h + faceHeight * 0.42);
    ctx.stroke();
    ctx.restore();
    return true;
  }

  drawObstacle(obstacle) {
    if (this.drawBakedObstacle(obstacle)) return;
    const ctx = this.ctx;
    const stage = this.arenaStage?.id ?? 0;
    const accent = STAGE_ACCENTS[stage % STAGE_ACCENTS.length];

    ctx.save();
    // 1. Soft rounded cartoon contact shadow
    ctx.fillStyle = 'rgba(0, 4, 12, 0.42)';
    roundedRect(ctx, obstacle.x + 6, obstacle.y + 10, obstacle.w, obstacle.h, 14);
    ctx.fill();

    // 2. Bold comic ink outline
    ctx.strokeStyle = '#081020';
    ctx.lineWidth = 3.6;

    // 3. Cel-shaded 2D cartoon bumper pillar body
    const bodyGradient = ctx.createLinearGradient(
      obstacle.x,
      obstacle.y,
      obstacle.x + obstacle.w,
      obstacle.y + obstacle.h,
    );
    bodyGradient.addColorStop(0, '#1c2e4a');
    bodyGradient.addColorStop(0.5, '#122038');
    bodyGradient.addColorStop(1, '#0a1426');
    ctx.fillStyle = bodyGradient;
    roundedRect(ctx, obstacle.x, obstacle.y, obstacle.w, obstacle.h, 14);
    ctx.fill();
    ctx.stroke();

    // 4. Inner plate with bevel
    ctx.fillStyle = '#16253d';
    roundedRect(ctx, obstacle.x + 5, obstacle.y + 5, obstacle.w - 10, obstacle.h - 10, 10);
    ctx.fill();

    // 5. Glossy cartoon specular highlight along top and left
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(obstacle.x + 12, obstacle.y + obstacle.h - 14);
    ctx.lineTo(obstacle.x + 12, obstacle.y + 12);
    ctx.lineTo(obstacle.x + obstacle.w - 14, obstacle.y + 12);
    ctx.stroke();

    // 6. Central animated cartoon neon conduit
    const pulse = 0.45 + Math.sin(this.elapsed * 4.2 + obstacle.x * 0.05) * 0.25;
    ctx.strokeStyle = `${accent.primary}${Math.round(clamp(pulse, 0, 1) * 255).toString(16).padStart(2, '0')}`;
    ctx.shadowColor = accent.primary;
    ctx.shadowBlur = 10;
    ctx.lineWidth = 2.8;
    ctx.beginPath();
    ctx.moveTo(obstacle.x + obstacle.w / 2, obstacle.y + 18);
    ctx.lineTo(obstacle.x + obstacle.w / 2, obstacle.y + obstacle.h - 18);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 7. Corner shiny cartoon bolt rivets
    ctx.fillStyle = accent.warm;
    for (const [bx, by] of [
      [obstacle.x + 10, obstacle.y + 10],
      [obstacle.x + obstacle.w - 10, obstacle.y + 10],
      [obstacle.x + obstacle.w - 10, obstacle.y + obstacle.h - 10],
      [obstacle.x + 10, obstacle.y + obstacle.h - 10],
    ]) {
      ctx.beginPath();
      ctx.arc(bx, by, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 8. Stylized cartoon safety hazard chevrons at the base
    ctx.globalAlpha = 0.38;
    ctx.fillStyle = '#ffd66b';
    for (let x = obstacle.x + 14; x < obstacle.x + obstacle.w - 8; x += 18) {
      ctx.save();
      ctx.translate(x, obstacle.y + obstacle.h - 11);
      ctx.rotate(-0.55);
      ctx.fillRect(-5, -2, 10, 3.5);
      ctx.restore();
    }

    ctx.restore();
  }

  /*
   * The perimeter as a real wall: a top band all the way round, the far
   * wall's inner face falling into the room, and the near wall's outer face
   * falling away from it.
   *
   * The far face deliberately covers the first `wallScreenHeight` of floor.
   * That is what a wall seen from above does, and it is most of what makes
   * the arena read as a room rather than as a rectangle drawn on a floor.
   *
   * Returns false without a tileset so the caller keeps its flat border.
   */
  drawBakedArenaWall(bounds) {
    const tiles = this.arenaTileset;
    if (!tiles?.ready) return false;
    if (this.preferCartoon2DMap !== false) return false;

    const ctx = this.ctx;
    const faceHeight = tiles.wallScreenHeight;
    const thickness = 22;
    const left = bounds.x - thickness;
    const spanW = bounds.w + thickness * 2;

    const band = (x, y, w, h) => tiles.tileRect(ctx, 'wallTop', x, y, w, h, 0, 0);
    const ringY = bounds.y - thickness;
    const ringH = bounds.h + thickness * 2 + faceHeight;

    /*
     * Outside the walls is void, not more floor.
     *
     * The outer deck tiles the whole viewport, so without this the perimeter
     * sits in the middle of a floor field and reads as a stripe rather than
     * as the edge of a room. Punched with even-odd rather than four rects so
     * the hole stays exactly the wall ring.
     */
    ctx.save();
    ctx.fillStyle = 'rgba(2, 5, 12, 0.84)';
    ctx.beginPath();
    ctx.rect(left - 2400, ringY - 2400, spanW + 4800, ringH + 4800);
    ctx.rect(left, ringY, spanW, ringH);
    ctx.fill('evenodd');
    ctx.restore();

    // Far wall: top band outside the floor, inner face falling into the room.
    band(left, bounds.y - thickness, spanW, thickness);
    tiles.tileRect(ctx, 'wallFace', left, bounds.y, spanW, faceHeight, left, bounds.y);

    // Its shadow on the floor sells the height more than the face does.
    ctx.save();
    const cast = ctx.createLinearGradient(0, bounds.y + faceHeight, 0, bounds.y + faceHeight + 30);
    cast.addColorStop(0, 'rgba(0, 0, 0, 0.5)');
    cast.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = cast;
    ctx.fillRect(bounds.x, bounds.y + faceHeight, bounds.w, 30);
    ctx.restore();

    // Side walls last on this edge, so they close over the far face's ends.
    band(left, bounds.y, thickness, bounds.h);
    band(bounds.x + bounds.w, bounds.y, thickness, bounds.h);

    // Near wall: its top band, then its outer face falling away from the room.
    band(left, bounds.y + bounds.h, spanW, thickness);
    tiles.tileRect(
      ctx, 'wallFace',
      left, bounds.y + bounds.h + thickness, spanW, faceHeight,
      left, bounds.y + bounds.h + thickness,
    );

    // Contact occlusion where the side and near walls meet the floor. A hard
    // edge alone reads as a drawn line; the gradient is what makes the floor
    // look like it runs underneath something solid.
    ctx.save();
    const ao = 18;
    const edge = (x, y, w, h, x0, y0, x1, y1) => {
      const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
      gradient.addColorStop(0, 'rgba(0, 0, 0, 0.45)');
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, w, h);
    };
    edge(bounds.x, bounds.y + bounds.h - ao, bounds.w, ao,
         0, bounds.y + bounds.h, 0, bounds.y + bounds.h - ao);
    edge(bounds.x, bounds.y, ao, bounds.h, bounds.x, 0, bounds.x + ao, 0);
    edge(bounds.x + bounds.w - ao, bounds.y, ao, bounds.h,
         bounds.x + bounds.w, 0, bounds.x + bounds.w - ao, 0);
    ctx.restore();

    // The lit cap along every top edge that breaks into a face.
    ctx.save();
    ctx.strokeStyle = 'rgba(208, 233, 255, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(left, bounds.y);
    ctx.lineTo(left + spanW, bounds.y);
    ctx.moveTo(left, bounds.y + bounds.h + thickness);
    ctx.lineTo(left + spanW, bounds.y + bounds.h + thickness);
    ctx.stroke();
    ctx.restore();
    return true;
  }

  drawArenaBorder() {
    const ctx = this.ctx;
    const bounds = this.arenaStage.bounds;
    const stage = this.arenaStage?.id ?? 0;
    const accent = STAGE_ACCENTS[stage % STAGE_ACCENTS.length];
    const pulse = 0.62 + Math.sin(this.elapsed * 2.7) * 0.11 + this.arenaExpansionPulse * 0.24;
    const baked = this.drawBakedArenaWall(bounds);

    ctx.save();
    if (!baked) {
      ctx.fillStyle = 'rgba(3, 7, 15, 0.94)';
      ctx.strokeStyle = '#1b2c49';
      ctx.lineWidth = 14;
      roundedRect(ctx, bounds.x, bounds.y, bounds.w, bounds.h, 14);
      ctx.stroke();
    }

    ctx.strokeStyle = `${accent.primary}${Math.round(clamp(pulse, 0, 1) * 255).toString(16).padStart(2, '0')}`;
    ctx.shadowColor = accent.primary;
    ctx.shadowBlur = 20 + this.arenaExpansionPulse * 24;
    ctx.lineWidth = 4;
    roundedRect(ctx, bounds.x, bounds.y, bounds.w, bounds.h, 14);
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(226, 244, 255, 0.24)';
    ctx.lineWidth = 1;
    roundedRect(ctx, bounds.x + 7, bounds.y + 7, bounds.w - 14, bounds.h - 14, 10);
    ctx.stroke();

    const lightGap = 72;
    ctx.fillStyle = accent.warm;
    ctx.globalAlpha = 0.52;
    for (let x = bounds.x + 38; x < bounds.x + bounds.w - 28; x += lightGap) {
      ctx.fillRect(x, bounds.y - 3, 16, 5);
      ctx.fillRect(x, bounds.y + bounds.h - 2, 16, 5);
    }
    for (let y = bounds.y + 38; y < bounds.y + bounds.h - 28; y += lightGap) {
      ctx.fillRect(bounds.x - 3, y, 5, 16);
      ctx.fillRect(bounds.x + bounds.w - 2, y, 5, 16);
    }
    ctx.restore();
  }

  drawEnemies() {
    super.drawEnemies();
  }

  drawEnemyShots() {
    super.drawEnemyShots();
  }

  drawPlayer() {
    const ctx = this.ctx;
    ctx.save();
    for (const echo of this.playerEchoes) {
      const alpha = clamp(echo.life / echo.maxLife, 0, 1) * 0.1;
      ctx.save();
      ctx.translate(echo.x, echo.y);
      ctx.rotate(echo.angle);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = UI_COLORS.player;
      ctx.beginPath();
      ctx.moveTo(21, 0);
      ctx.lineTo(-13, -11);
      ctx.lineTo(-19, 0);
      ctx.lineTo(-13, 11);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();

    const motionScale = clamp(this.visualMotion, 0, 1);
    ctx.save();
    ctx.translate(this.player.x, this.player.y);
    ctx.rotate(this.visualLean * 0.025);
    ctx.scale(1 + motionScale * 0.035, 1 - motionScale * 0.022);
    ctx.translate(-this.player.x, -this.player.y);
    super.drawPlayer();
    ctx.restore();

    if (this.state === 'playing' && motionScale > 0.08) {
      ctx.save();
      ctx.globalAlpha = 0.08 + motionScale * 0.12;
      ctx.strokeStyle = UI_COLORS.player;
      ctx.lineWidth = 1.4;
      const backX = this.player.x - this.visualDirection.x * (24 + motionScale * 16);
      const backY = this.player.y - this.visualDirection.y * (24 + motionScale * 16);
      ctx.beginPath();
      ctx.moveTo(this.player.x - this.visualDirection.x * 16, this.player.y - this.visualDirection.y * 16);
      ctx.lineTo(backX, backY);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawBullet() {
    const ctx = this.ctx;
    if (!this.bullet.held) {
      const speed = Math.hypot(this.bullet.vx || 0, this.bullet.vy || 0);
      const direction = normalize(this.bullet.vx || 0, this.bullet.vy || 0);
      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
      ctx.beginPath();
      ctx.ellipse(this.bullet.x + 4, this.bullet.y + 8, 11, 4, 0, 0, Math.PI * 2);
      ctx.fill();

      const trailLength = clamp(speed / 16, 22, 62);
      const trail = ctx.createLinearGradient(
        this.bullet.x,
        this.bullet.y,
        this.bullet.x - direction.x * trailLength,
        this.bullet.y - direction.y * trailLength,
      );
      trail.addColorStop(0, 'rgba(255, 240, 145, 0.58)');
      trail.addColorStop(1, 'rgba(255, 230, 109, 0)');
      ctx.strokeStyle = trail;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(this.bullet.x, this.bullet.y);
      ctx.lineTo(this.bullet.x - direction.x * trailLength, this.bullet.y - direction.y * trailLength);
      ctx.stroke();
      ctx.restore();
    }
    super.drawBullet();
  }

  drawWorldLighting() {
    if (this.state === 'menu') return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    const dash = clamp(this.dashVisual || 0, 0, 1);

    // 1. Dynamic player kinetic illumination aura
    const playerGlowRadius = 140 + dash * 45;
    const playerGlow = ctx.createRadialGradient(
      this.player.x,
      this.player.y,
      6,
      this.player.x,
      this.player.y,
      playerGlowRadius,
    );
    playerGlow.addColorStop(0, 'rgba(98, 243, 255, 0.24)');
    playerGlow.addColorStop(0.38, 'rgba(60, 185, 240, 0.11)');
    playerGlow.addColorStop(1, 'rgba(98, 243, 255, 0)');
    ctx.fillStyle = playerGlow;
    ctx.fillRect(
      this.player.x - playerGlowRadius,
      this.player.y - playerGlowRadius,
      playerGlowRadius * 2,
      playerGlowRadius * 2,
    );

    // 2. Held bullet: concentrated warm golden core with rotating corona
    if (this.bullet.held) {
      const heldGlow = ctx.createRadialGradient(
        this.player.x,
        this.player.y,
        4,
        this.player.x,
        this.player.y,
        115,
      );
      heldGlow.addColorStop(0, 'rgba(255, 235, 95, 0.32)');
      heldGlow.addColorStop(0.35, 'rgba(255, 195, 45, 0.14)');
      heldGlow.addColorStop(1, 'rgba(255, 195, 45, 0)');
      ctx.fillStyle = heldGlow;
      ctx.fillRect(this.player.x - 120, this.player.y - 120, 240, 240);
    }

    // 3. In-flight radiant bullet & recall energy tether
    if (!this.bullet.held) {
      const isRecalling = Boolean(this.bullet.recalling);
      const bulletRadius = isRecalling ? 135 : 165;
      const bulletGlow = ctx.createRadialGradient(
        this.bullet.x,
        this.bullet.y,
        3,
        this.bullet.x,
        this.bullet.y,
        bulletRadius,
      );
      if (isRecalling) {
        bulletGlow.addColorStop(0, 'rgba(120, 245, 255, 0.45)');
        bulletGlow.addColorStop(0.35, 'rgba(60, 205, 255, 0.20)');
        bulletGlow.addColorStop(1, 'rgba(60, 205, 255, 0)');
      } else {
        bulletGlow.addColorStop(0, 'rgba(255, 245, 140, 0.45)');
        bulletGlow.addColorStop(0.35, 'rgba(255, 205, 50, 0.22)');
        bulletGlow.addColorStop(1, 'rgba(255, 180, 40, 0)');
      }
      ctx.fillStyle = bulletGlow;
      ctx.fillRect(
        this.bullet.x - bulletRadius,
        this.bullet.y - bulletRadius,
        bulletRadius * 2,
        bulletRadius * 2,
      );

      // Recall energy tether light corridor
      if (isRecalling) {
        ctx.strokeStyle = 'rgba(98, 243, 255, 0.16)';
        ctx.lineWidth = 16;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(this.player.x, this.player.y);
        ctx.lineTo(this.bullet.x, this.bullet.y);
        ctx.stroke();
      }
    }

    // 4. Enemy threat radiance (Color-coded signature lighting & telegraph flares)
    if (Array.isArray(this.enemies) && this.enemies.length > 0) {
      for (const enemy of this.enemies) {
        if (!enemy || enemy.dead || enemy.health <= 0) continue;
        const hit = (enemy.hitFlash || 0) > 0;
        const heat = Math.max(0, enemy.chargeTelegraph || enemy.shotTelegraph || (enemy.hitSquash || 0));
        let color = 'rgba(255, 90, 110, ';
        let rad = (enemy.radius || 16) * 2.8;

        if (enemy.guardian) {
          color = 'rgba(103, 221, 255, ';
          rad = (enemy.radius || 42) * 2.5;
        } else if (enemy.type === 'brute') {
          color = 'rgba(255, 159, 67, ';
          rad = (enemy.radius || 24) * 2.9;
        } else if (enemy.type === 'sniper') {
          color = 'rgba(167, 139, 250, ';
          rad = (enemy.radius || 15) * 3.2;
        } else if (enemy.type === 'charger') {
          color = 'rgba(255, 75, 95, ';
          rad = (enemy.radius || 18) * (heat > 0 ? 4.2 : 2.6);
        } else if (enemy.type === 'splitter') {
          color = 'rgba(126, 242, 154, ';
          rad = (enemy.radius || 16) * 2.8;
        } else if (enemy.type === 'warden') {
          color = 'rgba(79, 228, 255, ';
          rad = (enemy.radius || 24) * 3.1;
        }

        const alphaCore = hit ? 0.36 : (heat > 0 ? 0.28 : 0.14);
        const enemyGlow = ctx.createRadialGradient(
          enemy.x,
          enemy.y,
          2,
          enemy.x,
          enemy.y,
          rad,
        );
        enemyGlow.addColorStop(0, `${color}${alphaCore})`);
        enemyGlow.addColorStop(0.45, `${color}${alphaCore * 0.38})`);
        enemyGlow.addColorStop(1, `${color}0)`);
        ctx.fillStyle = enemyGlow;
        ctx.fillRect(enemy.x - rad, enemy.y - rad, rad * 2, rad * 2);
      }
    }

    ctx.restore();
  }

  drawTargetReticle() {
    const ctx = this.ctx;
    const x = clamp(this.pointer.x, 10, WIDTH - 10);
    const y = clamp(this.pointer.y, 10, HEIGHT - 10);
    const pulse = this.reducedMotion ? 0 : Math.sin(this.elapsed * 7) * 1.5;
    const radius = 9 + pulse;

    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = this.bullet.held ? 'rgba(255, 238, 132, 0.9)' : 'rgba(156, 194, 224, 0.62)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.stroke();

    const gap = 5;
    const length = 7;
    ctx.beginPath();
    ctx.moveTo(-gap - length, 0);
    ctx.lineTo(-gap, 0);
    ctx.moveTo(gap, 0);
    ctx.lineTo(gap + length, 0);
    ctx.moveTo(0, -gap - length);
    ctx.lineTo(0, -gap);
    ctx.moveTo(0, gap);
    ctx.lineTo(0, gap + length);
    ctx.stroke();

    ctx.fillStyle = this.bullet.held ? UI_COLORS.bullet : UI_COLORS.muted;
    ctx.beginPath();
    ctx.arc(0, 0, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  getSnapshot() {
    return {
      ...super.getSnapshot(),
      releaseVersion: RELEASE_VERSION,
      world2DRuntimeVersion: WORLD_2D_RUNTIME_VERSION,
      true2DArenaActive: true,
      world2DStyle: 'layered-top-down-2d',
      layeredFloorTiles: true,
      environmentalDepth: true,
      stableHudDuringShake: true,
      deterministicCameraShake: true,
      visualMotionSmoothing: true,
      gameplayGeometryChanged: false,
    };
  }
}
