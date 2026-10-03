import test from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { assertSupportedPi, SUPPORTED_PI } from "../src/compatibility.js";
test("actual SDK version matches the audited lifecycle; other versions fail clearly", () => {
  assert.equal(VERSION, SUPPORTED_PI);
  assert.doesNotThrow(() => assertSupportedPi(VERSION));
  for (const version of ["0.99.0", "1.0.1", "1.1.0", "2.0.0", "1.0.0-beta"]) {
    assert.throws(() => assertSupportedPi(version), /Recovery is disabled/);
  }
});
