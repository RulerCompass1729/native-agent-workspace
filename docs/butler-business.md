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
const business = new ButlerBusiness({ role, roomState, view });
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
in the private `butler-business-reads.jsonl`. The same lock checks the fixed
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
Quota exhaustion, missing durability, lock contention, unsafe paths and damaged
logs withhold the page. A failed write is never repaired by truncating old records.
The journal is capped at 32 MiB and each metadata line at 128 KiB; old data is not
automatically deleted. A stale lock after a crash remains a blocking condition;
there is no automatic takeover. Recovery requires a maintainer to inspect that
exact lock and its live writer, preserve the journal, and follow the existing
approval/review gate before any removal. Deleting the journal to reset usage is
not a recovery mechanism. The quota follows the system UTC date, so a same-user
clock change or offline file alteration is outside this model-only boundary.
This adds audit metadata only; the business data stays read-only.

Only a verified person can page the metadata through the existing review API:
`workspace.butlerReview('reads', { afterSequence: 0, limit: 20 })`. It returns
`{records, throughSequence, nextAfterSequence, truncated}`. These positions belong
to the read log, independently of the suggestion ledger's sequence. Human log
reads do not consume model pages. The command is absent from the agent catalog;
an ordinary cross-session consent cannot grant it.

Literal regression contracts pin each kind of returned row, including nested
READY and queue-count fields. Adding a `reason`, `question` or other field requires
an explicit contract change. Blank or secret-shaped space names yield a metadata-
only unavailable row, leaving other space rows readable.

This checkpoint does not settle the separate automatic ledger-input questions
about member-derived decision titles or names. Their existing behavior is
unchanged while the person decides. Production context/tool qualification,
activation and the record period stay closed. The DSH transport still needs a
separate proof that this is its only tool outlet, with no generic catalog or
consent fallback.
