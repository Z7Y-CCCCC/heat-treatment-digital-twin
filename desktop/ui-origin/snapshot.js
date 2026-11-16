(async function () {
  const entries = Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]);
  const databases = await indexedDB.databases();
  return { entries, indexedDbCount: databases.length };
})
