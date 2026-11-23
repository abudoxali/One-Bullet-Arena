"""Bake the One Bullet Arena map tileset.

Run headless:

    blender --background --factory-startup --python tools/blender/build-tileset.py

WHY MATERIALS AND NOT BLOCKS
----------------------------
Arena obstacles are plain rectangles whose sizes come from `ARENA_STAGES` in
src/arena.js -- 48x216 in the first sector, and other shapes later. Baking a
sprite per obstacle size is not possible and a nine-slice set is a lot of
pieces to compose for very little gain here.

So this bakes surfaces, not objects: one floor panel (four variants), one wall
top panel and one wall face strip. The renderer tiles them with
`createPattern` and builds each obstacle's geometry itself, which means any
rectangle works and the art stays one small atlas.

THE PROJECTION IS MIXED, DELIBERATELY
-------------------------------------
The simulation is 2D: x and y are both ground coordinates and the renderer
maps them to the screen one to one. So the ground is drawn top-down and is
NOT foreshortened, while anything standing up -- walls, actors -- is drawn
three-quarter. That mismatch is the standard top-down game convention and the
actors were already baked for it.

Concretely: floor and wall-top panels render from straight overhead, and the
wall face renders from the shared 53.13 degree camera, where a wall of
WALL_HEIGHT world units is exactly WALL_HEIGHT * 0.6 units tall on screen.
"""

import json
import math
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bakelib  # noqa: E402

# --------------------------------------------------------------------------
# Contract constants.
# --------------------------------------------------------------------------
# TILE matches TILE_SIZE in src/core/world-2d-runtime.js. The floor grid is a
# visual grid, but keeping the baked panel on the same pitch means the seams
# the art already draws land exactly on the panel edges.
TILE = 54
PIXELS_PER_UNIT = 2
TILE_PX = TILE * PIXELS_PER_UNIT                       # 108

# How tall a wall stands in world units, and therefore how deep its face is on
# screen. Tall enough to read as cover next to a ~30 unit creature; short
# enough that it does not swallow the floor behind it.
WALL_HEIGHT = 70
FACE_PX = round(WALL_HEIGHT * bakelib.HEIGHT_SCALE) * PIXELS_PER_UNIT   # 84
assert WALL_HEIGHT * bakelib.HEIGHT_SCALE == FACE_PX / PIXELS_PER_UNIT, \
    "wall height must land on a whole number of screen units"

FLOOR_VARIANTS = 4          # matches floorTileVariant() in world-2d-runtime.js

# Desaturated slate, in the family of FLOOR_TOPS[0] ('#121e35'). Baked neutral
# on purpose: the renderer tints per sector from STAGE_ACCENTS, so eight
# sectors share one atlas.
#
# The floor is deliberately much darker than the wall top. The first bake gave
# them close values and the blocks stopped reading as blocks -- on a top-down
# map, the only thing separating a wall from the ground is that its lit top
# surface is brighter, because both are seen from the same angle.
PALETTE = {
    "floor": "#111a2e",
    "floor_trim": "#1e2c48",
    "wall_top": "#3d5480",
    "wall_top_trim": "#53709f",
    "wall_face": "#0b1322",
    "wall_rib": "#1a2742",
    "bolt": "#44588a",
}


