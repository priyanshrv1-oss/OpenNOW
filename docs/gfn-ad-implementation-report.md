# GFN Ad Queue Investigation and OpenNOW Implementation Options

## Summary

The official GeForce NOW web client appears to implement ads as a first-party queue gating system, not just a generic marketing overlay. The strongest signals are:

- queue progress payloads include `sessionAdsRequired` and `sessionAds`
- the queue polling logic changes cadence when ads are required
- the client has explicit ad error states such as `AdPlayTimeout`, `AdVideoStuck`, and `IsAdsRequiredUndefined`
- locale strings include queue-ad copy: `Session queue paused`, `Resume ads to stay in queue.`, and accessibility labels for an ad video element
- a live launch recorded four sequential ad creatives from `creative-f1.simulmedia-apis.com` before the rig-ready blocker appeared

This points to an ad-aware session lifecycle rather than a simple upsell banner.

## Evidence Collected

### 1. Official queue UI and strings

During the live official-client capture, the queue flow exposed ad-related UI including `Mute Ad` and `Finish ads to stay in queue`. The English locale bundle also contains a dedicated queue-ad opportunity section:

- `notification.opportunity.queuePaused = "Session queue paused"`
- `notification.opportunity.stayInQueue = "Resume ads to stay in queue."`
- `notification.opportunity.ariaLabels.videoAriaLabel = "Advertisement"`
- `notification.opportunity.ariaLabels.videoPlayingWithoutDescAriaLabel = "Ad video playing - no description available"`

These strings indicate that the client renders an actual ad video experience with accessibility support, not just passive text.

### 2. Official session payload is ad-aware

The official vendor bundle contains queue progress code that constructs a session progress event with ad fields:

```text
event: SESSION_SETUP_PROGRESS,
eta: l.eta,
queuePosition: l.queuePosition,
isAdsRequired: l.isAdsRequired,
ads: [],
sessionId: l.sessionId,
subSessionId: l.subSessionId
```

In the same vendor bundle, the upstream session object is read from CloudMatch-style payload fields:

```text
progressState: ...,
isAdsRequired: i.sessionAdsRequired,
ads: []
...
if (i.sessionAds) {
  const Ut = i.sessionAds.length;
  ...
}
```

This is the strongest implementation clue. The server-side session payload already tells the client whether ads are required and provides per-ad objects through `sessionAds`.

### 3. Live launch runtime confirms real ad playback before rig-ready

During a fresh monitored launch of Marvel Rivals in the official browser client, the page-side watcher recorded a concrete ad-to-session sequence:

- `22:16:22` ad video load started from `https://creative-f1.simulmedia-apis.com/50830146-1cc9-4a0a-ac78-142a7b95c730.mp4`
- `22:16:53` first ad ended at about `30.037s`
- `22:16:53` second ad began from `https://creative-f1.simulmedia-apis.com/b0b0c71d-2961-45a4-8f06-2236ea443b49.mp4`
- `22:17:23` second ad ended at about `30.037s`
- `22:17:23` third ad began from `https://creative-f1.simulmedia-apis.com/c2b32ea5-ab9d-4945-bb08-3f3762d79ebb.mp4`
- `22:17:53` third ad ended at `30s`
- `22:17:53` fourth ad began from `https://creative-f1.simulmedia-apis.com/3a6ddb09-655d-45e1-9dbe-58d70c17ebc1.mp4`
- `22:18:23` fourth ad ended at `30s`
- `22:18:45` the browser streamer video performed `loadstart`
- `22:18:48` the streamer video reached `playing` while muted, after which the DOM showed `Your Gaming Rig is Ready!`

This matters for two reasons:

- the ads were not hypothetical bundle code; the official client really played external MP4 creatives during queue/setup
- the client switched from audible ad media to the muted stream surface only after the ad chain completed

The watched page had already advanced to the rig-ready blocker by the time the DOM snapshot was pulled, so the ad DOM itself was gone. The video event history still preserved the sequence.

### 4. Fresh full-body launch capture confirms ads can be required before ad metadata is populated

