"""Independent CAD-image-derived well-furnace variants 03 and 05.

Z is up, the presentation/front face looks toward -Y, and ground is Z=0.
The newest five CAD drawings describe FIVE machines, not orthographic views.
Variant 03 is a sectional elevation, not a plan. Variant 05 was corrected
by the latest user request: it is a cabinet-depth furnace, not a freestanding
door or panel assembly. Depths are estimates: 05 cabinet = 1.65 m,
03 = 1.3 m. CAD display colors are not used as paint colors.
Materials are supplied by the existing multipurpose-furnace palette.
This module only builds geometry through the supplied adapter; it neither
opens Blender scenes nor writes/export files, lights, cameras, or ground.
"""

from __future__ import annotations

import math

__all__ = ["build_three", "build_five"]


def _washer(a, name, loc, parent, axis="Y", radius=.023):
    a.cylinder(name, loc, radius, .0045, "brushed_metal", parent, axis, 16)


def _front_panel(a, name, x, y, z, w, h, parent, material="enamel", bolts=True):
    """Folded removable metal panel, with a narrow dark seam and real fixings."""
    a.box(name + "_seam", (x, y + .004, z), (w + .014, .022, h + .014),
          "gasket", parent, .003)
    a.box(name, (x, y - .012, z), (w, .032, h), material, parent, .006)
    if bolts:
        points = [(x + sx * (w / 2 - .042), y - .033, z + sz * (h / 2 - .042))
                  for sx in (-1, 1) for sz in (-1, 1)]
        for i, point in enumerate(points):
            _washer(a, name + "_washer_" + str(i), point, parent)
        a.bolts(name + "_screw", [(px, py - .004, pz) for px, py, pz in points],
                parent, "Y", .011)


def _side_panel(a, name, x, y, z, depth, height, parent):
    side = 1 if x > 0 else -1
    a.box(name + "_seam", (x, y, z), (.020, depth + .012, height + .012),
          "gasket", parent, .002)
    a.box(name, (x + side * .017, y, z), (.034, depth, height), "enamel", parent)
    points = [(x + side * .038, y + sy * (depth / 2 - .048),
               z + sz * (height / 2 - .043)) for sy in (-1, 1) for sz in (-1, 1)]
    for i, point in enumerate(points):
        _washer(a, name + "_washer_" + str(i), point, parent, "X")
    a.bolts(name + "_screw", points, parent, "X", .011)


def _flange(a, name, loc, radius, parent, axis="Y", material="brushed_metal"):
    x, y, z = loc
    a.cylinder(name + "_flange", loc, radius, .030, material, parent, axis, 32)
    a.cylinder(name + "_collar", loc, radius * .59, .063, "stainless", parent, axis, 24)
    points = []
    for i in range(8):
        t = math.tau * i / 8
        u, v = radius * .80 * math.cos(t), radius * .80 * math.sin(t)
        if axis == "Y":
            point = (x + u, y - .021, z + v)
        elif axis == "X":
            point = (x + .021, y + u, z + v)
        else:
            point = (x + u, y + v, z + .021)
        points.append(point)
    a.bolts(name + "_bolt", points, parent, axis, min(.010, radius * .095))


def _ring(a, name, center, outer, inner, thickness, parent, mat="stainless"):
    """Annulus in XZ: lifting eye / pipe clamp, rather than a painted disc."""
    x, y, z = center
    n = 32
    verts = []
    for yy, r in ((y - thickness / 2, outer), (y + thickness / 2, outer),
                  (y - thickness / 2, inner), (y + thickness / 2, inner)):
        verts.extend((x + r * math.cos(i * math.tau / n), yy,
                      z + r * math.sin(i * math.tau / n)) for i in range(n))
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.extend(((i, j, n + j, n + i),
                      (2 * n + i, 3 * n + i, 3 * n + j, 2 * n + j),
                      (i, 2 * n + i, 2 * n + j, j),
                      (n + i, n + j, 3 * n + j, 3 * n + i)))
    return a.mesh(name, verts, faces, mat, parent, .002)


