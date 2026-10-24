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

`avatar:setup` installs the pinned SDKs into `.venv-avatar`. On Windows, it uses the Python launcher (`py`) when available and creates `.venv-avatar\Scripts\python.exe`; no WSL or Bash is required. To select a Python interpreter explicitly in PowerShell:

```powershell
$env:AVATAR_SETUP_PYTHON = "C:\Path\To\Python310\python.exe"
npm run avatar:setup
```

Restart `npm run dev` after editing `.env`. Open **http://localhost:5173**, enter a topic, choose **Boson talking avatar**, select a **Student avatar**, optionally edit the student name, and click **Start lesson**. The preset name is used by default and updates when you choose another preset; a custom name is used in the conversation and classroom interface. Enable the microphone once the connection and actual video track are ready. Let the student finish speaking before responding; microphone audio is not forwarded during avatar playback, which prevents speaker echo from triggering another response. Check that the transcript and understanding map update. Use **End lesson** when finished.

Choose **Realtime audio** to use the current low-latency Realtime speech, or **Emotion-tagged Higgs TTS** to synthesize the completed response with inline Higgs TTS emotion tags before playback. Tagged TTS is available for both talking-avatar and voice/photo sessions; the avatar mode forwards its synthesized 24 kHz PCM to the synchronized avatar output. This adds some startup latency, then streams PCM as it is generated. Emotion tags are applied on about half of eligible conversational replies; the rest use neutral speech. Anger and sadness are selected most often among tagged replies; amusement, contentment, contemplation, and surprise are also included. Anger/sadness can include shouting/crying style cues, and contemplation can include a prosody pause. The debug drawer records the selected emotion and tag, and synthesis errors are shown in the classroom instead of silently falling back to Realtime audio. The learning-map dashboard has an **Emotion & teacher response** section showing each student anger/sadness cue and whether the teacher's next transcribed response acknowledged it. While the avatar's response is calling `update_understanding` to log a taught fact, that response is synthesized without an emotion tag; the subsequent conversational response can use emotion normally. This keeps the fact-logging response from sounding emotionally tagged before the teacher has a chance to react to the student's conversational reply. Acknowledgment is a lightweight transcript-based check, not audio sentiment analysis. The API key remains on the local server. See the [Higgs TTS tags guide](https://docs.boson.ai/models/higgs-tts/tags) for supported controls.

Before starting, use the student's response-style slider to choose how readily they question explanations. The student always begins with a blank topic knowledge state, regardless of the slider. Low values make them more receptive to the instructor's claims; higher values make them more likely to question claims based only on facts already taught in the conversation. The slider does not provide prior topic knowledge. The learning map lists what the student was taught, including claims flagged as misconceptions, alongside a separate instructor fact check. Claims are marked accurate only when the check affirmatively supports them, incorrect when clearly contradicted, and otherwise unverified. Instructor-only findings and corrections are not sent back to the student's model context; “accurate” is an AI-assisted check, not a formal guarantee.

Optionally upload a plain-text `.txt` reference file in lesson setup (64 KB max; 16,000 characters max). It is used only by the instructor guide extractor and assessment to ground the teachable facts and check claims against your supplied reference; the student is not given the notes and must still be taught through the conversation. The notes stay in server memory for the lesson's lifetime (up to one hour) and are sent to Boson for guide extraction and explanation assessment. Local mock mode does not use reference notes.

When notes are uploaded, lesson preparation also extracts a short instructor-only checklist of teachable facts explicitly supported by those notes. These points remain separate from the generated lesson concepts and are not assigned to them. Find **Teach from your notes** in the learning map. A point is automatically marked complete and added to the student's taught-facts record when the instructor assessment detects that your explanation substantively teaches it. The server also stores a verbatim source excerpt for every checklist point and marks it complete when the spoken explanation directly covers that excerpt, even if semantic assessment misses the match; merely mentioning or confirming a point does not count. The instructor check also records substantive facts about the lesson topic even when they are independent of both the generated concepts and uploaded notes. These appear under **Other facts taught** and in **What [student] has been taught**, with an instructor accuracy review, and count as a successful teaching update without changing the lesson concept's mastery status. Independent facts are separate from the uploaded-notes checklist and do not mark unrelated note points complete. This tracks what was taught, not whether the student has learned or retained it; the separate evidence-based concept map continues to track the student's responses.

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
- `src/realtime/speechTags.ts` builds the documented inline Higgs TTS control tags. Voice/photo mode requests tagged PCM from the local `/api/speech` proxy; avatar mode requests the same Higgs TTS model from its managed worker and sends those PCM frames to `DataStreamAudioOutput`.
- `src/realtime/avatarToolBridge.ts` uses the same topic-specific tracker and independent evidence checks as voice mode, grounds evidence in actual human turns, deduplicates tool call IDs, and sends one continuation per response batch. State/transcripts flow to the existing React interface.
- `src/ui/LiveAvatarVideo.tsx` shows an actual remote video track, or a clearly labeled waiting state. Connection becomes usable only after the voice agent and video track are both present.

