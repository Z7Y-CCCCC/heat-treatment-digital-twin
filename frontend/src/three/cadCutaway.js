// All covers that can occlude a process bath must respond to the same switch
// in standalone action previews and coordinated line previews.
export const CAD_CUTAWAY_SUFFIXES=Object.freeze([
    'housing','lining','hood','upper_housing','tank','tanks','central_lower_body','lower_collection','filter_tank',
    'fans_enamel','cold_housing','hot_housing','refractory','vault_bricks','partition_shell','partition_lining',
    'hot_access_panels','hot_rear_hatch','quench_tank','quench_liquid',
    'tank_lids','agitator_lids','cold_front_hatches','cold_rear_hatches','tank_baffles'
])
export function collectCutawayMaterials(root,names){
    const result=[],visited=new Set()
    for(const name of names)root.getObjectByName(name)?.traverse(node=>{
        if(!node.isMesh||visited.has(node))return;visited.add(node)
        const materials=[].concat(node.material).map(material=>{
            const clone=material.clone();clone.userData.previewOpacity=material.opacity;clone.userData.previewTransparent=material.transparent
            result.push(clone);return clone
        })
        node.material=Array.isArray(node.material)?materials:materials[0]
    })
    return result
}
