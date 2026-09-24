# 地图底图来源

下载日期：2026-09-18。仅用于集团分布可视化，不是测绘或导航数据。

- `china-provinces.geojson`：阿里云 DataV GeoAtlas 省级 GeoJSON，保留原始几何。
  - 数据：https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json
  - 官方接口示例：https://help.aliyun.com/zh/datav/datav-atlas/developer-reference/atlas-sdk-introduction
- `china-admin/provinces/<adcode>.geojson` 与 `china-admin/districts/<adcode>.geojson`：阿里云 DataV GeoAtlas 市、区县级行政边界，按本地层级文件离线打包。
  - 下载工具：`tools/download_china_admin_maps.mjs`
  - 数据接口：https://geo.datav.aliyun.com/areas_v3/bound/<adcode>_full.json
  - 官方说明：GeoAtlas 可提取省、市、区县边界；乡镇街道边界不在本次数据范围内。
  - 省级直辖市会直接提供区县边界，无法再拆出独立地级市；台湾省无此接口下级文件。
  - 未将公开访问等同于额外的商用地图授权；正式发布时应核查适用的来源条款。
- `world-countries.geojson`：Natural Earth 1:110m Admin 0 Countries，Public Domain。
  - 数据：https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_admin_0_countries.geojson
  - 说明：https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/
  - Natural Earth 采用其默认边界表达；前端不另行修改争议边界，也不把底图用作主权判断。

工厂地理标记只来自后台填写的经纬度。未填写的位置显示在“待定位”列表，不自动生成地理位置。
