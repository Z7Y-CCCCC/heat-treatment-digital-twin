"""Photo-referenced transfer cart V6.

This module only builds geometry through the shared ``h`` helper.  It does not
connect to Blender, change the active file, save, render, or export anything.
Coordinates are metres, Blender Z-up.  Feed is +X; the operator side is -Y.
"""

from math import atan2, cos, pi, sin, sqrt


def _ring_y(h, name, loc, outer, inner, depth, mat, parent, sides=48):
    obj = h.tube(name, loc, outer, inner, depth, mat, parent, sides=sides)
    obj.rotation_euler[0] = pi / 2
    return obj


def _chain_loop(h, name, x, path, count, width, parent):
    """Flat articulated plates following a closed path in the YZ plane."""
    lengths = []
    total = 0.0
    for a, b in zip(path, path[1:] + path[:1]):
        length = sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)
        lengths.append(length)
        total += length
    for i in range(count):
        distance = (i + 0.5) * total / count
        for k, length in enumerate(lengths):
            if distance <= length:
                a, b = path[k], path[(k + 1) % len(path)]
                t = distance / length
                y = a[0] + (b[0] - a[0]) * t
                z = a[1] + (b[1] - a[1]) * t
                angle = atan2(b[1] - a[1], b[0] - a[0])
                plate = h.box(
                    f"{name}_plate_{i:02d}", (x, y, z),
                    (0.030, total / count * 0.85, width),
                    "cart_chain", parent, bevel=0.003,
                )
                plate.rotation_euler[0] = angle
                h.cylinder(
                    f"{name}_pin_{i:02d}", (x + 0.019, y, z),
                    width * 0.145, 0.015, "brushed_metal", parent,
                    axis="X", sides=10,
                )
                break
            distance -= length


def _deck_tread(h, parent):
    """A single low-poly mesh for restrained raised checkerplate, not boxes."""
    verts, faces = [], []
    for ix in range(35):
        for iy in range(7):
            x = -1.62 + ix * 0.095
            y = -1.305 + iy * 0.10
            if -1.10 < x < -0.04 and -1.205 < y < -0.725:
                continue  # Under the electrical cabinet.
            for offset, angle in [(-0.013, pi / 4), (0.014, -pi / 4)]:
                start = len(verts)
                for zz in [0.356, 0.359]:
                    for xx, yy in [(-0.025, -0.004), (0.025, -0.004),
                                   (0.025, 0.004), (-0.025, 0.004)]:
                        verts.append((x + offset + xx * cos(angle) - yy * sin(angle),
                                      y + xx * sin(angle) + yy * cos(angle), zz))
                faces.extend(tuple(start + n for n in face) for face in
                             [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
                              (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)])
    h.mesh("operator_deck_checkerplate", verts, faces, "cart_tread", parent)


def _handwheel(h, name, x, y, z, parent):
    _ring_y(h, f"{name}_rim", (x, y, z), 0.112, 0.093, 0.018,
            "stainless", parent)
    h.cylinder(f"{name}_hub", (x, y, z), 0.031, 0.055,
               "brushed_metal", parent, axis="Y", sides=24)
    for i in range(3):
        angle = i * 2 * pi / 3 + pi / 2
        h.rod(f"{name}_spoke_{i}", (x, y, z),
              (x + 0.099 * cos(angle), y, z + 0.099 * sin(angle)),
              0.010, "stainless", parent)
    h.cylinder(f"{name}_crank", (x + 0.072, y + 0.038, z - 0.048),
               0.012, 0.075, "heat_black", parent, axis="Y", sides=16)
    h.cylinder(f"{name}_shaft", (x, y - 0.063, z), 0.019, 0.12,
               "stainless", parent, axis="Y", sides=16)


