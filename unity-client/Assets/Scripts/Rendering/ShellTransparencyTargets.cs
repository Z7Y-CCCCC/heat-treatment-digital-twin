using System;
using System.Collections.Generic;

namespace HeatTreatment.DigitalTwin.Rendering
{
    // Exact cover assemblies from the packaged CAD manifests. Do not infer from
    // arbitrary substrings (a fan/chain/drive must remain solid and animated).
    // Custom models use their explicitly authored inspection.shell targets.
    public static class ShellTransparencyTargets
    {
        // CAD skins contain several nested sheets; a stronger tint stacks into
        // an opaque-looking wall. A faint skin plus explicit structural edges
        // keeps the furnace recognizable without hiding its internal mechanisms.
        public const float GhostOpacity = .045f;
        private static readonly HashSet<string> CoverNodes = new HashSet<string>(StringComparer.Ordinal)
        {
            "cad_tempering_furnace_v1_housing", "cad_tempering_furnace_v1_lining",
            "cad_tempering_furnace_v1_circulation_cover", "cad_tempering_furnace_v1_extraction",
            "cad_tempering_furnace_v1_rear_service_hatch",
            "cad_tempering_furnace_v1_door", "cad_tempering_furnace_v1_door_seals",
            "cad_tempering_furnace_v1_panel_fasteners",
            "cad_tempering_furnace_v1_lifting_eyes", "cad_tempering_furnace_v1_nameplates",
            "cad_air_cooling_table_v1_hood", "cad_air_cooling_table_v1_hood_latches", "cad_air_cooling_table_v1_door",
            "cad_washing_machine_v1_housing", "cad_washing_machine_v1_lining",
            "cad_washing_machine_v1_tanks", "cad_washing_machine_v1_rear_inspection",
            "cad_washing_machine_v1_lifting_eyes", "cad_washing_machine_v1_door", "cad_washing_machine_v1_door_seals",
            "cad_washing_machine_v1_central_lower_body", "cad_washing_machine_v1_lower_collection", "cad_washing_machine_v1_heater_flanges",
            "cad_water_cooling_tank_v1_upper_housing", "cad_water_cooling_tank_v1_lining",
            "cad_water_cooling_tank_v1_rear_tank_hatch", "cad_water_cooling_tank_v1_tank",
            "cad_water_cooling_tank_v1_lifting_eyes", "cad_water_cooling_tank_v1_door", "cad_water_cooling_tank_v1_door_seals",
            "cad_multipurpose_furnace_600_v1_cold_housing", "cad_multipurpose_furnace_600_v1_hot_housing",
            "cad_multipurpose_furnace_600_v1_cold_front_hatches", "cad_multipurpose_furnace_600_v1_cold_rear_hatches",
            "cad_multipurpose_furnace_600_v1_partition_shell", "cad_multipurpose_furnace_600_v1_partition_lining",
            "cad_multipurpose_furnace_600_v1_quench_tank",
            "cad_multipurpose_furnace_600_v1_lining", "cad_multipurpose_furnace_600_v1_tank_lids",
            "cad_multipurpose_furnace_600_v1_extraction", "cad_multipurpose_furnace_600_v1_hot_access_panels",
            "cad_multipurpose_furnace_600_v1_hot_roof_end_caps", "cad_multipurpose_furnace_600_v1_refractory", "cad_multipurpose_furnace_600_v1_vault_bricks",
            "cad_multipurpose_furnace_600_v1_door", "cad_multipurpose_furnace_600_v1_door_seals", "cad_multipurpose_furnace_600_v1_agitator_lids",
            "cad_multipurpose_furnace_600_v1_exhaust_duct", "cad_multipurpose_furnace_600_v1_hood_fittings",
            "cad_multipurpose_furnace_600_v1_hot_rear_hatch", "cad_multipurpose_furnace_600_v1_upper_service_panels"
        };
        private static readonly string[] EquipmentPrefixes = {
            "cad_tempering_furnace_v1_", "cad_multipurpose_furnace_600_v1_", "cad_washing_machine_v1_",
            "cad_water_cooling_tank_v1_", "cad_air_cooling_table_v1_"
        };
        private static readonly HashSet<string> InternalMechanisms = new HashSet<string>(StringComparer.Ordinal)
        {
            "internal_fan", "internal_rollers", "circulation_fan", "heating_elements", "door_drive", "door_chains",
            "intermediate_gate", "agitators", "agitator", "hoist", "hoist_frame", "basket", "rollers",
            "gate_lift_chain", "gate_hydraulics", "door_lift_chain.002", "fan_blades", "fan_drive"
        };
        private static readonly HashSet<string> StructuralReferences = new HashSet<string>(StringComparer.Ordinal)
        {
            "structure", "door_guides", "door_carriages", "door_safety", "canopy_frame", "gate_gantry",
            "pipes", "process_pipes", "coolant_pipes", "oil_pipes", "instrumentation", "process_instruments",
            "heater_terminals", "valves", "valve_detail", "electrics", "controls"
        };
        // Static references are deliberately solid too. This is NOT a mask of
        // 'everything that is not moving'. Nearest semantic child wins over
        // a housing ancestor, preserving mechanisms mounted inside a cover.
        public static bool IsOpaqueNode(string name)
        {
            if (name == null) return false;
            foreach (var prefix in EquipmentPrefixes)
            {
                if (!name.StartsWith(prefix, StringComparison.Ordinal)) continue;
                var role = name.Substring(prefix.Length);
                return InternalMechanisms.Contains(role) || StructuralReferences.Contains(role);
            }
            return false;
        }
        public static bool IsCoverNode(string name) => name != null && CoverNodes.Contains(name);
    }
}
