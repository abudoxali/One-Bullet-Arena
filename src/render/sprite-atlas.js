/*
 * Baked pixel-art sprite atlases.
 *
 * Actors are modelled, lit and animated in Blender and baked to a single PNG
 * per archetype by tools/blender/build-sprite.py. This module is the runtime
 * half of that contract: it loads an atlas, picks the right cell for a facing
 * and an animation state, and blits it.
 *
 * THE CONTRACT
 * ------------
 * Sprites are baked at `pixelsPerUnit` pixels per logical world unit and drawn
 * back down by the same factor, so a 128 pixel frame baked at density 2 covers
 * 64 logical units however the art was rendered. Density is 2 because a smooth
 * cartoon render has gradients to resolve and any HiDPI canvas is already
 * backing at 2x; at density 1 the shading turns to mush.
 *
 * Frames sit in a grid, indexed state-major then direction then frame:
 *
 *     cell = state.start + direction * state.frames + frame
 *
 * WHY THE EIGHT DIRECTIONS ARE NOT 45 DEGREES APART
 * -------------------------------------------------
 * The bake camera looks down at 53.13 degrees, so the ground plane compresses
 * by 0.8 on screen. A yaw of 45 degrees in Blender therefore arrives as about
 * 38.7 degrees in canvas space, and the diagonals bunch toward the horizontal.
 * Rounding an angle to the nearest 45 would pick the wrong sprite for roughly
 * a sixth of all headings. The manifest ships the eight angles as rendered and
 * `nearestDirection` matches against those.
 *
 * EVERYTHING HERE IS OPTIONAL
 * ---------------------------
 * `ready` stays false until both the manifest and the image have loaded, and
 * goes back to false forever if either fails. Callers are expected to fall
 * back to the procedural art rather than wait, so a missing or corrupt atlas
 * costs fidelity and never a blank screen.
 */

export const SPRITE_ATLAS_VERSION = '3.17.0-cartoon-sprites';

const TAU = Math.PI * 2;

/*
 * Smallest signed angle from `a` to `b`, in radians.
 */
function angleDelta(a, b) {
  let delta = (b - a) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  return delta;
}

/*
 * Index of the baked direction whose rendered screen angle is closest to
 * `angle`. Pure, so the direction table can be asserted without a canvas.
 */