A second monitored relaunch, instrumented with full fetch-body capture from the start of session creation, produced a stronger contract-level clue.

The `POST /v2/session?keyboardLayout=...` create response returned:

```json
{
  "sessionAdsRequired": true,
  "sessionAds": null,
  "status": 1,
  "seatSetupInfo": {
    "queuePosition": 0,
    "seatSetupEta": 30000,
    "seatSetupStep": 0
  },
  "sessionControlInfo": {
    "ip": "np-mia-04.cloudmatchbeta.nvidiagrid.net",
    "resourcePath": "/v2/session/<session-id>"
  }
}
```

At the same time, the live queue DOM showed:

- `Looking for the Next Available Rig...`
- `Mute Ad`
- `Finish ads to stay in queue`
- `GET DAY PASS`
- upsell copy that explicitly includes `Ad-free experience`

And the active ad surface was a dedicated pre-stream video element:

- element id: `preStreamVideo`
- name: `opportunityVideo`
- poster: `shared/assets/img/DefaultGameArt-TVBanner-nonGame.svg`
- source stack from `creative-f1.simulmedia-apis.com`:
  - MP4
  - WebM
  - HLS (`creative.m3u8`)

This changes the implementation reading in an important way: the queue can enter an ad-required state before `sessionAds` is populated with explicit per-ad metadata. In other words, `sessionAdsRequired` is the primary gating signal, while creative resolution can happen later through a separate opportunity surface.

### 5. Polling behavior changes when ads are required

The vendor bundle contains ad-specific polling configuration:

```text
adsPollingIntervalMinMS: ... ? ... : 3000,
adsThrottleIntervalMS: ... ? ... : 2000,
adsWaitTimeoutS: ...
```

It also adjusts the queue poll interval when `sessionAdsRequired` is true:

```text
i.sessionAdsRequired &&
  (d = Math.max(d, this.fh.adsPollingIntervalMinMS))
```

That means ads are not just cosmetic. They participate in queue orchestration and affect how frequently the client polls setup progress.

The live launch also exposed a cadence change that lines up with this logic:

- while the monitored ad chain was running, session polling hit `/v2/session/<id>` around each ad boundary, roughly every 30 seconds
- after the final ad ended, the same endpoint was polled about once per second until the rig became ready

That is consistent with the bundle evidence that ads participate in queue/setup state and influence how aggressively the client polls.

### 6. Official client has explicit ad error handling

The main bundle contains a first-party ad error enum with at least these states:

- `ErrorLoadingUrl`
- `AdPlayTimeout`
- `AdVideoStuck`
- `IsAdsRequiredUndefined`
- `MediaPlayBlocked`

This suggests NVIDIA expects real failure modes around ad playback, autoplay restrictions, and server/client disagreement about whether ads are mandatory.

### 7. Queue pause notification is wired into a session state

The main bundle maps a session opportunity state to the queue-ad messaging:

```text
GracePeriodStart ->
  title: notification.opportunity.queuePaused
  body: notification.opportunity.stayInQueue
```

That looks like a queue grace-period model: if ads stop, the queue can pause and the user gets a short window to resume.

## What This Likely Means Architecturally

The official flow likely works like this:

1. Session creation or queue polling returns normal queue data plus `sessionAdsRequired` and `sessionAds`.
2. While `sessionAdsRequired` is true, the client keeps a dedicated ad sub-state inside the queue/setup flow.
3. The client renders ad media and tracks ad progress and failures locally.
4. Queue progression is conditional on continued ad playback or ad completion.
5. If playback stalls or the user pauses/mutes incorrectly, the queue can enter a paused or grace-period state.
6. The client continues polling with ad-specific intervals until the queue clears and normal setup resumes.

This is more than an upsell screen. It is a session-state extension attached to queueing.

## What Was Not Clearly Confirmed