Each lesson has its own room. Only the `user` microphone is forwarded; mic frames are paused during avatar playback to prevent speaker echo from being mistaken for another user turn. The avatar listens only to the `agent` participant. Boson renders the face and voice together. `playback_finished` supplies the played duration, so the worker truncates conversation history to match what was heard.

When a learning update fails, the student receives a per-lesson anger level that rises with consecutive failures and resets after progress. They can sound sharply angry at an explanation that is not helping and demand a different approach; the roleplay does not include threats, demeaning personal attacks, or slurs.

The student prompt asks the avatar to express a randomly selected emotion through vocal delivery, with anger and sadness selected most often. Emotion is not written as a label or control token in the spoken transcript. In **Emotion-tagged Higgs TTS** mode, the app adds the selected supported inline tag to the clean transcript only in the server-side synthesis request; the tag controls the generated audio and is not displayed or spoken. Leading bracketed mood labels and inline control tokens are removed from displayed speech transcripts.

The student asks open-ended questions and follows the facts the instructor chooses to teach; generated lesson concepts are private assessment categories, not a prompt or sequence for instruction. Each clear factual statement is recorded in a topic-wide taught-facts state, even when it is a short sentence without supporting explanation or the evaluator cannot match it to a concept. Its accuracy can remain unverified. The instructor-only assessor can independently match one statement to any generated concepts and uploaded-note facts, without requiring the student to select a concept. A single statement can update multiple matches, and a new fact can be recorded even when it matches no generated concept or note. Short yes/no answers to the student's direct questions are paired with the immediately preceding spoken question and recorded as unverified beliefs in the topic-wide state.

Ending a lesson, closing the tab, losing the event stream, leaving the room, or reaching the 10-minute cap initiates cleanup. The worker releases the Boson session in `finally`; the Node server also attempts a backup release. Session creation is not automatically retried, because it is not idempotent. A cancellation during creation waits for the pending request to finish so the returned session can be released.

## Uploaded photos

**Boson voice + photo** keeps your chosen photo in browser IndexedDB. That is a still portrait, separate from the preset used in talking-avatar mode. Switch to **Boson voice + photo** to upload or change the portrait; uploaded photos are not used as live-video avatars. The published live API accepts a registered `avatar_id`; the full OpenAPI schema does not document a photo-registration endpoint. Boson reportedly supports custom photos for the team, but its registration instructions are still needed. Do not guess an endpoint or pass an image as an avatar ID.

## Configuration and diagnostics

Optional server-only overrides:

```dotenv
# Exact preview ID supplied in the hackathon slides and verified by the server:
BOSON_REALTIME_MODEL=higgs-realtime-1.5-preview
BOSON_REALTIME_URL=wss://api.boson.ai/v1/realtime
# Path to a prepared Python environment, if not the default:
# AVATAR_PYTHON=C:\Path\To\Python310\python.exe
```

The main classroom loads its session config directly from TypeScript at startup. It does not require `npm run avatar:config`; that export is only for standalone diagnostics.

`GET /api/avatar/status` reports missing LiveKit settings and whether the Python environment exists. `GET /api/avatar/presets` reads your Boson catalog. Neither starts a billable avatar session. `POST /api/avatar/lessons` refuses incomplete settings before creating a room or avatar; its short-lived room token is intended for the browser. The server remains bound to localhost. Add authentication and issuance limits before public deployment.

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
