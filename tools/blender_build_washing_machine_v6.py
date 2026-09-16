"""Photo-led washing-machine V6 geometry module.

The orchestrator supplies ``h`` and owns scenes, saving, exporting and checks.
Everything here is estimated from three site photographs, not a CAD dimension.
The broad tank, upright chamber, sloping loading hood, wide side cabinet and
unequal blue pump set are deliberate corrections to the old V4 silhouette.
"""

from __future__ import annotations

import math


def _flange(h, name, loc, radius, parent, axis="Z", mat="wash_pipe_green"):
    """A paired flange, visible gasket and six bolts, without ball-like joints."""
    x, y, z = loc
    h.cylinder(name + "_gasket", loc, radius * .94, .016,
               "gasket", parent, axis, 28)
    for side in (-1, 1):
        delta = side * .019
        p = (x + (delta if axis == "X" else 0),
             y + (delta if axis == "Y" else 0),
             z + (delta if axis == "Z" else 0))
        h.cylinder(name + "_plate", p, radius, .028, mat, parent, axis, 28)
    points = []
    for i in range(6):
        a = i * math.tau / 6
        u, v = radius * .76 * math.cos(a), radius * .76 * math.sin(a)
        if axis == "X":
            points.append((x - .043, y + u, z + v))
        elif axis == "Y":
            points.append((x + u, y - .043, z + v))
        else:
            points.append((x + u, y + v, z + .043))
    h.bolts(name + "_bolt", points, parent, axis, radius=.009)


def _side_label(h, name, text, loc, size, mat, parent):
    label = h.label(name, text, loc, size, mat, parent, front="X")
    label.rotation_euler[2] = -math.pi / 2
    return label


def _capsule_guard(h, parent):
    # The reference has a tall rounded yellow drive cover, not a round disk.
    cy, cz, radius, half_straight = -1.02, 3.68, .19, .42
    profile = []
    for i in range(13):
        a = i * math.pi / 12
        profile.append((cy + radius * math.cos(a),
                        cz + half_straight + radius * math.sin(a)))
    for i in range(13):
        a = math.pi + i * math.pi / 12
        profile.append((cy + radius * math.cos(a),
                        cz - half_straight + radius * math.sin(a)))
    verts = [(x, y, z) for x in (-1.076, -.950) for y, z in profile]
    n = len(profile)
    faces = [tuple(reversed(range(n))), tuple(range(n, n * 2))]
    faces += [(i, (i + 1) % n, (i + 1) % n + n, i + n)
              for i in range(n)]
    h.mesh("tall_rounded_lift_chain_guard", verts, faces,
           "wash_guard_yellow", parent, .007)
    for z in (3.10, 4.16):
        h.box("chain_guard_mount", (-.928, -1.02, z), (.11, .24, .11),
              "dark_structure", parent)
    h.bolts("chain_guard_fixing",
            [(-1.087, -1.02, z) for z in (3.13, 4.23)], parent, "X", .011)


