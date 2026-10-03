import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  utimes,
  rm,
  symlink,
  stat,
  readdir,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectJournals,
  protectJournal,
  retentionConfig,
} from "../src/retention.js";
const config = { days: 7, maxBytes: 20, invalid: false };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "recovery-gc-"));
  await mkdir(join(root, "session"));
  return {
    root,
    async file(id: string, days: number, size = 10) {
      await mkdir(join(root, "session"), { recursive: true });
      const path = join(root, "session", id + ".frames");
      await writeFile(path, "x".repeat(size), { mode: 0o600 });
      const time = Date.now() - days * 86400000;
      await utimes(path, time / 1000, time / 1000);
      return path;
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("retention config rejects invalid values; zero disables each bound", () => {
  assert.deepEqual(retentionConfig({}), {
    days: 7,
    maxBytes: 1073741824,
    invalid: false,
  });
  for (const v of [
    "-1",
    "NaN",
    "Infinity",
    "0.5",
    "",
    "999999999999999999999",
  ]) {
    assert(
      retentionConfig({ PI_GENERATION_RECOVERY_RETENTION_DAYS: v }).invalid,
    );
  }
  assert.equal(
    retentionConfig({ PI_GENERATION_RECOVERY_RETENTION_DAYS: "0" }).days,
    0,
  );
});
test("expiration then oldest quota; restart and truncated content need no parsing", async () => {
  const f = await fixture();
  try {
    await f.file("expired", 8);
    await f.file("old", 3);
    await f.file("new", 1);
    await f.file("newest", 0);
    const r = await collectJournals(f.root, config);
    assert.equal(r.gcDeletedFiles, 2);
    assert.equal(r.gcDeletedBytes, 20);
    assert.equal(r.gcFailures, 0);
    assert.deepEqual((await readdir(join(f.root, "session"))).sort(), [
      "new.frames",
      "newest.frames",
    ]);
    assert.equal((await collectJournals(f.root, config)).gcDeletedFiles, 0);
  } finally {
    await f.close();
  }
});
test("active session lease and explicit recovery protection survive quota", async () => {
  const f = await fixture();
  let release;
  try {
    const path = await f.file("active", 20);
    release = await protectJournal(f.root, "session", "active");
    await f.file("inactive-same-session", 20);
    assert.equal((await collectJournals(f.root, config)).gcDeletedFiles, 1);
    assert.equal((await stat(join(f.root, "session"))).mode & 0o777, 0o700);
    assert.equal((await collectJournals(f.root, config)).gcDeletedFiles, 0);
    await release();
    release = undefined;
    assert.equal(
      (
        await collectJournals(f.root, config, {
          protectedJournals: new Set(["session/active.frames"]),
        })
      ).gcDeletedFiles,
      0,
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await collectJournals(f.root, config)).gcDeletedFiles, 1);
  } finally {
    await release?.();
    await f.close();
  }
});
test("symlinks, replaced files, missing files and scan bounds fail safely", async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.frames"), "private");
    await symlink(outside, join(f.root, "linked"));
    await symlink(
      join(outside, "keep.frames"),
      join(f.root, "session", "link.frames"),
    );
    await f.file("race", 10);
    const r = await collectJournals(f.root, config, {
      beforeDelete: async (p) => {
        await rm(p);
        await symlink(join(outside, "keep.frames"), p);
      },
    });
    assert.equal(r.gcDeletedFiles, 0);
    assert.equal((await stat(join(outside, "keep.frames"))).size, 7);
    await f.file("gone", 10);
    assert.equal(
      (
        await collectJournals(f.root, config, {
          beforeDelete: async (p) => {
            await rm(p);
          },
        })
      ).gcFailures,
      0,
    );
    assert.equal(
      (await collectJournals(f.root, config, { maxEntries: 0 })).gcFailures,
      1,
    );
  } finally {
    await f.close();
  }
});
test("directory replacement cannot redirect unlink to a symlink target", async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "gc-outside-"));
  try {
    await f.file("old", 10);
    await writeFile(join(outside, "old.frames"), "keep");
    let swapped = false;
    const r = await collectJournals(f.root, config, {
      beforeDelete: async () => {
        if (!swapped) {
          swapped = true;
          await rename(join(f.root, "session"), join(f.root, "moved"));
          await symlink(outside, join(f.root, "session"));
        }
      },
    });
    assert.equal(r.gcDeletedFiles, 1);
    assert.equal((await stat(join(outside, "old.frames"))).size, 4);
    assert.equal(
      (await collectJournals(join(f.root, "session"), config)).gcFailures,
      1,
    );
  } finally {
    await f.close();
    await rm(outside, { recursive: true, force: true });
  }
});
test("I/O failure, missing roots, empty dirs, unlimited and stale crash leases", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await collectJournals(join(f.root, "missing"), config)).gcFailures,
      0,
    );
    assert.equal((await collectJournals(f.root, config)).gcDeletedFiles, 0);
    const path = await f.file("old", 10);
    assert.equal((await collectJournals(path, config)).gcFailures, 1);
    assert.equal(
      (await collectJournals(f.root, { days: 0, maxBytes: 0, invalid: false }))
        .gcDeletedFiles,
      0,
    );
    await writeFile(join(f.root, "session", ".active-2147483647-old"), "");
    assert.equal(
      (
        await collectJournals(f.root, config, {
          beforeDelete: async () => {
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          },
        })
      ).gcFailures,
      1,
    );
    assert.equal((await collectJournals(f.root, config)).gcDeletedFiles, 1);
  } finally {
    await f.close();
  }
});
