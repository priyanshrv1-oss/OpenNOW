import { app, BrowserWindow, ipcMain } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const peerPreload = join(__dirname, "native-streamer-e2e-peer-preload.cjs");

const state = {
  peerReady: false,
  offer: null,
  nativeReady: false,
  nativeWindowId: null,
  nativeStreaming: false,
  nativeFrames: 0,
  nativeAudioBuffers: 0,
  reliablePackets: 0,
  partialPackets: 0,
  pendingInputSent: false,
  pendingWindowInput: false,
  logs: [],
};

let peerWindow;
let manager;

function log(message) {
  state.logs.push(message);
  console.log(message);
}

async function findNativeWindowId() {
  const display = process.env.DISPLAY;
  if (!display) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("xdotool", ["search", "--name", "OpenNOW Native Streamer"], {
      env: { ...process.env, DISPLAY: display },
    });
    return stdout.trim().split(/\s+/).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

async function sendNativeInput() {
  if (!state.nativeWindowId || !process.env.DISPLAY) {
    throw new Error("Native window not found for input verification");
  }
  await execFileAsync(
    "xdotool",
    [
      "windowactivate",
      "--sync",
      state.nativeWindowId,
      "mousemove",
      "--window",
      state.nativeWindowId,
      "120",
      "120",
      "mousemove_relative",
      "--sync",
      "18",
      "12",
      "keydown",
      "a",
      "keyup",
      "a",
      "click",
      "1",
    ],
    { env: { ...process.env, DISPLAY: process.env.DISPLAY } },
  );
}

async function maybeComplete() {
  if (!state.nativeStreaming || state.nativeFrames < 2 || state.nativeAudioBuffers < 3) {
    return;
  }
  if (state.reliablePackets < 1 || state.partialPackets < 1) {
    return;
  }
  log("native-streamer e2e verification complete");
  await manager.stop({ reason: "e2e complete" }).catch(() => {});
  await app.quit();
}

async function sendSyntheticNativeControlMessages() {
  if (!manager || state.pendingInputSent) {
    return;
  }
  state.pendingInputSent = true;
  log("sending synthetic control-plane input packets");
  manager.send({
    type: "input",
    payload: {
      kind: "keyboard",
      down: true,
      keycode: 0x41,
      scancode: 0x1e,
      modifiers: 0,
      timestamp_us: Date.now() * 1000,
    },
  });
  manager.send({
    type: "input",
    payload: {
      kind: "mouse_move",
      dx: 14,
      dy: 8,
      timestamp_us: Date.now() * 1000,
    },
  });
  manager.send({
    type: "input",
    payload: {
      kind: "mouse_button",
      down: true,
      button: 1,
      timestamp_us: Date.now() * 1000,
    },
  });
}

class LocalNativeStreamerManager {
  socketPath = null;
  server = null;
  socket = null;
  process = null;
  decodeBuffer = Buffer.alloc(0);

  constructor(onEvent, onAnswer, onIce) {
    this.onEvent = onEvent;
    this.onAnswer = onAnswer;
    this.onIce = onIce;
    this.handshakeReady = new Promise((resolve) => {
      this.resolveHandshakeReady = resolve;
    });
  }

  async start(request) {
    await this.stop("restart").catch(() => {});
    this.request = request;
    this.decodeBuffer = Buffer.alloc(0);
    this.socketPath = await this.createSocketPath();
    this.server = net.createServer((socket) => {
      this.socket = socket;
      socket.on("data", (chunk) => this.handleData(chunk));
      socket.on("close", () => {
        this.socket = null;
        this.onEvent({ type: "stopped", reason: "native socket closed" });
      });
    });
    await new Promise((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolvePromise);
    });
    const binary = this.resolveBinary();
    this.process = await import("node:child_process").then(({ spawn }) =>
      spawn(binary, ["--ipc-endpoint", this.socketPath], {
        cwd: resolve(__dirname, ".."),
        env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    this.process.stdout?.on("data", (chunk) => this.onEvent({ type: "log", level: "info", message: chunk.toString("utf8").trim() }));
    this.process.stderr?.on("data", (chunk) => this.onEvent({ type: "log", level: "warn", message: chunk.toString("utf8").trim() }));
  }

  async stop(reason = "stop") {
    if (this.socket) {
      this.send({ type: "stop_session", reason });
      this.socket.destroy();
      this.socket = null;
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    if (this.server) {
      await new Promise((resolvePromise) => this.server.close(() => resolvePromise()));
      this.server = null;
    }
    if (this.socketPath && process.platform !== "win32") {
      await rm(this.socketPath, { force: true }).catch(() => {});
    }
    this.socketPath = null;
  }

  async handleSignalingEvent(event) {
    if (!this.socket) {
      log(`manager dropped signaling event ${event.type}: socket not ready`);
      return;
    }
    if (event.type === "offer") {
      log(`manager forwarding offer (${event.sdp.length} chars)`);
      this.send({ type: "signaling_offer", sdp: event.sdp });
    } else if (event.type === "remote-ice") {
      log(`manager forwarding remote ICE ${event.candidate.candidate}`);
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

  async createSocketPath() {
    if (process.platform === "win32") {
      return `\\\\.\\pipe\\opennow-native-streamer-e2e-${randomUUID()}`;
    }
    const dir = join(app.getPath("userData"), "native-streamer-e2e");
    await mkdir(dir, { recursive: true });
    return join(dir, `${randomUUID()}.sock`);
  }

  resolveBinary() {
    const explicit = process.env.OPENNOW_NATIVE_STREAMER_BIN;
    if (explicit && existsSync(explicit)) {
      return explicit;
    }
    throw new Error("OPENNOW_NATIVE_STREAMER_BIN is required for e2e");
  }

  handleData(chunk) {
    this.decodeBuffer = Buffer.concat([this.decodeBuffer, chunk]);
    while (this.decodeBuffer.length >= 4) {
      const len = this.decodeBuffer.readUInt32BE(0);
      if (this.decodeBuffer.length < 4 + len) {
        return;
      }
      const payload = JSON.parse(this.decodeBuffer.subarray(4, 4 + len).toString("utf8"));
      this.decodeBuffer = this.decodeBuffer.subarray(4 + len);
      void this.handleNativeMessage(payload);
    }
  }

  async handleNativeMessage(message) {
    log(`native->manager ${message.type}`);
    if (message.type === "hello") {
      this.send({ type: "hello_ack", protocol_version: message.protocol_version, instance_id: "e2e" });
      this.send({
        type: "start_session",
        payload: {
          session: {
            session_id: this.request.session.sessionId,
            server_ip: this.request.session.serverIp,
            signaling_server: this.request.session.signalingServer,
            signaling_url: this.request.session.signalingUrl,
            zone: this.request.session.zone,
            streaming_base_url: null,
            ice_servers: [],
            media_connection_info: null,
            gpu_type: null,
          },
          settings: {
            resolution: this.request.settings.resolution,
            fps: this.request.settings.fps,
            max_bitrate_kbps: this.request.settings.maxBitrateMbps * 1000,
            codec: this.request.settings.codec,
            color_quality: this.request.settings.colorQuality,
            decoder_preference: this.request.settings.decoderPreference,
            mouse_sensitivity: this.request.settings.mouseSensitivity,
            mouse_acceleration: this.request.settings.mouseAcceleration,
          },
          window_title: "OpenNOW Native Streamer",
        },
      });
      this.resolveHandshakeReady?.();
      return;
    }
    if (message.type === "local_answer") {
      await this.onAnswer({ sdp: message.sdp });
      return;
    }
    if (message.type === "local_ice") {
      await this.onIce({
        candidate: message.candidate.candidate,
        sdpMid: message.candidate.sdp_mid,
        sdpMLineIndex: message.candidate.sdp_mline_index,
        usernameFragment: message.candidate.username_fragment,
      });
      return;
    }
    this.onEvent(message);
  }

  send(message) {
    if (!this.socket) {
      return;
    }
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    this.socket.write(frame);
  }
}

async function startNativeSession() {
  if (!state.peerReady || !state.offer || manager) {
    return;
  }

  manager = new LocalNativeStreamerManager(
    (payload) => void ipcMain.emit("e2e:native-event", null, payload),
    async ({ sdp }) => {
      log(`native answer received (${sdp.length} chars)`);
      peerWindow.webContents.send("e2e:answer", { sdp });
    },
    async (candidate) => {
      peerWindow.webContents.send("e2e:remote-ice", candidate);
    },
  );

  await manager.start({
    session: {
      sessionId: "local-e2e",
      status: 2,
      zone: "dev",
      serverIp: "127.0.0.1",
      signalingServer: "local",
      signalingUrl: "ws://local",
      iceServers: [],
    },
    settings: {
      resolution: "1280x720",
      fps: 30,
      maxBitrateMbps: 25,
      codec: "H264",
      colorQuality: "8bit_420",
      decoderPreference: "auto",
      mouseSensitivity: 100,
      mouseAcceleration: 100,
    },
  });

  await manager.handshakeReady;
  await manager.handleSignalingEvent({ type: "offer", sdp: state.offer });
}

ipcMain.on("e2e:peer-ready", async () => {
  state.peerReady = true;
  log("peer renderer ready");
  await startNativeSession();
});

ipcMain.on("e2e:offer", async (_event, payload) => {
  state.offer = payload.sdp;
  log(`peer offer created (${payload.sdp.length} chars)`);
  await startNativeSession();
});

ipcMain.on("e2e:peer-ice", async (_event, payload) => {
  if (!manager) {
    return;
  }
  await manager.handleSignalingEvent({
    type: "remote-ice",
    candidate: payload,
  });
});

ipcMain.on("e2e:peer-data", async (_event, payload) => {
  log(`peer data packet channel=${payload.channel} length=${payload.length}`);
  if (payload.channel === "input_channel_v1") {
    state.reliablePackets += 1;
  }
  if (payload.channel === "input_channel_partially_reliable") {
    state.partialPackets += 1;
  }
  log(`peer data packet channel=${payload.channel} reliable=${state.reliablePackets} partial=${state.partialPackets}`);
  await maybeComplete();
});

ipcMain.on("e2e:native-event", async (_event, payload) => {
  if (payload.type === "ready") {
    state.nativeReady = true;
    log("native process ready");
  }
  if (payload.type === "state") {
    log(`native state ${payload.state}${payload.detail ? ` (${payload.detail})` : ""}`);
    if (payload.state === "streaming") {
      state.nativeStreaming = true;
    }
  }
  if (payload.type === "log") {
    log(`native log [${payload.level}] ${payload.message}`);
  }
  if (payload.type === "stats") {
    state.nativeFrames = payload.stats.frames_rendered ?? payload.stats.framesRendered ?? 0;
    state.nativeAudioBuffers = payload.stats.audio_buffers ?? payload.stats.audioBuffers ?? 0;
    const inputPackets = payload.stats.input_packets_sent ?? payload.stats.inputPacketsSent ?? 0;
    log(`native stats frames=${state.nativeFrames} audio=${state.nativeAudioBuffers} input=${inputPackets}`);
    if (!state.nativeWindowId && !state.pendingWindowInput && state.nativeFrames > 0) {
      state.pendingWindowInput = true;
      state.nativeWindowId = await findNativeWindowId();
      log(`native window id ${state.nativeWindowId ?? "missing"}`);
      if (state.nativeWindowId) {
        log("sending synthetic window input via xdotool");
        await sendNativeInput();
        await sendSyntheticNativeControlMessages();
      }
    }
    await maybeComplete();
  }
  if (payload.type === "error") {
    log(`native error ${payload.code}: ${payload.message}`);
    throw new Error(`Native error ${payload.code}: ${payload.message}`);
  }
});

function peerHtml() {
  return `<!doctype html>
<html>
<body>
<script>
const log = (...args) => console.log("[peer]", ...args);
const pc = new RTCPeerConnection({ iceServers: [] });
const canvas = document.createElement("canvas");
canvas.width = 640;
canvas.height = 360;
document.body.appendChild(canvas);
const ctx = canvas.getContext("2d");
let tick = 0;
setInterval(() => {
  tick += 1;
  ctx.fillStyle = tick % 2 ? "#2563eb" : "#16a34a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.font = "48px sans-serif";
  ctx.fillText("OpenNOW native e2e", 40, 90);
  ctx.fillText(String(tick), 40, 160);
}, 33);
const videoStream = canvas.captureStream(30);
for (const track of videoStream.getTracks()) pc.addTrack(track, videoStream);
const audioContext = new AudioContext();
const oscillator = audioContext.createOscillator();
const gain = audioContext.createGain();
gain.gain.value = 0.08;
const destination = audioContext.createMediaStreamDestination();
oscillator.frequency.value = 440;
oscillator.connect(gain);
gain.connect(destination);
oscillator.start();
for (const track of destination.stream.getTracks()) pc.addTrack(track, destination.stream);
const bootstrapDataChannel = pc.createDataChannel("bootstrap");
bootstrapDataChannel.onopen = () => log("bootstrap data channel open");

pc.onicecandidate = (event) => {
  if (event.candidate) {
    window.e2e.send("e2e:peer-ice", {
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
      usernameFragment: event.candidate.usernameFragment,
    });
  }
};

pc.ondatachannel = (event) => {
  const channel = event.channel;
  log("remote data channel", channel.label);
  channel.binaryType = "arraybuffer";
  channel.onopen = () => {
    if (channel.label === "input_channel_v1") {
      channel.send(new Uint8Array([0x0e, 0x02, 0x03, 0x00]));
    }
  };
  channel.onmessage = (message) => {
    const bytes = message.data instanceof ArrayBuffer ? new Uint8Array(message.data) : new Uint8Array();
    window.e2e.send("e2e:peer-data", { channel: channel.label, length: bytes.length });
  };
};

window.e2e.on("e2e:answer", async ({ sdp }) => {
  await pc.setRemoteDescription({ type: "answer", sdp });
  log("remote answer applied");
});

window.e2e.on("e2e:remote-ice", async (candidate) => {
  try {
    await pc.addIceCandidate(candidate);
  } catch (error) {
    log("remote ICE error", String(error));
  }
});

(async () => {
  await audioContext.resume();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  window.e2e.send("e2e:peer-ready");
  window.e2e.send("e2e:offer", { sdp: offer.sdp });
})();
</script>
</body>
</html>`;
}

async function run() {
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
  await app.whenReady();
  peerWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: peerPreload,
      sandbox: false,
      contextIsolation: true,
    },
  });
  await peerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(peerHtml())}`);

  setTimeout(async () => {
    log("e2e timeout");
    await manager?.stop({ reason: "timeout" }).catch(() => {});
    app.exit(1);
  }, 30000);
}

run().catch((error) => {
  console.error(error);
  app.exit(1);
});
