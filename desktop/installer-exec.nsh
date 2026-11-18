; A source-pinned, installer-only nsExec stream decoder; stock NSIS stays intact.
!ifndef DIGITAL_TWIN_INSTALLER_EXEC_LOADED
  !define DIGITAL_TWIN_INSTALLER_EXEC_LOADED
  !addplugindir /x86-unicode "${__FILEDIR__}\.cache\installer-nsexec"
!endif
