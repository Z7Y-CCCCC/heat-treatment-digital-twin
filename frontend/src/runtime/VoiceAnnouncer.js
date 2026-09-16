import { getBackendOrigin } from './backendEndpoint.js'

const ALLOWED_TRIGGERS = new Set(['change', 'rising', 'falling', 'equals', 'above', 'below'])
const ALLOWED_MODES = new Set(['tts', 'file', 'auto'])

function clamp(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

export function parseVoiceConfig(raw) {
  if (raw === undefined || raw === null || raw === '') return { enabled: false, rules: [] }
  let source = raw
  if (typeof raw === 'string') {
    try { source = JSON.parse(raw) } catch (error) { return { enabled: false, rules: [] } }
  }
  const sourceRules = Array.isArray(source)
    ? source
    : (Array.isArray(source?.rules) ? source.rules : [])
  const rules = sourceRules.slice(0, 12).map((rule, index) => normalizeVoiceRule(rule, index))
  return {
    enabled: source?.enabled !== false && rules.some(rule => rule.enabled),
    rules
  }
}

export function normalizeVoiceRule(rule = {}, index = 0) {
  const trigger = ALLOWED_TRIGGERS.has(String(rule.trigger || 'change'))
    ? String(rule.trigger || 'change')
    : 'change'
  const mode = ALLOWED_MODES.has(String(rule.mode || 'auto'))
    ? String(rule.mode || 'auto')
    : 'auto'
  const threshold = rule.threshold === '' || rule.threshold === undefined || rule.threshold === null
    ? null
    : Number(rule.threshold)
  return {
    id: String(rule.id || `voice_${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '_') || `voice_${index + 1}`,
    enabled: rule.enabled !== false,
    trigger,
    threshold: Number.isFinite(threshold) ? threshold : null,
    mode,
    text: String(rule.text || '').trim().slice(0, 500),
    audio_url: String(rule.audio_url || '').trim(),
    cooldown_ms: Math.round(clamp(rule.cooldown_ms, 0, 3600000, 10000)),
    volume: clamp(rule.volume, 0, 1, 1),
    rate: clamp(rule.rate, 0.5, 2, 1),
    voice_name: String(rule.voice_name || '').trim(),
    announce_on_start: rule.announce_on_start === true
  }
}

function comparable(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value
  const text = String(value).trim()
  if (!text) return ''
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true'
  const number = Number(text)
  return Number.isFinite(number) ? number : text
}

function truthy(value) {
  const normalized = comparable(value)
  if (normalized === null || normalized === '' || normalized === 0 || normalized === false) return false
  return true
}

function numeric(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function equalValue(left, right) {
  const a = comparable(left)
  const b = comparable(right)
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return a === b || String(a ?? '') === String(b ?? '')
}

export function voiceRuleConditionMatches(rule, value) {
  switch (rule.trigger) {
    case 'rising': return truthy(value)
    case 'falling': return !truthy(value)
    case 'equals': return equalValue(value, rule.threshold)
    case 'above': {
      const number = numeric(value)
      return number !== null && rule.threshold !== null && number >= Number(rule.threshold)
    }
    case 'below': {
      const number = numeric(value)
      return number !== null && rule.threshold !== null && number <= Number(rule.threshold)
    }
    case 'change':
    default:
      return value !== null && value !== undefined
  }
}

export function shouldTriggerVoiceRule(rule, previous, current, hasPrevious) {
  if (!rule?.enabled || current === null || current === undefined) return false
  if (!hasPrevious) return rule.announce_on_start && voiceRuleConditionMatches(rule, current)

  switch (rule.trigger) {
    case 'rising': return !truthy(previous) && truthy(current)
    case 'falling': return truthy(previous) && !truthy(current)
    case 'equals': return !equalValue(previous, rule.threshold) && equalValue(current, rule.threshold)
    case 'above': {
      const previousNumber = numeric(previous)
      const currentNumber = numeric(current)
      return previousNumber !== null && currentNumber !== null && rule.threshold !== null
        && previousNumber < Number(rule.threshold) && currentNumber >= Number(rule.threshold)
    }
    case 'below': {
      const previousNumber = numeric(previous)
      const currentNumber = numeric(current)
      return previousNumber !== null && currentNumber !== null && rule.threshold !== null
        && previousNumber > Number(rule.threshold) && currentNumber <= Number(rule.threshold)
    }
    case 'change':
    default:
      return !equalValue(previous, current)
  }
}

function inferCategory(point = {}) {
  if (point.category) return point.category
  const name = String(point.label || point.name || '').toLowerCase()
  const type = String(point.data_type || '').toUpperCase()
  if (type === 'BOOL' || /报警|故障|状态|运行/.test(name)) return 'status'
  if (/气|阀|流量/.test(name)) return 'gas'
  if (/门/.test(name)) return 'doors'
  if (/风机|风扇|搅拌|泵|电机/.test(name)) return 'motors'
  if (/链|推|拉|机构/.test(name)) return 'mechanisms'
  return 'analog'
}

function renderText(template, context) {
  const fallback = `${context.deviceName || '设备'} ${context.label || '点位'} 发生变化，当前值 ${context.value ?? '未知'}`
  const source = String(template || '').trim() || fallback
  const replacements = {
    '{设备}': context.deviceName || '',
    '{点位}': context.label || '',
    '{值}': context.value ?? '',
    '{单位}': context.unit || '',
    '{device}': context.deviceName || '',
    '{point}': context.label || '',
    '{value}': context.value ?? '',
    '{unit}': context.unit || ''
  }
  return Object.entries(replacements).reduce((result, [key, value]) => result.split(key).join(String(value)), source)
}

function resolveAudioUrl(url) {
  const value = String(url || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  return `${getBackendOrigin()}${value.startsWith('/') ? value : `/${value}`}`
}

function pointDefinition(deviceId, deviceName, point, fallbackIndex = 0) {
  const category = inferCategory(point)
  const fieldName = String(point.value_role || point.name || '').trim()
  if (!deviceId || !fieldName) return null
  const config = parseVoiceConfig(point.voice_config)
  if (!config.enabled || !config.rules.length) return null
  return {
    key: `${deviceId}|${point.id || fallbackIndex}|${category}.${fieldName}`,
    deviceId,
    deviceName,
    pointId: point.id || '',
    category,
    fieldName,
    label: String(point.label || point.name || fieldName),
    unit: String(point.unit || ''),
    rules: config.rules
  }
}

export class VoiceAnnouncer {
  constructor(options = {}) {
    this.definitionsByDevice = new Map()
    this.previousValues = new Map()
    this.lastTriggeredAt = new Map()
    this.pendingKeys = new Set()
    this.queue = []
    this.playing = false
    this.muted = options.muted === true
    this.maxQueue = options.maxQueue || 32
    this.disposed = false
    this.playbackCancels = new Set()
  }

  setFactoryPoints(workshops = []) {
    this.definitionsByDevice.clear()
    const grouped = new Map()
    const allDevices = []
    workshops.forEach(workshop => {
      ;(workshop.lines || []).forEach(line => (line.devices || []).forEach(device => allDevices.push(device)))
      ;(workshop.devices || []).forEach(device => allDevices.push(device))
    })
    allDevices.forEach(device => {
      const definitions = (device.dataPoints || [])
        .map((point, index) => pointDefinition(device.id, device.name, point, index))
        .filter(Boolean)
      grouped.set(device.id, definitions)
    })
    grouped.forEach((definitions, deviceId) => this.definitionsByDevice.set(deviceId, definitions))
  }

  updateDefinitionsFromFrame(data) {
    const deviceId = data?.furnace_id
    if (!deviceId || !data?.pointMeta) return
    const entries = Object.entries(data.pointMeta)
    if (!entries.some(([, meta]) => Object.prototype.hasOwnProperty.call(meta || {}, 'voice_config'))) return
    const definitions = entries.map(([path, meta], index) => {
      const [category, fieldName] = path.split('.')
      const config = parseVoiceConfig(meta?.voice_config)
      if (!config.enabled || !config.rules.length) return null
      return {
        key: `${deviceId}|${meta?.id || index}|${category}.${fieldName}`,
        deviceId,
        deviceName: data.furnace_name || deviceId,
        pointId: meta?.id || '',
        category: meta?.category || category,
        fieldName: meta?.field_name || fieldName,
        label: meta?.label || fieldName,
        unit: meta?.unit || '',
        rules: config.rules
      }
    }).filter(Boolean)
    this.definitionsByDevice.set(deviceId, definitions)
  }

  setMuted(value) {
    this.muted = Boolean(value)
    if (this.muted) {
      this.queue = []
      this.pendingKeys.clear()
      for (const cancel of [...this.playbackCancels]) cancel()
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.setMuted(true)
    this.definitionsByDevice.clear()
    this.previousValues.clear()
    this.lastTriggeredAt.clear()
  }

  unlock() {
    if (typeof window === 'undefined') return
    // A real user gesture is enough to unlock Chromium's audio policy. The
    // Electron shell also disables the autoplay restriction for unattended sites.
    this._drainQueue()
  }

  handleDeviceData(data) {
    if (this.disposed) return
    const deviceId = data?.furnace_id
    if (!deviceId) return
    this.updateDefinitionsFromFrame(data)
    const definitions = this.definitionsByDevice.get(deviceId) || []
    definitions.forEach(definition => {
      const current = data?.[definition.category]?.[definition.fieldName]
      const quality = data?.quality?.[definition.category]?.[definition.fieldName] || 'good'
      const previousKey = definition.key
      const hasPrevious = this.previousValues.has(previousKey)
      const previous = this.previousValues.get(previousKey)
      this.previousValues.set(previousKey, current)
      if (quality !== 'good') return

      definition.rules.forEach(rule => {
        if (!shouldTriggerVoiceRule(rule, previous, current, hasPrevious)) return
        const now = Date.now()
        const triggerKey = `${previousKey}|${rule.id}`
        const lastAt = this.lastTriggeredAt.get(triggerKey) || 0
        if (now - lastAt < rule.cooldown_ms) return
        this.lastTriggeredAt.set(triggerKey, now)
        this.enqueue({
          key: triggerKey,
          rule,
          context: {
            deviceName: data.furnace_name || deviceId,
            label: definition.label,
            value: current,
            unit: definition.unit
          }
        })
      })
    })
  }

  enqueue(item) {
    if (this.disposed || this.muted || !item?.rule) return
    if (this.pendingKeys.has(item.key)) return
    if (this.queue.length >= this.maxQueue) {
      const dropped = this.queue.shift()
      if (dropped?.key) this.pendingKeys.delete(dropped.key)
    }
    this.queue.push(item)
    this.pendingKeys.add(item.key)
    this._drainQueue()
  }

  async preview(rule, context = {}) {
    if (this.disposed) return
    const normalized = normalizeVoiceRule(rule)
    return this._playItem({
      rule: normalized,
      context: {
        deviceName: context.deviceName || '示例设备',
        label: context.label || '示例点位',
        value: context.value ?? 1,
        unit: context.unit || ''
      }
    })
  }

  async _drainQueue() {
    if (this.disposed || this.playing || this.muted || this.queue.length === 0) return
    this.playing = true
    const item = this.queue.shift()
    this.pendingKeys.delete(item.key)
    try { await this._playItem(item) } catch (error) { /* audio failure must not stop the queue */ }
    this.playing = false
    if (this.queue.length) this._drainQueue()
  }

  async _playItem(item) {
    if (this.disposed || this.muted) return
    const rule = item.rule
    const text = renderText(rule.text, item.context)
    const mode = rule.mode === 'auto' ? (rule.audio_url ? 'file' : 'tts') : rule.mode
    if (mode === 'file' && rule.audio_url) {
      try {
        await this._playAudio(resolveAudioUrl(rule.audio_url), rule.volume)
        return
      } catch (error) {
        if (!text) throw error
      }
    }
    if (this.disposed || this.muted) return
    await this._speak(text, rule)
  }

  _playAudio(url, volume = 1) {
    return new Promise((resolve, reject) => {
      if (typeof Audio === 'undefined') {
        reject(new Error('当前环境不支持音频播放'))
        return
      }
      const audio = new Audio(url)
      audio.volume = clamp(volume, 0, 1, 1)
      audio.preload = 'auto'
      let settled = false
      let timeout
      const cancel = () => finish(new Error('语音播放已停止'))
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.playbackCancels.delete(cancel)
        audio.onended = null
        audio.onerror = null
        audio.pause()
        audio.removeAttribute?.('src')
        if (error) reject(error)
        else resolve()
      }
      this.playbackCancels.add(cancel)
      audio.onended = () => finish()
      audio.onerror = () => finish(new Error('语音文件播放失败'))
      timeout = setTimeout(() => finish(new Error('语音文件播放超时')), 30000)
      try { Promise.resolve(audio.play()).catch(finish) } catch (error) { finish(error) }
    })
  }

  _speak(text, rule) {
    return new Promise((resolve, reject) => {
      if (typeof window === 'undefined' || !window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') {
        reject(new Error('当前环境没有可用的系统语音'))
        return
      }
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'zh-CN'
      utterance.volume = clamp(rule.volume, 0, 1, 1)
      utterance.rate = clamp(rule.rate, 0.5, 2, 1)
      if (rule.voice_name) {
        const voice = window.speechSynthesis.getVoices().find(item => item.name === rule.voice_name)
        if (voice) utterance.voice = voice
      }
      let settled = false
      let timeout
      const cancel = () => {
        finish(new Error('语音播放已停止'))
        window.speechSynthesis.cancel()
      }
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.playbackCancels.delete(cancel)
        utterance.onend = null
        utterance.onerror = null
        if (error) reject(error)
        else resolve()
      }
      utterance.onend = () => finish()
      utterance.onerror = event => finish(new Error(event?.error || '系统语音播放失败'))
      this.playbackCancels.add(cancel)
      timeout = setTimeout(() => {
        finish(new Error('系统语音播放超时'))
        window.speechSynthesis.cancel()
      }, Math.max(10000, text.length * 450))
      try { window.speechSynthesis.speak(utterance) } catch (error) { finish(error) }
    })
  }
}

export function createVoiceAnnouncer(options = {}) {
  return new VoiceAnnouncer(options)
}
