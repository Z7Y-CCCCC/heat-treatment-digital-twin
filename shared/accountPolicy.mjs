// One policy for account creation, credential reload and browser forms.
export const MIN_USERNAME_LENGTH = 2
export const MAX_USERNAME_LENGTH = 32
export const MIN_PASSWORD_LENGTH = 6
export const MAX_PASSWORD_LENGTH = 128

// Escape the hyphen for HTML pattern's Unicode 'v' mode as well as JS 'u'.
export const USERNAME_PATTERN = String.raw`[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_\-]{1,31}`
const usernameExpression = new RegExp(`^(?:${USERNAME_PATTERN})$`, 'u')

export function isValidUsername(value) {
  return typeof value === 'string' && value === value.trim() && usernameExpression.test(value)
}

export function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase()
}

export function isValidPassword(value) {
  return typeof value === 'string' && value.length >= MIN_PASSWORD_LENGTH
    && value.length <= MAX_PASSWORD_LENGTH && Boolean(value.trim())
}
