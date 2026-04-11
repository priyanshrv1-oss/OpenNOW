# OpenNOW Native Streamer

`OpenNOW Native Streamer` is the standalone Rust native streaming backend for OpenNOW. It runs as a separate process and opens its own native window titled `OpenNOW Native Streamer`.

## Why Rust + GStreamer

- Rust keeps the control plane explicit, typed, and maintainable across Windows, macOS, Linux, and Linux ARM.
- GStreamer provides the real media transport/decoding backbone for the native path.
- The process split keeps the existing Electron/Chromium path intact as a fallback while allowing a real native transport and window.

## Ownership split

- Electron main process owns CloudMatch session creation, polling, claiming, stopping, and the NVST signaling WebSocket.
- This Rust process owns the native window, WebRTC media runtime, audio/video playback, and native input transport.
- Electron main and the native process communicate over a framed JSON IPC channel over a local Unix socket or named pipe.

## Native path

Implemented here:

- framed JSON IPC handshake and control protocol
- GFN SDP helpers for public-IP extraction, server-IP fixing, codec preference, H.265 normalization, answer munging, NVST SDP generation, and partial-reliability parsing
- GStreamer `webrtcbin` offer/answer handling and ICE forwarding
- manual ICE candidate injection from `mediaConnectionInfo`
- separate native window titled `OpenNOW Native Streamer`
- decoded video rendering into the native window via GTK4 `Picture`
- audio playback through a native audio sink
- keyboard, mouse, wheel, and controller/gamepad input capture and packet transmission over native data channels

When `enableNativeStreamer` is `false`, OpenNOW keeps using the existing Chromium/WebRTC renderer path unchanged. When it is `true`, Electron main launches this separate process/window and forwards signaling over the local IPC channel.

Deferred / known limitations:

- microphone parity is still out of scope in this task
- screenshot / recording migration stays on the Electron/browser path
- hardware-decoder selection is still capability-driven and platform-specific rather than fully tuned per target
- controller mapping is currently focused on XInput-like semantics used by the existing client path

## Platform notes

- Windows: keep named-pipe IPC and decoder probing isolated so D3D11 / Media Foundation decode paths can be wired cleanly.
- macOS: keep platform-specific decode probing isolated for VideoToolbox-backed paths.
- Linux x64: current runtime is exercised here and uses GStreamer-native decode / sink selection.
- Linux ARM / Raspberry Pi: platform modules remain isolated so V4L2/stateless/software probe paths can be extended without rewriting the control plane.

## Development

Run tests:

```bash
cargo test --manifest-path opennow-native-streamer/Cargo.toml
```

Prepare the production-shaped binary that Electron packages under `resources/native-streamer/`:

```bash
npm --prefix opennow-stable run native-streamer:prepare
```

Run the local Electron end-to-end verification harness for the native path:

```bash
xvfb-run -a npm --prefix opennow-stable run native-streamer:e2e
```

Run the native process directly against a controller-created socket:

```bash
cargo run --manifest-path opennow-native-streamer/Cargo.toml -- --ipc-endpoint /tmp/opennow-native-streamer.sock
```