def _tank_and_chamber(h):
    g = h.group("chassis")
    for x in (-.75, .75):
        h.box("tank_skid", (x, .03, .13), (.18, 2.98, .19),
              "dark_structure", g)
        for y in (-1.26, .06, 1.29):
            h.cylinder("levelling_foot", (x, y, .043), .083, .072,
                       "brushed_metal", g, sides=20)
            h.cylinder("levelling_stud", (x, y, .112), .021, .13,
                       "stainless", g, sides=12)
    for y in (-1.20, .04, 1.26):
        h.box("tank_crossmember", (0, y, .175), (1.79, .10, .15),
              "dark_structure", g)
    # A folded service skid supports the unevenly sized pump set.
    h.box("pump_skid_floor", (-1.47, .08, .115), (1.20, 2.93, .055),
          "stainless", g, .003)
    for x in (-2.055, -.92):
        h.box("pump_skid_folded_edge", (x, .08, .152), (.025, 2.93, .09),
              "brushed_metal", g, .003)
    for y in (-1.35, 1.51):
        h.box("pump_skid_end_return", (-1.48, y, .15), (1.18, .024, .085),
              "brushed_metal", g, .003)

    g = h.group("tank_shell")
    h.box("lower_water_tank_mass", (0, .015, .91), (1.80, 2.82, 1.40),
          "enamel_edge", g, .012)
    for side in (-1, 1):
        for i, y in enumerate((-.935, .0, .935)):
            h.box(f"tank_side_panel_{side}_{i}", (side * .918, y, .922),
                  (.035, .927, 1.37), "enamel", g, .004)
        h.box("tank_upper_fold", (side * .908, .015, 1.633),
              (.089, 2.91, .068), "stainless", g)
    for y in (-1.419, 1.45):
        h.box("tank_end_cladding", (0, y, .92), (1.81, .034, 1.385),
              "enamel", g, .005)
    h.box("tank_top", (0, .015, 1.643), (1.85, 2.92, .056),
          "enamel", g, .008)
    # Front transfer apron is shallow and broad, as in the site view.
    h.box("front_apron_face", (0, -1.465, 1.395), (1.41, .04, .32),
          "enamel_edge", g)
    h.box("front_apron_tray", (0, -1.625, 1.244), (1.45, .37, .044),
          "stainless", g)
    for x in (-.70, .70):
        h.box("front_apron_side_return", (x, -1.622, 1.34),
              (.038, .35, .22), "enamel", g)
    h.box("front_yellow_low_bumper", (0, -1.504, .38),
          (1.06, .17, .18), "wash_guard_yellow", g, .014)
    for x in (-.45, .45):
        h.box("bumper_mount", (x, -1.433, .30), (.11, .08, .22),
              "dark_structure", g)
    # Small, actually connected drain valve, with short lever.
    h.pipe("front_tank_drain", [(.67, -1.43, .31), (.67, -1.57, .31)],
           .021, "brass", g)
    h.cylinder("front_drain_valve", (.67, -1.55, .31), .033, .080,
               "brass", g, "Y", 12)
    h.box("front_drain_handle", (.67, -1.55, .365), (.12, .025, .014),
          "gasket", g, .002)

    g = h.group("upright_chamber_shell")
    # No solid central cube: the front opening and door pocket are real voids.
    for side in (-1, 1):
        for i, y in enumerate((-.64, .02, .68, 1.205)):
            width = .645 if i < 3 else .39
            h.box(f"tall_chamber_panel_{side}_{i}", (side * .855, y, 2.94),
                  (.060, width, 2.46), "enamel", g, .004)
        for y in (-1.005, -.325, .355, 1.035, 1.425):
            h.box("same_color_vertical_stiffener", (side * .913, y, 3.0),
                  (.070, .077, 2.69), "enamel", g, .004)
        for z in (1.79, 2.54, 3.29, 4.15):
            h.box("same_color_horizontal_stiffener", (side * .913, .19, z),
                  (.062, 2.50, .078), "enamel", g, .003)
    h.box("chamber_rear_skin", (0, 1.414, 2.965), (1.76, .06, 2.59),
          "enamel", g)
    # The rear roof terminates behind the door slot at y=-.88.
    h.box("rear_chamber_roof", (0, .277, 4.317), (1.80, 2.30, .09),
          "enamel", g)
    for x in (-.768, .768):
        h.box("tall_front_lift_column", (x, -1.09, 3.007),
              (.15, .21, 2.79), "enamel", g, .012)
        h.box("front_column_foot", (x, -1.09, 1.72),
              (.24, .29, .11), "enamel_edge", g)
    for y in (-.78, .49, 1.23):
        for x in (-.70, .70):
            h.box("lifting_lug_foot", (x, y, 4.37), (.13, .20, .14),
                  "enamel", g)
            eye = h.tube("true_open_lifting_eye", (x, y, 4.445),
                         .081, .042, .055, "enamel", g, 28)
            eye.rotation_euler[1] = math.pi / 2
    for y in (-.54, .58):
        h.box("red_top_junction_cover", (0, y, 4.398), (.62, .34, .14),
              "red", g, .012)
        for i in range(5):
            h.box("top_junction_louvre", (-.31, y -.115 + i * .056, 4.40),
                  (.011, .033, .052), "heat_black", g, .001)
    # Short collar: no disproportionately tall stack.
    h.tube("short_upper_vent", (.17, .63, 4.575), .155, .139, .40,
           "stainless", g, 36)
    h.tube("upper_vent_rolled_lip", (.17, .63, 4.777), .166, .139, .022,
           "stainless", g, 36)
    _capsule_guard(h, g)


