import { app } from "electron";
import { accessSync, constants } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createServer,
  Socket,
  type AddressInfo,
  type Server,
} from "node:net";
import { join, resolve } from "node:path";

import type {
  IceCandidatePayload,
  MainToRendererSignalingEvent,
  NativeStreamerEvent,
  NativeStreamerLifecycleState,
  NativeStreamerStartRequest,
  NativeStreamerStateSnapshot,
  NativeStreamerStopRequest,
  SendAnswerRequest,
} from "@shared/gfn";

interface NativeStreamerManagerOptions {
  workspaceRoot: string;
  onAnswer: (payload: SendAnswerRequest) => Promise<void>;
  onLocalIceCandidate: (candidate: IceCandidatePayload) => Promise<void>;
}

interface NativeProtocolEnvelope {
  version: 1;
  type: string;
  payload?: Record<string, unknown>;
}

const PROTOCOL_VERSION = 1 as const;

export class NativeStreamerManager {
  private readonly listeners = new Set<(event: NativeStreamerEvent) => void>();
  private readonly workspaceRoot: string;
  private readonly onAnswer: (payload: SendAnswerRequest) => Promise<void>;
  private readonly onLocalIceCandidate: (candidate: IceCandidatePayload) => Promise<void>;

  private state: NativeStreamerStateSnapshot = {
    backend: "native-streamer",
    state: "idle",
    updatedAtMs: Date.now(),
  };

  private child: ChildProcess | null = null;
  private server: Server | null = null;
  private socket: Socket | null = null;
  private readBuffer = Buffer.alloc(0);
  private startPromise: Promise<NativeStreamerStateSnapshot> | null = null;
  private launchGeneration = 0;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly observedMessageTypes = new Set<string>();

  constructor(options: NativeStreamerManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.onAnswer = options.onAnswer;
    this.onLocalIceCandidate = options.onLocalIceCandidate;
  }

  onEvent(listener: (event: NativeStreamerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): NativeStreamerStateSnapshot {
    return { ...this.state };
  }

  async start(input: NativeStreamerStartRequest): Promise<NativeStreamerStateSnapshot> {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startInternal(input)
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.updateState("failed", "OpenNOW Native Streamer failed to start", message);
        await this.stop({ reason: "start-failed" });
        throw error;
      })
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  async stop(input: NativeStreamerStopRequest = {}): Promise<void> {
    this.launchGeneration += 1;

    try {
      this.send({
        version: PROTOCOL_VERSION,
        type: "disconnect",
        payload: {
          reason: input.reason ?? "stop-requested",
        },
      });
    } catch {
      // Ignore socket send errors during teardown.
    }

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        const server = this.server;
        this.server = null;
        if (!server) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    }

    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
    this.readBuffer = Buffer.alloc(0);
    this.observedMessageTypes.clear();

