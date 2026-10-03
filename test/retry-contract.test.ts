import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./harness.js";

for (const enabled of [false, true])
  test("real Pi retry contract: enabled=" + enabled, async () => {
    const events: string[] = [];
    const omissionsAtEnd: number[] = [];
    let terminalPersisted = false;
    const h = await harness({
      retry: enabled,
      factories: [
        (pi) => {
          pi.on("message_end", (e, ctx) => {
            if (e.message.role !== "assistant") return;
            events.push("message_end");
            terminalPersisted = ctx.sessionManager
              .getBranch()
              .some((x) => x.type === "message" && x.message === e.message);
          });
          pi.on("turn_end", (e) => {
            events.push("turn_end");
            assert(e.messageEntryId);
          });
          pi.on("agent_end", (e, ctx) => {
            events.push("extension_agent_end");
            assert(!("willRetry" in e));
            omissionsAtEnd.push(
              ctx.sessionManager
                .getBranch()
                .filter(
                  (e) => e.type === "context_edit" && e.replacement === null,
                ).length,
            );
          });
          pi.on("agent_settled", () => {
            events.push("settled");
          });
        },
      ],
    });
    try {
      const s = await h.make();
      const retries: boolean[] = [];
      s.subscribe((e) => {
        if (e.type === "agent_end") {
          retries.push(e.willRetry);
          events.push("public_agent_end");
        }
      });
      h.scripts.push(
        {
          reasoning: "complete",
          text: "committed prefix ".repeat(250),
          fail: true,
        },
        { text: "retry" },
      );
      await s.prompt("fixture");
      assert.equal(terminalPersisted, false);
      assert.deepEqual(retries, enabled ? [true, false] : [false]);
      assert.equal(h.payloads.length, enabled ? 2 : 1);
      assert.equal(omissionsAtEnd[0], 0);
      assert.equal(omissionsAtEnd.at(-1), enabled ? 1 : 0);
      assert(events.indexOf("message_end") < events.indexOf("turn_end"));
      assert(
        events.indexOf("extension_agent_end") <
          events.indexOf("public_agent_end"),
      );
      assert.equal(events.at(-1), "settled");
      if (enabled)
        assert(
          !JSON.stringify(h.payloads[1]!.input).includes("committed prefix"),
        );
    } finally {
      await h.close();
    }
  });

test("a boundary continuation is NOT Pi retry: bypasses retry.enabled=false", async () => {
  let requested = false;
  const h = await harness({
    retry: false,
    factories: [
      (pi) => {
        pi.on("agent_before_settle", (e) => {
          if (e.outcome === "error" && !requested) {
            requested = true;
            return {
              entries: [
                {
                  type: "custom_message",
                  customType: "fixture.recovery",
                  display: false,
                  content: "Continue the prior attempt.",
                },
              ],
              continue: true,
            };
          }
        });
      },
    ],
  });
  try {
    const s = await h.make();
    h.scripts.push({ text: "partial", fail: true }, { text: "continued" });
    await s.prompt("fixture");
    assert.equal(h.payloads.length, 2);
  } finally {
    await h.close();
  }
});