export function nearestDirection(screenAngles, angle) {
  if (!Array.isArray(screenAngles) || screenAngles.length === 0) return 0;
  const target = Number(angle) || 0;
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < screenAngles.length; i += 1) {
    const distance = Math.abs(angleDelta(screenAngles[i], target));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/*
 * Frame within a state at `time` seconds. Looping states wrap; one-shot states
 * hold their last frame, which is what lets a hit pose settle instead of
 * snapping back to the first frame mid-flash.
 */
export function animationFrame(state, time) {
  const count = Math.max(1, Math.floor(state?.frames) || 1);
  const fps = Math.max(0.001, Number(state?.fps) || 1);
  const elapsed = Math.max(0, Number(time) || 0);
  const raw = Math.floor(elapsed * fps);
  if (state?.loop === false) return Math.min(count - 1, raw);
  return ((raw % count) + count) % count;
}

export class SpriteAtlas {
  constructor(actor, baseUrl) {
    this.actor = actor;
    this.baseUrl = baseUrl;
    this.manifest = null;
    this.image = null;
    this.failed = false;
    this.loading = false;
  }

  get ready() {
    return Boolean(this.manifest && this.image && !this.failed);
  }

  /*
   * Fetches the manifest and the image. Safe to call more than once and safe
   * to call where there is no DOM: without fetch or Image this resolves to a
   * permanently unready atlas instead of throwing, so Node tests can import
   * this module.
   */
  async load() {
    if (this.loading || this.ready || this.failed) return this.ready;
    if (typeof fetch !== 'function' || typeof Image !== 'function') {
      this.failed = true;
      return false;
    }
    this.loading = true;
    try {
      const manifestUrl = new URL(`${this.actor}.json`, this.baseUrl);
      const response = await fetch(manifestUrl, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`manifest ${response.status}`);
      const manifest = await response.json();
      const image = await loadImage(new URL(manifest.image, this.baseUrl));
      this.manifest = manifest;
      this.image = image;
    } catch (error) {
      // A missing atlas is a downgrade, not a fault: the caller keeps its
      // procedural path. Reported once so a broken bake is still visible.
      this.failed = true;
      if (typeof console !== 'undefined') {
        console.warn(`[sprite-atlas] ${this.actor} unavailable, using procedural art`, error);
      }
    } finally {
      this.loading = false;
    }
    return this.ready;
  }

  hasState(name) {
    return Boolean(this.manifest?.states?.[name]);
  }

  /*
   * Source rectangle for one cell, or null when the state is unknown.
   */
  cell(stateName, angle, time) {
    const manifest = this.manifest;
    const state = manifest?.states?.[stateName];
    if (!state) return null;

    const direction = nearestDirection(manifest.screenAngles, angle);
    const frame = animationFrame(state, time);
    const index = state.start + direction * state.frames + frame;
    const column = index % manifest.columns;
    const row = Math.floor(index / manifest.columns);
    return {
      sx: column * manifest.frameWidth,
      sy: row * manifest.frameHeight,
      sw: manifest.frameWidth,
      sh: manifest.frameHeight,
    };
  }

  /*
   * Blits one cell with its ground point at (x, y). Returns false when the
   * atlas is not usable, so the caller can fall through to procedural art in
   * the same frame.
   *
   * `flash` brightens the sprite with an additive second pass. Canvas filters
   * would be tidier but `ctx.filter` is still uneven across the browsers the
   * deploy gate runs, and 'lighter' is supported everywhere.
   */
  draw(ctx, { x, y, state, angle, time, alpha = 1, scale = 1, flash = 0 }) {
    if (!this.ready) return false;
    const source = this.cell(state, angle, time);
    if (!source) return false;

    const manifest = this.manifest;
    const pixel = manifest.pixelsPerUnit > 0 ? manifest.pixelsPerUnit : 1;
    const unit = scale / pixel;
    const width = manifest.frameWidth * unit;
    const height = manifest.frameHeight * unit;
    let dx = x - manifest.anchorX * unit;
    let dy = y - manifest.anchorY * unit;

    // Pixel-art actors snap to the logical grid so their pixels stop crawling
    // as the camera moves; smooth actors must not, because rounding their
    // position is a visible stutter with nothing gained.
    const pixelArt = manifest.filtering === 'pixel';
    if (pixelArt) {
      dx = Math.round(dx);
      dy = Math.round(dy);
    }

    const smoothing = ctx.imageSmoothingEnabled;
    ctx.save();
    ctx.imageSmoothingEnabled = !pixelArt;
    ctx.globalAlpha *= Math.max(0, Math.min(1, alpha));
    ctx.drawImage(this.image, source.sx, source.sy, source.sw, source.sh, dx, dy, width, height);
    if (flash > 0.001) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha *= Math.max(0, Math.min(1, flash));
      ctx.drawImage(this.image, source.sx, source.sy, source.sw, source.sh, dx, dy, width, height);
    }
    ctx.restore();
    ctx.imageSmoothingEnabled = smoothing;
    return true;
  }
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`image ${url}`));
    image.src = String(url);
  });
}

/*
 * Chooses the animation state for an enemy from simulation fields only.
 *
 * Enemies carry no velocity and are removed the instant they die, so there is
 * nothing here to read for a walk test or a death. A scout closes on the
 * player continuously, which makes 'run' the honest default; 'death' is baked
 * and waits for a corpse state to exist in the simulation.
 */
export function enemySpriteState(enemy) {
  if (!enemy) return 'idle';
  if ((Number(enemy.spawnTime) || 0) > 0) return 'idle';
  if ((Number(enemy.hitFlash) || 0) > 0) return 'hit';
  if ((Number(enemy.staggerTime) || 0) > 0) return 'idle';
  return 'run';
}
