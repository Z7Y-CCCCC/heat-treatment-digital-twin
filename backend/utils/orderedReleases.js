// Sort only small keys in SQL. MySQL filesort can otherwise copy megabytes of
// snapshot_json per row into its sort buffer, even for LIMIT 1.
async function orderedReleases(db, projectId, { currentOnly = false, limit = null } = {}) {
    return orderedRows(db, 'releases', `SELECT id FROM releases WHERE project_id = ?${currentOnly ? ' AND is_current = 1' : ''}
        ORDER BY created_at DESC, id DESC${limit === 1 ? ' LIMIT 1' : ''}`, [projectId]);
}
async function orderedRows(db, table, keyQuery, params = []) {
    if (!['releases', 'scenes', 'widgets', 'projects'].includes(table)) throw new Error('Unsupported large document table');
    const keys = await db.all(keyQuery, params);
    const rows = new Map();
    for (let offset = 0; offset < keys.length; offset += 200) {
        const ids = keys.slice(offset, offset + 200).map(row => row.id);
        const values = await db.all(`SELECT * FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
        values.forEach(row => rows.set(row.id, row));
    }
    return keys.map(row => rows.get(row.id)).filter(Boolean);
}
module.exports = { orderedReleases, orderedRows };
