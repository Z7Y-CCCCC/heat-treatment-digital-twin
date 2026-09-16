"""Photo-led tempering-furnace V6 module for the shared V6 build harness.

All dimensions are estimated from the supplied photographs, not measured.
This module deliberately does not connect to Blender, save, render, or export.
The harness supplies geometry helpers through ``h`` and owns the new scene.
"""

from __future__ import annotations

import math


def _rounded_panel(h, name, width, height, depth, radius, mat, parent):
    """One solid sheet with genuinely round X/Z corners, not stacked doors."""
    outline = []
    for cx, cz, start in (
        (width / 2 - radius, height / 2 - radius, 0),
        (-width / 2 + radius, height / 2 - radius, 90),
        (-width / 2 + radius, -height / 2 + radius, 180),
        (width / 2 - radius, -height / 2 + radius, 270),
    ):
        for i in range(9):
            a = math.radians(start + i * 90 / 8)
            outline.append((cx + radius * math.cos(a), cz + radius * math.sin(a)))
    n = len(outline)
    vertices = [(x, y, z) for y in (-depth / 2, depth / 2) for x, z in outline]
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    faces.extend((i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n))
    return h.mesh(name, vertices, faces, mat, parent, bevel=.002)


def _rail(h, name, start, end, parent, radius=.019):
    return h.rod(name, start, end, radius, "safety_yellow", parent, sides=12)


