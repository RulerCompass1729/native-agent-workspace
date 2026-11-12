# Butler business context boundary

This source capability supports the single-entry vision: the designated butler
can understand work across spaces while native conversations remain private.
It performs no model call, queue write, role change or lifecycle action. The
record period and activation remain off; production DSH wiring and qualification
are separate gates.

## Default context and writable targets

`butler-policy.buildInput` supplies an active-space index: `id`, `name`, a literal
`writable` flag and `queueCounts` by status. It does not read task bodies, member
histories or arbitrary source getters. The index has at most 200 spaces, 300
queue status entries per space and 128 KiB of serialized UTF-8 data; invalid or
oversized indexes fail explicitly. Archived spaces are absent by default.

`readableCatalogRows(catalog, { includeArchived })` builds that metadata index;
`catalogRows` is its compatibility alias. `writableCatalogRows` always excludes
archives and requires `writable === true`. Queue proposals, including automatic
selection of the sole target, use this writable set. Explicit `open` and
`archive` proposal targets also require an active writable space. `question` and
`report` may explicitly reference readonly or archived spaces. These remain
record-only proposals; a future executor must recheck its actual target and
authority at the operation boundary. Missing-target behavior is unchanged.
Ordinary nonmember and secretary S2 projections are unchanged.

## One bound read capability

The trusted runtime host supplies the role, private RoomState and current
metadata records. It binds the actual designated record and exact selection:

```js
// Main creates one audit object with its opaque person verifier. Reuse that
// exact instance for this capability and the human butlerReview('reads') path.
const business = new ButlerBusiness({ dataDir, role, roomState, view, readAudit: butlerReadAudit });
const capability = business.bind(actualRecord, { selectionRevision, runnerRef });
const catalog = capability.catalog();
const page = capability.invoke('readBusiness', {
  kind: 'deliveries', spaceId, fromTime, throughTime, limit: 20,
});
```

The initial record must be the actual object in the trusted host view. Later
calls resolve its bound session/native identity in a fresh view and recheck the
role revision, runner, membership and liveness. A revoked, rotated or replaced
binding cannot fall through to ordinary agent permissions. The model never
supplies an actor, selection or authorization object.

`readAudit` and `dataDir` are required. The trusted host must pass Main's own
`dataDir` constant, never a model field, query option or inferred role directory.
The audit's private store brand and its actual directory device/inode must match
that owned mode-700 directory before construction, binding and each read's
authorization checks. JSON/prototype stand-ins and overridden instance checks
cannot assert a different root. Physical aliases of the same directory remain
valid. With Main's real `dataDir` supplied, an audit in a different private folder
is refused; the comparison alone cannot authenticate that supplied reference.

The audit module's export object is frozen, so property assignment or redefinition
cannot substitute its constructor before Business imports it. This shallow guard
keeps the existing constructor, prototype, instance and public API behavior; it
does not defend arbitrary same-process code that can replace require.cache or
module.exports itself.

There is no implicit store derived from `role.file`, and that path is not read
to choose the audit. The role record may live in a nested instance directory;
its real authorization checks still run. The host reuses its shared audit object
and Main directory for every role and reconstructed business capability,
including its person-only log reader. Directory changes refuse the operation before a body is returned; a change
during a read can still count one prepared page in Main's correct log. A failed
audit also refuses binding and catalog access. This explicit source
contract does not inject, wire or qualify the production DSH host; its future
factory still must supply the trusted Main values.

The catalog exposes only `readBusiness`. Every other method is refused, including
`initial`, `nativeHistory`, terminal/observation/file reads and queue mutations.
An ordinary cross-session approval or a caller-supplied `approved` value cannot
override that restriction. The future DSH host must install this capability as
its only NAW tool dispatcher; it must not expose the generic workspace-control
catalog, snapshots or old operation receipts alongside it. This source adapter
has no generic executor or fallback. A separate runtime proof must verify that
no other built-in/native tools or automatic session history reach the model.

## Queries and traceability

| `kind` | Query | Contents |
| --- | --- | --- |
| `spaces` | Optional `includeArchived`, `limit`, `cursor` | Active indexes by default; archived metadata only on explicit request |
| `queue` | Required `spaceId`; optional `limit`, `cursor` | Current complete task text and structured status/timing/READY fields; archives may be explicitly read |
| `deliveries` | Required `spaceId`, `fromTime`, `throughTime`; optional `limit`, `cursor` | Retained typed queue results and READY branch/commit, with event/item references |

Times are inclusive nonnegative integer milliseconds, with a maximum delivery
window of 31 days. Pages default to 20 and permit at most 50 records, 64 KiB of
serialized UTF-8 data and 2000 scanned source entries. An empty page can still
have `truncated: true`; continue with `nextCursor`. The space store has a separate
1000-space read cap. Queue arrays retain the existing 300-item limit. These are
finite read bounds, not model spending authorizations.