- I confirmed a third-party creative delivery host, `creative-f1.simulmedia-apis.com`, but I did not confirm the exact orchestration SDK or bidding layer that selected those creatives.
- I confirmed that the active ad element can expose direct MP4, WebM, and HLS sources simultaneously, but I did not confirm how the client chooses between them internally.
- The `doubleclick` and `vast` substring hits from raw text search were not meaningful once inspected in context. They were not evidence of an actual ad SDK integration path.
- The monitored session poll responses were truncated in the watcher buffer, so this specific live run did not preserve the full JSON needed to re-read `sessionAdsRequired` or `sessionAds` directly from the response body.
- The browser snapshot taken after the page moved into the rig-ready blocker did not contain the active ad video DOM. The strongest evidence therefore came from the video-event history plus the earlier bundle and locale analysis.

## Implications for OpenNOW

OpenNOW already has most of the core launch-state plumbing needed for an ad-aware queue flow:

- queue/setup/loading lifecycle in [opennow-stable/src/renderer/src/App.tsx](/Volumes/Projects/OpenNOW/opennow-stable/src/renderer/src/App.tsx)
- desktop loading overlay in [opennow-stable/src/renderer/src/components/StreamLoading.tsx](/Volumes/Projects/OpenNOW/opennow-stable/src/renderer/src/components/StreamLoading.tsx)
- controller loading overlay in [opennow-stable/src/renderer/src/components/ControllerStreamLoading.tsx](/Volumes/Projects/OpenNOW/opennow-stable/src/renderer/src/components/ControllerStreamLoading.tsx)
- session contracts in [opennow-stable/src/shared/gfn.ts](/Volumes/Projects/OpenNOW/opennow-stable/src/shared/gfn.ts)
- queue extraction and session polling in [opennow-stable/src/main/gfn/cloudmatch.ts](/Volumes/Projects/OpenNOW/opennow-stable/src/main/gfn/cloudmatch.ts)

The missing piece is an ad-specific session model.

## Recommended Data Model for OpenNOW

If you want parity with the official design, extend `SessionInfo` with an optional ad state instead of building ads purely into the UI.

Suggested additions to [opennow-stable/src/shared/gfn.ts](/Volumes/Projects/OpenNOW/opennow-stable/src/shared/gfn.ts):

```ts
export interface SessionAdInfo {
  adId: string;
  state?: number;
  mediaUrl?: string;
  clickThroughUrl?: string;
  durationMs?: number;
  canMute?: boolean;
  canPause?: boolean;
}

export interface SessionAdState {
  isAdsRequired: boolean;
  isQueuePaused?: boolean;
  gracePeriodSeconds?: number;
  ads: SessionAdInfo[];
}
```

Then add:

```ts
adState?: SessionAdState;
```

to `SessionInfo`.

This keeps the source of truth in the session layer, which matches what the official client appears to do.

## Implementation Options

### Option 1. Minimal OpenNOW implementation

Implement ads as a UI-only waiting-room experience while the session remains in `queue`.

Scope:

- no backend contract changes
- local video playback only
- simple pause/mute controls
- queue text changes while ad is active

Pros:

- fastest to ship
- low risk
- fits current overlay structure

Cons:

- no real coupling to queue state
- cannot enforce `resume ads to stay in queue`
- behavior diverges from the official model

Best fit if the goal is cosmetic parity only.

### Option 2. Contract-driven ad queue flow

Mirror the official architecture by extending `SessionInfo` with ad fields and driving the UI from session payloads returned by `createSession` and `pollSession`.

Scope:

- parse ad fields in [opennow-stable/src/main/gfn/cloudmatch.ts](/Volumes/Projects/OpenNOW/opennow-stable/src/main/gfn/cloudmatch.ts)
- surface them in [opennow-stable/src/shared/gfn.ts](/Volumes/Projects/OpenNOW/opennow-stable/src/shared/gfn.ts)
- render ad UI inside the existing loading overlays
- add ad-specific poll throttling or minimum intervals when `isAdsRequired` is true

Pros:

- closest to official-client design
- supports queue pause, grace period, and ad completion semantics
- scales to server-driven policies later

Cons:

- requires schema changes
- more state handling
- higher QA cost

This is the best option if the goal is functional parity.

### Option 3. Membership-aware hybrid flow

