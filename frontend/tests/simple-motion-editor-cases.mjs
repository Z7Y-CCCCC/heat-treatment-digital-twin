import { canvasMotionBasis, simpleMotionDraft } from '../src/views/admin/utils/simpleMotionDraft.js'

// The old controls are deliberately retired, not hidden in an advanced pane.
// Replace their UI-edit assertions with migration/absence/CAS assertions. The
// backend and native legacy-protocol suites continue to exercise old runtime data.
export function registerSimpleMotionEditorCases({ test, assert, fixture, clone, originalMovement, sourceChoices, settled,
  parentMobileDraftSaver, installBrowser, discardFactoryDrafts, cacheFactoryDraft, saveFactoryDrafts, listFactoryDrafts }) {
  const retired = ['工位编号数据含义', '移动开始或实际移动反馈点位', '独立到位工位反馈点位', '移动数据过期阈值（毫秒）',
    '移动场景单位每米', '移动视觉平滑时间（毫秒）', '开启移动运动细节模拟', '切换简易工位显示', '移动轨道起始 X', '移动轨道基准 Y', '移动轨道参考终点 X']
  const signals = async f => {
    f.field('移动位置数值点位').fire('change', 'PLC_POS')
    f.field('PLC 到位 BOOL 信号').fire('change', 'PLC_RUN')
    await settled()
  }
  const importStations = async f => {
    const button = f.elements().find(row => row.type === 'button' && /^从当前产线导入/.test(row.text))
    assert.ok(button); button.fire('click'); await settled()
  }
  const simple = () => ({ ...originalMovement(), displayMode: 'simple', stationInputMeaning: 'target', arrivalSignalPointId: 'PLC_RUN',
    startActionPointId: '', arrivalSmoothing: true })

  for (const meaning of ['', 'current', 'target', 'last-confirmed', 'range', 'normalized']) {
    test(`only the simple form exists when opening legacy ${meaning || 'unspecified'} configuration; opening never writes data`, async t => {
      const old = originalMovement()
      if (['range', 'normalized'].includes(meaning)) old.valueMode = meaning
      else if (meaning) old.stationInputMeaning = meaning
      const f = await fixture(t, old), before = clone(f.saved.instance_config)
      assert.equal(f.vm.motion.displayMode, 'simple'); assert.equal(f.vm.motion.valueMode, 'station')
      assert.equal(f.vm.motion.stationInputMeaning, 'target')
      assert.equal(f.vm.motion.currentPositionPointId, meaning === 'target' ? 'PLC_POS' : '', 'never reinterpret a current/held/progress value as target')
      assert.equal(f.vm.motion.arrivalSignalPointId, '', 'never reinterpret the opposite-polarity moving bit as arrival')
      assert.equal(f.field('到位时平滑对齐').checked, true)
      for (const label of retired) assert.equal(f.elements().some(row => row.props['aria-label'] === label), false, label)
      assert.equal(f.elements().some(row => row.props.placeholder === '例如 8.5' || /高级兼容设置/.test(row.text)), false)
      assert.deepEqual(f.saved.instance_config, before); assert.equal(f.saves.length, 0)
      assert.deepEqual(clone(f.vm.motion.stations[0].position), before.movement.stations[0].position)
    })
  }

  test('two real fields and one-click canvas stations save without a single physical parameter; smoothing reopens either choice', async t => {
    const f = await fixture(t, null, { rails: [{ id: 'r', length: 60 }] }, sourceChoices())
    assert.equal(f.field('到位时平滑对齐').checked, true)
    assert.deepEqual(f.field('PLC 到位 BOOL 信号').options.map(row => row._value), ['', 'PLC_RUN'])
    await signals(f); f.vm.motion.enabled = true; await importStations(f); await f.save()
    assert.equal(f.saves.length, 1); const movement = f.saves[0].movement
    assert.equal(movement.displayMode, 'simple'); assert.equal(movement.arrivalSmoothing, true)
    assert.deepEqual(f.saves[0].pointIds, ['PLC_POS', 'PLC_RUN']); assert.equal(f.saves[0].expected, null)
    for (const key of ['maxSpeed', 'acceleration', 'sceneUnitsPerMeter', 'speedMode', 'smoothingMs', 'simulationEnabled', 'startActionPointId', 'arrivalPositionPointId']) assert.equal(Object.hasOwn(movement, key), false, key)
    assert.equal(Object.hasOwn(movement.stations[0], 'distanceMeters'), false)
    assert.deepEqual(movement.start, { x: -30, y: 0, z: 0 }); assert.deepEqual(movement.end, { x: 30, y: 0, z: 0 })
    assert.deepEqual(movement.stations[0].position, { x: -21, y: 0, z: 0 })
    await f.reopen(); assert.equal(f.field('到位时平滑对齐').checked, true)
    f.field('到位时平滑对齐').fire('change', false); await f.save(); await f.reopen()
    assert.equal(f.field('到位时平滑对齐').checked, false)
  })

  test('saving a migrated target retains exact station geometry, custom config, action bindings and original CAS baseline', async t => {
    const old = { ...originalMovement(), stationInputMeaning: 'target' }
    old.stations[0].position.x = 6.9999999999999964
    const f = await fixture(t, old), before = clone(f.saved.instance_config)
    await signals(f); await f.save()
    assert.equal(f.saves.length, 1); const saved = f.saves[0]
    assert.deepEqual(saved.expected, before.movement)
    assert.deepEqual(saved.movement.start, before.movement.start); assert.deepEqual(saved.movement.end, before.movement.end)
    assert.deepEqual(saved.movement.stations[0].position, before.movement.stations[0].position)
    assert.deepEqual(f.saved.instance_config.animationBindings, before.animationBindings)
    assert.deepEqual(f.saved.instance_config.custom, before.custom)
    assert.equal(Object.hasOwn(f.vm.motion, 'acceleration'), false)
  })

  test('old current number requires an explicit target selection and actual arrival BOOL before any save', async t => {
    const f = await fixture(t), before = clone(f.saved.instance_config)
    await f.save(); assert.equal(f.saves.length, 0); assert.match(f.vm.errorMessage, /目标工位/)
    f.field('移动位置数值点位').fire('change', 'PLC_POS'); await f.save()
    assert.equal(f.saves.length, 0); assert.match(f.vm.errorMessage, /到位 BOOL/)
    assert.deepEqual(f.saved.instance_config, before)
    f.field('PLC 到位 BOOL 信号').fire('change', 'PLC_RUN'); await f.save()
    assert.equal(f.saves.length, 1)
  })

  for (const invalid of ['PLC_COMMAND', 'PLC_WRITE', 'PLC_OTHER', 'missing']) {
    test(`simple form rejects invalid arrival ${invalid} atomically instead of guessing a source`, async t => {
      const f = await fixture(t, originalMovement(), undefined, sourceChoices()), before = clone(f.saved.instance_config)
      f.field('移动位置数值点位').fire('change', 'PLC_POS'); f.vm.motion.arrivalSignalPointId = invalid
      await f.save(); assert.equal(f.saves.length, 0); assert.match(f.vm.errorMessage, /只读 BOOL/)
      assert.deepEqual(f.saved.instance_config, before)
    })
  }

  test('stale migrated editor keeps its original CAS across remount; only explicit reread rebases its saved rail', async t => {
    const f = await fixture(t, { ...originalMovement(), stationInputMeaning: 'target' })
    await signals(f); f.vm.motion.stations[0].value = 8
    f.externallyShift(); const external = clone(f.saved.instance_config.movement)
    await f.save(); assert.match(f.vm.errorMessage, /已更新/); assert.deepEqual(f.saved.instance_config.movement, external)
    await f.reopen(); await f.save(); assert.match(f.vm.errorMessage, /已更新/)
    assert.equal(f.saves[1].expected.start.z, .5)
    f.field('放弃移动修改并重新读取配置').fire('click'); await settled()
    assert.equal(f.vm.motion.start.z, 3.5); await signals(f); await f.save()
    assert.equal(f.saves.at(-1).expected.start.z, 3.5)
  })

  test('historical draft without an original comparison snapshot cannot bypass CAS or reappear as the old form', async t => {
    const f = await fixture(t)
    cacheFactoryDraft('', 'mobile-motion:cart', 'mobile-motion', { deviceId: 'cart', motion: originalMovement() })
    await f.vm.loadDevice('cart'); await settled(); assert.equal(f.vm.motion.displayMode, 'simple'); await signals(f); await f.save()
    assert.equal(f.saves.length, 0); assert.match(f.vm.errorMessage, /快照/)
    f.field('放弃移动修改并重新读取配置').fire('click'); await settled(); await signals(f); await f.save()
    assert.equal(f.saves.length, 1)
  })

  test('invalid imported rail stays invalid; the only repair is an explicit read from the actual canvas, not manual coordinates or guesses', async t => {
    const old = { ...originalMovement(), start: { x: '', y: 0, z: .5 }, stations: [{ value: null, position: { x: -21, z: .5 } }] }
    const f = await fixture(t, old, { rails: [{ id: 'r', length: 40 }] }), before = clone(f.saved.instance_config)
    await signals(f); await f.save(); assert.equal(f.saves.length, 0); assert.match(f.vm.errorMessage, /轨道信息/)
    assert.equal(f.vm.motion.start.x, ''); assert.deepEqual(f.saved.instance_config, before)
    await importStations(f); await f.save(); assert.equal(f.saves.length, 1)
    assert.deepEqual(f.saves[0].movement.start, { x: -20, y: 0, z: 0 })
    assert.equal(f.saves[0].movement.stations[0].value, 1)
  })

  test('missing canvas rail does not create the former arbitrary ten-unit path', async t => {
    const f = await fixture(t, null); await signals(f); f.vm.motion.enabled = true
    await importStations(f); assert.match(f.vm.errorMessage, /画布.*导轨/); assert.equal(f.vm.motion.start.x, '')
    await f.save(); assert.equal(f.saves.length, 0)
  })

  test('canvas rail geometry supports a rotated workshop frame and preserves the cart calibration, without metres', () => {
    const device = { coordinate_space: 'workshop_local', pos_x: 9, pos_y: 2, pos_z: 20,
      lineLayout: { rails: [{ id: 'r', length: 20 }], transform: { x: 10, y: 0, z: 20, rotationY: 90 } }, instance_config: { railId: 'r' } }
    const basis = canvasMotionBasis(device)
    assert.ok(Math.abs(basis.start.x - 9) < 1e-9 && Math.abs(basis.end.x - 9) < 1e-9)
    assert.equal(basis.start.y, 2); assert.ok(Math.abs(Math.abs(basis.start.z - basis.end.z) - 20) < 1e-9)
    assert.throws(() => canvasMotionBasis({ ...device, lineLayout: { rails: [] } }), /导轨/)
    assert.throws(() => canvasMotionBasis({ ...device, pos_y: NaN }), /位置/)
    const legacy = simpleMotionDraft({ ...device, instance_config: { movement: { ...originalMovement(), stationInputMeaning: 'current' } } })
    assert.equal(legacy.currentPositionPointId, ''); assert.equal(legacy.arrivalSignalPointId, '')
  })

  test('factory-switch save blocks every retired cached mode and keeps its unsaved draft, rather than resurrecting the old editor', async t => {
    installBrowser(t); discardFactoryDrafts(''); t.after(() => discardFactoryDrafts(''))
    const writes = [], save = await parentMobileDraftSaver({ getDevice: async () => { throw Error('Must reject before any load') }, updateDeviceMovement: async (...args) => writes.push(args) })
    for (const valueMode of ['range', 'normalized', 'station']) for (const stationInputMeaning of ['', 'current', 'target', 'last-confirmed']) {
      const movement = { ...originalMovement(), valueMode, stationInputMeaning }
      const body = { deviceId: 'cart', motion: movement, devicePayload: { instance_config: { movement } }, expectedMovement: movement }
      cacheFactoryDraft('', 'mobile-motion:cart', 'mobile-motion', body)
      await assert.rejects(saveFactoryDrafts('', { 'mobile-motion': save }), /旧移动草稿已停用/)
      assert.equal(listFactoryDrafts('').length, 1); assert.equal(writes.length, 0)
    }
  })

  test('factory-switch simple save requires both sources, preserves CAS and does not request a distance or acceleration', async t => {
    installBrowser(t); discardFactoryDrafts(''); t.after(() => discardFactoryDrafts(''))
    const writes = [], latest = { id: 'cart', dataPoints: sourceChoices(), instance_config: { custom: 'keep' } }
    const save = await parentMobileDraftSaver({ getDevice: async () => clone(latest), updateDeviceMovement: async (...args) => { writes.push(args); return { success: true } } })
    const movement = simple(), expected = { old: 'exact CAS', start: { x: -20, y: 0, z: .5 } }
    await save({ deviceId: 'cart', motion: movement, devicePayload: { instance_config: { movement } }, selectedPointIds: ['PLC_POS', 'PLC_RUN'], expectedMovement: expected })
    assert.equal(writes.length, 1); assert.deepEqual(writes[0][3], expected); assert.deepEqual(latest.instance_config, { custom: 'keep' })
    for (const key of ['acceleration', 'maxSpeed', 'sceneUnitsPerMeter', 'simulationEnabled', 'startActionPointId']) assert.equal(Object.hasOwn(writes[0][1], key), false, key)
    assert.deepEqual(writes[0][2], ['PLC_POS', 'PLC_RUN'], 'old cached selected IDs must not alter unrelated point sampling')
    for (const arrivalSignalPointId of ['', 'PLC_COMMAND', 'PLC_WRITE', 'PLC_OTHER']) {
      const bad = { ...movement, arrivalSignalPointId }
      await assert.rejects(save({ deviceId: 'cart', motion: bad, devicePayload: { instance_config: { movement: bad } } }), /BOOL/)
    }
    assert.equal(writes.length, 1)
  })

  test('disabled fresh device can save without inventing a rail, station or signal', async t => {
    const f = await fixture(t, null); await f.save(); assert.equal(f.saves.length, 1)
    const saved = f.saves[0].movement
    assert.equal(saved.enabled, false); assert.equal(Object.hasOwn(saved, 'start'), false); assert.equal(saved.stations.length, 0)
    assert.equal(saved.currentPositionPointId, ''); assert.equal(saved.arrivalSignalPointId, '')
  })
}
