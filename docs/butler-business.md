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
selection of the sole target, use this writable set. An explicit non-queue
business report may refer to a readable archive, without granting queue rights.
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
