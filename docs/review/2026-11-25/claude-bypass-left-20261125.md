# No recovery puts a Claude session back into bypass after the person left it

A Claude session in bypass, left for another mode with a key and with no turn since, came back in bypass: a backend update, the person's resume and any other started it as NAW last knew it, and NAW learns the mode only from a turn. The model change already read what the session's own transcript ends in. That check is now in the one launch every resume uses, and the model change has none of its own.

- **Resume.** Where NAW knows the session in bypass and its transcript says it was left in another mode, it is started in that mode, by name, and NAW's record says so. Still in bypass, it is started in bypass; so is one whose transcript is missing, cut short, a link, another conversation's or of an unknown mode, as before.
- **What the transcript says it was left in.** Claude writes its mode as it exits, unless that is the one it wrote last, and always writes its cost then. The mode written last therefore counts when it, or an exit, follows the last turn; it is looked for as far back as 16 MB, beyond which all is as before. Otherwise Claude was killed after that turn and the mode is an older one: bypass stays bypass; a session NAW knows in default, plan or dontAsk is started in that by name, unless the older mode, which Claude would go by, is plan or dontAsk; the rest is left to Claude, as before, since a change made after the turn is gone with the process.
- **Claude's own return is not enough.** It restores the mode a session was left in, except bypass and default: from default it comes back in the person's own default, which is bypass on a machine set so. This brought bypass back there even after a turn in default. A session left in default is therefore asked for default by name.
- **NAW starts no session in bypass on its transcript's word.** Known in another mode while its transcript says it was left in bypass, it is started in the mode NAW knew; left to itself, Claude used the person's own default, bypass included. Other modes are restored by Claude from the transcript, as before.
- **A conversation opened from history with bypass ticked** has no transcript known to NAW at that first start, so the choice stands.
- **Rotation** did bring bypass back, in two ways. The successor's mode was read when the handoff was asked for, before the turn that reports the change; and a session once opened in bypass always started its successor in bypass, which went unnoticed when the session was in default by then. Both are settled after the handoff turn: the successor gets bypass only if the session still has it. Where that turn reports more than was read at the request, the successor keeps what was read.
- **Default is carried to a successor by name.** It was not, so the successor of a session in default started in the person's own default, looser or stricter. Claude takes `manual` at launch for the mode it reports as `default`; NAW already accepts that name, and the comparison of what a successor reports treats the two as one.

Codex is unchanged. No wording, dependency, network access or stored field is new.

## Checks

On the unchanged code six of the nine resume tests and the four rotation tests that assert the fix fail; what must not change passes there too. Mutations of the launch: 52 of 53 are caught, three after tests were added; the one left changes nothing that Claude writes. Mutations of the rotation and of the first version of the launch: all 23 caught, four after tests were added.

With the installed Claude 2.1.332 and a local stand-in for its model service (no account, no network, no cost), outside the daily app, the transcript read between the stop and the resume:

- A backend update (the service's stop, its state closed and loaded again, the resume) after shift+tab to auto, default, accept edits and plan, with no turn: started in that mode, and the next turn reports it; a second recovery leaves it there, also with no turn between. Untouched, and once around back to bypass: started in bypass. The same in a session that had been resumed before. The old code started default and plan in bypass.
- The same with the person's own default set to bypass, and after a turn in each of the four: each came back in its mode. The old code came back in bypass after a turn in default. A turn in plan, then bypass with none: plan. Left in default, resumed, a turn in accept edits, back to default with none, where Claude writes nothing new: default.
- The person's stop and resume, for default and plan: the same, and for default the old code the same fault. Claude ended by SIGHUP (plan) and SIGTERM (default) comes back in it.
- Killed outright: after a turn in plan or default it comes back in that, also where the own default is bypass, and started in dontAsk in that; the old code came back in the own default. Last written in plan, then a turn in default and back to plan with none: plan. After a turn in accept edits or auto: the own default, as the old code. In bypass, also after a turn in plan and one back in bypass: bypass.
- A conversation last in plan, opened from history with bypass ticked: twice stopped and resumed with no turn, bypass each time; after a turn in bypass and a kill, bypass; after a turn in bypass and back to plan with none, where Claude writes nothing new, plan.
- The update on 2.1.328 to 2.1.331 for plan, and a kill in bypass and after a turn in plan. Some starts after a kill on 2.1.328 to 2.1.330 did not become ready in 60 seconds, on the old code too (3 of 6, and 5 of 17 on the new); none on 2.1.331 and 2.1.332. Those cases were repeated until they did.
- What a rotation asks for, with the handoff turn and the successor's first turn run: default, plan and accept edits each start as that, untouched as bypass. The old code started default and plan in bypass. The launch name `manual` ran on every installed version, 2.1.328 to 2.1.332. These ran before the last change to the launch, which the rotation does not use.

Moved onto alpha.303 by a merge without conflict or hand edit. On the merged tree all 175 related test files pass (4563 tests); before it, on this change alone, one file failed, as on its base, and alpha.303 corrects it. Eleven of the runs above (seven resumes and kills, the four rotations) were repeated on the merged tree with 2.1.332, with the same results.

No real model was called.

## Known limits

- Killed outright (SIGKILL, power loss) Claude writes nothing, so a change with no turn after it is lost: the session comes back in bypass, as before, or in what its last turn ran in. After a turn in accept edits or auto Claude goes by an older mode it wrote, and where that is bypass or default by the person's own default, bypass included, as before.
- A session NAW knows in another mode whose transcript it cannot read is left to Claude, as before: the same.
- A mode written for a moment, in passing with shift+tab or in a plan the agent entered, can be the last one in a session killed right after: it comes back in that, less than it had where NAW knew it in bypass; otherwise as before.
- Telling a killed session from one that exited rests on the cost Claude writes as it exits (2.1.328 to 2.1.332). Without it, a session back in the mode written last, after a turn in bypass, would come back in bypass, as before; so would one whose mode was written last more than 16 MB back.
- A change from another mode to bypass with no turn after it is lost too: the session comes back in the mode NAW knew. Until now it came back in the person's own default.
- A conversation opened from history in bypass and killed before its first turn and its first clean exit comes back in the mode its old record was left in, which is less.
- After it comes back in another mode, bypass is not among the modes shift+tab offers, as after any resume that does not ask for it.
- Where the person's own default is stricter than default (plan, dontAsk), a session left in default, or killed after a turn in it, now comes back in default, and has a successor in it; until now in that stricter mode.
- The successor of a session in default is now compared as any other: one that changes its mode in its first turn fails the rotation, and the old session goes on.
- A successor of a session whose mode was never reported starts as before. Changes among modes other than bypass, made without a turn before the handoff was asked for, are not carried. A key pressed in NAW after that ends the rotation, as before.
- Codex sessions opened with full access start their successors with it, whatever the person changed in Codex since: NAW keeps no record of what Codex runs with.
- A window opened before this version still holds the old rotation, and a backend started before it the old resume.
- Not yet used in the daily app.

## Independent review

One non-author, read-only reviewer, five passes. The first blocked on a claim (that nothing gives a session more than NAW knew), which led to the own default being bypass and so to asking by name. The second blocked on two cases of a kill, which led to telling a killed session from one that exited. The third blocked on a mode written far back and on an older tighter mode; both were changed, the second was run natively and the first only in tests. The fourth passed. Its notes are additions to Known limits, the cost of reading up to 16 MB where no mode is found, and that a named auto after a change to a model without auto mode was not run. A fifth, on the merge with alpha.303, passed with three corrections of wording here.
