# Make the rows of operation records once, not for every state event

The service sends a state event several times a second while agents work. For each one the app's main process made again the rows of every operation record kept, archived ones included: with 4,473 records about 37 ms and 50 MB of garbage an event, twice that with twice the records. The memory of the main process grew with the garbage, and nothing limits how many records are kept.

- The words of a settled record (its name, text, arguments, error and the options of its card) are kept with the record object. The line that names sessions and rooms is kept with them, and made again when a name, an id or a provider changes. A record is never edited in place, so one that is added again, moved, replaced or loaded after a deletion is made again. A record that is waiting, running or awaiting a native receipt, or that has run out but is not settled, is read live as before.
- The states made for a page leave the rows out of every session. Only a send (at most four a second) makes the rows of the sessions it shows, and the times of the others, which their summary needs in place.
- The bell reads only the records that have a card, and keeps the text of a settled card.
- A session's summary no longer makes a Date for each message. This was the largest part of the garbage that remained, about 43 MB a send with 258,000 messages; an earlier diagnosis missed it because its messages were empty.

The page, the bell, the waiting strip, the phone and what an agent reads are the same. Nothing is deleted or merged, and V8's limits are as before. The state that is made and dropped while a send waits is still made: the event is cheap now, so this was not changed. Not changed either: the search for created sessions reads every message for each event (1.45 ms with 258,000 messages).

## Checks

Measured in plain Node with synthetic records and messages of the size and the disorder of a daily installation (counts only were read): 4,475 records, 250,000 messages, three sessions shown. The machine was busy with other work.

| | before | after |
| --- | --- | --- |
| one state event | 36.6 ms, 54 MB | 1.7 ms, 0.65 MB (1.5 ms and 0.2 MB of it without any record) |
| the same, 8,546 records | 70.3 ms | 1.7 ms, 1.0 MB |
| an event that is sent (at most 4 a second) | 42.2 ms | 4.1 ms, 7.0 MB (1.1 ms of the rest is the summaries without any record) |
| ten events a second: processor, peak heap | 62%, 1,002 MB | 16%, 407 MB (12.5%, 377 MB without any record) |
| the same, 8,546 records | not measured | 17%, 423 MB |

Two figures miss the letter of the target: a state event that is also sent takes 4.1 ms and 7 MB, against 3 ms and 5 MB, of which the records are 1.1 ms; and ten events a second use 16% of a processor rather than 5%, of which the records are 3.4 points and 12.5 are there without any record.

Old and new code on the same records, field by field, including the copy to the page: 918 checks of the page, the bell, the strip, the phone, search, agent and rows, through renames (in place as well), a room renamed, provider changes, cards answered, queued, replaced, asked again, settled, run out and repeated, records added again, settled to the archive and deleted, sessions ended and archived, storage failed; 848 of them non-empty; equal at 1,500 and at 4,429 records. The first version of this comparison had records without an operation id, so no card was ever replaced; the comparison and the tests now have them, and the mutations below found it.

Ten tests in `record-rows.test.cjs`. On the previous code five fail: the projection count (1905 for one event, where it expects only those with a card), the call sites of the page, and three because functions added here are missing. The other five pass on both: they pin what must not change. 47 mutants: 45 killed, two change no result (a method compared before the full comparison, and a kept text made again). 111 test files that read `main.cjs`: 3191 passed, none skipped. 3417 tests of related files: 3403 passed, and the other 14 (a comment line and a signature that two tests cut the source by) are fixed and pass, 187 of 187 in their four files. No full run. No model was called and the daily app was not touched.

An isolated Electron app with hidden windows, 20 synthetic backends and 4,473 archived records, ten events a second for 75 seconds, one run each: on the previous code the peak heapTotal was 681 MB and the physical footprint 764 to 794 MB with 1,570 scavenges; on this code 455 MB, 427 to 484 MB and 240; on this code without records 397 MB, 541 to 548 MB and 242. The footprint with records is not above that without, so the records no longer add to it; the difference between the runs is noise.

## Known limits

- Each Electron run is one run. The daily footprint is read after the installation.
- A name list that cannot be told apart by these fields (id, name, provider of sessions; id and name of rooms) is the same for the rows. The last four sets of names are kept; more windows than that, each a rename behind, make their rows again.
