export const DASHBOARD_CHARTS = [
 ['line','折线图','按时间查看数值变化；可开启平滑曲线。'],
 ['area','面积图','用填充面积呈现数值随时间的变化。'],
 ['bar','柱状图','对比不同分类或时间点的数值。'],
 ['pie','饼图','查看非负分类数值的占比；不适合比较温度趋势。'],
 ['gauge','仪表盘','显示当前读数；量程可自动适配，也可设置最小值和最大值。']
].map(([id,label,hint])=>({id,label,hint}))
// Older saved dashboards may still use advanced charts. Keep their field
// mappings and renderer compatibility, but do not offer them for new edits.
export const CHART_FIELD_ROLES = {
 heatmap:[['xField','横向分类'],['yField','纵向分类'],['heatValueField','热度值']],
 scatter:[['xField','X 数值'],['valueField','Y 数值']],
 candlestick:[['openField','开值'],['closeField','收值'],['lowField','最低值'],['highField','最高值']],
 boxplot:[['lowField','最小值'],['q1Field','下四分位'],['medianField','中位数'],['q3Field','上四分位'],['highField','最大值']]
}
