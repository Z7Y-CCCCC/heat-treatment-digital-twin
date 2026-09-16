export function deferred() {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}

export function json(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

export const settle = () => new Promise(resolve => setImmediate(resolve))

export function installBrowser(t) {
    const originals = new Map()
    const cleanups = []
    const replace = (key, value) => {
        if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    }
    t.after(() => {
        for (const cleanup of cleanups) cleanup()
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor)
            else delete globalThis[key]
        }
    })
    const makeEvents = () => {
        const listeners = new Map()
        return {
            listeners,
            addEventListener(name, handler) {
                if (!listeners.has(name)) listeners.set(name, new Set())
                listeners.get(name).add(handler)
            },
            removeEventListener(name, handler) { listeners.get(name)?.delete(handler) }
        }
    }
    const browser = {
        ...makeEvents(),
        location: new URL('http://127.0.0.1:3001/admin'),
        fetch: (...args) => globalThis.fetch(...args),
        setTimeout: (...args) => globalThis.setTimeout(...args),
        clearTimeout: (...args) => globalThis.clearTimeout(...args),
        setInterval: (...args) => globalThis.setInterval(...args),
        clearInterval: (...args) => globalThis.clearInterval(...args)
    }
    replace('window', browser)
    replace('document', { ...makeEvents(), visibilityState: 'visible', querySelector: () => ({ classList: { contains: () => false } }) })
    const channels = []
    replace('BroadcastChannel', class {
        messages = []
        constructor() { channels.push(this) }
        postMessage(message) { this.messages.push(message) }
        close() { this.closed = true }
    })
    return { browser, replace, channels, beforeRestore: cleanup => cleanups.unshift(cleanup) }
}

export function installSockets(replace) {
    const sockets = []
    class FakeSocket {
        readyState = 0
        sent = []
        constructor(url) { this.url = url; sockets.push(this) }
        send(value) { this.sent.push(value) }
        open() { this.readyState = 1; this.onopen?.() }
        emit(type, payload) { this.onmessage?.({ data: JSON.stringify({ type, payload }) }) }
        close() { this.readyState = 3; this.onclose?.() }
    }
    replace('WebSocket', FakeSocket)
    return sockets
}
