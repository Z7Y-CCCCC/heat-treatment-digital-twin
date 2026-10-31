import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMotionPreset, setMotionTarget, advanceMotion, bindingSampleUsable } from '../src/three/bindingMotion.js';
const require = createRequire(import.meta.url);
const { normalizeModelMetadata } = require('../../backend/services/modelAssetMetadata.js');

test('door signal moves at constant speed, reverses in flight and clamps to the endpoint', () => {
    const binding = createMotionPreset('door');
    const state = {};
    assert.equal(setMotionTarget(state, 0, 3), 0);
    setMotionTarget(state, 1.5, 3);
    assert.equal(advanceMotion(state, binding, 1), .5);
    // Repeated PLC samples must not restart the animation.
    setMotionTarget(state, 1.5, 3);
    assert.equal(advanceMotion(state, binding, 1), 1);
    setMotionTarget(state, 0, 3);
    assert.equal(advanceMotion(state, binding, .5), .75);
    state.suspended = true;
    assert.equal(advanceMotion(state, binding, 20), .75);
    state.suspended = false;
    assert.equal(advanceMotion(state, binding, 20), 0);
    assert.equal(setMotionTarget({}, 1.5, 3), 1.5, 'initial acquisition uses observed pose');
});
test('metadata preserves bounded timing and legacy continuous following', () => {
    const bindings = normalizeModelMetadata({partBindings:[{}, {transition_duration: 3}, {transition_duration: -1}, {transition_duration: 100}]}).partBindings;
    assert.deepEqual(bindings.map(b => b.transition_duration), [0,3,0,60]);
    const state = {offset: 0};
    assert.equal(setMotionTarget(state, 0.42, 0), .42);
    assert.equal(createMotionPreset('valve').action, 'rotate_angle');
    assert.equal(createMotionPreset('material').action, 'visibility');
});
test('only the bound point and device quality gate motion', () => {
    const binding = {source_group:'doors', source_key:'front_door_open'};
    const frame = {doors:{front_door_open:true}, quality:{doors:{front_door_open:'good'}, analog:{temperature:'bad'}}};
    assert.equal(bindingSampleUsable(frame,binding),true);
    frame.quality.doors.front_door_open = 'stale';
    assert.equal(bindingSampleUsable(frame,binding),false);
    frame.quality.doors.front_door_open = 'good';
    frame.status = {online:false};
    assert.equal(bindingSampleUsable(frame,binding),false);
    frame.status = {quality:'bad'};
    assert.equal(bindingSampleUsable(frame,binding),false);
    assert.equal(bindingSampleUsable({doors:frame.doors},binding),true,'legacy frames remain compatible');
});
