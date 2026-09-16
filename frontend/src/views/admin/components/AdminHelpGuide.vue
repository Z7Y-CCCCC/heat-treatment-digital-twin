<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'

const emit = defineEmits(['navigate'])

const isOpen = ref(false)
const searchQuery = ref('')
const activeCategory = ref('all')
const expandedId = ref('getting-started-1')
const searchInput = ref(null)

const categories = [
    { id: 'all', label: '全部问题', icon: '⌘' },
    { id: 'getting-started', label: '第一次使用', icon: '01' },
    { id: 'security', label: '登录与安全', icon: '02' },
    { id: 'runtime', label: 'Unity 与大屏', icon: '03' },
    { id: 'factory', label: '车间与产线', icon: '04' },
    { id: 'models', label: '模型资产', icon: '05' },
    { id: 'devices', label: '设备管理', icon: '06' },
    { id: 'points', label: 'PLC 与点位', icon: '07' },
    { id: 'dashboard', label: '组件与画面', icon: '08' },
    { id: 'mobile', label: '移动设备', icon: '09' },
    { id: 'data', label: '数据源与备份', icon: '10' },
    { id: 'performance', label: '性能与显示', icon: '11' },
    { id: 'troubleshooting', label: '故障排查', icon: '12' }
]

const wizardSteps = [
    { number: '01', title: '系统', description: '确认项目、运行方式和基础服务', target: { tab: 'settings', settingsSubpage: 'runtime' } },
    { number: '02', title: '车间', description: '建立车间并设定空间范围', target: { tab: 'workshops' } },
    { number: '03', title: '产线', description: '创建产线、设备线和导轨结构', target: { tab: 'lines' } },
    { number: '04', title: '模型', description: '导入、预览、优化和验收模型', target: { tab: 'models' } },
    { number: '05', title: '设备', description: '关联设备、模型和 PLC 连接', target: { tab: 'devices' } },
    { number: '06', title: '点位', description: '配置 PLC 地址、值类型和采集周期', target: { tab: 'points' } },
    { number: '07', title: '画面', description: '编排设备并设计大屏组件', target: { tab: 'platform', platformSubpage: 'designer' } },
    { number: '08', title: '验收', description: '检查实时值、质量和上线状态', target: { tab: 'point-monitor' } }
]

