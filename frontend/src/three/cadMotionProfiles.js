// Built-in simulation actions. These IDs are not commissioned PLC point addresses.
import {MULTIPURPOSE_CYCLE_DURATION} from './multipurposeProcess.js'
const action = (id,label,detail,duration=8) => ({id,label,detail,duration})
export const CAD_MOTION_PROFILES = {
    cad_tempering_furnace_091300: {prefix:'cad_tempering_furnace_v1_',actions:[
        action('door','回火炉门开启 / 关闭','门板和滑架同步升降，导轨、链轮架及驱动外壳固定。'),
        action('circulation','循环风机运转','炉内八片叶轮和传动轴绕各自轴心转动，电机与风罩固定。'),
        action('rollers','炉内辊道运转','七根辊筒绕横向轴心转动，轴承座和炉体保持固定。'),
        action('heating','回火加热与热风循环','加热管发光并带动循环叶轮，演示加热和均温过程。')
    ]},
    cad_multipurpose_furnace_082000: {prefix:'cad_multipurpose_furnace_600_v1_',actions:[
        {...action('process_cycle','完整工艺循环','进前室 → 开中门进后室 → 加工 → 返回前室 → 下降油淬 → 升起沥油 → 拉出料盘。',MULTIPURPOSE_CYCLE_DURATION),preserveDuration:true},
        action('door','前室门开启 / 关闭','门板和滑架同步升降，导轨和驱动外壳固定。'),
        action('gate','中间隔热门开启 / 关闭','隔热门升降，让开冷热室之间的移料通道。'),
        action('basket_down','承料架下降淬火','统一送料面后，承料架演示下降 800 mm 再返回，淬火槽保持固定。'),
        action('basket_up','承料架升起沥油','升起后显示琥珀色油珠和黏稠拉丝，油滴稀疏回落至油槽并逐渐减少。'),
        action('circulation','热室循环叶轮','仅循环叶轮和转轴旋转，罩壳与电机定子固定。'),
        action('agitator','淬火双搅拌叶轮','两个叶轮绕各自轴心旋转，搅拌电机及槽盖固定。'),
        action('hot_rollers','热室辊道运转','七根辊筒绕各自轴心旋转，轴承座保持固定。'),
        action('internal_transfer','冷热室内移料','隔门开启后显示工件在前室与热室之间移动。'),
        action('heating','加热与热风循环','辐射管发光及循环叶轮运转为加热过程示意。')
    ]},
    cad_transfer_cart_101300: {prefix:'cad_transfer_cart_v1_',actions:[
        action('travel','料车往返行走','车体平移，行走轮按轮径同步滚动。'),
        action('feed','推料伸出 / 退回','抓钩通过连接销接住中间导槽内的送料链；送料链接入后方链条盒，与链轮同步进退，带动抓钩往返。'),
        action('hook','推拉钩脱开 / 勾合','钩头绕横向轴翻转，演示脱开与勾合；实际角度及信号需现场标定。'),
        action('rollers','承料辊转动','仅辊轴和辊筒转动，支架及轴承座保持固定。')
    ]},
    cad_lifting_load_table_111400: {prefix:'cad_lifting_staging_table_v1_',actions:[
        action('lift_up','备料台上升 / 回位','剪叉按定长杆件运动，平台及液压杆同步随动。'),
        action('lift_down','备料台下降 / 回位','底座固定，剪叉收拢，平台下降后返回原位。'),
        action('rollers','承料辊转动','辊筒绕各自轴心转动，平台固定。')
    ]},
    cad_fixed_load_table_112200: {prefix:'cad_fixed_staging_table_v1_',actions:[
        action('rollers','承料辊滚动','模拟物料通过时的辊筒滚动，固定台架不移动。')
    ]},
    cad_air_cooling_table_115800ht: {prefix:'cad_air_cooling_table_v1_',actions:[
        action('door','风冷门关闭 / 打开','升降门和滑架同步运动，门导轨固定。'),
        action('fans','双风机运转','仅风机叶片和转轴转动，电机壳、防护网固定。'),
        action('rollers','承料辊转动','辊道支架固定，辊筒绕各自轴心转动。')
    ]},
    cad_cleaner_170700: {prefix:'cad_washing_machine_v1_',actions:[
        action('door','清洗门开启 / 关闭','门板和滑架同步升降，导轨及驱动外壳固定。'),
        action('pumps','循环泵运转','可见轴端转动，泵壳固定；不旋转整个泵组。'),
        {...action('basket_down','料盘下降浸洗','下方碱水槽常驻满液；料盘与承料辊台同步下降，物料完全浸入碱液。'),oneWay:true},
        {...action('basket_up','料盘升起出水','浸洗后料盘与承料辊台从碱水槽升回进出料高度，再进行喷清水。'),oneWay:true},
        action('spray','喷清水','料盘升出碱水槽后，在上位按实际喷嘴位置喷清水漂洗，泵轴随动。')
    ]},
    cad_water_cooling_tank_471000: {prefix:'cad_water_cooling_tank_v1_',actions:[
        action('door','前门开启 / 关闭','门板和滑架同步升降，导轨固定。'),
        action('basket_down','承料架下降入水','统一送料面后，承料架按 850 mm 演示行程下降，然后回位。'),
        action('basket_up','承料架升起沥水','由下位升起承料架，显示回落水滴。'),
        action('agitator','循环搅拌','仅搅拌轴和叶片转动，电机壳固定。'),
        action('fill','注水','水槽工作液位上升。'),
        action('drain','排水','水槽液位下降，显示排水流向。')
    ]}
}
export function cadMotionActions(modelId) {return CAD_MOTION_PROFILES[modelId]?.actions || []}
export function cadMotionFrame(modelId,actionId,time) {
    const action=cadMotionActions(modelId).find(a=>a.id===actionId)
    if(!action)throw Error('未知的 CAD 演示动作')
    const elapsed=Math.max(0,Math.min(action.duration,Number(time)||0))
    return {id:action.id,elapsed,progress:elapsed/action.duration,amount:action.oneWay?elapsed/action.duration:Math.sin(Math.PI*elapsed/action.duration)**2,complete:elapsed>=action.duration}
}
