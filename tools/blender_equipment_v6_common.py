"""Shared, non-destructive photo-equipment study/export/re-import pipeline.

Uses the already-reviewed V6 geometric primitives, with asset-local materials,
separate editable/runtime scenes, and nested functional/animation groups.
Execute from Blender; only the primary coordinator uses the MCP connection.
"""

from __future__ import annotations

import importlib.util
import json
import math
import runpy
from collections import defaultdict
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector, Quaternion
from mathutils.bvhtree import BVHTree

WORKSPACE=Path(__file__).resolve().parents[1]
OUT=WORKSPACE/"backend"/"assets"/"models"
COMPLETE_BLEND=OUT/"photo_equipment_models_v6_complete.blend"
KEYS={"transfer_cart":"cart", "tempering_furnace":"temper", "washing_machine":"wash"}


def load_module(path, name):
    spec=importlib.util.spec_from_file_location(name,str(path))
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def bounds(objects):
    points=[obj.matrix_world@Vector(corner) for obj in objects if obj.type=="MESH" for corner in obj.bound_box]
    if not points:
        return [0.0]*6
    return [min(p[i] for p in points) for i in range(3)]+[max(p[i] for p in points) for i in range(3)]


def find(scene,name):
    matches=[obj for obj in scene.objects if obj.name==name or
             (obj.name.startswith(name+".") and obj.name[len(name)+1:].isdigit())]
    if len(matches)!=1:
        raise AssertionError(f"Expected one {name}: {[obj.name for obj in matches]}")
    return matches[0]


def clear_owned_scene(name,asset_id):
    scene=bpy.data.scenes.get(name)
    if scene is None:
        return
    if scene.get("asset_id")!=asset_id:
        raise RuntimeError(f"Refusing to replace unrelated scene {name}")
    if any(not obj.get("v6_generated") for obj in scene.objects):
        raise RuntimeError(f"Unmarked objects in {name}; preserve user additions before rebuilding")
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj,do_unlink=True)
    bpy.data.scenes.remove(scene)


def look_at(obj,target):
    obj.rotation_euler=(Vector(target)-obj.location).to_track_quat("-Z","Y").to_euler()


def triangle_tree(objects):
    vertices,faces,owners=[],[],[]
    for obj in objects:
        if obj.type!="MESH":
            continue
        offset=len(vertices)
        vertices.extend(obj.matrix_world@v.co for v in obj.data.vertices)
        obj.data.calc_loop_triangles()
        for face in obj.data.loop_triangles:
            faces.append(tuple(offset+i for i in face.vertices))
            owners.append(obj.name)
    return BVHTree.FromPolygons(vertices,faces,all_triangles=True),owners


