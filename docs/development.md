# Development Guide

This guide covers the active Electron-based OpenNOW client in [`opennow-stable/`](../opennow-stable).

## Prerequisites

- Node.js 22 or newer
- npm
- A GeForce NOW account for end-to-end testing

## Getting Started

Install app dependencies inside the Electron workspace:

```bash
cd opennow-stable
npm install
```

You can then work either from the app directory or from the repository root.

From the repository root:

```bash
npm run dev
npm run typecheck
npm run build
npm run dist
```

Directly inside `opennow-stable/`:

```bash
npm run dev
npm run preview
npm run typecheck
npm run build
npm run dist
npm run dist:signed
```

## Workspace Layout

```text
opennow-stable/
├── src/
│   ├── main/           Electron main process
│   │   ├── gfn/        Auth, game catalogs, subscriptions, CloudMatch, signaling
│   │   └── services/   Cache and refresh helpers
│   ├── preload/        Safe API exposed to the renderer
│   ├── renderer/src/   React application
│   │   ├── components/ Screens, stream UI, settings, library, navigation
│   │   ├── gfn/        WebRTC client and input protocol
│   │   └── utils/      Diagnostics and UI helpers
│   └── shared/         Shared types, IPC channels, logging helpers
├── electron.vite.config.ts
├── package.json
└── tsconfig*.json
opennow-native-streamer/
├── src/             Rust native streamer runtime
└── tests/           Rust protocol and IPC tests
```

## Architecture

### Main process

The main process handles platform and system responsibilities:

- OAuth and session bootstrap
- Game catalog fetches and cache refresh
- CloudMatch session creation, polling, claiming, and stopping
- Signaling and low-level Electron integration
- Native streamer process spawning and local socket IPC when the beta toggle is enabled
- Local media management for screenshots and recordings
- Persistent settings storage

Key entry point:

- [`opennow-stable/src/main/index.ts`](../opennow-stable/src/main/index.ts)

### Preload

The preload layer exposes a narrow IPC surface to the renderer with `contextBridge`.

Key entry point:

- [`opennow-stable/src/preload/index.ts`](../opennow-stable/src/preload/index.ts)

### Renderer

The renderer is a React app responsible for:

- Login and provider selection
- Browsing the catalog and public listings
- Managing stream launch state and session recovery
- Rendering the WebRTC stream when the native toggle is disabled
- Triggering the separate native streamer path when the native toggle is enabled
- Handling controller input, shortcuts, stats overlay, screenshots, recordings, and settings UI

Key entry points:

- [`opennow-stable/src/renderer/src/App.tsx`](../opennow-stable/src/renderer/src/App.tsx)
- [`opennow-stable/src/renderer/src/components/StreamView.tsx`](../opennow-stable/src/renderer/src/components/StreamView.tsx)
- [`opennow-stable/src/renderer/src/components/SettingsPage.tsx`](../opennow-stable/src/renderer/src/components/SettingsPage.tsx)

## Common Tasks

### Start the app in development

```bash
cd opennow-stable
npm run dev
```

### Run type checks

```bash
cd opennow-stable
npm run typecheck
```

### Run native streamer tests

```bash
cargo test --manifest-path opennow-native-streamer/Cargo.toml
```

### Build and verify the native streamer in development

```bash
cd opennow-stable
npm run native-streamer:prepare
npm run native-streamer:e2e
npm run chromium-stream:e2e
```

### Build production bundles

```bash
cd opennow-stable
npm run build
```

### Package release artifacts locally

Unsigned packages:

```bash
cd opennow-stable
npm run dist
```

Signed packages, if your environment is configured for signing:

```bash
cd opennow-stable
npm run dist:signed
```

## CI And Releases

The repository includes two main GitHub Actions workflows:

- [`auto-build.yml`](../.github/workflows/auto-build.yml) builds pull requests and pushes to `main` and `dev`
- [`release.yml`](../.github/workflows/release.yml) packages and publishes tagged or manually-triggered releases

Current build matrix:

| Target | Output |
| --- | --- |
| Windows | NSIS installer, portable executable |
| macOS x64 | `dmg`, `zip` |
| macOS arm64 | `dmg`, `zip` |
| Linux x64 | `AppImage`, `deb` |
| Linux ARM64 | `AppImage`, `deb` |

### Windows native-streamer artifact

For the Rust + GStreamer backend, the repository also includes @/.github/workflows/native-streamer-windows.yml.

That workflow:

- runs on Windows
- installs the GStreamer MSVC SDK
- runs `cargo test --manifest-path opennow-native-streamer/Cargo.toml`
- builds `opennow-native-streamer.exe` in release mode
- uploads an artifact named `opennow-native-streamer-windows-x64`

Artifact layout:

- `native-bin/win32-x64/opennow-native-streamer.exe`
- `README.txt`

Use that artifact by copying the executable into:

- `opennow-stable/native-bin/win32-x64/opennow-native-streamer.exe`

or by pointing `OPENNOW_NATIVE_STREAMER_BIN` at the downloaded executable.

### Local Windows fallback build

If you are building the Windows native streamer locally instead of downloading the CI artifact:

1. Install Visual Studio Build Tools with MSVC C++
2. Install Rust stable MSVC:
   - `rustup default stable-x86_64-pc-windows-msvc`
3. Install the 64-bit GStreamer MSVC runtime and development packages to:
   - `C:\gstreamer\1.0\msvc_x86_64`
4. Set:

```powershell
$env:GSTREAMER_1_0_ROOT_MSVC_X86_64="C:\gstreamer\1.0\msvc_x86_64"
$env:PKG_CONFIG_PATH="$env:GSTREAMER_1_0_ROOT_MSVC_X86_64\lib\pkgconfig"
$env:PATH="$env:GSTREAMER_1_0_ROOT_MSVC_X86_64\bin;$env:PATH"
```

5. Build from the repository root:

```powershell
cargo build --release --manifest-path opennow-native-streamer/Cargo.toml
```

6. Copy the output into:

```powershell
opennow-stable\native-bin\win32-x64\opennow-native-streamer.exe
```

## Notes For Contributors

- The active app is the Electron client. If you see older references to previous implementations, prefer `opennow-stable/`.
- Root-level npm scripts are convenience wrappers around the `opennow-stable` workspace.
- Before opening a PR, run `npm run typecheck`, `npm run build`, and `cargo test --manifest-path opennow-native-streamer/Cargo.toml`.

For contribution workflow details, see [`.github/CONTRIBUTING.md`](../.github/CONTRIBUTING.md).
