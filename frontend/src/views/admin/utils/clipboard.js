// Preserve the complete path, including whitespace, and support local HTTP/WebView pages.
export async function copyTextToClipboard(text) {
    if (typeof text !== 'string' || !text.length) throw new Error('没有可复制的路径')
    try {
        if (globalThis.navigator?.clipboard?.writeText) {
            await globalThis.navigator.clipboard.writeText(text)
            return
        }
    } catch {
        // Clipboard permissions and insecure origins can reject the modern API.
    }

    const doc = globalThis.document
    if (!doc?.body || typeof doc.execCommand !== 'function') throw new Error('浏览器无法复制，请手动复制路径')
    const focused = doc.activeElement
    const selection = doc.getSelection?.()
    const ranges = []
    for (let index = 0; index < (selection?.rangeCount || 0); index++) ranges.push(selection.getRangeAt(index).cloneRange())
    const inputSelection = typeof focused?.selectionStart === 'number'
        ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection]
        : null
    const textarea = doc.createElement('textarea')
    textarea.value = text
    textarea.readOnly = true
    textarea.setAttribute('aria-hidden', 'true')
    Object.assign(textarea.style, { position: 'fixed', left: '-9999px', top: '0', opacity: '0' })
    try {
        doc.body.appendChild(textarea)
        textarea.focus({ preventScroll: true })
        textarea.select()
        if (!doc.execCommand('copy')) throw new Error('浏览器无法复制，请手动复制路径')
    } finally {
        textarea.remove()
        focused?.focus?.({ preventScroll: true })
        if (inputSelection) focused.setSelectionRange?.(...inputSelection)
        if (selection && ranges.length) {
            selection.removeAllRanges()
            for (const range of ranges) selection.addRange(range)
        }
    }
}