def _mouth_and_lifting_door(h):
    g = h.group("loading_mouth_frame")
    for x in (-.735, .735):
        h.box("mouth_jamb", (x, -1.36, 2.40), (.11, .29, 1.42),
              "enamel_edge", g)
        h.box("mouth_stainless_jamb", (x * .94, -1.509, 2.40),
              (.055, .046, 1.34), "stainless", g)
        h.box("lift_guide", (x * .92, -1.12, 3.02),
              (.044, .043, 2.53), "stainless", g, .003)
    for z in (1.733, 3.075):
        h.box("mouth_cross_frame", (0, -1.36, z), (1.57, .29, .098),
              "enamel_edge", g)
    h.box("mouth_bottom_lip", (0, -1.48, 1.775), (1.46, .40, .05),
          "brushed_metal", g)
    for x in (-.694, .694):
        h.bolts("mouth_guide_fastener", [(x, -1.538, z)
                for z in (1.85, 2.40, 2.96)], g, "Y", .010)

    g = h.group("visible_chamber")
    for x in (-.646, .646):
        # Split jamb liners around the moving door and its folded crossbar.
        # A continuous liner here intersected each edge of the leaf by 18.5mm.
        h.box("chamber_reveal_front", (x, -1.30, 2.38), (.054, .14, 1.21),
              "heat_black", g)
        h.box("chamber_reveal_rear", (x, -.43, 2.38), (.054, 1.08, 1.21),
              "heat_black", g)
    h.box("chamber_dark_back", (0, .22, 2.40), (1.32, .045, 1.29),
          "heat_black", g)
    h.box("chamber_floor", (0, -.70, 1.746), (1.29, 1.65, .044),
          "brushed_metal", g)
    for x in (-.47, .47):
        # Loading guides stop either side of the door slot instead of passing
        # through the bottom of the closed leaf.
        h.box("inlet_roller_track_front", (x, -1.4325, 1.81), (.055, .435, .060),
              "brushed_metal", g)
        h.box("inlet_roller_track_rear", (x, -.53, 1.81), (.055, .96, .060),
              "brushed_metal", g)
    for i, y in enumerate((-1.43, -1.21, -.99, -.77, -.55, -.33)):
        h.cylinder(f"inlet_static_roller_{i}", (0, y, 1.846), .033, 1.15,
                   "stainless", g, "X", 18)
    # The basket-like load is intentionally omitted: its exact form is obscured.
    # One moving leaf only. Parent origin is closed, travel is applied externally.
    g = h.group("wash_door_lift", (0, -1.10, 2.406), dynamic=True)
    h.box("single_lift_door", (0, 0, 0), (1.275, .10, 1.224),
          "heat_black", g, .016)
    for x in (-.61, .61):
        h.box("door_edge_fold", (x, -.058, 0), (.027, .024, 1.17),
              "brushed_metal", g, .002)
    h.box("door_bottom_fold", (0, -.060, -.58), (1.23, .034, .057),
          "dark_structure", g, .003)
    h.box("door_upper_crossbar", (0, -.066, .52), (1.20, .046, .063),
          "dark_structure", g)
    g["preview_lift"] = .73
    g["closed_top"] = 3.018
    g["full_open_top"] = 4.288
    g["estimated_min_hood_clearance"] = .252

    g = h.group("black_sloping_hood")
    # Side profile in (y,z), front is y<0. Open underside admits the lifting leaf.
    profile = [(-1.825, 3.12), (-1.26, 4.56), (-.775, 4.56), (-.775, 3.12)]
    verts = [(x, y, z) for x in (-.87, .87) for y, z in profile]
    faces = [(3, 2, 1, 0), (4, 5, 6, 7),
             (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6)]
    hood = h.mesh("continuous_black_sloping_hood", verts, faces,
                  "heat_black", g, .007)
    # Explicit sheet thickness preserves readable lower folds without a lid.
    if hasattr(hood, "modifiers"):
        thickness = hood.modifiers.new("hood_sheet_thickness", "SOLIDIFY")
        thickness.thickness = .004
        thickness.offset = -1
    for x in (-.875, .875):
        h.box("hood_side_bottom_fold", (x, -1.29, 3.125),
              (.033, 1.08, .046), "stainless", g, .002)
    h.box("hood_front_fold", (0, -1.827, 3.123), (1.775, .035, .056),
          "stainless", g, .003)
    # A low, almost vertical brand strip follows the visible front face.
    plate = h.box("hood_brand_plate", (0, -1.703, 3.435),
                  (.87, .016, .20), "heat_black", g, .002)
    plate.rotation_euler[0] = -math.atan2(.565, 1.44)
    text = h.label("hood_brand", "KINGKIND", (0, -1.72, 3.445),
                   .115, "red", g)
    text.rotation_euler[0] -= math.atan2(.565, 1.44)
    for z in (3.343, 3.525):
        y = -1.825 + (z - 3.12) * .565 / 1.44 - .015
        h.box("brand_red_frame_horizontal", (0, y, z),
              (.90, .012, .012), "red", g, .001)
    for x in (-.447, .447):
        bar = h.box("brand_red_frame_vertical", (x, -1.712, 3.435),
                    (.012, .014, .184), "red", g, .001)
        bar.rotation_euler[0] = -math.atan2(.565, 1.44)

    g = h.group("door_drive_housing")
    h.motor("wash_door_lift_motor", (.91, -1.13, 3.06), .43, "Z", g)
    h.box("door_motor_mount", (.914, -1.03, 2.877), (.24, .22, .08),
          "enamel_edge", g)
    h.pipe("door_motor_power", [(1.00, -1.16, 3.09), (1.035, -.94, 3.09),
                               (1.035, -.92, 2.68), (.91, -.92, 2.66)],
           .012, "gasket", g, .07)


