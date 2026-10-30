// One outstanding read per resource, including its response body. A stalled
// local service cannot accumulate a new fetch on each polling tick.
export function createJsonPollingScope(fetcher, timeoutMs = 10000) {
    const pending = new Map()
    let disposed = false
    function read(key, url, options = {}) {
        if (disposed) return Promise.reject(new Error('Polling scope is disposed'))
        if (pending.has(key)) return pending.get(key).promise
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        const entry = { controller, timer, promise: null }
        pending.set(key, entry)
        entry.promise = (async () => {
            try {
                const response = await fetcher(url, { ...options, signal: controller.signal })
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                return await response.json()
            } finally {
                clearTimeout(timer)
                if (pending.get(key) === entry) pending.delete(key)
            }
        })()
        return entry.promise
    }
    function dispose() {
        disposed = true
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.controller.abort() }
        pending.clear()
    }
    return { read, dispose }
}