class Equipment:
    def __init__(self,key,version="v6"):
        self.key=key
        self.version=version
        self.model_id=f"photo_{key}_{version}"
        self.prefix=KEYS[key]+f"_{version}_"
        self.edit_name=version.upper()+"_"+KEYS[key].upper()+"_EDIT"
        self.runtime_name=version.upper()+"_"+KEYS[key].upper()+"_RUNTIME"
        self.base=load_module(WORKSPACE/"tools"/"blender_build_multipurpose_furnace_v6.py","_geometry_"+key)
        self.base.PREFIX=self.prefix
        self.base.MATS={}
        raw_mesh=self.base.mesh
        def oriented_mesh(*args,**kwargs):
            obj=raw_mesh(*args,**kwargs)
            bm=bmesh.new()
            try:
                bm.from_mesh(obj.data)
                # Some legacy box/rounded-panel face orders were inward. Fix
                # closed islands locally before their bevel/normal modifiers;
                # leave open sheet/label normals as authored. Older assets and
                # the shared source primitive file are never modified.
                if bm.edges and all(edge.is_manifold for edge in bm.edges):
                    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
                    bm.to_mesh(obj.data)
                    obj.data.update()
            finally:
                bm.free()
            return obj
        self.base.mesh=oriented_mesh
        self.groups={}
        self.spec={}
        self.root=None

    def __getattr__(self,name):
        if name in {"box","cylinder","rod","tube","beam","pipe","mesh","motor","gauge","label","bolts","handwheel"}:
            return getattr(self.base,name)
        raise AttributeError(name)

    def empty(self,name,parent=None,loc=(0,0,0)):
        return self.base.empty(self.prefix+name,parent,loc)

    def group(self,name,loc=(0,0,0),dynamic=False,parent=None):
        if name in self.groups:
            raise ValueError(f"Duplicate functional group: {name}")
        obj=self.empty(name,self.root if parent is None else parent,loc)
        obj["functional_group"]=name
        obj["preserve_animation"]=dynamic
        self.groups[name]=obj
        return obj

    def material(self,key,color,metallic=0.0,roughness=.45,emission=0.0):
        name=self.prefix+"mat_"+key
        mat=bpy.data.materials.get(name) or bpy.data.materials.new(name)
        mat.use_nodes=True
        mat.diffuse_color=(*color[:3],1)
        bsdf=next(n for n in mat.node_tree.nodes if n.type=="BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value=(*color[:3],1)
        bsdf.inputs["Metallic"].default_value=metallic
        bsdf.inputs["Roughness"].default_value=roughness
        bsdf.inputs["Emission Color"].default_value=(*color[:3],1)
        bsdf.inputs["Emission Strength"].default_value=emission
        self.base.MATS[key]=mat
        return mat

    def materials(self):
        for key,color,metallic,roughness in [
            ("enamel",(.68,.70,.65),.06,.36),
            ("enamel_edge",(.49,.53,.49),.08,.42),
            ("stainless",(.54,.59,.59),.88,.32),
            ("brushed_metal",(.39,.43,.44),.83,.4),
            ("dark_structure",(.043,.055,.056),.25,.46),
            ("heat_black",(.013,.017,.019),.08,.69),
            ("gasket",(.019,.023,.022),0,.87),
            ("safety_yellow",(.9,.28,.002),.04,.42),
            ("gas_yellow",(.9,.28,.002),.10,.38),
            ("air_cyan",(.07,.58,.60),.1,.34),
            ("motor_teal",(.10,.22,.20),.28,.35),
            ("motor_blue",(.018,.105,.26),.25,.36),
            ("brass",(.48,.30,.065),.77,.32),
            ("red",(.72,.024,.014),.06,.32),
            ("dial",(.87,.88,.79),0,.43),
            ("screen",(.026,.23,.28),.1,.24),
            ("screen_light",(.18,.76,.73),0,.42),
            ("green",(.014,.65,.085),0,.25),
            ("refractory",(.20,.17,.13),0,.92),
            ("floor",(.115,.145,.16),0,.74),
        ]:
            self.material(key,color,metallic,roughness,.25 if key in {"screen","screen_light"} else 0)

    def start(self):
        OUT.mkdir(parents=True,exist_ok=True)
        clear_owned_scene(self.edit_name,self.model_id)
        self.scene=bpy.data.scenes.new(self.edit_name)
        self.scene["asset_id"]=self.model_id
        self.scene["v6_generated"]=True
        bpy.context.window.scene=self.scene
        self.materials()
        self.root=self.base.empty(self.model_id+"_editable_root")
        self.root["model_id"]=self.model_id
        self.root["dimensional_accuracy"]="photo-derived visual estimate, not measured CAD"
        self.base.ROOT=self.root
        return self

    def studio(self):
        scene=self.scene
        world=bpy.data.worlds.get("V6_EQUIPMENT_REVIEW_WORLD") or bpy.data.worlds.new("V6_EQUIPMENT_REVIEW_WORLD")
        world.use_nodes=True
        bg=next(n for n in world.node_tree.nodes if n.type=="BACKGROUND")
        bg.inputs["Color"].default_value=(.22,.27,.31,1)
        bg.inputs["Strength"].default_value=.28
        scene.world=world
        self.box("review_floor",(0,0,-.025),(200,200,.05),"floor",None,0)
        for name,loc,power,size,color in [
            ("key",(1,-5,8),1000,5,(1,.94,.85)),
            ("fill",(-5,-1,5),650,4,(.8,.9,1)),
            ("rim",(3,5,7),1400,4.5,(.9,.95,1)),
        ]:
            data=bpy.data.lights.new(self.prefix+name,"AREA")
            data.energy=power
            data.shape="DISK"
            data.size=size
            data.color=color
            obj=self.base.link(bpy.data.objects.new(data.name,data))
            obj.location=loc
            look_at(obj,(0,0,1.8))
        data=bpy.data.cameras.new(self.prefix+"camera")
        data.type="ORTHO"
        camera=self.base.link(bpy.data.objects.new(data.name,data))
        scene.camera=camera
        self.configure_render(scene)
        scene.unit_settings.system="METRIC"
        scene.unit_settings.scale_length=1
        self.set_view(self.spec["views"][0])

    @staticmethod
    def configure_render(scene,width=1600,height=1400):
        scene.render.engine="BLENDER_EEVEE"
        scene.render.resolution_x=width
        scene.render.resolution_y=height
        scene.render.resolution_percentage=100
        scene.render.image_settings.file_format="PNG"
        scene.render.film_transparent=False
        scene.view_settings.view_transform="AgX"
        scene.view_settings.look="AgX - Medium High Contrast"

    def set_view(self,view):
        camera=self.scene.camera
        camera.location=view["camera"]
        camera.data.ortho_scale=view["scale"]
        look_at(camera,view["target"])

    def build(self):
        self.start()
        module=load_module(WORKSPACE/"tools"/f"blender_build_{self.key}_{self.version}.py","_asset_"+self.key)
        self.spec=module.build(self)
        assert self.spec["model_id"]==self.model_id
        self.root["reference_photos"]=json.dumps(self.spec.get("reference_photos",[]),ensure_ascii=False)
        self.root["delivery_status"]="review"
        for binding in self.spec.get("bindings",[]):
            if binding["node_name"] not in self.groups:
                raise ValueError(f"Binding is not an explicit functional group: {binding}")
            self.groups[binding["node_name"]]["preserve_animation"]=True
        self.scene["build_spec"]=json.dumps(self.spec,ensure_ascii=False)
        bpy.context.view_layer.update()
        self.studio()
        self.scene["rest_poses"]=json.dumps({key:{"location":list(obj.location),"rotation":list(obj.rotation_euler)} for key,obj in self.groups.items()})
        bpy.context.view_layer.update()
        print(json.dumps({"stage":"built","model_id":self.model_id,"editable_objects":len(self.root.children_recursive)},ensure_ascii=False))
        return self

    def restore(self):
        self.scene=bpy.data.scenes[self.edit_name]
        self.spec=json.loads(self.scene["build_spec"])
        self.root=bpy.data.objects[self.model_id+"_editable_root"]
        self.groups={obj["functional_group"]:obj for obj in self.root.children_recursive if "functional_group" in obj}
        bpy.context.window.scene=self.scene
        return self

    def rest_pose(self):
        poses=json.loads(self.scene["rest_poses"])
        for key,pose in poses.items():
            obj=self.groups[key]
            obj.location=pose["location"]
            obj.rotation_euler=pose["rotation"]
        bpy.context.view_layer.update()

    def metadata(self):
        release_version=self.version.removeprefix("v")+".0.0"
        bindings=[]
        for entry in self.spec.get("bindings",[]):
            binding={"node_path":"","input_min":0,"input_max":1,"output_min":0,"invert":False,**entry}
            binding["node_name"]=self.prefix+"node_"+entry["node_name"]
            binding["source_mapping_status"]="review_required"
            bindings.append(binding)
        return {
            "schema_version":1,"model_id":self.model_id,"version":self.version,"source":"photo_reference_geometry_study",
            "batchable":True,
            "optimization":{"mode":"auto","mergeStatic":False,"preserveAnimated":True,"instanceRepeated":True,
                            "materialEnhancement":"original","contactShadow":True},
            "runtime":{"enableGenericBindings":False,"showStatusLight":True},
            "assetSpec":{"version":release_version,"device_family":self.spec["family"],"unit":"m",
                         "axis_rule":"Y-up export; orientation follows reference metadata",
                         "max_triangles":200000,"max_nodes":800,"max_texture_size":2048,
                         "delivery_status":"review","notes":"照片估算外观，非实测CAD；绑定为待确认映射，不接入生产点位。"},
            "partBindings":bindings,
            "inspection":{"enabled":True,"shell":{"node_names":[self.prefix+"node_"+name for name in self.spec.get("shell_groups",[])],
                          "node_paths":[],"opacity":.16,"wireframe":False}},
            "reference":{"photos":self.spec.get("reference_photos",[]),"dimensional_accuracy":"visual_estimate_not_measured",
                         "notes":self.spec.get("notes",[])},
            "release":{"version":release_version,"status":"draft","published_at":"","history":[]},
        }

    def export(self):
        bpy.context.window.scene=self.scene
        self.rest_pose()
        depsgraph=bpy.context.evaluated_depsgraph_get()
        sources=set(self.groups.values())
        def functional_parent(obj):
            parent=obj.parent
            while parent is not None and parent not in sources:
                parent=parent.parent
            return parent
        records={key:[] for key in self.groups}
        for obj in self.root.children_recursive:
            if obj.type not in {"MESH","FONT","CURVE"}:
                continue
            part=functional_parent(obj)
            if part is None:
                raise ValueError(f"Geometry outside a semantic group: {obj.name}")
            data=bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph),depsgraph=depsgraph)
            transform=part.matrix_world.inverted()@obj.matrix_world
            data.transform(transform)
            if transform.to_3x3().determinant()<0:
                data.flip_normals()
            data.update()
            records[part["functional_group"]].append(data)
        source_transforms={key:obj.matrix_world.copy() for key,obj in self.groups.items()}
        source_parents={key:functional_parent(obj) for key,obj in self.groups.items()}
        clear_owned_scene(self.runtime_name,self.model_id)
        runtime=bpy.data.scenes.new(self.runtime_name)
        runtime["asset_id"]=self.model_id
        runtime["v6_generated"]=True
        bpy.context.window.scene=runtime
        root=self.base.empty(self.model_id+"_root")
        root["model_id"]=self.model_id
        root["dimensional_accuracy"]="visual estimate, not measured"
        groups={key:self.base.empty(self.prefix+"node_"+key) for key in self.groups}
        for key,assembly in groups.items():
            parent=source_parents[key]
            assembly.parent=groups[parent["functional_group"]] if parent else root
            parent_matrix=source_transforms[parent["functional_group"]] if parent else self.root.matrix_world
            assembly.matrix_local=parent_matrix.inverted()@source_transforms[key]
            assembly["functional_group"]=key
            assembly["preserve_animation"]=self.groups[key].get("preserve_animation",False)
            buckets=defaultdict(list)
            for data in records[key]:
                mat=data.materials[0] if data.materials else None
                obj=self.base.link(bpy.data.objects.new(self.prefix+"baked_fragment",data),assembly)
                buckets[mat].append(obj)
            for mat,objects in buckets.items():
                bpy.ops.object.select_all(action="DESELECT")
                for obj in objects: obj.select_set(True)
                active=objects[0]
                bpy.context.view_layer.objects.active=active
                if len(objects)>1: bpy.ops.object.join()
                mat_key=mat.name.removeprefix(self.prefix+"mat_") if mat else "unassigned"
                active.name=self.prefix+key+"_"+mat_key
                active.data.name=active.name+"_mesh"
        bpy.context.view_layer.update()
        bpy.ops.object.select_all(action="DESELECT")
        for obj in [root,*root.children_recursive]: obj.select_set(True)
        bpy.context.view_layer.objects.active=root
        glb=OUT/(self.model_id+".glb")
        bpy.ops.export_scene.gltf(filepath=str(glb),export_format="GLB",use_selection=True,use_active_scene=True,
            export_yup=True,export_apply=True,export_animations=False,export_extras=True,
            export_lights=False,export_cameras=False,export_materials="EXPORT")
        metadata=self.metadata()
        validator=runpy.run_path(str(WORKSPACE/"tools"/"validate_equipment_glb.py"))
        document,size=validator["read_glb"](glb)
        report=validator["validate"](document,size,self.model_id+"_root",metadata)
        report.update({"model_id":self.model_id,"family":self.spec["family"],"editable_objects":len(self.root.children_recursive),
                       "production_runtime_tested":False,"original_assets_modified":False,
                       "functional_groups":list(self.groups),"dimensional_accuracy":"visual_estimate_not_measured"})
        report["binding_axes"]=[{"node":b["node_name"],"axis":b["axis"],"action":b["action"]} for b in metadata["partBindings"]]
        metadata["acceptance"]={"status":"review" if report["valid"] else "failed","stats":report["stats"],
                                "production_runtime_tested":False,"roundtrip_verified":False}
        (OUT/(self.model_id+"_metadata.json")).write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding="utf-8")
        (OUT/(self.model_id+"_report.json")).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
        bpy.context.window.scene=self.scene
        print(json.dumps({"stage":"exported","model_id":self.model_id,"valid":report["valid"],"stats":report["stats"],"errors":report["errors"]},ensure_ascii=False))
        if not report["valid"]:
            raise AssertionError("Asset export failed structural validation")
        return report

    def render(self):
        bpy.context.window.scene=self.scene
        self.rest_pose()
        for view in self.spec["views"]:
            self.set_view(view)
            self.scene.render.filepath=str(OUT/(self.model_id+"_"+view["suffix"]+".png"))
            bpy.ops.render.render(write_still=True)
        self.set_view(self.spec["views"][0])
        print(json.dumps({"stage":"rendered","model_id":self.model_id,"views":[v["suffix"] for v in self.spec["views"]]}))

    def verify(self):
        """GLB re-import, all binding transforms, door rays, and opened-pose render."""
        report_path=OUT/(self.model_id+"_report.json")
        metadata_path=OUT/(self.model_id+"_metadata.json")
        report=json.loads(report_path.read_text(encoding="utf-8"))
        metadata=json.loads(metadata_path.read_text(encoding="utf-8"))
        previous=bpy.context.window.scene
        bpy.context.window.scene=bpy.data.scenes[self.runtime_name]
        bpy.context.view_layer.update()
        source_root=bpy.data.objects[self.model_id+"_root"]
        expected=bounds(source_root.children_recursive)
        name=self.edit_name+"_ROUNDTRIP"
        if bpy.data.scenes.get(name): raise RuntimeError("Existing isolated check requires inspection")
        scene=bpy.data.scenes.new(name)
        bpy.context.window.scene=scene
        result={"status":"running"}
        try:
            bpy.ops.import_scene.gltf(filepath=str(OUT/(self.model_id+".glb")))
            bpy.context.view_layer.update()
            root=find(scene,self.model_id+"_root")
            all_meshes=[o for o in root.children_recursive if o.type=="MESH"]
            actual=bounds(all_meshes)
            error=max(abs(a-b) for a,b in zip(expected,actual))
            assert error<1e-4, f"Round-trip bounds error {error}"
            triangles=0
            for obj in all_meshes:
                obj.data.calc_loop_triangles()
                triangles+=len(obj.data.loop_triangles)
            assert triangles==report["stats"]["triangles"], f"Triangle mismatch: {triangles} != {report['stats']['triangles']}"
            motions=[]
            for binding in metadata["partBindings"]:
                obj=find(scene,binding["node_name"])
                assert obj.type=="EMPTY" and len(obj.children)>0, f"Non-independent binding node: {obj.name}"
                moving=set(obj.children_recursive)
                unaffected={o:o.matrix_world.copy() for o in all_meshes if o not in moving}
                initial_location=obj.location.copy()
                initial_rotation=obj.rotation_euler.copy()
                axis,sign={"x":(0,1),"y":(2,1),"z":(1,-1)}[binding["axis"]]
                if binding["action"]=="translate":
                    obj.location[axis]+=sign*binding.get("output_max",.3)
                elif binding["action"] in {"rotate_speed","rotate_angle"}:
                    obj.rotation_euler[axis]+=sign*math.pi/2
                bpy.context.view_layer.update()
                assert all(max(abs(o.matrix_world[r][c]-matrix[r][c]) for r in range(4) for c in range(4))<1e-6 for o,matrix in unaffected.items()), f"Motion moved unrelated geometry: {obj.name}"
                motions.append({"node":binding["node_name"],"action":binding["action"],
                                "axis_gltf":binding["axis"],"axis_blender":"xyz"[axis],"unrelated_meshes_fixed":True})
                obj.location=initial_location
                obj.rotation_euler=initial_rotation
                bpy.context.view_layer.update()
            bpy.context.view_layer.update()
            depsgraph=bpy.context.evaluated_depsgraph_get()
            door_results=[]
            for check in self.spec.get("checks",[]):
                if check["kind"]!="door_ray": continue
                obj=find(scene,self.prefix+"node_"+check["node_name"])
                moving=set(obj.children_recursive)
                closed=scene.ray_cast(depsgraph,Vector(check["origin"]),Vector(check["direction"]).normalized())
                assert closed[0] and closed[4] in moving, f"Closed door ray misses {obj.name}: {closed[4].name if closed[0] else None}"
                axis="xyz".index(check.get("axis","z").lower())
                rest=obj.location.copy()
                static_tree,static_owners=triangle_tree(o for o in all_meshes if o not in moving)
                sweep=[]
                for step in range(11):
                    obj.location[axis]=rest[axis]+check["travel"]*step/10
                    bpy.context.view_layer.update()
                    moving_tree,_=triangle_tree(moving)
                    overlaps=static_tree.overlap(moving_tree)
                    collision_objects=sorted({static_owners[a] for a,b in overlaps})
                    assert not overlaps, f"Door sweep collision at {step}/10 for {obj.name}: {collision_objects}"
                    sweep.append({"fraction":step/10,"surface_intersections":0})
                obj.location[axis]=rest[axis]+check["travel"]
                bpy.context.view_layer.update()
                opened=scene.ray_cast(depsgraph,Vector(check["origin"]),Vector(check["direction"]).normalized())
                assert not opened[0] or opened[4] not in moving, f"Door fails to clear ray: {obj.name}"
                door_results.append({"node":obj.name,"closed_hit":closed[4].name,
                                     "opened_hit":opened[4].name if opened[0] else None,"ray_clear":True,
                                     "travel":check["travel"],"sweep_samples":sweep})
                # Leave doors open for exported-model visual QA; source is untouched.
            result={"status":"passed","nodes":len(root.children_recursive)+1,"triangles":triangles,
                    "bounds_max_error_m":error,"bounds_blender_xyz":actual,"binding_checks":motions,
                    "door_ray_checks":door_results,"production_runtime_tested":False}
            for source in self.scene.objects:
                if source.type in {"CAMERA","LIGHT"} or source.name==self.prefix+"review_floor":
                    obj=source.copy()
                    if source.data: obj.data=source.data.copy()
                    scene.collection.objects.link(obj)
                    if source==self.scene.camera: scene.camera=obj
            scene.world=self.scene.world
            self.configure_render(scene,1440,1260)
            scene.render.filepath=str(OUT/(self.model_id+"_runtime_check.png"))
            bpy.ops.render.render(write_still=True)
            result["render"]=str(Path(scene.render.filepath).relative_to(WORKSPACE))
        except Exception as exc:
            result={"status":"failed","error":str(exc)}
            raise
        finally:
            report["roundtrip"]=result
            report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
            metadata["acceptance"]["roundtrip_verified"]=result["status"]=="passed"
            metadata_path.write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding="utf-8")
            bpy.context.window.scene=previous
            for obj in list(scene.objects): bpy.data.objects.remove(obj,do_unlink=True)
            bpy.data.scenes.remove(scene)
        print(json.dumps({"stage":"verified","model_id":self.model_id,"result":result},ensure_ascii=False))
        return result


