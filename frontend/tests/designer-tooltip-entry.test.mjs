import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileTemplate } from 'vue/compiler-sfc'

const sourceUrl = new URL('../src/views/admin/components/DashboardDesigner.vue', import.meta.url)
const { descriptor, errors } = parse(await readFile(sourceUrl, 'utf8'))
const template = descriptor.template.content

test('designer template still compiles after removing the duplicate tooltip entry', () => {
  assert.deepEqual(errors, [])
  assert.deepEqual(compileTemplate({ source: template, filename: sourceUrl.pathname, id: 'designer-tooltip-entry' }).errors, [])
})

test('the top tooltip mode switch remains the only tooltip editor entry', () => {
  assert.doesNotMatch(template, /编辑悬停提示内容与数据来源/)
  assert.equal([...template.matchAll(/@click="setDesignerMode\('tooltips'\)"/g)].length, 1)
  assert.match(template, /title="切换到悬停提示编辑"[^>]*@click="setDesignerMode\('tooltips'\)"/)
  assert.match(template, /<span>悬停提示<\/span>/)
})

test('view tooltip template selection and sharing guidance remain available', () => {
  const settings = template.match(/<fieldset[^>]*class="device-tooltip-settings"[\s\S]*?<\/fieldset>/)?.[0]
  assert.ok(settings)
  assert.doesNotMatch(settings, /<button\b/)
  assert.match(settings, /aria-label="当前视角悬停模板"/)
  assert.match(settings, /updateViewTooltipReference\(partTooltipSupported\?'part':'device',\$event.target.value\)/)
  assert.match(settings, /<option value="inherit">继承默认模板<\/option>/)
  assert.match(settings, /<option value="disabled">关闭提示<\/option>/)
  assert.match(settings, /共享模板内部的文字、数值、区域均可单独编辑。保存并发布后同步到大屏。/)
})
