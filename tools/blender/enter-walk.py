"""Set the arena up for first-person walking, then hand the viewport over.

    blender tools/blender/arena.blend --python tools/blender/enter-walk.py

Blender has no game engine any more -- the BGE was removed in 2.8 -- so this
is not the game running inside Blender. What it is, is Blender's own Walk
Navigation with gravity and collision switched on, which lets you stand in the
map at eye height and move through it exactly as a player would. For the
actual game loop (shooting, the ricochet, enemies) the Godot project in godot/
is the thing to run.

Controls once you press Shift + `  (backtick, above Tab):

    W A S D   move            mouse   look
    Q / E     down / up       Shift   run,  Ctrl  walk slowly
    Space     jump            V       toggle gravity
    Esc       leave walk mode (Enter to confirm position)
"""

import bpy
from mathutils import Euler, Vector

# Eye height and pace of a person, so the arena's 2.2 m walls read at the
# scale they will have in play rather than as scenery.
VIEW_HEIGHT = 1.7
WALK_SPEED = 3.4
START_AT = Vector((0.0, -8.4, 1.7))


def configure_walk():
    walk = bpy.context.preferences.inputs.walk_navigation
    walk.use_gravity = True
    walk.view_height = VIEW_HEIGHT
    walk.jump_height = 1.4
    walk.walk_speed = WALK_SPEED
    walk.walk_speed_factor = 5.0
    walk.use_mouse_reverse = False
    bpy.context.preferences.inputs.use_mouse_continuous = True


def configure_viewport():
    """Material shading and a starting stance just inside the near wall."""
    for area in bpy.context.screen.areas:
        if area.type != "VIEW_3D":
            continue
        for space in area.spaces:
            if space.type != "VIEW_3D":
                continue
            space.shading.type = "MATERIAL"
            space.shading.use_scene_lights = True
            space.shading.use_scene_world = True
            space.clip_start = 0.05
            space.clip_end = 400.0
            region = space.region_3d
            region.view_perspective = "PERSP"
            # Looking down the arena from behind the player's spawn.
            region.view_location = START_AT + Vector((0.0, 6.0, -0.6))
            region.view_rotation = Euler((1.25, 0.0, 0.0), "XYZ").to_quaternion()
            region.view_distance = 9.0


def main():
    configure_walk()
    configure_viewport()
    print("WALK ready: press Shift + ` in the 3D viewport to walk the arena.")
    print(f"WALK gravity=on view_height={VIEW_HEIGHT} speed={WALK_SPEED}")


if __name__ == "__main__":
    main()
