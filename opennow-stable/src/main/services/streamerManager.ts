import { app, BrowserWindow } from "electron";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  ExternalStreamerLaunchRequest,
  IceCandidatePayload,
  MainToRendererStreamerEvent,
  MainToRendererSignalingEvent,
  SendAnswerRequest,
} from "@shared/gfn";
import { IPC_CHANNELS } from "@shared/ipc";

interface StreamerControlMessage {
  type: string;
  [key: string]: unknown;
}

interface StreamerProcessMessage {
  type: "hello" | "log" | "state" | "answer" | "local-ice";
  pid?: number;
  level?: string;
  message?: string;
  state?: "idle" | "connecting" | "connected" | "disconnected" | "failed";
  detail?: string;
  sdp?: string;
  nvstSdp?: string;
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export class StreamerManager {
  private server: Server | null = null;
  private socket: Socket | null = null;
  private process: ChildProcess | null = null;
  private pendingReady: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
  private mode: "idle" | "legacy" | "external" = "idle";

  constructor(
    private readonly windowProvider: () => BrowserWindow | null,
    private readonly signalingHandlers: {
      sendAnswer: (payload: SendAnswerRequest) => Promise<void>;
      sendIceCandidate: (payload: IceCandidatePayload) => Promise<void>;
    },
  ) {}

  getAvailability(): { available: boolean; reason?: string } {
    const binaryPath = this.resolveBinaryPath();
    if (!existsSync(binaryPath)) {
      return { available: false, reason: `Missing opennow-streamer binary at ${binaryPath}` };
    }
    return { available: true };
  }

  setLegacyMode(): void {
    this.mode = "legacy";
  }

  async start(request: ExternalStreamerLaunchRequest): Promise<void> {
    const availability = this.getAvailability();
    if (!availability.available) {
      throw new Error(availability.reason ?? "Native streamer binary unavailable");
    }

    await this.stop();
    const port = await this.createControlServer();
    const binaryPath = this.resolveBinaryPath();
    this.mode = "external";
    this.emit({ type: "availability", available: true });
    this.emit({ type: "state", state: "connecting", detail: "launching native streamer" });

    const child = spawn(binaryPath, ["--control-url", `tcp://127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.process = child;

    child.stdout?.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) this.emit({ type: "log", level: "stdout", message });
    });

    child.stderr?.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) this.emit({ type: "log", level: "stderr", message });
    });

    child.once("exit", (code, signal) => {
      this.emit({
        type: "state",
        state: code === 0 ? "disconnected" : "failed",
        detail: `native streamer exited code=${code ?? "null"} signal=${signal ?? "null"}`,
      });
      this.cleanupSocket();
      this.process = null;
      this.mode = "idle";
    });

    await this.waitForReady();
    await this.sendControl({ type: "configure", session: request.session, settings: request.settings });
  }

  async stop(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      await this.sendControl({ type: "stop" }).catch(() => {});
    }
    this.cleanupSocket();
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
    }
    this.mode = "idle";
  }

  async forwardSignalingEvent(event: MainToRendererSignalingEvent): Promise<boolean> {
    if (this.mode !== "external") {
      return false;
    }

    if (event.type === "offer") {
      await this.sendControl({ type: "signaling-offer", sdp: event.sdp });
      return true;
    }

    if (event.type === "remote-ice") {
      await this.sendControl({
        type: "signaling-remote-ice",
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid ?? null,
        sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
      });
      return true;
    }

    if (event.type === "disconnected") {
      this.emit({ type: "state", state: "disconnected", detail: event.reason });
      return true;
    }

    if (event.type === "error") {
      this.emit({ type: "error", message: event.message });
      return true;
    }

    return false;
  }

  private resolveBinaryPath(): string {
    const __filename = fileURLToPath(import.meta.url);
    const mainDir = dirname(__filename);
    const suffix = process.platform === "win32" ? ".exe" : "";
    const candidates = [
      resolve(mainDir, `../../../../opennow-streamer/target/release/opennow-streamer${suffix}`),
      resolve(mainDir, `../../../../opennow-streamer/target/debug/opennow-streamer${suffix}`),
      join(process.resourcesPath, "bin", `opennow-streamer${suffix}`),
      resolve(app.getAppPath(), `../opennow-streamer/target/release/opennow-streamer${suffix}`),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  }

  private async createControlServer(): Promise<number> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
    }

    const server = createServer();
    this.server = server;
    server.on("connection", (socket) => {
      this.socket = socket;
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.handleProcessMessage(line);
          newline = buffer.indexOf("\n");
        }
      });
      socket.on("close", () => {
        this.socket = null;
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind native streamer control socket");
    }

    return address.port;
  }

  private waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReady = null;
        reject(new Error("Timed out waiting for native streamer handshake"));
      }, 10_000);
      this.pendingReady = { resolve, reject, timer };
    });
  }

  private cleanupSocket(): void {
    if (this.pendingReady) {
      clearTimeout(this.pendingReady.timer);
      this.pendingReady = null;
    }
    this.socket?.destroy();
    this.socket = null;
  }

  private async sendControl(message: StreamerControlMessage): Promise<void> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Native streamer control channel is not connected");
    }
    await new Promise<void>((resolve, reject) => {
      this.socket?.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  private handleProcessMessage(line: string): void {
    let parsed: StreamerProcessMessage;
    try {
      parsed = JSON.parse(line) as StreamerProcessMessage;
    } catch (error) {
      this.emit({ type: "error", message: `Invalid native streamer payload: ${String(error)}` });
      return;
    }

    if (parsed.type === "hello") {
      if (this.pendingReady) {
        clearTimeout(this.pendingReady.timer);
        this.pendingReady.resolve();
        this.pendingReady = null;
      }
      this.emit({ type: "log", level: "info", message: `native streamer connected pid=${parsed.pid ?? "unknown"}` });
      return;
    }

    if (parsed.type === "log") {
      this.emit({ type: "log", level: parsed.level ?? "info", message: parsed.message ?? "" });
      return;
    }

    if (parsed.type === "state") {
      this.emit({ type: "state", state: parsed.state ?? "connecting", detail: parsed.detail });
      return;
    }

    if (parsed.type === "answer" && parsed.sdp) {
      void this.signalingHandlers.sendAnswer({ sdp: parsed.sdp, nvstSdp: parsed.nvstSdp }).catch((error) => {
        this.emit({ type: "error", message: `Failed to forward native answer: ${String(error)}` });
      });
      return;
    }

    if (parsed.type === "local-ice" && parsed.candidate) {
      void this.signalingHandlers.sendIceCandidate({
        candidate: parsed.candidate,
        sdpMid: parsed.sdpMid,
        sdpMLineIndex: parsed.sdpMLineIndex,
      }).catch((error) => {
        this.emit({ type: "error", message: `Failed to forward native ICE: ${String(error)}` });
      });
    }
  }

  private emit(event: MainToRendererStreamerEvent): void {
    const window = this.windowProvider();
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.STREAMER_EVENT, event);
    }
  }
}
