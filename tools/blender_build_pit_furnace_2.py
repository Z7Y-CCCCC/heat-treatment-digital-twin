"""Pit furnace 2, reconstructed from the user's second CAD screenshot.

The screenshot is a sectional elevation, not a dimensioned 3D drawing. Height
is normalized to approximately 5 m; the 1.5 m depth is an explicit visual
assumption. The upper hood, narrow lower well, left lid lifting standard and
right finned air connection distinguish this unit from the other four.

This module only authors the equipment geometry. The coordinator supplies the
existing multipurpose-furnace palette, mesh helpers, export and review scenes.
Front skins live in external_cover groups so the sectional assembly remains
inspectable without cutting or modifying the underlying model.
"""

import math


def _flange_y(a, name, x, y, z, r, parent, mat="stainless", count=8):
    a.cylinder(name + "_disc", (x, y, z), r, .029, mat, parent, "Y", 32)
    a.bolts(name + "_bolts", [
        (x + r * .78 * math.cos(i * math.tau / count), y - .025,
         z + r * .78 * math.sin(i * math.tau / count))
        for i in range(count)
    ], parent, "Y", .012)


def _spring(a, name, x, y, bottom, height, radius, parent):
    # One continuous helix, rather than a pile of unrelated torus rings.
    turns = 8
    points = [(x + radius * math.cos(i * math.tau / 20),
               y + radius * math.sin(i * math.tau / 20),
               bottom + height * i / (turns * 20))
              for i in range(turns * 20 + 1)]
    a.pipe(name + "_coil", points, .009, "safety_yellow", parent, .001)
    for z in (bottom - .012, bottom + height + .012):
        a.cylinder(name + "_seat", (x, y, z), radius * 1.28,
                   .026, "brushed_metal", parent, sides=24)
    a.cylinder(name + "_tie_rod", (x, y, bottom + height / 2),
               .015, height + .10, "stainless", parent, sides=16)


def _wall_bolts(a, parent):
    # Seam fasteners follow the lower shaft and shoulder edges.
    for x in (-.895, .895):
        a.bolts("shaft_seam_fixings", [(x, -.803, z)
                for z in (.13, .95, 1.72, 2.51, 3.12)], parent, "Y", .015)
    for x in (-1.32, 1.32):
        a.bolts("shoulder_seam_fixings", [(x, -.803, z)
                for z in (3.25, 3.70, 4.24, 4.40)], parent, "Y", .014)


