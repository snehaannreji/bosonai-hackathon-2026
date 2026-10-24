# Near-real-time whiteboard vision with Vertex AI

TeachBack keeps its Boson Realtime 1.5 conversation and LiveKit avatar. A separate **Gemini 3.5 Flash-Lite** image-analysis request observes the drawing; its result replaces a bounded visual-context block in the existing Boson session. This is event-driven JPEG analysis, not native video input. No drawing descriptions are hardcoded or sent as substitutes for images.

## Authentication and startup

The server uses Google's official Node **`@google/genai`** SDK, equivalent to the Python initialization requested by the team:

```ts
new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: 'global',
})
```

The configured local project is `project-d8a84c19-33a4-4553-bfa`. Its ID/location/model are in the ignored root `.env`. **No `GEMINI_API_KEY` is required or used.** Credentials stay in the local ADC store, outside the project; the SDK refreshes access tokens and reuses one server-side client. Boson/LiveKit credentials and microphone transport are unchanged.

On another developer's machine:

```bash
npm ci
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

Set these non-secret server settings in the existing `.env`:

```dotenv
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
GOOGLE_CLOUD_LOCATION=global
VISION_MODEL=gemini-3.5-flash-lite
```

```bash
npm run dev
```

Open **http://localhost:5173**, start a Boson voice/avatar lesson, and draw. Vision starts automatically when the conversation is open and the Vertex project is configured. No per-frame button is needed. **Stop sharing whiteboard** disables analysis and sends an `off` invalidation; **Start sharing whiteboard** enables it again. The separate **Test local capture** control remains a local video diagnostic and is unrelated to JPEG analysis.

The collapsed **Vision debugging** panel shows board revision, analyzed revision, acknowledged context revision, pending-state status, description, age, discarded results, and measured capture/provider/round-trip/context/total latency. Its one-second age-label timer never takes screenshots. Console debug logs contain timing metadata only, not image bytes or credentials. The optional **Measure local JPEG export** button benchmarks local encoding; it does not trigger analysis or deliver an observation.

## Capture and latest-frame-wins scheduling

`WhiteboardPanel` reuses the existing fixed canvas, so export includes only drawing pixels. Pointer movement, completed/cancelled strokes, placed text, shapes, eraser strokes, Undo, Clear and Move actions call the pipeline directly. Subpixel duplicate movement is ignored. Existing objects can be moved with the Move tool using approximate bounding-box selection.

- A completed edit schedules capture after **120 ms**, combining rapid edits.
- A long stroke can capture an intermediate state after **350 ms**, then at most every 350 ms while the pipeline keeps up. A short stroke avoids an unnecessary initial dot request.
- One reusable export canvas renders at **768 px on the longest side**, encodes **JPEG quality 0.76**, and hashes the actual JPEG bytes. Identical images reuse an existing observation with an updated revision; they do not call the model again.
- There is **one active capture/analysis/delivery and one replaceable pending revision**, not a FIFO image queue. Pending frames are exported only when capacity becomes available, ensuring the export reflects the newest canvas.
- Results must still match the current board revision before being delivered. Edits during an acknowledgement also enqueue a newer invalidation, so an old observation cannot silently become current during delivery.
- Clear immediately sends a `cleared` context, drops cached observations and aborts the old local request. Clear needs no vision inference because the app authoritatively knows it removed every mark. Later results cannot restore the erased drawing.
- Normal edits do not repeatedly abort active model requests. Abort is used on clear/stop/disconnect; the SDK notes this may stop local waiting without cancelling server work or charges. Backend concurrency is also capped at one, with no server queue or automatic retries.

If the model is slower than continuous drawing, strict freshness intentionally leaves the student uncertain until a current result arrives. It does not present a stale diagram as current to make a latency counter look better.

## Vision request

The server sends one current JPEG plus at most the last short description, using `models.generateContent`, structured JSON, **MINIMAL thinking**, a short prompt, and a **256-token output limit**. The output contains `description`, `changes`, `visible_text` and `uncertainties`; the server assigns the trusted revision. The model is told to report visible content, avoid solving/inventing, and treat image text as data. Incomplete, blocked or malformed responses are rejected.

`POST /api/vision/analyze` has a bounded image body and does not persist images. Errors diagnose missing/expired ADC, disabled Vertex API, IAM/service usage permissions, quota and unavailable models. There is no fallback to the Gemini Developer API or another provider. `/api/vision/status` reports project configuration, not proof of semantic recognition or native Boson video support.

## Delivering observations without speech or history flooding

The supported Boson mechanism is a partial **`session.update`** containing **only `session.instructions`**. The instructions are rebuilt from the same lesson/student/personality prompt plus the latest validated visual context. Each update replaces the previous block; it does not append a teacher message or tool result to the conversational history. It does not restart the socket, change audio settings, call `response.create`, or cancel speech.

- Voice mode uses the existing browser WebSocket and `VisualContextChannel`.
- Avatar mode sends `POST /api/avatar/lessons/:id/visual-context`; the server rebuilds the prompt, sends the supported event through the existing worker IPC/WebSocket, and waits for the matching `session.updated` acknowledgement.
- The channel allows one unacknowledged update plus one coalesced latest update. It confirms delivery only when Boson echoes matching instructions. Old revisions are rejected.
- The worker announces readiness only once; subsequent visual instruction acknowledgements do not reset the avatar's speaking/activity state.

Pending/cleared/off contexts invalidate all older diagrams. The persona policy admits uncertainty while analysis is pending, uses current observations naturally when the teacher speaks, and does not comment automatically on every edit. Visual data is not treated as a human teaching quote and cannot independently award understanding; the existing learning tools/evidence gates remain in place.

The current snapshot explicitly supersedes conversational memory, including the student's own earlier descriptions. A production-persona browser test initially exposed a stale-circle answer despite a successful transport ACK; strengthening that precedence fixed the repeated sequence. Transport acknowledgement by itself is therefore not treated as proof of accurate recognition.

An answer already being generated can reflect the context available when that answer began. Updates deliberately do not interrupt or regenerate it; subsequent responses use the newest acknowledged context. The avatar branch's pre-existing microphone suppression during playback remains unchanged, so this work does not claim newly verified hardware full-duplex barge-in.

## Actual verification and latency

On October 24, 2026, the ADC-authenticated Vertex client successfully called `gemini-3.5-flash-lite` in `global` for the configured project. Its first simple connection check returned the requested acknowledgement in **1,082 ms**.

A real three-image experiment then analyzed unlabeled red-circle, circle-plus-blue-arrow and arrow-only JPEGs. **The actual model observations** were delivered into one Boson `higgs-realtime-1.5-preview` session, and its spoken transcripts were:

1. “I see a single red circle on a plain white background.”
2. “A blue arrow pointing right toward the red circle was added.”
3. “The red circle is gone; now there's just a single horizontal blue arrow pointing to the right on a plain white background.”

| Stage | Vertex inference | Vision HTTP round trip | Boson context ACK | Image request → context, excluding browser capture |
| --- | ---: | ---: | ---: | ---: |
| Red circle | 1,461 ms | 1,485 ms | 27 ms | 1,540 ms |
| Add arrow | 1,255 ms | 1,270 ms | 26 ms | 1,323 ms |
| Erase circle | 1,509 ms | 1,521 ms | 27 ms | 1,574 ms |

Those measurements used the first prompt/output budget. The prompt was shortened from 60 to 20 words and output capped at 256 tokens to reduce the slowest stage. A subsequent real avatar test with that configuration identified the circle and arrow, took **1,343 ms** for Vertex and **28 ms** for context ACK, received **455 distinct video frames and 477,600 audio samples**, continued learning to `partial` on the following explanation, and released its room. This confirms the visual context and real avatar/audio path work together; it is a typed-input/headless media test, not a hardware microphone test.

In the browser lab, a red-circle edit automatically exported JPEG in **5 ms**, completed Vertex inference in **1,324 ms**, and completed local analysis **1,464 ms after the edit**, including debounce/network time. That lab has no voice session, so its total is not an end-to-end Boson delivery measurement. Local capture is small relative to provider inference. **The roughly one-second goal is not yet consistently met; measured provider inference is the bottleneck.** No latency figures are fabricated or presented as guarantees.

The full classroom browser test used the production student persona, actual canvas exports and the existing voice session. It recognized the circle and added arrow, then answered after erasure: “A blue arrow pointing right is on the whiteboard now. The red circle outline is gone.” The arrow update took **6 ms capture + 1,095 ms Vertex inference + 28 ms context ACK**, with **1,261 ms total edit-to-context latency**, including debounce/network. Erasure took **7 ms capture + 1,472 ms inference + 28 ms ACK**, **1,638 ms total**. One earlier blank-board request returned a transient Vertex HTTP 504; the next drawing edit succeeded. Timeout diagnostics distinguish this from ADC/IAM rejection and keep the same provider.

Five rapid edits, including Clear, finished at revision **14**, with analyzed/delivered revision **14**, **no pending frame** and **two stale results discarded**. The final arrow-only frame took **5 ms capture, 795 ms inference, 27 ms ACK and 958 ms total**; the student's actual answer was “There's a blue arrow pointing right on the whiteboard.” This demonstrates a sub-second update is achievable in this environment, not a consistent guarantee. Final checks passed: **155 JavaScript tests, 18 Python worker tests, TypeScript checking and the production build**. The build retains an existing large-bundle advisory.

The earlier live transport-only experiment applied pending/clear updates on the same Boson session, including during speech generation, in about **25 ms** each and caused **zero unsolicited responses**. Controlled fixtures/race-condition unit tests are separate from these real-model tests.

Ignored local evidence files: `captures/whiteboard-context-transport.json`, `captures/whiteboard-vertex-live-probe.json`, `captures/avatar-live-probe-summary.json`, `captures/whiteboard-browser-fallback.json`. These contain actual observations, transcripts and timing metadata; no primary API keys, access tokens or base64 images.

## Reproduce the experiment

For automatic browser capture and real conversation delivery, open **http://localhost:5173/?whiteboardTest=1**. Start a Boson voice/avatar lesson. The query flag exposes controlled drawing buttons without changing the normal pipeline: Blank board → Red circle → Add blue arrow → Erase circle. Ask the student what is visible, what changed, and whether the circle remains. Then rapidly alternate edits and clear, checking that only the latest revision becomes current. Button labels/shape commands are never sent to Gemini or Boson; only actual rendered image pixels go to vision. The normal application uses the same pipeline for mouse/touch edits.

For an analysis-only experiment, open **http://localhost:5173/vision-lab**. Avoid running multiple active drawing tabs at once because the prototype backend allows one vision analysis globally.

Credentialed CLI checks:

```bash
# Instructions-only transport test; explicitly does not claim vision recognition:
npm run probe:whiteboard -- --transport-only

