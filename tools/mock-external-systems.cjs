#!/usr/bin/env node
'use strict';

// Self-contained, read-only training APIs. No PLC or application database.
const http = require('node:http');
const { parseArgs } = require('node:util');
const DEFAULT_PORT = 19090;
const SYSTEMS = Object.freeze([
  { id: 'erp', name: '模拟 ERP', detail: '订单与物料库存', color: '#2867d7' },
  { id: 'mes', name: '模拟 MES', detail: '生产进度与设备状态', color: '#008b78' },
  { id: 'vms', name: '模拟 VMS', detail: '工厂销售与回款管理', color: '#795ac3' }
]);
const DEVICES = Object.freeze([
  { deviceId: 'DEMO-FURNACE-03', deviceName: '模拟 3# 多用炉', factoryName: '模拟工厂', workshopName: '模拟热处理车间', lineName: '模拟 1# 产线' },
  { deviceId: 'DEMO-FURNACE-04', deviceName: '模拟 4# 多用炉', factoryName: '模拟工厂', workshopName: '模拟热处理车间', lineName: '模拟 1# 产线' },
  { deviceId: 'DEMO-CART-01', deviceName: '模拟 1# 料车', factoryName: '模拟工厂', workshopName: '模拟热处理车间', lineName: '模拟 1# 产线' },
  { deviceId: 'DEMO-CLEANER-01', deviceName: '模拟 1# 清洗机', factoryName: '模拟工厂', workshopName: '模拟清洗车间', lineName: '模拟 2# 产线' }
]);
const field = (path, label, type = 'string', unit = '') => ({ path, label, type, unit });
const commonFields = [field('deviceId', '模拟设备编号'), field('deviceName', '设备名称')];
const TABLES = Object.freeze([
  { system: 'erp', id: 'orders', name: '模拟生产订单', category: '生产业务', fields: [...commonFields, field('orderNo', '订单号'), field('customerName', '客户'), field('productName', '产品'), field('plannedQty', '计划数量', 'number', '件'), field('completedQty', '已完成数量', 'number', '件'), field('status', '订单状态'), field('dueDate', '交期')] },
  { system: 'erp', id: 'inventory', name: '模拟物料库存', category: '库存物流', fields: [...commonFields, field('materialCode', '物料编码'), field('materialName', '物料名称'), field('warehouseName', '仓库'), field('stockQty', '库存数量', 'number', '件'), field('reservedQty', '已占用数量', 'number', '件'), field('availableQty', '可用数量', 'number', '件')] },
  { system: 'mes', id: 'production', name: '模拟生产进度', category: '生产业务', fields: [...commonFields, field('workOrderNo', '工单号'), field('shiftName', '班次'), field('plannedQty', '计划数量', 'number', '件'), field('completedQty', '已完成数量', 'number', '件'), field('qualifiedQty', '合格数量', 'number', '件'), field('qualifiedRate', '合格率', 'number', '%'), field('progress', '生产进度', 'number', '%'), field('updatedAt', '更新时间')] },
  { system: 'mes', id: 'devices', name: '模拟设备状态', category: '实时采集', fields: [...commonFields, field('factoryName', '工厂'), field('workshopName', '车间'), field('lineName', '产线'), field('online', '连接正常', 'boolean'), field('running', '运行中', 'boolean'), field('status', '运行状态'), field('temperature', '温度', 'number', '℃'), field('alarmCount', '当前报警数', 'number', '条'), field('pushAtEnd', '推料到位', 'boolean'), field('returnAtEnd', '退回到位', 'boolean'), field('updatedAt', '更新时间')] },
  { system: 'vms', id: 'sales-orders', name: '模拟销售订单', category: '销售业务', fields: [...commonFields, field('salesOrderNo', '销售订单号'), field('orderNo', '关联生产订单号'), field('customerId', '客户编号'), field('customerName', '客户名称'), field('productName', '销售产品'), field('salesQty', '销售数量', 'number', '件'), field('shippedQty', '已发货数量', 'number', '件'), field('unitPrice', '销售单价', 'number', '元/件'), field('salesAmount', '订单金额', 'number', '元'), field('paidAmount', '已回款金额', 'number', '元'), field('outstandingAmount', '待回款金额', 'number', '元'), field('status', '销售状态')] },
  { system: 'vms', id: 'sales-summary', name: '模拟销售回款汇总', category: '销售业务', fields: [...commonFields, field('customerId', '客户编号'), field('customerName', '客户名称'), field('salespersonName', '销售负责人'), field('targetAmount', '目标金额', 'number', '元'), field('salesAmount', '已销售金额', 'number', '元'), field('paidAmount', '已回款金额', 'number', '元'), field('outstandingAmount', '待回款金额', 'number', '元'), field('collectionRate', '回款率', 'number', '%'), field('updatedAt', '更新时间')] }
]);

