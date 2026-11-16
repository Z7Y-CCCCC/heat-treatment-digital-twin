const router = require('express').Router();
const { getDb } = require('../db/database');
const { saveWorkshopArrangement } = require('../services/workshopArrangement');
router.put('/', async (req, res) => {
  try {
    const db = await getDb();
    res.json(await db.transaction(tx => saveWorkshopArrangement(tx, req.factoryId, req.body)));
  } catch (error) { res.status(error.statusCode || 400).json({ success: false, error: error.message }); }
});
module.exports = router;
