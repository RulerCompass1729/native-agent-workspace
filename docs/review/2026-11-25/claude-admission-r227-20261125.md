## Install admission stops only for what a reading showed to end badly (lane/claude-admission-r227-20261125)

The person (2026-11-25): an install goes as soon as the full tests and the review have passed, and a check without a shown consequence is not kept. The reassessment behind it found two that have one: the compressor at 85% or more of its segment limit (a kernel panic had it at 100%) and less than 8 GiB of disk (packaging and an install were measured to take up to 5).

Change (`scripts/install-admission.cjs`, run before packaging):
- Removed: the stop for swap 90% used with less than 16 GiB of disk. Swap files are made as they are needed and were made below that line; the ratio was above 90% in 1,572 of 1,573 readings. Swap that cannot be read no longer stops, and the line says it was not read.
- Pressure 2 or 3 goes ahead and the line says so. The question, the two-hour consent, the `consent` command and exit code 76 are gone.
- Critical pressure (4) is read again every 30 s and stops only after ten minutes of it. The two limits stop at the first reading, also while it waits.

Unchanged: the values 85% and 8 GiB, an unreadable pressure, segment count or disk stops, the measured growth of packaging counts toward the segment limit, `watch`, the record file, exit 0 and 75. `--consent` and `--wait-minutes` are ignored, as any unknown argument is.

Tests: 32. On `e2825e53` the 16 about what changed are red. Mutations: 40 of 40 red. The command ran on this machine once: pressure 2, swap 21.2 of 22.0 GiB, 17.6 GiB of disk, GO.

Not in this change: the install's wait for messages on their way (an isolated experiment comes first), and the release scripts.

Undo: drop this lane's commit.
