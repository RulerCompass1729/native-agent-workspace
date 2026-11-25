## A model the person chose in a Claude session is kept on resume (lane/claude-requested-model-20261124)

Reported: a session created with model A and changed to B with `/model` started with A again after every resume or backend migration. `app/adapters.cjs` starts a resumed session with the model asked for at creation and only then the last report, on purpose: after alpha.285 a report native caused itself must not replace what the person asked for. Nothing updated the asked-for model afterwards.

Change: native's `PostModelSwitch` event names its cause. A change by `command` (`/model <name>`, the `/config` model row, fast mode that promotes the model) or `picker` becomes the session's requested model, saved with it. `auto` (its own fallback), `resume`, `sdk` (Remote Control, IDE), a missing cause and one not known yet are only reported, as before. The order of preference on resume is unchanged. A model id longer than a launch accepts leaves the previous request in place. The current compatibility hook is added to the copies that upgrade in place.

Tests: the 72 related files, 2205/2205. 8 of the new ones fail before the change; the ones for sessions never changed, and for native's own causes, pass before and after. Ten mutations of the change each fail at least one test.

Real CLI 2.1.328, 2.1.331 and 2.1.332 under the loopback fixture (no outside network, one fixed reply): created with Haiku, `/model sonnet`, stop and resume, then the picker, stop and resume. Before (run on 2.1.332): both resumes start with Haiku. After (all three): Sonnet, then the picked model; a resume before any change starts with Haiku in both.

Backend migration uses the same resume launch; the probe stopped and resumed in one process and no real migration ran. That native reports its own fallbacks as `auto` is its stated definition and its default when nothing names a cause; no fallback was provoked.

Not followed, so the earlier request (or the earlier choice) stays:
- A change made before this version: a session created with a model needs one more `/model`.
- A change through Remote Control or an IDE (`sdk`), one made before the hook is bound, one whose row was lost, and one superseded by another while its own native hooks still run. Read from native's text, not run: choosing the model native already fell back to names no cause. For a session created without a model these are new once its person has made a choice: it used to start with the last report.

Other limits:
- `to_model` is the resolved id, so `/model default` and `opusplan` are expected to keep the model they resolved to, not the alias (not run).
- Rotation starts the successor with the last report, as before: after a native fallback that is the fallback, not the choice (`carrySettings`, outside this lane).
- The cause is native's own. Whether a choice that never landed can label a later automatic change was not checked.
- Not driven by a test: the mod's rebind of a chosen row (the replayed row is made at the adapter), and the choice across `/clear` and `/branch` (same process and record).

Effort resumes with what native last reported; of the permission modes only bypass is passed. Neither has a request that wins over the report on resume, so neither has this fault. Codex keeps a thread's model itself on resume (`codexResumeParams` passes only a profile's catalog), so it is not this path.

Review: one read-only session, two rounds, PASS-WITH-NOTES with nothing blocking; its notes are in the limits above.

Undo: revert the commit; saved sessions keep the chosen model as their requested one.
