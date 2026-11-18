# Installer-only nsExec stream repair

Pinned NSIS 3.12 sources retain their upstream notices; see `COPYING` and `provenance.json`.

The local patch in `nsexec.c` compacts unconsumed UTF-16LE/DBCS bytes before the next pipe read, delays first-chunk detection for fragmented BOMs, and returns an error for an incomplete final character. This fixes real Chinese fragments such as `吀文件清单…` without stripping warning/error text.

`desktop/scripts/build-installer-nsexec.cjs` builds an x86 Unicode, statically linked installer-only DLL offline using the same MSVC toolchain already required for native installer chrome. Source/provenance and DLL hashes are validated on every cache reuse; customer software and collector resources are unchanged. The stock NSIS compiler, archive decoder, provenance and /WX policies are not replaced.

The isolated regression intentionally splits a UTF-16 stream into odd byte-sized pipe writes and checks exact recovered text and exit status through the actual NSIS plugin.

Source/header/license whitespace is normalized to LF with no trailing blanks; license wording is unchanged. Original upstream digests and final vendored digests are recorded separately. The repository enforces LF for this subtree so Windows Git checkout cannot invalidate the source proof.
