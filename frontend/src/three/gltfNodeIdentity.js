/** Restore authored identifiers before collecting paths or cloning cached scenes.
 * GLTFLoader replaces punctuation/space and suffixes duplicates for animation
 * tracks; Unity's importer uses original node names. The app drives PLC bindings
 * itself, and does not consume the GLTFLoader animation clips.
 */
export function restoreGltfNodeNames(gltf) {
    const associations = gltf?.parser?.associations
    const sourceNodes = gltf?.parser?.json?.nodes
    if (!associations || !Array.isArray(sourceNodes)) return gltf
    for (const scene of gltf.scenes || [gltf.scene]) {
        scene?.traverse(object => {
            const index = associations.get(object)?.nodes
            const name = sourceNodes[index]?.name
            if (Number.isInteger(index) && typeof name === 'string') object.name = name
        })
    }
    return gltf
}
