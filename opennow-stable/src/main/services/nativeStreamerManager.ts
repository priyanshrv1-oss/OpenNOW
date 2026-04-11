import { app, BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import type {
  IceCandidatePayload,
  MainToRendererNativeStreamerEvent,
  MainToRendererSignalingEvent,
  NativeStreamerStartRequest,
  NativeStreamerStopRequest,
  SendAnswerRequest,
} from "@shared/gfn";
import { IPC_CHANNELS } from "@shared/ipc";

interface NativeHelloMessage {
  type: "hello";
  protocol_version: number;
  process_id: number;
}

interface NativeHelloAckMessage {
  type: "hello_ack";
  protocol_version: number;
  instance_id: string;
}

type NativeControlMessage =
  | NativeHelloAckMessage
  | { type: "start_session"; payload: { session: unknown; settings: unknown; window_title: string } }
  | { type: "stop_session"; reason?: string | null }
  | { type: "signaling_offer"; sdp: string }
  | { type: "remote_ice"; candidate: { candidate: string; sdp_mid?: string | null; sdp_mline_index?: number | null; username_fragment?: string | null } }
  | { type: "ping" };

type NativeEventMessage =
  | { type: "ready" }
  | { type: "state"; state: MainToRendererNativeStreamerEvent extends infer T ? T extends { type: "state"; state: infer S } ? S : never : never; detail?: string | null }
  | { type: "local_answer"; sdp: string; nvst_sdp: string }
  | { type: "local_ice"; candidate: { candidate: string; sdp_mid?: string | null; sdp_mline_index?: number | null; username_fragment?: string | null } }
  | { type: "stats"; stats: { frames_rendered: number; audio_buffers: number; input_packets_sent: number; last_error?: string | null } }
  | { type: "log"; level: string; message: string }
  | { type: "error"; code: string; message: string; recoverable: boolean }
  | { type: "pong" };

export class NativeStreamerManager {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private process: ChildProcess | null = null;
  private socketPath: string | null = null;
  private decodeBuffer = Buffer.alloc(0);
  private startRequest: NativeStreamerStartRequest | null = null;
  private pendingHello = false;

  constructor(
    private readonly mainWindowProvider: () => BrowserWindow | null,
    private readonly sendAnswer: (payload: SendAnswerRequest) => Promise<void>,
    private readonly sendIceCandidate: (payload: IceCandidatePayload) => Promise<void>,
  ) {}

  async start(request: NativeStreamerStartRequest): Promise<void> {
    await this.stop({ reason: "restart" }).catch(() => {});
    this.startRequest = request;
    this.pendingHello = true;
    this.decodeBuffer = Buffer.alloc(0);

    const socketPath = await this.createSocketPath();
    this.socketPath = socketPath;
    this.server = net.createServer((socket) => {
      this.socket = socket;
      socket.on("data", (chunk) => this.handleData(chunk));
      socket.on("close", () => {
        this.socket = null;
        this.emit({ type: "stopped", reason: "native socket closed" });
      });
      socket.on("error", (error) => {
        this.emit({ type: "error", code: "socket_error", message: String(error), recoverable: false });
      });
    });

    await new Promise<void>((resolvePromise, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(socketPath, () => resolvePromise());
    });

    const binary = this.resolveBinary();
    const args = binary.endsWith("cargo")
      ? ["run", "--manifest-path", join(app.getAppPath(), "../opennow-native-streamer/Cargo.toml"), "--", "--ipc-endpoint", socketPath]
      : ["--ipc-endpoint", socketPath];

    const child = spawn(binary, args, {
      cwd: resolve(app.getAppPath(), ".."),
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG ?? "info",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.process = child;
    child.stdout?.on("data", (chunk) => {
      this.emit({ type: "log", level: "info", message: chunk.toString("utf8").trim() });
    });
    child.stderr?.on("data", (chunk) => {
      this.emit({ type: "log", level: "warn", message: chunk.toString("utf8").trim() });
    });
    child.once("exit", (code, signal) => {
      this.process = null;
      this.emit({ type: "stopped", reason: `native process exited (${code ?? "null"}/${signal ?? "none"})` });
    });
  }

  async stop(request: NativeStreamerStopRequest = {}): Promise<void> {
    if (this.socket) {
      this.send({ type: "stop_session", reason: request.reason ?? null });
      this.socket.destroy();
      this.socket = null;
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
    }
    if (this.socketPath && process.platform !== "win32") {
      await rm(this.socketPath, { force: true }).catch(() => {});
    }
    this.socketPath = null;
    this.startRequest = null;
    this.pendingHello = false;
  }

  async handleSignalingEvent(event: MainToRendererSignalingEvent): Promise<void> {
    if (!this.socket) {
      return;
    }
    if (event.type === "offer") {
      this.send({ type: "signaling_offer", sdp: event.sdp });
      return;
    }
    if (event.type === "remote-ice") {
      this.send({
        type: "remote_ice",
        candidate: {
          candidate: event.candidate.candidate,
          sdp_mid: event.candidate.sdpMid,
          sdp_mline_index: event.candidate.sdpMLineIndex,
          username_fragment: event.candidate.usernameFragment,
        },
      });
    }
  }

  private async handleNativeMessage(message: NativeEventMessage | NativeHelloMessage): Promise<void> {
    if (message.type === "hello") {
      this.send({ type: "hello_ack", protocol_version: message.protocol_version, instance_id: randomUUID() });
      if (this.startRequest) {
        this.send({
          type: "start_session",
          payload: {
            session: {
              session_id: this.startRequest.session.sessionId,
              server_ip: this.startRequest.session.serverIp,
              signaling_server: this.startRequest.session.signalingServer,
              signaling_url: this.startRequest.session.signalingUrl,
              zone: this.startRequest.session.zone,
              streaming_base_url: this.startRequest.session.streamingBaseUrl,
              ice_servers: this.startRequest.session.iceServers,
              media_connection_info: this.startRequest.session.mediaConnectionInfo
                ? { ip: this.startRequest.session.mediaConnectionInfo.ip, port: this.startRequest.session.mediaConnectionInfo.port }
                : null,
              gpu_type: this.startRequest.session.gpuType,
            },
            settings: {
              resolution: this.startRequest.settings.resolution,
              fps: this.startRequest.settings.fps,
              max_bitrate_kbps: this.startRequest.settings.maxBitrateMbps * 1000,
              codec: this.startRequest.settings.codec,
              color_quality: this.startRequest.settings.colorQuality,
              decoder_preference: this.startRequest.settings.decoderPreference,
              mouse_sensitivity: this.startRequest.settings.mouseSensitivity,
              mouse_acceleration: this.startRequest.settings.mouseAcceleration,
            },
            window_title: "OpenNOW Native Streamer",
          },
        });
      }
      this.pendingHello = false;
      return;
    }

    switch (message.type) {
      case "ready":
        this.emit({ type: "ready" });
        break;
      case "state":
        this.emit({ type: "state", state: message.state, detail: message.detail ?? undefined });
        break;
      case "local_answer":
        await this.sendAnswer({ sdp: message.sdp, nvstSdp: message.nvst_sdp });
        this.emit({ type: "local-answer", sdp: message.sdp, nvstSdp: message.nvst_sdp });
        break;
      case "local_ice":
        await this.sendIceCandidate({
          candidate: message.candidate.candidate,
          sdpMid: message.candidate.sdp_mid,
          sdpMLineIndex: message.candidate.sdp_mline_index,
          usernameFragment: message.candidate.username_fragment,
        });
        this.emit({
          type: "local-ice",
          candidate: {
            candidate: message.candidate.candidate,
            sdpMid: message.candidate.sdp_mid,
            sdpMLineIndex: message.candidate.sdp_mline_index,
            usernameFragment: message.candidate.username_fragment,
          },
        });
        break;
      case "stats":
        this.emit({
          type: "stats",
          stats: {
            framesRendered: message.stats.frames_rendered,
            audioBuffers: message.stats.audio_buffers,
            inputPacketsSent: message.stats.input_packets_sent,
            lastError: message.stats.last_error ?? null,
          },
        });
        break;
      case "log":
        this.emit({ type: "log", level: message.level, message: message.message });
        break;
      case "error":
        this.emit({ type: "error", code: message.code, message: message.message, recoverable: message.recoverable });
        break;
      case "pong":
        break;
    }
  }

  private handleData(chunk: Buffer): void {
    this.decodeBuffer = Buffer.concat([this.decodeBuffer, chunk]);
    while (this.decodeBuffer.length >= 4) {
      const len = this.decodeBuffer.readUInt32BE(0);
      if (this.decodeBuffer.length < 4 + len) {
        return;
      }
      const payload = this.decodeBuffer.subarray(4, 4 + len);
      this.decodeBuffer = this.decodeBuffer.subarray(4 + len);
      const parsed = JSON.parse(payload.toString("utf8")) as NativeEventMessage | NativeHelloMessage;
      void this.handleNativeMessage(parsed).catch((error) => {
        this.emit({ type: "error", code: "protocol_error", message: String(error), recoverable: false });
      });
    }
  }

  private send(message: NativeControlMessage): void {
    if (!this.socket) {
      return;
    }
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    this.socket.write(frame);
  }

  private emit(event: MainToRendererNativeStreamerEvent): void {
    const window = this.mainWindowProvider();
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.NATIVE_STREAMER_EVENT, event);
    }
  }

  private async createSocketPath(): Promise<string> {
    if (process.platform === "win32") {
      return `\\\\.\\pipe\\opennow-native-streamer-${randomUUID()}`;
    }
    const dir = join(app.getPath("userData"), "native-streamer");
    await mkdir(dir, { recursive: true });
    return join(dir, `${randomUUID()}.sock`);
  }

  private resolveBinary(): string {
    const explicit = process.env.OPENNOW_NATIVE_STREAMER_BIN;
    if (explicit && existsSync(explicit)) {
      return explicit;
    }
    const executableName = process.platform === "win32" ? "opennow-native-streamer.exe" : "opennow-native-streamer";
    const platformDir = `${process.platform}-${process.arch}`;
    const candidatePaths = app.isPackaged
      ? [
          join(process.resourcesPath, "native-streamer", platformDir, executableName),
          join(process.resourcesPath, "native-streamer", executableName),
        ]
      : [
          join(resolve(app.getAppPath(), ".."), "native-bin", platformDir, executableName),
          join(resolve(app.getAppPath(), ".."), "..", "opennow-native-streamer", "target", "release", executableName),
          join(resolve(app.getAppPath(), ".."), "..", "opennow-native-streamer", "target", "debug", executableName),
        ];
    for (const candidate of candidatePaths) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return process.platform === "win32" ? "cargo.exe" : "cargo";
  }
}