    this.updateState("idle", input.reason ?? "stopped");
  }

  async handleSignalingEvent(event: MainToRendererSignalingEvent): Promise<void> {
    switch (event.type) {
      case "connected":
        this.updateState("connecting", "Signaling connected");
        this.send({ version: PROTOCOL_VERSION, type: "signaling-connected" });
        return;
      case "offer":
        this.updateState("connecting", "Received offer from signaling server");
        this.send({
          version: PROTOCOL_VERSION,
          type: "signaling-offer",
          payload: { sdp: event.sdp },
        });
        return;
      case "remote-ice":
        this.send({
          version: PROTOCOL_VERSION,
          type: "signaling-remote-ice",
          payload: event.candidate as unknown as Record<string, unknown>,
        });
        return;
      case "disconnected":
        this.send({
          version: PROTOCOL_VERSION,
          type: "signaling-disconnected",
          payload: { reason: event.reason },
        });
        this.updateState("failed", "Signaling disconnected", event.reason);
        return;
      case "error":
        this.send({
          version: PROTOCOL_VERSION,
          type: "signaling-error",
          payload: { message: event.message },
        });
        this.updateState("failed", "Signaling error", event.message);
        return;
      case "log":
        this.emit({ type: "log", message: event.message });
        return;
    }
  }

  private async startInternal(input: NativeStreamerStartRequest): Promise<NativeStreamerStateSnapshot> {
    await this.stop({ reason: "restart" });

    const generation = ++this.launchGeneration;
    const executablePath = this.resolveExecutablePath();
    const server = createServer();
    this.server = server;

    this.updateState("launching", "Launching OpenNOW Native Streamer", undefined, executablePath);

    const serverReady = await new Promise<AddressInfo>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Native streamer IPC server failed to bind"));
          return;
        }
        resolve(address);
      });
    });

    const connectionPromise = new Promise<Socket>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for native streamer IPC connection"));
      }, 10000);

      server.once("connection", (socket) => {
        clearTimeout(timeout);
        resolve(socket);
      });
      server.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    const child = spawn(
      executablePath,
      [
        `--ipc-host=${serverReady.address}`,
        `--ipc-port=${serverReady.port}`,
        `--session-id=${input.session.sessionId}`,
      ],
      {
        cwd: this.workspaceRoot,
        env: {
          ...process.env,
          OPENNOW_NATIVE_STREAMER_PRODUCT_NAME: "OpenNOW Native Streamer",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child = child;

    child.stdout?.on("data", (chunk) => {
      this.emit({ type: "log", message: `[native stdout] ${chunk.toString("utf8").trim()}` });
    });
    child.stderr?.on("data", (chunk) => {
      this.emit({ type: "log", message: `[native stderr] ${chunk.toString("utf8").trim()}` });
    });

    const earlyExitPromise = new Promise<never>((_, reject) => {
      child.once("error", (error) => reject(error));
      child.once("exit", (code, signal) => {
        if (this.launchGeneration !== generation) {
          return;
        }
        reject(new Error(`OpenNOW Native Streamer exited before IPC handshake (code=${code ?? "null"}, signal=${signal ?? "null"})`));
      });
    });

    const socket = await Promise.race([connectionPromise, earlyExitPromise]);
    if (this.launchGeneration !== generation) {
      throw new Error("Native streamer launch superseded by a newer request");
    }

    this.socket = socket;
    this.readBuffer = Buffer.alloc(0);
    this.bindSocket(socket);

    await this.waitForMessage("hello", 10000);

    this.updateState("handshaking", "Sending session configuration to native streamer", undefined, executablePath);
    this.send({
      version: PROTOCOL_VERSION,
      type: "session-config",
      payload: {
        sessionId: input.session.sessionId,
        zone: input.session.zone,
        serverIp: input.session.serverIp,
        signalingServer: input.session.signalingServer,
        signalingUrl: input.session.signalingUrl,
        mediaConnectionIp: input.session.mediaConnectionInfo?.ip,
        mediaConnectionPort: input.session.mediaConnectionInfo?.port,
        iceServers: input.session.iceServers as unknown as Record<string, unknown>,
        resolution: input.settings.resolution,
        fps: input.settings.fps,
        maxBitrateMbps: input.settings.maxBitrateMbps,
        codec: input.settings.codec,
        colorQuality: input.settings.colorQuality,
        gameLanguage: input.settings.gameLanguage,
        enableL4S: input.settings.enableL4S,
        gameTitle: input.gameTitle ?? "Game",
        displayName: "OpenNOW Native Streamer",
      },
    });

    await this.waitForMessage("session-config-ack", 10000);
    this.updateState("ready", "OpenNOW Native Streamer is ready", undefined, executablePath);
    return this.getState();
  }

  private bindSocket(socket: Socket): void {
    socket.on("data", (chunk) => {
      this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
      this.drainMessages();
    });
    socket.on("close", () => {
      this.socket = null;
      if (this.state.state !== "idle") {
        this.updateState("exited", "OpenNOW Native Streamer socket closed");
      }
    });
    socket.on("error", (error) => {
      this.updateState("failed", "Native streamer IPC error", String(error));
    });
  }

  private drainMessages(): void {
    while (this.readBuffer.length >= 4) {
      const size = this.readBuffer.readUInt32BE(0);
      if (this.readBuffer.length < 4 + size) {
        return;
      }

      const payload = this.readBuffer.subarray(4, 4 + size);
      this.readBuffer = this.readBuffer.subarray(4 + size);

      try {
        const envelope = JSON.parse(payload.toString("utf8")) as NativeProtocolEnvelope;
        void this.handleMessage(envelope);
      } catch (error) {
        this.emit({ type: "log", message: `Failed to parse native streamer message: ${String(error)}` });
      }
    }
  }

  private async handleMessage(message: NativeProtocolEnvelope): Promise<void> {
    this.observedMessageTypes.add(message.type);
    switch (message.type) {
      case "hello":
        this.resolveWaiters("hello");
        this.emit({ type: "log", message: "OpenNOW Native Streamer connected" });
        return;
      case "session-config-ack":
        this.resolveWaiters("session-config-ack");
        this.emit({ type: "log", message: "OpenNOW Native Streamer acknowledged session config" });
        return;
      case "answer":
        if (message.payload?.sdp && typeof message.payload.sdp === "string") {
          await this.onAnswer({
            sdp: message.payload.sdp,
            nvstSdp:
              typeof message.payload.nvstSdp === "string"
                ? message.payload.nvstSdp
                : undefined,
          });
        }
        return;
      case "local-ice":
        if (message.payload?.candidate && typeof message.payload.candidate === "string") {
          await this.onLocalIceCandidate({
            candidate: message.payload.candidate,
            sdpMid:
              typeof message.payload.sdpMid === "string" || message.payload.sdpMid === null
                ? message.payload.sdpMid
                : undefined,
            sdpMLineIndex:
              typeof message.payload.sdpMLineIndex === "number" || message.payload.sdpMLineIndex === null
                ? message.payload.sdpMLineIndex
                : undefined,
            usernameFragment:
              typeof message.payload.usernameFragment === "string" || message.payload.usernameFragment === null
                ? message.payload.usernameFragment
                : undefined,
          });
        }
        return;
      case "state": {
        const state =
          typeof message.payload?.state === "string"
            ? (message.payload.state as NativeStreamerLifecycleState)
            : "ready";
        const messageText =
          typeof message.payload?.message === "string" ? message.payload.message : undefined;
        const detail =
          typeof message.payload?.detail === "string" ? message.payload.detail : undefined;
        this.updateState(state, messageText, detail, this.state.executablePath);
        return;
      }
      case "log":
        if (typeof message.payload?.message === "string") {
          this.emit({ type: "log", message: message.payload.message });
        }
        return;
      default:
        this.emit({ type: "log", message: `Unhandled native streamer message type: ${message.type}` });
    }
  }

  private async waitForMessage(type: string, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.observedMessageTypes.has(type)) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for native streamer message: ${type}`));
      }, timeoutMs);

      const resolver = (): void => {
        cleanup();
        resolve();
      };
      const set = this.waiters.get(type) ?? new Set<() => void>();
      set.add(resolver);
      this.waiters.set(type, set);

      const cleanup = (): void => {
        clearTimeout(timeout);
        const current = this.waiters.get(type);
        current?.delete(resolver);
        if (current && current.size === 0) {
          this.waiters.delete(type);
        }
      };
    });
  }

  private resolveWaiters(type: string): void {
    const set = this.waiters.get(type);
    if (!set || set.size === 0) {
      return;
    }

    this.waiters.delete(type);
    for (const resolver of set) {
      resolver();
    }
  }

  private send(envelope: NativeProtocolEnvelope): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Native streamer socket is not connected");
    }

    const payload = Buffer.from(JSON.stringify(envelope), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length, 0);
    this.socket.write(Buffer.concat([length, payload]));
  }

  private updateState(
    state: NativeStreamerLifecycleState,
    message?: string,
    detail?: string,
    executablePath?: string,
  ): void {
    this.state = {
      backend: "native-streamer",
      state,
      message,
      detail,
      pid: this.child?.pid,
      executablePath: executablePath ?? this.state.executablePath,
      updatedAtMs: Date.now(),
    };
    this.emit({ type: "state", state: this.getState() });
  }

  private emit(event: NativeStreamerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private resolveExecutablePath(): string {
    const envPath = process.env.OPENNOW_NATIVE_STREAMER_BIN?.trim();
    const executableName = process.platform === "win32" ? "opennow-native-streamer.exe" : "opennow-native-streamer";
    const repoRoot = resolve(this.workspaceRoot);
    const nativeProjectRoot = join(repoRoot, "opennow-native-streamer");
    const existenceFlag = process.platform === "win32" ? constants.F_OK : constants.X_OK;
    const packagedCandidates = [
      join(process.resourcesPath, "native-streamer", process.platform, executableName),
      join(process.resourcesPath, "opennow-native-streamer", "bin", executableName),
    ];
    const devCandidates = [
      join(nativeProjectRoot, "build", executableName),
      join(nativeProjectRoot, "build", "Release", executableName),
      join(nativeProjectRoot, "build", "Debug", executableName),
      join(nativeProjectRoot, "dist", executableName),
    ];

    const candidates = [
      ...(envPath ? [resolve(envPath)] : []),
      ...(app.isPackaged ? packagedCandidates : []),
      ...devCandidates,
    ];

    for (const candidate of candidates) {
      try {
        accessSync(candidate, existenceFlag);
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }

    throw new Error(
      `OpenNOW Native Streamer binary was not found. Expected it under ${nativeProjectRoot} (for example ${join(nativeProjectRoot, "build", executableName)}) or set OPENNOW_NATIVE_STREAMER_BIN.`,
    );
  }
}
