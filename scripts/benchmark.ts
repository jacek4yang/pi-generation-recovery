import { performance } from "node:perf_hooks";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/journal.js";
const root = await mkdtemp(join(tmpdir(), "generation-bench-"));
try {
  const j = Journal.create(root, "session", "attempt");
  const start = performance.now();
  const count = 5000;
  for (let i = 0; i < count; i++) {
    if (
      !j.append({
        kind: "frame",
        frame: {
          type: "text_delta",
          contentIndex: 0,
          delta: "a small streamed delta ",
        },
      })
    )
      throw new Error("Journal budget exceeded");
    if (i % 128 === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await j.close();
  if (j.failed) throw new Error("Journal failed");
  const milliseconds = performance.now() - start;
  console.log(
    JSON.stringify({
      frames: count,
      milliseconds,
      microsecondsPerFrame: (milliseconds * 1000) / count,
      bytes: (await stat(j.path)).size,
      scope:
        "journal serialization/hash/append/terminal sync; not end-to-end generation latency",
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