def _spring(a, name, x, y, bottom, height, radius, parent, turns=7):
    """Single closed helical wire mesh; no stacked cylinders posing as a spring."""
    verts, faces = [], []
    steps, sides, wire = turns * 24, 8, .008
    pitch = height / (turns * math.tau)
    norm = math.sqrt(radius * radius + pitch * pitch)
    for i in range(steps + 1):
        t = turns * math.tau * i / steps
        radial = (math.cos(t), math.sin(t), 0)
        across = (-pitch * math.sin(t) / norm, pitch * math.cos(t) / norm, -radius / norm)
        for j in range(sides):
            u, v = math.cos(j * math.tau / sides), math.sin(j * math.tau / sides)
            verts.append((x + radius * math.cos(t) + wire * (u * radial[0] + v * across[0]),
                          y + radius * math.sin(t) + wire * (u * radial[1] + v * across[1]),
                          bottom + height * i / steps + wire * v * across[2]))
    for i in range(steps):
        for j in range(sides):
            k = (j + 1) % sides
            faces.append((i * sides + j, i * sides + k, (i + 1) * sides + k, (i + 1) * sides + j))
    faces.extend((tuple(reversed(range(sides))), tuple(steps * sides + j for j in range(sides))))
    a.mesh(name, verts, faces, "stainless", parent)


def _spring_bridge(a, parent, center_z, y, width=.98, spring_height=.26):
    """Three guide rods, visible compression coils, a cap, and stiff lower bridge."""
    a.box("spring_bridge_lower", (0, y, center_z), (width + .20, .28, .07),
          "enamel_edge", parent)
    top = center_z + spring_height + .12
    a.box("spring_bridge_upper", (0, y, top), (width, .25, .08), "enamel", parent)
    for i, x in enumerate((-width * .36, 0, width * .36)):
        a.cylinder("bridge_tie_rod_" + str(i), (x, y, (top + center_z) / 2), .021,
                   top - center_z + .15, "stainless", parent)
        a.cylinder("spring_dark_core_" + str(i), (x, y, center_z + .07 + spring_height / 2),
                   .037, spring_height, "dark_structure", parent)
        _spring(a, "compression_spring_" + str(i), x, y, center_z + .068,
                spring_height, .059, parent)
        for z in (center_z + .050, center_z + .085 + spring_height):
            a.cylinder("spring_seat_" + str(i), (x, y, z), .077, .027,
                       "safety_yellow", parent)
        for z in (center_z - .052, top + .058):
            a.cylinder("tie_locknut_" + str(i), (x, y, z), .036, .038,
                       "brushed_metal", parent, sides=6)
    for x in (-width * .48, width * .48):
        a.box("bridge_end_cheek", (x, y, center_z + .15), (.035, .25, .22),
              "enamel_edge", parent)
        a.bolts("bridge_cheek_fixing", [(x, y - .135, center_z + z) for z in (.07, .22)],
                parent, "Y", .013)
    a.pipe("bridge_lift_handle", [(-.15, y, top + .045), (-.15, y, top + .11),
                                  (.15, y, top + .11), (.15, y, top + .045)],
           .013, "stainless", parent, .024)


