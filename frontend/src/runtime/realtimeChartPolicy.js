// Native WebView shares the CPU/GPU with the animated 3D factory. A fresh PLC
// observation must not start a new 450 ms canvas tween on every HUD chart.
// Draw each real sample directly; keep the designer/non-overlay behavior and
// all samples, timestamps, axes and series settings unchanged.
export function realtimeChartOption(option, nativeOverlay) {
  if (!nativeOverlay) return option
  const direct = series => ({ ...series, animation: false, animationDuration: 0, animationDurationUpdate: 0 })
  return { ...option, animation: false, animationDuration: 0, animationDurationUpdate: 0,
    ...(Array.isArray(option.series) ? { series: option.series.map(direct) }
      : option.series && typeof option.series === 'object' ? { series: direct(option.series) } : {}) }
}
