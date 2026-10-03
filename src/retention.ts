import { constants } from "node:fs";
import {
  mkdir,
  open,
  lstat,
  opendir,
  unlink,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

export interface Retention {
  days: number;
  maxBytes: number;
  invalid: boolean;
}
export function retentionConfig(
  env: NodeJS.ProcessEnv = process.env,
): Retention {
  let invalid = false;
  function value(name: string, fallback: number) {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      invalid = true;
      return fallback;
    }
    return Number(raw);
  }
  return {
    days: value("PI_GENERATION_RECOVERY_RETENTION_DAYS", 7),
    maxBytes: value("PI_GENERATION_RECOVERY_MAX_TOTAL_BYTES", 1073741824),
    get invalid() {
      return invalid;
    },
  };
}
export interface GcResult {
  gcRuns: number;
  gcDeletedFiles: number;
  gcDeletedBytes: number;
  gcFailures: number;
}
const safe = /^[a-zA-Z0-9_-]{1,128}$/;
function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
// Anchor every operation to open directory descriptors, not replaceable parent paths.
// Node has no portable unlinkat: unsupported hosts fail closed rather than risk following links.
async function directory(
  path: string,
): Promise<{ handle: FileHandle; path: string }> {
  if (process.platform !== "linux")
    throw new Error("Descriptor-anchored GC requires Linux");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  return { handle, path: `/proc/self/fd/${handle.fd}` };
}
export async function protectJournal(
  root: string,
  session: string,
  attempt: string,
): Promise<() => Promise<void>> {
  if (!safe.test(session) || !safe.test(attempt))
    throw new Error("Unsafe session identity");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await directory(root);
  try {
    await dir.handle.chmod(0o700);
    await mkdir(join(dir.path, session), { mode: 0o700 }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    const child = await directory(join(dir.path, session));
    try {
      await child.handle.chmod(0o700);
      const name = `.active-${process.pid}-${attempt}`;
      const lease = join(child.path, name);
      const f = await open(
        lease,
        constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      await f.close();
      await child.handle.close();
      return async () => {
        const r = await directory(root);
        try {
          const c = await directory(join(r.path, session));
          try {
            await unlink(join(c.path, name)).catch((e) => {
              if (!missing(e)) throw e;
            });
          } finally {
            await c.handle.close();
          }
        } finally {
          await r.handle.close();
        }
      };
    } catch (e) {
      await child.handle.close();
      throw e;
    }
  } finally {
    await dir.handle.close();
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
/** Best effort, bounded two-level scan; never reads journal contents or follows symlinks. */
export async function collectJournals(
  root: string,
  config: Retention,
  options: {
    protectedJournals?: ReadonlySet<string>;
    now?: number;
    maxEntries?: number;
    beforeDelete?: (path: string) => Promise<void>;
  } = {},
): Promise<GcResult> {
  const result: GcResult = {
    gcRuns: 1,
    gcDeletedFiles: 0,
    gcDeletedBytes: 0,
    gcFailures: config.invalid ? 1 : 0,
  };
  if (!config.days && !config.maxBytes) return result;
  const now = options.now ?? Date.now();
  let scanned = 0;
  const started = Date.now();
  const handles: FileHandle[] = [];
  const candidates: {
    path: string;
    size: number;
    mtime: number;
    ino: number;
    dev: number;
  }[] = [];
  let total = 0;
  const bound = () => {
    if (
      ++scanned > (options.maxEntries ?? 10000) ||
      Date.now() - started > 2000
    )
      throw new Error("GC scan bound");
  };
  try {
    const rootDir = await directory(root);
    handles.push(rootDir.handle);
    try {
      const dirs = await opendir(rootDir.path);
      for await (const entry of dirs) {
        bound();
        if (!entry.isDirectory() || !safe.test(entry.name)) continue;
        const d = await directory(join(rootDir.path, entry.name));
        handles.push(d.handle);
        const records: typeof candidates = [];
        const protectedNames = new Set<string>();
        let hasEntries = false;
        for await (const file of await opendir(d.path)) {
          bound();
          const lease = /^\.active-(\d+)-([-a-zA-Z0-9_]{1,128})$/.exec(
            file.name,
          );
          if (lease && alive(Number(lease[1])))
            protectedNames.add(lease[2] + ".frames");
          else if (lease && file.isFile()) {
            await unlink(join(d.path, file.name)).catch((e) => {
              if (!missing(e)) result.gcFailures++;
            });
            continue;
          }
          hasEntries = true;
          if (
            !file.isFile() ||
            !/^[-a-zA-Z0-9_]{1,128}\.frames$/.test(file.name)
          )
            continue;
          const path = join(d.path, file.name);
          try {
            const s = await lstat(path);
            if (s.isFile() && !s.isSymbolicLink()) {
              records.push({
                path,
                size: s.size,
                mtime: s.mtimeMs,
                ino: s.ino,
                dev: s.dev,
              });
              total += s.size;
            }
          } catch (e) {
            if (!missing(e)) throw e;
          }
        }
        if (!hasEntries)
          await rmdir(join(rootDir.path, entry.name)).catch((e) => {
            if (!missing(e) && e.code !== "ENOTEMPTY") result.gcFailures++;
          });
        candidates.push(
          ...records.filter((r) => {
            const name = r.path.slice(r.path.lastIndexOf("/") + 1);
            return (
              !protectedNames.has(name) &&
              !options.protectedJournals?.has(entry.name + "/" + name)
            );
          }),
        );
      }
    } catch (e) {
      if (!missing(e)) result.gcFailures++;
    }
    candidates.sort(
      (a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path),
    );
    for (const c of candidates) {
      if (
        !(config.days && now - c.mtime > config.days * 86400000) &&
        !(config.maxBytes && total > config.maxBytes)
      )
        continue;
      try {
        await options.beforeDelete?.(c.path);
        const s = await lstat(c.path);
        if (
          !s.isFile() ||
          s.isSymbolicLink() ||
          s.ino !== c.ino ||
          s.dev !== c.dev ||
          s.mtimeMs !== c.mtime ||
          s.size !== c.size
        )
          continue;
        await unlink(c.path);
        total -= c.size;
        result.gcDeletedFiles++;
        result.gcDeletedBytes += c.size;
      } catch (e) {
        if (!missing(e)) result.gcFailures++;
      }
    }
  } catch (e) {
    if (!missing(e)) result.gcFailures++;
  } finally {
    for (const h of handles)
      await h.close().catch(() => {
        result.gcFailures++;
      });
  }
  return result;
}