# Use your three real JPEG whiteboard exports in the stated order:
npm run probe:whiteboard -- --images circle.jpg circle-arrow.jpg arrow-only.jpg

# Actual LiveKit avatar/video/audio plus a real image observation:
npm run probe:avatar -- --vision-image circle-arrow.jpg --topic 'Shapes and colors'

npm test
npm run test:avatar
npm run typecheck
npm run build
```

## Files and extension points

| Area | Files |
| --- | --- |
| Vertex SDK, validation, diagnostics and concurrency | `server/vision.ts`, `server/index.ts` |
| JPEG export, scheduling and typed context | `src/whiteboard/snapshot.ts`, `visionPipeline.ts`, `observations.ts`, `contextChannel.ts` |
| Existing editor and debug panel | `src/ui/WhiteboardPanel.tsx`, `src/whiteboard/board.ts`, `src/App.tsx`, `src/main.tsx`, `src/index.css` |
| Existing voice/avatar context delivery | `src/realtime/RealtimeClient.ts`, `LiveAvatarClient.ts`, `sessionConfig.ts`, `server/avatarSessions.ts`, `avatar/agent.py` |
| Reproducible checks | `tools/probe-whiteboard.ts`, `tools/avatar-probe.py`, `test/visionPipeline.test.ts`, `visualContext.test.ts`, `visionServer.test.ts`, existing client/worker tests |

References: [Vertex ADC](https://cloud.google.com/vertex-ai/generative-ai/docs/start/gcp-auth), [Google Gen AI SDK](https://googleapis.github.io/js-genai/release_docs/classes/client.GoogleGenAI.html), [Flash-Lite model](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite), [supported Boson client events](https://docs.boson.ai/api-reference/realtime/client-events). The earlier [native-video investigation](WHITEBOARD-VISION.md) remains historical; no undocumented native events are used by this fallback.