def _control_cabinet(h):
    g = h.group("wide_control_cabinet")
    # Wide double doors in the YZ plane, mounted beside the tank, not a tower.
    cx, cy, cz = -1.217, -.46, 2.206
    h.box("cabinet_back_housing", (cx, cy, cz), (.40, 1.46, 2.26),
          "enamel_edge", g, .012)
    for i, y in enumerate((-.825, -.095)):
        h.box(f"cabinet_door_{i}", (-1.431, y, cz), (.034, .719, 2.205),
              "enamel", g, .009)
        for z in (1.29, 3.11):
            h.box("cabinet_hinge", (-1.461, y + (-.32 if i == 0 else .32), z),
                  (.027, .035, .094), "enamel_edge", g, .004)
        h.box("cabinet_warning_patch", (-1.455, y, 1.66),
              (.010, .30, .085), "dial", g, .001)
        h.box("cabinet_warning_header", (-1.464, y, 1.696),
              (.010, .30, .014), "wash_guard_yellow", g, .001)
        _side_label(h, "cabinet_caution", "CAUTION", (-1.473, y, 1.669),
                    .025, "gasket", g)
    h.box("cabinet_center_door_gap", (-1.45, -.46, cz), (.012, .009, 2.18),
          "gasket", g, .001)
    h.box("cabinet_lock_backplate", (-1.461, -.525, 2.05), (.027, .045, .35),
          "gasket", g, .004)
    h.box("cabinet_vertical_lock_handle", (-1.490, -.525, 2.07),
          (.031, .028, .285), "dark_structure", g, .005)
    h.cylinder("cabinet_keyhole", (-1.508, -.525, 1.936), .012, .016,
               "stainless", g, "X", 12)
    for y, width, height, z in ((-.89, .23, .25, 2.40), (-.10, .32, .265, 2.40)):
        h.box("panel_screen_bezel", (-1.467, y, z), (.040, width, height),
              "dark_structure", g, .011)
        h.box("panel_screen_recess", (-1.493, y, z + .007),
              (.012, width - .039, height - .045), "screen", g, .005)
        for row in range(3):
            h.box("screen_ui_readout", (-1.502, y, z + .060 - row * .05),
                  (.003, width * .56, .008), "screen_light", g, .001)
    for j, mat in enumerate(("red", "green", "gasket", "gasket")):
        yy = -.29 + j * .105
        h.cylinder("cabinet_button_collar", (-1.479, yy, 2.06), .027, .027,
                   "brushed_metal", g, "X", 20)
        h.cylinder("cabinet_button_cap", (-1.50, yy, 2.06), .018, .023,
                   mat, g, "X", 20)
    _side_label(h, "cabinet_brand", "KINGKIND", (-1.46, -.46, 3.10),
                .087, "red", g)
    # Broad side louvre; blades are recessed and angled rather than dots.
    h.box("cabinet_louvre_recess", (-1.22, -1.200, 2.77),
          (.29, .018, .39), "dark_structure", g, .005)
    for i in range(11):
        blade = h.box("cabinet_louvre_blade", (-1.22, -1.217, 2.594 + i * .034),
                      (.295, .021, .021), "enamel_edge", g, .002)
        blade.rotation_euler[0] = math.radians(-22)
    h.box("cabinet_lower_cable_tray", (-1.205, -.46, .997),
          (.39, 1.50, .102), "enamel_edge", g)
    for i in range(14):
        h.cylinder("cabinet_cable_gland", (-1.22, -1.10 + i * .10, 1.070),
                   .017, .060, "stainless", g, sides=12)
    for y in (-1.04, .12):
        h.box("cabinet_mount_column", (-1.034, y, 1.74), (.10, .10, 1.61),
              "enamel_edge", g)
    # Signal tower sits on cabinet, not a floating decorative sphere.
    h.cylinder("beacon_mount", (-1.20, -.03, 3.388), .045, .10,
               "stainless", g, sides=20)
    for z, mat in ((3.467, "green"), (3.535, "dial"), (3.603, "red")):
        h.cylinder("beacon_segment", (-1.20, -.03, z), .042, .064,
                   mat, g, sides=24)
    h.cylinder("beacon_cap", (-1.20, -.03, 3.641), .045, .013,
               "stainless", g, sides=24)
    # A small, front-facing pendant seen on the tank rim.
    h.box("front_local_button_box", (.94, -1.10, 1.907),
          (.17, .16, .44), "enamel", g)
    for row in range(3):
        for x in (.897, .975):
            h.cylinder("local_operator_button", (x, -1.19, 1.78 + row * .095),
                       .018, .020, "red" if row == 2 else "gasket", g, "Y", 16)
    h.pipe("pendant_cable", [(.96, -1.035, 1.72), (.96, -.81, 1.70),
                             (.88, -.77, 1.63)], .010, "gasket", g, .06)