const articles = [
    {
        id: 'getting-started-1', category: 'getting-started', popular: true,
        title: '第一次使用系统，正确的配置顺序是什么？',
        answer: '推荐按“系统 → 车间 → 产线 → 模型 → 设备 → 点位 → 画面 → 验收”的顺序配置。先把空间和资产建好，再绑定实时数据，最后发布大屏。这样可以避免设备找不到产线、模型没有位置或组件没有数据等连锁问题。',
        steps: ['在系统设置中确认数据模式、运行服务和项目场景。', '创建车间并设置世界坐标、边界和尺寸。', '创建产线，再导入模型、创建设备和配置点位。', '完成现场编排和大屏组件绑定后，到点位监视验收。'],
        target: { tab: 'settings', settingsSubpage: 'runtime' }, tags: ['配置顺序', '新手']
    },
    {
        id: 'getting-started-2', category: 'getting-started', popular: true,
        title: '为什么我配置了设备，但大屏里还是看不到？',
        answer: '设备是否显示同时受车间、产线、模型资产、设备可见状态和当前视角影响。先确认设备已经保存到产线，再检查模型是否能预览，最后点击大屏中的“适配”或回到全厂视角。',
        steps: ['在设备管理确认设备所属产线和启用状态。', '在模型库预览同一个模型，确认不是占位模型。', '在现场编排器检查设备是否被移到视口外。', '切换到全厂视角并点击适配。'],
        target: { tab: 'devices' }, tags: ['设备不显示', '视角']
    },
    {
        id: 'getting-started-3', category: 'getting-started',
        title: '新建项目后，应该先改哪些基础信息？',
        answer: '建议先改项目名称、默认场景名称、数据模式和 Unity 画质档位。项目与场景决定大屏的归属，数据模式决定系统是连接真实 PLC 还是使用离线模拟数据。',
        steps: ['打开系统设置，确认运行与投屏、数据通路。', '打开大屏设计器的项目与场景，填写名称。', '保存后重新打开大屏，确认标题和场景状态。'],
        target: { tab: 'platform', platformSubpage: 'scene' }, tags: ['项目', '场景']
    },
    {
        id: 'getting-started-4', category: 'getting-started',
        title: '如何判断当前保存的配置是否真的生效？',
        answer: '保存成功提示只代表后端已经接受配置；实时大屏是否生效还要看配置类型。布局、组件和设备一般会即时刷新，Unity 灯光、部分模型元数据或画质设置可能需要刷新大屏或重启客户端。',
        steps: ['先确认按钮旁出现绿色“保存成功”。', '观察顶部 Unity、设备和数据状态。', '点击实时大屏标签或刷新页面验证显示。', '仍不一致时查看本向导的故障排查分类。'],
        target: { tab: 'point-monitor' }, tags: ['保存', '生效']
    },
    {
        id: 'getting-started-5', category: 'getting-started',
        title: '系统里的“配置顺序”导航怎么用？',
        answer: '顶部配置顺序是一个快捷向导，不会自动修改配置。点击某一步会直接跳到对应模块；步骤圆点只是建议顺序，不代表当前步骤已经完成。',
        steps: ['点击顶部任意步骤进入对应配置页。', '完成当前页后用“下一步”思路继续配置。', '全部完成后进入验收，检查实时值和模型状态。'],
        target: { tab: 'settings', settingsSubpage: 'runtime' }, tags: ['导航', '向导']
    },
    {
        id: 'getting-started-6', category: 'getting-started',
        title: '页面中的蓝色、绿色和红色状态分别代表什么？',
        answer: '蓝色通常代表当前选中或可操作；绿色代表在线、成功或质量良好；黄色代表等待、陈旧或需要注意；红色代表失败、离线或存在阻断问题。具体原因请悬停查看提示，或打开对应模块的错误详情。',
        steps: ['优先看顶部 Unity、设备和数据连接状态。', '再看设备卡片或点位的质量标签。', '红色状态不要只刷新页面，应先查看错误文本。'],
        target: { tab: 'point-monitor' }, tags: ['状态', '颜色']
    },

    {
        id: 'security-1', category: 'security', popular: true,
        title: '后台为什么会自动锁定？如何调整时间？',
        answer: '后台安全策略会在一段时间没有人工操作后自动锁定，避免配置权限长期暴露。数据刷新、设备动画和后台轮询不算人工操作。可在“系统设置 → 后台安全”调整 1–480 分钟。',
        steps: ['进入系统设置 → 后台安全。', '输入自动锁定时间或点击常用时间。', '点击保存，等待按钮旁出现绿色成功反馈。'],
        target: { tab: 'settings', settingsSubpage: 'security' }, tags: ['自动锁定', '密码']
    },
    {
        id: 'security-2', category: 'security',
        title: '忘记后台密码怎么办？',
        answer: '后台密码不会显示在页面或浏览器存储中。如果仍有已解锁的工程师窗口，可以在后台安全页修改密码；如果所有窗口都已锁定，需要由项目管理员按本机部署方案进行恢复，不能通过前端绕过密码。',
        steps: ['如果还有解锁窗口，进入后台安全修改密码。', '修改后其他工程师会话会失效，需要重新登录。', '没有任何解锁窗口时，联系部署负责人处理本机恢复。'],
        target: { tab: 'settings', settingsSubpage: 'security' }, tags: ['密码', '锁定']
    },
    {
        id: 'security-3', category: 'security',
        title: '点击“保存自动锁定设置”后怎么确认成功？',
        answer: '按钮会先进入“保存中…”状态并暂时禁用；接口成功后，按钮旁会出现绿色勾选和“保存成功”，同时当前生效时间会更新。红色提示表示服务没有接受本次修改。',
        steps: ['观察按钮文字是否变为“保存中…”。', '等待绿色成功提示，不要连续重复点击。', '如果失败，按提示检查后台安全服务或会话是否失效。'],
        target: { tab: 'settings', settingsSubpage: 'security' }, tags: ['保存反馈', '安全']
    },
    {
        id: 'security-4', category: 'security',
        title: '为什么顶部有“立即锁定”按钮？',
        answer: '顶部按钮用于离开电脑前立即收回后台编辑权限。锁定不会关闭实时大屏，重新进入后台需要密码。正在编辑的内容应先保存，否则未保存的页面状态可能不会写入后端。',
        steps: ['先保存当前正在编辑的页面。', '确认保存成功提示出现。', '点击顶部“立即锁定”，再验证实时大屏仍可显示。'],
        target: { tab: 'settings', settingsSubpage: 'security' }, tags: ['立即锁定', '权限']
    },
    {
        id: 'security-5', category: 'security',
        title: '多个后台窗口同时打开会互相影响吗？',
        answer: '会。后台安全状态会在窗口之间同步：一个窗口锁定后，其他窗口会收到锁定状态；修改密码后其他工程师会话会失效。建议只保留必要的后台窗口。',
        steps: ['修改密码或锁定前先保存所有窗口。', '其他窗口出现锁定提示后重新输入新密码。', '不要在多个窗口同时编辑同一条配置。'],
        target: { tab: 'settings', settingsSubpage: 'security' }, tags: ['多窗口', '会话']
    },

    {
        id: 'runtime-1', category: 'runtime', popular: true,
        title: 'Unity 显示“已连接”，但画面不更新怎么办？',
        answer: '“Unity 已连接”只说明客户端心跳在线，不代表当前场景、配置和 Unity 画面都已完成同步。先观察大屏状态条，再尝试切换实时大屏标签；如果仍无变化，使用窗口右上角刷新按钮。',
        steps: ['确认顶部 Unity 状态是绿色。', '点击实时大屏标签，再返回后台。', '点击窗口刷新按钮重新加载 Web 画面。', '仍不更新时检查运行与投屏页的本地服务状态。'],
        target: { tab: 'settings', settingsSubpage: 'runtime' }, tags: ['Unity', '不更新']
    },
    {
        id: 'runtime-2', category: 'runtime',
        title: '如何重启或刷新 Unity 端？',
        answer: '优先使用窗口右上角的刷新按钮，它只刷新当前 Web 页面；当 Unity 场景、模型缓存或原生窗口状态异常时，再关闭并重新启动客户端。重启前先保存后台配置。',
        steps: ['保存当前编辑内容。', '先点击右上角刷新页面。', '如果问题仍在，关闭客户端后重新启动 HeatTreatmentDigitalTwin。', '重新打开后查看模型错误面板和连接状态。'],
        target: { tab: 'settings', settingsSubpage: 'runtime' }, tags: ['重启', '刷新']
    },
    {
        id: 'runtime-3', category: 'runtime',
        title: '实时大屏启动时为什么会出现返回按钮？',
        answer: '返回按钮只应在用户主动进入车间、产线或设备下级视角后出现。启动时如果仍显示，通常是旧的导航上下文被恢复或当前发布视图带有父级关系。可以回到全厂视角并刷新页面。',
        steps: ['点击返回按钮回到上一级或全厂视角。', '重新从全厂视角进入下级视角。', '仍然启动即出现时，检查大屏设计器中的视图父级关系。'],
        target: { tab: 'platform', platformSubpage: 'designer' }, tags: ['返回按钮', '视角']
    },
    {
        id: 'runtime-4', category: 'runtime',
        title: '为什么实时大屏会闪屏或出现白边？',
        answer: '闪屏通常来自窗口重绘、组件频繁改变尺寸或显卡合成层刷新。如果仍出现，先检查是否有组件在不停改变尺寸，再检查 Unity 客户端日志。',
        steps: ['确认不是浏览器缩放或窗口边缘拖动造成的视觉重绘。', '暂时关闭频繁动画或高频滚动组件。', '必要时在系统设置降低 Unity 画质档位。', '记录出现白边的组件和操作路径。'],
        target: { tab: 'settings', settingsSubpage: 'performance' }, tags: ['闪屏', '白边', 'WebView']
    },
    {
        id: 'runtime-5', category: 'runtime',
        title: '实时大屏和后台管理如何切换？',
        answer: 'Unity 客户端顶部有“实时大屏”和“后台管理”两个标签。切换标签不会删除配置；后台锁定时仍可以查看实时大屏，进入后台时需要解锁。',
        steps: ['点击顶部实时大屏查看现场。', '点击后台管理进入配置。', '后台锁定后按提示输入密码。'],
        target: { tab: 'composer' }, tags: ['标签页', '切换']
    },
    {
        id: 'runtime-6', category: 'runtime',
        title: '设备离线时，大屏应该显示什么？',
        answer: '设备离线时应保留最后一次可用画面，同时在状态、点位质量和设备卡片上明确显示离线或数据陈旧，不应把旧值伪装成实时值。出现红色状态后优先查看设备连接配置和点位监视。',
        steps: ['在点位监视查看质量和最后更新时间。', '在设备管理检查 PLC 地址与协议。', '确认后端采集服务和 Unity 连接状态。'],
        target: { tab: 'point-monitor' }, tags: ['离线', '数据质量']
    },

    {
        id: 'factory-1', category: 'factory', popular: true,
        title: '车间位置、尺寸和产线位置分别有什么区别？',
        answer: '车间位置决定整个车间在工厂世界中的坐标；车间尺寸决定边界和空间范围；产线位置决定产线在车间内部的位置。先确定车间，再调整产线，设备位置属于产线内部布局。',
        steps: ['车间管理设置世界位置和边界。', '产线管理设置产线相对车间的位置。', '现场编排器调整设备在产线上的位置。'],
        target: { tab: 'workshops' }, tags: ['坐标', '布局']
    },
    {
        id: 'factory-2', category: 'factory',
        title: '如何新增一个车间？',
        answer: '车间是空间和产线的容器。新增后需要给车间命名、设置尺寸和世界位置，再进入产线管理创建产线。建议先用清晰的现场名称，不要只使用“车间1”。',
        steps: ['打开车间管理并点击新增。', '填写名称、尺寸、世界位置和边界。', '保存后在车间列表中选中它。', '继续创建该车间下的产线。'],
        target: { tab: 'workshops' }, tags: ['新增车间', '空间']
    },
    {
        id: 'factory-3', category: 'factory',
        title: '产线反向是什么意思？会不会改变设备数据？',
        answer: '产线反向主要改变产线的空间方向和布局顺序，用于适配现场从右向左或从左向右的流向。它不会改变设备 ID、PLC 点位或模型资产，但保存前仍建议确认设备在画面中的相对位置。',
        steps: ['在产线管理选择目标产线。', '执行产线反向并查看预览。', '确认设备顺序和导轨方向后保存。'],
        target: { tab: 'lines' }, tags: ['产线反向', '流向']
    },
    {
        id: 'factory-4', category: 'factory',
        title: '为什么产线保存了，但设备位置没有跟着变？',
        answer: '产线结构保存和设备实例位置保存是两个动作。产线结构负责产线、导轨和设备归属；设备具体坐标、旋转和缩放由现场编排器保存。',
        steps: ['先保存产线结构。', '进入现场编排器确认设备位置。', '点击“保存设备布局”，等待成功反馈。', '刷新大屏验证。'],
        target: { tab: 'composer' }, tags: ['设备位置', '保存布局']
    },
    {
        id: 'factory-5', category: 'factory',
        title: '车间边界有什么用？',
        answer: '边界用于表达车间空间范围、辅助镜头适配和现场布局检查。它不是碰撞体，也不会限制 PLC 数据或设备运行。实际部署时建议按现场可视范围设置，并给边缘设备留出余量。',
        steps: ['在车间管理设置边界开关。', '填写宽度、深度和高度。', '保存后回到大屏检查适配效果。'],
        target: { tab: 'workshops' }, tags: ['边界', '空间范围']
    },
    {
        id: 'factory-6', category: 'factory',
        title: '如何把多个设备放到同一条产线？',
        answer: '设备创建时选择所属产线即可。设备 ID 必须唯一，名称可以按现场编号命名；创建后可在现场编排器中调整设备在产线上的坐标。',
        steps: ['先在产线管理确认目标产线存在。', '进入设备管理点击新增设备。', '选择同一条产线并绑定模型。', '保存后到现场编排器排布。'],
        target: { tab: 'devices' }, tags: ['设备归属', '产线']
    },

    {
        id: 'models-1', category: 'models', popular: true,
        title: 'GLB/GLTF 模型导入后预览失败，通常是什么原因？',
        answer: '最常见原因是模型文件路径失效、后端返回 404、文件没有可用场景、文件过大或资源引用不完整。现在模型预览失败会显示具体 HTTP 状态、模型名称和请求 URL。',
        steps: ['打开模型库查看错误面板中的 URL。', '确认该 URL 在当前机器可以访问。', '若是 404，重新上传模型或修正资产路径。', '若能访问但仍失败，检查 GLB 是否包含可用场景。'],
        target: { tab: 'models' }, tags: ['模型预览', '404', 'GLB']
    },
    {
        id: 'models-2', category: 'models',
        title: '为什么之前导入成功的模型现在显示 404？',
        answer: '导入记录和实际文件是两件事：数据库里仍可能有模型记录，但磁盘上的上传文件被移动、删除、换了机器，或者后端路径发生变化。预览请求返回 404 就表示当前 URL 找不到实体文件。',
        steps: ['复制错误面板中的完整 URL。', '在当前后端检查对应 uploads/models 文件是否存在。', '重新上传原始 GLB，确认保存后预览成功。', '不要只修改模型名称来掩盖路径问题。'],
        target: { tab: 'models' }, tags: ['404', '文件丢失']
    },
    {
        id: 'models-3', category: 'models',
        title: '模型导入后为什么变成灰色占位模型？',
        answer: '灰色或黑色几何体是运行时的安全回退模型，表示真实模型加载失败，但场景仍然可以继续显示。请查看模型错误提示，不要把占位模型当成导入成功。',
        steps: ['查看模型未加载错误面板。', '确认模型 ID、文件 URL 和 HTTP 状态。', '修复资产后刷新预览或重启 Unity。'],
        target: { tab: 'models' }, tags: ['占位模型', '灰色模型']
    },
    {
        id: 'models-4', category: 'models',
        title: '上传模型时应该使用 GLB 还是 GLTF？',
        answer: '现场交付优先使用单文件 GLB，便于备份、传输和部署；GLTF 可以使用，但必须保证外部 bin、纹理和引用路径一起可访问。模型名称和业务 ID 建议稳定，不要频繁变更。',
        steps: ['优先导出单文件 GLB。', '上传后立即在模型库预览。', '确认材质、尺寸、朝向和原点。', '通过验收后再绑定到设备。'],
        target: { tab: 'models' }, tags: ['GLB', 'GLTF', '上传']
    },
    {
        id: 'models-5', category: 'models',
        title: '模型大小、方向和原点不对怎么处理？',
        answer: '模型文件应该在建模软件中先完成单位、朝向和原点整理；后台的设备缩放和旋转适合现场微调，不适合弥补严重的模型坐标错误。建议统一使用米制、底面接近 Y=0，并把设备中心放在合理原点。',
        steps: ['在模型库预览检查底面和朝向。', '需要大幅修正时回到建模软件处理。', '在现场编排器只做少量缩放、旋转和位置调整。'],
        target: { tab: 'models' }, tags: ['坐标', '缩放', '朝向']
    },
    {
        id: 'models-6', category: 'models',
        title: '模型验收主要检查哪些内容？',
        answer: '模型验收至少要检查文件可访问、场景可解析、材质正常、尺寸合理、朝向一致、节点命名稳定和运行时性能。需要拆解或点位绑定的模型，还要检查关键节点是否存在。',
        steps: ['先确认模型文件状态为可访问。', '预览检查外观、材质、底面和中心。', '配置关键部件或外壳节点。', '完成检查后提交验收，再绑定设备。'],
        target: { tab: 'models' }, tags: ['验收', '节点']
    },
    {
        id: 'models-7', category: 'models',
        title: '模型节点绑定后为什么没有跟着点位变化？',
        answer: '节点绑定需要同时满足模型节点路径正确、点位有实时值、动作类型与点位值类型匹配，并且组件或设备处于可更新状态。只保存绑定关系，不代表现场一定有有效数据。',
        steps: ['在部位绑定中确认节点路径能被找到。', '检查点位监视是否有新鲜值。', '确认动作是开关、角度、百分比还是颜色。', '用模拟模式先验证，再切换真实 PLC。'],
        target: { tab: 'models' }, tags: ['节点绑定', '动画']
    },
    {
        id: 'models-8', category: 'models',
        title: '模型库里删除模型会影响已经绑定的设备吗？',
        answer: '会。设备保存的是模型类型关联，删除或失效模型资产后，相关设备可能回退到占位模型。删除前应先查看关联影响，并先为设备切换到替代模型。',
        steps: ['打开模型库查看目标模型的关联设备。', '先为关联设备绑定替代模型。', '确认大屏和预览正常后再删除旧资产。'],
        target: { tab: 'models' }, tags: ['删除模型', '关联影响']
    },
    {
        id: 'models-9', category: 'models',
        title: '如何区分模型记录、模型文件和设备实例？',
        answer: '模型记录是后台中的名称、ID、元数据和文件路径；模型文件是磁盘上的 GLB/GLTF；设备实例是现场的一台具体设备，包含位置、旋转、缩放、产线归属和实时点位。一个模型可以被多个设备实例复用。',
        steps: ['模型资产问题去模型库处理。', '设备位置问题去现场编排器处理。', '点位和连接问题去点位映射或设备管理处理。'],
        target: { tab: 'models' }, tags: ['模型', '设备实例']
    },

    {
        id: 'devices-1', category: 'devices', popular: true,
        title: '创建设备时，模型、产线和 PLC 分别怎么选？',
        answer: '产线决定设备属于哪个空间结构，模型决定大屏里的外观，PLC 连接决定从哪里读取实时数据。三者互相独立但必须都正确，设备才能既出现在正确位置又显示正确状态。',
        steps: ['选择设备所属车间和产线。', '选择已验收的模型资产。', '填写设备名称、ID 和 PLC 连接。', '保存后到点位映射绑定数据。'],
        target: { tab: 'devices' }, tags: ['创建设备', '模型', 'PLC']
    },
    {
        id: 'devices-2', category: 'devices',
        title: '设备 ID 可以修改吗？',
        answer: '设备 ID 是点位、实时数据和移动配置的重要关联键，已经投入使用后不建议修改。若必须修改，应同时迁移点位、设备布局、模型绑定和移动设备配置，并重新验收。',
        steps: ['先确认旧 ID 被哪些点位和组件引用。', '备份当前配置。', '完成关联迁移后再修改。', '重新打开大屏检查所有引用。'],
        target: { tab: 'devices' }, tags: ['设备 ID', '关联']
    },
    {
        id: 'devices-3', category: 'devices',
        title: '设备显示“等待采集”是什么意思？',
        answer: '表示设备配置已经存在，但当前还没有收到有效 PLC 数据。可能是连接未建立、点位未配置、地址错误、采集器未启动或设备处于模拟数据之外的等待状态。',
        steps: ['检查设备管理里的 PLC 连接参数。', '进入点位映射确认至少有一个有效点位。', '到点位监视查看最后更新时间和质量。', '检查运行与投屏页的采集服务状态。'],
        target: { tab: 'point-monitor' }, tags: ['等待采集', '连接']
    },
    {
        id: 'devices-4', category: 'devices',
        title: '设备名称改了，为什么组件里还是旧名称？',
        answer: '组件可能使用了发布版本中的标题，也可能是 Unity/WebSocket 还保留旧配置。保存设备后，刷新大屏并确认发布画面重新加载；如果是手工文本组件，需要单独修改组件标题。',
        steps: ['保存设备名称。', '刷新后台和实时大屏。', '检查大屏设计器组件标题是否为固定文本。'],
        target: { tab: 'devices' }, tags: ['名称', '发布']
    },
    {
        id: 'devices-5', category: 'devices',
        title: '设备删除前为什么要确认关联？',
        answer: '删除设备可能同时影响点位、布局、移动配置、组件绑定和历史数据。系统会先展示影响范围，确认名称后才允许删除，避免误删现场资产。',
        steps: ['点击删除并查看关联影响。', '确认目标设备名称完全一致。', '删除后重新检查大屏组件和点位列表。'],
        target: { tab: 'devices' }, tags: ['删除设备', '影响范围']
    },
    {
        id: 'devices-6', category: 'devices',
        title: '固定设备和辅助设备有什么区别？',
        answer: '固定设备通常使用标准炉体或现场模型，并挂载生产点位；辅助设备可以是小车、清洗机、机器人或其他不属于主设备线的对象。辅助设备仍然可以有模型、点位和移动配置。',
        steps: ['根据现场职责选择设备类型。', '需要移动效果时进入移动设备页配置。', '需要实时状态时仍然在点位映射里绑定点位。'],
        target: { tab: 'mobile-devices' }, tags: ['辅助设备', '小车']
    },

    {
        id: 'points-1', category: 'points', popular: true,
        title: 'PLC 只传“当前位置 1、2、3”，能不能显示连续移动？',
        answer: '不能把停靠编号当成连续测距值。系统可以准确显示当前位置点位，但从 1 到 2 中间的真实位置并不知道；如果需要全过程同步，PLC 必须持续提供测距值或移动进度。没有连续数据时，中间只能做模拟动画并明确标注为估算。',
        steps: ['把 1、2、3 配置为离散位置点位。', '在移动设备页定义位置编号到坐标的映射。', '只有接入测距值或进度值后，才开启真实连续跟随。'],
        target: { tab: 'mobile-devices' }, tags: ['移动设备', '位置', 'PLC']
    },
    {
        id: 'points-2', category: 'points',
        title: '点位名称、显示名称和值角色有什么区别？',
        answer: '点位名称用于识别和配置，显示名称用于界面展示，值角色用于告诉系统这个值代表温度、门状态、当前位置或进度等业务含义。名称可以自由命名，但值角色要保持稳定。',
        steps: ['为每个点位填写现场可读的显示名称。', '为系统行为选择准确的值角色。', '保存后到点位监视确认实际值落在正确字段。'],
        target: { tab: 'points' }, tags: ['点位字段', '值角色']
    },
    {
        id: 'points-3', category: 'points',
        title: 'PLC 地址应该怎么填写？',
        answer: '地址格式取决于所选 PLC 协议。不要把协议、IP、Rack/Slot 和变量地址混在一个字段里；先选择协议，再按界面提示填写连接参数和点位地址。',
        steps: ['在设备管理选择正确协议。', '填写 IP、端口和协议专属连接参数。', '在点位映射按提示填写寄存器、DB、Tag 或变量地址。', '用点位监视读取一次验证。'],
        target: { tab: 'devices' }, tags: ['地址', '协议']
    },
    {
        id: 'points-4', category: 'points',
        title: '采集周期越小越好吗？',
        answer: '不是。采集周期越小，实时性越好，但 PLC、后端、WebSocket 和 Unity 的压力越大。温度、状态和位置应按业务需要设置；移动设备位置通常需要更低延迟，但也要结合 PLC 实际刷新频率。',
        steps: ['先确认 PLC 实际刷新频率。', '状态点可使用较低频率，位置点按移动速度调优。', '在点位监视观察时间戳是否真的更新。', '不要让大量无关点位使用极短周期。'],
        target: { tab: 'points' }, tags: ['采集周期', '延迟', '性能']
    },
    {
        id: 'points-5', category: 'points',
        title: '点位显示“坏质量”或“陈旧”是什么意思？',
        answer: '坏质量通常表示读取失败、类型不对或数据无效；陈旧表示最近没有收到足够新的数据。界面可以保留最后值，但不会把陈旧值当成最新实时值。',
        steps: ['查看点位的最后更新时间和错误信息。', '检查 PLC 连接和地址。', '确认数据类型、缩放和单位。', '恢复后观察质量是否回到良好。'],
        target: { tab: 'point-monitor' }, tags: ['数据质量', '陈旧']
    },
    {
        id: 'points-6', category: 'points',
        title: '模拟模式和真实 PLC 模式怎么切换？',
        answer: '模拟模式适合离线演示和界面验收，真实模式由后端采集器读取 PLC。切换模式后要保存系统设置，并刷新大屏；不要在现场误用模拟模式判断设备真实状态。',
        steps: ['进入系统设置 → 数据通路。', '选择内置低延迟采集或模拟数据。', '保存并刷新大屏。', '在点位监视确认数据来源。'],
        target: { tab: 'settings', settingsSubpage: 'data' }, tags: ['模拟数据', '真实数据']
    },
    {
        id: 'points-7', category: 'points',
        title: '数值范围 0–100 和 0–1 怎么选？',
        answer: '选择与 PLC 实际传输约定一致的范围。0–1 常用于归一化进度，0–100 常用于百分比展示。位置映射会根据选定模式转换，不要同时在 PLC 和系统里重复换算。',
        steps: ['确认 PLC 原始值的含义和范围。', '在点位映射选择值模式。', '用 0、50、100 或 0、0.5、1 验证转换结果。'],
        target: { tab: 'points' }, tags: ['归一化', '百分比']
    },
    {
        id: 'points-8', category: 'points',
        title: '点位值为什么读取到了，但组件不显示？',
        answer: '组件还需要绑定正确的设备、点位和值角色。常见问题是绑定了另一台设备、选择了错误的分类，或组件条件把内容隐藏了。',
        steps: ['在点位监视确认点位确实有值。', '在大屏设计器检查设备和点位绑定。', '检查显示条件、动画条件和可见性规则。', '保存并发布画面。'],
        target: { tab: 'platform', platformSubpage: 'designer' }, tags: ['组件绑定', '不显示']
    },
    {
        id: 'points-9', category: 'points',
        title: '如何给移动设备配置起始、终点和当前位置？',
        answer: '移动设备至少需要一个当前位置点位；起始位置和终点位置可以是离散编号对应的停靠坐标，也可以是连续坐标/进度的端点。只有当前位置持续变化时，模型才有真实移动依据。',
        steps: ['打开移动设备标签页选择设备。', '绑定当前位置点位。', '按现场编号录入停靠点坐标或位置表。', '按需配置开始行动点位和到位状态。'],
        target: { tab: 'mobile-devices' }, tags: ['移动配置', '起点', '终点']
    },
    {
        id: 'points-10', category: 'points',
        title: '如何降低 PLC 到 Unity 的显示延迟？',
        answer: '低延迟的关键是减少无意义轮询和排队：采集器收到新值后立即推送，Unity 只处理最新帧，点位按必要频率采集，移动位置不要等待下一批无关数据。',
        steps: ['把移动位置点位设为必要的高频点。', '避免为同一位置配置重复轮询。', '确认后端 WebSocket 和 Unity 状态在线。', '在点位监视对比 PLC 时间戳与大屏更新时间。'],
        target: { tab: 'settings', settingsSubpage: 'performance' }, tags: ['低延迟', 'WebSocket']
    },

    {
        id: 'dashboard-1', category: 'dashboard', popular: true,
        title: '如何新增一个大屏组件？',
        answer: '组件在大屏设计器中创建。先选择组件类型，再配置位置、尺寸、标题和数据来源；涉及 PLC 的组件还要绑定设备和点位。保存草稿后需要发布，实时大屏才会使用发布版本。',
        steps: ['进入大屏设计器。', '点击新增组件并选择类型。', '配置内容、样式、显示条件和数据源。', '保存草稿并发布画面。'],
        target: { tab: 'platform', platformSubpage: 'designer' }, tags: ['组件', '发布']
    },
    {
        id: 'dashboard-2', category: 'dashboard',
        title: '保存草稿和保存并发布有什么区别？',
        answer: '保存草稿只保存当前编辑内容，不一定改变实时大屏；保存并发布会生成可供实时大屏使用的版本。建议先保存草稿检查，再发布正式版本。',
        steps: ['编辑后先保存草稿。', '检查预览、数据绑定和显示条件。', '确认无误后点击保存并发布。', '切换实时大屏验证。'],
        target: { tab: 'platform', platformSubpage: 'designer' }, tags: ['草稿', '发布']
    },
    {
        id: 'dashboard-3', category: 'dashboard',
        title: '组件的显示条件为什么不生效？',
        answer: '显示条件需要有可用的运行时值，并且比较方式、阈值和数据类型一致。空值、坏质量或绑定设备错误都会导致条件无法按预期判断。',
        steps: ['确认数据源点位有新鲜值。', '检查条件引用的是正确设备和字段。', '检查数字、布尔和文本比较方式。', '保存发布后再验证。'],
        target: { tab: 'platform', platformSubpage: 'designer' }, tags: ['显示条件', '可见性']
    },
    {
        id: 'dashboard-4', category: 'dashboard',
        title: '如何让组件点击后联动 Unity 视角？',
        answer: '组件事件中选择进入设备、聚焦产线、聚焦车间或切换视图等动作，并配置对应目标。发布后，点击组件会向 Unity 发送导航请求。',
        steps: ['打开组件的事件配置。', '选择视角动作和目标设备/产线。', '保存并发布。', '在实时大屏点击组件验证。'],
        target: { tab: 'platform', platformSubpage: 'designer' }, tags: ['事件', '视角联动']
    },
    {
        id: 'dashboard-5', category: 'dashboard',
        title: '为什么组件右侧详情没有自动弹出？',
        answer: '详情面板通常由选中事件触发，组件必须是可交互类型，并且前台有对应的详情视图。请确认组件没有被透明层遮挡，事件配置没有被条件隐藏。',
        steps: ['点击组件本体而不是空白区域。', '检查组件是否配置了选中/进入详情事件。', '检查详情面板的可见性和 z-index。', '保存发布后刷新大屏。'],
        target: { tab: 'platform', platformSubpage: 'designer' }, tags: ['详情', '选中']
    },
    {
        id: 'dashboard-6', category: 'dashboard',
        title: '设计器中的按钮和实时大屏中的按钮为什么不一样？',
        answer: '设计器按钮可能带有编辑态边框、拖拽手柄和选中态；实时大屏只显示发布版本的运行态样式。请在发布后的实时大屏检查最终效果，不要只看编辑器的辅助边框。',
        steps: ['先保存草稿并查看预览。', '发布后切到实时大屏。', '如果仍不一致，检查是否打开了旧页面缓存。'],
        target: { tab: 'platform', platformSubpage: 'designer' }, tags: ['按钮样式', '编辑器']
    },
    {
        id: 'dashboard-7', category: 'dashboard',
        title: '如何调整组件大小、位置和层级？',
        answer: '在设计器中选中组件后调整画布位置和尺寸，必要时修改旋转和 z-index。组件重叠时，层级越高越靠前；交互区域应避免被其他组件覆盖。',
        steps: ['选中组件并拖动位置或边缘。', '调整尺寸和层级。', '检查不同窗口尺寸下的布局。', '保存并发布。'],
        target: { tab: 'platform', platformSubpage: 'designer' }, tags: ['布局', 'z-index']
    },
    {
        id: 'dashboard-8', category: 'dashboard',
        title: '预览区域报错时，右侧错误列表怎么拖动？',
        answer: '错误列表超过高度后会出现滚动条，可以直接拖动右侧滑块，也可以在列表内部滚轮滚动。错误面板会拦截自己的指针事件，不会把拖动误传给 3D 画布。',
        steps: ['把鼠标放在错误列表内部。', '拖动右侧滚动条或滚动鼠标滚轮。', '查看完整 URL 和 HTTP 状态，再处理对应模型。'],
        target: { tab: 'models' }, tags: ['滚动条', '错误列表']
    },

    {
        id: 'mobile-1', category: 'mobile', popular: true,
        title: '移动设备页面应该配置哪些点位？',
        answer: '最小配置是当前位置点位；如果需要表现动作过程，可以增加开始行动、停止/到位、起始位置、终点位置或连续进度点位。离散位置编号只能准确表达停靠点，不能还原中间真实轨迹。',
        steps: ['先绑定当前位置。', '按 PLC 实际能力增加行动和到位点位。', '只有有连续进度或测距值时才启用真实连续跟随。'],
        target: { tab: 'mobile-devices' }, tags: ['移动设备', '点位']
    },
    {
        id: 'mobile-2', category: 'mobile',
        title: '位置编号 1、2、3 如何对应大屏坐标？',
        answer: '位置编号是业务值，大屏坐标是三维位置。需要在移动设备配置中建立位置表，把每个编号映射到现场测量的 X、Y、Z 坐标；系统收到编号后切换到对应停靠坐标。',
        steps: ['用测距仪或现场基准确定停靠点。', '录入每个编号对应的三维坐标。', '让 PLC 传入编号并在点位监视验证。', '在实时大屏检查模型是否跳到目标点。'],
        target: { tab: 'mobile-devices' }, tags: ['位置表', '坐标映射']
    },
    {
        id: 'mobile-3', category: 'mobile',
        title: '为什么移动设备从一个点跳到另一个点，而不是平滑移动？',
        answer: '如果 PLC 只提供离散位置编号，系统无法知道中间真实位置。可以在起点和终点之间做视觉缓动，但那是模拟路径，不是测距数据。现场验收应明确区分“停靠位置同步”和“全过程同步”。',
        steps: ['确认当前位置点位的值是离散编号还是连续值。', '离散值只验收起点/终点停靠是否正确。', '需要真实平滑移动时接入测距或进度点位。'],
        target: { tab: 'mobile-devices' }, tags: ['平滑移动', '离散值']
    },
    {
        id: 'mobile-4', category: 'mobile',
        title: '移动设备的位置坐标应该用世界坐标还是产线坐标？',
        answer: '如果设备跟随某条产线或车间，优先使用与所属空间一致的本地坐标，便于整体移动和复制布局；跨车间或独立设备才需要特别确认世界坐标。页面中的坐标空间必须和建模配置一致。',
        steps: ['确认设备所属车间和产线。', '选择与产线布局一致的坐标空间。', '用一个已知停靠点校验坐标方向。'],
        target: { tab: 'mobile-devices' }, tags: ['世界坐标', '本地坐标']
    },
    {
        id: 'mobile-5', category: 'mobile',
        title: '移动设备延迟很高怎么优化？',
        answer: '移动设备只应订阅必要的位置和动作点位，收到新值后直接更新最新模型状态，不等待下一轮无关数据。平滑时间只是视觉过渡，不能弥补 PLC 数据本身延迟。',
        steps: ['降低移动位置点位的采集周期。', '避免重复绑定相同位置点位。', '把平滑时间设置为现场可接受的视觉过渡。', '对比 PLC 时间、后端时间和 Unity 显示时间。'],
        target: { tab: 'mobile-devices' }, tags: ['延迟', '优化']
    },
    {
        id: 'mobile-6', category: 'mobile',
        title: '移动设备到位后为什么还在移动？',
        answer: '可能是到位点位没有绑定、当前位置仍在变化、数据质量陈旧，或平滑时间尚未结束。先观察点位监视中的原始值和质量，再检查移动配置。',
        steps: ['查看当前位置和到位点位的实时值。', '确认到位状态的逻辑值和方向。', '检查是否仍有新的位置数据。', '必要时把平滑时间临时设为 0 验证。'],
        target: { tab: 'mobile-devices' }, tags: ['到位', '平滑']
    },
    {
        id: 'mobile-7', category: 'mobile',
        title: '没有连续测距值，页面上的“开始行动”还要不要配置？',
        answer: '可以配置。开始行动点位可以用于显示设备正在移动、触发提示或开始模拟过渡；但它不能凭空产生真实中间位置。没有连续值时，建议把说明写清楚，避免把动画当作测量结果。',
        steps: ['绑定开始行动或运行状态点位。', '把它用于状态显示或视觉提示。', '用当前位置编号决定最终停靠位置。'],
        target: { tab: 'mobile-devices' }, tags: ['开始行动', '状态']
    },

    {
        id: 'data-1', category: 'data',
        title: '数据库和 PLC 数据有什么区别？',
        answer: 'PLC 数据是现场实时采集链路，适合设备状态、温度、位置和报警；数据库数据是业务只读数据，适合批次、产量、能耗、质量和历史记录。两者可以同时用于同一张大屏，但来源和刷新策略不同。',
        steps: ['设备实时状态绑定 PLC 点位。', '批次和统计组件绑定外部只读数据库。', '在组件里明确标记数据来源和更新时间。'],
        target: { tab: 'settings', settingsSubpage: 'database' }, tags: ['数据库', 'PLC']
    },
    {
        id: 'data-2', category: 'data',
        title: '外部数据库连接测试成功，但组件没有数据？',
        answer: '连接成功只代表可以访问数据库，不代表查询契约、表名、字段、权限和筛选条件正确。还要检查组件绑定的连接、场景、设备或产线筛选条件。',
        steps: ['在数据库设置重新测试连接。', '查看业务数据契约或预览结果。', '检查组件绑定的 connectionId 和筛选范围。', '确认查询字段和时间范围有数据。'],
        target: { tab: 'settings', settingsSubpage: 'database' }, tags: ['数据库', '无数据']
    },
    {
        id: 'data-3', category: 'data',
        title: '备份应该备份什么？',
        answer: '建议备份数据库、模型资产、场景布局、组件发布版本和点位配置。只有数据库备份可能缺少上传的 GLB 文件；只有模型文件备份又无法恢复设备与点位关联。',
        steps: ['定期执行数据库备份。', '保留模型上传目录和元数据。', '导出或保存整站灾备包。', '恢复后检查模型 URL 和设备关联。'],
        target: { tab: 'settings', settingsSubpage: 'database' }, tags: ['备份', '恢复']
    },
    {
        id: 'data-4', category: 'data',
        title: '恢复备份后模型为什么仍然加载失败？',
        answer: '恢复数据库记录不一定恢复上传文件；如果模型文件目录没有一起恢复，记录中的 file_path 仍然会指向不存在的文件。恢复后要逐个检查模型资产的可访问性。',
        steps: ['检查恢复后的模型文件目录。', '在模型库批量查看预览状态。', '对 404 模型重新上传或修正路径。', '再恢复设备和大屏发布版本。'],
        target: { tab: 'models' }, tags: ['恢复', '模型文件']
    },
    {
        id: 'data-5', category: 'data',
        title: '为什么外部数据组件要标注“只读”？',
        answer: '外部数据库组件只负责读取业务数据，不应通过大屏修改生产业务数据。这样能降低误操作风险，也方便现场把大屏与排产、MES 或质量系统隔离。',
        steps: ['确认数据源连接使用只读账号。', '组件只配置查询和展示。', '需要修改业务数据时回到原业务系统操作。'],
        target: { tab: 'settings', settingsSubpage: 'database' }, tags: ['只读', '权限']
    },

    {
        id: 'performance-1', category: 'performance', popular: true,
        title: '大屏卡顿时，应该先调整哪些设置？',
        answer: '先减少同时显示的组件和动画，再降低渲染分辨率倍率，最后调整目标帧率和抗锯齿。不要一开始就把所有质量选项关掉，先找出是模型、组件还是数据刷新造成的压力。',
        steps: ['关闭不必要的高频组件和动画。', '降低渲染分辨率倍率。', '按设备能力选择平衡或性能档位。', '检查模型面数和纹理大小。'],
        target: { tab: 'settings', settingsSubpage: 'performance' }, tags: ['卡顿', '性能']
    },
    {
        id: 'performance-2', category: 'performance',
        title: '为什么组件悬停和选中特效看起来不流畅？',
        answer: '悬停和选中动画应该只改变局部 transform、阴影和边框，避免触发布局重排。当前系统已统一过渡时长和焦点样式；若设备较弱，优先减少同时悬停的复杂组件和大面积阴影。',
        steps: ['确认没有多个组件同时播放复杂动画。', '减少大面积模糊和阴影。', '检查浏览器缩放和窗口尺寸。', '在性能设置选择平衡档位。'],
        target: { tab: 'settings', settingsSubpage: 'performance' }, tags: ['悬停', '动画']
    },
    {
        id: 'performance-3', category: 'performance',
        title: '模型很多时如何减少加载时间？',
        answer: '让多个设备复用同一个模型资产，压缩纹理和几何，避免在同一视角加载大量高面数模型；同时确保资产 URL 不会反复 404。加载失败重试会比一次成功加载更慢。',
        steps: ['清理重复模型资产。', '压缩 GLB 和纹理。', '减少远景设备的细节。', '先修复全部 404 再评估性能。'],
        target: { tab: 'models' }, tags: ['模型性能', '加载']
    },
    {
        id: 'performance-4', category: 'performance',
        title: '历史趋势和实时数据刷新太频繁怎么办？',
        answer: '实时点位和趋势图不需要使用同一个刷新周期。趋势图可以按秒级或更长周期刷新，位置和报警等关键数据才需要更低延迟。组件越多，越要按业务重要性分层刷新。',
        steps: ['区分关键实时数据和统计数据。', '减少趋势图的点数和刷新频率。', '只让必要组件订阅实时点位。'],
        target: { tab: 'settings', settingsSubpage: 'performance' }, tags: ['趋势', '刷新频率']
    },
    {
        id: 'performance-5', category: 'performance',
        title: '大屏出现白边、毛边或锯齿怎么办？',
        answer: '白边可能来自窗口合成层和透明 WebView 边界，毛边通常和抗锯齿、分辨率倍率或纹理边缘有关。先区分是 UI 组件边缘还是 3D 模型边缘，再选择对应处理方式。',
        steps: ['截图记录出现位置和触发操作。', 'UI 边缘问题先刷新页面并检查缩放。', '模型边缘问题调整抗锯齿和渲染倍率。', '持续出现时记录具体模型和视角。'],
        target: { tab: 'settings', settingsSubpage: 'performance' }, tags: ['白边', '锯齿']
    },
    {
        id: 'performance-6', category: 'performance',
        title: '什么时候应该关闭抗锯齿？',
        answer: '当设备 GPU 性能有限、模型数量较多或窗口分辨率很高时，可以关闭抗锯齿换取帧率。若主要问题是 UI 文本或模型边缘质量，先尝试降低分辨率倍率而不是盲目关闭。',
        steps: ['先在平衡档位观察帧率。', '仍卡顿再关闭抗锯齿。', '保存后刷新大屏，对比设备和文字清晰度。'],
        target: { tab: 'settings', settingsSubpage: 'performance' }, tags: ['抗锯齿', 'GPU']
    },
    {
        id: 'performance-7', category: 'performance',
        title: '如何判断问题在前端、后端还是 Unity？',
        answer: '前端问题通常表现为按钮、布局、搜索或组件交互异常；后端问题表现为接口失败、保存失败、404 或数据库连接失败；Unity 问题表现为场景、模型、相机或原生窗口不更新。看状态条和错误文本比反复刷新更有效。',
        steps: ['先查看页面是否有明确错误提示。', '再看顶部 Unity、设备和数据连接状态。', '最后对照后端接口和模型 URL。'],
        target: { tab: 'point-monitor' }, tags: ['定位问题', '诊断']
    },

    {
        id: 'troubleshooting-1', category: 'troubleshooting', popular: true,
        title: '保存按钮点击后没有任何反应怎么办？',
        answer: '新版保存按钮会显示“保存中…”、成功或失败提示。如果没有变化，先确认页面是否仍在响应、后台会话是否已锁定，以及按钮是否被其他透明层遮挡。',
        steps: ['观察按钮文字是否改变。', '查看顶部后台锁定状态。', '打开浏览器控制台或后端日志确认请求。', '刷新页面后重新登录再保存。'],
        target: { tab: 'settings', settingsSubpage: 'security' }, tags: ['保存失败', '无反馈']
    },
    {
        id: 'troubleshooting-2', category: 'troubleshooting',
        title: '页面提示后台会话失效，未保存内容怎么办？',
        answer: '会话失效后，后端会拒绝需要权限的写入请求。先把当前页面的配置内容记下或截图，再重新解锁；不要在未确认保存成功前关闭页面。',
        steps: ['记录当前修改内容。', '重新输入后台密码。', '重新打开目标页面并保存。', '看到成功提示后再离开。'],
        target: { tab: 'settings', settingsSubpage: 'security' }, tags: ['会话失效', '未保存']
    },
    {
        id: 'troubleshooting-3', category: 'troubleshooting',
        title: '接口返回 404 时，是前端坏了吗？',
        answer: '不一定。404 表示请求的资源在当前服务地址找不到，最常见于模型文件路径失效、接口路径版本不一致或请求到了错误端口。先看错误中的完整 URL 和资源类型。',
        steps: ['确认是模型 URL 还是 API URL。', '在当前服务地址直接访问该 URL。', '模型 404 就重新上传或修正资产。', 'API 404 则检查后端版本和路由。'],
        target: { tab: 'models' }, tags: ['404', '接口']
    },
    {
        id: 'troubleshooting-4', category: 'troubleshooting',
        title: '模型错误面板为什么只显示占位几何体？',
        answer: '这是为了保证场景可继续操作的回退策略。真实模型下载或解析失败时，系统会保留设备位置和标签，同时用错误面板显示原因。修复文件后刷新模型预览或重启 Unity 即可重新加载。',
        steps: ['查看错误面板里的设备和 URL。', '确认资源返回 200 且文件可解析。', '刷新页面或重新启动 Unity。'],
        target: { tab: 'models' }, tags: ['占位', '错误提示']
    },
    {
        id: 'troubleshooting-5', category: 'troubleshooting',
        title: '为什么页面看起来像加载了旧版本？',
        answer: '浏览器或 WebView 可能保留旧的 JS/CSS 缓存，也可能当前查看的是草稿而不是最新发布版本。先刷新页面，仍不一致时重启 Unity 客户端。',
        steps: ['点击窗口右上角刷新。', '确认当前大屏使用的是最新发布版本。', '关闭并重启 Unity 客户端。', '重新进入后台验证。'],
        target: { tab: 'platform', platformSubpage: 'designer' }, tags: ['缓存', '旧版本']
    },
    {
        id: 'troubleshooting-6', category: 'troubleshooting',
        title: '设备在线但点位一直没有值，应该查什么？',
        answer: '设备在线表示连接层可达，不代表每个点位地址和数据类型都正确。需要依次检查点位是否启用、地址是否正确、读取权限、数据类型、缩放和最后更新时间。',
        steps: ['进入点位监视确认点位状态。', '检查设备连接和协议参数。', '核对 PLC 端变量地址和类型。', '用一个已知稳定点位做对照。'],
        target: { tab: 'point-monitor' }, tags: ['在线无值', '点位']
    },
    {
        id: 'troubleshooting-7', category: 'troubleshooting',
        title: '页面按钮点击不动或拖拽失效怎么办？',
        answer: '常见原因是被透明覆盖层拦截、组件处于只读/锁定状态，或 3D 画布的指针事件抢走了操作。先看按钮是否禁用，再检查当前是否在错误面板、弹窗或编辑器覆盖层中。',
        steps: ['确认后台没有锁定、按钮没有置灰。', '把鼠标移动到目标控件内部再操作。', '关闭弹窗或错误面板后重试。', '刷新页面清理旧的覆盖层状态。'],
        target: { tab: 'composer' }, tags: ['拖拽', '点击无效']
    },
    {
        id: 'troubleshooting-8', category: 'troubleshooting',
        title: '什么时候应该联系开发人员，而不是继续刷新？',
        answer: '如果同一个明确错误在重启后仍然出现，或者数据、模型和配置已经确认正确但运行态仍异常，就应该保留错误文本、时间、设备 ID、模型 URL 和复现步骤交给开发人员。单纯反复刷新会丢失现场信息。',
        steps: ['复制完整错误文本和 URL。', '记录设备、点位、模型 ID 和发生时间。', '说明从哪个页面、点击什么动作后出现。', '附上必要截图和后端日志。'],
        target: { tab: 'point-monitor' }, tags: ['反馈问题', '日志']
    }
]

