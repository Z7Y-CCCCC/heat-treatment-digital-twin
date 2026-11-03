const CATALOG = [
    { id: 'cad_transfer_cart_101300', name: '料车 · 10.13.00 CAD', source: '10.13.00_料车.glb', family: '料车' },
    { id: 'cad_lifting_load_table_111400', name: '升降备料台 · 11.14.00 CAD', source: '11.14.00_升降备料台.glb', family: '升降备料台' },
    { id: 'cad_fixed_load_table_112200', name: '固定备料台 · 11.22.00 CAD', source: '11.22.00_固定备料台.glb', family: '固定备料台' },
    { id: 'cad_air_cooling_table_115800ht', name: '风冷台 · 11.58.00HT CAD', source: '11.58.00HT_风冷台.glb', family: '风冷台' },
    { id: 'cad_cleaner_170700', name: '清洗机 · 17.07.00 CAD', source: '17.07.00_清洗机.glb', family: '清洗机' },
    { id: 'cad_water_cooling_tank_471000', name: '水冷槽 · 47.10.00 CAD', source: '47.10.00_水冷槽.glb', family: '水冷槽' },
    { id: 'cad_multipurpose_furnace_082000', name: '600普通多用炉 · 08.20.00 CAD', source: '08.20.00_600普通多用炉.glb', family: '多用炉' }
];

function getCadEquipmentModels() {
    return CATALOG.map(({ id, name, family }) => ({
        id, name, file_path: `/assets/models/${id}.glb`, asset_type: 'model', placement_level: 'device', factory_id: null,
        tags: JSON.stringify(['packaged', 'cad', family]), thumbnail: null, default_scale: 1,
        metadata: JSON.stringify(require(`../assets/models/${id}_metadata.json`)), is_builtin: true
    }));
}

module.exports = { CATALOG, getCadEquipmentModels };