def build_two(a):
    """Author pit furnace 2. All coordinates are Z-up, front is negative Y."""
    structure = a.group("well_structure")
    structure["reference"] = "CAD 2: narrow shaft, broad upper chamber, left lifting column, right finned duct"
    structure["depth_assumption_m"] = 1.5

    # Bottom floor and four short anchor feet. No transport chassis or wheels.
    a.box("well_bottom_folded_pan", (0, 0, .075), (1.92, 1.56, .15),
          "enamel_edge", structure, .011)
    a.box("well_bottom_inside_lining", (0, 0, .19), (1.68, 1.29, .10),
          "refractory", structure, .004)
    for x in (-.83, .83):
        for y in (-.62, .62):
            a.box("anchor_foot", (x, y, .02), (.27, .27, .04),
                  "brushed_metal", structure, .004)
            a.bolts("foundation_bolt", [(x, y, .055)], structure, "Z", .022)

    # Lower well: side sheets, rear sheet, insulation and actual empty space.
    for sign in (-1, 1):
        x = sign * .93
        a.box("lower_side_skin", (x, 0, 1.65), (.055, 1.5, 3.0),
              "enamel", structure, .004)
        a.box("lower_insulation_slab", (sign * .863, 0, 1.64),
              (.077, 1.42, 2.96), "refractory", structure, .002)
        for z in (.14, 1.0, 1.84, 2.65, 3.17):
            a.box("shaft_stiffener", (sign * .956, 0, z),
                  (.061, 1.55, .048), "enamel_edge", structure, .002)
        for y in (-.737, .737):
            a.box("shaft_corner_fold", (sign * .945, y, 1.66),
                  (.075, .06, 3.09), "enamel_edge", structure, .003)
    a.box("lower_rear_sheet", (0, .752, 1.65), (1.87, .052, 3.0),
          "enamel", structure, .004)
    a.box("lower_rear_insulation", (0, .69, 1.66), (1.70, .064, 2.96),
          "refractory", structure, .002)
    # A slight inner sheet protects insulation; it does not fill the well.
    for sign in (-1, 1):
        a.box("inner_stainless_liner", (sign * .811, 0, 1.66),
              (.012, 1.35, 2.95), "brushed_metal", structure, .001)
    a.box("inner_rear_liner", (0, .646, 1.66), (1.61, .012, 2.95),
          "brushed_metal", structure, .001)

    # Broad upper shoulder. These independent walls create a T silhouette.
    upper = a.group("upper_shoulder_chamber")
    for sign in (-1, 1):
        a.box("upper_side_skin", (sign * 1.352, 0, 3.805),
              (.058, 1.56, 1.27), "enamel", upper, .006)
        a.box("upper_side_insulation", (sign * 1.291, 0, 3.81),
              (.06, 1.44, 1.16), "refractory", upper, .002)
        a.box("upper_inner_side_sheet", (sign * 1.252, 0, 3.81),
              (.014, 1.4, 1.15), "brushed_metal", upper, .002)
        # Shoulder undersides support the overhang but leave the center open.
        a.box("shoulder_horizontal_return", (sign * 1.13, 0, 3.18),
              (.45, 1.55, .075), "enamel_edge", upper, .004)
        a.box("shoulder_inner_shelf", (sign * 1.075, 0, 3.245),
              (.34, 1.35, .052), "refractory", upper, .003)
        for y in (-.737, .737):
            a.box("upper_corner_angle", (sign * 1.353, y, 3.81),
                  (.082, .082, 1.28), "enamel_edge", upper, .003)
    a.box("upper_back_sheet", (0, .757, 3.80), (2.70, .053, 1.25),
          "enamel", upper, .004)
    a.box("upper_back_insulation", (0, .704, 3.80), (2.55, .05, 1.15),
          "refractory", upper, .002)
    a.box("upper_back_inner_sheet", (0, .673, 3.80), (2.5, .014, 1.15),
          "brushed_metal", upper, .001)
    for y in (-.76, .76):
        a.box("shoulder_mouth_rim", (0, y, 4.435), (2.76, .08, .071),
              "brushed_metal", upper, .004)
    for x in (-1.34, 1.34):
        a.box("shoulder_end_rim", (x, 0, 4.435), (.08, 1.54, .071),
              "brushed_metal", upper, .004)

    # Flat front covers are removable for a genuine sectional review.
    front = a.group("external_cover_front")
    a.box("shaft_front_gasket", (0, -.765, 1.66), (1.86, .016, 3.055),
          "gasket", front, .004)
    for i, z in enumerate((.66, 1.66, 2.66)):
        a.box("shaft_front_panel_%02d" % i, (0, -.789, z),
              (1.805, .033, .993), "enamel", front, .004)
    a.box("shoulder_front_gasket", (0, -.766, 3.80), (2.697, .017, 1.249),
          "gasket", front, .004)
    a.box("shoulder_front_panel", (0, -.790, 3.80), (2.637, .033, 1.203),
          "enamel", front, .004)
    _wall_bolts(a, front)

    # Upper plug lid / circulation hood. Its shell has a visible hollow underside.
    hood = a.group("lid_hood_shell")
    for x in (-.90, .90):
        a.box("hood_side", (x, 0, 4.35), (.045, 1.33, .86),
              "enamel", hood, .006)
    a.box("hood_back", (0, .647, 4.35), (1.80, .045, .86),
          "enamel", hood, .006)
    a.box("hood_roof", (0, 0, 4.81), (1.94, 1.41, .071),
          "enamel", hood, .008)
    for y in (-.669, .669):
        a.box("hood_roof_folded_lip", (0, y, 4.764), (1.91, .041, .064),
              "stainless", hood, .003)
    for x in (-.945, .945):
        a.box("hood_mount_ear", (x, 0, 4.80), (.105, 1.49, .033),
              "brushed_metal", hood, .002)
    lid_front = a.group("external_cover_hood")
    a.box("hood_front", (0, -.659, 4.35), (1.815, .034, .86),
          "enamel", lid_front, .006)
    # Seven distinctive rectangular upper hood tabs from the drawing.
    for i in range(7):
        x = -.71 + i * .237
        a.box("hood_service_tab", (x, -.683, 4.65), (.106, .038, .024),
              "brushed_metal", lid_front, .002)
        a.bolts("hood_tab_fixing", [(x, -.709, 4.65)], lid_front, "Y", .009)

    # Tall left lifting column and top cantilever arm. Explicit hinge hardware.
    lift = a.group("left_lid_lift_standard")
    for y in (-.49, .49):
        a.box("lift_standard_leg", (-1.48, y, 4.195), (.095, .095, 1.61),
              "dark_structure", lift, .004)
        a.box("lift_standard_mount", (-1.415, y, 3.50), (.22, .21, .095),
              "enamel_edge", lift, .004)
        a.bolts("standard_mount_bolts", [(-1.426, y-.066, 3.556),
                                      (-1.426, y+.066, 3.556)], lift, "Z", .014)
        a.box("upper_cantilever_beam", (-.43, y, 4.947), (2.19, .078, .091),
              "dark_structure", lift, .003)
        a.beam("cantilever_knee", (-1.48, y, 4.77), (-1.13, y, 4.929),
               .061, "brushed_metal", lift)
        for z in (3.50, 3.64, 4.08, 4.48, 4.90):
            a.box("lift_column_cross_bracket", (-1.495, y, z),
                  (.14, .145, .039), "brushed_metal", lift, .002)
        a.rod("lift_guide_bar", (-1.537, y, 3.50), (-1.537, y, 4.91),
              .017, "stainless", lift, 16)
    a.box("lift_column_backplate", (-1.514, 0, 4.195), (.043, 1.09, 1.61),
          "enamel_edge", lift, .005)
    a.rod("hood_hinge_pivot", (-1.469, -.62, 4.84), (-1.469, .62, 4.84),
          .037, "stainless", lift, 24)
    for y in (-.57, .57):
        _flange_y(a, "lid_hinge_bearing", -1.469, y, 4.84, .077, lift)
    # Twin lift links between the support beam and lid. No unsupported motor.
    for x in (-.52, .50):
        for y in (-.49, .49):
            a.rod("lid_suspension_stud", (x, y, 4.84), (x, y, 4.978),
                  .017, "stainless", lift, 16)
            a.cylinder("lid_suspension_nut", (x, y, 4.886), .029,
                       .024, "brushed_metal", lift, sides=6)
    a.cylinder("manual_lift_bearing", (-1.58, -.51, 3.64), .075, .074,
               "brushed_metal", lift, "Y", 24)
    a.rod("manual_lift_shaft", (-1.76, -.51, 3.64), (-1.45, -.51, 3.64),
          .02, "stainless", lift, 16)
    a.pipe("manual_lift_crank", [(-1.76,-.51,3.64),(-1.76,-.51,3.52),
                                 (-1.76,-.65,3.52)], .018,
           "dark_structure", lift, .025)

    # Side outlet is a squared duct with a vertical finned terminal, as in CAD.
    air = a.group("right_upper_air_duct")
    a.box("right_side_duct", (1.345, .12, 4.631), (.93, .49, .177),
          "enamel", air, .012)
    a.box("right_duct_root_flange", (.922, .12, 4.631), (.055, .59, .259),
          "brushed_metal", air, .005)
    a.bolts("duct_root_fixings", [(.965, y, z)
             for y in (-.075,.315) for z in (4.56,4.70)], air, "X", .011)
    a.box("downturned_duct_neck", (1.603, .12, 4.478), (.351, .42, .197),
          "enamel_edge", air, .005)
    for z in (4.381, 4.075):
        a.box("finned_terminal_flange", (1.603, .12, z), (.387, .458, .027),
              "brushed_metal", air, .004)
        a.bolts("terminal_flange_fasteners", [(x,y,z+.021)
                 for x in (1.46,1.745) for y in (-.046,.286)], air, "Z", .011)
    a.box("terminal_core", (1.603,.12,4.228), (.297,.334,.28),
          "dark_structure", air, .006)
    for i in range(13):
        a.box("terminal_horizontal_cooling_fin_%02d" % i,
              (1.603,.12,4.095+i*.022), (.36,.413,.010),
              "stainless", air, .002)
    a.box("terminal_bottom_opening", (1.603,.12,4.054), (.295,.329,.017),
          "heat_black", air, .002)
    for y in (-.077, .317):
        for x in (1.442,1.764):
            a.rod("terminal_tie_stud", (x,y,4.04),(x,y,4.403),
                  .009,"brushed_metal",air,12)

    # Support track and the three-spring suspension under the lid.
    carriage = a.group("upper_internal_support_bridge")
    for y in (-.37,.32):
        a.box("upper_support_channel", (0,y,3.60),(1.68,.087,.10),
              "brushed_metal",carriage,.003)
        for x in (-.815,.815):
            a.box("channel_end_bracket",(x,y,3.611),(.11,.145,.15),
                  "enamel_edge",carriage,.004)
        # Continuous side beams and regularly spaced web openings.
        for z in (3.684,3.732):
            a.box("perforated_bridge_flange",(0,y,z),(1.54,.069,.016),
                  "stainless",carriage,.002)
        for i in range(19):
            a.box("perforated_bridge_web_%02d"%i,(-.745+i*.0828,y,3.708),
                  (.020,.05,.046),"stainless",carriage,.001)
    for x in (-.36,.36):
        a.box("guide_crosshead",(x,-.025,3.724),(.14,.82,.052),
              "brushed_metal",carriage,.003)
        a.bolts("guide_crosshead_bolts",[(x,y,3.762) for y in (-.30,.26)],
                carriage,"Z",.014)
    a.box("spring_upper_crosshead",(0,-.18,3.993),(.52,.27,.055),
          "brushed_metal",carriage,.004)
    for i,x in enumerate((-.20,0,.20)):
        _spring(a,"support_spring_%02d"%i,x,-.18,3.761,.19,.026,carriage)
    for x in (-.31,.31):
        for y in (-.37,.12):
            a.rod("suspension_guide",(x,y,3.423),(x,y,3.776),
                  .013,"stainless",carriage,16)
            a.cylinder("guide_slider",(x,y,3.692),.027,.09,
                       "brushed_metal",carriage,sides=20)

    # Hanging rectangular load fixture is open, not a false solid front door.
    load = a.group("suspended_fixture", dynamic=True)
    load["geometry_basis"] = "Fine rectangular hanging outline in the section; rod/cage thickness inferred"
    for y in (-.29,.27):
        for x in (-.51,.51):
            a.box("load_carrier_corner",(x,y,2.105),(.019,.024,2.605),
                  "stainless",load,.0015)
        for z in (.80,3.412):
            a.box("load_carrier_crossbar",(0,y,z),(1.05,.032,.025),
                  "stainless",load,.0015)
        for x in (-.17,.17):
            a.rod("load_hanger_tie",(x,y,.81),(x,y,3.414),.006,
                  "brushed_metal",load,10)
    for x in (-.51,.51):
        for z in (.80,3.412):
            a.box("load_carrier_depth_tie",(x,-.01,z),(.026,.59,.026),
                  "stainless",load,.0015)
    for i in range(10):
        a.box("load_tray_slat_%02d"%i,(-.458+i*.102,-.01,.809),
              (.028,.55,.023),"brushed_metal",load,.0015)
    for x in (-.49,-.17,0,.17,.49):
        a.cylinder("load_upper_fastener",(x,-.32,3.385),.017,.02,
                   "brass",load,"Y",8)

    # Bottom circulation impeller in a shallow protected recess.
    fan = a.group("bottom_circulation_fan")
    a.box("fan_base_mount",(0,.07,.255),(.60,.46,.074),
          "enamel_edge",fan,.005)
    for x in (-.23,.23):
        a.box("fan_bearing_pedestal",(x,.07,.34),(.06,.32,.18),
              "dark_structure",fan,.004)
        a.bolts("fan_base_fasteners",[(x,y,.30) for y in(-.05,.19)],
                fan,"Z",.011)
    a.cylinder("fan_scroll_rear",(0,.26,.47),.183,.16,
               "motor_teal",fan,"Y",40)
    _flange_y(a,"fan_service_rim",0,.168,.47,.195,fan,"brushed_metal",8)
    rotor = a.group("bottom_circulation_impeller", dynamic=True)
    a.cylinder("fan_hub",(0,.137,.47),.054,.04,"stainless",rotor,"Y",24)
    for i in range(9):
        angle=i*math.tau/9
        blade=a.box("fan_radial_blade_%02d"%i,
                    (.103*math.cos(angle),.131,.47+.103*math.sin(angle)),
                    (.115,.026,.033),"brushed_metal",rotor,.003)
        blade.rotation_euler[1]=-angle
    for x in (-.265,.265):
        a.rod("fan_guard_vertical",(x,-.05,.25),(x,-.05,.66),
              .008,"dark_structure",fan,10)
    for z in (.31,.46,.61):
        a.rod("fan_guard_crosswire",(-.36,-.061,z),(.36,-.061,z),
              .007,"dark_structure",fan,10)
    # Folded base baffle (a real shallow U pan rather than a black slab).
    a.box("fan_lower_baffle_floor",(0,-.07,.235),(1.10,.83,.023),
          "stainless",fan,.002)
    for x in (-.558,.558):
        wall=a.box("fan_lower_baffle_flare",(x,-.07,.287),(.023,.83,.116),
                   "stainless",fan,.002)
        wall.rotation_euler[1]=math.radians(24 if x>0 else -24)

    # Remaining external trims, one unambiguous left service feed.
    services=a.group("left_service_feed")
    a.pipe("upper_instrument_feed",[(-1.43,-.44,3.55),(-1.60,-.44,3.55),
                                    (-1.60,-.44,4.54),(-1.37,-.44,4.54)],
           .017,"brushed_metal",services,.045)
    for z in (3.66,4.08,4.49):
        a.box("service_feed_clamp",(-1.594,-.432,z),(.066,.062,.03),
              "enamel_edge",services,.002)
    a.box("shaft_base_manufacturer_plate",(.52,-.812,.35),(.30,.011,.085),
          "brushed_metal",front,.003)
