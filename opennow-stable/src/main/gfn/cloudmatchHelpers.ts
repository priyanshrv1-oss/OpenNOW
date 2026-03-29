import crypto from "node:crypto";

import type { SessionCreateRequest } from "@shared/gfn";
import {
  colorQualityBitDepth,
  colorQualityChromaFormat,
} from "@shared/gfn";
import {
  buildGfnHeaders,
  GFN_APP_LAUNCH_MODE,
  GFN_BROWSER_TYPE_CHROME,
  GFN_CLIENT_IDENTIFICATION,
  GFN_CLIENT_PLATFORM_NAME,
  GFN_CLIENT_STREAMER_CLASSIC,
  GFN_CLIENT_STREAMER_WEBRTC,
  GFN_CLIENT_TYPE_NATIVE,
  GFN_DEVICE_MAKE_UNKNOWN,
  GFN_DEVICE_MODEL_UNKNOWN,
  GFN_DEVICE_TYPE_DESKTOP,
  GFN_ENHANCED_STREAM_MODE,
  GFN_PLAY_ORIGIN,
  GFN_PLAY_REFERER,
  GFN_SDK_VERSION,
  GFN_SESSION_REQUEST_CLIENT_VERSION,
  GFN_STREAMER_VERSION,
  resolveGfnDeviceOs,
} from "@shared/gfnClient";

import type { CloudMatchRequest, CloudMatchResponse } from "./types";

export interface RequestHeadersOptions {
  token: string;
  clientId?: string;
  deviceId?: string;
  includeOrigin?: boolean;
  platform?: NodeJS.Platform;
}

export function streamingServerIp(response: CloudMatchResponse): string | null {
  const connections = response.session.connectionInfo ?? [];
  const sigConn = connections.find((conn) => conn.usage === 14);

  if (sigConn) {
    const rawIp = sigConn.ip;
    const directIp = Array.isArray(rawIp) ? rawIp[0] : rawIp;
    if (directIp && directIp.length > 0) {
      return directIp;
    }

    if (sigConn.resourcePath) {
      const host = extractHostFromUrl(sigConn.resourcePath);
      if (host) return host;
    }
  }

  const controlIp = response.session.sessionControlInfo?.ip;
  if (controlIp && controlIp.length > 0) {
    return Array.isArray(controlIp) ? controlIp[0] : controlIp;
  }

  return null;
}

export function extractHostFromUrl(url: string): string | null {
  const prefixes = ["rtsps://", "rtsp://", "wss://", "https://"];
  let afterProto: string | null = null;
  for (const prefix of prefixes) {
    if (url.startsWith(prefix)) {
      afterProto = url.slice(prefix.length);
      break;
    }
  }
  if (!afterProto) return null;

  const host = afterProto.split(":")[0]?.split("/")[0];
  if (!host || host.length === 0 || host.startsWith(".")) return null;
  return host;
}

export function isZoneHostname(ip: string): boolean {
  return ip.includes("cloudmatchbeta.nvidiagrid.net") || ip.includes("cloudmatch.nvidiagrid.net");
}

export function buildSignalingUrl(
  raw: string,
  serverIp: string,
): { signalingUrl: string; signalingHost: string | null } {
  if (raw.startsWith("rtsps://") || raw.startsWith("rtsp://")) {
    const withoutScheme = raw.startsWith("rtsps://")
      ? raw.slice("rtsps://".length)
      : raw.slice("rtsp://".length);
    const host = withoutScheme.split(":")[0]?.split("/")[0];
    if (host && host.length > 0 && !host.startsWith(".")) {
      return {
        signalingUrl: `wss://${host}/nvst/`,
        signalingHost: host,
      };
    }
    return {
      signalingUrl: `wss://${serverIp}:443/nvst/`,
      signalingHost: null,
    };
  }

  if (raw.startsWith("wss://")) {
    const withoutScheme = raw.slice("wss://".length);
    const host = withoutScheme.split("/")[0] ?? null;
    return { signalingUrl: raw, signalingHost: host };
  }

  if (raw.startsWith("/")) {
    return {
      signalingUrl: `wss://${serverIp}:443${raw}`,
      signalingHost: null,
    };
  }

  return {
    signalingUrl: `wss://${serverIp}:443/nvst/`,
    signalingHost: null,
  };
}

export function requestHeaders(options: RequestHeadersOptions): Record<string, string> {
  const clientId = options.clientId ?? crypto.randomUUID();
  const deviceId = options.deviceId ?? crypto.randomUUID();

  const platform = options.platform ?? process.platform;

  return buildGfnHeaders({
    authorization: { token: options.token },
    contentType: "application/json",
    clientId,
    clientStreamer: GFN_CLIENT_STREAMER_CLASSIC,
    clientType: GFN_CLIENT_TYPE_NATIVE,
    deviceMake: GFN_DEVICE_MAKE_UNKNOWN,
    deviceModel: GFN_DEVICE_MODEL_UNKNOWN,
    deviceOs: resolveGfnDeviceOs(platform),
    deviceType: GFN_DEVICE_TYPE_DESKTOP,
    browserType: GFN_BROWSER_TYPE_CHROME,
    deviceId,
    ...(options.includeOrigin !== false
      ? {
          origin: GFN_PLAY_ORIGIN,
          referer: GFN_PLAY_REFERER,
        }
      : {}),
  });
}

