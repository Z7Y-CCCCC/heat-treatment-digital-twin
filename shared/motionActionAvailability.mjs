// Retire authoring choices, not the rig/clip assets or archived device rows.
// process_cycle is the multipurpose furnace's complete process, not a part
// actuator. Its exact packaged ID is distinct from ordinary doors/fans/parts.
export function isRetiredMotionAction(action) {
  return action?.kind === 'clip' && typeof action.id === 'string'
    && (action.id === 'clip:process_cycle' || action.id.startsWith('clip:user_'))
}
