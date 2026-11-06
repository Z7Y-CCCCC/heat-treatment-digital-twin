const signature = value => JSON.stringify(value)
const clone = value => JSON.parse(JSON.stringify(value))
function channelValue(node, channel) {
 if (channel === 'p') return node.position.toArray()
 if (channel === 'q') return node.quaternion.toArray()
 if (channel === 's') return node.scale.toArray()
 if (channel === 'v') return [node.visible ? 1 : 0]
 const material = [].concat(node.material || [])[Number(channel.slice(1))]
 if (!material) return null
 if (channel[0] === 'c' && material.color) return [...material.color.toArray(), material.opacity]
 if (channel[0] === 'e' && material.emissive) return [...material.emissive.toArray(), material.emissiveIntensity]
 return null
}
function restoreChannel(node, channel, value) {
 if (channel === 'p') node.position.fromArray(value)
 else if (channel === 'q') node.quaternion.fromArray(value)
 else if (channel === 's') node.scale.fromArray(value)
 else if (channel === 'v') node.visible = value[0] > .5
 else {
  const material = [].concat(node.material || [])[Number(channel.slice(1))]
  if (!material) return
  if (channel[0] === 'c') { material.color?.fromArray(value); material.opacity = value[3] }
  else if (channel[0] === 'e') { material.emissive?.fromArray(value); material.emissiveIntensity = value[3] }
 }
}
const partChannel = definition => ({ translate: 'p', rotate_angle: 'q', rotate_speed: 'q', visibility: 'v', color: 'c0' })[definition.action]

// A new unrelated action must not send an unchanged, waiting endpoint animation back to its base pose.
// Records are tied to the current scene's nodes plus an identical binding AND action definition.
export function captureMotionEndpointDisplayStates(player, parts = []) {
 const records = new Map()
 for (const entry of player?.entries || []) {
  if (entry.binding.trigger?.mode !== 'endpoints' || !entry.signal.hasSample) continue
  const channels = entry.clip.tracks.map(track => ({ node: player.nodes.get(track.node), channel: track.channel })).filter(row => row.node).map(row => ({ ...row, value: channelValue(row.node, row.channel) })).filter(row => row.value)
  records.set(`clip:${entry.binding.actionId}`, { binding: signature(entry.binding), definition: signature(entry.clip), signal: clone(entry.signal), channels })
 }
 for (const entry of parts) {
  if (entry.binding.trigger?.mode !== 'endpoints' || !entry.signal.hasSample) continue
  const channel = partChannel(entry.definition), value = channel && channelValue(entry.node, channel)
  records.set(`part:${entry.binding.actionId}`, { binding: signature(entry.binding), definition: signature(entry.definition), signal: clone(entry.signal), channels: value ? [{ node: entry.node, channel, value }] : [] })
 }
 return records
}
export function restoreMotionEndpointDisplayStates(records, player, parts = []) {
 const restore = (key, entry, definition) => {
  const record = records.get(key)
  if (!record || record.binding !== signature(entry.binding) || record.definition !== signature(definition)) return
  entry.signal = clone(record.signal)
  for (const row of record.channels) restoreChannel(row.node, row.channel, row.value)
 }
 for (const entry of player?.entries || []) restore(`clip:${entry.binding.actionId}`, entry, entry.clip)
 for (const entry of parts) restore(`part:${entry.binding.actionId}`, entry, entry.definition)
}
