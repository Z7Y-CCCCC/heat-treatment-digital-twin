import test from 'node:test'
import assert from 'node:assert/strict'
import { colorChannels, effectiveWidgetBackground, updateWidgetBackground, updateWidgetBackgroundOpacity, widgetAppearanceVariables } from '../src/runtime/widgetAppearance.js'

test('background color and its opacity share one effective value instead of conflicting controls', () => {
  const style = {background:'rgba(9, 22, 35, .82)',backgroundOpacity:.12}
  assert.equal(effectiveWidgetBackground(style),'rgba(9, 22, 35, 0.12)')
  updateWidgetBackground(style,'rgba(20, 180, 80, .65)')
  assert.equal(style.backgroundOpacity,.65)
  assert.equal(effectiveWidgetBackground(style),'rgba(20, 180, 80, 0.65)')
  updateWidgetBackgroundOpacity(style,.3)
  assert.equal(style.background,'rgba(20, 180, 80, 0.3)')
  updateWidgetBackground(style,'transparent')
  assert.equal(style.backgroundOpacity,0)
  assert.equal(effectiveWidgetBackground(style),'rgba(88, 79, 137, 0)')
  updateWidgetBackground(style,'#1248ab')
  assert.equal(style.backgroundOpacity,1)
  assert.equal(effectiveWidgetBackground(style),'rgba(18, 72, 171, 1)')
  assert.deepEqual(colorChannels('#0f08'),{rgb:[0,255,0],alpha:136/255})
  assert.deepEqual(colorChannels('#10203080'),{rgb:[16,32,48],alpha:128/255})
})

test('authored zero radius/padding survive and active conditions override only their own colors', () => {
  const style = {borderColor:'#123456',borderRadius:0,padding:0,fontSize:28,color:'#aa3366'}
  const base = widgetAppearanceVariables(style)
  assert.equal(base['--widget-radius'],'0px')
  assert.equal(base['--widget-padding'],'0px')
  assert.equal(base['--hud-module-font-size'],'28px')
  assert.equal(base['--module-text'],'#aa3366')
  const condition = widgetAppearanceVariables(style,{color:'#00ff00',borderColor:'#ffaa00'})
  assert.equal(condition['--module-text'],'#00ff00')
  assert.equal(condition['--widget-border-color'],'#ffaa00')
  assert.deepEqual(style,{borderColor:'#123456',borderRadius:0,padding:0,fontSize:28,color:'#aa3366'})
})
