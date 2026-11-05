const express = require('express')
const { getDb, getDbStatus } = require('../db/database')
const policy = require('../services/globalViewNavigation')
module.exports = controller => {
  const router = express.Router()
  router.get('/', async (req, res) => {
    try { res.setHeader('Cache-Control', 'no-store'); res.json(await policy.getPolicy(await getDb())) }
    catch (error) { res.status(500).json({ error: '全局视角配置暂不可用' }) }
  })
  router.get('/resolve', async (req, res) => {
    try { res.setHeader('Cache-Control', 'no-store'); res.json(await require('../services/viewEntry').resolveEntry(await getDb(), req.query)) }
    catch (error) { res.status(400).json({ error: '视角入口暂不可用：' + error.message }) }
  })
  router.put('/', async (req, res) => {
    try {
      const result = await policy.savePolicy(await getDb(), req.body || {}, getDbStatus().type)
      controller.wsServer?.broadcast('configuration_changed', { keys: [policy.KEY], settings: { [policy.KEY]: JSON.stringify(result.config) }, timestamp: Date.now() })
      res.json({ success: true, ...result })
    } catch (error) { res.status(error.statusCode || 400).json({ error: error.message }) }
  })
  return router
}