def build_five(a):
    """05: deep insulated cabinet with the reference's front lift plate and springs.

    The front elevation defines the facade, not the whole machine's depth.
    Five closed cabinet walls enclose a chamber behind the solid front assembly.
    The new depth is an explicit proportional estimate, not a measured CAD value.
    """
    structure = a.group("f5_two_column_panel_frame")
    body = a.group("f5_opaque_solid_main_body")
    lifting = a.group("f5_suspended_solid_inner_plate", dynamic=True)
    guide = a.group("f5_exposed_upper_spring_and_slide")
    hardware = a.group("f5_panel_fasteners")
    structure["dimension_basis"] = "Front proportions from CAD 05; latest verbal correction requires cabinet-depth furnace; 1.65 m cabinet depth is estimated"
    structure["reference_identity"] = "05 cabinet furnace with two front columns, three crossrails, closed side/rear/top/bottom walls and exposed springs"
    body["reference_role"] = "Continuous opaque front assembly mounted on the deep insulated cabinet, not a freestanding door"
    body["estimated_thickness_m"] = .19
    lifting["reference_role"] = "Narrow solid suspended panel with three vertical plate divisions; not a wire cage"
    lifting["estimated_thickness_m"] = .085

    # Preserve the front elevation's columns, but connect them to a deep base.
    for x in (-1.45, 1.45):
        a.box("main_column_web", (x, 0, 2.19), (.055, .24, 4.34), "enamel_edge", structure)
        for xx in (x - .051, x + .051):
            a.box("main_column_flange", (xx, 0, 2.19), (.028, .29, 4.34), "enamel", structure)
        a.box("column_foot", (x, 0, .023), (.24, .45, .046), "dark_structure", structure)
        for yy in (-.16, .16):
            a.beam("foot_gusset", (x, yy, .055), (x, 0, .34), .042,
                   "brushed_metal", structure)
        a.bolts("foundation_anchor", [(x + dx, yy, .058)
                                       for dx in (-.082, .082) for yy in (-.17, .17)],
                hardware, "Z", .016)
        for z in (.46, 1.76, 3.06, 4.36):
            a.box("rail_to_column_plate", (x, -.166, z), (.20, .026, .20),
                  "enamel_edge", structure)
            a.bolts("column_join_bolts", [(x + dx, -.186, z + dz)
                                          for dx in (-.065, .065) for dz in (-.063, .063)],
                    hardware, "Y", .014)

    # One closed front panel spans the main rectangle: never see-through.
    # All front trim sits on top of this continuous body, so seams cannot turn
    # into holes when a cover group is hidden for the review cutaway.
    a.box("continuous_opaque_main_panel", (0, .060, 2.235), (2.77, .19, 4.16),
          "enamel", body, .006)
    a.box("solid_panel_back_sheet", (0, .166, 2.235), (2.77, .026, 4.16),
          "enamel_edge", body, .004)
    for x in (-1.37, 1.37):
        a.box("panel_side_return", (x, .082, 2.235), (.030, .23, 4.16),
              "enamel_edge", body, .004)
    for z in (.166, 4.305):
        a.box("panel_horizontal_edge_fold", (0, .079, z), (2.77, .23, .030),
              "enamel_edge", body, .003)

    # The narrow central rectangle is a real .085 m-thick plate assembly.
    # Three shallow face plates express the reference's vertical divisions;
    # their uninterrupted backing remains behind every small seam.
    a.box("solid_inner_plate_backing", (0, -.081, 2.044), (1.64, .085, 3.872),
          "enamel_edge", lifting, .004)
    for i, x in enumerate((-.545, 0, .545)):
        a.box("inner_plate_face_section_" + str(i), (x, -.135, 2.044),
              (.540, .024, 3.852), "enamel", lifting, .002)
    for x in (-.825, .825):
        a.box("inner_plate_side_fold", (x, -.09, 2.044), (.023, .126, 3.886),
              "brushed_metal", lifting, .002)
    for z in (.108, 3.980):
        a.box("inner_plate_horizontal_fold", (0, -.09, z), (1.672, .126, .025),
              "brushed_metal", lifting, .002)
    for x in (-.813, -.271, .271, .813):
        a.cylinder("solid_plate_suspension_pin", (x, -.159, 3.922), .021, .028,
                   "brass", lifting, "Y", 16)
        a.bolts("suspension_pin_lock", [(x, -.180, 3.922)], lifting, "Y", .011)

    # Three full-width strengthening rails remain in front of both plate sets.
    for z in (.46, 1.76, 3.06):
        a.box("front_crossrail_web", (0, -.181, z), (2.85, .035, .047),
              "enamel_edge", structure)
        for zz in (z - .029, z + .029):
            a.box("crossrail_fold", (0, -.166, zz), (2.85, .082, .014),
                  "enamel_edge", structure)
    a.box("main_top_crossbeam", (0, 0, 4.36), (2.98, .22, .081), "enamel_edge", structure)
    for x in (-1.27, 1.27):
        a.beam("top_corner_brace", (x * .88, .130, 4.35),
               (x * 1.10, .130, 4.15), .053, "brushed_metal", structure)

    # No large hood: the corrected image shows the spring bridge and slide
    # mechanism above the plate's top edge, visible in the ordinary exterior.
    for x in (-.525, .525):
        for yy in (-.180, .017):
            a.cylinder("polished_lift_guide", (x, yy, 4.220), .013, .600,
                       "stainless", guide, sides=16)
        a.box("lift_guide_bearing", (x, -.0815, 4.414), (.178, .27, .11), "enamel_edge", guide)
        a.box("lift_carriage_shoe", (x, -.0815, 4.012), (.14, .25, .066), "brushed_metal", guide)
        for z in (4.38, 4.45):
            a.bolts("guide_bearing_screw", [(x + dx, -.232, z) for dx in (-.055, .055)],
                    hardware, "Y", .010)
    a.box("lift_transfer_bar", (0, -.0815, 4.394), (1.91, .18, .067), "brushed_metal", guide)
    for x in (-1.105, 1.105):
        a.box("outer_carriage_rail", (x, -.0815, 4.434), (.51, .16, .058), "stainless", guide)
        for dx in (-.20, -.12, -.04, .04, .12, .20):
            a.box("rail_web_recess", (x + dx, -.169, 4.436), (.043, .008, .019),
                  "dark_structure", guide, .001)
            a.bolts("rail_fixings", [(x + dx, -.0515, 4.477)], hardware, "Z", .009)
    a.box("spring_bridge_mount", (0, -.0815, 4.476), (.93, .25, .080),
          "brushed_metal", guide)
    _spring_bridge(a, guide, 4.550, -.0815, .88, .255)

    # Move the entire reference-derived facade to the FRONT of the cabinet.
    # Do not stretch bolts/springs or merely thicken a door: add a real enclosure.
    for group in (structure, body, lifting, guide, hardware):
        group.location.y -= .90
    shell = a.group("f5_insulated_cabinet_shell")
    support = a.group("f5_cabinet_support_base")
    shell["cabinet_depth_m"] = 1.65
    shell["depth_is_estimated"] = True
    shell["reference_role"] = "Full-depth furnace enclosure: left/right insulated walls, back, roof and bottom; not a front panel"
    front_y, rear_y = -.90, .75
    center_y = (front_y + rear_y) / 2
    depth = rear_y - front_y
    for side, x in (("L", -1.36), ("R", 1.36)):
        a.box("cabinet_side_wall_" + side, (x, center_y, 2.235), (.14, depth, 4.12),
              "enamel", shell, .012)
        # Shallow folded seams and rails define the cabinet depth without holes.
        for z in (.46, 1.76, 3.06, 4.32):
            a.box("cabinet_side_crossrail_" + side, (x + (.084 if x > 0 else -.084), center_y, z),
                  (.030, depth, .045), "enamel_edge", shell, .003)
        for y in (front_y + .035, rear_y - .035):
            a.box("cabinet_side_edge_post_" + side, (x + (.091 if x > 0 else -.091), y, 2.235),
                  (.030, .072, 4.20), "enamel_edge", shell, .003)
        points = [(x + (.106 if x > 0 else -.106), y, z)
                  for y in (front_y + .10, rear_y - .10)
                  for z in (.48, 1.78, 3.08, 4.30)]
        a.bolts("cabinet_side_fixing_" + side, points, shell, "X", .011)
    a.box("cabinet_back_wall", (0, rear_y - .08, 2.235), (2.64, .14, 4.12),
          "enamel", shell, .012)
    for name, z in (("bottom", .165), ("top", 4.305)):
        a.box("cabinet_" + name, (0, center_y, z), (2.86, depth, .14),
              "enamel_edge", shell, .012)
    # The interior stays a usable chamber, rather than a giant solid cuboid.
    for x in (-1.225, 1.225):
        a.box("cabinet_inner_insulation", (x, -.025, 2.235), (.13, 1.34, 3.99),
              "refractory", shell, .008)
    a.box("cabinet_rear_insulation", (0, .52, 2.235), (2.45, .16, 3.99),
          "refractory", shell, .008)
    for z in (.305, 4.16):
        a.box("cabinet_end_insulation", (0, -.025, z), (2.45, 1.34, .14),
              "refractory", shell, .008)
    for x in (-1.34, 1.34):
        a.box("cabinet_longitudinal_skid", (x, center_y, .055), (.16, 1.95, .11),
              "dark_structure", support, .005)
        a.box("cabinet_rear_support_pad", (x, .71, .022), (.31, .43, .044),
              "dark_structure", support, .005)
        a.bolts("cabinet_rear_anchor", [(x + dx, .82, .054) for dx in (-.105, .105)],
                support, "Z", .016)
    for y in (-.77, .61):
        a.box("cabinet_base_crossmember", (0, y, .074), (2.85, .14, .095),
              "dark_structure", support, .004)
    return {"structure": structure, "body": body, "lifting": lifting,
            "guide": guide, "hardware": hardware, "shell": shell, "support": support}