const popularArticles = computed(() => articles.filter(article => article.popular).slice(0, 6))
const normalizedQuery = computed(() => searchQuery.value.trim().toLowerCase())
const filteredArticles = computed(() => {
    const query = normalizedQuery.value
    return articles.filter(article => {
        const inCategory = activeCategory.value === 'all' || article.category === activeCategory.value
        if (!inCategory) return false
        if (!query) return true
        const searchable = [article.title, article.answer, ...(article.steps || []), ...(article.tags || [])].join(' ').toLowerCase()
        return searchable.includes(query)
    })
})
const activeCategoryLabel = computed(() => categories.find(item => item.id === activeCategory.value)?.label || '全部问题')

function openGuide() {
    isOpen.value = true
    nextTick(() => searchInput.value?.focus())
}

function closeGuide() {
    isOpen.value = false
}

function toggleArticle(id) {
    expandedId.value = expandedId.value === id ? '' : id
}

function chooseCategory(id) {
    activeCategory.value = id
    if (id !== 'all') searchQuery.value = ''
    const first = filteredArticles.value[0]
    if (first) expandedId.value = first.id
}

function choosePopular(article) {
    activeCategory.value = article.category
    searchQuery.value = ''
    expandedId.value = article.id
}

function openTarget(article) {
    if (!article.target) return
    emit('navigate', article.target)
    closeGuide()
}

