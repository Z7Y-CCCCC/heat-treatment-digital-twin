'use strict';
// Pure in-memory fixture: no getDb(), backend process, HTTP, PLC or Unity.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    actionsForModel, isRetiredMotionAction, validateDeviceAnimations, publicDeviceAnimations
} = require('../services/deviceAnimations');

const clone = value => JSON.parse(JSON.stringify(value));
const oldAction = { id:'clip:user_old_cycle', kind:'clip', label:'旧自定义动画', mode:'position', channels:['door:p'] };
const partAction = { id:'part:door', kind:'part', label:'炉门', mode:'position', channels:['door:p'] };
const point = { id:'point-door', device_id:'device', data_type:'BOOL', category:'doors', value_role:'door', name:'door', access_type:'READ' };
function oldBinding(patch = {}) {
    return { actionId:oldAction.id, enabled:true, pointId:'removed-point', dataItemId:'removed-data',
        trigger:{mode:'condition', operator:'eq', value:true, hysteresis:0}, inputMin:0, inputMax:1,
        invert:false, speed:1, transitionSeconds:.5, kind:'clip', mode:'position', clipId:'user_old_cycle',
        partId:'', sourceGroup:'doors', sourceKey:'removed-door', sourceFingerprint:'stored-source-fingerprint',
        extension:{archive:'must survive'}, ...patch };
}
function fixture(bindings = [oldBinding()]) {
    return { revision:'current-revision', device:{id:'device'}, model:{id:'fixture-model'},
        actions:[clone(oldAction),clone(partAction)], motionPackage:{archive:'not rewritten'},
        config:{version:1,staleMs:5000,bindings:clone(bindings)}, points:[clone(point)],
        catalog:{revision:'catalog-revision',items:[]}, datasets:[] };
}
const publicRows = loaded => publicDeviceAnimations(loaded).config.bindings;
const disableRow = loaded => ({ ...clone(publicRows(loaded)[0]), enabled:false });
const save = (loaded, bindings, revision = loaded.revision) => validateDeviceAnimations(loaded,
    {revision,config:{version:1,staleMs:5000,bindings}});
const ordinaryRow = () => ({actionId:partAction.id,enabled:true,pointId:point.id,inputMin:0,inputMax:1,
    invert:false,speed:1,transitionSeconds:.5});

test('retirement is the legacy custom prefix and exact complete-process clip, never ordinary parts or other clips', () => {
    assert.equal(isRetiredMotionAction(oldAction), true);
    assert.equal(isRetiredMotionAction({kind:'clip',id:'clip:process_cycle'}), true);
    for (const action of [null,{},partAction,{kind:'part',id:oldAction.id},{kind:'clip',id:'clip:door'},
        {kind:'part',id:'clip:process_cycle'},{kind:'clip',id:'clip:process_cycle_extra'},{kind:'clip',id:'part:user_door'},{kind:'clip',id:'user_old_cycle'},
        {kind:'clip',id:42}]) assert.equal(isRetiredMotionAction(action), false);
});

test('package and actions history remain readable without filtering or rewriting model metadata', () => {
    const model = {motion_package:{actions:[{id:'user_old_cycle',label:'旧动画',mode:'position',channels:['door:p']},
        {id:'door',label:'炉门',mode:'position',channels:['door:p']}]},
        metadata:{partBindings:[{id:'user_legitimate_part',name:'门',node_name:'door',action:'translate'}]}};
    const original = clone(model), actions = actionsForModel(model);
    assert.deepEqual(actions.map(action => action.id), ['clip:user_old_cycle','clip:door','part:user_legitimate_part']);
    assert.deepEqual(model, original);
    const loaded = fixture(); assert.ok(publicDeviceAnimations(loaded).actions.some(isRetiredMotionAction));
    assert.deepEqual(loaded.motionPackage,{archive:'not rewritten'});
});

test('an existing enabled retired clip cannot be submitted enabled, including an otherwise unchanged payload', () => {
    const loaded = fixture(), original = clone(loaded);
    assert.throws(() => save(loaded,publicRows(loaded)), /旧自定义动画.*不能再启用/);
    assert.deepEqual(loaded,original);
});

test('newly activating a retired clip is rejected and an unconfigured disabled default is never stored', () => {
    const loaded = fixture([]), row = { ...ordinaryRow(),actionId:oldAction.id };
    assert.throws(() => save(loaded,[row]), /旧自定义动画.*不能再启用/);
    assert.deepEqual(save(loaded,[{...row,enabled:false}]).bindings,[]);
    assert.deepEqual(loaded.config.bindings,[]);
});

test('explicit disable changes only enabled and preserves every stored private/archive field without mutation', () => {
    const loaded = fixture(), original = clone(loaded), row = disableRow(loaded), beforeBody = clone(row);
    const result = save(loaded,[row]);
    assert.deepEqual(result.bindings,[{...original.config.bindings[0],enabled:false}]);
    assert.deepEqual(row,beforeBody); assert.deepEqual(loaded,original);
    result.bindings[0].extension.archive = 'changed-return-value';
    result.bindings[0].trigger.value = false;
    assert.deepEqual(loaded,original,'returned nested history is detached from the loaded database snapshot');
});

