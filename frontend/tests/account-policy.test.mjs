import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileTemplate } from 'vue/compiler-sfc'
import { isValidUsername, normalizeUsername, isValidPassword, MIN_USERNAME_LENGTH, MAX_USERNAME_LENGTH,
  USERNAME_PATTERN, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../../shared/accountPolicy.mjs'

test('Chinese and mixed login names share the browser and server username policy', () => {
  const htmlPattern = new RegExp(`^(?:${USERNAME_PATTERN})$`, 'v')
  assert.equal(MIN_USERNAME_LENGTH, 2)
  assert.equal(MAX_USERNAME_LENGTH, 32)
  for (const name of ['普通用户1', '张三', '值班员_A-1', 'Workshop_A', '车'.repeat(32), '𠮷野']) {
    assert.ok(isValidUsername(name), name)
    assert.ok(htmlPattern.test(name), name)
  }
  for (const name of ['', '张', '车'.repeat(33), '无效 用户', 'a\nb', 'abc\n', 'a@b', '<用户>', '1用户', 'a😀', null, 123]) {
    assert.equal(isValidUsername(name), false, String(name))
  }
  assert.equal(normalizeUsername(' 普通用户A '), '普通用户a')
  assert.equal(normalizeUsername(' ADMIN '), 'admin')
})

test('six-character passwords work without trimming or weakening the upper bound', () => {
  assert.equal(MIN_PASSWORD_LENGTH, 6)
  assert.equal(MAX_PASSWORD_LENGTH, 128)
  for (const password of ['a1B2c3', '123456', '中文密码六位', ' abcd ', 'p'.repeat(128)]) assert.ok(isValidPassword(password))
  for (const password of ['', '12345', '      ', 'p'.repeat(129), null, 123456]) assert.equal(isValidPassword(password), false)
})

for (const filename of ['AdminAccess.vue', 'GroupOverview.vue', 'admin/components/PlatformUsersSettings.vue', 'admin/components/AdminSecuritySettings.vue']) {
  test(`${filename} uses the shared six-character policy for every password field`, async () => {
    const { descriptor, errors } = parse(await readFile(new URL(`../src/views/${filename}`, import.meta.url), 'utf8'))
    assert.deepEqual(errors, [])
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename, id: 'account-policy' }).errors, [])
    const inputs = descriptor.template.content.match(/<input\b[^>]*autocomplete="(?:current-password|new-password)"[^>]*>|<input\b[^>]*:autocomplete="[^"\n]*current-password[^"\n]*"[^>]*>/g)
    assert.ok(inputs?.length, 'password fields must be checked')
    for (const input of inputs) {
      assert.match(input, /:minlength="MIN_PASSWORD_LENGTH"/)
      assert.match(input, /:maxlength="MAX_PASSWORD_LENGTH"/)
    }
    assert.doesNotMatch(descriptor.template.content, /minlength="8"|8–128|至少 8 位/)
  })
}