def build_three(a):
    """Variant 03: narrow high body with wide T shoulders and two low pumps."""
    frame = a.group("f3_fixed_base_and_tower_frame")
    shell = a.group("f3_T_shoulder_enclosure")
    plate = a.group("f3_suspended_inner_workpiece_cage", dynamic=True)
    front_cover = a.group("external_cover_f3_front_shell")
    tank_cover = a.group("external_cover_f3_reservoir_front")
    lining = a.group("f3_thick_section_walls_and_rear_lining")
    guide = a.group("f3_upper_internal_guide")
    left = a.group("f3_low_left_reservoir_and_pump")
    plumbing = a.group("f3_exposed_process_pipework")
    instruments = a.group("f3_upper_right_double_gauge")
    pump = a.group("f3_lower_center_pump")
    frame["dimension_basis"] = "Newest CAD 141f63ef-ad6c-4ffa-8de8-b2ddb70fbb21.png; upper width 2.2 m, lower width 1.5 m, height about 4.5 m, estimated depth 1.3 m"
    frame["reference_identity"] = "Independent well furnace 03; fixed base, no furnace-01 cart or left loading platform"
    front_cover["hide_for_cutaway"] = True
    tank_cover["hide_for_cutaway"] = True
    plate["reference_role"] = "Internal hanging cage in the open well, not an external door"
    lining["wall_section_thickness_m"] = .085

    # Narrow fixed pedestal and the recognizable broad top shoulders.
    for x in (-.728, .728):
        a.box("base_longitudinal_channel", (x, 0, .075), (.095, 1.38, .15),
              "enamel_edge", frame)
        for y in (-.62, .62):
            a.box("tower_foot_plate", (x, y, .018), (.20, .24, .036), "dark_structure", frame)
            a.bolts("tower_anchor", [(x + dx, y + dy, .046)
                                      for dx in (-.065, .065) for dy in (-.082, .082)],
                    frame, "Z", .013)
            a.box("narrow_corner_upright", (x, y, 1.60), (.059, .065, 3.06),
                  "enamel_edge", frame)
    for z in (.13, .80, 3.12):
        for y in (-.650, .650):
            a.box("lower_cross_rail", (0, y, z), (1.54, .062, .068), "enamel_edge", frame)
    for x in (-.37, 0, .37):
        for y in (-.642, .642):
            a.box("open_pedestal_vertical_strut", (x, y, .442), (.044, .042, .638),
                  "enamel_edge", frame)
    for x in (-1.065, 1.065):
        for y in (-.628, .628):
            a.box("head_corner_post", (x, y, 3.81), (.078, .079, 1.39),
                  "enamel_edge", frame)
    for z in (3.115, 3.755, 4.475):
        for y in (-.660, .660):
            a.box("head_wide_cross_rail", (0, y, z), (2.19, .068, .065),
                  "enamel_edge", frame)
        for x in (-1.065, 1.065):
            a.box("head_side_rail", (x, 0, z), (.065, 1.31, .065), "enamel_edge", frame)

    # Sheet enclosure: upper head wider than lower furnace well.
    for y, tag in ((-.610, "front"), (.620, "rear")):
        panel_parent = front_cover if tag == "front" else shell
        for row, (z, h) in enumerate(((1.389, 1.06), (2.489, 1.07))):
            for col, x in enumerate((-.361, .361)):
                _front_panel(a, tag + "_body_panel_%d_%d" % (row, col), x, y, z,
                             .701, h, panel_parent)
        for row, (z, h) in enumerate(((3.415, .526), (4.101, .635))):
            for col, x in enumerate((-.711, 0, .711)):
                _front_panel(a, tag + "_head_panel_%d_%d" % (row, col), x, y, z,
                             .689, h, panel_parent)
    for x in (-.713, .713):
        for row, (z, h) in enumerate(((1.382, 1.074), (2.492, 1.077))):
            _side_panel(a, "body_side_%s_%d" % ("L" if x < 0 else "R", row),
                        x, 0, z, 1.20, h, shell)
    for x in (-1.041, 1.041):
        for row, (z, h) in enumerate(((3.42, .545), (4.10, .645))):
            _side_panel(a, "head_side_%s_%d" % ("L" if x < 0 else "R", row),
                        x, 0, z, 1.20, h, shell)
    a.box("roof_dark_seal", (0, 0, 4.470), (2.12, 1.24, .027), "gasket", shell)
    a.box("head_roof_cover", (0, 0, 4.497), (2.16, 1.30, .039), "enamel", shell)
    # Shoulder ledges do not span the well: a full-width plate here would
    # incorrectly bisect/close the long suspended internal cage.
    for x in (-.88, .88):
        a.box("shoulder_underside_ledge", (x, 0, 3.126), (.33, 1.25, .064),
              "enamel_edge", shell)
    # Actual sectional thickness around a hollow chamber, rather than a
    # giant solid cuboid. Pale metal inner faces are readable in cutaway view.
    for x in (-.679, .679):
        a.box("lower_well_thick_side", (x, .006, 1.98), (.085, 1.215, 2.32),
              "enamel_edge", lining, .006)
        a.box("lower_well_inner_skin", (x - (.047 if x > 0 else -.047), .005, 1.98),
              (.011, 1.183, 2.30), "brushed_metal", lining, .002)
    for x in (-1.011, 1.011):
        a.box("wide_head_thick_side", (x, .006, 3.815), (.085, 1.215, 1.32),
              "enamel_edge", lining, .006)
        a.box("wide_head_inner_skin", (x - (.047 if x > 0 else -.047), .005, 3.815),
              (.011, 1.18, 1.30), "brushed_metal", lining, .002)
    a.box("lower_well_rear_lining", (0, .566, 1.98), (1.30, .075, 2.32),
          "brushed_metal", lining, .004)
    a.box("wide_head_rear_lining", (0, .566, 3.815), (1.98, .075, 1.32),
          "brushed_metal", lining, .004)
    a.box("head_internal_ceiling", (0, .008, 4.451), (1.98, 1.14, .040),
          "brushed_metal", lining, .004)
    for x in (-.824, .824):
        a.box("shoulder_insulated_horizontal_section", (x, .006, 3.174),
              (.379, 1.20, .074), "enamel_edge", lining, .004)
    for y in (-.573, .573):
        a.bolts("roof_cover_screws", [(x, y, 4.525) for x in (-.97, -.65, -.32, 0, .32, .65, .97)],
                shell, "Z", .011)
    # The below-chamber pedestal stays open, exposing its pump and bracing.
    # The long rectangle in the CAD is a suspended inner assembly. Build an
    # open rectangular cage at the center of the real cavity, not a front slab.
    for x in (-.513, -.171, .171, .513):
        for y in (-.284, .255):
            a.box("cage_long_vertical", (x, y, 2.19), (.012, .013, 2.676),
                  "stainless" if abs(x) > .3 else "brushed_metal", plate, .0015)
    for z in (.852, 3.528):
        for y in (-.284, .255):
            a.box("cage_horizontal_end", (0, y, z), (1.038, .018, .019),
                  "stainless", plate, .0015)
        for x in (-.513, .513):
            a.box("cage_depth_end", (x, -.0145, z), (.018, .558, .019),
                  "stainless", plate, .0015)
    for x in [i * .082 for i in range(-6, 7)]:
        a.rod("cage_bottom_grid", (x, -.284, .87), (x, .255, .87), .005,
              "brushed_metal", plate, 8)
    for x in (-.491, 0, .491):
        for z in (.895, 3.482):
            _washer(a, "cage_attachment_washer", (x, -.300, z), plate, radius=.023)
            a.cylinder("cage_attachment_bolt", (x, -.307, z), .011, .020,
                       "stainless", plate, "Y", 6)

    # Upper front mechanism is partly nested inside the broad shoulder; there
    # is deliberately no oversized external top mast from variant 01.
    a.box("head_transfer_crossbeam", (0, -.050, 3.827), (1.64, .32, .074),
          "brushed_metal", guide)
    for x in (-.395, .395):
        for yy in (-.284, .255):
            a.cylinder("head_guide_rod", (x, yy, 3.729), .011, .39,
                       "stainless", guide, sides=16)
        a.box("head_guide_slide", (x, -.0145, 3.805), (.12, .59, .115), "enamel_edge", guide)
        a.bolts("head_slide_bolts", [(x + dx, -.316, 3.809) for dx in (-.038, .038)],
                guide, "Y", .010)
    _spring_bridge(a, guide, 3.875, -.065, .48, .158)
    for x in (-.932, .932):
        a.box("top_edge_lug_base", (x, -.07, 4.527), (.145, .22, .022),
              "brushed_metal", guide)
        _ring(a, "top_edge_lift_eye", (x, -.07, 4.565), .052, .025, .021, guide)

    # Low left ancillary reservoir, visibly separate from the tall furnace.
    for x in (-1.630, -1.020):
        a.box("reservoir_skid", (x, .04, .040), (.10, 1.20, .080), "dark_structure", left)
    a.box("reservoir_tank_bottom", (-1.322, .035, .085), (.70, 1.20, .050), "enamel_edge", left)
    for x in (-1.655, -.989):
        a.box("reservoir_thick_side", (x, .035, .452), (.052, 1.20, .727), "enamel", left)
    a.box("reservoir_rear_wall", (-1.322, .609, .452), (.68, .052, .727), "enamel", left)
    a.box("reservoir_top_lid_seal", (-1.322, .035, .833), (.709, 1.211, .026), "gasket", left)
    a.box("reservoir_top_lid", (-1.322, .035, .858), (.744, 1.25, .032), "enamel_edge", left)
    _front_panel(a, "reservoir_access_cover", -1.323, -.590, .471, .61, .60, tank_cover)
    a.box("upper_left_valve_box", (-1.341, .175, 1.120), (.53, .74, .486), "enamel", left)
    a.box("upper_left_box_lid", (-1.341, .175, 1.377), (.55, .76, .030), "enamel_edge", left)
    for y in (-.468, .524):
        a.bolts("reservoir_lid_bolt", [(x, y, .885) for x in (-1.608, -1.325, -1.039)],
                left, "Z", .012)
    a.box("left_pump_mount", (-1.184, -.734, .140), (.33, .40, .045), "brushed_metal", left)
    a.motor("left_circulation_motor", (-1.178, -.767, .276), .60, "X", left, "motor_teal")
    a.cylinder("left_pump_volute", (-1.40, -.770, .273), .105, .13,
               "motor_teal", left, "X", 32)
    _flange(a, "left_pump_flange", (-1.478, -.770, .273), .091, left, "X")
    a.cylinder("reservoir_fill_cap", (-1.564, .310, .903), .036, .062,
               "brushed_metal", left, sides=16)
    a.cylinder("reservoir_fill_knob", (-1.564, .310, .938), .049, .017,
               "dark_structure", left, sides=12)

    # Low central pump and the characteristic tall surface-mounted feed pipe.
    a.box("central_pump_plinth", (0, -.812, .097), (.38, .52, .095), "enamel_edge", pump)
    a.box("central_pump_sole", (0, -.854, .157), (.31, .41, .038), "brushed_metal", pump)
    a.motor("center_pump_motor", (0, -.876, .337), .80, "Y", pump, "motor_blue")
    a.cylinder("center_pump_volute", (0, -.697, .337), .137, .113,
               "motor_blue", pump, "Y", 32)
    _flange(a, "center_pump_suction", (0, -.620, .337), .113, pump)
    for x in (-.117, .117):
        a.bolts("pump_foot_bolt", [(x, y, .190) for y in (-1.009, -.710)], pump, "Z", .012)
    a.pipe("central_pump_riser", [(0, -.666, .355), (0, -.666, .614),
                                  (.318, -.666, .614), (.318, -.666, .823)],
           .038, "brushed_metal", plumbing, .070)
    a.pipe("central_return_loop", [(.117, -.690, .36), (.473, -.69, .36),
                                   (.473, -.69, .802), (.70, -.69, .802)],
           .030, "brushed_metal", plumbing, .060)
    _flange(a, "center_riser_joint", (.318, -.666, .74), .072, plumbing, "Z")
    _flange(a, "center_return_joint", (.473, -.69, .62), .061, plumbing, "Z")

    a.pipe("left_outer_vertical_service", [(-1.306, .233, 1.363), (-1.183, .233, 1.363),
                                            (-1.183, .233, 3.405), (-1.055, .233, 3.405)],
           .051, "enamel_edge", plumbing, .080)
    a.pipe("front_long_feed", [(-1.394, -.820, .303), (-1.56, -.820, .303),
                               (-1.56, -.820, .60), (-.476, -.820, .60),
                               (-.476, -.820, 4.171), (.604, -.820, 4.171)],
           .020, "dark_structure", plumbing, .047)
    a.pipe("lower_horizontal_service", [(-1.864, -.735, .878), (-1.864, -.735, .992),
                                         (-1.56, -.735, .992), (.881, -.735, .992)],
           .021, "brushed_metal", plumbing, .045)
    a.pipe("tank_return_line", [(-1.536, -.766, .290), (-1.536, -.766, .53),
                                (-1.085, -.766, .53), (-1.085, -.40, .53)],
           .021, "dark_structure", plumbing, .040)
    for z in (1.19, 2.14, 3.05, 3.94):
        a.box("long_pipe_standoff", (-.476, -.758, z), (.083, .073, .042),
              "brushed_metal", plumbing, .003)
        a.cylinder("long_pipe_clamp", (-.476, -.820, z), .028, .023,
                   "brushed_metal", plumbing)
        a.bolts("pipe_bracket_fixing", [(-.435, -.802, z)], plumbing, "Y", .008)
    for x in (-1.60, -.831, -.181, .681):
        a.box("lower_pipe_support", (x, -.693, .992), (.045, .11, .072),
              "brushed_metal", plumbing, .003)
    for x in (-.935, .935):
        a.pipe("head_edge_vertical_line", [(x, -.711, 3.378), (x, -.711, 4.355),
                                           (x * .86, -.711, 4.355)],
               .018, "dark_structure", plumbing, .030)
    _flange(a, "left_vertical_pipe_upper_joint", (-1.183, .233, 3.21), .080, plumbing, "Z")
    _flange(a, "left_vertical_pipe_lower_joint", (-1.183, .233, 1.51), .080, plumbing, "Z")
    for x in (-1.598, .741):
        _flange(a, "lower_manifold_joint", (x, -.735, .992), .052, plumbing, "X")
    a.cylinder("service_valve_body", (-1.46, -.821, .60), .039, .089, "brass", plumbing, "X", 16)
    a.rod("valve_stem", (-1.46, -.821, .60), (-1.46, -.905, .60), .009, "stainless", plumbing)
    a.handwheel("reservoir_isolation_handwheel", (-1.46, -.919, .60), plumbing, .047)
    a.cylinder("center_valve_body", (.318, -.666, .65), .046, .068, "brass", plumbing)
    a.handwheel("center_pump_handwheel", (.318, -.772, .65), plumbing, .043)

    # Distinctive right shoulder U-pipe and vertically stacked instrumentation.
    a.pipe("right_upper_U_service", [(1.061, .17, 3.55), (1.292, .17, 3.55),
                                      (1.292, .17, 4.086), (1.154, .17, 4.086)],
           .047, "enamel_edge", instruments, .083)
    _flange(a, "right_upper_pipe_connection", (1.106, .17, 3.55), .079, instruments, "X")
    a.box("dual_gauge_mounting_bracket", (1.293, .025, 4.103), (.21, .34, .018),
          "brushed_metal", instruments)
    a.box("dual_gauge_box", (1.295, -.051, 4.129), (.215, .16, .328), "enamel", instruments)
    a.box("dual_gauge_face", (1.295, -.138, 4.129), (.195, .017, .31), "dial", instruments)
    a.gauge("upper_service_gauge", 1.295, -.157, 4.199, instruments, .050)
    a.gauge("lower_service_gauge", 1.295, -.157, 4.073, instruments, .050)
    a.bolts("gauge_box_cover_screw", [(x, -.153, z) for x in (1.216, 1.374)
                                     for z in (3.997, 4.260)], instruments, "Y", .008)
    a.pipe("gauge_upper_impulse_pipe", [(1.295, .010, 4.30), (1.295, .010, 4.486),
                                        (1.258, .010, 4.486)],
           .011, "stainless", instruments, .018)
    a.box("gauge_tube_guard", (1.334, .018, 4.404), (.024, .030, .24),
          "dark_structure", instruments)

    return {"frame": frame, "shell": shell, "plate": plate, "guide": guide,
            "left": left, "plumbing": plumbing, "instruments": instruments, "pump": pump,
            "front_cover": front_cover, "tank_cover": tank_cover, "lining": lining}