test('disable does not resolve lost sources or revalidate old numeric/trigger metadata', () => {
    const loaded = fixture([oldBinding({inputMin:null,inputMax:null,speed:null,transitionSeconds:null,
        trigger:{mode:'condition',operator:'eq',value:'old text',hysteresis:0}})]), row = disableRow(loaded);
    for (const key of ['catalog','points','datasets']) Object.defineProperty(loaded,key,{get(){throw Error(`old ${key} source must not be read`);}});
    const result = save(loaded,[row]);
    assert.equal(result.bindings[0].enabled,false);
    assert.equal(result.bindings[0].dataItemId,'removed-data');
    assert.equal(result.bindings[0].sourceFingerprint,'stored-source-fingerprint');
    assert.equal(result.bindings[0].inputMin,null);
    assert.equal(result.bindings[0].trigger.value,'old text');
});

test('a disabled retired clip does not occupy a channel needed by a valid current part binding', () => {
    const loaded = fixture(), result = save(loaded,[disableRow(loaded),ordinaryRow()]);
    assert.equal(result.bindings[0].enabled,false);
    assert.equal(result.bindings[1].enabled,true);
    assert.equal(result.bindings[1].kind,'part');
    assert.equal(result.bindings[1].pointId,point.id);
    assert.equal(result.bindings[1].sourceGroup,'doors');
    assert.equal(result.bindings[1].sourceKey,'door');
});

test('retired and current rows cannot avoid retirement by reversing validation order', () => {
    const loaded = fixture(), retired = publicRows(loaded)[0];
    assert.throws(() => save(loaded,[ordinaryRow(),retired]), /旧自定义动画.*不能再启用/);
    assert.throws(() => save(loaded,[retired,ordinaryRow()]), /旧自定义动画.*不能再启用/);
});

test('a previously disabled retired binding cannot be reactivated', () => {
    const loaded = fixture([oldBinding({enabled:false})]), row = publicRows(loaded)[0];
    assert.throws(() => save(loaded,[{...row,enabled:true}]), /旧自定义动画.*不能再启用/);
    assert.deepEqual(save(loaded,[row]).bindings,loaded.config.bindings);
});

test('disabled history cannot be retargeted or have technical fields edited', () => {
    const loaded = fixture(), row = disableRow(loaded);
    for (const patch of [{pointId:point.id},{dataItemId:'different-data'},{inputMin:-1},{inputMax:2},
        {invert:true},{speed:2},{transitionSeconds:0},{trigger:{...row.trigger,value:false}}])
        assert.throws(() => save(loaded,[{...clone(row),...patch}]), /只允许停用.*历史绑定字段/);
    const missing = clone(row); delete missing.trigger;
    assert.throws(() => save(loaded,[missing]), /只允许停用.*历史绑定字段/);
    assert.throws(() => save(loaded,[{...row,sourceFingerprint:'injected'}]), /动作配置无效/);
});

test('endpoint history compares public data selections but retains hidden resolved feedback metadata', () => {
    const trigger = {mode:'endpoints',extended:{dataItemId:'old-extended',pointId:'old-point-a',sourceGroup:'mechanisms',
        sourceKey:'extended',sourceFingerprint:'old-fingerprint-a'},retracted:{dataItemId:'old-retracted',pointId:'old-point-b',
        sourceGroup:'mechanisms',sourceKey:'retracted',sourceFingerprint:'old-fingerprint-b'}};
    const loaded = fixture([oldBinding({pointId:'',dataItemId:'',trigger})]), row = disableRow(loaded);
    assert.deepEqual(row.trigger,{mode:'endpoints',extended:{dataItemId:'old-extended'},retracted:{dataItemId:'old-retracted'}});
    const result = save(loaded,[row]); assert.deepEqual(result.bindings[0].trigger,trigger);
    const changed = clone(row); changed.trigger.extended.dataItemId = 'new-extended';
    assert.throws(() => save(loaded,[changed]), /只允许停用.*历史绑定字段/);
    const injected = clone(row); injected.trigger.extended.pointId = 'forged-point';
    assert.throws(() => save(loaded,[injected]), /只允许停用.*历史绑定字段/);
});

test('legacy point-only history need not acquire a new dataItemId or trigger when disabled', () => {
    const stored = oldBinding(); delete stored.dataItemId; delete stored.trigger;
    const loaded = fixture([stored]), row = disableRow(loaded), result = save(loaded,[row]);
    assert.equal(Object.hasOwn(result.bindings[0],'dataItemId'),false);
    assert.equal(Object.hasOwn(result.bindings[0],'trigger'),false);
    assert.deepEqual(result.bindings[0],{...stored,enabled:false});
    assert.throws(() => save(loaded,[{...row,dataItemId:''}]), /只允许停用.*历史绑定字段/);
});

