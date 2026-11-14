import { ref } from 'vue'
export const saveFeedback = ref(null)
let sequence = 0
export function showSaveFeedback(message, type = 'success') {
  saveFeedback.value = { id: ++sequence, message: String(message), type: type === 'error' ? 'error' : 'success' }
}
