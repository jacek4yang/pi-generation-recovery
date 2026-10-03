import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  appendFile,
  readFile,
  writeFile,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, readJournal } from "../src/journal.js";

test("committed records, Unicode, restrictive modes and truncated tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "generation-journal-"));
  try {
    const j = Journal.create(root, "session", "attempt");
    for (let n = 0; n < 200; n++) assert(j.append({ text: "中文🧪", n }));
    await j.close();
    assert(!j.failed);
    assert.equal((await readJournal(j.path)).length, 200);
    assert.equal((await stat(j.path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "session"))).mode & 0o777, 0o700);
    await appendFile(j.path, '{"n":200');
    assert.equal((await readJournal(j.path)).length, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("bounded overflow preserves earlier accepted records", async () => {
  const root = await mkdtemp(join(tmpdir(), "generation-journal-"));
  try {
    const j = Journal.create(root, "session", "attempt", {
      maxPendingBytes: 2048,
    });
    assert(j.append({ safe: true }));
    assert(!j.append({ large: "x".repeat(4096) }));
    await j.close();
    assert(j.failed);
    assert.equal((await readJournal(j.path)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("corrupt committed record fails closed; no overwrite of existing journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "generation-journal-"));
  try {
    const j = Journal.create(root, "session", "attempt");
    j.append({ safe: true });
    await j.close();
    const before = await readFile(j.path);
    const duplicate = Journal.create(root, "session", "attempt");
    duplicate.append({ other: true });
    await duplicate.close();
    assert(duplicate.failed);
    assert.deepEqual(await readFile(j.path), before);
    await writeFile(
      j.path,
      before.toString().replace('"safe":true', '"safe":false'),
    );
    await assert.rejects(readJournal(j.path), /Corrupt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("invalid paths and symlink reads are refused", async () => {
  assert.throws(
    () => Journal.create("/tmp", "../outside", "attempt"),
    /Unsafe/,
  );
  const root = await mkdtemp(join(tmpdir(), "generation-journal-"));
  try {
    await writeFile(join(root, "target"), "secret");
    await symlink(join(root, "target"), join(root, "link"));
    await assert.rejects(readJournal(join(root, "link")), /Unsafe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
