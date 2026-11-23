"""Restyle a downloaded CC0 character and export it as glTF for Godot.

    blender --background --disable-autoexec <source.blend> \
        --python tools/blender/import-actor.py -- \
        --name scout --length 1.9 --core "#ff6b7f" --fill "#2a1020" --accent "#ffb1bd"

Source models are the CC0 "Easy Animated Enemy Pack" by Quaternius. They
arrive rigged, with named actions, and in their own scale and palette. This
script keeps the rig and the animations untouched and changes only the two
things that have to match this game: size and colour.

WHY THE MATERIALS ARE REPLACED RATHER THAN TINTED
-------------------------------------------------
The pack ships each creature with a small texture atlas and two or three flat
materials. Tinting the atlas would drag every creature toward the same hue.
Replacing the materials instead lets each archetype keep the palette the JS
build already assigns it in src/render/cinematic-combat-art.js, so the colour
language carries over from the game that is being rebuilt.

The rim shader is the same one bakelib builds for everything else, so a model
exported here is lit consistently with the arena once it is in the scene.

WHAT IS DELIBERATELY NOT DONE
-----------------------------
Nothing touches the armature, the bone names or the actions. Retargeting or
re-rigging a CC0 asset is how you end up with animations that almost work;
the pack's own rig is already correct for its own mesh.
"""

import argparse
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bakelib  # noqa: E402


def strip_scene():
    """Drop anything that is not the character. Source files ship a camera and
    lights, and exporting those would light the model twice in Godot."""
    for obj in list(bpy.data.objects):
        if obj.type in {"CAMERA", "LIGHT", "SPEAKER"}:
            bpy.data.objects.remove(obj, do_unlink=True)


def find_rig():
    armature = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    return armature, meshes


def restyle(meshes, core, fill, accent, rim):
    """Swap every material slot for the game's palette.

    Slot 0 is the creature's body in every model in this pack and slot 1 is
    its secondary (claws, shell, wings), so the mapping is positional. A
    model with more slots reuses the fill, which is the safe direction: an
    unexpected part reads as part of the silhouette rather than glowing.

    The rim is much weaker here than in the sprite bakes. There it had to
    separate a 48 pixel silhouette with no scene lighting behind it; in Godot
    the same model sits under three directional lights and an ambient term,
    and a rim strength of 1.6 blew every creature out to white.
    """
    body = bakelib.smooth_material("actor_body", core, bakelib.mix_hex(accent, "#ffffff", 0.5), rim)
    second = bakelib.smooth_material("actor_second", fill, bakelib.mix_hex(accent, core, 0.5), rim * 0.7)

    for mesh in meshes:
        slots = mesh.data.materials
        for index in range(len(slots)):
            slots[index] = body if index == 0 else second
        if not slots:
            slots.append(body)


def rescale(armature, meshes, target_length):
    """Normalise so the creature's longest horizontal axis is `target_length`.

    The pack is authored at its own scale (the rat is nearly 7 units long).
    The game's collision radii come from the JS build -- a scout is 0.85 m --
    so every actor has to be brought into metres or it will not match its own
    hitbox.

    Scale goes on the armature as a node transform rather than being applied
    to the mesh: applying it would bake into the rest pose and leave the
    action translation curves in the old units.
    """
    extent = 0.0
    for mesh in meshes:
        extent = max(extent, mesh.dimensions.x, mesh.dimensions.y)
    if extent <= 0.0001:
        return 1.0
    factor = target_length / extent
    root = armature if armature is not None else meshes[0]
    root.scale = (factor, factor, factor)
    return factor


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True)
    parser.add_argument("--length", type=float, default=1.9)
    parser.add_argument("--core", default="#ff6b7f")
    parser.add_argument("--fill", default="#2a1020")
    parser.add_argument("--accent", default="#ffb1bd")
    parser.add_argument("--rim", type=float, default=0.3, help="fresnel rim strength")
    parser.add_argument("--out", default="godot/assets/actors")
    args = parser.parse_args(argv)

    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    out_dir = args.out if os.path.isabs(args.out) else os.path.join(repo, args.out)
    os.makedirs(out_dir, exist_ok=True)

    strip_scene()
    armature, meshes = find_rig()
    if not meshes:
        raise SystemExit("no mesh in source file")

    restyle(meshes, args.core, args.fill, args.accent, args.rim)
    factor = rescale(armature, meshes, args.length)
    bpy.context.view_layer.update()

    actions = [a.name for a in bpy.data.actions]
    path = os.path.join(out_dir, f"{args.name}.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_animations=True,
        # Every action becomes its own clip rather than one long timeline, so
        # Godot's AnimationPlayer gets named clips it can cross-fade.
        export_animation_mode="ACTIONS",
        export_apply=False,
        use_selection=False,
    )

    print(f"ACTOR name={args.name} scale={factor:.4f} actions={len(actions)}")
    print(f"ACTOR clips={','.join(sorted(actions))}")
    print(f"ACTOR out={path}")


if __name__ == "__main__":
    main()