def _pump(h, index, y, scale, main, static_parent):
    """Horizontal pump on its own feet. Only its short shaft can rotate."""
    g = static_parent
    s = scale
    z = .23 + .16 * s
    casing_x = -1.21
    motor_x = casing_x - .31 * s
    blue = "wash_pump_blue"
    h.box(f"pump_{index}_baseplate", (motor_x -.03, y, .208),
          (.76 * s, .45 * s, .068), blue, g, .012)
    for xx in (motor_x -.27 * s, motor_x + .22 * s):
        for yy in (y -.18 * s, y + .18 * s):
            h.cylinder(f"pump_{index}_base_anchor", (xx, yy, .252),
                       .016, .022, "stainless", g, sides=6)
    h.cylinder(f"pump_{index}_motor_body", (motor_x -.09 * s, y, z),
               .151 * s, .40 * s, blue, g, "X", 28)
    for i in range(15):
        a = i * math.tau / 15
        fin = h.box(f"pump_{index}_cooling_fin",
                    (motor_x -.09 * s, y + .151 * s * math.cos(a),
                     z + .151 * s * math.sin(a)),
                    (.375 * s, .014 * s, .033 * s), blue, g, .002)
        fin.rotation_euler[0] = a - math.pi / 2
    h.cylinder(f"pump_{index}_rear_fan_cover", (motor_x -.335 * s, y, z),
               .159 * s, .10 * s, blue, g, "X", 28)
    h.cylinder(f"pump_{index}_dark_end_disc", (motor_x -.389 * s, y, z),
               .121 * s, .009, "dark_structure", g, "X", 24)
    for i in range(-3, 4):
        zz = i * .027 * s
        chord = math.sqrt((.108 * s) ** 2 - zz ** 2)
        h.box(f"pump_{index}_fan_grille", (motor_x -.397 * s, y, z + zz),
              (.012, 2 * chord, .012 * s), blue, g, .001)
    h.box(f"pump_{index}_terminal_box", (motor_x -.045 * s, y, z + .167 * s),
          (.17 * s, .17 * s, .12 * s), blue, g, .007)
    for xx in (motor_x -.21 * s, motor_x + .045 * s):
        h.box(f"pump_{index}_motor_foot", (xx, y, .275),
              (.073 * s, .34 * s, .085), blue, g, .005)
    # Flattened centrifugal volute and bolted cover, not a spherical blob.
    casing_radius = .189 * s
    h.cylinder(f"pump_{index}_volute", (casing_x, y, z), casing_radius,
               .165 * s, blue if main else "stainless", g, "X", 32)
    h.cylinder(f"pump_{index}_volute_cover", (casing_x -.09 * s, y, z),
               casing_radius * .91, .023, blue if main else "brushed_metal",
               g, "X", 32)
    points = [(casing_x -.107 * s, y + casing_radius * .73 * math.cos(a),
               z + casing_radius * .73 * math.sin(a))
              for a in (i * math.tau / 6 for i in range(6))]
    h.bolts(f"pump_{index}_cover_bolt", points, g, "X", .009)
    h.cylinder(f"pump_{index}_fixed_coupling", (motor_x + .16 * s, y, z),
               .082 * s, .082 * s, "dark_structure", g, "X", 24)
    rotor_name = f"wash_pump_{index:02d}_shaft_rotate"
    rotor = h.group(rotor_name, (motor_x + .222 * s, y, z), dynamic=True)
    h.cylinder(f"pump_{index}_shaft", (0, 0, 0), .028 * s, .078 * s,
               "stainless", rotor, "X", 16)
    h.box(f"pump_{index}_shaft_key", (0, .030 * s, 0),
          (.035 * s, .012 * s, .016 * s), "brushed_metal", rotor, .001)
    # Short axial suction spool enters the lower tank. A double hairpin in
    # this tiny gap cannot accommodate the largest pipe's diameter without
    # folding its inside surface. Hidden routing is intentionally simplified.
    h.pipe(f"pump_{index}_inlet", [(casing_x + .085 * s, y, z),
                                  (-.865, y, z)],
           .055 * s, "wash_pipe_green", g, .12 * s)
    _flange(h, f"pump_{index}_inlet_flange", (casing_x + .126 * s, y, z),
            .095 * s, g, "X")
    discharge_top = z + casing_radius + .14
    h.pipe(f"pump_{index}_discharge_neck", [(casing_x, y, z + .1 * s),
                                          (casing_x, y, discharge_top)],
           .049 * s, "wash_pipe_green", g)
    _flange(h, f"pump_{index}_discharge_flange", (casing_x, y, discharge_top -.04),
            .088 * s, g)
    if not main:
        h.pipe(f"pump_{index}_small_riser", [(casing_x, y, discharge_top),
                                            (casing_x, y, .99),
                                            (-1.035, y, 1.06),
                                            (-1.035, y, 1.52),
                                            (-.905, y, 1.52)],
               .027 * s, "wash_pipe_green", g, .085)
        h.cylinder(f"pump_{index}_isolation_valve", (casing_x, y, .84),
                   .041 * s, .10, "brass", g, sides=12)
        h.rod(f"pump_{index}_valve_stem", (casing_x, y, .84),
              (casing_x -.07, y, .84), .010, "stainless", g)
        h.box(f"pump_{index}_valve_lever", (casing_x -.075, y + .045, .845),
              (.021, .145, .016), "gasket", g, .003)
    h.pipe(f"pump_{index}_power_cable", [(motor_x -.05, y + .07, z + .22 * s),
                                        (motor_x -.10, y + .23 * s, z + .31 * s),
                                        (-1.03, y + .23 * s, .78),
                                        (-1.03, y, 1.045)],
           .011, "gasket", g, .11)
    return rotor_name, (casing_x, y, discharge_top)