def save_complete(filepath=None):
    output_path=COMPLETE_BLEND if filepath is None else Path(filepath)
    if bpy.context.window.scene.get("asset_id"):
        for area in bpy.context.screen.areas:
            if area.type=="VIEW_3D":
                area.spaces.active.region_3d.view_perspective="CAMERA"
                area.spaces.active.overlay.show_overlays=False
                area.spaces.active.shading.type="MATERIAL"
    bpy.ops.wm.save_as_mainfile(filepath=str(output_path))
    print(("V6 complete workspace saved: " if filepath is None else "Complete workspace saved: ")+str(output_path))


def run_asset(key,stage="all",version="v6",blend_path=None):
    h=Equipment(key,version=version)
    if stage in {"all","build"}:
        h.build()
    else:
        h.restore()
    if stage in {"all","export"}:
        h.export()
        attach_geometry_audit(key,version=version)
    if stage in {"all","render"}:
        h.render()
    if stage in {"all","verify"}:
        h.verify()
    save_complete(blend_path)
    return h


def attach_geometry_audit(key,version="v6"):
    model_id=f"photo_{key}_{version}"
    auditor=load_module(WORKSPACE/"tools"/"audit_equipment_glb_geometry.py","_geometry_audit")
    document,binary,size=auditor.read_glb(OUT/(model_id+".glb"))
    audit=auditor.audit(document,binary,size)
    path=OUT/(model_id+"_report.json")
    report=json.loads(path.read_text(encoding="utf-8"))
    assert size==report["stats"]["file_bytes"], "Report and audited GLB are different versions"
    assert audit["stats"]["triangles"]==report["stats"]["unique_mesh_triangles"]
    report["geometry_audit"]=audit
    path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    path=OUT/(model_id+"_metadata.json")
    metadata=json.loads(path.read_text(encoding="utf-8"))
    metadata["acceptance"]["geometry_verified"]=audit["valid"]
    if not audit["valid"]:
        metadata["acceptance"]["status"]="failed"
    path.write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"stage":"geometry_audit","model_id":model_id,"valid":audit["valid"],"stats":audit["stats"]}))
    if not audit["valid"]:
        raise AssertionError(f"Geometry audit failed for {model_id}: {audit['reversed_triangles_by_mesh']}")
    return audit


