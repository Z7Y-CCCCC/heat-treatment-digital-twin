import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, reactive } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'

const url = new URL('../src/components/EnableCapsule.vue', import.meta.url)
const { descriptor, errors } = parse(await readFile(url, 'utf8'))
assert.deepEqual(errors, [])
const compiled = compileScript(descriptor, { id: 'capsule-test', inlineTemplate: true }).content
  .replaceAll('from "vue"', `from ${JSON.stringify(import.meta.resolve('vue'))}`)
const { default: Capsule } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('capsule renders accessible enabled/disabled states and emits a toggle intent, not a local optimistic value', async t => {
  const renderer = createRenderer({
    createElement: tag => ({ tag, children: [], props: {} }), createText: text => ({ text }), createComment: text => ({ text }),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
    patchProp: (node, key, old, value) => { node.props[key] = value },
    insert: (node, parent) => parent.children.push(node), remove() {}, parentNode: () => null, nextSibling: () => null
  })
  const props = reactive({ enabled: true, pending: false, disabled: false, label: '启用工厂：验收厂' })
  let toggles = 0
  const root = { children: [] }, app = renderer.createApp({ render: () => h(Capsule, { ...props, onToggle: () => toggles++ }) })
  app.mount(root); t.after(() => app.unmount())
  const button = root.children[0]
  assert.equal(button.tag, 'button')
  assert.equal(button.props.role, 'switch')
  assert.equal(button.props['aria-label'], props.label)
  assert.equal(button.props['aria-checked'], true)
  assert.equal(button.children[0].text, '启用')
  button.props.onClick()
  assert.equal(toggles, 1)
  assert.equal(props.enabled, true, 'parent must confirm the saved state')
  props.pending = true; await nextTick()
  assert.equal(button.props.disabled, true)
  assert.equal(button.props['aria-busy'], true)
  props.pending = false; props.enabled = false; await nextTick()
  assert.equal(button.props['aria-checked'], false)
  assert.equal(button.props.disabled, false)
  assert.equal(button.children[0].text, '停用')
  props.disabled = true; await nextTick()
  assert.equal(button.props.disabled, true)
})

test('factories and accounts reuse one compact animated capsule with keyboard focus and reduced-motion support', async () => {
  for (const file of ['FactoryDirectorySettings', 'PlatformUsersSettings']) {
    const source = await readFile(new URL(`../src/views/admin/components/${file}.vue`, import.meta.url), 'utf8')
    assert.match(source, /import EnableCapsule from/)
    assert.match(source, /<EnableCapsule /)
  }
  const css = descriptor.styles.map(style => style.content).join('\n')
  assert.match(css, /width:68px;height:28px/)
  assert.match(css, /border-radius:999px/)
  assert.match(css, /transform:translateX\(40px\)/)
  assert.match(css, /:focus-visible/)
  assert.match(css, /prefers-reduced-motion:reduce/)
})