def add_box(name, location, scale, material, bevel=1.4, segments=2):
    bpy.ops.mesh.primitive_cube_add(size=2.0, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    # Bevel width is measured in the mesh's own space, so the object scale has
    # to be baked into the mesh first. Without this a 1.8 unit chamfer is 1.8
    # of the primitive's 2 unit edge -- it ate the corners and turned every
    # deck plate into an octagon, which cannot tile.
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material)
    if bevel > 0:
        modifier = obj.modifiers.new("bevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = segments
        modifier.limit_method = "ANGLE"
        modifier.angle_limit = math.radians(40)
    return obj


def add_cylinder(name, location, radius, depth, material, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=16, radius=radius, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    return obj


def clear_objects():
    for obj in list(bpy.data.objects):
        if obj.type == "MESH":
            bpy.data.objects.remove(obj, do_unlink=True)


# --------------------------------------------------------------------------
# pieces
# --------------------------------------------------------------------------
def build_floor_panel(variant, plate_mat, trim_mat, bolt_mat):
    """A beveled deck plate seen from above.

    The 2 unit inset leaves a dark gutter between neighbouring panels, so the
    tiling reads as panelling rather than as a repeated texture. Detail is
    kept to what survives at 54 pixels: a bevel the key light can catch, and
    one clear feature per variant.
    """
    half = TILE / 2 - 2
    add_box("plate", (0, 0, -4), (half, half, 4), plate_mat, bevel=1.8)

    if variant == 1:
        for sx in (-1, 1):
            for sy in (-1, 1):
                add_cylinder(f"bolt_{sx}_{sy}", (sx * (half - 5), sy * (half - 5), 0.4),
                             1.9, 1.6, bolt_mat)
    elif variant == 2:
        # A vent: three ribs reading as louvres from overhead.
        for i in (-1, 0, 1):
            add_box(f"louvre_{i}", (0, i * 7.0, 0.5), (half - 7, 2.2, 0.9), trim_mat, bevel=0.5)
    elif variant == 3:
        # A seam running corner to corner, to break up long floors.
        seam = add_box("seam", (0, 0, 0.4), (half - 3, 1.5, 0.7), trim_mat, bevel=0.3)
        seam.rotation_euler = (0, 0, math.radians(38))


def build_wall_top(plate_mat, trim_mat):
    """The top surface of a wall, seen from above: lighter and framed."""
    half = TILE / 2 - 1
    add_box("cap", (0, 0, -4), (half, half, 4), plate_mat, bevel=2.4, segments=3)
    add_box("ridge", (0, 0, 0.6), (half - 6, half - 6, 1.0), trim_mat, bevel=1.0)


def build_wall_face(face_mat, rib_mat):
    """The vertical face of a wall, seen from the shared camera.

    The slab runs far in +Y so its top surface projects above the frame and
    only the face toward the camera is captured. The bevel on the top front
    edge is what gives the baked strip its lit cap, which is the line that
    separates a wall's top from its face once both are tiled in the game.
    """
    half = TILE / 2
    add_box("slab", (0, 40, WALL_HEIGHT / 2), (half, 40, WALL_HEIGHT / 2), face_mat,
            bevel=2.2, segments=3)
    # Vertical ribs, plus a band near the base where the wall meets the floor.
    for i in (-1, 1):
        add_box(f"rib_{i}", (i * 15.0, -0.6, WALL_HEIGHT * 0.52),
                (3.4, 1.0, WALL_HEIGHT * 0.40), rib_mat, bevel=0.8)
    add_box("skirt", (0, -0.6, 5.0), (half - 2, 1.0, 4.0), rib_mat, bevel=0.8)


# --------------------------------------------------------------------------
# bake
# --------------------------------------------------------------------------
def bake_piece(builder, width, height, elevation, target, ortho, frames_dir, name):
    scene = bakelib.new_scene(width, height)
    bakelib.ortho_camera(scene, ortho, target=target, elevation=elevation)
    bakelib.three_point_lights(scene)

    materials = {key: bakelib.matte_material(key, value, roughness=0.62, metallic=0.08)
                 for key, value in PALETTE.items()}
    builder(materials)

    path = os.path.join(frames_dir, f"{name}.png")
    return bakelib.clean_frame(bakelib.render_to(scene, path))


def main():
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    out_dir = os.path.join(repo, "src", "assets", "sprites")
    frames_dir = os.path.join(repo, "tools", "blender", "_frames", "tileset")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(frames_dir, exist_ok=True)

    overhead = math.pi / 2
    pieces = {}
    rendered = {}

    for variant in range(FLOOR_VARIANTS):
        rendered[f"floor{variant}"] = bake_piece(
            lambda m, v=variant: build_floor_panel(v, m["floor"], m["floor_trim"], m["bolt"]),
            TILE_PX, TILE_PX, overhead, (0, 0, 0), TILE, frames_dir, f"floor{variant}")

    rendered["wallTop"] = bake_piece(
        lambda m: build_wall_top(m["wall_top"], m["wall_top_trim"]),
        TILE_PX, TILE_PX, overhead, (0, 0, 0), TILE, frames_dir, "wall_top")

    rendered["wallFace"] = bake_piece(
        lambda m: build_wall_face(m["wall_face"], m["wall_rib"]),
        TILE_PX, FACE_PX, bakelib.ELEVATION, (0, 0, WALL_HEIGHT / 2), TILE, frames_dir, "wall_face")

    # Atlas: one row of square panels, then the face strip underneath.
    square = [k for k in rendered if k != "wallFace"]
    width = TILE_PX * len(square)
    height = TILE_PX + FACE_PX
    atlas = np.zeros((height, width, 4), dtype=np.float32)

    for i, key in enumerate(square):
        atlas[0:TILE_PX, i * TILE_PX:(i + 1) * TILE_PX] = rendered[key]
        pieces[key] = {"x": i * TILE_PX, "y": 0, "w": TILE_PX, "h": TILE_PX}

    atlas[TILE_PX:TILE_PX + FACE_PX, 0:TILE_PX] = rendered["wallFace"]
    pieces["wallFace"] = {"x": 0, "y": TILE_PX, "w": TILE_PX, "h": FACE_PX}

    atlas_path = os.path.join(out_dir, "arena-tileset.png")
    bakelib.save_image("arena_tileset", atlas, atlas_path)

    manifest = {
        "image": "arena-tileset.png",
        "pixelsPerUnit": PIXELS_PER_UNIT,
        "tile": TILE,
        "floorVariants": FLOOR_VARIANTS,
        # A wall stands WALL_HEIGHT units tall in the world and therefore
        # HEIGHT_SCALE * WALL_HEIGHT units tall on screen. The renderer needs
        # both: the first is the fiction, the second is the pixel offset.
        "wallHeight": WALL_HEIGHT,
        "wallScreenHeight": round(WALL_HEIGHT * bakelib.HEIGHT_SCALE, 3),
        "heightScale": round(bakelib.HEIGHT_SCALE, 4),
        "groundCompression": round(bakelib.GROUND_COMPRESSION, 4),
        "filtering": "smooth",
        "pieces": pieces,
    }
    with open(os.path.join(out_dir, "arena-tileset.json"), "w", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")

    print(f"BAKE tileset={width}x{height} pieces={len(pieces)}")
    print(f"BAKE wall_screen_height={manifest['wallScreenHeight']} face_px={FACE_PX}")
    print(f"BAKE atlas_path={atlas_path}")


if __name__ == "__main__":
    main()