Use existing subscription data from [opennow-stable/src/main/gfn/subscription.ts](/Volumes/Projects/OpenNOW/opennow-stable/src/main/gfn/subscription.ts) to decide whether the queue should show ads, upsell, or neither.

Scope:

- free tier: ad-required queue flow
- premium tier: current queue/setup flow without ads
- low-playtime or limited accounts: show upsell banners instead of ads or alongside them

Pros:

- aligns with official membership messaging
- reuses existing `fetchSubscription` integration
- gives you differentiated UX by plan

Cons:

- requires a policy layer beyond raw queue state
- risks mixing monetization logic into the renderer if not kept centralized

Best fit if you want monetization behavior rather than just queue visuals.

## Practical Integration Plan for OpenNOW

### Phase 1. Add ad state to the session contract

- Extend `SessionInfo` in [opennow-stable/src/shared/gfn.ts](/Volumes/Projects/OpenNOW/opennow-stable/src/shared/gfn.ts)
- Parse optional ad fields in [opennow-stable/src/main/gfn/cloudmatch.ts](/Volumes/Projects/OpenNOW/opennow-stable/src/main/gfn/cloudmatch.ts)
- Keep the fields optional so current providers continue working

### Phase 2. Add a dedicated queue-ad UI state

In [opennow-stable/src/renderer/src/App.tsx](/Volumes/Projects/OpenNOW/opennow-stable/src/renderer/src/App.tsx):

- derive `const adState = session?.adState`
- keep `streamStatus` as `queue`, but add an overlay mode when `adState?.isAdsRequired`
- preserve existing queue position handling

This avoids exploding the global launch state enum while still letting the queue screen branch into ad-required UI.

### Phase 3. Extend the loading overlays

In [opennow-stable/src/renderer/src/components/StreamLoading.tsx](/Volumes/Projects/OpenNOW/opennow-stable/src/renderer/src/components/StreamLoading.tsx) and [opennow-stable/src/renderer/src/components/ControllerStreamLoading.tsx](/Volumes/Projects/OpenNOW/opennow-stable/src/renderer/src/components/ControllerStreamLoading.tsx):

- add optional props for `adState`
- show ad video region, mute toggle, and queue-paused message when ads are active
- keep the existing queue/setup/launching stepper visible so the user still understands session progress

The official client appears to treat ads as part of queue progression, not a separate full-screen route.

### Phase 4. Add failure handling

Model at least these local error cases:

- media play blocked by autoplay policy
- ad URL failed to load
- ad playback timeout
- ad stuck without time progression
- missing or contradictory `isAdsRequired`

Those map directly to the error vocabulary found in the official bundle.

### Phase 5. Optional poll tuning

If OpenNOW eventually receives server-driven ad fields, adjust queue poll intervals when ads are required, similar to the official client. Do not add this until the contract exists.

## Recommended First Implementation

The best near-term path is Option 2 with a narrow first cut:

1. extend `SessionInfo` with optional `adState`
2. parse ad fields in CloudMatch if present, otherwise leave them undefined
3. update both loading overlays to render an ad panel when `adState.isAdsRequired` is true
4. support mute, paused, and failure states
5. defer third-party ad SDK work until there is proof it is needed

That gives OpenNOW the right architecture without prematurely committing to a vendor-specific ad stack.

## Bottom Line

The official GFN web client does not look like it bolted ads on top of the queue. It treats ads as part of session setup state. The clearest proof is the combination of `sessionAdsRequired`, `sessionAds`, ad-specific polling config, ad-specific error enums, the queue-paused/stay-in-queue notification copy, the live launch evidence showing four real 30-second ad creatives before rig-ready, and the fresh full-body session-create response showing `sessionAdsRequired: true` even while `sessionAds` was still null.

For OpenNOW, the correct abstraction is therefore:

- ads belong in the session contract
- the renderer should branch its queue UI from that contract
- membership and upsell messaging should remain a separate concern layered on top

If you want parity with the official client, implement an ad-aware queue state machine, not just a video widget on the loading screen.