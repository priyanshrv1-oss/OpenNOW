# Official GFN Web Client Capture

Captured on 2026-04-07 from the official browser client at `https://play.geforcenow.com` using the integrated browser session. The session was already authenticated, and a reload resolved into a live deeplink/queue flow for a game launch rather than the neutral storefront. That made the capture more useful for network-stack inspection because it included live session polling and queue assets.

## Artifacts

- `browser-artifacts.json`: Sanitized page metadata, script tags, stylesheet links, service worker registration, storage keys, and navigation timing.
- `resource-summary.json`: Loaded resources grouped by initiator type with sample URLs.
- `endpoints.json`: Sanitized network-relevant endpoints observed during startup and queue state.
- `console-logs.json`: Sanitized in-page console output captured from app startup.
- `page-shell.html`: Sanitized HTML shell captured from the live queue page.

## High-Signal Findings

- The official web client is served from the `/mall/` app shell and loads a module-based SPA bundle set: `runtime`, `polyfills`, `vendor`, `main`, plus lazy chunks such as `65.*.js`, `165.*.js`, `598.*.js`, `626.*.js`, `862.*.js`, and `923.*.js`.
- Styling is primarily delivered through a single hashed stylesheet plus inline/runtime style blocks. The capture showed one external stylesheet and 19 style blocks.
- A service worker is active at scope `https://play.geforcenow.com/` with script `https://play.geforcenow.com/mall/gfn-service-worker.js`.
- Content discovery and app metadata are fetched through persisted GraphQL queries on `https://apps.gxn.nvidia.com/graphql`.
- Session lifecycle traffic hits CloudMatch endpoints on both the global tier and the selected zone load balancer, including `prod.cloudmatchbeta.nvidiagrid.net` and `np-atl-04.cloudmatchbeta.nvidiagrid.net` in this capture.
- The browser client also talks to separate services for telemetry, subscriptions, remote config/experiments, surveys, auth/userinfo, and service URL discovery.
- Startup console logs explicitly mention shared storage initialization, IndexedDB/datastore creation, service worker registration, telemetry processing, and the browser streaming plugin.

## Observed Browser Events

- Browser console warnings reported repeated preload misuse for `spotlight-bg.webp`.
- Browser console also reported at least one failed resource load with HTTP 403 while the queue page was active.

## Resource Mix Snapshot

The captured resource inventory included:

- 10 script-initiated JS resources
- 28 XHR requests
- 14 fetch requests
- 44 image requests
- 8 CSS-initiated resources
- 1 audio asset
- 2 iframe loads
- 2 video-initiated resources

## Notes

- Identifiers such as session IDs, device IDs, and user IDs were redacted before writing artifacts into the workspace.
- These files capture URLs and runtime evidence, not full downloaded contents of every external JS/CSS bundle. If you want the actual minified bundle bodies mirrored locally as a second pass, fetch those specific URLs rather than committing them into the repo by default.