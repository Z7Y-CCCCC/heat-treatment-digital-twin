(function (entries) {
  if (!Array.isArray(entries) || entries.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string')))
    throw new Error('Invalid storage snapshot');
  if (new Set(entries.map(pair => pair[0])).size !== entries.length) throw new Error('Duplicate storage key');
  // Preflight ALL conflicts before any write. Never replace newer target edits.
  const conflicts = entries.filter(([key, value]) => localStorage.getItem(key) !== null && localStorage.getItem(key) !== value);
  if (conflicts.length) return { success: false, reason: 'target-conflict', conflictCount: conflicts.length };
  const added = [];
  try {
    for (const [key, value] of entries) {
      if (localStorage.getItem(key) === null) { localStorage.setItem(key, value); added.push(key); }
    }
    if (entries.some(([key, value]) => localStorage.getItem(key) !== value)) throw new Error('Storage readback mismatch');
    return { success: true, copied: added.length, verified: entries.length };
  } catch {
    for (const key of added) localStorage.removeItem(key);
    return { success: false, reason: 'write-or-readback-failed' };
  }
})
