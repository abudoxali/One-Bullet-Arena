/*
 * The baked arena tileset.
 *
 * tools/blender/build-tileset.py bakes the map as surfaces rather than
 * objects: four floor panel variants, a wall top panel and a wall face strip.
 * Obstacles are arbitrary rectangles out of ARENA_STAGES, so the renderer
 * tiles these pieces across whatever shape a sector asks for instead of
 * loading a sprite per block.
 *
 * THE PROJECTION IS MIXED, DELIBERATELY
 * -------------------------------------
 * The simulation is 2D: x and y are both ground coordinates, mapped to the
 * screen one to one. So the ground is drawn top-down and is never
 * foreshortened, while anything standing up is drawn three-quarter. An
 * obstacle's rectangle is therefore its TOP face, and its front face hangs
 * below the rectangle's lower edge by `wallScreenHeight`. That is the same
 * convention the procedural art used, so collision still reads exactly where
 * the player expects it.
 *
 * Like the actor atlases this is entirely optional: until it loads, and
 * forever if it fails, the caller keeps its procedural floor and blocks.
 */

import { loadImage } from './sprite-atlas.js';

export const TILESET_ATLAS_VERSION = '3.17.0-cartoon-sprites';

export class TilesetAtlas {
  constructor(name, baseUrl) {
    this.name = name;
    this.baseUrl = baseUrl;
    this.manifest = null;
    this.image = null;
    this.failed = false;
    this.loading = false;
  }

  get ready() {
    return Boolean(this.manifest && this.image && !this.failed);
  }

  /* Height of a wall's visible face, in logical units. Zero until loaded. */
  get wallScreenHeight() {
    return Number(this.manifest?.wallScreenHeight) || 0;
  }

  async load() {
    if (this.loading || this.ready || this.failed) return this.ready;
    if (typeof fetch !== 'function' || typeof Image !== 'function') {
      this.failed = true;
      return false;
    }
    this.loading = true;
    try {
      const response = await fetch(new URL(`${this.name}.json`, this.baseUrl), { cache: 'force-cache' });
      if (!response.ok) throw new Error(`manifest ${response.status}`);
      const manifest = await response.json();
      const image = await loadImage(new URL(manifest.image, this.baseUrl));
      this.manifest = manifest;
      this.image = image;
    } catch (error) {
      this.failed = true;
      if (typeof console !== 'undefined') {
        console.warn(`[tileset-atlas] ${this.name} unavailable, using procedural art`, error);
      }
    } finally {
      this.loading = false;
    }
    return this.ready;
  }

  piece(name) {
    return this.manifest?.pieces?.[name] || null;
  }

  /*
   * Logical size of a piece. The atlas is baked at `pixelsPerUnit` pixels per
   * logical unit, so a 108 pixel panel covers 54 units and the extra density
   * is spent on HiDPI rather than on making everything twice as big.
   */
  logicalSize(name) {
    const piece = this.piece(name);
    if (!piece) return null;
    const density = this.manifest.pixelsPerUnit > 0 ? this.manifest.pixelsPerUnit : 1;
    return { w: piece.w / density, h: piece.h / density };
  }

  draw(ctx, name, dx, dy, dw, dh) {
    const piece = this.piece(name);
    if (!this.ready || !piece) return false;
    ctx.drawImage(this.image, piece.x, piece.y, piece.w, piece.h, dx, dy, dw, dh);
    return true;
  }

  /*
   * Tiles one piece across a logical rectangle, clipped to it.
   *
   * `originX`/`originY` anchor the grid so that the arena floor keeps its
   * seams on the same pitch everywhere instead of restarting at each
   * rectangle. Drawn tile by tile rather than through createPattern: a
   * pattern would need setTransform to undo the bake density, and drawImage
   * costs nothing here while being supported identically everywhere the
   * deploy gate runs.
   */
  tileRect(ctx, name, x, y, w, h, originX = x, originY = y) {
    const size = this.logicalSize(name);
    if (!size || w <= 0 || h <= 0) return false;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    const startX = originX + Math.floor((x - originX) / size.w) * size.w;
    const startY = originY + Math.floor((y - originY) / size.h) * size.h;
    for (let ty = startY; ty < y + h; ty += size.h) {
      for (let tx = startX; tx < x + w; tx += size.w) {
        this.draw(ctx, name, tx, ty, size.w, size.h);
      }
    }
    ctx.restore();
    return true;
  }
}

/*
 * Which floor panel sits at a grid cell.
 *
 * Mirrors floorTileVariant() in world-2d-runtime.js so the baked floor keeps
 * the same deterministic scatter the procedural floor had; sectors stay
 * distinguishable by their accent rather than by a different layout.
 */
export function floorPieceName(variant, variants = 4) {
  const count = Math.max(1, Math.floor(variants) || 1);
  const index = ((Math.floor(variant) || 0) % count + count) % count;
  return `floor${index}`;
}