def render_overview():
    """Three native 3D assets together, without compositing the preview images."""
    name="V6_THREE_EQUIPMENT_OVERVIEW"
    clear_owned_scene(name,"three_equipment_overview")
    scene=bpy.data.scenes.new(name)
    scene["asset_id"]="three_equipment_overview"
    scene["v6_generated"]=True
    bpy.context.window.scene=scene
    layout=[("transfer_cart",(-5.1,0,0),0,"TRANSFER CART"),
            ("tempering_furnace",(0,0,0),0,"TEMPERING FURNACE"),
            ("washing_machine",(5.0,.15,0),math.pi/2,"WASHING MACHINE")]
    for key,position,angle,title in layout:
        root=bpy.data.objects[f"photo_{key}_v6_root"]
        originals=[root,*root.children_recursive]
        mapping={}
        for source in originals:
            obj=source.copy()
            obj.name="overview_"+source.name
            obj["v6_generated"]=True
            scene.collection.objects.link(obj)
            mapping[source]=obj
        for source,obj in mapping.items():
            obj.parent=mapping.get(source.parent)
            # On a cold .blend load an inactive source scene may not yet have
            # evaluated world/matrix_local caches. Copy stored local channels,
            # not that cache, or doors/rollers lose their pivot translations.
            obj.matrix_parent_inverse=source.matrix_parent_inverse.copy()
            obj.matrix_basis=source.matrix_basis.copy()
            if source is not root:
                assert (obj.location-source.location).length<1e-6, f"Overview lost local pivot: {source.name}"
        mapping[root].location=position
        mapping[root].rotation_euler.z=angle
    h=Equipment("transfer_cart")
    h.prefix="v6_overview_"
    h.base.PREFIX=h.prefix
    h.scene=scene
    h.materials()
    h.spec={"views":[{"camera":(8,-24,12),"target":(-.2,0,2.25),"scale":16.9}]}
    h.studio()
    h.configure_render(scene,2400,1350)
    # Broader soft sources cover the whole lineup; lighting changes no asset material.
    for obj in scene.objects:
        if obj.type=="LIGHT":
            obj.data.size=9
            obj.data.energy*=2.3
    for key,position,angle,title in layout:
        h.label(key+"_caption",title+"  /  V6",(position[0],-2.65,.20),.24,"dark_structure",None)
    scene.render.filepath=str(OUT/"photo_equipment_models_v6_three_overview.png")
    bpy.ops.render.render(write_still=True)
    save_complete()
    print("V6 three-equipment overview complete")


if __name__=="__main__":
    for asset_key in KEYS:
        run_asset(asset_key)
    render_overview()
