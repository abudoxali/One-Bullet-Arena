"""Build the whole arena as a Blender scene you can walk around in.

    blender --background --factory-startup --python tools/blender/build-level.py

Writes tools/blender/arena.blend. Open it and press Shift+` to walk the level
in first person -- WASD to move, Q/E for up/down, mouse to look, Esc to leave.
tools/blender/enter-walk.py turns on gravity and collision for that mode.

This is the assembled level, not the module kit. build-kit.py exports loose
pieces for Godot to tile at runtime; this script places the same pieces into
one scene so the map can be inspected, lit and art-directed as a whole, which
is the thing a tiling runtime cannot show you.

Geometry comes from the same sector data the game uses, converted from the JS
build's 1280x720 logical space into metres (0.05 m per pixel, arena centred on
the origin, ground on XY with Z up).
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
GUTTER = 0.06

# Sector 0 from src/arena.js: bounds 660x410 px, two 48x216 px pillars.
ARENA = {"w": 33.0, "d": 20.5}
PILLARS = [
    {"x": -7.3, "y": 0.0, "w": 2.4, "d": 10.8},
    {"x": 7.3, "y": 0.0, "w": 2.4, "d": 10.8},
]

PALETTE = {
    "floor": "#243049",
    "floor_trim": "#33425f",
    "wall": "#38496b",
    "wall_cap": "#4a5f88",
    "wall_dark": "#1b2438",
    "bolt": "#55699a",
    "trim": "#39d9ff",
    "hazard": "#ffd66b",
    "robot_shell": "#cfe0f5",
    "robot_dark": "#2b3850",
    "robot_accent": "#39d9ff",
}

_materials = {}


def material(key):
    if key in _materials:
        return _materials[key]
    if key in ("trim", "robot_accent"):
        mat = emissive(key, PALETTE[key], 3.0)
    elif key == "hazard":
        mat = emissive(key, PALETTE[key], 0.8)
    else:
        mat = bakelib.matte_material(key, PALETTE[key], roughness=0.6, metallic=0.1)
    _materials[key] = mat
    return mat


def emissive(name, colour, strength):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    tree.nodes.clear()
    principled = tree.nodes.new("ShaderNodeBsdfPrincipled")
    principled.inputs["Base Color"].default_value = bakelib.hex_to_linear(colour)
    principled.inputs["Roughness"].default_value = 0.35
    principled.inputs["Emission Color"].default_value = bakelib.hex_to_linear(colour)
    principled.inputs["Emission Strength"].default_value = strength
    tree.links.new(principled.outputs[0], tree.nodes.new("ShaderNodeOutputMaterial").inputs[0])
    return mat


def box(name, centre, size, key, bevel=0.05, segments=2, parent=None, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=2.0, location=centre, rotation=rotation)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size[0] * 0.5, size[1] * 0.5, size[2] * 0.5)
    # Bevel width lives in the mesh's own space, so apply the scale first or a
    # 0.05 chamfer is 0.05 of the primitive's 2 unit edge and eats the corners.
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material(key))
    if bevel > 0:
        modifier = obj.modifiers.new("bevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = segments
        modifier.limit_method = "ANGLE"
        modifier.angle_limit = math.radians(40)
    if parent is not None:
        obj.parent = parent
    return obj


def cylinder(name, centre, radius, depth, key, rotation=(0, 0, 0), parent=None):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=16, radius=radius, depth=depth, location=centre, rotation=rotation)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.materials.append(material(key))
    bpy.ops.object.shade_smooth()
    if parent is not None:
        obj.parent = parent
    return obj


def collection(name):
    col = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(col)
    return col


def move_to(col, objects):
    for obj in objects:
        for existing in obj.users_collection:
            existing.objects.unlink(obj)
        col.objects.link(obj)


# --------------------------------------------------------------------------
# level
# --------------------------------------------------------------------------
def build_floor():
    made = []
    columns = int(ARENA["w"] / TILE)
    rows = int(ARENA["d"] / TILE)
    start_x = -(columns * TILE - TILE) * 0.5
    start_y = -(rows * TILE - TILE) * 0.5
    span = TILE - GUTTER * 2

    # The slab under the panels shows through the gutters and becomes the seam.
    made.append(box("floor_slab", (0, 0, -0.3), (ARENA["w"], ARENA["d"], 0.4), "wall_dark", bevel=0))

    for row in range(rows):
        for column in range(columns):
            x = start_x + column * TILE
            y = start_y + row * TILE
            made.append(box(f"panel_{column}_{row}", (x, y, -0.09), (span, span, 0.18),
                            "floor", bevel=0.07, segments=3))
            # Same deterministic scatter the JS floor used, so detail stays
            # sparse and never lands in a readable pattern.
            variant = abs(column * 17 + row * 31) % 4
            if variant == 2:
                for sx in (-1, 1):
                    for sy in (-1, 1):
                        made.append(cylinder(f"bolt_{column}_{row}_{sx}_{sy}",
                                             (x + sx * span * 0.38, y + sy * span * 0.38, -0.005),
                                             0.055, 0.04, "bolt"))
            elif variant == 3:
                for i in (-1, 0, 1):
                    made.append(box(f"louvre_{column}_{row}_{i}", (x, y + i * 0.26, 0.012),
                                    (span * 0.62, 0.1, 0.05), "floor_trim", bevel=0.015))
    return made


def wall_run(centre, axis, length, yaw, tag):
    """Whole modules end to end, overhanging the corner rather than gapping."""
    made = []
    count = int(math.ceil(length / TILE))
    start = [centre[0] - axis[0] * (count * TILE - TILE) * 0.5,
             centre[1] - axis[1] * (count * TILE - TILE) * 0.5]
    for i in range(count):
        x = start[0] + axis[0] * i * TILE
        y = start[1] + axis[1] * i * TILE
        rot = (0, 0, yaw)
        made.append(box(f"{tag}_body_{i}", (x, y, WALL_HEIGHT * 0.5),
                        (TILE, WALL_DEPTH, WALL_HEIGHT), "wall", bevel=0.05, rotation=rot))
        made.append(box(f"{tag}_skirt_{i}", (x, y, 0.14),
                        (TILE, WALL_DEPTH + 0.14, 0.28), "wall_dark", bevel=0.04, rotation=rot))
        made.append(box(f"{tag}_cap_{i}", (x, y, WALL_HEIGHT - 0.08),
                        (TILE, WALL_DEPTH + 0.1, 0.16), "wall_cap", bevel=0.05, rotation=rot))
        # The lit strip sits in a recess on the inward face: a light set into
        # the wall, not paint on it.
        inward = (-math.sin(yaw), math.cos(yaw))
        made.append(box(f"{tag}_trim_{i}",
                        (x + inward[0] * (WALL_DEPTH * 0.5 + 0.01),
                         y + inward[1] * (WALL_DEPTH * 0.5 + 0.01),
                         WALL_HEIGHT * 0.62),
                        (TILE * 0.78, 0.06, 0.09), "trim", bevel=0.02, rotation=rot))
    return made


def build_walls():
    half_w = ARENA["w"] * 0.5 + WALL_DEPTH * 0.5
    half_d = ARENA["d"] * 0.5 + WALL_DEPTH * 0.5
    made = []
    made += wall_run((0, -half_d), (1, 0), ARENA["w"], 0.0, "wall_s")
    made += wall_run((0, half_d), (1, 0), ARENA["w"], math.pi, "wall_n")
    made += wall_run((-half_w, 0), (0, 1), ARENA["d"], -math.pi * 0.5, "wall_w")
    made += wall_run((half_w, 0), (0, 1), ARENA["d"], math.pi * 0.5, "wall_e")
    return made


def build_pillars():
    made = []
    for index, pillar in enumerate(PILLARS):
        columns = max(1, round(pillar["w"] / TILE))
        rows = max(1, round(pillar["d"] / TILE))
        step_x = pillar["w"] / columns
        step_y = pillar["d"] / rows
        for row in range(rows):
            for column in range(columns):
                x = pillar["x"] - (pillar["w"] - step_x) * 0.5 + column * step_x
                y = pillar["y"] - (pillar["d"] - step_y) * 0.5 + row * step_y
                made.append(box(f"pillar{index}_{column}_{row}", (x, y, WALL_HEIGHT * 0.5),
                                (step_x, step_y, WALL_HEIGHT), "wall", bevel=0.06))
        made.append(box(f"pillar{index}_skirt", (pillar["x"], pillar["y"], 0.16),
                        (pillar["w"] + 0.12, pillar["d"] + 0.12, 0.32), "wall_dark", bevel=0.05))
        made.append(box(f"pillar{index}_cap", (pillar["x"], pillar["y"], WALL_HEIGHT - 0.07),
                        (pillar["w"] + 0.1, pillar["d"] + 0.1, 0.14), "wall_cap", bevel=0.05))
        for sy in (-1, 1):
            made.append(box(f"pillar{index}_trim_{sy}",
                            (pillar["x"], pillar["y"] + sy * (pillar["d"] * 0.5 + 0.01),
                             WALL_HEIGHT * 0.62),
                            (pillar["w"] * 0.6, 0.06, 0.09), "trim", bevel=0.02))
    return made


def build_props():
    """Hazard chevrons on the floor and vents on the walls.

    Props are what stop a correct level from reading as a grey box: they give
    the eye somewhere to land and tell you which way the room is oriented.
    """
    made = []
    for sx in (-1, 1):
        for i in range(4):
            made.append(box(f"hazard_{sx}_{i}",
                            (sx * (ARENA["w"] * 0.5 - 1.6), -2.4 + i * 1.6, 0.02),
                            (1.5, 0.28, 0.04), "hazard", bevel=0.01,
                            rotation=(0, 0, math.radians(38))))
    for i in range(6):
        x = -10.0 + i * 4.0
        made.append(box(f"vent_{i}", (x, ARENA["d"] * 0.5 + 0.1, 1.1),
                        (1.1, 0.12, 0.5), "wall_dark", bevel=0.03))
    return made


def build_lights():
    """Key, fill and back, matching bakelib's direction contract, plus point
    lights along the trim so the cyan reads as a source and not a sticker."""
    made = []
    # Directions are where each light SHINES, derived from bakelib's own
    # positions: the key sits at -X/-Y above and throws toward +X, so the lit
    # side is screen-left-to-right exactly as in every bake.
    for name, direction, energy, colour in (
        ("key", (0.6, 0.36, -0.76), 3.2, (1.0, 0.97, 0.92)),
        ("fill", (-0.7, 0.33, -0.33), 0.9, (0.66, 0.78, 1.0)),
        ("back", (-0.09, -0.82, -0.55), 1.4, (1.0, 0.88, 0.95)),
    ):
        data = bpy.data.lights.new(name, type="SUN")
        data.energy = energy
        data.color = colour
        data.angle = math.radians(14.0)
        obj = bpy.data.objects.new(name, data)
        obj.rotation_euler = bakelib.Vector(direction).to_track_quat("-Z", "Y").to_euler()
        obj.location = (0, 0, 14)
        bpy.context.scene.collection.objects.link(obj)
        made.append(obj)

    for i in range(5):
        data = bpy.data.lights.new(f"trim_light_{i}", type="POINT")
        data.energy = 120.0
        data.color = (0.22, 0.85, 1.0)
        data.shadow_soft_size = 0.6
        obj = bpy.data.objects.new(f"trim_light_{i}", data)
        obj.location = (-12.0 + i * 6.0, ARENA["d"] * 0.5 - 0.4, WALL_HEIGHT * 0.62)
        bpy.context.scene.collection.objects.link(obj)
        made.append(obj)
    return made


def build_camera():
    data = bpy.data.cameras.new("GameCamera")
    data.type = "ORTHO"
    data.ortho_scale = 38.0
    cam = bpy.data.objects.new("GameCamera", data)
    # The game's own 53.13 degree three-quarter view, so the Blender scene and
    # Godot frame the arena identically.
    elevation = math.atan2(4.0, 3.0)
    cam.location = (0.0, -math.cos(elevation) * 40.0, math.sin(elevation) * 40.0)
    cam.rotation_euler = (math.pi / 2 - elevation, 0.0, 0.0)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    return [cam]


# --------------------------------------------------------------------------
# player
# --------------------------------------------------------------------------
def build_player(at=(0.0, -6.0, 0.0)):
    """A compact sci-fi walker.

    Deliberately mechanical. An earlier attempt at an organic creature built
    from primitives read as boxes glued together; hard-surface forms are what
    this way of modelling is actually good at, so the player is a machine and
    the bevels and recesses become design rather than artefacts.

    Sized against the game's own collision radius of 0.9 m.
    """
    root = bpy.data.objects.new("Player", None)
    bpy.context.scene.collection.objects.link(root)
    root.location = at
    made = [root]

    made.append(box("p_hips", (0, 0, 0.72), (1.0, 0.7, 0.42), "robot_dark", bevel=0.07, parent=root))
    made.append(box("p_chest", (0, 0, 1.22), (1.34, 0.86, 0.64), "robot_shell", bevel=0.1, segments=3, parent=root))
    made.append(box("p_collar", (0, 0, 1.6), (1.1, 0.72, 0.16), "robot_dark", bevel=0.05, parent=root))
    made.append(box("p_head", (0, 0.04, 1.86), (0.62, 0.58, 0.44), "robot_shell", bevel=0.09, segments=3, parent=root))
    # The visor is the one bright thing above the waist: it tells you which
    # way the player is facing from any angle the camera can take.
    made.append(box("p_visor", (0, -0.3, 1.88), (0.46, 0.08, 0.14), "robot_accent", bevel=0.03, parent=root))

    for sx in (-1, 1):
        side = "l" if sx < 0 else "r"
        made.append(box(f"p_shoulder_{side}", (sx * 0.78, 0, 1.44),
                        (0.42, 0.62, 0.46), "robot_dark", bevel=0.08, parent=root))
        made.append(box(f"p_arm_{side}", (sx * 0.82, 0, 1.0),
                        (0.3, 0.34, 0.56), "robot_shell", bevel=0.06, parent=root))
        made.append(box(f"p_thigh_{side}", (sx * 0.34, 0, 0.42),
                        (0.38, 0.42, 0.46), "robot_dark", bevel=0.06, parent=root))
        made.append(box(f"p_boot_{side}", (sx * 0.36, -0.04, 0.12),
                        (0.46, 0.62, 0.24), "robot_shell", bevel=0.06, parent=root))
        made.append(box(f"p_vent_{side}", (sx * 0.58, 0.44, 1.3),
                        (0.14, 0.06, 0.3), "robot_accent", bevel=0.02, parent=root))

    # The launcher arm: this game gives you one bullet, so the thing that
    # fires it should be the heaviest shape on the model.
    made.append(box("p_launcher", (0.86, -0.42, 1.06), (0.34, 0.9, 0.34),
                    "robot_dark", bevel=0.06, parent=root))
    made.append(cylinder("p_muzzle", (0.86, -0.92, 1.06), 0.13, 0.22, "robot_accent",
                         rotation=(math.pi / 2, 0, 0), parent=root))
    made.append(cylinder("p_core", (0, -0.45, 1.24), 0.17, 0.1, "robot_accent",
                         rotation=(math.pi / 2, 0, 0), parent=root))
    return made


# --------------------------------------------------------------------------
def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.view_settings.view_transform = "Standard"
    scene.world = bpy.data.worlds.new("world")
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = (0.03, 0.045, 0.08, 1.0)
    background.inputs["Strength"].default_value = 0.35

    move_to(collection("Floor"), build_floor())
    move_to(collection("Walls"), build_walls())
    move_to(collection("Pillars"), build_pillars())
    move_to(collection("Props"), build_props())
    move_to(collection("Lights"), build_lights())
    move_to(collection("Camera"), build_camera())
    move_to(collection("Player"), build_player())

    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    path = os.path.join(repo, "tools", "blender", "arena.blend")
    bpy.ops.wm.save_as_mainfile(filepath=path)

    meshes = len([o for o in bpy.data.objects if o.type == "MESH"])
    print(f"LEVEL objects={meshes} collections={len(bpy.data.collections)}")
    print(f"LEVEL saved={path}")


if __name__ == "__main__":
    main()
