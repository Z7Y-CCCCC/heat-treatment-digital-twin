export const DASHBOARD_CHARTS = [
 ['line','折线图'],['smoothLine','曲线图'],['stepLine','阶梯折线图'],['area','面积图'],['stackedArea','堆叠面积图'],
 ['bar','柱状图'],['horizontalBar','条形图'],['stackedBar','堆叠柱状图'],['lineBar','折柱组合图'],
 ['pie','饼图'],['donut','环形图'],['rose','玫瑰图'],['gauge','仪表盘'],['scatter','散点图'],
 ['radar','雷达图'],['funnel','漏斗图'],['heatmap','热力图'],['candlestick','K线图'],['boxplot','箱线图'],['waterfall','瀑布图']
].map(([id,label])=>({id,label}))
export const CHART_FIELD_ROLES = {
 heatmap:[['xField','横向分类'],['yField','纵向分类'],['heatValueField','热度值']],
 scatter:[['xField','X 数值'],['valueField','Y 数值']],
 candlestick:[['openField','开值'],['closeField','收值'],['lowField','最低值'],['highField','最高值']],
 boxplot:[['lowField','最小值'],['q1Field','下四分位'],['medianField','中位数'],['q3Field','上四分位'],['highField','最大值']]
}
