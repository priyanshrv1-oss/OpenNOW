import test from "node:test";
import assert from "node:assert/strict";

import { remapResumeAppLaunchMode } from "../../shared/gfn.ts";

test("remapResumeAppLaunchMode mirrors official resume remap", () => {
  assert.equal(remapResumeAppLaunchMode(2), 3);
  assert.equal(remapResumeAppLaunchMode(1), 2);
  assert.equal(remapResumeAppLaunchMode(0), 1);
  assert.equal(remapResumeAppLaunchMode(99), 1);
  assert.equal(remapResumeAppLaunchMode(undefined), 1);
});
