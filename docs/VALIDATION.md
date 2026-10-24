# Credentialed voice smoke test · October 23, 2026

The supplied Boson key is configured only in the gitignored root `.env`, with file mode 0600. The key is not included in this report or in frontend source/build artifacts.

## Observed live behavior

- The Node token server reloaded the credential; `/api/config` reports voice configured.
- The official headless probe minted a temporary browser credential and connected to the standard Boson WebSocket endpoint.
- A typed three-turn conversation produced real speech: Alex stated the initial gradient misconception, corrected it after the human explanation, and applied the correction to a positive-gradient example.
- A subsequent two-turn conversation streamed Boson-synthesized speech as microphone-style 24 kHz PCM. Boson performed turn detection and returned user transcripts and real spoken replies.
- In the final spoken test, Alex called `update_understanding` with a quote matching the observed human transcript. The evidence validator changed gradient direction from `misunderstood` to `understood`, then Alex gave a short spoken response.
- The service reported model `higgs-realtime`. That alias does not independently confirm the key's underlying 1.5 routing.

The first live checks exposed inconsistent tool use and a mistaken model-chosen status. The Alex prompt was shortened, and the public tool was simplified to concept + quoted evidence. The handler now derives status from the grounded evidence rubric. The final spoken test exercised that corrected path successfully. Tool invocation is still model-driven; a single passing smoke test is not a reliability guarantee.

## Local checks

43 unit/integration tests passed, TypeScript passed, and the production build passed after the changes. The tests include knowledge-state evidence gates, state derivation, session isolation, mock conversation flow, transcript reduction, resampling, model routing, tool deduplication, cancellation and playback truncation.

The live probe exercises the audio protocol without a physical microphone or speakers. Human-device audio quality and in-browser barge-in still need a short manual check: open http://localhost:5173, choose Boson voice, Start lesson, Start microphone, speak and interrupt Alex. Avatar lip synchronization remains untested because LiveKit Cloud credentials have not been configured.

Raw probe event captures are stored under gitignored `captures/`. No live avatar session was started.


## Integrated talking-avatar checks

The main classroom now has Boson talking-avatar mode with server-issued LiveKit tokens, per-lesson Python workers, real track attachment, transcripts, and grounded learning tools. The live Boson catalog returned Claire, Emma, and James. Python 3.10 dependencies were installed in `.venv-avatar` and import checks passed. The avatar startup endpoint returned an explicit missing-LiveKit-settings error before allocating a provider session.

55 JavaScript tests and 3 Python tests pass, plus TypeScript and the production build. These include mocked readiness, audio isolation, microphone control, tool batching, evidence validation, SDK interruption/truncation, capacity-error handling, and cleanup after room-connect failure. LiveKit credentials are still absent; no actual live-avatar session or visual synchronization has been verified. The earlier live voice/audio smoke-test results remain valid.


## Exact 1.5 preview model access

The opening deck supplied the exact ID `higgs-realtime-1.5-preview`. A fresh call using the existing key at the standard Boson realtime endpoint was accepted, returned `session.created.model = higgs-realtime-1.5-preview`, and generated real speech and a transcript. The resolved session had no image/avatar/video fields. The app configuration now uses this ID. This supersedes the earlier uncertainty about the model name; native preview face output remains unverified and requires its specific API example.

A second live check on the exact preview ID streamed synthesized speech, received human transcripts, and executed `update_understanding` with grounded evidence, moving gradient direction to `understood`. The follow-up generated real audio. Native photo/video output was not requested because its schema is absent from the supplied slides.


## Credentialed LiveKit avatar smoke test

LiveKit settings were supplied and saved only in the gitignored `.env`. The local server reports the avatar configured. A headless LiveKit user joined a lesson created through the classroom's server endpoints, received Claire's real audio and video tracks, and exchanged two turns with `higgs-realtime-1.5-preview`. The second turn invoked grounded learning and changed gradient direction to `understood`.

The test received 428 video frames with 428 distinct frame hashes and 458,880 audio samples at 24 kHz. Two actual received frames were inspected visually; the face/mouth changed. The first attempt exposed a buffered event-stream startup, corrected by sending an initial SSE comment immediately. The rerun passed.

The probe requested session release and disconnected. A subsequent authenticated LiveKit room-list check found zero TeachBack rooms and zero remaining participants. No primary API key or LiveKit secret occurred in source, build output or docs. These checks confirm real media flow and cleanup; they do not replace a human microphone/speaker and perceptual lip-sync check in the browser.


## Any-topic classroom update

The classroom now prepares a fresh lesson from the user's topic instead of using fixed gradient-descent concepts. Topic-specific prompts/tool schemas and an independent evidence assessment share the existing Realtime 1.5 and LiveKit paths. Photosynthesis and French past tense were tested against the live planning/assessment endpoints: each produced relevant, different concepts; reassurance matched zero criteria; substantive explanations matched both tested criteria.

A complete photosynthesis talking-avatar run received real video/audio, stayed on topic, asked a relevant follow-up, and updated a concept to partial based on the evidence. It received 427 distinct video frames and 458,160 audio samples and requested cleanup afterward. The topic-entry and initial learning-map screen were inspected in Chrome. That browser check exposed a transient catalog 429: the catalog subsequently returned 200, and successful catalog caching plus in-flight request deduplication now prevents duplicate development-mode catalog calls. The UI has an explicit retry button.

72 JavaScript tests and 3 Python tests pass, including cross-topic isolation, Unicode grounding, confirmation rejection, independent criteria matching, stale-result rejection, assessment retry/cache behavior, generic mock lessons, delayed avatar continuation cancellation, and catalog request deduplication. TypeScript and the production build pass. Topic-specific grading is model-based and is not a formal factual-accuracy guarantee.
