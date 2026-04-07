import type { SessionMonitorSetting, StreamSettings } from "../../shared/gfn.ts";

function parseResolution(input: string): { width: number; height: number } {
  const [rawWidth, rawHeight] = input.split("x");
  const width = Number.parseInt(rawWidth ?? "", 10);
  const height = Number.parseInt(rawHeight ?? "", 10);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1920, height: 1080 };
  }

  return { width, height };
}

export function normalizeMonitorSetting(setting: Partial<SessionMonitorSetting> | undefined): SessionMonitorSetting | undefined {
  if (!setting) {
    return undefined;
  }

  const widthInPixels = Number(setting.widthInPixels);
  const heightInPixels = Number(setting.heightInPixels);
  const framesPerSecond = Number(setting.framesPerSecond);
  if (
    !Number.isFinite(widthInPixels) || widthInPixels <= 0 ||
    !Number.isFinite(heightInPixels) || heightInPixels <= 0 ||
    !Number.isFinite(framesPerSecond) || framesPerSecond <= 0
  ) {
    return undefined;
  }

  return {
    widthInPixels,
    heightInPixels,
    framesPerSecond,
    sdrHdrMode: Number(setting.sdrHdrMode ?? 0),
    displayData: setting.displayData
      ? {
          desiredContentMaxLuminance: Number(setting.displayData.desiredContentMaxLuminance ?? 0),
          desiredContentMinLuminance: Number(setting.displayData.desiredContentMinLuminance ?? 0),
          desiredContentMaxFrameAverageLuminance: Number(setting.displayData.desiredContentMaxFrameAverageLuminance ?? 0),
        }
      : undefined,
    dpi: typeof setting.dpi === "number" ? setting.dpi : undefined,
  };
}

export function buildMonitorSettingFromStreamSettings(settings: StreamSettings): SessionMonitorSetting {
  const { width, height } = parseResolution(settings.resolution);
  const hdrEnabled = false;

  return {
    widthInPixels: width,
    heightInPixels: height,
    framesPerSecond: settings.fps,
    sdrHdrMode: hdrEnabled ? 1 : 0,
    displayData: {
      desiredContentMaxLuminance: hdrEnabled ? 1000 : 0,
      desiredContentMinLuminance: 0,
      desiredContentMaxFrameAverageLuminance: hdrEnabled ? 500 : 0,
    },
    dpi: 100,
  };
}

export function normalizePrimaryMonitorSetting(
  monitorSettings: Array<Partial<SessionMonitorSetting>> | undefined,
  fallbackSettings?: StreamSettings,
): SessionMonitorSetting {
  const primary = monitorSettings?.map(normalizeMonitorSetting).find((entry) => entry !== undefined);
  if (primary) {
    return primary;
  }
  if (fallbackSettings) {
    return buildMonitorSettingFromStreamSettings(fallbackSettings);
  }
  return buildMonitorSettingFromStreamSettings({
    resolution: "1920x1080",
    fps: 60,
    maxBitrateMbps: 75,
    codec: "H264",
    colorQuality: "8bit_420",
    gameLanguage: "en_US",
    enableL4S: false,
  });
}
