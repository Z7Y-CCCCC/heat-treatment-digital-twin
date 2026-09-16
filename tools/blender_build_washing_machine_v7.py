"""Washer V7: restore the photo-visible low rear equipment section.

Preserves the V6 front assembly as its own reference rather than modifying the
V6 file. Rear envelope is visible in mmexport1783325197891.jpg, but its exact
dimensions and internal function remain unmeasured/partly obscured.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path


def load_front_builder():
    path=Path(__file__).with_name("blender_build_washing_machine_v6.py")
    spec=importlib.util.spec_from_file_location("_washer_v6_front_reference",str(path))
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rear_section(h):
    h.material("rear_cover_red_orange",(.84,.105,.027),.06,.40)

    # Distinct low rear module: top close to the existing tank deck. This is
    # NOT a second high furnace chamber or the background IBC / yellow platform.
    start,end=1.635,3.605
    center=(start+end)/2
    frame=h.group("rear_auxiliary_support")
    for x in (-.75,.75):
        h.box("rear_skid_longitudinal",(x,2.54,.13),(.18,2.20,.19),"dark_structure",frame)
        for y in (1.82,3.39):
            h.cylinder("rear_levelling_foot",(x,y,.043),.083,.072,"brushed_metal",frame,sides=20)
            h.cylinder("rear_levelling_stud",(x,y,.112),.021,.13,"stainless",frame,sides=12)
    for y in (1.81,2.60,3.43):
        h.box("rear_skid_crossmember",(0,y,.175),(1.80,.10,.15),"dark_structure",frame)
    for x in (-.76,.76):
        h.box("front_rear_structural_splice",(x,1.53,.21),(.22,.46,.095),"brushed_metal",frame)
        h.bolts("splice_bolt",[(x,y,.266) for y in (1.39,1.68)],frame,"Z",.014)

    joint=h.group("front_rear_connector")
    h.box("recessed_connection_neck",(0,1.542,.895),(1.69,.19,1.29),"enamel_edge",joint,.008)
    for y in (1.490,1.614):
        for x in (-.901,.901):
            h.box("section_joint_vertical_flange",(x,y,.91),(.040,.034,1.38),"enamel",joint,.003)
        for z in (.226,1.599):
            h.box("section_joint_horizontal_flange",(0,y,z),(1.838,.034,.036),"enamel",joint,.003)
    # A visible short bridge and two seams establish a real second volume.
    h.box("section_joint_top_bridge",(0,1.548,1.632),(1.75,.172,.037),"stainless",joint,.003)
    for x in (-.919,.919):
        for z in (.35,.83,1.37):
            h.cylinder("joint_side_fastener",(x,1.55,z),.012,.014,"stainless",joint,"X",6)

    shell=h.group("rear_auxiliary_shell")
    shell["reference_status"]="visible rear low outline; dimensions/function require site confirmation"
    # Actual sheet enclosure. Do not add an arbitrary solid cube inside it.
    h.box("rear_bottom_pan",(0,center,.235),(1.81,end-start,.047),"enamel_edge",shell)
    for side in (-1,1):
        for i,(cy,length) in enumerate(((1.994,.69),(2.657,.623),(3.293,.624))):
            h.box(f"rear_side_panel_{side}_{i}",(side*.915,cy,.917),(.036,length,1.362),"enamel",shell,.004)
        for y in (start+.012,end-.006):
            h.box("rear_corner_fold",(side*.926,y,.917),(.052,.069,1.377),"enamel_edge",shell,.004)
        h.box("rear_top_perimeter",(side*.906,center,1.626),(.079,end-start+.055,.066),"stainless",shell)
    h.box("rear_end_skin",(0,end+.011,.917),(1.824,.036,1.365),"enamel",shell,.005)
    h.box("rear_forward_skin",(0,start+.015,.917),(1.801,.03,1.33),"enamel_edge",shell,.004)
    for x in (-.78,.78):
        h.box("rear_end_fold",(x,end+.036,.917),(.034,.027,1.33),"enamel_edge",shell,.003)
    # Low removable rear maintenance panel, understated because its exact
    # hardware is hidden by the foreground tote in the photographs.
    h.box("rear_access_panel_gasket",(0,end+.034,.92),(1.31,.018,1.04),"gasket",shell,.003)
    h.box("rear_access_panel",(0,end+.048,.92),(1.285,.020,1.016),"enamel",shell,.004)
    for x in (-.565,.565):
        for z in (.485,1.355):
            h.cylinder("rear_access_panel_fastener",(x,end+.064,z),.012,.012,"stainless",shell,"Y",6)

    covers=h.group("rear_low_top_covers")
    for i,(cy,length) in enumerate(((2.114,.853),(3.079,.866))):
        h.box(f"rear_lid_gasket_{i}",(0,cy,1.650),(1.69,length+.013,.020),"gasket",covers,.004)
        h.box(f"rear_removable_cover_{i}",(0,cy,1.671),(1.731,length,.026),"enamel",covers,.007)
        for x in (-.30,.30):
            h.pipe("rear_lid_lifting_handle",[(x-.070,cy,1.692),(x-.070,cy,1.778),
                       (x+.070,cy,1.778),(x+.070,cy,1.692)],.012,"stainless",covers,.035)
    # Red/orange top component visible on the low continuation in 7891.jpg.
    h.box("rear_red_cover_mount",(.43,2.65,1.700),(.655,.485,.028),"brushed_metal",covers,.004)
    h.box("rear_red_orange_service_cover",(.43,2.65,1.796),(.617,.44,.166),"rear_cover_red_orange",covers,.011)
    for y in (2.485,2.815):
        for x in (.19,.67):
            h.cylinder("rear_red_cover_fastener",(x,y,1.883),.010,.010,"stainless",covers,sides=6)

    services=h.group("rear_external_services")
    # An outside continuation of the existing cyan utility run. Connectivity
    # is illustrative; no claim about the real rear unit's internal purpose.
    h.pipe("rear_cyan_utility_continuation",[(-1.10,1.40,1.18),(-1.10,3.16,1.18),
               (-.815,3.16,1.18)],.018,"air_cyan",services,.070)
    for y in (1.85,2.69):
        h.cylinder("rear_utility_union",(-1.10,y,1.18),.030,.075,"brass",services,"Y",12)
        h.box("rear_utility_standoff",(-1.015,y,1.18),(.16,.036,.06),"stainless",services,.003)
    # Cable trunk bridges both assemblies along the far side, ending in a box.
    h.pipe("rear_control_conduit",[(.943,1.29,1.38),(1.015,1.29,1.38),
               (1.015,2.86,1.38),(.929,2.86,1.38)],.010,"gasket",services,.035)
    h.box("rear_small_junction_box",(.952,2.86,1.34),(.089,.22,.20),"enamel_edge",services,.006)
    h.box("rear_junction_lid",(1.003,2.86,1.34),(.018,.205,.182),"enamel",services,.003)
    h.pipe("rear_low_drain_stub",[(.60,end+.03,.35),(.60,end+.173,.35)],.019,"brass",services)
    h.cylinder("rear_drain_valve",(.60,end+.128,.35),.029,.075,"brass",services,"Y",12)
    h.box("rear_drain_short_handle",(.60,end+.125,.40),(.12,.024,.014),"gasket",services,.003)


def build(h):
    spec=load_front_builder().build(h)
    rear_section(h)
    spec["model_id"]="photo_washing_machine_v7"
    spec["family"]="清洗机 / 补齐后部箱体 V7"
    spec["views"]=[
        {"suffix":"preview","camera":(-9.3,-6.2,6.1),"target":(-.22,.95,2.23),"scale":7.50},
        {"suffix":"rear","camera":(-8.4,8.1,5.3),"target":(-.15,.97,2.10),"scale":7.40},
        {"suffix":"side","camera":(-11,.95,3.40),"target":(-.12,.95,2.32),"scale":7.15},
    ]
    spec["shell_groups"].append("rear_auxiliary_shell")
    spec["notes"]=[
        "V7按用户纠正补齐后半部；V6将高腔和低水箱在同一后平面结束，外轮廓不完整。",
        "mmexport1783325197891.jpg可见继续向后的白色低位续接体、顶盖及红橙色部件；不将背景黑罩、黄平台或IBC方桶并入本机。",
        "新增近等宽的低后箱、分段连接、独立支座、检修盖与外部线管；后箱顶部接近现有水箱顶，不推测为第二个等高炉腔。",
        "后箱示意包络Y=1.635..3.605m、宽约1.85m、高约1.68m；长度、内部用途和完整后端面因遮挡仍待现场确认，不是测量结果。",
        "保留原四泵、侧柜、前升降门；不增加未经照片证实的第五台泵。外部管线跨接仅为可视化连接示意。",
        *spec["notes"],
    ]
    spec["rear_outline_check"]={"front_end_y":-1.8445,"old_rear_y":1.545,
                                "new_rear_y_min":3.70,"rear_body_top_z":1.684}
    return spec
