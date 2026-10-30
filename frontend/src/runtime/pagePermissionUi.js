import { canAdminPage } from './adminSession.js'

// Native disabled controls are keyboard/accessibility safe. API authorization
// remains authoritative, including handlers triggered without DOM events.
export const permissionDirective = {
  mounted(element, binding, vnode) {
    updatePermissionControl(element, binding, vnode)
    element.addEventListener?.('submit', event => {
      if (element.__permissionDenied) { event.preventDefault(); event.stopImmediatePropagation() }
    }, true)
  },
  updated: updatePermissionControl,
  getSSRProps(binding) {
    return permitted(binding) ? {} : { disabled: true, 'aria-disabled': 'true' }
  }
}
function permitted(binding) {
  const { page, action = 'edit', also } = binding.value || {}
  return canAdminPage(page, action) && (!also || canAdminPage(page, also))
}
function updatePermissionControl(element, binding, vnode) {
  const denied = !permitted(binding)
  element.__permissionDenied = denied
  const nativeDisabled = vnode.props?.disabled
  element.disabled = denied || nativeDisabled === '' || nativeDisabled === true
  if (denied) element.setAttribute?.('aria-disabled', 'true')
  else element.removeAttribute?.('aria-disabled')
}
