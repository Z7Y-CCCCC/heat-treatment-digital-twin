import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileTemplate } from 'vue/compiler-sfc'

const source = await readFile(new URL('../src/views/AdminAccess.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
test('login and confirmation have explicit, stable, accessible password reveal controls', () => {
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: 'AdminAccess.vue', id: 'access' }).errors, [])
  for (const key of ['showPassword', 'showConfirmation']) {
    assert.match(source, new RegExp(`const ${key} = ref\\(false\\)`))
    assert.match(source, new RegExp(`:type="${key} \\? 'text' : 'password'"`))
    assert.match(source, new RegExp(`:aria-pressed="${key}"`))
  }
  assert.equal((descriptor.template.content.match(/class="unlock-password-toggle"/g) || []).length, 2)
  assert.doesNotMatch(descriptor.template.content, /<button[^>]*v-if="(?:password|confirmation|showPassword|showConfirmation)"/)
  assert.match(source, /input::-ms-reveal[^}]*display: none/)
  assert.match(source, /\.unlock-password-toggle[^}]*background: transparent/)
})
test('reveal is reset before submitting and when authentication changes', () => {
  assert.match(source, /busy.value = true\s+showPassword.value = false\s+showConfirmation.value = false/)
  assert.match(source, /watch\(\(\) => adminSession.authenticated, authenticated => \{\s+showPassword.value = false\s+showConfirmation.value = false/)
})
