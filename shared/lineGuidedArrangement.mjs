import { planLinePlacementTemplate } from './linePlacementTemplate.mjs'

// Explicit recommendation only. Geometry is measured in line-local space;
// only lane-to-rail depth is recommended. Along-rail X positions and lengths
// belong to the user's manual layout, never to an automatic packing algorithm.
const clone = value => JSON.parse(JSON.stringify(value))
export function planGuidedLineArrangement(layout, kind, rows) {
  return { ...planLinePlacementTemplate(layout, kind, rows, undefined, { independentSides: true }), originalRows: clone(rows) }
}
