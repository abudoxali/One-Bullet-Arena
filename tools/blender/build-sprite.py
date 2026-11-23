"""Bake a One Bullet Arena actor into a smooth cartoon sprite atlas.

Run headless:

    blender --background --factory-startup --python tools/blender/build-sprite.py -- --actor scout

Everything here is procedural. There is no .blend file to keep in sync: the
model, the materials, the camera rig and every animation pose are built from
this script, so a re-render is reproducible and reviewable as a diff.

THE PIXEL CONTRACT
------------------
The simulation runs in a 1280x720 logical space (src/game-data.js). Sprites are
baked at PIXELS_PER_UNIT pixels per logical unit and the runtime divides by it
again, so a scout whose collision radius is 17 occupies 34 logical units on
screen whatever density we bake at.

Density is 2, not 1. A smooth cartoon render has gradients to resolve, and on
any HiDPI display the canvas backing store is already 2x, so a 2x bake lands
one sprite pixel on one device pixel instead of being blown up. At 1x the
creature is 34 pixels wide and the shading turns to mush.

The camera sits 53.13 degrees above the horizon. That is the 3-4-5 triangle, so
the ground plane compresses by exactly sin = 0.8 and heights by cos = 0.6.

ART DIRECTION
-------------
Soft rounded creatures, smooth gradient shading, a bright fresnel rim on the
silhouette, and a grounded contact shadow. Exaggerated cartoon motion: strong
squash and stretch with volume preserved, overshoot on impacts, trailing
secondary action on the crest.

This replaced a hard-banded pixel-art bake. That version used a constant
ColorRamp to force three flat tones per material, killed antialiasing with
filter_size 0, and stamped a one pixel contour around the silhouette. All of
that is deliberately gone: antialiasing is back on, dithering is back on so
8-bit gradients do not band, and the rim replaces the contour.

LIGHTING IS A CALIBRATION
-------------------------
The character rotates and the lights do not, which is what makes a creature
facing the key read as lit and one facing away read as backlit -- correct for a
fixed arena light. The risk is that one of the eight yaws comes out too dark to
read, so the fill is deliberately generous and the rim is strong enough to hold
the silhouette on the darkest direction.
"""

import argparse
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Euler, Vector

# --------------------------------------------------------------------------
# Contract constants. Changing these means re-rendering every actor.
# --------------------------------------------------------------------------
PIXELS_PER_UNIT = 2
# 64 logical units across, not 48. A scout's body is only about 25 units wide,
# but the run lean and the death collapse swing it well past that: at 48 the
# measured content filled the cell edge to edge on direction 4 and frames were
# being clipped. The padding is transparent and costs almost nothing to draw.
WORLD_WIDTH = 64
FRAME = WORLD_WIDTH * PIXELS_PER_UNIT        # 128 px
CAMERA_TARGET_Z = 10.0
ELEVATION = math.atan2(4.0, 3.0)             # 53.13 deg
GROUND_COMPRESSION = math.sin(ELEVATION)     # 0.8
HEIGHT_SCALE = math.cos(ELEVATION)           # 0.6
ANCHOR_X = FRAME // 2                                                  # 48
ANCHOR_Y = int(FRAME / 2 + CAMERA_TARGET_Z * HEIGHT_SCALE * PIXELS_PER_UNIT)  # 60
DIRECTIONS = 8
ATLAS_COLUMNS = 16

# Palettes come from the STYLE table in src/render/cinematic-combat-art.js so
# the baked art and the surviving procedural VFX agree on each archetype.
ACTORS = {
    "scout": {
        "radius": 17,
        "core": "#ff6b7f",
        "fill": "#2a1020",
        "accent": "#ffb1bd",
        "eye": "#1b0a12",
    },
}

STATES = [
    # name,    frames, fps, loop
    ("idle",   6,  8, True),
    ("run",   14, 20, True),
    ("hit",    4, 18, False),
    ("death",  8, 14, False),
]


