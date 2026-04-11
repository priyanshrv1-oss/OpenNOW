import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const preload = join(import.meta.dirname, "native-streamer-e2e-peer-preload.cjs");

const state = {
  clientVideoTracks: 0,
  clientAudioTracks: 0,
  dataMessages: 0,
};

let clientWindow;
let peerWindow;

function log(message) {
  console.log(message);
}

async function assertNoNativeWindow() {
  if (!process.env.DISPLAY) {
    return;
  }
  try {
    await execFileAsync("xdotool", ["search", "--name", "OpenNOW Native Streamer"], {
      env: { ...process.env, DISPLAY: process.env.DISPLAY },
    });
    throw new Error("Native streamer window appeared during Chromium fallback verification");
  } catch (error) {
    if (String(error).includes("Native streamer window appeared")) {
      throw error;
    }
  }
}

async function maybeComplete() {
  if (state.clientVideoTracks < 1 || state.clientAudioTracks < 1 || state.dataMessages < 1) {
    return;
  }
  await assertNoNativeWindow();
  log("chromium fallback e2e verification complete");
  await app.quit();
}

ipcMain.on("e2e:peer-offer", (_event, payload) => {
  clientWindow.webContents.send("e2e:offer", payload);
});

ipcMain.on("e2e:peer-ice", (_event, payload) => {
  clientWindow.webContents.send("e2e:remote-ice", payload);
});

ipcMain.on("e2e:client-answer", (_event, payload) => {
  peerWindow.webContents.send("e2e:answer", payload);
});

ipcMain.on("e2e:client-ice", (_event, payload) => {
  peerWindow.webContents.send("e2e:remote-ice", payload);
});

ipcMain.on("e2e:client-video-track", async () => {
  state.clientVideoTracks += 1;
  log(`chromium client videoTracks=${state.clientVideoTracks}`);
  await maybeComplete();
});

ipcMain.on("e2e:client-audio-track", async () => {
  state.clientAudioTracks += 1;
  log(`chromium client audioTracks=${state.clientAudioTracks}`);
  await maybeComplete();
});

ipcMain.on("e2e:client-data", async (_event, payload) => {
  state.dataMessages += 1;
  log(`chromium client data channel=${payload.channel} count=${state.dataMessages}`);
  await maybeComplete();
});

const PEER_SCRIPT = `
(() => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  let tick = 0;
  setInterval(() => {
    tick += 1;
    ctx.fillStyle = tick % 2 ? "#7c3aed" : "#059669";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "48px sans-serif";
    ctx.fillText("Chromium fallback", 32, 96);
    ctx.fillText(String(tick), 32, 160);
  }, 33);
  const videoStream = canvas.captureStream(30);
  for (const track of videoStream.getTracks()) pc.addTrack(track, videoStream);
  const ac = new AudioContext();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  gain.gain.value = 0.05;
  const dest = ac.createMediaStreamDestination();
  osc.connect(gain);
  gain.connect(dest);
  osc.start();
  for (const track of dest.stream.getTracks()) pc.addTrack(track, dest.stream);
  const channel = pc.createDataChannel("browser_control");
  channel.onopen = () => channel.send("fallback-ok");
  pc.onicecandidate = (event) => {
    if (event.candidate) window.e2e.send("e2e:peer-ice", {
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
      usernameFragment: event.candidate.usernameFragment,
    });
  };
  window.e2e.on("e2e:answer", async ({ sdp }) => {
    await pc.setRemoteDescription({ type: "answer", sdp });
  });
  window.e2e.on("e2e:remote-ice", async (candidate) => {
    try { await pc.addIceCandidate(candidate); } catch {}
  });
  (async () => {
    await ac.resume();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    window.e2e.send("e2e:peer-offer", { sdp: offer.sdp });
  })();
})();
`;

const CLIENT_SCRIPT = `
(() => {
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  document.body.appendChild(video);
  const audio = document.createElement("audio");
  audio.autoplay = true;
  document.body.appendChild(audio);
  const pc = new RTCPeerConnection({ iceServers: [] });
  const remoteStream = new MediaStream();
  video.srcObject = remoteStream;
  audio.srcObject = remoteStream;
  pc.ontrack = (event) => {
    remoteStream.addTrack(event.track);
    if (event.track.kind === "video") {
      window.e2e.send("e2e:client-video-track", {});
    }
    if (event.track.kind === "audio") {
      window.e2e.send("e2e:client-audio-track", {});
    }
  };
  pc.ondatachannel = (event) => {
    event.channel.onmessage = () => window.e2e.send("e2e:client-data", { channel: event.channel.label });
  };
  pc.onicecandidate = (event) => {
    if (event.candidate) window.e2e.send("e2e:client-ice", {
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
      usernameFragment: event.candidate.usernameFragment,
    });
  };
  window.e2e.on("e2e:offer", async ({ sdp }) => {
    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    window.e2e.send("e2e:client-answer", { sdp: answer.sdp });
  });
  window.e2e.on("e2e:remote-ice", async (candidate) => {
    try { await pc.addIceCandidate(candidate); } catch {}
  });
})();
`;

async function run() {
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
  await app.whenReady();
  clientWindow = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: false, contextIsolation: true } });
  peerWindow = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: false, contextIsolation: true } });
  await clientWindow.loadURL("data:text/html,<html><body></body></html>");
  await peerWindow.loadURL("data:text/html,<html><body></body></html>");
  await clientWindow.webContents.executeJavaScript(CLIENT_SCRIPT);
  await peerWindow.webContents.executeJavaScript(PEER_SCRIPT);
  setTimeout(() => app.exit(1), 20000);
}

run().catch((error) => {
  console.error(error);
  app.exit(1);
});
