import { createVoiceAnnouncer } from './VoiceAnnouncer.js'

export function factoryVoiceEnabled(value) { return value !== false && value !== 'false' && value !== 0 && value !== '0' }
export function factoryVoiceDevices(config = {}) {
  if (Array.isArray(config.voiceDevices)) return config.voiceDevices
  const devices = new Map()
  for (const workshop of config.workshops || []) {
    for (const device of workshop.devices || []) devices.set(String(device.id), device)
    for (const line of workshop.lines || []) for (const device of line.devices || []) devices.set(String(device.id), device)
  }
  return [...devices.values()]
}

// Reuses the view's existing real-time store/socket. No polling or second
// connection, and never announces another factory's globally broadcast frames.
export function createFactoryVoiceController(options = {}) {
  let factoryId = '', deviceIds = new Set(), announcer = createVoiceAnnouncer({ ...options, muted: true }), disposed = false, override = null
  const available = () => options.available?.() !== false
  return {
    get announcer() { return announcer },
    configure(config = {}) {
      if (disposed) return
      const next = String(config.factoryId || '')
      if (factoryId !== next) { announcer.dispose(); announcer = createVoiceAnnouncer({ ...options, muted: true }); factoryId = next; override = null }
      const devices = factoryVoiceDevices(config)
      deviceIds = new Set(devices.map(device => String(device.id)))
      announcer.setFactoryDevices(devices)
      const configured = factoryVoiceEnabled(config.settings?.voice_enabled)
      if (configured === override) override = null
      announcer.setMuted(!next || !available() || !(override ?? configured))
    },
    handleDeviceData(data) { if (!disposed && available() && deviceIds.has(String(data?.furnace_id))) announcer.handleDeviceData(data) },
    handleMessage(message) {
      if (message?.type === 'realtime_resync_required') override = null
      const payload = message?.payload || {}
      const voiceOnly = message?.type === 'configuration_changed' && payload.settings && Object.keys(payload.settings).length === 1 && Object.hasOwn(payload.settings, 'voice_enabled')
      if (message?.type !== 'factory_voice_changed' && !voiceOnly) return false
      if (!disposed && factoryId && String(payload.factoryId) === factoryId) {
        override = factoryVoiceEnabled(voiceOnly ? payload.settings.voice_enabled : payload.enabled)
        announcer.setMuted(!available() || !override)
      }
      return true
    },
    unlock() { if (!disposed) announcer.unlock() },
    suspend() { announcer.setMuted(true) },
    dispose() { disposed = true; announcer.dispose(); deviceIds.clear() }
  }
}
