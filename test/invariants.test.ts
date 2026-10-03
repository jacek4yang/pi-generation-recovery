import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { generationRecovery } from "../src/recovery.js";
import { Journal, readJournal } from "../src/journal.js";
import { adapter, FrontierTracker } from "../src/state.js";
import { harness } from "./harness.js";

test("healthy wire input, tool exposure and visible result are unchanged", async () => {
  const inputs: string[] = [];
  for (const enabled of [false, true]) {
    let root = "";
    const h = await harness({
      factories: enabled ? [(pi) => generationRecovery({ root })(pi)] : [],
    });
    root = join(h.dir, "journals");
    try {
      const s = await h.make();
      h.scripts.push({ text: "healthy 🧪 response" });
      await s.prompt("fixture");
      assert.equal(h.payloads.length, 1);
      const p = h.payloads[0]!;
      inputs.push(
        JSON.stringify({
          input: p.input,
          tools: p.tools,
          instructions: p.instructions,
          model: p.model,
          reasoning: p.reasoning,
          include: p.include,
        }).replaceAll(h.dir, "<isolated>"),
      );
      assert.equal(
        s.messages
          .filter((m) => m.role === "assistant")
          .at(-1)
          ?.content.filter((c) => c.type === "text")
          .map((c) => c.text)
          .join(""),
        "healthy 🧪 response",
      );
    } finally {
      await h.close();
    }
  }
  assert.equal(inputs[0], inputs[1]);
});

test("raw observer is read-only, allowlisted and never promotes a summary delta", () => {
  const a = adapter("openai-codex-responses");
  const event = Object.freeze({
    type: "response.output_item.done",
    item: Object.freeze({
      type: "reasoning",
      id: "rs_fixture",
      encrypted_content: "opaque-fixture",
      authorization: "never-copy",
    }),
  });
  a.observe(event);
  a.observe(event);
  assert.equal(a.completedReasoning, 1);
  assert(!JSON.stringify(a).includes("never-copy"));
  assert(!JSON.stringify(a).includes("opaque-fixture"));
  const tracker = new FrontierTracker();
  tracker.accept({
    type: "thinking_start",
    contentIndex: 0,
    content: { type: "thinking", thinking: "" },
  });
  tracker.accept({
    type: "thinking_delta",
    contentIndex: 0,
    delta: "summary only",
  });
  assert.equal(tracker.candidate(a, true), "none");
  assert.equal(tracker.frontier, "PARTIAL_REASONING");
  const generic = adapter("anthropic-messages");
  generic.observe(event);
  assert.equal(generic.completedReasoning, 0);
  assert(!generic.capabilities.opaqueReasoningReplay);
});

test("journal roots cannot be symlinks and failures preserve the target", async () => {
  const root = await mkdtemp(join(tmpdir(), "generation-private-"));
  try {
    await writeFile(join(root, "target"), "private fixture");
    await symlink(join(root, "target"), join(root, "alias"));
    const j = Journal.create(join(root, "alias"), "session", "attempt");
    j.append({ frame: "fixture" });
    await j.close();
    assert(j.failed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new process recovers committed records after abrupt writer exit, without inventing settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "generation-crash-"));
  try {
    // Both source and packaged tests resolve their own installed Journal implementation.
    const module = import.meta.resolve("../src/journal.js");
    const path = module.endsWith(".js") ? module.slice(0, -3) + ".ts" : module;
    const code =
      "import {Journal,readJournal} from " +
      JSON.stringify(path) +
      ";const j=Journal.create(" +
      JSON.stringify(root) +
      ',"session","attempt");for(let n=0;n<20;n++)j.append({n});j.flush();for(let i=0;i<100;i++){try{if((await readJournal(j.path)).length===20)process.exit(0);}catch{}await new Promise(r=>setTimeout(r,10));}process.exit(1);';
    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      { timeout: 10000, stdio: "pipe" },
    );
    assert.equal(
      (await readJournal(join(root, "session", "attempt.frames"))).length,
      20,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
