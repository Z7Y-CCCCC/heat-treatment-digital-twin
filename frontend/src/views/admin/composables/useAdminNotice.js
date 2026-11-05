import { onScopeDispose, reactive } from 'vue'

export function useAdminNotice() {
  const notice = reactive({ id: 0, text: '', tone: 'success' })
  let timer
  function clear() { clearTimeout(timer); notice.text = '' }
  function show(text, tone = 'success') {
    clear(); Object.assign(notice, { id: notice.id + 1, text: String(text || ''), tone })
    timer = setTimeout(clear, tone === 'error' ? 6500 : 3200)
  }
  onScopeDispose(clear)
  return { notice, show, clear }
}
