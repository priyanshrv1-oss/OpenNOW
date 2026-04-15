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
npm run dist:mac:catalina
```

Directly inside `opennow-stable/`:

```bash
npm run dev
npm run preview
npm run typecheck
npm run build
npm run dist
npm run dist:signed
npm run dist:mac:catalina
npm run dist:mac:catalina:signed
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
```

## Architecture

### Main process

The main process handles platform and system responsibilities:

- OAuth and session bootstrap
- Game catalog fetches and cache refresh
- CloudMatch session creation, polling, claiming, and stopping
- Signaling and low-level Electron integration
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
- Rendering the WebRTC stream
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

Catalina-compatible legacy macOS packages:

```bash
cd opennow-stable
npm run dist:mac:catalina
```

Signed Catalina-compatible packages:

```bash
cd opennow-stable
npm run dist:mac:catalina:signed
```

## CI And Releases

The repository includes two main GitHub Actions workflows:

- [`auto-build.yml`](../.github/workflows/auto-build.yml) builds pull requests and pushes to `main` and `dev`
- [`release.yml`](../.github/workflows/release.yml) packages and publishes tagged or manually-triggered releases

Current build matrix:

| Target | Packaging path | Output |
| --- | --- | --- |
| Windows | Main Electron line | NSIS installer, portable executable |
| macOS x64 | Main Electron line | `OpenNOW-v${version}-mac-x64.{dmg,zip}` |
| macOS arm64 | Main Electron line | `OpenNOW-v${version}-mac-arm64.{dmg,zip}` |
| macOS Catalina x64 | Legacy Electron 27 packaging config with `minimumSystemVersion: 10.15.0` | `OpenNOW-v${version}-mac-catalina-x64.{dmg,zip}` |
| Linux x64 | Main Electron line | `AppImage`, `deb` |
| Linux ARM64 | Main Electron line | `AppImage`, `deb` |

The Catalina lane reuses the same compiled application source and electron-vite build output. Only the packaging step switches to `electron-builder.catalina.json`, which pins `electronVersion` to `27.3.11` and sets the macOS minimum system version explicitly for Catalina-compatible distribution.

## Notes For Contributors

- The active app is the Electron client. If you see older references to previous implementations, prefer `opennow-stable/`.
- Root-level npm scripts are convenience wrappers around the `opennow-stable` workspace, including the Catalina-specific `dist:mac:catalina` packaging command.
- `opennow-stable/electron-builder.json` is the default packaging config for current Electron builds; `opennow-stable/electron-builder.catalina.json` is the dedicated legacy macOS packaging config.
- Before opening a PR, run `npm run typecheck` and `npm run build`.

For contribution workflow details, see [`.github/CONTRIBUTING.md`](../.github/CONTRIBUTING.md).
