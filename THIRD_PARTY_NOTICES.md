# Third-party notices

Revive PSG1's original source and artwork are released under Apache-2.0. Package
manager dependencies are not relicensed; their metadata and lockfiles identify
the exact versions and each dependency remains subject to its own license.

The repository includes the Gradle Wrapper JAR from the Gradle project, which
is distributed under Apache-2.0. The wrapper downloads Gradle itself when used.

The pinned LineageOS manifest in `docs/handoff/` records upstream repositories
for reproducibility. It does not vendor those repositories or change their
individual licenses and notices.

Names and trademarks—including PSG1, PlaySolana, Android, Google, and
LineageOS—belong to their respective owners. See `NOTICE`.

## Handoff audit

On 2026-08-10, the npm lockfile reported 858 packages: predominantly MIT,
Apache-2.0, ISC, BSD, MPL-2.0, and LGPL-3.0-or-later expressions. The four
entries without lockfile license metadata were local `@revive-psg1/*` workspace
links; each corresponding package declares Apache-2.0 in its source manifest.

Rust metadata resolved without a missing license field. Its dependency graph is
predominantly MIT and/or Apache-2.0, with BSD, ISC, MPL-2.0, Unicode-3.0, Zlib,
CC0, CDLA-Permissive-2.0, and compatible compound expressions. Dependencies are
linked through their package managers rather than copied into Revive source.

These inventory results document the handoff; they are not a substitute for a
release-specific legal review if a future maintainer redistributes binaries.
