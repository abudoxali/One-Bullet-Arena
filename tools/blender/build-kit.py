"""Model the modular arena kit and export it as glTF for Godot.

    blender --background --factory-startup --python tools/blender/build-kit.py

Produces one .glb per module in godot/assets/kit/. Godot tiles them along the
arena bounds that ArenaData carries over from the JS build, so a module is
placed and repeated, never stretched to fit a sector.

WHY MODULES AND NOT TEXTURES
----------------------------
The 2D build faked wall height with painted gradients and a drawn contour.
Godot lights and shadows real geometry, so the panel bevels, the wall caps and
the recessed trim all catch the key light by themselves. Texturing a flat box
would throw that away and need a normal-map bake to get it back.

SIZES ARE A CONTRACT WITH THE GODOT SIDE
----------------------------------------
`TILE` and `WALL_HEIGHT` must match the constants in godot/scripts. A module
is modelled to fill exactly its tile, minus a small gutter that becomes the
seam between neighbours -- the same trick the 2D floor used, where the gap is
the design rather than an artefact.

Everything is modelled with its base at z = 0 and exports Y-up, so Godot can
place a module at ground level without an offset.
"""

import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bakelib  # noqa: E402

TILE = 2.0
WALL_HEIGHT = 2.2
WALL_DEPTH = 0.8
GUTTER = 0.06          # half-gap between neighbouring floor panels

PALETTE = {
    # Albedo only. Godot's three-light rig does the shading, so baking any
    # lighting in here would light everything twice.
    "floor": "#243049",
    "floor_trim": "#33425f",
    "wall": "#38496b",
    "wall_cap": "#4a5f88",
    "wall_dark": "#1b2438",
    "bolt": "#55699a",
    "trim": "#39d9ff",     # structural cyan, same as the JS build
}


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.view_settings.view_transform = "Standard"
    return scene


def emissive_material(name, colour, strength=2.0):
    """Principled with emission, so glTF carries both base colour and glow."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    tree.nodes.clear()
    principled = tree.nodes.new("ShaderNodeBsdfPrincipled")
    principled.inputs["Base Color"].default_value = bakelib.hex_to_linear(colour)
    principled.inputs["Roughness"].default_value = 0.35
    principled.inputs["Emission Color"].default_value = bakelib.hex_to_linear(colour)
    principled.inputs["Emission Strength"].default_value = strength
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(principled.outputs[0], output.inputs[0])
    return mat


def box(name, centre, size, material, bevel=0.05, segments=2):
    bpy.ops.mesh.primitive_cube_add(size=2.0, location=centre)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size[0] * 0.5, size[1] * 0.5, size[2] * 0.5)
    # Bevel width is measured in the mesh's own space, so the scale has to be
    # applied first or a 0.05 chamfer becomes 0.05 of the primitive's 2 unit
    # edge and eats the corners.
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material)
    if bevel > 0:
        modifier = obj.modifiers.new("bevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = segments
        modifier.limit_method = "ANGLE"
        modifier.angle_limit = math.radians(40)
    return obj


def cylinder(name, centre, radius, depth, material):
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=radius, depth=depth, location=centre)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    return obj


# --------------------------------------------------------------------------
# modules
# --------------------------------------------------------------------------
def floor_panel(variant, mats):
    """A deck plate filling one tile, inset by the gutter on every side."""
    span = TILE - GUTTER * 2
    box("plate", (0, 0, -0.09), (span, span, 0.18), mats["floor"], bevel=0.07, segments=3)

    if variant == 1:
        for sx in (-1, 1):
            for sy in (-1, 1):
                cylinder(f"bolt_{sx}_{sy}", (sx * (span * 0.38), sy * (span * 0.38), -0.005),
                         0.055, 0.04, mats["bolt"])
    elif variant == 2:
        for i in (-1, 0, 1):
            box(f"louvre_{i}", (0, i * 0.26, 0.012), (span * 0.62, 0.1, 0.05),
                mats["floor_trim"], bevel=0.015)


def wall_segment(mats):
    """One run of perimeter wall: skirt, body, lit trim, cap.

    The trim sits in a recess on the inward face so the cyan reads as a light
    strip set into the wall rather than paint on its surface.
    """
    box("body", (0, 0, WALL_HEIGHT * 0.5), (TILE, WALL_DEPTH, WALL_HEIGHT),
        mats["wall"], bevel=0.05)
    box("skirt", (0, 0, 0.14), (TILE, WALL_DEPTH + 0.14, 0.28), mats["wall_dark"], bevel=0.04)
    box("cap", (0, 0, WALL_HEIGHT - 0.08), (TILE, WALL_DEPTH + 0.1, 0.16),
        mats["wall_cap"], bevel=0.05)
    box("trim", (0, -WALL_DEPTH * 0.5 - 0.01, WALL_HEIGHT * 0.62),
        (TILE * 0.78, 0.06, 0.09), mats["trim"], bevel=0.02)


def pillar_block(mats):
    """An obstacle module. Obstacles are long rectangles in the layouts, so
    Godot repeats this along the long axis instead of scaling one block and
    smearing its bevel."""
    box("body", (0, 0, WALL_HEIGHT * 0.5), (TILE, TILE, WALL_HEIGHT), mats["wall"], bevel=0.07)
    box("skirt", (0, 0, 0.16), (TILE + 0.1, TILE + 0.1, 0.32), mats["wall_dark"], bevel=0.05)
    box("cap", (0, 0, WALL_HEIGHT - 0.07), (TILE + 0.08, TILE + 0.08, 0.14),
        mats["wall_cap"], bevel=0.05)
    for sy in (-1, 1):
        box(f"trim_{sy}", (0, sy * (TILE * 0.5 + 0.01), WALL_HEIGHT * 0.62),
            (TILE * 0.6, 0.06, 0.09), mats["trim"], bevel=0.02)


def build_materials():
    mats = {key: bakelib.matte_material(key, value, roughness=0.6, metallic=0.1)
            for key, value in PALETTE.items() if key != "trim"}
    mats["trim"] = emissive_material("trim", PALETTE["trim"], 2.4)
    return mats


def export(name, out_dir):
    path = os.path.join(out_dir, f"{name}.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True,
                              export_animations=False, use_selection=False)
    size = os.path.getsize(path)
    print(f"KIT module={name} bytes={size}")


def main():
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    out_dir = os.path.join(repo, "godot", "assets", "kit")
    os.makedirs(out_dir, exist_ok=True)

    modules = [
        ("floor_a", lambda m: floor_panel(0, m)),
        ("floor_b", lambda m: floor_panel(1, m)),
        ("floor_c", lambda m: floor_panel(2, m)),
        ("wall", wall_segment),
        ("pillar", pillar_block),
    ]
    for name, builder in modules:
        reset()
        builder(build_materials())
        bpy.context.view_layer.update()
        export(name, out_dir)

    print(f"KIT tile={TILE} wall_height={WALL_HEIGHT} wall_depth={WALL_DEPTH} out={out_dir}")


if __name__ == "__main__":
    main()
