# R255.2 Rotation stop acknowledgement

A source session can remain live when its conditional stop returns an unconfirmed result. The dispatcher previously treated any resolved call as a confirmed stop and then recorded the handoff as done. The source kept its native process while the normal waiting path stopped tracking it.

A synthetic normal rotation returned `stopped: false` while its source remained idle. Main wrote a `done` record and failed the new assertion. The patch uses the existing maintenance identity proof and checks the stopped revisions and disposition before recording completion. Unconfirmed results stay in the existing waiting path. The guards for drafts, current work and approval remain in service code.

The focused Node test run passed five checks, including a successful rotation, a stop refused at a human-input boundary, an accepted stop recovered from the service's own refusal, a live held source, and an unconfirmed acknowledgement. Manual designation changes and the lifetime of processes from older completed rotations are separate cases. No live sessions or model turns were used.

First independent review found that a Codex unsubscribe acknowledgement could still be counted as a native end. The focused fixture reproduced this by returning an exact conditional receipt with state `disconnected`. It now stays unconfirmed. Eight focused checks passed, including the real service's two possible Claude receipt outcomes represented by the existing fixtures. Shared Codex servers remain under their own lifecycle.