export function parseResolution(input: string): { width: number; height: number } {
  const [rawWidth, rawHeight] = input.split("x");
  const width = Number.parseInt(rawWidth ?? "", 10);
  const height = Number.parseInt(rawHeight ?? "", 10);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1920, height: 1080 };
  }

  return { width, height };
}

interface BuildSessionRequestBodyOptions {
  deviceHashId?: string;
  subSessionId?: string;
  now?: Date;
}

export function buildSessionRequestBody(
  input: SessionCreateRequest,
  options: BuildSessionRequestBodyOptions = {},
): CloudMatchRequest {
  const { width, height } = parseResolution(input.settings.resolution);
  const cq = input.settings.colorQuality;
  const hdrEnabled = false;
  const bitDepth = colorQualityBitDepth(cq);
  const chromaFormat = colorQualityChromaFormat(cq);
  const accountLinked = input.accountLinked ?? true;

  return {
    sessionRequestData: {
      appId: input.appId,
      internalTitle: input.internalTitle || null,
      availableSupportedControllers: [],
      networkTestSessionId: null,
      parentSessionId: null,
      clientIdentification: GFN_CLIENT_IDENTIFICATION,
      deviceHashId: options.deviceHashId ?? crypto.randomUUID(),
      clientVersion: GFN_SESSION_REQUEST_CLIENT_VERSION,
      sdkVersion: GFN_SDK_VERSION,
      streamerVersion: GFN_STREAMER_VERSION,
      clientPlatformName: GFN_CLIENT_PLATFORM_NAME,
      clientRequestMonitorSettings: [
        {
          widthInPixels: width,
          heightInPixels: height,
          framesPerSecond: input.settings.fps,
          sdrHdrMode: hdrEnabled ? 1 : 0,
          displayData: {
            desiredContentMaxLuminance: hdrEnabled ? 1000 : 0,
            desiredContentMinLuminance: 0,
            desiredContentMaxFrameAverageLuminance: hdrEnabled ? 500 : 0,
          },
          dpi: 100,
        },
      ],
      useOps: true,
      audioMode: 2,
      metaData: [
        { key: "SubSessionId", value: options.subSessionId ?? crypto.randomUUID() },
        { key: "wssignaling", value: "1" },
        { key: "GSStreamerType", value: GFN_CLIENT_STREAMER_WEBRTC },
        { key: "networkType", value: "Unknown" },
        { key: "ClientImeSupport", value: "0" },
        {
          key: "clientPhysicalResolution",
          value: JSON.stringify({ horizontalPixels: width, verticalPixels: height }),
        },
        { key: "surroundAudioInfo", value: "2" },
      ],
      sdrHdrMode: hdrEnabled ? 1 : 0,
      clientDisplayHdrCapabilities: hdrEnabled
        ? {
            version: 1,
            hdrEdrSupportedFlagsInUint32: 1,
            staticMetadataDescriptorId: 0,
          }
        : null,
      surroundAudioInfo: 0,
      remoteControllersBitmap: 0,
      clientTimezoneOffset: -(options.now ?? new Date()).getTimezoneOffset() * 60 * 1000,
      enhancedStreamMode: GFN_ENHANCED_STREAM_MODE,
      appLaunchMode: GFN_APP_LAUNCH_MODE,
      secureRTSPSupported: false,
      partnerCustomData: "",
      accountLinked,
      enablePersistingInGameSettings: true,
      userAge: 26,
      requestedStreamingFeatures: {
        reflex: input.settings.fps >= 120,
        bitDepth,
        cloudGsync: false,
        enabledL4S: input.settings.enableL4S,
        mouseMovementFlags: 0,
        trueHdr: hdrEnabled,
        supportedHidDevices: 0,
        profile: 0,
        fallbackToLogicalResolution: false,
        hidDevices: null,
        chromaFormat,
        prefilterMode: 0,
        prefilterSharpness: 0,
        prefilterNoiseReduction: 0,
        hudStreamingMode: 0,
        sdrColorSpace: 2,
        hdrColorSpace: hdrEnabled ? 4 : 0,
      },
    },
  };
}

export function cloudmatchUrl(zone: string): string {
  return `https://${zone}.cloudmatchbeta.nvidiagrid.net`;
}

export function resolveStreamingBaseUrl(zone: string, provided?: string): string {
  if (provided && provided.trim()) {
    const trimmed = provided.trim();
    return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  }
  return cloudmatchUrl(zone);
}

export function shouldUseServerIp(baseUrl: string): boolean {
  return baseUrl.includes("cloudmatchbeta.nvidiagrid.net");
}

export function resolvePollStopBase(zone: string, provided?: string, serverIp?: string): string {
  const base = resolveStreamingBaseUrl(zone, provided);
  if (serverIp && shouldUseServerIp(base) && !isZoneHostname(serverIp)) {
    return `https://${serverIp}`;
  }
  return base;
}
