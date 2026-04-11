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

## Windows CI artifact

The repository includes a dedicated workflow at @/.github/workflows/native-streamer-windows.yml that builds the native streamer on Windows and uploads an artifact named `opennow-native-streamer-windows-x64`.

Artifact contents:

- `native-bin/win32-x64/opennow-native-streamer.exe`
- `README.txt` with the same placement notes below

To use the artifact with a local OpenNOW checkout:

1. Download the `opennow-native-streamer-windows-x64` artifact from the workflow run.
2. Extract it into the repository so the executable ends up at:
   - `opennow-stable/native-bin/win32-x64/opennow-native-streamer.exe`
3. Start OpenNOW from the repository checkout. The Electron main process will discover that path automatically in development mode.

If you want to keep the executable elsewhere, set:

```powershell
$env:OPENNOW_NATIVE_STREAMER_BIN="C:\full\path\to\opennow-native-streamer.exe"
```

The executable still requires the 64-bit GStreamer MSVC runtime on the Windows machine where it runs.

## Local Windows build fallback

Required toolchain and dependencies:

- Rust stable with the MSVC toolchain (`rustup default stable-x86_64-pc-windows-msvc`)
- Visual Studio 2022 Build Tools with MSVC C++ tools
- 64-bit GStreamer 1.0 MSVC runtime installer
- 64-bit GStreamer 1.0 MSVC development installer

Recommended install root:

- `C:\gstreamer\1.0\msvc_x86_64`

PowerShell environment setup for the current shell:

```powershell
$env:GSTREAMER_1_0_ROOT_MSVC_X86_64="C:\gstreamer\1.0\msvc_x86_64"
$env:PKG_CONFIG_PATH="$env:GSTREAMER_1_0_ROOT_MSVC_X86_64\lib\pkgconfig"
$env:PATH="$env:GSTREAMER_1_0_ROOT_MSVC_X86_64\bin;$env:PATH"
```

Build commands from the repository root:

```powershell
cargo test --manifest-path opennow-native-streamer/Cargo.toml
cargo build --release --manifest-path opennow-native-streamer/Cargo.toml
```

Expected output:

- `opennow-native-streamer\target\release\opennow-native-streamer.exe`

Development placement for OpenNOW:

```powershell
New-Item -ItemType Directory -Force -Path opennow-stable\native-bin\win32-x64 | Out-Null
Copy-Item opennow-native-streamer\target\release\opennow-native-streamer.exe opennow-stable\native-bin\win32-x64\opennow-native-streamer.exe
```

After copying, OpenNOW development builds will discover the executable automatically through the existing native binary resolution logic.

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
