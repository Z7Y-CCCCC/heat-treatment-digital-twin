import { CLEANER_PROCESS_STEPS } from '../../../three/cleanerProcess.js'

export const CLEANER_ACTIONS = CLEANER_PROCESS_STEPS.filter(step => ['fill', 'heat', 'spray', 'ultrasonic', 'drain', 'blow'].includes(step.id))

// Process effects are built-in previews, not fabricated PLC bindings. Preserve
// the original binding index so editing/deleting a row still addresses the
// correct saved binding after the six process rows have been prepended.
export function motionEntries(bindings, includeCleaner, query = '', bindingName = binding => binding.name || '') {
    const entries = [
        ...(includeCleaner ? CLEANER_ACTIONS.map(process => ({ process, index: -1 })) : []),
        ...bindings.map((binding, index) => ({ binding, index }))
    ]
    const needle = query.trim().toLowerCase()
    return entries.filter(({ process, binding }) => (process
        ? `${process.label} ${process.detail} ${process.id}`
        : `${bindingName(binding)} ${binding.source_group} ${binding.source_key}`).toLowerCase().includes(needle))
}