# --------------------------------------------------------------------------
# colour
# --------------------------------------------------------------------------
def srgb_to_linear(c):
    """Blender node colours are linear; the game's palette is sRGB hex."""
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_to_linear(value):
    value = value.lstrip("#")
    rgb = [int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    return tuple(srgb_to_linear(c) for c in rgb) + (1.0,)


def mix_hex(a, b, t):
    a = a.lstrip("#")
    b = b.lstrip("#")
    out = []
    for i in (0, 2, 4):
        ca = int(a[i:i + 2], 16)
        cb = int(b[i:i + 2], 16)
        out.append(int(round(ca + (cb - ca) * t)))
    return "#%02x%02x%02x" % tuple(out)


# --------------------------------------------------------------------------
# scene setup
# --------------------------------------------------------------------------
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = FRAME
    scene.render.resolution_y = FRAME
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    # Antialiasing on. The pixel-art bake set this to 0 for hard edges; smooth
    # art needs the reconstruction filter or every silhouette is a staircase.
    scene.render.filter_size = 1.5
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 90
    # Dither back on: it costs nothing here and stops 8-bit gradients banding.
    scene.render.dither_intensity = 1.0
    # Standard, not AgX: tone mapping would pull the render away from the
    # palette the rest of the game draws with.
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.display_settings.display_device = "sRGB"
    try:
        scene.eevee.taa_render_samples = 64
    except AttributeError:
        pass
    return scene


def smooth_material(name, base, rim, rim_strength=1.6, roughness=0.52, blend=0.26):
    """Principled body with a fresnel rim mixed in at grazing angles.

    The rim does the job the pixel bake gave to a drawn contour: it separates
    the creature from a lit floor. Being fresnel-driven it follows the form
    instead of tracing a flat outline, which is what the soft look needs.
    """
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    tree.nodes.clear()

    principled = tree.nodes.new("ShaderNodeBsdfPrincipled")
    principled.inputs["Base Color"].default_value = hex_to_linear(base)
    principled.inputs["Roughness"].default_value = roughness
    principled.inputs["Metallic"].default_value = 0.0

    weight = tree.nodes.new("ShaderNodeLayerWeight")
    weight.inputs["Blend"].default_value = blend

    emission = tree.nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = hex_to_linear(rim)
    emission.inputs["Strength"].default_value = rim_strength

    mix = tree.nodes.new("ShaderNodeMixShader")
    output = tree.nodes.new("ShaderNodeOutputMaterial")

    # Layer Weight 'Facing' is 0 head-on and 1 at the silhouette edge.
    tree.links.new(weight.outputs["Facing"], mix.inputs[0])
    tree.links.new(principled.outputs[0], mix.inputs[1])
    tree.links.new(emission.outputs[0], mix.inputs[2])
    tree.links.new(mix.outputs[0], output.inputs[0])
    return mat


def flat_material(name, colour, strength=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    tree.nodes.clear()
    emission = tree.nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = hex_to_linear(colour)
    emission.inputs["Strength"].default_value = strength
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(emission.outputs[0], output.inputs[0])
    return mat


def matte_material(name, colour, roughness=0.8):
    """No rim. For eyes and feet, which should sink rather than glow."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    tree.nodes.clear()
    principled = tree.nodes.new("ShaderNodeBsdfPrincipled")
    principled.inputs["Base Color"].default_value = hex_to_linear(colour)
    principled.inputs["Roughness"].default_value = roughness
    principled.inputs["Metallic"].default_value = 0.0
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(principled.outputs[0], output.inputs[0])
    return mat


def build_camera(scene):
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = WORLD_WIDTH
    cam_data.clip_start = 1.0
    cam_data.clip_end = 900.0
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)

    distance = 400.0
    view = Vector((0.0, math.cos(ELEVATION), -math.sin(ELEVATION)))
    cam.location = Vector((0.0, 0.0, CAMERA_TARGET_Z)) - view * distance
    cam.rotation_euler = Euler((math.pi / 2 - ELEVATION, 0.0, 0.0), "XYZ")
    scene.camera = cam
    return cam


def build_lights(scene):
    """Key, fill and a back rim.

    The fill is unusually strong for a three point rig. The actor rotates under
    fixed lights, so the yaw pointing away from the key would otherwise render
    as a dark blob, and every one of the eight has to stay readable in combat.
    """
    for name, location, energy, colour in (
        ("key", (-150.0, -90.0, 190.0), 4.2, (1.0, 0.97, 0.92)),
        ("fill", (150.0, -70.0, 70.0), 2.1, (0.66, 0.78, 1.0)),
        ("back", (20.0, 180.0, 120.0), 2.6, (1.0, 0.88, 0.95)),
    ):
        data = bpy.data.lights.new(name, type="SUN")
        data.energy = energy
        data.color = colour
        data.angle = math.radians(18.0)      # soft terminator
        obj = bpy.data.objects.new(name, data)
        obj.location = location
        obj.rotation_euler = (-Vector(location).normalized()).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(obj)

    # A dim ambient world so nothing ever reaches pure black.
    scene.world = bpy.data.worlds.new("world")
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = (0.16, 0.19, 0.28, 1.0)
    background.inputs["Strength"].default_value = 0.55


# --------------------------------------------------------------------------
# model
# --------------------------------------------------------------------------
def add_sphere(name, location, scale, material, parent):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=28, radius=1.0, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    obj.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    obj.parent = parent
    return obj


def build_scout(spec):
    """A plump, beaked little runner.

    The reference is a soft rounded creature, not an insect. An earlier bake
    made this archetype a spiky four-legged bug and it read as hostile clutter
    rather than as a character.

    The first soft version then failed differently: it was a smooth pink egg
    with a pale oval on the belly and small eyes, and from most of the eight
    yaws you could not tell which way it was pointed. Facing is not optional
    here -- the player has to read an approach at a glance -- so direction now
    comes from hard silhouette cues instead of surface detail: a beak out the
    front, a crest off the back, and eyes big enough to find at this size.
    The pale belly panel is gone; the highlight on the reference is lighting,
    not geometry, and as an object it just read as a growth.

    Overall width is held near 26 units so that a squashed frame still clears
    the cell with margin.
    """
    core = spec["core"]
    fill = spec["fill"]
    accent = spec["accent"]

    shell = smooth_material("scout_shell", core, mix_hex(accent, "#ffffff", 0.55), 1.8)
    beak_mat = smooth_material("scout_beak", mix_hex(accent, "#ffffff", 0.25),
                               mix_hex(accent, "#ffffff", 0.7), 1.4, roughness=0.44)
    crest_mat = smooth_material("scout_crest", mix_hex(core, accent, 0.55),
                                mix_hex(accent, "#ffffff", 0.6), 2.1)
    dark = matte_material("scout_dark", mix_hex(fill, core, 0.25))
    eye = matte_material("scout_eye", spec["eye"], roughness=0.25)
    glint = flat_material("scout_glint", "#ffffff", 1.4)

    root = bpy.data.objects.new("root", None)
    bpy.context.scene.collection.objects.link(root)

    parts = {}
    parts["base"] = add_sphere("base", (0, -0.5, 5.6), (12.4, 11.0, 6.0), shell, root)
    parts["body"] = add_sphere("body", (0, 0.5, 14.0), (11.0, 10.5, 11.5), shell, root)
    parts["beak"] = add_sphere("beak", (0, 11.5, 13.0), (3.0, 6.2, 2.6), beak_mat, root)
    parts["crest"] = add_sphere("crest", (0, -6.5, 22.5), (2.8, 5.6, 4.2), crest_mat, root)

    eyes, glints, feet = [], [], []
    for sx in (-1, 1):
        side = "l" if sx < 0 else "r"
        eyes.append(add_sphere(f"eye_{side}", (sx * 4.0, 8.4, 17.6), (2.9, 2.3, 3.2), eye, root))
        glints.append(add_sphere(f"glint_{side}", (sx * 3.2, 9.9, 18.7), (1.05, 0.8, 1.1), glint, root))
        feet.append(add_sphere(f"foot_{side}", (sx * 5.0, 5.6, 1.7), (3.6, 4.6, 1.9), dark, root))
    parts["eyes"] = eyes
    parts["glints"] = glints
    parts["feet"] = feet

    rest = {}
    for obj in root.children_recursive:
        rest[obj.name] = (obj.location.copy(), obj.rotation_euler.copy(), obj.scale.copy())
    return root, parts, rest


# --------------------------------------------------------------------------
# poses
# --------------------------------------------------------------------------
MAX_SPREAD = 1.30


def squash(obj, amount):
    """Scale vertically by `amount` and widen to keep the volume.

    Cartoon squash reads as wrong the moment the character gains or loses
    mass, so the horizontal gain is the inverse square root of the vertical
    loss rather than a hand-picked number.

    Both ends are clamped. Strict volume preservation at a 0.12 collapse
    wants a 2.9x spread, which threw the death frames clean out of the 96
    pixel cell -- the first bake of this style reported zero margin on every
    side because of exactly that. Past roughly a third of the original height
    the eye stops reading volume anyway and starts reading deformation.
    """
    amount = max(0.34, amount)
    obj.scale.z *= amount
    spread = min(MAX_SPREAD, 1.0 / math.sqrt(amount))
    obj.scale.x *= spread
    obj.scale.y *= spread


def apply_pose(root, parts, rest, state, frame, total):
    """Set every part transform for one frame.

    Poses are computed rather than keyframed. Direct transforms keep each
    frame exactly reproducible and let the squash maths stay explicit.
    """
    for obj in root.children_recursive:
        loc, rot, scale = rest[obj.name]
        obj.location = loc.copy()
        obj.rotation_euler = rot.copy()
        obj.scale = scale.copy()

    base = parts["base"]
    body = parts["body"]
    beak = parts["beak"]
    crest = parts["crest"]
    eyes = parts["eyes"]
    glints = parts["glints"]
    feet = parts["feet"]
    upper = [body, beak, crest] + eyes + glints
    phase = (frame / total) * math.tau

    if state == "idle":
        breath = math.sin(phase)
        squash(body, 1.0 + breath * 0.045)
        squash(base, 1.0 - breath * 0.030)
        for obj in upper:
            obj.location.z += breath * 0.9
        # The crest lags the breath by a quarter cycle: secondary action is
        # most of what sells a soft body as alive.
        crest.rotation_euler.x += math.radians(math.sin(phase - math.pi / 2) * 7.0)
        for i, foot in enumerate(feet):
            foot.location.z += max(0.0, math.sin(phase + i * math.pi)) * 0.35

    elif state == "run":
        # Two strides per loop. Contact squashes hard, apex stretches.
        stride = math.sin(phase * 2.0)
        lift = abs(math.sin(phase * 2.0))
        contact = max(0.0, -stride)
        airborne = max(0.0, stride)

        root.rotation_euler.x = math.radians(11.0 + airborne * 4.0)
        squash(body, 1.0 + airborne * 0.16 - contact * 0.20)
        squash(base, 1.0 + airborne * 0.10 - contact * 0.24)

        hop = lift * 3.4
        for obj in upper:
            obj.location.z += hop
        crest.rotation_euler.x += math.radians(-28.0 * airborne + 16.0 * contact)
        crest.location.y -= airborne * 1.6
        # The beak leads the body into the stride and settles on contact.
        beak.location.y += airborne * 1.8 - contact * 0.8
        beak.rotation_euler.x += math.radians(-7.0 * airborne)

        for i, foot in enumerate(feet):
            swing = math.sin(phase + i * math.pi)
            foot.location.y += swing * 4.6
            foot.location.z += max(0.0, swing) * 3.2 + hop * 0.35
            foot.rotation_euler.x += math.radians(swing * 26.0)
        # Eyes stay level while the body bounces: the head is the anchor the
        # player tracks, so it moves less than everything around it.
        for obj in eyes + glints:
            obj.location.z -= hop * 0.35

    elif state == "hit":
        # 0 impact, 1 deepest compression, 2 overshoot, 3 settle.
        curve = [0.55, 1.0, -0.45, -0.12][min(frame, 3)]
        amount = abs(curve)
        root.rotation_euler.x = math.radians(-18.0 * curve)
        squash(body, 1.0 - curve * 0.26)
        squash(base, 1.0 - curve * 0.20)
        for obj in upper:
            obj.location.y -= curve * 3.2
            obj.location.z -= max(0.0, curve) * 2.0
        crest.rotation_euler.x += math.radians(38.0 * curve)
        for i, eye_part in enumerate(eyes):
            # Eyes screw shut on the compression frames.
            eye_part.scale.z *= 1.0 - 0.55 * max(0.0, curve)
        for foot in feet:
            foot.location.y += curve * 1.8
        for obj in upper:
            obj.location.z += amount * 0.4

    elif state == "death":
        t = frame / (total - 1)
        ease = t * t * (3 - 2 * t)
        # A small pop before the collapse: going straight down reads as a
        # dropped object rather than as something being killed.
        pop = math.sin(min(1.0, t * 2.6) * math.pi) * (1.0 - ease)
        root.rotation_euler.x = math.radians(-28.0 * ease)
        root.location.z = -3.2 * ease
        squash(body, 1.0 + pop * 0.22 - ease * 0.62)
        squash(base, 1.0 - ease * 0.55)
        for obj in upper:
            obj.location.z += pop * 5.0 - ease * 7.0
        crest.rotation_euler.x += math.radians(74.0 * ease)
        for eye_part in eyes:
            eye_part.scale.z *= max(0.04, 1.0 - ease * 1.5)
        for glint in glints:
            glint.scale = Vector(glint.scale) * max(0.02, 1.0 - ease * 2.2)
        for i, foot in enumerate(feet):
            foot.location.y += (3.0 - i * 6.0) * ease
            foot.location.z += pop * 2.0

    bpy.context.view_layer.update()


# --------------------------------------------------------------------------
# render + pack
# --------------------------------------------------------------------------
def load_frame_pixels(path):
    """Read a rendered PNG back as raw stored values.

    Non-Color stops Blender converting the file's sRGB bytes into linear on
    load. The atlas is written back the same way, so the round trip is exact.
    """
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = "Non-Color"
    width, height = img.size
    buf = np.empty(width * height * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    bpy.data.images.remove(img)
    return buf.reshape(height, width, 4)


def clean_frame(pixels):
    """Drop all-but-invisible pixels.

    EEVEE leaves a haze of alpha around 0.01 from the soft lights. Left in, it
    compresses badly and shows as a faint halo once the sprite is drawn over a
    lit floor. Anything above the floor keeps its soft edge untouched -- this
    is a cleanup, not the hard threshold the pixel bake used.
    """
    out = pixels.copy()
    faint = out[:, :, 3] < 0.012
    out[faint] = 0.0
    return out


def render_actor(name, spec, out_dir, frames_dir, sheet_path=""):
    scene = reset_scene()
    build_camera(scene)
    build_lights(scene)
    root, parts, rest = build_scout(spec)

    plan = []
    index = 0
    for state, count, fps, loop in STATES:
        plan.append({"state": state, "start": index, "frames": count, "fps": fps, "loop": loop})
        index += count * DIRECTIONS

    rows = math.ceil(index / ATLAS_COLUMNS)
    atlas = np.zeros((rows * FRAME, ATLAS_COLUMNS * FRAME, 4), dtype=np.float32)

    os.makedirs(frames_dir, exist_ok=True)
    bounds = [FRAME, FRAME, 0, 0]       # min_x, min_y, max_x, max_y over all frames
    rendered = 0
    for entry in plan:
        state = entry["state"]
        count = entry["frames"]
        for direction in range(DIRECTIONS):
            for frame in range(count):
                root.rotation_euler = Euler((0.0, 0.0, 0.0), "XYZ")
                root.location = Vector((0.0, 0.0, 0.0))
                apply_pose(root, parts, rest, state, frame, count)
                # Direction goes on top of the pose so the pose maths never
                # has to know which way the actor is looking.
                root.rotation_euler.z = -direction * (math.tau / DIRECTIONS)
                bpy.context.view_layer.update()

                path = os.path.join(frames_dir, f"{name}_{state}_{direction}_{frame}.png")
                scene.render.filepath = path
                bpy.ops.render.render(write_still=True)

                pixels = clean_frame(load_frame_pixels(path))
                solid = pixels[:, :, 3] > 0.02
                if solid.any():
                    ys, xs = np.nonzero(solid)
                    # Blender rows are bottom-up; flip for frame coordinates.
                    top = FRAME - 1 - ys.max()
                    bottom = FRAME - 1 - ys.min()
                    bounds = [min(bounds[0], int(xs.min())), min(bounds[1], int(top)),
                              max(bounds[2], int(xs.max())), max(bounds[3], int(bottom))]

                cell = entry["start"] + direction * count + frame
                col = cell % ATLAS_COLUMNS
                row = cell // ATLAS_COLUMNS
                # Row 0 is the top band. Writing rows in reverse here silently
                # transposed the whole sheet -- the runtime read cell 0 and got
                # a death frame -- while each cell's own content still looked
                # upright, so nothing about the art gave the swap away.
                atlas[row * FRAME:(row + 1) * FRAME,
                      col * FRAME:(col + 1) * FRAME] = pixels
                rendered += 1

    os.makedirs(out_dir, exist_ok=True)
    atlas_path = os.path.join(out_dir, f"{name}.png")
    save_image(f"{name}_atlas", atlas, atlas_path)

    manifest = {
        "actor": name,
        "image": f"{name}.png",
        "frameWidth": FRAME,
        "frameHeight": FRAME,
        "pixelsPerUnit": PIXELS_PER_UNIT,
        "anchorX": ANCHOR_X,
        "anchorY": ANCHOR_Y,
        "columns": ATLAS_COLUMNS,
        "rows": rows,
        "directions": DIRECTIONS,
        "radius": spec["radius"],
        # Smooth art wants bilinear sampling. The runtime reads this rather
        # than assuming, so a pixel-art actor could still ship beside it.
        "filtering": "smooth",
        # The eight baked yaws are NOT evenly spaced on screen: the 0.8 ground
        # squash pulls the diagonals in to about 38.7 degrees. The runtime must
        # pick the nearest baked angle from this list rather than divide by 45.
        "groundCompression": round(GROUND_COMPRESSION, 4),
        "screenAngles": [
            round(math.atan2(-math.cos(-d * math.tau / DIRECTIONS) * GROUND_COMPRESSION,
                             -math.sin(-d * math.tau / DIRECTIONS)), 6)
            for d in range(DIRECTIONS)
        ],
        "states": {
            e["state"]: {"start": e["start"], "frames": e["frames"], "fps": e["fps"], "loop": e["loop"]}
            for e in plan
        },
    }
    with open(os.path.join(out_dir, f"{name}.json"), "w", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")

    if sheet_path:
        write_contact_sheet(atlas, plan, sheet_path)

    print(f"BAKE actor={name} cells={rendered} atlas={ATLAS_COLUMNS * FRAME}x{rows * FRAME}")
    print(f"BAKE content_bounds x={bounds[0]}..{bounds[2]} y={bounds[1]}..{bounds[3]} frame={FRAME}")
    print(f"BAKE margin left={bounds[0]} top={bounds[1]} right={FRAME - 1 - bounds[2]} bottom={FRAME - 1 - bounds[3]}")
    print(f"BAKE atlas_path={atlas_path}")


def save_image(name, rgba_top_down, path):
    image = bpy.data.images.new(name, rgba_top_down.shape[1], rgba_top_down.shape[0], alpha=True)
    image.colorspace_settings.name = "Non-Color"
    image.alpha_mode = "STRAIGHT"
    flat = np.ascontiguousarray(rgba_top_down[::-1]).reshape(-1).astype(np.float32)
    image.pixels.foreach_set(flat)
    image.filepath_raw = path
    image.file_format = "PNG"
    image.save()
    bpy.data.images.remove(image)


def write_contact_sheet(atlas, plan, path, zoom=3):
    """A zoomed, checkerboarded review sheet: eight yaws, then a run cycle."""
    by_state = {e["state"]: e for e in plan}

    def cell(index):
        row, col = divmod(index, ATLAS_COLUMNS)
        return atlas[row * FRAME:(row + 1) * FRAME, col * FRAME:(col + 1) * FRAME]

    idle, run = by_state["idle"], by_state["run"]
    death, hit = by_state["death"], by_state["hit"]
    rows = [
        [cell(idle["start"] + d * idle["frames"]) for d in range(DIRECTIONS)],
        [cell(run["start"] + 2 * run["frames"] + f) for f in range(0, run["frames"], 2)],
        [cell(hit["start"] + 2 * hit["frames"] + f) for f in range(hit["frames"])]
        + [cell(death["start"] + 2 * death["frames"] + f) for f in range(0, death["frames"], 2)],
    ]
    columns = max(len(r) for r in rows)

    height, width = len(rows) * FRAME, columns * FRAME
    sheet = np.zeros((height, width, 4), dtype=np.float32)
    for r, row in enumerate(rows):
        for c, tile in enumerate(row):
            sheet[r * FRAME:(r + 1) * FRAME, c * FRAME:(c + 1) * FRAME] = tile

    yy, xx = np.mgrid[0:height, 0:width]
    checker = np.where(((yy // 8 + xx // 8) % 2) == 0, 0.13, 0.19).astype(np.float32)
    alpha = sheet[:, :, 3:4]
    rgb = (sheet[:, :, :3] * alpha + np.dstack([checker] * 3) * (1.0 - alpha)).astype(np.float32)
    big = np.repeat(np.repeat(rgb, zoom, axis=0), zoom, axis=1).astype(np.float32)
    big = np.dstack([big, np.ones(big.shape[:2], dtype=np.float32)]).astype(np.float32)
    save_image("contact_sheet", big, path)
    print(f"BAKE sheet={path}")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--actor", default="scout", choices=sorted(ACTORS))
    parser.add_argument("--out", default="src/assets/sprites")
    parser.add_argument("--frames", default="")
    parser.add_argument("--sheet", default="", help="write a zoomed review sheet here")
    args = parser.parse_args(argv)

    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    out_dir = args.out if os.path.isabs(args.out) else os.path.join(repo, args.out)
    frames_dir = args.frames or os.path.join(repo, "tools", "blender", "_frames", args.actor)

    render_actor(args.actor, ACTORS[args.actor], out_dir, frames_dir, args.sheet)


if __name__ == "__main__":
    main()
