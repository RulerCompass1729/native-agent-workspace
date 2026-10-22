# Daily competitor decision review

You are running the user's explicitly requested daily product review. Produce a
Chinese research report, not code changes. The outer runner saves your final
report and handles local archiving; do not write files, create schedules, modify
the product, publish, send messages to others, or actually abandon the project.

Read this repository's docs/product.md, the newest section of docs/interaction.md,
and the current status at the top of docs/readiness.md. Distinguish our implemented
and tested behavior from intended capabilities. The product is a local human-first
GUI/TUI workspace for native Claude/Codex sessions and their native fleets, usable
solo or in controlled collaboration without implicit model calls or history sharing.

Keep context acquisition small: cap initial repository excerpts at 12,000
characters total, taking only current sections, not entire historical documents.
If shared rules require memory lookup, search its index and read only the latest
relevant section (at most 4,000 characters), never the full historical project
memory. Do not inspect launchd jobs, scheduler implementation, private runtime
directories, native session logs, or unrelated files. The outer runner supplies
the previous report below when one exists; if none is supplied, treat this as the
baseline review, and do not search the filesystem for a missing previous report.
Avoid rereading unchanged excerpts. Reserve time and context for external evidence.

Every run must include both open discovery and existing-competitor follow-up:

- Search GitHub and the broader web for new/recent alternatives, including official
  provider apps, open-source projects and commercial desktop tools. Vary queries
  around user jobs (native session continuity, terminal/chat parity, collaboration,
  transparent context and cost), not only known product names. Do not freeze the
  competitor universe to a watchlist. Record discovered candidates or explicitly
  report no relevant new discovery with the queries/coverage used.
- Follow known competitors' releases, actual implementation and user issues.
  Initial leads include Orca, Codewhale, Nimbalyst, Superset and the native provider
  products, but these are seeds, not a closed set. Rotate deeper follow-up so a
  quiet incumbent does not consume every day's research. Revisit strong threats
  first. Preserve an evolving compact watchlist and last checked dates in the report.
- Start from the previous report, check what changed, and avoid re-researching
  unchanged facts. Target 4–6 search queries, up to 12 substantive source reads and
  at most 2 deep code investigations. This is a research budget, not a completeness
  guarantee. A 12-minute process deadline is enforced externally; finish a useful
  bounded report rather than chase exhaustive coverage. Do not launch paid provider
  tests or install competitors. Use at most one short independent review agent,
  only for checking the gathered evidence and conclusion, without new research.
  Do not create a researcher team. If unavailable, mark independent review pending.
  One research task may contain multiple model requests: the deadline is not a
  monetary cap. Do not claim an exact token or monetary cost without telemetry.
- Prefer primary sources. Separate announced, shipped, source-confirmed and actually
  tested evidence. Inspect relevant source before making code-level claims. Link
  exact files/commits or dated releases. Issues are reported experiences, not proof
  of current bugs or prevalence. Do not treat GitHub stars or feature counts as
  product superiority. A search failure is uncertainty, not evidence of no threat.
- Assess the same user workflow end-to-end: existing session identity/fleet,
  bidirectional native/GUI input, intermediate output, human interruption, directed
  collaboration, private context, visible delivery/cost, usability and recovery.
  Find reusable components and their license/compatibility constraints; do not copy
  code or declare reuse safe solely from a repository license badge.

Start with exactly one plain line:
结论：继续 / 收窄 / 转向 / 建议停止 / 证据不足
(Choose ONE value, not the entire list.)

Use these section labels: 发现与变化, 重合与价值, 下一步, 未知与审查, 跟踪名单.
Include at least two primary HTTPS links for an actionable decision. Then give:
today's material changes and new candidates; evidence of overlap and
remaining user value; whether extending/contributing to an existing project would
save effort; one priority implication for our current development; confidence and
unknowns; independent review status; primary links; compact evolving watchlist.
Aim for 800–1400 Chinese characters plus sources/watchlist; do not repeat generic
marketing or invent precise overlap scores. A short low-change report is valid.

Recommend stopping only if evidence shows one or more accessible alternatives
reliably cover the core user workflow, our remaining advantage is not material,
and adapting or contributing to them is credibly cheaper than continuing. Explain
the best argument against that conclusion. Substantial overlap alone is not a
stop condition. Missing evidence must lower confidence, not turn into an optimistic
claim. Any stop/pivot is a recommendation for the human, never permission to delete,
archive, close, or stop the user's project automatically.