Records include canonical `naw:space:<id>` item/event references, recorded times,
metadata revision, archive state and read-only status. A complete task is never
silently shortened. Missing, damaged or secret-shaped sources are unavailable
rather than copied into a different field. Results and cursors carry no session
body, event free text, reply fragment, private notes, control-audit payload,
prompt, environment, native history or terminal frame. Cursor scope and revision
are checked on each page; data changes return `ERR_BUTLER_BUSINESS_STALE`.
Cursors do not grant authority and contain no signing secret.

Delivery coverage is explicitly `structured-queue-events-only`. A valid legacy
READY monitor can return its recorded branch/commit and backlink; absent original
task evidence stays unavailable. Only an already retained, validated READY source
can return its full original task after queue trimming. Unstructured reply text
is not parsed or promoted into a delivery result. This is bounded access to
retained business records, not a claim to reconstruct all historical activity.

## Remaining runtime gates

The target is NAW's own DSH agent loop with DeepSeek; another model is not added
here. The role accepts only the designated DSH instance and checks its explicit
model configuration, runner, native identity and revision. That identity check is
not a live DSH isolation proof. No DSH loop is connected by this checkpoint, no
qualification flag is enabled and
no real provider request is made by the tests. The first working-day trial,
installed use and the secretary-to-butler cutover remain future acceptance work.


## Read audit and page allowance

Every successful `readBusiness` page must first append and fsync a metadata record
in the private read log, `history/butler-reads/` in the data folder (the layout is
under "Kept whole, in blocks" below). The same lock checks the fixed
**64-page UTC-day allowance** and commits its next counter. The maximum page is
64 KiB, so this bounds approved business pages to 4 MiB per UTC day. Empty and
repeated pages count. All selections, session handoffs and restarts share that
file's count; changing actor or constructing another capability cannot reset it.
The limit is a read allowance, not a USD spending cap or a change to the person's
reminder policy. The model cannot supply or change it. The allowance counts
newly released pages, not cumulative provider input: a later request can resend
an earlier tool result. The DSH host must separately bound each complete model
request; this counter is not a token measurement.

A record contains sequence, time, UTC day and page-of-day; session/native IDs,
selection revision and runner reference; query kind, space ID, limit and any
archive/time-window bounds; returned count, record references, scan count and
truncation flag. There are no names, task text, replies, decision titles, failure
reasons, raw cursors, environment, headers or session history. This records page
preparation under valid authority, not proof that the model or provider received
it. A final revocation or transport failure can leave a conservative extra record.

The data capability rechecks identity before audit commit and before returning.
Business calls the base `ButlerReadAudit.record(audit, page)` entry, which enters
the audit's private implementation without dispatching a public `recordPage`
override. The public method remains compatible for direct callers. The base
constructor is frozen so host composition cannot replace its directory check or
record entry with a fake receipt. This guards host misuse of these APIs; it does
not isolate them from arbitrary code executing in the same process.

Directory equality is a consistency check, not proof that the host chose the
correct root. Runtime acceptance must show the actual Main factory passing its
real `dataDir` and its single `butlerReadAudit` instance, shared with the verified
person's metadata reader. An audit and a claimed directory that agree with each
other but both point somewhere else are not qualified. This checkpoint does not
add that production factory and does not claim that its injection is proven.

Quota exhaustion, missing durability, lock contention, unsafe paths and a damaged
block being written withhold the page. A failed write is never repaired by
truncating old records. Each block holds at most 32 MiB and each metadata line at
most 128 KiB; the log as a whole has no cap and nothing is deleted by itself. A
stale lock after a crash remains a blocking condition;
there is no automatic takeover. Recovery requires a maintainer to inspect that
exact lock and its live writer, preserve the journal, and follow the existing
approval/review gate before any removal. Deleting the journal to reset usage is
not a recovery mechanism. The quota follows the system UTC date, so a same-user
clock change or offline file alteration is outside this model-only boundary.
This adds audit metadata only; the business data stays read-only.

Only a verified person can page the metadata through the existing review API:
`workspace.butlerReview('reads', { afterSequence: 0, limit: 20 })`. It returns
`{records, gaps, throughSequence, nextAfterSequence, truncated, storage}`. These positions
belong to the read log, independently of the suggestion ledger's sequence. Human log
reads do not consume model pages. The command is absent from the agent catalog;
an ordinary cross-session consent cannot grant it.

`storage` contains only `usedBytes`, `remindBytes`, `blocks`, `unreadableBlocks`
and a literal `warning` Boolean, true when `usedBytes` is past `remindBytes`. The
byte counts are the blocks' sizes as the manifest records them, not device free
space. `remindBytes` is the person's 0.5 GiB reminder line (2026-11-11), shared
with every record kept this way in `app/record-history.cjs`; past it the log keeps
recording. It is not a model option, a spending threshold or a time-to-full
estimate. There is no automatic archive, prune, rotation, deletion or counter reset.