def _pipes_and_pumps(h):
    g = h.group("pump_housings")
    bindings = []
    main_start = None
    for i, (y, size) in enumerate(((-1.04, .71), (-.39, .79), (.39, 1.16), (1.17, .82)), 1):
        node, discharge = _pump(h, i, y, size, i == 3, g)
        bindings.append({"id": f"wash_pump_{i}_speed", "node_name": node,
                         "source_group": "motors", "source_key": f"wash_pump_{i}_speed",
                         "action": "rotate_speed", "axis": "x", "speed_factor": .18})
        if i == 3:
            main_start = discharge

    g = h.group("green_process_pipework")
    x, y, z = main_start
    h.pipe("large_inverted_u_supply", [(x, y, z), (x, y, 3.957),
                                       (x, -.715, 3.957),
                                       (-.740, -.715, 3.957)],
           .067, "wash_pipe_green", g, .20)
    for zz in (1.10, 2.80):
        _flange(h, "large_main_riser_flange", (x, y, zz), .118, g)
    _flange(h, "large_main_wall_flange", (-.948, -.715, 3.957), .115, g, "X")
    for zz in (1.70, 3.18):
        h.box("riser_wall_standoff", (-1.045, y, zz), (.31, .070, .054),
              "stainless", g, .003)
        ring = h.tube("riser_clamp_ring", (x, y, zz), .077, .069, .030,
                      "stainless", g, 24)
        h.box("riser_clamp_tab", (x -.066, y, zz), (.035, .12, .030),
              "stainless", g, .002)
    # Distinct horizontal supply/return branches, only on the service face.
    h.pipe("mid_green_return_header", [(-.75, 1.29, 1.80), (-1.071, 1.29, 1.80),
                                       (-1.071, .61, 1.80), (-1.071, .61, 2.18),
                                       (-.75, .61, 2.18)],
           .045, "wash_pipe_green", g, .12)
    h.pipe("upper_green_process_branch", [(-.86, 1.27, 3.03), (-1.06, 1.27, 3.03),
                                          (-1.06, .66, 3.03), (-1.06, .66, 2.05),
                                          (-.86, .66, 2.05)],
           .025, "wash_pipe_green", g, .075)
    h.pipe("thin_long_green_return", [(-.86, 1.32, .62), (-1.092, 1.32, .62),
                                      (-1.092, 1.32, 2.50),
                                      (-1.092, -.74, 2.50), (-.857, -.74, 2.50)],
           .018, "wash_pipe_green", g, .06)
    for yy, zz in ((.61, 2.30), (1.27, 2.84), (1.32, .78)):
        h.cylinder("branch_union", (-1.075, yy, zz), .039, .085,
                   "wash_pipe_green", g, sides=12)
    # Visible teal actuators and compact valve castings; no invented white filters.
    for yy in (.73, 1.26):
        h.pipe("high_valve_feed", [(-.852, yy, 2.69), (-1.092, yy, 2.69),
                                   (-1.092, yy, 2.50)],
               .018, "wash_pipe_green", g, .085)
        h.cylinder("high_valve_return_union", (-1.092, yy, 2.54), .028, .067,
                   "wash_pipe_green", g, "Z", 12)
        h.cylinder("high_valve_body", (-1.032, yy, 2.697), .083, .17,
                   "brushed_metal", g, "X", 24)
        h.box("high_teal_actuator", (-1.131, yy, 2.729), (.125, .16, .12),
              "motor_teal", g, .008)
        h.cylinder("actuator_endcap", (-1.209, yy, 2.730), .049, .025,
                   "motor_teal", g, "X", 20)
        h.pipe("high_valve_small_lead", [(-1.11, yy, 2.80), (-1.11, yy, 2.94),
                                        (-.864, yy, 2.94)],
               .011, "wash_pipe_green", g, .06)
    h.pipe("cyan_utility_supply", [(-.87, 1.40, 1.18), (-1.10, 1.40, 1.18),
                                   (-1.10, -.97, 1.18), (-.895, -.97, 1.18)],
           .018, "air_cyan", g, .07)
    for yy in (.55, 1.28):
        h.cylinder("utility_brass_union", (-1.10, yy, 1.18), .031, .064,
                   "brass", g, "Y", 12)
    h.pipe("rear_service_drain", [(-.865, 1.38, .37), (-1.045, 1.38, .37),
                                  (-1.045, 1.38, .60)],
           .021, "brass", g, .06)
    h.box("rear_drain_red_lever", (-1.047, 1.425, .64), (.025, .17, .018),
          "red", g, .003)
    return bindings


