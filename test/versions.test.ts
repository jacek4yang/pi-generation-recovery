import test from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { assertSupportedPi, SUPPORTED_PI } from "../src/compatibility.js";
test("actual SDK version matches the audited lifecycle; other versions fail clearly", () => {
  assert.equal(SUPPORTED_PI, "1.0.1");
  if (process.env.PI_TEST_VERSION)
    assert.equal(VERSION, process.env.PI_TEST_VERSION);
  for (const version of [VERSION, "1.0.1"])
    assert.doesNotThrow(() => assertSupportedPi(version));
  for (const version of [
    "0.99.0",
    "1.0.0",
    "1.0.2",
    "1.1.0",
    "2.0.0",
    "1.0.0-beta",
    "1.0.1-beta",
  ]) {
    assert.throws(() => assertSupportedPi(version), /Recovery is disabled/);
  }
});