function rowsFor(table, tick, now) {
  const updatedAt = new Date(now).toISOString();
  if (table === 'erp/orders') return DEVICES.map((device, index) => {
    const plannedQty = 240 + index * 80;
    const completedQty = Math.min(plannedQty, 80 + index * 40 + (tick % 30) * 4);
    return { ...device, orderNo: `MOCK-ERP-202611-${String(index + 1).padStart(3, '0')}`, salesOrderNo: `MOCK-SO-${String(index + 1).padStart(3, '0')}`, customerId: `MOCK-CUSTOMER-${index + 1}`, customerName: ['模拟精工公司', '模拟装备公司', '模拟机械公司', '模拟制造公司'][index], productName: ['模拟齿轮', '模拟轴件', '模拟料盘', '模拟壳体'][index], plannedQty, completedQty, status: completedQty === plannedQty ? '已完成' : '生产中', dueDate: new Date(now + (index + 1) * 86400000).toISOString().slice(0, 10), updatedAt };
  });
  if (table === 'erp/inventory') return DEVICES.map((device, index) => {
    const stockQty = 1500 + index * 200 - (tick % 100) * 3, reservedQty = 100 + index * 20;
    return { ...device, materialCode: `MOCK-MAT-${String(index + 1).padStart(3, '0')}`, materialName: ['模拟齿轮毛坯', '模拟轴件毛坯', '模拟周转料盘', '模拟待清洗壳体'][index], warehouseName: index < 2 ? '模拟原料仓' : '模拟在制品仓', stockQty, reservedQty, availableQty: stockQty - reservedQty, updatedAt };
  });
  if (table === 'mes/production') return DEVICES.map((device, index) => {
    const plannedQty = 240 + index * 80, completedQty = 80 + index * 40 + (tick % 30) * 4;
    const qualifiedQty = completedQty - 1 - index;
    return { ...device, workOrderNo: `MOCK-MES-${index + 1}`, orderNo: `MOCK-ERP-202611-${String(index + 1).padStart(3, '0')}`, shiftName: '模拟白班', plannedQty, completedQty, qualifiedQty, qualifiedRate: Number((qualifiedQty / completedQty * 100).toFixed(1)), progress: Number((completedQty / plannedQty * 100).toFixed(1)), updatedAt };
  });
  if (table === 'mes/devices') return DEVICES.map((device, index) => {
    const phase = (tick + index * 3) % 12, online = phase !== 11, running = online && phase < 9;
    const alarmCount = online && phase === 10 ? 1 : 0;
    return { ...device, online, running, status: !online ? '模拟离线' : alarmCount ? '模拟异常' : running ? '模拟运行' : '模拟待机', temperature: Number((index === 2 ? 24 + (tick % 5) * .2 : 520 + index * 30 + Math.sin(tick / 3 + index) * 12).toFixed(1)), alarmCount, pushAtEnd: online && phase >= 4 && phase <= 7, returnAtEnd: online && (phase <= 1 || phase >= 9), updatedAt };
  });
  if (table === 'vms/sales-orders') return DEVICES.map((device, index) => {
    const salesQty = 240 + index * 80, shippedQty = Math.min(salesQty, 70 + index * 40 + (tick % 30) * 4);
    const unitPrice = 180 + index * 30, salesAmount = salesQty * unitPrice;
    const paidAmount = Math.min(salesAmount, 16000 + index * 4000 + (tick % 80) * 250);
    return { ...device, salesOrderNo: `MOCK-SO-${String(index + 1).padStart(3, '0')}`, orderNo: `MOCK-ERP-202611-${String(index + 1).padStart(3, '0')}`, customerId: `MOCK-CUSTOMER-${index + 1}`, customerName: ['模拟精工公司', '模拟装备公司', '模拟机械公司', '模拟制造公司'][index], productName: ['模拟齿轮', '模拟轴件', '模拟料盘', '模拟壳体'][index], salesQty, shippedQty, unitPrice, salesAmount, paidAmount, outstandingAmount: salesAmount - paidAmount, status: shippedQty === salesQty ? '已发货' : '执行中', updatedAt };
  });
  if (table === 'vms/sales-summary') return DEVICES.map((device, index) => {
    const targetAmount = 200000 + index * 50000, salesAmount = 70000 + index * 20000 + (tick % 100) * 500;
    const paidAmount = 42000 + index * 12000 + (tick % 100) * 400;
    return { ...device, customerId: `MOCK-CUSTOMER-${index + 1}`, customerName: ['模拟精工公司', '模拟装备公司', '模拟机械公司', '模拟制造公司'][index], salespersonName: ['模拟销售甲', '模拟销售乙'][index % 2], targetAmount, salesAmount, paidAmount, outstandingAmount: salesAmount - paidAmount, collectionRate: Number((paidAmount / salesAmount * 100).toFixed(1)), updatedAt };
  });
  throw new Error('Unknown training table');
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function homePage(origin) {
  const cards = SYSTEMS.map(system => `<section class="card" style="--accent:${system.color}"><div class="card-top"><span class="badge">${system.id.toUpperCase()}</span><div><h2>${system.name}</h2><p>${system.detail}</p></div><span class="pill">模拟 · 本机</span></div><dl><dt>API 根地址</dt><dd><code>${origin}/${system.id}</code><button class="copy" data-copy="${origin}/${system.id}">复制</button></dd><dt>健康检查地址</dt><dd><code>/health</code><span class="note">JSON · 无认证</span></dd></dl><div class="tables">${TABLES.filter(table => table.system === system.id).map(table => `<article><header><h3>${table.name}</h3><a href="/${system.id}/${table.id}" target="_blank" rel="noopener">查看接口 ↗</a></header><div class="api-path"><code>/${table.id}</code><button class="copy" data-copy="/${table.id}">复制路径</button></div><p>结果根节点：<code>data.rows</code><button class="copy" data-copy="data.rows">复制</button></p><div class="values" data-table="${system.id}/${table.id}">正在读取模拟数据…</div><details><summary>字段与单位</summary><div class="field-list">${table.fields.map(item => `<span><b>${escapeHtml(item.label)}</b><code>${item.path}</code>${item.unit ? `<small>${item.unit}</small>` : ''}</span>`).join('')}</div></details></article>`).join('')}</div></section>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ERP / MES / VMS 模拟接口工作台</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f3f6fb;color:#25354b;font:14px/1.65 "Microsoft YaHei","Segoe UI",sans-serif}main{max-width:1460px;margin:auto;padding:28px}h1{font-size:25px;margin:0 0 6px;font-weight:700}h2{font-size:18px;margin:0}h3{font-size:15px;margin:0}p{margin:4px 0;color:#53647a}.heading{display:flex;justify-content:space-between;gap:24px;align-items:center;margin-bottom:22px}.live{display:flex;gap:8px;align-items:center;white-space:nowrap;color:#22714e}.live:before{content:"";width:8px;height:8px;border-radius:50%;background:#299e6b}.warning{background:#fff6de;border:1px solid #f0deb0;padding:10px 16px;border-radius:9px;color:#715519;margin-bottom:18px}.steps{display:flex;gap:16px;margin-bottom:22px}.step{flex:1;border:1px solid #dce5ef;border-radius:10px;background:white;padding:12px 16px}.step b{display:inline-flex;border-radius:50%;background:#eaf0ff;color:#3468be;width:24px;height:24px;align-items:center;justify-content:center;margin-right:9px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.card{background:white;border:1px solid #dce4ef;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px #20385d04}.card-top{display:flex;align-items:center;gap:11px;padding:18px;border-bottom:1px solid #e5ebf2}.badge{background:var(--accent);color:white;font-weight:bold;padding:9px;border-radius:9px;letter-spacing:.4px}.pill{font-size:11px;color:#577085;background:#f0f4f8;border-radius:20px;padding:3px 7px;margin-left:auto;white-space:nowrap}dl{margin:16px 18px}dt{font-size:12px;color:#53647a}dd{margin:3px 0 10px;display:flex;align-items:center;gap:7px;flex-wrap:wrap}code{font:12px/1.6 Consolas,monospace;background:#f1f5fa;border-radius:4px;padding:2px 5px;color:#25496e;overflow-wrap:anywhere}.copy{border:0;background:#ebf2ff;color:#315f9e;font:12px "Microsoft YaHei",sans-serif;cursor:pointer;border-radius:5px;padding:4px 7px}.copy:hover{background:#dce9fe}.note{font-size:11px;color:#607386}.tables{padding:0 18px 18px}.tables article{border-top:1px solid #e3eaf1;padding-top:15px;margin-top:15px}.tables header{display:flex;justify-content:space-between;gap:10px;align-items:center}a{font-size:12px;color:var(--accent,#2867d7);text-decoration:none}.api-path{display:flex;align-items:center;gap:8px;margin-top:9px}.tables article>p{font-size:12px;margin:8px 0}.values{background:#f6f8fc;border-radius:8px;padding:10px 12px;margin-top:10px;color:#475b73;font-size:12px;min-height:93px}.values div{display:flex;justify-content:space-between;gap:12px;margin-bottom:3px}.values b{color:#263c54;font-weight:600}.values .time{color:#6a7a8e;font-size:11px;margin-top:6px}details{margin-top:9px}summary{cursor:pointer;color:#486486;font-size:12px}.field-list{display:grid;gap:5px;padding-top:9px}.field-list span{display:flex;align-items:center;gap:7px;border-bottom:1px solid #edf1f6;padding-bottom:4px;font-size:12px}.field-list b{font-weight:500;flex:1}.field-list small{color:#62768b;min-width:21px}.footer{margin-top:20px;padding:15px 18px;background:#eaf0f8;border-radius:10px}.footer p{font-size:12px}.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#233e60;color:white;padding:8px 18px;border-radius:8px;display:none}@media(max-width:1120px){.grid{grid-template-columns:1fr}.tables{display:grid;grid-template-columns:1fr 1fr;gap:18px}.tables article{margin-top:0}.steps{gap:8px}.card-top{padding:15px 18px}}@media(max-width:700px){main{padding:16px}.heading,.steps{flex-direction:column;align-items:stretch}.tables{display:block}.tables article{margin-top:14px}.heading{gap:8px}h1{font-size:21px}}
  </style></head><body><main><header class="heading"><div><h1>外部系统模拟接口</h1><p>先用熟悉的 ERP、MES、VMS 数据练习接入，再替换成现场接口。</p></div><span class="live" id="live-status">每 3 秒更新模拟数据</span></header><div class="warning">这里只是练习环境，不连接真实设备，也不代表已接入大屏。VMS 按「工厂销售管理系统」模拟，提供销售订单与回款汇总。</div><div class="steps"><div class="step"><b>1</b>数据中心 → 数据源 → 新建 → HTTP / REST</div><div class="step"><b>2</b>复制下方根地址，健康检查填 /health，无认证</div><div class="step"><b>3</b>新建数据表，选连接、填路径及 data.rows，再选字段</div></div><div class="grid">${cards}</div><footer class="footer"><strong>第一次建议：MES → 模拟生产进度</strong><p>先关闭「记录匹配」开关，保留全部 4 条记录，读取字段后选设备名称、已完成数量、合格率；保存后到设计器选择该数据表。模拟设备编号不等于你现有软件的设备 ID，直接匹配真实设备可能没有记录。</p><p>全部数据带 simulated=true；数值会循环变化，适合测试刷新。停止模拟服务后，连接检查应显示失败，不会再生成数据。</p></footer></main><div class="toast" role="status"></div><script>
  const toast=document.querySelector('.toast');let toastTimer;
  document.addEventListener('click',async event=>{const button=event.target.closest('[data-copy]');if(!button)return;try{await navigator.clipboard.writeText(button.dataset.copy);toast.textContent='已复制';}catch{toast.textContent='复制不可用，请选中文字复制';}toast.style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.style.display='none',1800);});
  const displays={ 'erp/orders':['completedQty','plannedQty','件'], 'erp/inventory':['availableQty','stockQty','件'], 'mes/production':['completedQty','plannedQty','件'], 'mes/devices':['temperature',null,'℃'], 'vms/sales-orders':['paidAmount','salesAmount','元'], 'vms/sales-summary':['collectionRate',null,'%'] };
  async function refresh(){let failed=false;await Promise.all([...document.querySelectorAll('[data-table]')].map(async target=>{try{const response=await fetch('/'+target.dataset.table,{cache:'no-store'});if(!response.ok)throw Error();const result=await response.json(),spec=displays[target.dataset.table];target.replaceChildren();for(const row of result.data.rows.slice(0,3)){const line=document.createElement('div'),name=document.createElement('span'),value=document.createElement('b');name.textContent=target.dataset.table.startsWith('vms/')?row.customerName:row.deviceName;const v=row[spec[0]];value.textContent=(typeof v==='boolean'?(v?'在线':'离线'):v)+(spec[1]?' / '+row[spec[1]]:'')+(spec[2]?' '+spec[2]:'');line.append(name,value);target.append(line);}const time=document.createElement('div');time.className='time';time.textContent=result.total+' 条模拟记录 · '+new Date(result.updatedAt).toLocaleTimeString('zh-CN',{hour12:false});target.append(time);}catch{failed=true;target.textContent='模拟接口未响应，请检查启动窗口。';}}));document.querySelector('#live-status').textContent=failed?'接口暂未响应':'每 3 秒更新模拟数据';}refresh();setInterval(refresh,3000);
  </script></body></html>`;
}

function createServer({ clock = Date.now, tickMs = 3000 } = {}) {
  if (typeof clock !== 'function' || !Number.isFinite(tickMs) || tickMs < 1) throw new Error('Invalid simulation clock');
  const startedAt = clock();
  const server = http.createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address()?.port || DEFAULT_PORT}`;
    const reply = (status, body, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*', ...(status === 405 ? { Allow: 'GET' } : {}) });
      response.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    if (request.method !== 'GET') return reply(405, { simulated: true, error: '本模拟接口只允许 GET 读取，不接受控制或写入请求。' });
    let url;
    try { url = new URL(request.url, origin); } catch { return reply(400, { simulated: true, error: '请求地址格式无效。' }); }
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    if (pathname === '/') return reply(200, homePage(origin), 'text/html; charset=utf-8');
    if (pathname === '/favicon.ico') { response.writeHead(204); return response.end(); }
    const now = clock(), updatedAt = new Date(now).toISOString(), tick = Math.max(0, Math.floor((now - startedAt) / tickMs));
    if (pathname === '/health' || SYSTEMS.some(system => pathname === `/${system.id}/health`)) {
      return reply(200, { simulated: true, status: 'healthy', system: pathname.split('/')[1]?.toUpperCase() === 'HEALTH' ? 'ERP-MES-VMS-MOCK' : pathname.split('/')[1].toUpperCase(), updatedAt, message: '本机模拟接口，未连接真实业务系统。' });
    }
    if (pathname === '/catalog') return reply(200, { simulated: true, origin, systems: SYSTEMS, tables: TABLES.map(table => ({ ...table, baseUrl: `${origin}/${table.system}`, healthPath: '/health', path: `/${table.id}`, rootPath: 'data.rows', method: 'GET', authType: 'none' })) });
    const table = TABLES.find(item => pathname === `/${item.system}/${item.id}`);
    if (!table) return reply(404, { simulated: true, error: '没有这个模拟接口，请到工作台查看可用路径。', help: '/' });
    let rows = rowsFor(`${table.system}/${table.id}`, tick, now);
    if (url.searchParams.has('deviceId')) rows = rows.filter(row => row.deviceId === url.searchParams.get('deviceId'));
    return reply(200, { simulated: true, system: table.system.toUpperCase(), table: table.name, updatedAt, total: rows.length, message: '全部为模拟记录，非现场数据。', data: { rows }, fields: table.fields });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  return server;
}

async function startServer({ port = DEFAULT_PORT, host = '127.0.0.1', ...options } = {}) {
  if (host !== '127.0.0.1') throw new Error('模拟服务只允许监听 127.0.0.1，不能暴露到外网。');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须是 0 至 65535 的整数。');
  const server = createServer(options);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  let stopPromise;
  const stop = () => stopPromise ||= new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  return { server, origin: `http://${host}:${server.address().port}`, stop };
}

async function main() {
  const args = parseArgs({ options: { port: { type: 'string', short: 'p', default: process.env.MOCK_EXTERNAL_PORT || String(DEFAULT_PORT) }, host: { type: 'string', default: '127.0.0.1' }, help: { type: 'boolean', short: 'h' } } });
  if (args.values.help) { console.log('本机 ERP / MES / VMS 模拟接口\nnode tools/mock-external-systems.cjs [--port 19090]\n只读 GET，监听 127.0.0.1；按 Ctrl+C 停止。'); return; }
  if (!/^\d+$/.test(args.values.port)) throw new Error('端口请输入整数。');
  const running = await startServer({ port: Number(args.values.port), host: args.values.host });
  console.log(`模拟接口已启动：${running.origin}\nERP：${running.origin}/erp\nMES：${running.origin}/mes\nVMS：${running.origin}/vms\n健康检查：/health；JSON；无认证；数据表根节点：data.rows\n打开上面的工作台可复制参数。全部为模拟数据，不连接真实设备；按 Ctrl+C 停止。`);
  let stopping = false;
  const shutdown = async () => { if (stopping) return; stopping = true; await running.stop(); process.exitCode = 0; };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
if (require.main === module) main().catch(error => {
  console.error(error.code === 'EADDRINUSE' ? `端口已被占用，未启动第二个服务。可以改用：node tools/mock-external-systems.cjs --port ${DEFAULT_PORT + 1}` : error.message);
  process.exitCode = 1;
});
module.exports = { DEFAULT_PORT, SYSTEMS, DEVICES, TABLES, rowsFor, createServer, startServer };