function handleKeydown(event) {
    if (event.key === 'Escape' && isOpen.value) closeGuide()
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (!isOpen.value) openGuide()
        else nextTick(() => searchInput.value?.focus())
    }
}

onMounted(() => window.addEventListener('keydown', handleKeydown))
onUnmounted(() => window.removeEventListener('keydown', handleKeydown))
</script>

<template>
    <button type="button" class="help-guide-launch" title="打开系统常见问题向导" aria-label="打开系统常见问题向导" @click="openGuide">
        <span class="help-guide-launch-icon" aria-hidden="true">?</span>
        <span class="help-guide-launch-copy"><strong>系统向导</strong><small>常见问题与配置指引</small></span>
    </button>

    <Teleport to="body">
        <Transition name="help-guide-fade">
            <div v-if="isOpen" class="help-guide-backdrop" @click.self="closeGuide">
                <section class="help-guide-dialog" role="dialog" aria-modal="true" aria-labelledby="help-guide-title">
                    <header class="help-guide-header">
                        <div class="help-guide-title-wrap">
                            <span class="help-guide-brand-icon" aria-hidden="true">
                                <svg viewBox="0 0 24 24"><path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H20v16H7.5A2.5 2.5 0 0 0 5 21.5z"/><path d="M5 5.5v16M9 7h7M9 11h7M9 15h4"/></svg>
                            </span>
                            <div>
                                <div class="help-guide-eyebrow">DIGITAL TWIN SUPPORT</div>
                                <h2 id="help-guide-title">系统向导</h2>
                                <p>把现场配置、数据接入和大屏发布中的常见问题集中在这里。</p>
                            </div>
                        </div>
                        <div class="help-guide-header-actions">
                            <span class="help-guide-count">{{ articles.length }} 篇实用解答</span>
                            <button type="button" class="help-guide-close" aria-label="关闭系统向导" title="关闭" @click="closeGuide">×</button>
                        </div>
                    </header>

                    <div class="help-guide-search-area">
                        <label class="help-guide-search" for="help-guide-search-input">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></svg>
                            <input id="help-guide-search-input" ref="searchInput" v-model="searchQuery" type="search" placeholder="搜索问题，例如：模型 404、PLC、保存、闪屏…" autocomplete="off" />
                            <kbd>Ctrl K</kbd>
                        </label>
                        <div class="help-guide-popular" aria-label="热门问题">
                            <span>大家常问</span>
                            <button v-for="article in popularArticles" :key="article.id" type="button" @click="choosePopular(article)">{{ article.title }}</button>
                        </div>
                    </div>

                    <div class="help-guide-layout">
                        <aside class="help-guide-sidebar">
                            <div class="help-guide-sidebar-heading"><span>配置向导</span><small>按现场顺序</small></div>
                            <button v-for="step in wizardSteps" :key="step.number" type="button" class="help-guide-wizard-step" @click="emit('navigate', step.target); closeGuide()">
                                <span class="help-guide-wizard-number">{{ step.number }}</span>
                                <span><strong>{{ step.title }}</strong><small>{{ step.description }}</small></span>
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
                            </button>

                            <div class="help-guide-sidebar-heading help-guide-category-heading"><span>按主题找</span><small>{{ filteredArticles.length }} 条结果</small></div>
                            <nav class="help-guide-categories" aria-label="问题分类">
                                <button v-for="category in categories" :key="category.id" type="button" :class="{ active: activeCategory === category.id }" @click="chooseCategory(category.id)">
                                    <span class="help-guide-category-icon">{{ category.icon }}</span>
                                    <span>{{ category.label }}</span>
                                    <small v-if="category.id !== 'all'">{{ articles.filter(article => article.category === category.id).length }}</small>
                                </button>
                            </nav>
                        </aside>

                        <main class="help-guide-content">
                            <div class="help-guide-content-heading">
                                <div>
                                    <span class="help-guide-section-kicker">知识库 / {{ activeCategoryLabel }}</span>
                                    <h3>{{ normalizedQuery ? `搜索“${searchQuery}”的结果` : activeCategoryLabel }}</h3>
                                </div>
                                <span class="help-guide-result-count">{{ filteredArticles.length }} 个答案</span>
                            </div>

                            <div v-if="filteredArticles.length" class="help-guide-article-list">
                                <article v-for="(article, index) in filteredArticles" :key="article.id" class="help-guide-article" :class="{ expanded: expandedId === article.id }">
                                    <button type="button" class="help-guide-article-trigger" :aria-expanded="expandedId === article.id" @click="toggleArticle(article.id)">
                                        <span class="help-guide-article-index">{{ String(index + 1).padStart(2, '0') }}</span>
                                        <span class="help-guide-article-title"><strong>{{ article.title }}</strong><small>{{ article.tags?.slice(0, 3).join(' · ') }}</small></span>
                                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg>
                                    </button>
                                    <Transition name="help-guide-answer">
                                        <div v-if="expandedId === article.id" class="help-guide-answer">
                                            <p>{{ article.answer }}</p>
                                            <div v-if="article.steps?.length" class="help-guide-steps">
                                                <strong>建议这样处理</strong>
                                                <ol><li v-for="step in article.steps" :key="step">{{ step }}</li></ol>
                                            </div>
                                            <div class="help-guide-article-footer">
                                                <div class="help-guide-tags"><span v-for="tag in article.tags" :key="tag">{{ tag }}</span></div>
                                                <button v-if="article.target" type="button" class="help-guide-go-button" @click="openTarget(article)">打开相关配置 <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg></button>
                                            </div>
                                        </div>
                                    </Transition>
                                </article>
                            </div>
                            <div v-else class="help-guide-empty">
                                <span aria-hidden="true">⌕</span>
                                <h3>没有找到匹配的问题</h3>
                                <p>试试搜索“模型”“点位”“保存”“移动设备”或“Unity”。</p>
                                <button type="button" @click="searchQuery = ''; activeCategory = 'all'; expandedId = 'getting-started-1'">查看全部问题</button>
                            </div>
                        </main>
                    </div>

                    <footer class="help-guide-footer">
                        <span class="help-guide-footer-status"><i></i> 内容覆盖配置、模型、PLC、画面、移动设备和故障排查</span>
                        <span>按 <kbd>Esc</kbd> 关闭向导</span>
                    </footer>
                </section>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.help-guide-launch {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 5px 12px 5px 6px;
    border: 1px solid rgba(37, 99, 235, .24);
    border-radius: 11px;
    color: #194185;
    background: linear-gradient(135deg, #f8fbff 0%, #eaf2ff 100%);
    box-shadow: 0 5px 14px rgba(37, 99, 235, .09);
    cursor: pointer;
    font: inherit;
    text-align: left;
    transition: transform .18s cubic-bezier(.22,1,.36,1), border-color .18s ease, box-shadow .18s ease, background .18s ease;
}
.help-guide-launch:hover { transform: translateY(-1px); border-color: rgba(37, 99, 235, .48); background: linear-gradient(135deg, #ffffff 0%, #dceaff 100%); box-shadow: 0 9px 20px rgba(37, 99, 235, .16); }
.help-guide-launch:active { transform: translateY(0) scale(.985); }
.help-guide-launch:focus-visible, .help-guide-close:focus-visible, .help-guide-search input:focus-visible, .help-guide-article-trigger:focus-visible, .help-guide-go-button:focus-visible, .help-guide-wizard-step:focus-visible, .help-guide-categories button:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
.help-guide-launch-icon { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 9px; color: #fff; background: linear-gradient(145deg, #5b9bff 0%, #2563eb 65%, #1d4ed8 100%); font-size: 17px; font-weight: 800; box-shadow: 0 4px 9px rgba(37,99,235,.24); }
.help-guide-launch-copy { display: grid; gap: 1px; }
.help-guide-launch-copy strong { font-size: 12px; line-height: 1.2; }
.help-guide-launch-copy small { color: #667085; font-size: 10px; line-height: 1.2; }

.help-guide-backdrop { position: fixed; inset: 0; z-index: 2000; display: grid; place-items: center; padding: 24px; background: rgba(15, 23, 42, .42); backdrop-filter: blur(10px); }
.help-guide-dialog { width: min(1180px, 100%); height: min(820px, calc(100vh - 48px)); min-height: 520px; display: flex; flex-direction: column; overflow: hidden; color: #1d2939; background: #f7faff; border: 1px solid rgba(255,255,255,.72); border-radius: 22px; box-shadow: 0 30px 90px rgba(15,23,42,.28), 0 10px 30px rgba(37,99,235,.12); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif; }
.help-guide-header { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 25px 30px 21px; color: #f5f9ff; background: radial-gradient(circle at 78% -60%, rgba(110, 193, 255, .42), transparent 35%), linear-gradient(125deg, #172b47 0%, #123d6e 56%, #1d4ed8 100%); }
.help-guide-title-wrap { display: flex; align-items: center; gap: 15px; min-width: 0; }
.help-guide-brand-icon { width: 46px; height: 46px; flex: 0 0 46px; display: grid; place-items: center; border: 1px solid rgba(255,255,255,.28); border-radius: 14px; background: rgba(255,255,255,.13); box-shadow: inset 0 1px 0 rgba(255,255,255,.16), 0 9px 20px rgba(3,18,42,.18); }
.help-guide-brand-icon svg { width: 25px; height: 25px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.help-guide-eyebrow { color: #a9d5ff; font-size: 10px; font-weight: 800; letter-spacing: .14em; }
.help-guide-header h2 { margin: 4px 0 4px; color: #fff; font-size: 24px; line-height: 1; letter-spacing: -.02em; }
.help-guide-header p { margin: 0; color: rgba(228,241,255,.78); font-size: 12px; }
.help-guide-header-actions { display: flex; align-items: center; gap: 14px; flex: 0 0 auto; }
.help-guide-count { color: rgba(234,244,255,.78); font-size: 11px; }
.help-guide-close { width: 34px; height: 34px; display: grid; place-items: center; padding: 0; border: 1px solid rgba(255,255,255,.2); border-radius: 10px; color: #fff; background: rgba(255,255,255,.1); cursor: pointer; font-size: 24px; line-height: 1; transition: background .18s ease, transform .18s ease; }
.help-guide-close:hover { background: rgba(255,255,255,.22); transform: rotate(4deg); }
.help-guide-search-area { padding: 17px 30px 15px; background: #fff; border-bottom: 1px solid #e5edf6; }
.help-guide-search { height: 46px; display: flex; align-items: center; gap: 10px; max-width: 820px; padding: 0 12px; border: 1px solid #cbdaf0; border-radius: 12px; background: linear-gradient(180deg, #fbfdff 0%, #f4f8fd 100%); box-shadow: 0 5px 14px rgba(25, 65, 133, .06); }
.help-guide-search:focus-within { border-color: #60a5fa; box-shadow: 0 0 0 4px rgba(37,99,235,.1), 0 7px 18px rgba(37,99,235,.08); }
.help-guide-search svg { width: 19px; height: 19px; flex: 0 0 19px; fill: none; stroke: #5d7da4; stroke-width: 1.8; stroke-linecap: round; }
.help-guide-search input { min-width: 0; flex: 1; border: 0; outline: 0; color: #1d2939; background: transparent; font: inherit; font-size: 13px; }
.help-guide-search input::placeholder { color: #98a8bc; }
.help-guide-search kbd, .help-guide-footer kbd { padding: 3px 6px; border: 1px solid #d6e0ec; border-radius: 5px; color: #7c8ca1; background: #fff; font: 10px/1.1 Consolas, monospace; white-space: nowrap; }
.help-guide-popular { display: flex; align-items: center; gap: 8px; max-width: 100%; margin-top: 11px; overflow: auto; scrollbar-width: none; }
.help-guide-popular::-webkit-scrollbar { display: none; }
.help-guide-popular > span { flex: 0 0 auto; color: #7a8aa0; font-size: 11px; font-weight: 700; }
.help-guide-popular button { flex: 0 0 auto; padding: 5px 9px; border: 1px solid #e0e9f4; border-radius: 999px; color: #4c6d99; background: #f8fbff; cursor: pointer; font: inherit; font-size: 11px; transition: color .16s ease, border-color .16s ease, background .16s ease; }
.help-guide-popular button:hover { color: #1d4ed8; border-color: #93c5fd; background: #eff6ff; }
.help-guide-layout { min-height: 0; flex: 1; display: grid; grid-template-columns: 255px minmax(0, 1fr); }
.help-guide-sidebar { min-height: 0; padding: 21px 14px 17px 20px; overflow: auto; background: linear-gradient(180deg, #f4f8fd 0%, #eef4fb 100%); border-right: 1px solid #e2eaf3; scrollbar-width: thin; scrollbar-color: #bfd0e4 transparent; }
.help-guide-sidebar::-webkit-scrollbar, .help-guide-content::-webkit-scrollbar { width: 7px; }
.help-guide-sidebar::-webkit-scrollbar-thumb, .help-guide-content::-webkit-scrollbar-thumb { background: #bfd0e4; border-radius: 999px; }
.help-guide-sidebar-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 0 8px 9px; color: #243b5a; font-size: 12px; font-weight: 800; }
.help-guide-sidebar-heading small { color: #8a9bb0; font-size: 10px; font-weight: 500; }
.help-guide-wizard-step { width: 100%; display: grid; grid-template-columns: 28px minmax(0, 1fr) 14px; align-items: center; gap: 8px; padding: 8px; border: 1px solid transparent; border-radius: 10px; color: #536b88; background: transparent; cursor: pointer; text-align: left; transition: transform .16s ease, border-color .16s ease, background .16s ease, box-shadow .16s ease; }
.help-guide-wizard-step:hover { transform: translateX(2px); border-color: #d3e2f4; background: #fff; box-shadow: 0 5px 14px rgba(31,77,129,.06); }
.help-guide-wizard-number { width: 27px; height: 27px; display: grid; place-items: center; border-radius: 8px; color: #2563eb; background: #e2edff; font: 700 10px/1 Consolas, monospace; }
.help-guide-wizard-step strong, .help-guide-wizard-step small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.help-guide-wizard-step strong { color: #294769; font-size: 12px; }
.help-guide-wizard-step small { margin-top: 2px; color: #8495a9; font-size: 10px; }
.help-guide-wizard-step > svg { width: 13px; height: 13px; fill: none; stroke: #9db0c4; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.help-guide-category-heading { margin-top: 20px; }
.help-guide-categories { display: grid; gap: 3px; }
.help-guide-categories button { width: 100%; display: flex; align-items: center; gap: 8px; padding: 7px 8px; border: 1px solid transparent; border-radius: 8px; color: #61748d; background: transparent; cursor: pointer; font: inherit; font-size: 11px; text-align: left; transition: color .16s ease, border-color .16s ease, background .16s ease; }
.help-guide-categories button:hover { color: #2457a6; background: rgba(255,255,255,.7); }
.help-guide-categories button.active { color: #174ea6; border-color: #c7dcfa; background: linear-gradient(135deg, #fff 0%, #e8f1ff 100%); box-shadow: 0 4px 10px rgba(37,99,235,.08); font-weight: 700; }
.help-guide-category-icon { width: 21px; color: #6684a8; font: 700 9px/1 Consolas, monospace; text-align: center; }
.help-guide-categories button.active .help-guide-category-icon { color: #2563eb; }
.help-guide-categories button small { margin-left: auto; color: #9aaabd; font-size: 10px; }
.help-guide-content { min-height: 0; padding: 24px 30px 24px 28px; overflow: auto; background: #fbfdff; scrollbar-width: thin; scrollbar-color: #bfd0e4 transparent; }
.help-guide-content-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin-bottom: 16px; }
.help-guide-section-kicker { color: #6684a8; font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.help-guide-content h3 { margin: 5px 0 0; color: #213754; font-size: 21px; letter-spacing: -.02em; }
.help-guide-result-count { flex: 0 0 auto; padding: 6px 9px; border-radius: 999px; color: #3870bb; background: #eaf2ff; font-size: 11px; font-weight: 700; }
.help-guide-article-list { display: grid; gap: 10px; }
.help-guide-article { overflow: hidden; border: 1px solid #e1eaf4; border-radius: 13px; background: #fff; box-shadow: 0 4px 14px rgba(33,55,84,.035); transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease; }
.help-guide-article:hover { border-color: #c8dcf4; box-shadow: 0 8px 22px rgba(33,83,145,.08); }
.help-guide-article.expanded { border-color: #a9c8ef; box-shadow: 0 10px 27px rgba(37,99,235,.1); }
.help-guide-article-trigger { width: 100%; display: grid; grid-template-columns: 31px minmax(0, 1fr) 20px; align-items: center; gap: 11px; padding: 15px 16px; border: 0; color: #294769; background: transparent; cursor: pointer; font: inherit; text-align: left; }
.help-guide-article-index { color: #7ba2d1; font: 700 10px/1 Consolas, monospace; }
.help-guide-article-title { min-width: 0; display: grid; gap: 5px; }
.help-guide-article-title strong { color: #243f61; font-size: 13px; line-height: 1.4; }
.help-guide-article-title small { overflow: hidden; color: #91a1b4; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.help-guide-article-trigger > svg { width: 17px; height: 17px; fill: none; stroke: #88a0ba; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; transition: transform .2s ease, stroke .2s ease; }
.help-guide-article.expanded .help-guide-article-trigger > svg { transform: rotate(180deg); stroke: #2563eb; }
.help-guide-answer { padding: 0 16px 16px 58px; color: #60738b; }
.help-guide-answer > p { margin: 0 0 14px; color: #61748d; font-size: 12px; line-height: 1.8; }
.help-guide-steps { padding: 12px 13px; border: 1px solid #e1ecfa; border-radius: 10px; background: linear-gradient(135deg, #f7fbff 0%, #edf5ff 100%); }
.help-guide-steps > strong { color: #2b5f9e; font-size: 11px; }
.help-guide-steps ol { display: grid; gap: 6px; margin: 8px 0 0; padding-left: 20px; color: #61748d; font-size: 11px; line-height: 1.55; }
.help-guide-steps li::marker { color: #3b82f6; font-weight: 700; }
.help-guide-article-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; }
.help-guide-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.help-guide-tags span { padding: 4px 7px; border-radius: 999px; color: #6480a2; background: #f1f5fa; font-size: 10px; }
.help-guide-go-button { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; padding: 7px 10px; border: 1px solid #b9d2f3; border-radius: 8px; color: #2457a6; background: #f7fbff; cursor: pointer; font: inherit; font-size: 11px; font-weight: 700; transition: color .16s ease, background .16s ease, border-color .16s ease, transform .16s ease; }
.help-guide-go-button:hover { transform: translateY(-1px); color: #fff; border-color: #2563eb; background: linear-gradient(135deg, #4f8df7, #1d4ed8); }
.help-guide-go-button svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.help-guide-empty { min-height: 320px; display: grid; place-content: center; justify-items: center; padding: 30px; text-align: center; }
.help-guide-empty > span { color: #77a4d7; font-size: 43px; line-height: 1; }
.help-guide-empty h3 { margin: 12px 0 6px; font-size: 17px; }
.help-guide-empty p { margin: 0 0 16px; color: #8293a8; font-size: 12px; }
.help-guide-empty button { padding: 8px 12px; border: 1px solid #b9d2f3; border-radius: 8px; color: #2457a6; background: #f7fbff; cursor: pointer; font: inherit; font-size: 12px; }
.help-guide-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 30px; color: #8a9bb0; background: #fff; border-top: 1px solid #e5edf6; font-size: 10px; }
.help-guide-footer-status { display: inline-flex; align-items: center; gap: 7px; }
.help-guide-footer-status i { width: 7px; height: 7px; border-radius: 50%; background: #12b76a; box-shadow: 0 0 0 4px rgba(18,183,106,.1); }
.help-guide-fade-enter-active, .help-guide-fade-leave-active { transition: opacity .2s ease; }
.help-guide-fade-enter-active .help-guide-dialog, .help-guide-fade-leave-active .help-guide-dialog { transition: transform .24s cubic-bezier(.22,1,.36,1), opacity .2s ease; }
.help-guide-fade-enter-from, .help-guide-fade-leave-to { opacity: 0; }
.help-guide-fade-enter-from .help-guide-dialog, .help-guide-fade-leave-to .help-guide-dialog { opacity: 0; transform: translateY(12px) scale(.985); }
.help-guide-answer-enter-active, .help-guide-answer-leave-active { transition: opacity .18s ease, transform .18s ease; }
.help-guide-answer-enter-from, .help-guide-answer-leave-to { opacity: 0; transform: translateY(-5px); }

@media (max-width: 900px) {
    .help-guide-backdrop { padding: 12px; }
    .help-guide-dialog { height: calc(100vh - 24px); }
    .help-guide-layout { grid-template-columns: 205px minmax(0, 1fr); }
    .help-guide-header, .help-guide-search-area, .help-guide-content { padding-left: 20px; padding-right: 20px; }
    .help-guide-footer { padding-left: 20px; padding-right: 20px; }
}
@media (max-width: 1380px) {
    .help-guide-launch-copy { display: none; }
    .help-guide-launch { padding-right: 6px; }
}
@media (max-width: 680px) {
    .help-guide-launch-copy { display: none; }
    .help-guide-launch { padding-right: 6px; }
    .help-guide-header { align-items: flex-start; padding: 18px; }
    .help-guide-header h2 { font-size: 20px; }
    .help-guide-header p, .help-guide-count { display: none; }
    .help-guide-layout { display: flex; flex-direction: column; }
    .help-guide-sidebar { flex: 0 0 auto; max-height: 190px; padding: 12px 14px; border-right: 0; border-bottom: 1px solid #e2eaf3; }
    .help-guide-sidebar-heading, .help-guide-wizard-step { display: none; }
    .help-guide-category-heading { display: flex; margin-top: 0; }
    .help-guide-categories { display: flex; flex-wrap: wrap; gap: 5px; }
    .help-guide-categories button { width: auto; padding: 6px 8px; }
    .help-guide-categories button small { display: none; }
    .help-guide-content { padding: 18px 14px; }
    .help-guide-content h3 { font-size: 18px; }
    .help-guide-answer { padding-left: 16px; }
    .help-guide-article-footer { align-items: flex-start; flex-direction: column; }
    .help-guide-footer { display: none; }
}
@media (prefers-reduced-motion: reduce) {
    .help-guide-launch, .help-guide-dialog, .help-guide-article, .help-guide-wizard-step, .help-guide-go-button, .help-guide-article-trigger > svg { transition: none; }
}
</style>
