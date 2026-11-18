'use strict';
const path = require('node:path');
// Read-only instrumentation for the isolated native UI fixture. This source
// is never included in a production installer and only writes to its output.
function collectorPreviewEvidenceSource(directory) {
  const file = path.join(directory, 'choice-page.ini').replace(/\$/g, '$$');
  return `
!macro CollectorPreviewRect KEY HANDLE
  System::Alloc 16
  Pop $0
  System::Call 'user32::GetWindowRect(p \${HANDLE}, p r0)'
  System::Call 'user32::MapWindowPoints(p 0, p $collectorChoiceDialog, p r0, i 2)'
  System::Call '*$0(i.r1, i.r2, i.r3, i.r4)'
  System::Free $0
  WriteINIStr "${file}" "Rects" "\${KEY}" "$1,$2,$3,$4"
!macroend
Function CollectorPreviewRecord
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  WriteINIStr "${file}" "State" "existing" "$collectorExisting"
  WriteINIStr "${file}" "State" "choice" "$collectorChoice"
  WriteINIStr "${file}" "State" "requestedEmpty" "$collectorEmptySelection"
  WriteINIStr "${file}" "State" "newEmpty" "$collectorNewEmpty"
  WriteINIStr "${file}" "State" "installed" "$collectorInstalled"
  WriteINIStr "${file}" "State" "emptyApplied" "$collectorNewEmptyApplied"
  System::Call 'user32::IsWindowEnabled(p $collectorDisplayRadio) i.r0'
  WriteINIStr "${file}" "State" "displayEnabled" "$0"
  System::Call 'user32::IsWindowEnabled(p $collectorServiceRadio) i.r0'
  WriteINIStr "${file}" "State" "serviceEnabled" "$0"
  System::Call 'user32::IsWindowEnabled(p $collectorEmptyCheckbox) i.r0'
  WriteINIStr "${file}" "State" "emptyEnabled" "$0"
  \${NSD_GetState} $collectorDisplayRadio $0
  WriteINIStr "${file}" "State" "displayChecked" "$0"
  \${NSD_GetState} $collectorServiceRadio $0
  WriteINIStr "${file}" "State" "serviceChecked" "$0"
  \${NSD_GetState} $collectorEmptyCheckbox $0
  WriteINIStr "${file}" "State" "emptyChecked" "$0"
  System::Alloc 16
  Pop $0
  System::Call 'user32::GetClientRect(p $collectorChoiceDialog, p r0)'
  System::Call '*$0(i.r1, i.r2, i.r3, i.r4)'
  System::Free $0
  WriteINIStr "${file}" "Rects" "page" "$1,$2,$3,$4"
  !insertmacro CollectorPreviewRect display $collectorDisplayRadio
  !insertmacro CollectorPreviewRect service $collectorServiceRadio
  !insertmacro CollectorPreviewRect policy $collectorPolicyLabel
  !insertmacro CollectorPreviewRect empty $collectorEmptyCheckbox
  GetDlgItem $5 $HWNDPARENT 1
  !insertmacro CollectorPreviewRect action $5
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
`;
}
function parseChoiceEvidence(text) {
  const result = {}; let section;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const heading = /^\[([^\]]+)\]$/.exec(line.trim());
    if (heading) { section = result[heading[1]] = {}; continue; }
    const equal = line.indexOf('=');
    if (section && equal > 0) section[line.slice(0, equal)] = line.slice(equal + 1);
  }
  return result;
}
module.exports = { collectorPreviewEvidenceSource, parseChoiceEvidence };
