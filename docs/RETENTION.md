# Private journal retention

v0.2.0 defaults: **7 days** maximum inactive age and **1 GiB** total journal size. Configure `PI_GENERATION_RECOVERY_RETENTION_DAYS` and `PI_GENERATION_RECOVERY_MAX_TOTAL_BYTES` with nonnegative decimal integers. Zero disables that individual limit; both zero disable collection. Invalid or unsafe-integer values use the corresponding default and increment `gcFailures` on a collection run.

Collection runs at session start and at settled-agent boundaries, throttled to once per hour per extension instance. No frame/token handler scans the journal tree. It deletes expired inactive journals first (oldest first), then oldest inactive journals until observed size is below quota. Active journals and unresolved recovery journals have per-attempt PID leases and in-memory protection; **old inactive journals in the same long-lived session remain eligible**. Lease creation precedes journal creation, including after a session/branch change. Leases are released after settling or shutdown; stale leases left by a crashed process are removed on a later scan. PID reuse can conservatively retain a stale journal until that process exits.

## Safety and limits

Automatic GC is supported and tested on **Linux**. It anchors operations to open, no-follow directory descriptors via `/proc/self/fd`, including unlink, so replacing a directory with a symlink cannot redirect deletion. Node lacks a portable `unlinkat`; on other platforms GC fails closed with a local failure metric instead of attempting less-safe deletion. Recovery/capture may still function there, but v0.2.0 daily-driver storage validation is Linux-only. Use explicit manual retention on other platforms.

Directory/file permissions are 0700/0600 where supported. GC never reads journal contents, follows symlinks or recursively walks arbitrary subdirectories. It scans only expected session/attempt names, with at most 10,000 directory entries or two seconds of scan work per run. On partial scans it reports a failure but can still clean safely collected candidates from fully scanned sessions; later runs can make progress. Empty session directories and dead lease files are cleaned opportunistically.

This is a **best-effort quota**, not a filesystem hard limit: active data is never evicted, concurrency can change usage, scan limits can postpone work, and collection is hourly rather than continuous. If all remaining data is active, quota cannot be enforced until settlement. Each journal is independently capped at 32 MiB. No daemon, database, watcher, or per-token fsync.

`gcRuns`, `gcDeletedFiles`, `gcDeletedBytes`, and `gcFailures` are process-local counters. Bytes describe observed deleted journal sizes, not exact concurrent filesystem allocation. Missing files/races are tolerated; errors never break normal Pi generation. A failure to establish an active journal lease disables capture for that generation on Linux, rather than risking unprotected recovery data.

Retention never modifies Pi sessions or companion entries. Deleting old diagnostic journals does not change an already canonical assistant response. Restarting/reopening never authorizes recovery of an old interrupted generation. Protect backups as private session data and never upload journals to issues.