test('omitting an enabled retired row cannot silently keep it playing or delete its archive', () => {
    const loaded = fixture();
    assert.throws(() => save(loaded,[]), /仍有已启用.*显式停用/);
    assert.throws(() => save(loaded,[ordinaryRow()]), /仍有已启用.*显式停用/);
});

test('omitting an already disabled retired row preserves its definition while normal parts can save', () => {
    const loaded = fixture([oldBinding({enabled:false})]), original = clone(loaded.config.bindings[0]);
    const result = save(loaded,[ordinaryRow()]);
    assert.deepEqual(result.bindings.find(row => row.actionId === oldAction.id),original);
    assert.equal(result.bindings.find(row => row.actionId === partAction.id).enabled,true);
});

test('appending disabled archives cannot exceed the original one-hundred binding limit', () => {
    const archives = Array.from({length:100},(_,index) => oldBinding({
        actionId:`clip:user_archive_${index}`,clipId:`user_archive_${index}`,enabled:false
    }));
    const loaded = fixture(archives);
    assert.equal(save(loaded,[]).bindings.length,100);
    assert.throws(() => save(loaded,[ordinaryRow()]), /最多保留 100 项/);
    const allowed = fixture(archives.slice(0,99));
    assert.equal(save(allowed,[ordinaryRow()]).bindings.length,100);
    assert.deepEqual(loaded.config.bindings,archives,'a rejected oversized replacement cannot truncate archived history');
});

test('a stored retired clip can be disabled even if the old package action definition has disappeared', () => {
    const loaded = fixture(), row = disableRow(loaded); loaded.actions = [clone(partAction)];
    assert.deepEqual(save(loaded,[row]).bindings,[{...loaded.config.bindings[0],enabled:false}]);
    assert.throws(() => save(loaded,[{...row,enabled:true}]), /旧自定义动画.*不能再启用/);
    const empty = fixture([]); empty.actions = [clone(partAction)];
    assert.throws(() => save(empty,[{...ordinaryRow(),actionId:oldAction.id}]), /模型动作不存在/);
});

test('early public-shaped orphan history without kind can still be disabled, never recreated or reactivated', () => {
    const stored = clone(publicRows(fixture())[0]), loaded = fixture([stored]);
    loaded.actions = [clone(partAction)];
    const row = disableRow(loaded), result = save(loaded,[row]);
    assert.deepEqual(result.bindings,[{...stored,enabled:false}]);
    assert.equal(Object.hasOwn(result.bindings[0],'kind'),false,'stopping history cannot rewrite its technical shape');
    assert.throws(() => save(loaded,[{...row,enabled:true}]), /旧自定义动画.*不能再启用/);
    assert.throws(() => save(loaded,[]), /仍有已启用.*显式停用/);
    assert.throws(() => save(loaded,[{...row,pointId:point.id}]), /只允许停用.*历史绑定字段/);
    const empty = fixture([]); empty.actions = [clone(partAction)];
    assert.throws(() => save(empty,[{...row,enabled:false}]), /模型动作不存在/);
});

test('known part kinds cannot be retired through an orphan legacy namespace fallback', () => {
    const archivedPart = fixture([oldBinding({kind:'part'})]); archivedPart.actions = [clone(partAction)];
    assert.throws(() => save(archivedPart,[disableRow(archivedPart)]), /模型动作不存在/);
    const currentPart = fixture(); currentPart.actions = [{...partAction,id:oldAction.id}];
    const result = save(currentPart,[{...ordinaryRow(),actionId:oldAction.id}]);
    assert.equal(result.bindings[0].kind,'part');
    assert.equal(result.bindings[0].enabled,true);
});

test('part IDs that happen to contain user_ remain editable and keep the ordinary source validation', () => {
    const loaded = fixture([]); loaded.actions = [{...partAction,id:'part:user_door'}];
    const row = {...ordinaryRow(),actionId:'part:user_door'};
    assert.equal(save(loaded,[row]).bindings[0].enabled,true);
    assert.throws(() => save(loaded,[{...row,pointId:'removed-point'}]), /只读采集点位/);
});

test('CAS, duplicate rows, field whitelist and public source redaction still protect all saves', () => {
    const loaded = fixture(), row = disableRow(loaded);
    assert.throws(() => save(loaded,[row],'stale-revision'), cause => cause.statusCode === 409 && /已更新/.test(cause.message));
    assert.throws(() => save(loaded,[row,row]), /无效或重复/);
    assert.throws(() => save(loaded,[{...row,kind:'clip'}]), /无效或重复/);
    const publicRow = publicRows(loaded)[0];
    for (const field of ['kind','mode','clipId','partId','sourceGroup','sourceKey','sourceFingerprint','extension'])
        assert.equal(Object.hasOwn(publicRow,field),false);
    assert.deepEqual(loaded.config.bindings,[oldBinding()]);
});
