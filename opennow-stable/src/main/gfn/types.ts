import type { SessionMonitorSetting } from "@shared/gfn";

import type { SessionError, SessionErrorInfo } from "./errorCodes";

export interface SessionRequestMetadataEntry {
  key: string;
  value: string;
}

export interface RequestedStreamingFeatures {
  reflex: boolean;
  bitDepth: number;
  cloudGsync: boolean;
  enabledL4S: boolean;
  mouseMovementFlags: number;
  trueHdr: boolean;
  supportedHidDevices: number;
  profile: number;
  fallbackToLogicalResolution: boolean;
  hidDevices: string | null;
  chromaFormat: number;
  prefilterMode: number;
  prefilterSharpness: number;
  prefilterNoiseReduction: number;
  hudStreamingMode: number;
  sdrColorSpace: number;
  hdrColorSpace: number;
}

export interface SessionRequestData {
  appId: string | number;
  internalTitle: string | null;
  availableSupportedControllers: number[];
  networkTestSessionId: string | null;
  parentSessionId: string | null;
  clientIdentification: string;
  deviceHashId: string;
  clientVersion: string;
  sdkVersion: string;
  streamerVersion: number;
  clientPlatformName: string;
  clientRequestMonitorSettings: SessionMonitorSetting[];
  useOps: boolean;
  audioMode: number;
  metaData: SessionRequestMetadataEntry[];
  sdrHdrMode: number;
  clientDisplayHdrCapabilities: {
    version: number;
    hdrEdrSupportedFlagsInUint32: number;
    staticMetadataDescriptorId: number;
  } | null;
  surroundAudioInfo: number;
  remoteControllersBitmap: number;
  clientTimezoneOffset: number;
  enhancedStreamMode: number;
  appLaunchMode: number;
  secureRTSPSupported: boolean;
  partnerCustomData: string;
  accountLinked: boolean;
  enablePersistingInGameSettings: boolean;
  userAge: number;
  requestedStreamingFeatures: RequestedStreamingFeatures;
}

export interface CloudMatchRequest {
  sessionRequestData: SessionRequestData;
}

export interface ClaimSessionRequestBody extends CloudMatchRequest {
  action: 2;
  data: "RESUME";
  metaData: SessionRequestMetadataEntry[];
}

export interface CloudMatchResponse {
  requestStatus: {
    statusCode: number;
    statusDescription?: string;
    unifiedErrorCode?: number;
  };
  session: {
    sessionId: string;
    status: number;
    queuePosition?: number;
    seatSetupInfo?: {
      seatSetupStep?: number;
      queuePosition?: number;
      seatSetupEta?: number;
    };
    progressState?: number;
    eta?: number;
    sessionProgress?: {
      queuePosition?: number;
      progressState?: number;
      eta?: number;
    };
    progressInfo?: {
      queuePosition?: number;
      progressState?: number;
      eta?: number;
    };
    errorCode?: number;
    gpuType?: string;
    connectionInfo?: Array<{
      ip?: string;
      port: number;
      usage: number;
      protocol?: number;
      resourcePath?: string;
    }>;
    sessionControlInfo?: {
      ip?: string;
    };
    iceServerConfiguration?: {
      iceServers?: Array<{
        urls: string[] | string;
        username?: string;
        credential?: string;
      }>;
    };
    sessionRequestData?: {
      clientRequestMonitorSettings?: Array<{
        widthInPixels?: number;
        heightInPixels?: number;
        framesPerSecond?: number;
      }>;
      requestedStreamingFeatures?: {
        bitDepth?: number;
        chromaFormat?: number;
        enabledL4S?: boolean;
      };
    };
    finalizedStreamingFeatures?: {
      bitDepth?: number;
      chromaFormat?: number;
      enabledL4S?: boolean;
    };
  };
}

/** Session in the get sessions response */
export interface SessionEntry {
  sessionId: string;
  status: number;
  gpuType?: string;
  sessionRequestData?: Partial<SessionRequestData>;
  sessionControlInfo?: {
    ip?: string;
  };
  connectionInfo?: Array<{
    ip?: string;
    port: number;
    usage: number;
    protocol?: number;
  }>;
  monitorSettings?: Array<Partial<SessionMonitorSetting>>;
}

/** Response from GET /v2/session (list of sessions) */
export interface GetSessionsResponse {
  requestStatus: {
    statusCode: number;
    statusDescription?: string;
    unifiedErrorCode?: number;
  };
  sessions: SessionEntry[];
}

// Re-export error types for convenience
export type { SessionError, SessionErrorInfo };

/** Result type for CloudMatch operations that may fail with a SessionError */
export type CloudMatchResult<T> =
  | { success: true; data: T }
  | { success: false; error: SessionError };

/** Error response structure from CloudMatch API */
export interface CloudMatchErrorResponse {
  requestStatus: {
    statusCode: number;
    statusDescription?: string;
    unifiedErrorCode?: number;
  };
  session?: {
    sessionId?: string;
    errorCode?: number;
  };
}

/** Entitled resolution from subscription features */
export interface EntitledResolution {
  width: number;
  height: number;
  fps: number;
}

/** Storage addon info */
export interface StorageAddon {
  type: "PERMANENT_STORAGE";
  sizeGb?: number;
  usedGb?: number;
  regionName?: string;
  regionCode?: string;
}

/** Subscription info from MES API */
export interface SubscriptionInfo {
  membershipTier: string;
  subscriptionType?: string;
  subscriptionSubType?: string;
  allottedHours: number;
  purchasedHours: number;
  rolledOverHours: number;
  usedHours: number;
  remainingHours: number;
  totalHours: number;
  firstEntitlementStartDateTime?: string;
  serverRegionId?: string;
  currentSpanStartDateTime?: string;
  currentSpanEndDateTime?: string;
  notifyUserWhenTimeRemainingInMinutes?: number;
  notifyUserOnSessionWhenRemainingTimeInMinutes?: number;
  state?: string;
  isGamePlayAllowed?: boolean;
  isUnlimited: boolean;
  storageAddon?: StorageAddon;
  entitledResolutions: EntitledResolution[];
}
