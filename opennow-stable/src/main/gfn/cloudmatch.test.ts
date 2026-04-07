import test from "node:test";
import assert from "node:assert/strict";

import { normalizeMonitorSetting, normalizePrimaryMonitorSetting } from "./monitorSettings.ts";

test("normalizeMonitorSetting rejects incomplete or non-positive monitor settings", () => {
  assert.equal(normalizeMonitorSetting(undefined), undefined);
  assert.equal(normalizeMonitorSetting({ widthInPixels: 1920 }), undefined);
  assert.equal(normalizeMonitorSetting({ framesPerSecond: 60 }), undefined);
  assert.equal(normalizeMonitorSetting({ widthInPixels: 1920, heightInPixels: 1080, framesPerSecond: 0 }), undefined);
  assert.equal(normalizeMonitorSetting({ widthInPixels: 0, heightInPixels: 1080, framesPerSecond: 60 }), undefined);
});

test("normalizePrimaryMonitorSetting falls back when all session monitor entries are invalid", () => {
  const monitorSetting = normalizePrimaryMonitorSetting(
    [
      { widthInPixels: 1920 },
      { heightInPixels: 1080, framesPerSecond: 60 },
    ],
    {
      resolution: "2560x1440",
      fps: 120,
      maxBitrateMbps: 75,
      codec: "H264",
      colorQuality: "8bit_420",
      gameLanguage: "en_US",
      enableL4S: false,
    },
  );

  assert.equal(monitorSetting.widthInPixels, 2560);
  assert.equal(monitorSetting.heightInPixels, 1440);
  assert.equal(monitorSetting.framesPerSecond, 120);
});
