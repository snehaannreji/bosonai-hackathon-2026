# Boson talking-avatar classroom

The main React classroom now has an integrated **Boson talking avatar** mode. This uses real Higgs Avatar video and synchronized audio through LiveKit, with transcripts and the same evidence-checked learning dashboard. The previous separate HTML viewer is retained only as an advanced standalone diagnostic.

The Boson API key has been checked for Realtime voice and catalog access: the catalog returned **Claire**, **Emma**, and **James** presets. LiveKit project credentials are now configured locally. A real headless user received moving Claire video and speech, exercised learning-tool updates, and disconnected cleanly. No fake video is used. Perceptual lip synchronization and hardware microphone interruption still need a short browser check.

## Set up LiveKit Cloud

1. Sign in at https://cloud.livekit.io and create a project.
2. Copy the project's WebSocket URL from the project dashboard.
3. Open **Settings → Keys** and create/copy the API key and secret.
4. Add them to the root `.env` (keep secrets out of frontend code and chat):

```dotenv
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-project-key
LIVEKIT_API_SECRET=your-project-secret
```

Keep the existing Boson key. The [official Boson guide](https://docs.boson.ai/models/higgs-avatar/realtime-sessions) requires LiveKit Cloud and says its free tier is enough to try it; self-hosted LiveKit is not accepted by this API.

## Launch from the classroom

Use Node 22.22+ and Python 3.10+:

```bash
npm ci
npm run avatar:setup
npm run dev
```

`avatar:setup` installs the pinned SDKs into `.venv-avatar`. If needed, select Python explicitly:

```bash
AVATAR_SETUP_PYTHON=/path/to/python3.10 npm run avatar:setup
```

On the current machine, the compatible temporary Node runtime is `/private/tmp/node-v22.22.0-darwin-arm64/bin`; add it to PATH if Node is not installed normally. The avatar dependencies have already been installed using `/opt/homebrew/bin/python3.10`.

Restart `npm run dev` after editing `.env`. Open **http://localhost:5173**, enter a topic, choose **Boson talking avatar**, select a **Student avatar**, and click **Start lesson**. Enable the microphone once the connection and actual video track are ready. Talk to Alex, interrupt mid-sentence, and check that both the mouth and voice stop together. Check that the transcript and understanding map update. Use **End lesson** when finished.

Do not run `python avatar/agent.py` separately for this path. The Node server starts a managed bridge for the room and mints the browser token automatically. The current local demo allows one active avatar lesson at a time; an existing lesson must finish cleanup before another starts.

## Architecture

```text
React --room-scoped token--> LiveKit Cloud (user microphone)
Node --managed Python bridge--> Higgs Realtime (conversation)
Python --official DataStreamAudioOutput--> Boson avatar participant
Avatar --synchronized video + audio--> React/LiveKit client
Python --protocol events--> Node evidence validator --SSE--> React transcript/map
```

- `server/avatarSessions.ts` loads the preset catalog, issues user tokens, starts the worker, executes learning tools, streams UI updates and releases sessions. No primary API key or LiveKit secret is returned to React.
- `avatar/agent.py` adapts Boson's complete official raw-WebSocket example: LiveKit audio in, Higgs Realtime out, `DataStreamAudioOutput.capture_frame`, `flush`, and `clear_buffer` for the avatar. Its managed mode adds local process commands/events, not a new audio transport.
- `src/realtime/LiveAvatarClient.ts` uses the official LiveKit browser SDK to publish the mic and attach only the avatar's audio/video tracks. No PCM browser player runs alongside avatar audio.
- `src/realtime/avatarToolBridge.ts` uses the same topic-specific tracker and independent evidence checks as voice mode, grounds evidence in actual human turns, deduplicates tool call IDs, and sends one continuation per response batch. State/transcripts flow to the existing React interface.
- `src/ui/LiveAvatarVideo.tsx` shows an actual remote video track, or a clearly labeled waiting state. Connection becomes usable only after the voice agent and video track are both present.

Each lesson has its own room. Only the `user` microphone is forwarded; the avatar listens only to the `agent` participant. Boson renders the face and voice together. `playback_finished` supplies the played duration when interrupted, so the worker truncates conversation history to match what was heard.

Ending a lesson, closing the tab, losing the event stream, leaving the room, or reaching the 10-minute cap initiates cleanup. The worker releases the Boson session in `finally`; the Node server also attempts a backup release. Session creation is not automatically retried, because it is not idempotent. A cancellation during creation waits for the pending request to finish so the returned session can be released.

## Uploaded photos

**Verified generated-video test:** the supplied portrait successfully produced a talking-photo MP4 using `POST /v1/videos`, `ref_image` and `input_tts`. This separate CLI test does not register a live avatar. See [results, repeatable commands, and the exact missing Boson protocol](CUSTOM-AVATAR-INVESTIGATION.md). The classroom continues using presets for live conversations.

**Boson voice + photo** keeps your chosen photo in browser IndexedDB. That is a still portrait, separate from the preset used in talking-avatar mode. The published live API accepts a registered `avatar_id`; the full OpenAPI schema does not document a photo-registration endpoint. Boson reportedly supports custom photos for the team, but its registration instructions are still needed. Do not guess an endpoint or pass an image as an avatar ID.

## Configuration and diagnostics

### Account-owned custom avatars

The classroom accepts **both presets and account-owned IDs** from `GET /v1/avatars`. Configure `BOSON_AVATAR_ID` in the root `.env` with the exact ID Boson supplies, restart `npm run dev`, and refresh the webpage. That ID becomes the default when it is present in your key's catalog; the menu labels owned entries **Account avatar**. The server validates the selection, passes it as `TEACHBACK_AVATAR_ID` to the existing worker, and the worker sends it unchanged in the documented `POST /v1/avatar/sessions` request. LiveKit, Realtime 1.5, interruption handling and learning assessment use the same path as presets.

If the configured ID is absent from the catalog, the classroom shows a notice and selects Claire (or another listed preset). All listed presets remain manually selectable. With no explicit ID configured, an owned avatar is preferred when available; otherwise a preset is used. A provider failure after session creation starts is reported normally rather than automatically creating another billable session. Catalog results are cached for up to five minutes; restart the server after Boson adds an ID to pick it up immediately. The legacy `/api/avatar/presets` endpoint name is retained, but its `presets` array now contains the full catalog plus `defaultAvatarId` and `warning` response fields.

The latest authenticated catalog check still exposes only Claire, Emma and James; no account-owned ID is available to test live yet. No registration endpoint was invented. The standalone generated-video test does not register an avatar.

Optional server-only overrides:

```dotenv
# Exact preview ID supplied in the hackathon slides and verified by the server:
BOSON_REALTIME_MODEL=higgs-realtime-1.5-preview
BOSON_REALTIME_URL=wss://api.boson.ai/v1/realtime
# Path to a prepared Python environment, if not the default:
# AVATAR_PYTHON=/absolute/path/to/python
```

The main classroom loads its session config directly from TypeScript at startup. It does not require `npm run avatar:config`; that export is only for standalone diagnostics.

`GET /api/avatar/status` reports missing LiveKit settings and whether the Python environment exists. `GET /api/avatar/presets` reads your full Boson catalog and resolves the configured default. Neither starts a billable avatar session. `POST /api/avatar/lessons` accepts a listed `avatarId`, or uses the resolved default if omitted; it refuses incomplete settings before creating a room or avatar. Its short-lived room token is intended for the browser. The server remains bound to localhost. Add authentication and issuance limits before public deployment.

The client/bridge unit tests cover readiness, track isolation, microphone controls, tool evidence, tool deduplication, cancellation, and cleanup. The Python dependency import check and TypeScript/build checks pass. A credentialed media smoke test now passes; browser device playback and perceptual sync remain a manual check.

## Failure cases

- **Missing settings notice:** add all three LiveKit values, then stop/restart the dev command.
- **Python agent not installed:** run `npm run avatar:setup` with Python 3.10+.
- **422 invalid_livekit_url:** use the exact `wss://project.livekit.cloud` URL, without a path, port or query.
- **429 capacity_exhausted / 503 service_unavailable:** follow Boson's retry guidance; release old sessions and start a new lesson after waiting. The app does not retry creates blindly.
- **No video:** check the selected preset is in your key's catalog and that the LiveKit credentials belong to the same project URL. The UI continues showing a waiting state until real video arrives.
- **No audio:** click Start microphone or send a typed message to unlock browser audio; check output device and Boson credit.
- **Already running:** finish the other avatar lesson and wait for its worker to exit. Startup cancellation can take up to the provider's 60-second request timeout before release completes.

## Advanced standalone viewer

For isolating provider issues, `npm run avatar:config` exports Alex's config without learning tools, and `python avatar/agent.py` joins the fixed `avatar-demo` room. `public/avatar.html` can join that room with a manually minted `user` token as described in Boson's official guide. Do not run this alongside the integrated classroom or mistake its independent state for the main dashboard.

Official references: [Boson session guide](https://docs.boson.ai/models/higgs-avatar/realtime-sessions), [session request schema](https://docs.boson.ai/api-reference/avatar-realtime/create-a-session), [LiveKit browser SDK](https://docs.livekit.io/reference/client-sdk-js/classes/Room.html), [LiveKit server tokens](https://docs.livekit.io/reference/server-sdk-js/classes/AccessToken.html).


## Realtime 1.5 native-face information from the opening deck

The opening slides identify `higgs-realtime-1.5-preview` and describe native face-video output. That exact model ID has been verified for the current audio protocol and is now the default. The slides do not include the photo input or video transport schema. The LiveKit requirement above applies to this app's implemented preset-avatar path; native preview video may have a different integration. See [the slide findings and missing API details](HACKATHON-SLIDES.md).


## Repeat the live media smoke test

```bash
npm run probe:avatar
```

This uses the configured local server and creates a real, short Boson avatar session, so it consumes API credit. It joins as a headless LiveKit user, receives real video/audio frames, prepares a topic-specific lesson and submits two typed turns through the same classroom endpoints, checks learning events, and requests release in `finally`. It never prints credentials. Captured example frames and the media summary live under gitignored `captures/`. Run it only when another avatar lesson is not active.


The live probe defaults to photosynthesis. To test another topic, supply its explanation too:

```bash
npm run probe:avatar -- --topic "French past tense" --explanation "The passé composé describes completed events and combines present-tense avoir or être with a past participle, as in j’ai mangé. The imparfait describes past habits or background, as in je jouais."
```