def build(h):
    h.material("temper_shell", (.66, .70, .69), metallic=.07, roughness=.41)
    h.material("temper_shell_edge", (.53, .59, .58), metallic=.12, roughness=.43)
    h.material("temper_hood", (.15, .175, .17), metallic=.43, roughness=.39)
    h.material("temper_door", (.024, .029, .031), metallic=.14, roughness=.63)
    h.material("temper_lining", (.245, .225, .185), metallic=0, roughness=.89)
    h.material("temper_chain", (.079, .09, .085), metallic=.63, roughness=.43)

    chassis = h.group("chassis")
    for x in (-.91, .91):
        h.box("open_skid_longitudinal", (x, .23, .17), (.18, 3.28, .17), "temper_shell_edge", chassis)
        for y in (-1.17, 1.56):
            h.box("welded_base_foot", (x, y, .055), (.29, .31, .045), "brushed_metal", chassis, .003)
            h.bolts("base_anchor", [(x - .09, y, .083), (x + .09, y, .083)], chassis, axis="Z", radius=.019)
            h.box("short_structural_leg", (x, y, .52), (.27, .23, .62), "temper_shell", chassis)
    for y in (-1.18, .35, 1.58):
        h.box("open_skid_crossmember", (0, y, .20), (1.93, .16, .16), "temper_shell", chassis)
    # The open gap between the feet remains real geometry, rather than a plinth cube.
    h.box("underbody_pan", (0, .28, .79), (1.94, 2.76, .12), "temper_shell_edge", chassis)

    shell = h.group("thermal_shell")
    for x in (-.93, .93):
        h.box("insulated_side_wall", (x, .31, 2.04), (.20, 2.80, 2.49), "temper_shell", shell, .010)
        # Projecting same-colour flanges are prominent in all the side photographs.
        for y in (-1.075, -.38, .34, 1.06, 1.69):
            h.box("side_vertical_stiffener", (x * 1.102, y, 2.04), (.13, .036, 2.55), "temper_shell", shell, .003)
        for z in (.81, 1.22, 2.28, 3.32):
            h.box("side_horizontal_stiffener", (x * 1.102, .31, z), (.13, 2.84, .036), "temper_shell", shell, .003)
    h.box("rear_insulated_wall", (0, 1.69, 2.04), (1.86, .17, 2.49), "temper_shell", shell, .010)
    for x in (-.83, 0, .83):
        h.box("rear_vertical_stiffener", (x, 1.796, 2.05), (.038, .12, 2.56), "temper_shell", shell, .003)
    for z in (.81, 1.22, 2.28, 3.32):
        h.box("rear_horizontal_stiffener", (0, 1.796, z), (1.86, .12, .036), "temper_shell", shell, .003)
    h.box("roof_insulation_cap", (0, .31, 3.35), (2.07, 2.90, .13), "temper_shell", shell)
    # Front assembled from jambs/lintel/sill: no hidden full box blocking the mouth.
    for x in (-.817, .817):
        h.box("front_thick_jamb", (x, -1.077, 1.75), (.25, .19, 1.86), "temper_shell", shell)
    h.box("front_sill", (0, -1.069, .955), (1.94, .21, .19), "temper_shell", shell)
    h.box("front_lintel", (0, -1.055, 2.917), (1.94, .14, .87), "temper_shell", shell)
    h.box("front_upper_recess", (0, -1.136, 2.926), (1.50, .012, .82), "brushed_metal", shell, .003)

    chamber = h.group("refractory_chamber")
    for x in (-.727, .727):
        h.box("recessed_hot_face_side", (x, .26, 1.75), (.09, 2.64, 1.45), "temper_lining", chamber, .002)
    h.box("recessed_hot_face_floor", (0, .26, 1.016), (1.45, 2.64, .07), "temper_lining", chamber, .002)
    h.box("recessed_hot_face_roof", (0, .26, 2.482), (1.45, 2.64, .075), "temper_lining", chamber, .002)
    h.box("recessed_hot_face_rear", (0, 1.55, 1.75), (1.45, .06, 1.46), "temper_lining", chamber, .002)
    for x in (-.52, .52):
        h.box("internal_load_support", (x, .25, 1.09), (.07, 2.55, .07), "heat_black", chamber, .003)
    for z in (1.40, 1.80, 2.20):
        for x in (-.679, .679):
            h.box("lining_course_seam", (x, .23, z), (.005, 2.49, .009), "heat_black", chamber, .001)
    for x in (-.668, .668):
        h.box("mouth_reveal_vertical", (x, -1.082, 1.745), (.04, .10, 1.40), "gasket", chamber, .002)
    for z in (1.045, 2.445):
        h.box("mouth_reveal_horizontal", (0, -1.083, z), (1.37, .10, .035), "gasket", chamber, .002)

    door = h.group("door_front_lift", loc=(0, -1.255, 1.78), dynamic=True)
    _rounded_panel(h, "single_round_corner_heat_door", 1.47, 1.60, .095, .092, "temper_door", door)
    for x in (-.773, .773):
        for z in (-.49, .50):
            h.box("door_guide_follower", (x, .005, z), (.071, .083, .117), "temper_shell", door, .004)
            h.cylinder("door_follower_pin", (x, -.044, z), .027, .022, "stainless", door, axis="Y", sides=16)
    # Two visible U-shaped lower attachments belong to the moving door.
    for x in (-.465, .465):
        h.pipe("door_lower_u_attachment", [(x - .067, -.10, -.92), (x - .067, -.10, -.46),
                                            (x + .067, -.10, -.46), (x + .067, -.10, -.92)],
               .016, "temper_shell", door, bend=.025)
        h.cylinder("door_attachment_hinge", (x, -.10, -.46), .036, .18, "stainless", door, axis="X", sides=24)
        h.box("door_attachment_mount", (x, -.047, -.515), (.15, .060, .104), "temper_shell_edge", door, .005)

    guides = h.group("door_guides")
    for x in (-.866, .866):
        h.box("continuous_lift_guide_back", (x, -1.129, 2.56), (.082, .085, 3.43), "dark_structure", guides, .003)
        h.box("continuous_lift_guide_lip", (x + math.copysign(.043, x), -1.218, 2.56), (.026, .106, 3.43), "temper_shell", guides, .003)
        h.box("lift_chain_backing", (x, -1.221, 1.976), (.033, .028, 2.24), "temper_chain", guides, .001)
        for i in range(50):
            h.box("restrained_scale_lift_chain_link", (x, -1.244, .90 + i * .043), (.039, .019, .012), "temper_chain", guides, .001)
        # The upper stop belongs at the rail end, not midway through the door
        # follower's travel; the former position caused a half-open collision.
        for z in (.842, 4.306):
            h.box("guide_end_mount", (x, -1.195, z), (.14, .17, .06), "temper_shell", guides, .004)
    # The shaft is in front of the door's plane; upper storage is behind the fascia.
    drive = h.group("door_drive_housing")
    for x in (-.955, .955):
        h.box("shaft_bearing_pedestal", (x, -1.374, 3.09), (.105, .20, .205), "temper_shell", drive, .008)
        h.cylinder("shaft_bearing", (x, -1.390, 3.09), .088, .119, "temper_shell_edge", drive, axis="X", sides=24)
        h.bolts("shaft_bearing_fixing", [(x - math.copysign(.064, x), -1.448, 3.027),
                                         (x - math.copysign(.064, x), -1.323, 3.153)], drive, axis="X", radius=.012)
    h.box("gear_motor_bracket", (-1.108, -1.145, 3.075), (.31, .27, .077), "temper_shell", drive)
    h.motor("vertical_door_gearmotor", (-1.108, -1.205, 3.358), .67, "Z", drive, color="motor_teal")
    h.pipe("door_motor_cable", [(-1.22, -1.18, 3.39), (-1.29, -1.01, 3.35), (-1.29, -.77, 2.97)],
           .012, "gasket", drive, bend=.055)
    shaft = h.group("door_drive_shaft_rotate", loc=(0, -1.390, 3.09), dynamic=True)
    h.cylinder("door_lift_cross_shaft", (0, 0, 0), .035, 1.96, "stainless", shaft, axis="X", sides=28)
    for x in (-.68, .68):
        h.cylinder("door_shaft_collar", (x, 0, 0), .048, .034, "brushed_metal", shaft, axis="X", sides=20)
    h.box("shaft_key", (-.70, -.038, 0), (.06, .007, .012), "dark_structure", shaft, .001)

    hood = h.group("sloped_exhaust_hood")
    # Thick folded sheet; bottom remains open. Empty travel corridor at y=-1.255.
    lo_y, hi_y, lo_z, hi_z = -1.96, -1.33, 3.205, 4.52
    hood_vertices = [(-1.075, lo_y, lo_z), (1.075, lo_y, lo_z), (1.075, hi_y, hi_z), (-1.075, hi_y, hi_z),
                     (-1.075, lo_y + .025, lo_z), (1.075, lo_y + .025, lo_z), (1.075, hi_y + .025, hi_z), (-1.075, hi_y + .025, hi_z)]
    hood_faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    h.mesh("inclined_extraction_fascia", hood_vertices, hood_faces, "temper_hood", hood, bevel=.005)
    for x in (-1.075, 1.075):
        verts = [(x, lo_y, lo_z), (x, -.875, lo_z), (x, -.875, hi_z), (x, hi_y, hi_z),
                 (x + math.copysign(.025, x), lo_y, lo_z), (x + math.copysign(.025, x), -.875, lo_z),
                 (x + math.copysign(.025, x), -.875, hi_z), (x + math.copysign(.025, x), hi_y, hi_z)]
        h.mesh("hood_folded_side_cheek", verts, hood_faces, "temper_shell_edge", hood, bevel=.004)
        h.box("hood_lower_side_return", (x, -1.42, 3.205), (.029, 1.09, .072), "temper_hood", hood, .004)
    h.box("hood_shadow_front_return", (0, -1.946, 3.19), (2.19, .042, .097), "temper_hood", hood, .003)
    h.box("hood_rear_sheet", (0, -.878, 3.855), (2.19, .032, 1.33), "temper_hood", hood, .003)
    h.box("hood_top_sheet", (0, -1.100, 4.525), (2.19, .48, .025), "temper_hood", hood, .003)
    h.tube("short_open_exhaust_neck", (0, -1.090, 4.675), .131, .111, .29, "temper_hood", hood, sides=48)
    h.tube("exhaust_mouth_rolled_lip", (0, -1.090, 4.827), .151, .111, .028, "heat_black", hood, sides=48)
    for x in (-.72, .72):
        h.pipe("hood_lifting_eye", [(x - .035, -1.10, 4.54), (x - .035, -1.10, 4.60),
                                   (x + .035, -1.10, 4.60), (x + .035, -1.10, 4.54)], .008, "dark_structure", hood, bend=.025)
    plaque_z = 3.69
    plaque_y = lo_y + (plaque_z - lo_z) * (hi_y - lo_y) / (hi_z - lo_z)
    plaque = h.empty("inclined_maker_plaque_mount", hood, loc=(0, plaque_y - .025, plaque_z + .012))
    plaque.rotation_euler[0] = -math.atan((hi_y - lo_y) / (hi_z - lo_z))
    h.box("maker_plaque_red_edge", (0, 0, 0), (.99, .037, .263), "red", plaque, .008)
    h.box("maker_plaque_dark_face", (0, -.025, 0), (.964, .023, .240), "heat_black", plaque, .006)
    h.label("maker_wordmark", "KINGKIND", (0, -.038, -.005), .156, "red", plaque)

    tray = h.group("front_shallow_tray")
    h.box("shallow_door_drip_tray_floor", (0, -1.390, .807), (1.72, .65, .026), "brushed_metal", tray, .003)
    h.box("shallow_door_drip_tray_front_lip", (0, -1.713, .826), (1.75, .025, .061), "stainless", tray, .003)
    for x in (-.87, .87):
        h.box("shallow_tray_side_lip", (x, -1.391, .826), (.025, .65, .062), "stainless", tray, .003)
    for x in (-.57, .57):
        h.beam("tray_cantilever_bracket", (x, -1.08, .60), (x, -1.54, .783), .038, "temper_shell", tray)

    platform = h.group("service_platform")
    h.box("side_platform_deck", (1.402, .460, 3.48), (.69, 2.34, .068), "safety_yellow", platform, .004)
    for y in (-.71, 1.63):
        h.box("platform_end_channel", (1.402, y, 3.414), (.74, .055, .157), "safety_yellow", platform, .003)
    h.box("platform_outer_channel", (1.755, .460, 3.414), (.055, 2.39, .157), "safety_yellow", platform, .003)
    for y in (-.49, .46, 1.38):
        h.box("platform_wall_anchor_plate", (1.107, y, 2.91), (.025, .18, .19), "safety_yellow", platform, .003)
        h.beam("platform_diagonal_support", (1.114, y, 2.88), (1.70, y, 3.427), .071, "safety_yellow", platform)
        h.box("platform_underdeck_crossmember", (1.409, y, 3.40), (.66, .050, .07), "safety_yellow", platform, .003)
        h.bolts("platform_anchor", [(1.127, y - .053, 2.935), (1.127, y + .053, 2.935)], platform, axis="X", radius=.012)
    for i in range(30):
        h.box("deck_antislip_strip", (1.397, -.651 + i * .075, 3.518), (.62, .014, .007), "temper_shell_edge", platform, .001)
    # Genuine landing opening at the caged ladder, not a guard rail through the entry.
    for y in (-.69, -.03, .65, 1.40, 1.63):
        _rail(h, "platform_guard_post", (1.765, y, 3.48), (1.765, y, 4.38), platform)
    for z in (3.91, 4.38):
        for ya, yb in ((-.69, .65), (1.40, 1.63)):
            _rail(h, "platform_outer_guardrail", (1.765, ya, z), (1.765, yb, z), platform)
        for y in (-.69, 1.63):
            _rail(h, "platform_end_guardrail", (1.765, y, z), (1.071, y, z), platform)
    for y in (-.69, 1.63):
        _rail(h, "platform_inner_corner_post", (1.071, y, 3.48), (1.071, y, 4.38), platform)

    ladder = h.group("ladder_cage")
    for y in (.72, 1.32):
        _rail(h, "ladder_side_rail", (1.867, y, .17), (1.867, y, 4.43), ladder, .024)
        for z in (.62, 1.53, 2.42, 3.30):
            _rail(h, "ladder_wall_standoff", (1.10, y, z), (1.867, y, z), ladder, .015)
            h.box("ladder_wall_anchor", (1.093, y, z), (.025, .104, .108), "safety_yellow", ladder, .002)
    for i in range(12):
        _rail(h, "ladder_rung", (1.867, .72, .32 + i * .275), (1.867, 1.32, .32 + i * .275), ladder, .015)
    for z in (1.88, 2.40, 2.93, 3.47, 4.0, 4.43):
        points = [(1.867 + .42 * math.cos(-math.pi / 2 + i * math.pi / 24),
                   1.02 + .42 * math.sin(-math.pi / 2 + i * math.pi / 24), z) for i in range(25)]
        h.pipe("ladder_half_round_safety_hoop", points, .018, "safety_yellow", ladder, bend=.005)
    for deg in (-72, -36, 0, 36, 72):
        a = math.radians(deg)
        xx, yy = 1.867 + .42 * math.cos(a), 1.02 + .42 * math.sin(a)
        _rail(h, "ladder_cage_longitudinal", (xx, yy, 1.88), (xx, yy, 4.43), ladder, .013)

    electrics = h.group("electrical_cabinet")
    cabinet = h.empty("side_double_door_cabinet_orientation", electrics, loc=(-1.235, .28, 1.77))
    cabinet.rotation_euler[2] = -math.pi / 2
    h.box("double_door_electrical_enclosure", (0, 0, 0), (1.65, .34, 2.26), "temper_shell", cabinet, .014)
    for x in (-.411, .411):
        h.box("electrical_door_seal", (x, -.178, 0), (.803, .022, 2.213), "gasket", cabinet, .004)
        h.box("electrical_door_leaf", (x, -.197, 0), (.790, .034, 2.20), "temper_shell", cabinet, .008)
    h.label("cabinet_maker_wordmark", "KINGKIND", (-.47, -.22, .87), .075, "red", cabinet)
    h.box("cabinet_central_latch", (.018, -.233, -.15), (.037, .038, .35), "heat_black", cabinet, .011)
    h.box("hmi_charcoal_bezel", (.413, -.241, -.21), (.51, .065, .37), "dark_structure", cabinet, .012)
    h.box("hmi_metal_edge", (.413, -.278, -.21), (.473, .018, .330), "stainless", cabinet, .004)
    h.box("hmi_dark_screen", (.413, -.291, -.21), (.420, .013, .268), "screen", cabinet, .003)
    h.label("hmi_temper_label", "TEMPER", (.413, -.300, -.15), .035, "screen_light", cabinet)
    for i in range(4):
        h.box("hmi_readout_row", (.33, -.301, -.20 - i * .024), (.184 + (i % 2) * .047, .003, .009), "screen_light", cabinet, .001)
    for x in (-.60, -.285):
        h.box("temperature_controller_body", (x, -.243, -.205), (.24, .059, .232), "heat_black", cabinet, .007)
        h.box("temperature_controller_window", (x, -.277, -.175), (.195, .013, .12), "screen", cabinet, .003)
        h.label("temperature_readout", "---", (x, -.287, -.168), .050, "screen_light", cabinet)
        for button in (-.065, 0, .065):
            h.box("controller_membrane_key", (x + button, -.280, -.276), (.04, .010, .027), "temper_shell_edge", cabinet, .003)
    for x in (-.60, -.285):
        h.box("electrical_caution_label", (x, -.220, -.45), (.245, .005, .144), "dial", cabinet, .001)
        h.box("electrical_caution_header", (x, -.225, -.405), (.232, .006, .043), "safety_yellow", cabinet, .001)
        h.label("electrical_caution_text", "CAUTION", (x, -.229, -.453), .027, "heat_black", cabinet)
    h.cylinder("cabinet_main_rotary_switch", (.413, -.244, -.57), .034, .044, "dark_structure", cabinet, axis="Y", sides=20)
    for x in (-.72, .72):
        for z in (-.77, .75):
            h.box("cabinet_hinge", (x + math.copysign(.087, x), -.167, z), (.035, .074, .118), "stainless", cabinet, .005)
        h.pipe("cabinet_lift_eye", [(x - .035, 0, 1.138), (x - .035, 0, 1.203),
                                  (x + .035, 0, 1.203), (x + .035, 0, 1.138)], .007, "stainless", cabinet, bend=.02)
    for i in range(10):
        h.box("cabinet_side_vent_slot", (.831, .0, -.55 + i * .025), (.011, .22, .010), "dark_structure", cabinet, .002)
    h.cylinder("stacklight_mount", (-1.34, -.26, 2.964), .029, .16, "stainless", electrics, sides=20)
    for z, mat in ((3.08, "green"), (3.16, "dial"), (3.24, "red")):
        h.cylinder("stacklight_section", (-1.34, -.26, z), .038, .068, mat, electrics, sides=24)
    h.cylinder("stacklight_cap", (-1.34, -.26, 3.285), .040, .021, "temper_shell_edge", electrics, sides=24)
    # Narrow controls visible on the front jamb in the front photographs.
    h.box("front_operator_pendant", (-1.019, -1.302, 1.755), (.201, .124, .91), "temper_shell", electrics, .008)
    h.box("pendant_small_readout", (-1.019, -1.370, 2.055), (.131, .017, .112), "heat_black", electrics, .004)
    h.label("pendant_display", "--", (-1.019, -1.381, 2.055), .039, "red", electrics)
    for i, mat in enumerate(("red", "dark_structure", "green", "dark_structure")):
        h.cylinder("pendant_control", (-1.063 + (i % 2) * .087, -1.377, 1.861 - (i // 2) * .093),
                   .019, .022, mat, electrics, axis="Y", sides=18)

    services = h.group("pipe_services")
    # Restrained rear/side service circuit; no invented yellow round side cover.
    h.pipe("side_black_service_riser", [(1.142, 1.53, .54), (1.142, 1.53, 2.96), (1.142, .80, 2.96), (.935, .80, 2.96)],
           .031, "heat_black", services, bend=.062)
    h.cylinder("utility_riser_capped_union", (1.142, 1.53, .54), .049, .06,
               "brushed_metal", services, sides=12)
    h.pipe("side_small_air_line", [(.935, 1.18, .98), (1.151, 1.18, .98), (1.151, 1.18, 2.69), (1.151, .79, 2.69), (.935, .79, 2.69)],
           .015, "temper_shell", services, bend=.030)
    for z in (1.01, 1.76, 2.54):
        h.box("pipe_riser_saddle", (1.123, 1.53, z), (.07, .103, .044), "stainless", services, .003)
    for y in (.90, 1.10):
        h.cylinder("air_manifold_valve", (1.15, y, 2.63), .027, .125, "brass", services, sides=16)
        h.box("air_manifold_solenoid", (1.174, y, 2.659), (.066, .087, .057), "heat_black", services, .004)
        h.pipe("air_manifold_drop", [(1.15, y, 2.69), (1.15, y, 2.34), (1.15, 1.18, 2.34)],
               .011, "temper_shell", services, bend=.023)
    h.box("rear_junction_box", (.56, 1.857, 2.71), (.36, .126, .34), "temper_shell", services, .010)
    h.pipe("rear_junction_conduit", [(.56, 1.87, 2.51), (.56, 1.87, 1.02), (.24, 1.87, 1.02), (.24, 1.685, 1.02)],
           .012, "gasket", services, bend=.052)

    fan_housing = h.group("circulation_drive_housing")
    h.box("top_circulation_motor_support", (0, 1.055, 3.452), (.56, .50, .06), "temper_shell_edge", fan_housing, .006)
    h.cylinder("circulation_duct_neck", (0, 1.055, 3.56), .226, .20, "temper_shell", fan_housing, sides=32)
    h.motor("circulation_top_motor", (0, 1.055, 3.872), .69, "Z", fan_housing, color="motor_teal")
    h.pipe("circulation_motor_cable", [(.15, 1.055, 3.90), (.33, 1.12, 3.83), (.33, 1.69, 3.37), (.56, 1.86, 2.89)],
           .012, "gasket", fan_housing, bend=.060)
    rotor = h.group("circulation_fan_rotate", loc=(0, 1.055, 3.153), dynamic=True)
    h.cylinder("internal_circulation_shaft", (0, 0, 0), .032, .58, "stainless", rotor, sides=20)
    h.cylinder("internal_circulation_hub", (0, 0, -.11), .105, .083, "brushed_metal", rotor, sides=24)
    for i in range(8):
        a = i * math.tau / 8
        blade = h.box("internal_circulation_impeller_blade", (.197 * math.cos(a), .197 * math.sin(a), -.11),
                      (.212, .077, .024), "brushed_metal", rotor, .003)
        blade.rotation_euler[2] = a + .23

    return {
        "model_id": "photo_tempering_furnace_v6",
        "family": "回火炉",
        "views": [
            {"suffix": "preview", "camera": (7.1, -9.1, 6.0), "target": (.20, -.03, 2.31), "scale": 6.25},
            {"suffix": "rear", "camera": (-7.3, 8.7, 5.8), "target": (.22, .24, 2.29), "scale": 6.2},
            {"suffix": "controls", "camera": (-7.6, -6.8, 5.0), "target": (-.10, -.03, 2.31), "scale": 5.95},
        ],
        "bindings": [
            {"id": "tempering_door_open", "node_name": "door_front_lift", "source_group": "doors", "source_key": "tempering_door_open", "action": "translate", "axis": "y", "output_max": 1.64},
            {"id": "tempering_door_drive_speed", "node_name": "door_drive_shaft_rotate", "source_group": "motors", "source_key": "tempering_door_drive_speed", "action": "rotate_speed", "axis": "x", "speed_factor": 1.0},
            {"id": "tempering_fan_speed", "node_name": "circulation_fan_rotate", "source_group": "motors", "source_key": "tempering_fan_speed", "action": "rotate_speed", "axis": "y", "speed_factor": 1.0},
        ],
        "shell_groups": ["thermal_shell", "sloped_exhaust_hood"],
        "notes": [
            "以现场斜罩、单块圆角黑门、厚灰壳加强筋、黄平台/护笼梯、竖置门驱动及双门电柜为主要照片依据；不沿用V4横条铆钉门或直筒方罩。",
            "炉口由独立门框和耐火腔组成，闭门参考姿态只保留一套门。升降门及双U形附件作为同一运动组。",
            "升降行程1.64m：门板最高Z=4.22m，U形附件最低Z=2.50m。炉口上沿Z=2.445m；上行导槽在斜罩后方留出存放空间。",
            "尺寸为照片比例估算，非工程测量。炉内耐火层、内置循环叶轮/轴、背部服务线路属示意；不得用于制造或作为现场管线接法。",
            "门驱动转速绑定为独立可选示意点位；既有tempering_door_open与tempering_fan_speed语义保留，未修改生产配置。",
        ],
        "reference_photos": [
            "回火炉/mmexport1783325204825.jpg", "回火炉/mmexport1783325206255.jpg",
            "回火炉/mmexport1783325200634.jpg", "回火炉/mmexport1783325201991.jpg",
            "回火炉/mmexport1783325203422.jpg", "回火炉/mmexport1783325191832.jpg",
        ],
        "checks": [{"kind": "door_ray", "node_name": "door_front_lift", "origin": (0, -2.35, 1.77),
                    "direction": (0, 1, 0), "travel": 1.64, "axis": "z"}],
    }
