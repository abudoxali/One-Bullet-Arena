"""Shared Blender baking helpers for One Bullet Arena.

Both bakes -- actors (build-sprite.py) and the arena tileset
(build-tileset.py) -- have to agree on colour handling, light direction and
render settings, or the baked pieces will not sit together on screen. Keeping
that agreement in one module is the point of this file.

THE LIGHT IS A CONTRACT
-----------------------
Key from the upper left, fill from the right, rim from behind, and the camera
53.13 degrees above the horizon. Every asset in the game is lit this way, so a
wall's lit edge and a creature's lit edge fall on the same side and the two
read as being in the same room. Change the rig here and everything must be
re-baked together.

COLOUR MANAGEMENT
-----------------
`view_transform = 'Standard'` throughout. Blender defaults to AgX, which tone
maps the render and pulls it away from the palette the rest of the game draws
with in `src/ui-renderer.js` and `src/core/world-2d-runtime.js`.
"""

import math

import bpy
import numpy as np
from mathutils import Euler, Vector

# The camera's elevation is the 3-4-5 triangle, so the ground plane compresses
# by exactly sin = 0.8 and heights by cos = 0.6. Clean ratios keep the sprite
# grid and the wall heights honest against each other.
ELEVATION = math.atan2(4.0, 3.0)
# Written as exact rationals rather than sin/cos of the angle above. The
# triangle gives 4/5 and 3/5 exactly, but routing them through trig returns
# 0.6000000000000001, and a wall height that has to land on a whole number of
# screen pixels then fails its own consistency check.
GROUND_COMPRESSION = 0.8
HEIGHT_SCALE = 0.6


# --------------------------------------------------------------------------
# colour
# --------------------------------------------------------------------------
def srgb_to_linear(c):
    """Blender node colours are linear; the game's palette is sRGB hex."""
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_to_unit(value):
    """Plain 0..1 sRGB, for pixels read back under the Non-Color colourspace."""
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4)) + (1.0,)


def hex_to_linear(value):
    return tuple(srgb_to_linear(c) for c in hex_to_unit(value)[:3]) + (1.0,)


def mix_hex(a, b, t):
    """Blend two sRGB hex colours; used to derive each material's tones."""
    a = a.lstrip("#")
    b = b.lstrip("#")
    out = []
    for i in (0, 2, 4):
        ca = int(a[i:i + 2], 16)
        cb = int(b[i:i + 2], 16)
        out.append(int(round(ca + (cb - ca) * t)))
    return "#%02x%02x%02x" % tuple(out)


# --------------------------------------------------------------------------
# scene
# --------------------------------------------------------------------------
def new_scene(width, height, samples=64):
    """An empty EEVEE scene configured for transparent, palette-faithful bakes."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.filter_size = 1.5
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 90
    scene.render.dither_intensity = 1.0
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.display_settings.display_device = "sRGB"
    try:
        scene.eevee.taa_render_samples = samples
    except AttributeError:
        pass
    return scene


def ortho_camera(scene, ortho_scale, target=(0.0, 0.0, 0.0), elevation=ELEVATION, distance=400.0):
    """An orthographic camera looking toward +Y and down by `elevation`.

    `elevation` of pi/2 looks straight down, which is what floor and wall-top
    tiles want; the default 53.13 degrees is the three-quarter view everything
    standing up is baked from.
    """
    data = bpy.data.cameras.new("cam")
    data.type = "ORTHO"
    data.ortho_scale = ortho_scale
    data.clip_start = 1.0
    data.clip_end = distance * 2.5
    cam = bpy.data.objects.new("cam", data)
    scene.collection.objects.link(cam)

    view = Vector((0.0, math.cos(elevation), -math.sin(elevation)))
    cam.location = Vector(target) - view * distance
    cam.rotation_euler = Euler((math.pi / 2 - elevation, 0.0, 0.0), "XYZ")
    scene.camera = cam
    return cam


def three_point_lights(scene, key=4.2, fill=2.1, back=2.6, ambient=0.55):
    """The shared rig. See the module docstring: this direction is a contract.

    The fill is unusually strong for a three point rig because actors rotate
    under fixed lights, and the yaw facing away from the key still has to be
    readable in combat.
    """
    for name, location, energy, colour in (
        ("key", (-150.0, -90.0, 190.0), key, (1.0, 0.97, 0.92)),
        ("fill", (150.0, -70.0, 70.0), fill, (0.66, 0.78, 1.0)),
        ("back", (20.0, 180.0, 120.0), back, (1.0, 0.88, 0.95)),
    ):
        data = bpy.data.lights.new(name, type="SUN")
        data.energy = energy
        data.color = colour
        data.angle = math.radians(18.0)
        obj = bpy.data.objects.new(name, data)
        obj.location = location
        obj.rotation_euler = (-Vector(location).normalized()).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(obj)

    scene.world = bpy.data.worlds.new("world")
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = (0.16, 0.19, 0.28, 1.0)
    background.inputs["Strength"].default_value = ambient


# --------------------------------------------------------------------------
# materials
# --------------------------------------------------------------------------
def smooth_material(name, base, rim, rim_strength=1.6, roughness=0.52, blend=0.26):
    """Principled body with a fresnel rim mixed in at grazing angles.

    The rim separates an object from a lit floor the way a drawn contour would,
    but being fresnel-driven it follows the form instead of tracing a flat
    outline, which is what the soft cartoon look needs.
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


def matte_material(name, colour, roughness=0.8, metallic=0.0):
    """No rim. For surfaces that should sink rather than glow."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    tree.nodes.clear()
    principled = tree.nodes.new("ShaderNodeBsdfPrincipled")
    principled.inputs["Base Color"].default_value = hex_to_linear(colour)
    principled.inputs["Roughness"].default_value = roughness
    principled.inputs["Metallic"].default_value = metallic
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(principled.outputs[0], output.inputs[0])
    return mat


def flat_material(name, colour, strength=1.0):
    """Pure emission: one colour, never shaded."""
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


# --------------------------------------------------------------------------
# pixels
# --------------------------------------------------------------------------
def load_pixels(path):
    """Read a rendered PNG back as raw stored values.

    Non-Color stops Blender converting the file's sRGB bytes into linear on
    load. Images are written back the same way, so the round trip is exact and
    the palette the game sees is the palette the materials defined.
    """
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = "Non-Color"
    width, height = img.size
    buf = np.empty(width * height * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    bpy.data.images.remove(img)
    return buf.reshape(height, width, 4)


def save_image(name, rgba_top_down, path):
    """Write a top-down RGBA float array as a PNG."""
    image = bpy.data.images.new(name, rgba_top_down.shape[1], rgba_top_down.shape[0], alpha=True)
    image.colorspace_settings.name = "Non-Color"
    image.alpha_mode = "STRAIGHT"
    flat = np.ascontiguousarray(rgba_top_down[::-1]).reshape(-1).astype(np.float32)
    image.pixels.foreach_set(flat)
    image.filepath_raw = path
    image.file_format = "PNG"
    image.save()
    bpy.data.images.remove(image)


def clean_frame(pixels, floor=0.012):
    """Drop all-but-invisible pixels.

    EEVEE leaves a haze of alpha around 0.01 from the soft lights. Left in, it
    compresses badly and shows as a faint halo once the art is drawn over a lit
    floor. Anything above the floor keeps its soft edge untouched.
    """
    out = pixels.copy()
    out[out[:, :, 3] < floor] = 0.0
    return out


def render_to(scene, path):
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return load_pixels(path)
