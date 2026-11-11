# B4 DeepSeek Pro pricing and metering

Verified 2026-11-10 America/Los_Angeles (2026-11-11 04:35 UTC), without an
inference request, credentials or account/balance access. This is a dated
reference and reminder proposal; it changes no setting and enables no runner.

## Official rates

Model ID: `deepseek-v4-pro`; the current table identifies
`DeepSeek-V4-Pro-0813`. USD per **1,000,000 tokens**:

| Component | Off-peak | Peak |
| --- | ---: | ---: |
| Input, cache hit | $0.022 | $0.044 |
| Input, cache miss | $0.66 | $1.32 |
| Output | $1.98 | $3.96 |

Peak windows are 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday, excluding
Chinese public holidays; other hours are off-peak. Recheck the schedule and
rates before activation. This is USD pricing, not a converted CNY tariff.
[Official pricing](https://api-docs.deepseek.com/quick_start/pricing/).

The changelog dates the peak/off-peak introduction to 2026-08-16 16:00 UTC.
It also says Pro service continued after September 14. An older September
release announcement proposed routing Pro to Flash; that is contradicted by
the current pricing table and updated continuation notice. Do not silently
substitute Flash or treat documentation as proof of the model actually served.
[Changelog](https://api-docs.deepseek.com/updates/),
[older announcement](https://api-docs.deepseek.com/news/news260910/).

## Count the complete response once

For Responses API accounting:

- `input_tokens` is total input; `input_tokens_details.cached_tokens` is its
  cache-hit subset. Misses are total minus hits, not total plus hits.
- `output_tokens` includes the `output_tokens_details.reasoning_tokens`
  subset. Do not charge the reasoning subset a second time.
- Use final `response.usage`; initial streaming events can contain null usage.
  Final completed, incomplete and failed events can carry usage. A missing
  terminal report is unknown, not free.
- `usage.server_tool_use.tool_search` and `.tool_fetch` count successful
  operations. One search call can contain multiple billable queries. With both
  counts zero the entire field is omitted; do not infer zero from an incomplete
  or unqualified native translation.

[Responses API fields](https://api-docs.deepseek.com/guides/responses_api/).
The cache is best-effort, so repeated text does not guarantee a hit.
[Caching](https://api-docs.deepseek.com/guides/kv_cache/).

Search and Fetch each cost **$0.75 per 1,000 successful requests**. Success
requires HTTP 200 and a result/content; failed, empty-search and timed-out
operations are not billed. Calls from Codex and other harnesses are included.
Count the actual server operations, not output-item count or number of returned
search results. B4 is supposed to have no such tools: verify zero, rather than
silently leaving these charges out. [Search & Fetch billing](https://api-docs.deepseek.com/guides/search/).

For one response at a known tariff:

```text
estimated USD = (cachedInput * hitRate
               + (input - cachedInput) * missRate
               + output * outputRate) / 1,000,000
               + (successfulSearches + successfulFetches) * 0.00075
```

Require finite nonnegative integer counts and `cachedInput <= input`.
Preserve the source, tariff date and original counters; round only for display,
or conservatively upwards when converting to integer micro-dollars for a gate.
Account for every request/retry, including failed attempts with usage. In the
Codex 0.167.1 [boundary fixture](../scripts/test-butler-native-boundaries.cjs),
two fixed responses of 20 tokens each produced native `total.totalTokens` of
20 then 40, while `last.totalTokens` stayed 20. These thread totals are
cumulative: never add successive cumulative snapshots. Qualify that mapping
again when the native version or transport changes.
Deduplicate using the actual response/attempt identity, retaining ambiguous
attempts as unknown. The final usage must come from the trusted transport,
never from the model's proposed JSON.

The official pages inspected do not establish whether a request crossing a
peak boundary uses start time, finish time or split billing. Do not invent that
rule. A peak-rate calculation can be labelled a conservative estimate under
this tariff, including when the holiday calendar is unavailable; it is not a
verified billed amount. Missing output/cache/price data remains unknown unless
a separately explicit conservative estimate is possible. Do not replace an
unknown amount with zero or assume all input received the cache discount.

## Proposed first recording-day reminder

Recommend **USD 2 per UTC day**, subject to the person's selection. It is a new
proposal, not the old experiment's amount and not the separate USD 1 finite
compatibility-trial cap. Until selected, leave the reminder unset and automatic
batches disabled.

Arithmetic scenario, not measured workload: 20,000 uncached input tokens plus
2,000 output tokens and no tools cost $0.03432 at peak or $0.01716 off-peak.
Fifty such requests cost $1.716 or $0.858; USD 2 leaves modest room for that
recording-day scenario. Long reasoning, retries or larger context can exhaust
it sooner. Revisit after the first authorized day's actual ledger, not by
extrapolating an old tool-free experiment.

At the threshold, notify once and stop **new automatic batches**. Already
running inference may still incur charges; this is not a hard account spending
cap, and it must not terminate or override a person's native session. The
current core accepts USD/UTC and checks the next-batch estimate as well as
known attempt costs; unknown usage blocks it. See
[`budgetReady`](../app/butler-controller.cjs) and the allowed usage fields in
[`normalizeUsage`](../app/butler-ledger.cjs).

## What remains unverified

Converting server-tool counts to billable operations remains an estimate until
the native/provider translation is qualified. The core ledger has token and cost fields but no native server-tool counter or
tariff fields. This document does not add a provider metering adapter. The B4
runner/core owner must qualify the actual native usage translation, retain
auditable tariff/counter provenance, verify tools are absent, and feed a trusted
estimated `costMicros` before automatic activation. A token-only native update
does not prove the full provider charge or a zero search count.

Official rates, schedules, model routing and usage schemas can change. No live
invoice, account currency, native Pro response or effective user reminder was
read. Native tool/context/network gates remain blocked as described in
[the boundary checkpoint](butler-native-boundaries.md). The one-turn trial
still requires the person's finite-budget approval and its technical gates;
price verification supplies neither.
