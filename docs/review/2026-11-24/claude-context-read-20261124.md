## The size and cache lifetime a context handoff is decided on (lane/claude-context-read-20261124)

Independent review of the change that hands over a large warm Claude session found two ways it could act on a conversation that is no longer that large or no longer cached. Both are in `compaction-count.cjs`; `queue-dispatch.cjs` is unchanged.

A size is now given only by a pass that read the record to its end, on a whole line. Before, a pass that stopped partway (48 MB of one record, 96 MB of all), one that had no budget left for this record, one that met a line still being written at the end, and one inside a line too long to read all gave the size known so far. That could be 190,000 tokens from before a compaction to 20,000. Without a size the member's item is done as usual and no handoff starts for this reason. Compactions are counted as before and can be below the truth while a large record is read.

A request that neither read nor wrote the cache has no lifetime: none from before it is kept, and the search for the last one written stops there. Before, such a request took the lifetime of a write hours earlier with its own time, and an expired cache looked warm. A request that only read keeps the lifetime last written. A record read whole and one read a piece at a time give the same result.

Tests: six new ones fail on the earlier code, one of them 60 synthetic records read whole and in random pieces against an expected value worked out line by line. 12 edits that break these rules each fail at least one test. The review's two reproductions and the further cases were also run through the planner: the earlier code hands over, this one gives the item. A large warm session whose record was read to its end is still handed over.

Limits: a size is taken at most every 30 seconds, as before. A compaction written after the last sample is not seen until the next, and a session that finishes and settles (8 seconds) within that time can still be handed over by the size from before it; reproduced at 22 seconds, gone at 30. After the app starts, a large record gives no size until it has been read through.
