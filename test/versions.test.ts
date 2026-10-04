import test from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { assertRecoveryCapabilities } from "../src/compatibility.js";

test("CI SDK stays reproducible; host version labels do not gate capabilities", () => {
  if (process.env.PI_TEST_VERSION)
    assert.equal(VERSION, process.env.PI_TEST_VERSION);
  const api = Object.fromEntries(
    [
      "on",
      "appendEntry",
      "sendMessage",
      "getAllTools",
      "getActiveTools",
      "getThinkingLevel",
    ].map((key) => [key, () => {}]),
  );
  for (const version of [
    VERSION,
    "1.1.0",
    "2.0.0",
    "2.0.0-beta",
    "custom-build",
  ])
    assert.doesNotThrow(() => assertRecoveryCapabilities({ ...api, version }));
  assert.throws(
    () => assertRecoveryCapabilities({ ...api, sendMessage: undefined }),
    /requires Pi APIs: sendMessage/,
  );
  assert.throws(() => assertRecoveryCapabilities(null), /Recovery is disabled/);
});
