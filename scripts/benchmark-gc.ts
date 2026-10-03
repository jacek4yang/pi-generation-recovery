import { performance } from "node:perf_hooks";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectJournals, retentionConfig } from "../src/retention.js";
const root = await mkdtemp(join(tmpdir(), "gc-bench-"));
try {
  await mkdir(join(root, "session"));
  for (let i = 0; i < 1000; i++) {
    const path = join(root, "session", i + ".frames");
    await writeFile(path, "x".repeat(2048));
    await utimes(path, 0, 0);
  }
  const start = performance.now();
  const result = await collectJournals(root, retentionConfig({}));
  console.log(
    JSON.stringify({
      scope:
        "GC scan/stat/unlink only; fixture setup and model latency excluded",
      files: 1000,
      milliseconds: performance.now() - start,
      ...result,
    }),
  );
  if (result.gcDeletedFiles !== 1000 || result.gcFailures)
    throw new Error("GC benchmark failed");
} finally {
  await rm(root, { recursive: true, force: true });
}
