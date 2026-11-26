# R254: the project manager follows a confirmed handoff (continued)

Continues `docs/review/2026-11-25/newreq-r254-manager-handoff-20261125.md`.

## Review 2 of 8150c5ef: N8

The independent review of rework 1 (8150c5ef) passed with non-blocking notes. N8: `docs/space-project-manager.md` said 「记录的每次改动都先在轮换日志记一行」 and the header comment of `app/space-managers.cjs` said the same, but three changes of the record write no line.

- Source check, author-run: only `set()` with a session (`logChange` `designated`) and `settle()` (`settled`) write a line. A revoke (`set(room, null)`: the line is under `if (selected)`), the other space that `set()` clears when it designates a session managing elsewhere, and both saves in `retireSecretary` write none. The behaviour stays; the sentences were wrong.
- Fix: the doc now reads 「你指定一位、或交接写进记录时，都先在轮换日志记一行：你指定是 `designated`，交接写入是 `settled`；旧版本读日志时跳过这两种行。」 The comment now says a designation and a handoff written into the record are each first a line, and that a revoke, the other space a designation clears and the secretary's retirement write no line.
- Checks, author-run: `node --check app/space-managers.cjs`; `node scripts/test.cjs` on `docs-size` and `space-managers`: 32 pass, 0 fail. No test reads either sentence; code behaviour is unchanged.
- N9 (designations made on older builds) is an install note, carried by the project manager to the installer, not changed here.
