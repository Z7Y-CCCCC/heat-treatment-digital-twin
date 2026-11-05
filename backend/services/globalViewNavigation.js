const crypto = require('node:crypto')
const { GLOBAL_VIEW_KEY: KEY, GLOBAL_VIEWS, normalizeGlobalViews, applyViewNavigation } = require('../../shared/viewNavigation.mjs')
const revision = row => crypto.createHash('sha256').update(row ? String(row.value) : 'missing-global-view-navigation').digest('hex')
async function getPolicy(db) {
  const row = await db.get('SELECT value FROM settings WHERE `key` = ?', [KEY])
  return { config: normalizeGlobalViews(row?.value), revision: revision(row), configured: !!row }
}
function validatePolicy(value) {
  if (!value || value.version !== 1 || !value.enabled || Object.keys(value).some(key => !['version', 'enabled'].includes(key))
    || Object.keys(value.enabled).length !== GLOBAL_VIEWS.length || GLOBAL_VIEWS.some(view => typeof value.enabled[view.id] !== 'boolean'))
    throw Object.assign(new Error('全局视角开关格式无效'), { statusCode: 400 })
  return normalizeGlobalViews(value)
}
async function savePolicy(db, body, dialect) {
  const next = JSON.stringify(validatePolicy(body.config))
  return db.transaction(async tx => {
    const row = await tx.get('SELECT value FROM settings WHERE `key` = ?', [KEY])
    const conflict = () => Object.assign(new Error('其他窗口已更新全局视角，请重新读取后再试'), { statusCode: 409 })
    if (body.revision !== revision(row)) throw conflict()
    if (row && next === row.value) return getPolicy(tx)
    const saved = row ? await tx.run(`UPDATE settings SET value = ? WHERE \`key\` = ? AND ${require('./deviceInspection').exactTextEquals('value', dialect)}`, [next, KEY, row.value])
      : await tx.insertIgnore('settings', { key: KEY, value: next }, 'key')
    if (!saved?.changes && !saved?.affectedRows) throw conflict()
    return getPolicy(tx)
  })
}
async function runtimeDocument(db, document) { return applyViewNavigation(document, (await getPolicy(db)).config) }
module.exports = { KEY, getPolicy, savePolicy, validatePolicy, runtimeDocument }
