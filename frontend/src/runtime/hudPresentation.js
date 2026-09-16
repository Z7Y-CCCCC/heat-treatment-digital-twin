function positiveSize(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

// Render the reference overview at the same authoring size as the designer.
// Scaling the entire canvas keeps typography, charts and spacing proportional;
// resizing widget rectangles alone leaves 12px text huge on a small display.
export function fitHudCanvas(canvas = {}, viewport = {}) {
  const width = positiveSize(canvas.width, 1920)
  const height = positiveSize(canvas.height, 1080)
  const scale = Math.min(positiveSize(viewport.width, width) / width, positiveSize(viewport.height, height) / height)
  return { width: `${width}px`, height: `${height}px`, transform: `translate(-50%, -50%) scale(${scale})` }
}

export function splitHudKpiValue(value) {
  const text = String(value ?? '')
  const match = text.match(/^([+−-]?[\d,.]+)\s*(.*)$/u)
  return match ? { value: match[1], unit: match[2] } : { value: text, unit: '' }
}
