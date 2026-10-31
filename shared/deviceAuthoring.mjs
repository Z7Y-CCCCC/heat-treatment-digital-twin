export const TRANSFORM_FIELDS = ['pos_x', 'pos_y', 'pos_z', 'rotation_y', 'scale', 'sort_order', 'line_id', 'coordinate_space']
export const LAYOUT_CONFIG_FIELDS = ['railId', 'railName', 'railLineId', 'laneId', 'laneName', 'laneLineId', 'workshop_id', 'workshopId', 'stationNumber', 'station_number', 'layoutPlaced', 'placementPending', 'mirrorX']
export function deviceTransformPayload(device) {
  let config = device.instance_config || {}
  if (typeof config === 'string') { try { config = JSON.parse(config) } catch { config = {} } }
  return { ...Object.fromEntries(TRANSFORM_FIELDS.filter(key => device[key] !== undefined).map(key => [key, device[key]])),
    ...(Object.prototype.hasOwnProperty.call(config, 'ground') ? { ground: config.ground } : {}),
    layoutConfig: Object.fromEntries(LAYOUT_CONFIG_FIELDS.map(key => [key, config[key] ?? null])) }
}
