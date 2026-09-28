export function streetEntryStatus(site) {
  if (!site || site.runtime !== 'local') return { allowed: false, message: '该工厂尚未接入中控库，无法进入工厂场景。' }
  if (Number(site.workshops || 0) < 1) return { allowed: false, message: `${site.name || '该工厂'}尚未配置车间，请先在后台添加车间，再进入工厂场景。` }
  return { allowed: true, message: '' }
}

export function overviewEntryStatus(workshops = []) {
  const rows = Array.isArray(workshops) ? workshops : []
  if (!rows.length) return { allowed: false, message: '尚未配置车间，请先在后台添加车间。' }
  const lines = rows.flatMap(workshop => Array.isArray(workshop.lines) ? workshop.lines : [])
  if (!lines.length) return { allowed: false, message: '尚未配置产线，请先在车间内添加产线，暂不能进入三维总览。' }
  if (!lines.some(line => Array.isArray(line.devices) && line.devices.length)) return { allowed: false, message: '尚未配置设备，请先为产线添加设备，暂不能进入三维总览。' }
  return { allowed: true, message: '' }
}
