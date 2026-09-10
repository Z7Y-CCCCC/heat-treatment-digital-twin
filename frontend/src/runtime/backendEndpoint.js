function browserLocation() {
    if (typeof window === 'undefined') return null;
    return window.location;
}

export function getBackendOrigin() {
    const location = browserLocation();
    const configured = typeof window !== 'undefined'
        ? window.__DIGITAL_TWIN_BACKEND_ORIGIN__
        : '';
    if (configured) return String(configured).replace(/\/$/, '');
    if (!location) return 'http://127.0.0.1:3001';

    const envOrigin = String(import.meta.env.VITE_BACKEND_ORIGIN || '').trim();
    if (envOrigin) return envOrigin.replace(/\/$/, '');

    if (['5173', '4173', '3423'].includes(location.port)) {
        const protocol = location.protocol === 'https:' ? 'https:' : 'http:';
        return `${protocol}//${location.hostname || '127.0.0.1'}:3001`;
    }

    return location.origin;
}

export const API_BASE = `${getBackendOrigin()}/api`;

export function getWebSocketUrl(pathname = '/ws') {
    const backend = new URL(getBackendOrigin());
    backend.protocol = backend.protocol === 'https:' ? 'wss:' : 'ws:';
    backend.pathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
    backend.search = '';
    backend.hash = '';
    return backend.toString();
}