### Kept whole, in blocks

The person, 2026-11-11: keep every record, split it into small blocks (for
example by day), and remind them past 30 days or 0.5 GiB; the butler's read log
is kept the same way. `history/butler-reads/` holds:

- blocks named by the global number of their first line and the UTC day they were
  opened (`000000001-2026-11-11.jsonl`). A sealed block has its byte count and
  SHA-256 in the manifest; only the last block is open.
- `manifest.json`: every block with its numbers, line count per UTC day, size,
  times, checksum and status (`open`, `sealed`, `unreadable`), written whole
  through a synced temporary file and rename. The day's page count is the sum of
  the manifest's counts for that day, so a page never rescans earlier blocks.
- `migration.json`, only while an older version's single file is being taken in.

An older version's `butler-business-reads.jsonl` is taken in on the first read or
write after the update: renamed unchanged into the folder as a sealed block,
numbered after everything already logged, its pages counted toward their days.
An older version does not know the folder: if the person goes back, it shows an
empty log and starts its own count for the day from zero in a new single file.
This version takes that file in on its next start and counts its pages toward
their days, so after coming back the day's allowance is not reset; while on the
older version it is. (No butler is connected in either version yet.) Lines of
a taken-in file are read back with the day's running count across the log, not
the older version's own. A stop between the steps of taking in is finished from
`migration.json` on the next start: a block already moved is checked against the
plan and committed (a file an older version started meanwhile is taken in after
it); a plan the older file outgrew before it was moved is dropped and the file
taken in as it is; with the file in neither place the log stops. Nothing is moved
or created over a file already in the folder. An older version's file with a line
cut short is not taken in: the log stops, as it stopped that version. A block is sealed when a page arrives on a later UTC day than the block
was opened on, or would take it past 32 MiB; a block opened for a page whose
write then failed is empty and is dropped rather than sealed.

A sealed block whose bytes no longer match its checksum, or that is missing, is
marked `unreadable` and reported to the person as a gap (`{fromSequence,
throughSequence, count, days}`) in its place; the other blocks read as usual and
the block itself is not touched. Put back exactly as it was sealed, it reads
again. A gap takes positions toward a read's limit, so paging still moves past
it. The open block is held to what this running instance last wrote: found
changed, the log fails closed for this instance (pages are withheld). A new
instance (NAW reopened) seals it if only its last line was cut short by a stop
during an append (that page was never released; the line is left as it is), moves
aside a block holding nothing but such a line, and otherwise sets it aside as
unreadable; the next page opens a new block. A missing manifest, or one that does
not parse, is built again from the blocks, which requires every block to read;
otherwise, and when the manifest cannot be opened safely, the log fails closed. A manifest changed consistently by another
program running as the person is not detected; this log is not tamper-proof.

A trusted host may supply `onCapacityWarning(storage)` when constructing
`ButlerReadAudit`. It receives a frozen copy of those same five fields, without
actor, query, body or filesystem paths. On the first successful record or
verified human read past the reminder line, the callback runs only after the
operation and lock cleanup succeed. Synchronous throws and rejected promises do
not change a successful audit/page outcome. It fires at most once per object;
a reconstructed object's first human read of an already large journal can warn
again. No timer or heartbeat is added, and rejected/failed calls emit no warning
event. No rejected/failed-attempt record type is added; a complete preparation
row left by an uncertain write still conservatively counts. The callback is an
optional host signal, not proof that the person saw a warning. The future runtime host must explicitly
inject its shared audit instance; this checkpoint changes no Main/UI entry.
`recordPage` keeps its existing preparation receipt. Business tool pages never
contain storage status or a log-reading capability.

Literal regression contracts pin the spaces/queue/deliveries page envelopes and
each kind of returned row, including rejected decision/failure metadata, nested
READY and queue-count fields. Adding a `reason`, `question` or other field requires
an explicit contract change. Blank or secret-shaped space names yield a metadata-
only unavailable row, leaving other space rows readable.

This checkpoint does not settle the separate automatic ledger-input questions
about member-derived decision titles or names. Their existing behavior is
unchanged while the person decides. Production context/tool qualification,
activation and the record period stay closed. The DSH transport still needs a
separate proof that this is its only tool outlet, with no generic catalog or
consent fallback.

Factory acceptance must also use a plain base Audit instance with its default
clock, with no host-supplied clock or overridden human `read` method. It must
prove that the business capability and person reader close over Main's sole
instance, rather than accepting a matching audit/directory pair from options.
These are future runtime acceptance conditions, not proven by source fixtures.