def build(h):
    h.material("cart_chain", (0.145, 0.158, 0.164, 1), metallic=0.65, roughness=0.51)
    h.material("cart_tread", (0.107, 0.117, 0.124, 1), metallic=0.72, roughness=0.53)
    h.material("cart_panel", (0.71, 0.724, 0.675, 1), metallic=0.12, roughness=0.44)
    h.material("cart_beacon", (1.0, 0.265, 0.009, 1), metallic=0.12, roughness=0.25)
    h.material("cart_warning", (0.83, 0.80, 0.62, 1), metallic=0, roughness=0.66)

    rails = h.group("cart_reference_rails")
    travel = h.group("cart_travel", dynamic=True)
    chassis = h.group("cart_open_chassis", parent=travel)
    frame = h.group("cart_transfer_frame", parent=travel)
    head = h.group("cart_tall_head_frame", parent=travel)
    chain = h.group("cart_visible_chain_guides", parent=travel)
    deck = h.group("cart_operator_platform", parent=travel)
    console = h.group("cart_operator_console", parent=travel)
    drive = h.group("cart_drive_and_cables", parent=travel)

    # The cart runs laterally along the furnace row (Y), perpendicular to feed X.
    # These short rail pieces are a presentation reference, not part of the cart.
    for ix, x in enumerate([-1.32, 1.32]):
        h.box(f"floor_rail_foot_{ix}", (x, 0, 0.025), (0.13, 3.55, 0.025),
              "dark_structure", rails, bevel=0.003)
        h.box(f"floor_rail_web_{ix}", (x, 0, 0.051), (0.034, 3.55, 0.032),
              "brushed_metal", rails, bevel=0.002)
        h.box(f"floor_rail_head_{ix}", (x, 0, 0.077), (0.065, 3.55, 0.024),
              "brushed_metal", rails, bevel=0.002)
        for iy, y in enumerate([-1.50, -1.0, -0.5, 0.0, 0.5, 1.0, 1.50]):
            h.box(f"rail_fastener_{ix}_{iy}", (x, y, 0.017), (0.235, 0.095, 0.02),
                  "cart_chain", rails, bevel=0.001)

    # Deliberately hollow base: perimeter beams, crossmembers, narrow side decks.
    for y in [-0.66, 0.78]:
        h.box(f"chassis_long_boxbeam_{y}", (0, y, 0.285), (3.55, 0.155, 0.23),
              "dark_structure", chassis, bevel=0.008)
        h.box(f"chassis_welded_top_flange_{y}", (0, y, 0.41), (3.57, 0.17, 0.018),
              "heat_black", chassis, bevel=0.003)
    for x in [-1.69, -0.80, 0.55, 1.69]:
        h.box(f"chassis_crossmember_{x}", (x, 0.06, 0.28), (0.13, 1.46, 0.19),
              "dark_structure", chassis)
    for x in [-1.61, 1.59]:
        h.box(f"end_stop_mount_{x}", (x, 0.825, 0.34), (0.28, 0.075, 0.14),
              "heat_black", chassis, bevel=0.004)
        h.box(f"end_stop_pad_{x}", (x, 0.87, 0.34), (0.18, 0.035, 0.09),
              "gasket", chassis, bevel=0.008)
    for x in [-1.20, 0.90]:
        h.box(f"service_bay_rim_{x}", (x, 0.06, 0.405), (0.025, 1.28, 0.023),
              "brushed_metal", chassis, bevel=0.002)
    h.box("drive_service_deck", (-1.34, 0.07, 0.425), (0.64, 1.28, 0.028),
          "cart_tread", chassis, bevel=0.004)
    h.box("rear_narrow_service_deck", (0.28, 0.78, 0.421), (2.72, 0.24, 0.026),
          "cart_tread", chassis, bevel=0.003)

    # Flanged wheels share a real axle pivot; fixed bearing brackets do not spin.
    bindings = []
    for axle_index, y in enumerate([-0.50, 0.56], start=1):
        axle_name = f"cart_wheel_axle_{axle_index}_rotate"
        axle = h.group(axle_name, loc=(0, y, 0.223), dynamic=True, parent=travel)
        h.cylinder(f"wheel_axle_{axle_index}", (0, 0, 0), 0.037, 2.76,
                   "brushed_metal", axle, axis="X", sides=20)
        for ix, x in enumerate([-1.32, 1.32]):
            h.cylinder(f"flanged_wheel_{axle_index}_{ix}", (x, 0, 0), 0.136, 0.084,
                       "cart_chain", axle, axis="X", sides=40)
            h.cylinder(f"wheel_flange_{axle_index}_{ix}", (x - 0.045, 0, 0),
                       0.155, 0.017, "dark_structure", axle, axis="X", sides=40)
            h.cylinder(f"wheel_hub_{axle_index}_{ix}", (x + 0.046, 0, 0),
                       0.051, 0.031, "brushed_metal", axle, axis="X", sides=24)
            h.box(f"wheel_bearing_block_{axle_index}_{ix}", (x - 0.13, y, 0.275),
                  (0.095, 0.19, 0.20), "dark_structure", chassis, bevel=0.012)
        bindings.append({"id": axle_name, "node_name": axle_name,
                         "source_group": "motors", "source_key": "cart_travel_speed",
                         "action": "rotate_speed", "axis": "x", "speed_factor": 0.07})

    # Four-post welded frame.  No heavy solid shelf is inserted inside the frame.
    for x in [-1.08, 1.40]:
        for y in [-0.47, 0.64]:
            h.box(f"transfer_post_{x}_{y}", (x, y, 0.97), (0.11, 0.115, 1.10),
                  "dark_structure", frame, bevel=0.005)
            h.box(f"transfer_post_foot_{x}_{y}", (x, y, 0.439), (0.22, 0.20, 0.032),
                  "dark_structure", frame, bevel=0.004)
            h.bolts(f"transfer_post_bolts_{x}_{y}",
                    [(x - .077, y - .065, .461), (x + .077, y + .065, .461)],
                    frame, axis="Z", radius=.012)
    for y in [-0.47, 0.64]:
        h.box(f"deep_upper_sidebeam_{y}", (0.22, y, 1.485), (2.85, 0.10, 0.16),
              "dark_structure", frame, bevel=0.006)
        h.box(f"lower_open_frame_sidebeam_{y}", (0.16, y, 0.805), (2.55, 0.095, 0.115),
              "dark_structure", frame, bevel=0.005)
        h.box(f"polished_wear_strip_{y}", (0.23, y - .011, 1.574), (2.87, 0.038, 0.014),
              "brushed_metal", frame, bevel=0.002)
    h.box("upper_crossmember_at_head", (-1.06, .085, 1.49), (.115, 1.16, .16),
          "dark_structure", frame)
    h.box("lower_crossmember_at_feed", (1.38, .085, .803), (.10, 1.15, .12),
          "dark_structure", frame)
    # Three local long rollers near the feed mouth; most of the bed remains open.
    for index, x in enumerate([0.57, 0.98, 1.37], start=1):
        node = f"cart_feed_roller_{index}_rotate"
        roller = h.group(node, loc=(x, .085, 1.508), dynamic=True, parent=travel)
        h.cylinder(f"feed_roller_barrel_{index}", (0, 0, 0), .054, 1.01,
                   "brushed_metal", roller, axis="Y", sides=32)
        h.cylinder(f"feed_roller_shaft_{index}", (0, 0, 0), .022, 1.23,
                   "stainless", roller, axis="Y", sides=20)
        for y in [-.49, .66]:
            h.box(f"feed_roller_pillow_block_{index}_{y}", (x, y, 1.51), (.14, .058, .115),
                  "heat_black", frame, bevel=.010)
            h.cylinder(f"feed_roller_bearing_{index}_{y}", (x, y, 1.511), .044, .062,
                       "cart_chain", frame, axis="Y", sides=24)
        bindings.append({"id": node, "node_name": node,
                         "source_group": "motors", "source_key": "cart_roller_speed",
                         "action": "rotate_speed", "axis": "z", "speed_factor": .1047197551})

    # Slim paired guides and a moving push shoe, instead of a fictitious load slab.
    shuttle = h.group("cart_feed_shuttle", dynamic=True, parent=travel)
    for y in [-.315, .485]:
        h.box(f"feed_stationary_guide_{y}", (-.20, y, 1.604), (2.45, .040, .035),
              "heat_black", frame, bevel=.003)
        h.box(f"feed_sliding_bar_{y}", (-.60, y, 1.645), (1.02, .046, .026),
              "brushed_metal", shuttle, bevel=.003)
    h.box("feed_push_crosshead", (-.12, .085, 1.665), (.10, .91, .09),
          "dark_structure", shuttle, bevel=.005)
    for y in [-.315, .485]:
        h.box(f"feed_hook_{y}", (-.075, y, 1.713), (.085, .083, .10),
              "heat_black", shuttle, bevel=.009)
    bindings.append({"id": "cart_feed_extension", "node_name": "cart_feed_shuttle",
                     "source_group": "positions", "source_key": "cart_feed_extension",
                     "action": "translate", "axis": "x", "output_max": .92})

    # Tall black head, with the mechanism face toward the loading table (+X).
    h.box("head_mounting_platform", (-1.46, .085, .765), (.69, 1.08, .055),
          "dark_structure", head, bevel=.005)
    for y in [-.345, .515]:
        h.box(f"head_support_leg_{y}", (-1.50, y, .588), (.095, .095, .345),
              "dark_structure", head)
    h.box("head_recessed_backplate", (-1.46, .085, 1.91), (.040, .82, 2.27),
          "heat_black", head, bevel=.004)
    for y in [-.363, .533]:
        h.box(f"head_deep_side_channel_{y}", (-1.45, y, 1.918), (.155, .065, 2.295),
              "dark_structure", head, bevel=.005)
        h.box(f"head_edge_highlight_{y}", (-1.358, y, 1.918), (.014, .018, 2.225),
              "cart_chain", head, bevel=.002)
    for z in [.804, 1.67, 3.042]:
        h.box(f"head_cross_rib_{z}", (-1.478, .085, z), (.105, .925, .065),
              "dark_structure", head, bevel=.004)
    # Distinct chamfered outer and inner articulated paths are visible in photo 3.
    outer = [(-.265, 1.22), (-.295, 1.54), (-.295, 2.66), (-.18, 2.865),
             (.085, 2.96), (.35, 2.865), (.465, 2.66), (.465, 1.54),
             (.375, 1.26), (.24, 1.13), (-.065, 1.13)]
    inner = [(-.10, 1.55), (-.15, 1.78), (-.15, 2.59), (-.04, 2.72),
             (.085, 2.775), (.24, 2.68), (.31, 2.55), (.31, 1.62),
             (.215, 1.48), (.005, 1.46)]
    _chain_loop(h, "head_outer_articulated_chain", -1.35, outer, 64, .073, chain)
    _chain_loop(h, "head_inner_articulated_chain", -1.318, inner, 47, .062, chain)
    for y in [-.065, .235]:
        h.box(f"head_internal_slide_guide_{y}", (-1.377, y, 2.055), (.025, .047, 1.14),
              "cart_chain", chain, bevel=.003)
    h.cylinder("head_lower_sprocket_cover", (-1.316, .085, 1.005), .094, .035,
               "dark_structure", chain, axis="X", sides=40)
    for z in [1.36, 2.23, 2.93]:
        for y in [-.363, .533]:
            h.cylinder(f"head_edge_fastener_{y}_{z}", (-1.352, y, z), .012, .012,
                       "brushed_metal", head, axis="X", sides=6)
    for i, y in enumerate([-.19, .085, .36]):
        h.box(f"head_lower_valve_base_{i}", (-1.278, y, 1.225), (.10, .12, .16),
              "motor_blue", chain, bevel=.005)
        h.cylinder(f"head_valve_coil_{i}", (-1.215, y, 1.195), .029, .048,
                   "brass", chain, axis="X", sides=16)
        h.pipe(f"head_valve_small_hose_{i}",
               [(-1.20, y, 1.19), (-1.19, y, 1.05), (-1.25, y, .96)],
               .009, "gasket", chain, bend=.025)
    # Large upright worm gear motor is on the back, not a horizontal placeholder.
    h.box("vertical_motor_bracket", (-1.63, .085, 1.505), (.34, .42, .075),
          "dark_structure", drive, bevel=.005)
    h.motor("large_upright_head_gearmotor", (-1.76, .085, 1.94), 1.01, "Z", drive,
            color="motor_teal")
    h.box("head_worm_reducer_case", (-1.725, .085, 1.61), (.39, .43, .38),
          "motor_teal", drive, bevel=.047)
    h.cylinder("head_reducer_round_service_cover", (-1.940, .085, 1.625), .154, .05,
               "motor_teal", drive, axis="X", sides=48)
    h.cylinder("head_reducer_cover_boss", (-1.972, .085, 1.625), .063, .022,
               "motor_teal", drive, axis="X", sides=32)
    h.bolts("head_reducer_case_bolts",
            [(-1.972, .085 + .12*cos(t*pi/3), 1.625 + .12*sin(t*pi/3)) for t in range(6)],
            drive, axis="X", radius=.012)
    h.cylinder("head_reducer_oil_fill", (-1.78, -.045, 1.828), .019, .038,
               "red", drive, sides=16)

    # Under-bed reel and real three-spoke handwheels (rings, not solid disks).
    h.box("reel_support_bracket", (-.25, .50, 1.01), (.55, .13, .47),
          "dark_structure", drive, bevel=.007)
    reel = h.group("cart_cable_reel_rotate", loc=(-.23, .575, 1.075),
                   dynamic=True, parent=travel)
    h.cylinder("cable_reel_core", (0, 0, 0), .208, .22,
               "gasket", reel, axis="Y", sides=48)
    for y in [-.123, .123]:
        h.cylinder(f"cable_reel_flange_{y}", (0, y, 0), .275, .032,
                   "heat_black", reel, axis="Y", sides=48)
        _ring_y(h, f"cable_reel_safety_edge_{y}", (0, y+.018, 0), .265, .253, .009,
                "safety_yellow", reel)
    h.cylinder("cable_reel_centre_hub", (0, .152, 0), .066, .041,
               "cart_chain", reel, axis="Y", sides=24)
    bindings.append({"id": "cart_cable_reel_speed", "node_name": "cart_cable_reel_rotate",
                     "source_group": "motors", "source_key": "cart_travel_speed",
                     "action": "rotate_speed", "axis": "z", "speed_factor": .035})
    _handwheel(h, "adjustment_handwheel_left", -.64, .735, 1.28, drive)
    _handwheel(h, "adjustment_handwheel_right", -.34, .735, 1.28, drive)
    h.motor("lower_travel_gearmotor", (-1.28, .365, .57), .60, "Y", drive,
            color="motor_teal")
    h.box("travel_drive_coupling_guard", (-1.28, -.065, .557), (.32, .12, .25),
          "safety_yellow", drive, bevel=.030)
    h.box("lower_motor_foot", (-1.26, .31, .45), (.49, .63, .042),
          "brushed_metal", drive, bevel=.004)
    h.pipe("head_motor_power_conduit",
           [(-1.91, -.045, 2.065), (-1.995, -.10, 1.90), (-1.99, -.16, 1.00),
            (-1.85, -.18, .78), (-1.52, -.18, .70), (-1.55, -.24, .47)],
           .018, "gasket", drive, bend=.070)
    h.pipe("reel_to_chassis_cable",
           [(-.29, .54, .847), (-.30, .43, .69), (-.60, .30, .55),
            (-.85, .10, .50), (-1.03, -.14, .51)],
           .014, "gasket", drive, bend=.09)
    h.pipe("console_flexible_service_loop",
           [(-.84, -.81, .60), (-.99, -.70, .54), (-1.13, -.58, .51),
            (-1.31, -.35, .53), (-1.39, -.19, .64)],
           .018, "gasket", drive, bend=.06)

    # Operator platform: visible checkerplate and round-tube bent safety rails.
    h.box("operator_walkway_plate", (0, -1.01, .341), (3.48, .79, .030),
          "cart_tread", deck, bevel=.006)
    _deck_tread(h, deck)
    h.box("operator_outer_deck_edge", (0, -1.405, .292), (3.52, .042, .14),
          "dark_structure", deck, bevel=.005)
    for x in [-1.64, -.05, 1.63]:
        h.box(f"operator_underdeck_outrigger_{x}", (x, -1.015, .282), (.10, .82, .11),
              "dark_structure", deck, bevel=.004)
    # One continuous U-return handrail plus intermediate horizontal rails.
    for i, (x, y) in enumerate([(-1.63, -1.335), (-.02, -1.335),
                                (1.63, -1.335), (1.63, -.62), (-1.63, -.63)]):
        h.box(f"yellow_rail_baseplate_{i}", (x, y, .371), (.145, .13, .024),
              "safety_yellow", deck, bevel=.003)
        h.bolts(f"rail_anchor_bolts_{i}", [(x-.044, y-.037, .389), (x+.044, y+.037, .389)],
                deck, axis="Z", radius=.010)
        h.rod(f"yellow_round_post_{i}", (x, y, .385), (x, y, 1.545),
              .025, "safety_yellow", deck, sides=16)
    h.pipe("yellow_continuous_bent_top_rail",
           [(-1.63, -.60, 1.545), (-1.63, -1.335, 1.545),
            (1.63, -1.335, 1.545), (1.63, -.61, 1.545)],
           .027, "safety_yellow", deck, bend=.075)
    h.pipe("yellow_continuous_middle_rail",
           [(-1.63, -.60, .95), (-1.63, -1.335, .95),
            (1.63, -1.335, .95), (1.63, -.61, .95)],
           .020, "safety_yellow", deck, bend=.065)
    # Cabinet has one large door and a genuinely sloped control face.
    h.box("operator_console_black_plinth", (-.59, -.985, .422), (1.04, .49, .14),
          "heat_black", console, bevel=.005)
    h.box("operator_console_body", (-.59, -.97, .958), (1.00, .43, .99),
          "cart_panel", console, bevel=.009)
    h.box("operator_console_door_gasket", (-.59, -1.19, .955), (.932, .015, .916),
          "gasket", console, bevel=.008)
    h.box("operator_console_large_door", (-.59, -1.206, .955), (.914, .026, .898),
          "cart_panel", console, bevel=.011)
    # The eight-vertex wedge's front edge is lower than the back edge.
    verts = [(-1.14,-1.23,1.435),(-.04,-1.23,1.435),(-.04,-.695,1.495),(-1.14,-.695,1.495),
             (-1.14,-1.23,1.479),(-.04,-1.23,1.479),(-.04,-.695,1.586),(-1.14,-.695,1.586)]
    faces = [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
    h.mesh("operator_sloping_control_top", verts, faces, "cart_panel", console, bevel=.008)
    for row, y in enumerate([-1.077, -.874]):
        z = 1.479 + (y + 1.23) * .20
        for col in range(5):
            x = -.99 + col * .194
            h.cylinder(f"console_button_bezel_{row}_{col}", (x, y, z+.006),
                       .026, .012, "heat_black", console, sides=24)
            key = "dial"
            if row == 0 and col == 2:
                key = "screen_light"
            if row == 1 and col == 3:
                key = "green"
            if row == 1 and col == 4:
                key = "red"
            h.cylinder(f"console_button_cap_{row}_{col}", (x, y, z+.017),
                       .020, .014, key, console, sides=24)
            h.box(f"console_button_legend_{row}_{col}", (x, y-.051, z-.001),
                  (.070,.020,.004), "brushed_metal", console, bevel=.001)
    h.cylinder("console_emergency_stop_collar", (-.994,-.729,1.581), .043,.012,
               "safety_yellow", console, sides=28)
    h.cylinder("console_emergency_stop_mushroom", (-.994,-.729,1.608), .031,.047,
               "red", console, sides=28)
    for z in [.635, 1.285]:
        h.box(f"cabinet_left_hinge_{z}", (-1.057,-1.225,z), (.026,.028,.079),
              "brushed_metal", console, bevel=.004)
    h.cylinder("cabinet_quarter_turn_lock", (-.198,-1.228,.864), .023,.020,
               "heat_black", console, axis="Y", sides=24)
    h.box("cabinet_lock_slot", (-.198,-1.240,.864), (.005,.005,.022),
          "brushed_metal", console, bevel=.001)
    for idx, x in enumerate([-.79, -.56]):
        h.box(f"cabinet_warning_card_{idx}", (x,-1.223,1.06), (.19,.006,.123),
              "cart_warning", console, bevel=.001)
        h.box(f"cabinet_warning_yellow_header_{idx}", (x,-1.228,1.105), (.184,.006,.026),
              "safety_yellow", console, bevel=.001)
        h.mesh(f"cabinet_warning_triangle_{idx}",
               [(x-.069,-1.232,1.028),(x-.012,-1.232,1.028),(x-.04,-1.232,1.083)],
               [(0,1,2)], "heat_black", console)
        for line in range(3):
            h.box(f"cabinet_warning_textline_{idx}_{line}", (x+.035,-1.233,1.067-line*.013),
                  (.059,.002,.0035), "cart_chain", console, bevel=0)
    h.box("operator_console_side_handle", (-.075,-.875,1.04), (.030,.12,.041),
          "heat_black", console, bevel=.009)
    h.box("console_maker_plate", (.62,.699,1.473), (.28,.010,.062),
          "brushed_metal", frame, bevel=.002)
    h.label("console_maker_plate_text", "TRANSFER CART", (.62,.707,1.473), .026,
            "heat_black", frame, front="Y").rotation_euler[2] = pi

    # Beacon is attached to the tall head, as photographed, not floating on the panel.
    h.box("head_beacon_bracket", (-1.47,.365,3.065), (.22,.25,.022),
          "dark_structure", head, bevel=.003)
    h.cylinder("head_beacon_black_base", (-1.47,.365,3.092), .064,.044,
               "heat_black", head, sides=32)
    h.cylinder("head_beacon_clear_band", (-1.47,.365,3.133), .059,.042,
               "dial", head, sides=32)
    h.cylinder("head_beacon_orange_lens", (-1.47,.365,3.191), .060,.075,
               "cart_beacon", head, sides=40)
    h.cylinder("head_beacon_top_cap", (-1.47,.365,3.235), .056,.014,
               "cart_beacon", head, sides=32)

    bindings.insert(0, {"id": "cart_travel_position", "node_name": "cart_travel",
                         "source_group": "positions", "source_key": "cart_travel_position",
                         "action": "translate", "axis": "z", "output_max": 1.2})
    return {
        "model_id": "photo_transfer_cart_v6",
        "family": "取料小车",
        "views": [
            {"suffix": "preview", "camera": (6.2,-7.6,5.0),
             "target": (-.12,-.19,1.54), "scale": 5.25},
            {"suffix": "rear", "camera": (-6.2,7.3,4.2),
             "target": (-.22,.0,1.58), "scale": 4.95},
            {"suffix": "chain_side", "camera": (6.3,7.5,4.5),
             "target": (-.19,.02,1.55), "scale": 5.05},
        ],
        "bindings": bindings,
        "shell_groups": [],
        "notes": [
            "照片参考外观重建，尺寸和不可见结构为估算，不构成制造或机构设计图。",
            "Blender Z-up；送料+X，操作侧-Y；轨道与横移沿Y，导出GLB后横移轴为Z。",
            "按三张实拍重做开口钢架、背板双层长环形链/导向、立式青绿色减速机、三辐银手轮、卷盘和斜顶操作柜。",
            "承料结构改成双纵导轨和送料端3只局部长滚筒；未沿用V4整床均布滚筒。滚筒数量与遮挡区机构须实测确认。",
            "轨道为独立静态参考组；走台花纹用低面数单网格，机座中心保留空透关系。",
            "横移1.2m、送料0.92m和卷盘/轮轴转速仅作动画节点示意，尚未接入生产信号或运动联锁。",
            "照片可见链节用于外观识别，未仿真链传动闭环运动或真实传动比。",
        ],
        "reference_photos": [
            "小车/mmexport1783325207583.jpg",
            "小车/mmexport1783325208994.jpg",
            "小车/mmexport1783325210390.jpg",
        ],
        "checks": [],
    }