def build(h):
    """Build one root-relative asset and return export/verification intent."""
    h.material("wash_pipe_green", (.015, .245, .052), .18, .29)
    h.material("wash_pump_blue", (.019, .082, .33), .28, .35)
    h.material("wash_guard_yellow", (1.0, .55, .008), .05, .39)
    _tank_and_chamber(h)
    _mouth_and_lifting_door(h)
    _control_cabinet(h)
    bindings = [{"id": "wash_door_open", "node_name": "wash_door_lift",
                 "source_group": "status", "source_key": "wash_door_open",
                 "action": "translate", "axis": "y", "output_max": 1.27}]
    bindings += _pipes_and_pumps(h)
    return {
        "model_id": "photo_washing_machine_v6",
        "family": "清洗机",
        "views": [
            {"suffix": "preview", "camera": (-6.7, -7.3, 5.4),
             "target": (-.35, -.04, 2.25), "scale": 6.45},
            {"suffix": "rear", "camera": (-6.8, 6.3, 4.8),
             "target": (-.39, .04, 2.27), "scale": 6.40},
        ],
        "bindings": bindings,
        "shell_groups": ["tank_shell", "upright_chamber_shell", "black_sloping_hood"],
        "notes": [
            "照片估算外观重建，非实测 CAD；只重建照片可见设备本体，不含厂房平台。",
            "恢复下部大水箱、上部高耸竖腔、前端黑色斜罩；移除 V4 缺少照片依据的顶部平台轮廓。",
            "控制柜为侧面宽双门柜，带门缝、双屏、侧百叶、底部电缆槽和叠层信号灯。",
            "绿色倒 U 主管、回路支管、真实弯头法兰；蓝色泵为一大三小，不复制同尺寸泵或添加白色滤筒。",
            "单扇提升门具有真实开口与上部容纳空间；1.27 米行程属于示意参数，须实测校准。",
            "四个泵仅独立轴节点旋转，外壳与电机固定；GLB X 轴绑定，不旋转泵壳。",
            "装料滚筒及未见内部泵叶轮按最小示意处理，不声称照片遮挡结构准确。",
        ],
        "reference_photos": [
            "清洗机/mmexport1783325196484.jpg",
            "清洗机/mmexport1783325197891.jpg",
            "清洗机/mmexport1783325199288.jpg",
        ],
        "checks": [{"kind": "door_ray", "node_name": "wash_door_lift",
                    "origin": (0, -2.3, 2.43), "direction": (0, 1, 0),
                    "travel": 1.27, "axis": "z"}],
    }
