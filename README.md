# Human Intelligence · TeachBack

Teach an AI student instead of asking an AI tutor. Enter **any topic**—photosynthesis, French past tense, jazz improvisation, a recipe, or something else—and teach **Maya or Kai** in your own words. Each lesson gets its own three starting concepts, questions, and learning map. Both stay curious learners rather than becoming expert tutors.

Built from [Boson’s official Higgs Realtime tutorial](https://github.com/boson-ai/Higgs-Realtime-Tutorial). The starter’s microphone capture, PCM streaming, server VAD, barge-in/playback truncation, transcript reducer and batched tool loop are reused. See [upstream attribution](docs/UPSTREAM.md) and LICENSE. No model training takes place.

## Run locally

**Whiteboard vision:** the existing canvas now sends event-driven JPEGs to **Gemini 3.5 Flash-Lite on Vertex AI**, using local **Application Default Credentials**—no `GEMINI_API_KEY`. Set `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION=global` in `.env`, then restart the server. During a live lesson, finished edits capture after 120 ms and long strokes can update every 350 ms. One request runs at a time; pending revisions are replaced and stale results discarded. Real observations silently replace visual context through supported Boson `session.update` instructions, without restarting the conversation or triggering speech. Clear immediately invalidates previous drawings. Open **Vision debugging** for measured capture/provider/context timing. Real tests recognized the red circle, added arrow and erased circle; current provider inference is roughly 1.3–1.5 seconds, so consistent sub-second updates are not claimed. [Setup, actual results, browser experiments and limitations](docs/WHITEBOARD-FALLBACK.md).

Install **Node.js 22.22+** and npm first (`node --version`). From this directory:

```bash
npm ci
cp .env.example .env
# Edit .env and set your Realtime 1.5-enabled BOSON_API_KEY for live voice.
npm run dev
```

Open **http://localhost:5173**. The command starts the Node token server on port 3000 and React/Vite on port 5173.

1. Enter a topic, choose **Maya** or **Kai** and a **Student intelligence** level, choose Boson talking avatar or Boson voice + photo, and click **Start lesson**. Boson prepares a small topic-specific learning map.
2. Click **Start microphone**, allow browser microphone access, and begin explaining the topic. You can start by asking Maya what they think it means.
3. Explain the idea. Pause to let Boson’s server turn detector respond. Speak over Maya to interrupt.
4. Read the transcript and learning map. Click **Ask Maya to teach back** after an explanation.
5. **Stop microphone** pauses listening; **End lesson** stops the mic, clears queued speech and disconnects. Starting another lesson resets the conversation and knowledge.

Use headphones to minimize echo. Microphone access needs localhost or HTTPS. Chrome is the recommended first demo browser. Text input is also available in live mode; Maya still answers with Boson speech.

### Use an iPad or tablet as the whiteboard

Start a lesson on the computer, open **Whiteboard**, and choose **Connect tablet**. The app creates a lesson-scoped pairing link and displays it as a QR code. Scan it with the tablet camera; the tablet opens a drawing-only view with pen, eraser, colors, stroke width, undo, redo, clear, connection status, and disconnect. It never requests microphone or speaker access.

For local testing, put the computer and tablet on the same Wi-Fi network and keep `npm run dev` running. Vite and the TeachBack server listen on the local network; when the computer page is opened as `localhost`, the server prefers the Wi-Fi IPv4 address when building the QR link. On Windows, check the **Wireless LAN adapter Wi-Fi** section of `ipconfig` if the QR link shows a virtual adapter address. Allow incoming Node.js connections through the firewall on private networks. If automatic address selection is wrong—common with VPNs or multiple adapters—set this in `.env` using the computer's Wi-Fi IPv4 address and restart:

```dotenv
PUBLIC_APP_URL=http://YOUR_WIFI_IP:5173
```

In a deployed environment, set `PUBLIC_APP_URL=https://your-teachback-domain.example` unless the reverse proxy forwards the public host and protocol correctly. The same origin must proxy ordinary `/api` requests and WebSocket upgrades at `/api/whiteboard/ws` to the Node server.

Boards synchronize normalized vector marks, including live stroke previews, rather than images. The server retains the latest mark snapshot in memory so a tablet can reconnect while its 10-minute pairing link remains valid. Each lesson has a cryptographically random token, separate board state, operation deduplication, size validation, and explicit revocation when the lesson ends. The token is stored in the QR URL fragment so it is not sent in the initial tablet page request; no Boson, LiveKit, Google, or other privileged credential is exposed. Restarting the Node server clears active shared boards.

Turn-taking uses Realtime 1.5's server VAD with native response creation and interruption enabled. Voice mode clears its PCM queue and truncates the unheard assistant audio when speech starts. Avatar mode continuously forwards the LiveKit microphone—even while the avatar is speaking—then clears synchronized avatar playback on the same supported speech-start event. No inactivity response timer is enabled: after asking a question, the student waits for a real user turn. The development event drawer records speech start/end, response start/end, playback clearing, truncation, avatar interruption, and suppressed stale tool continuations without logging raw audio.

**No key?** Run the same commands, choose **Local mock (text only)**, then **Start lesson**. Enter a topic and type an explanation. This deterministic fixture uses transcript grounding and simulated assessments, but has **no microphone, no speech, no live AI and no avatar**. It never silently replaces a failed Boson connection.

## Maya, Kai and student intelligence

Choose your student before starting: **Maya** uses Boson's Claire preset, and **Kai** uses James. These are TeachBack character names; the real provider avatar IDs remain unchanged. A configured account-owned avatar is preserved, and **Change avatar appearance** keeps all available preset/custom faces accessible. If a character's preferred face is unavailable, the catalog default is used.

**Student intelligence** controls simulated learning behavior: **Needs more guidance** asks for plain language, worked examples and practice; **Balanced** asks normal follow-ups; **Quick learner** connects explanations faster and asks deeper application questions. The setting applies equally to either student, in voice and live-avatar mode. It does not change model weights or claim a measured IQ. The same evidence checks govern the understanding map at every level.

Student and level are saved in each lesson definition and locked during the lesson. End the lesson to change them; changing either resets the previous transcript/map before a fresh lesson. The local text mock displays the selected name and different follow-up styles, but remains a deterministic UI fixture.

## Realtime 1.5 early access (team priority)

The team-provided **Boson-Opening-2026.pdf**, slides 7 and 17, gives the exact model ID: **`higgs-realtime-1.5-preview`**. A credentialed smoke test accepted that ID, the server reported it in `session.created`, and Maya returned real speech. The app now defaults to this exact preview ID; it does not silently fall back to `higgs-realtime`.

```dotenv
BOSON_API_KEY=your-early-access-key
BOSON_REALTIME_MODEL=higgs-realtime-1.5-preview
BOSON_REALTIME_URL=wss://api.boson.ai/v1/realtime
```

The server, browser, diagnostic probe, and managed avatar bridge use this shared model setting. Restart the dev command after editing `.env`. The standalone avatar export also needs `npm run avatar:config` after a model change.

**Scope of verification:** the preview ID works with the official starter's existing audio/session protocol. This does not establish that native full-duplex video is enabled by this configuration. The app retains the starter's supported turn-detection settings until preview-specific integration instructions are available.

Slides 8 and 16 demonstrate a face driven by a reference image and speech. Slides 17–18 describe Realtime 1.5 producing face video from the same realtime model. The deck has no reference-image request fields, video event schema, upload/registration route or transport example. Its native-face feature may offer a different path from the published LiveKit/preset API; implementation needs Boson's specific preview example rather than guessed fields. See [the slide findings](docs/HACKATHON-SLIDES.md).

## Credentials

| Feature | Server environment | Where to get it |
| --- | --- | --- |
| Voice | `BOSON_API_KEY` with available credit | Boson Workspace API keys |
| Optional avatar | Same `BOSON_API_KEY`, plus `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit **Cloud** project → Settings → Keys |
| Mock | None | Local text fixture |

Never prefix keys with `VITE_`, put them in frontend code, or commit `.env`. The browser receives only a fresh temporary Boson client secret from `/api/token`. The live-avatar classroom receives only a short-lived **user room token**; its server credentials stay in the Node/Python processes. Boson’s live avatar requires LiveKit Cloud; self-hosted rooms are unsupported in the supplied guide. [Official session guide](https://docs.boson.ai/models/higgs-avatar/realtime-sessions)

## Architecture and ownership

```text
React UI → local /api/token → Boson ephemeral credential
Browser microphone → official RealtimeClient → Higgs Realtime
Higgs audio → official RingPlayer → speakers
Topic input → server-side Boson structured call → lesson concepts/criteria
Higgs events → official transcript reducer → transcript
Higgs update_understanding tool → quoted human evidence → independent Boson assessment → learning map
Laptop/tablet pointer events → lesson-token WebSocket relay → shared vector marks → existing canvas/vision pipeline
```

| Area | Files | Suggested owner |
| --- | --- | --- |
| Voice and credentials | `server/index.ts`, `src/realtime/RealtimeClient.ts`, `src/audio/` | Developer 1 |
| Student behavior and learning | `src/realtime/sessionConfig.ts`, `src/state/lesson.ts`, `src/state/topicKnowledge.ts`, `server/lessons.ts`, `src/tools/` | Developer 2 |
| Interface and avatar | `src/App.tsx`, `src/ui/`, `src/index.css`, `avatar/`, `src/realtime/LiveAvatarClient.ts`, `server/avatarSessions.ts` | Developer 3 |

`src/realtime/MockClient.ts` exposes the same interface for UI development. Each client owns an isolated knowledge tracker. The official tutorial’s original chapters remain in `docs/`; their old web-search examples describe the upstream app, not TeachBack. The root README is the setup authority for this project.

## Any-topic lessons and evidence

A lesson begins with the topic entered in the classroom. The Node server asks Higgs Realtime 1.5 for three relevant beginner concepts, two explanation criteria per concept, an opening question, and at most one plausible starting misconception. Unfamiliar/private topics should use clarification-oriented concepts instead of fabricated facts. All plans are validated before they reach the student.

Maya's system prompt and `update_understanding` tool schema are generated from that lesson. The learning map displays its actual concept labels. Each new lesson resets the transcript, evidence and state, even when two different topics happen to use the same internal concept IDs. A topic cannot be edited while its lesson is active: end the lesson, enter a new topic, and start again.

The tool accepts only a lesson concept ID and a verbatim human quote:

```json
{
  "concept": "concept_1",
  "evidence": "Plants need sunlight, water and carbon dioxide for photosynthesis."
}
```

The tracker first matches the quote against an actual observed human turn and rejects bare reassurance. An independent Boson text/tool session then assesses the recent human explanations against that concept's two criteria, using the entire source text so a cherry-picked quote cannot hide a contradiction. It returns matched criterion IDs and whether there is a concrete misconception. The tracker derives `unknown`, `misunderstood`, `partial`, or `understood`; Maya cannot self-award a status. One matched criterion gives partial, two give understood, and a concrete misconception gives misunderstood. Unsupported explanations leave state unchanged.

The same logic powers avatar and voice modes. Side-channel planning/assessment calls use the supported Boson Realtime protocol with text output and function calling, not another AI provider. They are serialized to avoid exhausting realtime concurrency. Assessments are cached within a lesson, errors preserve the previous state, and a result is discarded if a newer human explanation arrives while it is being checked. A delayed tool continuation does not start speech over a newer human turn.

**Practical limits:** the plan and semantic assessment are model-generated, not a validated exam or a guarantee of factual correctness. Private/uncertain facts can remain unsupported. The map is three starting concepts, not complete coverage of a subject. Voice transcription is still configured for English; typed explanations preserve Unicode text. The model simulates learning; no underlying weights are trained. Lessons/evidence live in memory, plans expire after an hour, and there is no database. Preparing a live lesson and assessing explanations consume Boson API credit.

**Local mock** needs no API call for topic preparation. It uses generic main-idea/mechanism/example cards and a clearly labeled simulated assessment. It is for UI work, not semantic evaluation. The original gradient-descent rubric remains only as a backward-compatible diagnostic fixture; the classroom always supplies a fresh topic-specific lesson.

## Upload a photo for Maya

A separate, verified **generated talking-photo test** is available as `npm run probe:photo -- --image '/full/path/student.jpg' --out captures/student.mp4`. It uses Boson's documented video endpoint, polls, and downloads an MP4. It does not turn the classroom portrait into a live custom avatar. See [the test result, setup, and missing live protocol](docs/CUSTOM-AVATAR-INVESTIGATION.md).

In the classroom, click **Upload a photo** or drop a photo on the avatar area. Choose a JPG, PNG or WebP up to 10 MB. The portrait appears while you talk to Maya. **Change photo** replaces it; **Remove** clears it. The photo persists across refreshes and new lessons in the same browser/profile/origin.

Photos are decoded to reject corrupt files and saved as blobs in IndexedDB. They are not sent to Boson or stored on the server. Clearing browser site data also removes them. If browser storage is unavailable, a valid image can still be shown for the current visit, with a visible notice.

The badge **Photo avatar · Not animated** means this is a still portrait. It does not claim to lip-sync. Boson's published live-session schema accepts a preset or an account-owned `avatar_id`; its published API routes do not include photo registration. Once Boson registers your photo, set `BOSON_AVATAR_ID` to the returned ID in `.env`, restart `npm run dev`, and refresh the classroom. It selects that ID if it appears in your key's catalog. Owned avatars appear as **Account avatar** alongside presets. An unavailable configured ID produces a notice and selects an available preset. Leaving the variable blank prefers an owned avatar, then a preset. LiveKit Cloud credentials are required for this live path. [Official session request schema](https://docs.boson.ai/api-reference/avatar-realtime/create-a-session)

## Boson talking avatar (integrated)

The classroom now defaults to **Boson talking avatar**. Your key's full available-avatar catalog is loaded from Boson; the checked catalog currently contains only Claire, Emma, and James. Choose an avatar, start a lesson, then enable the microphone. Boson publishes the actual moving video and synchronized voice in LiveKit; no prerecorded clip or simulated animation is used.

**One-time setup:** create a project at [LiveKit Cloud](https://cloud.livekit.io). Copy its project URL and a key/secret from **Settings → Keys** into `.env`:

```dotenv
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-project-key
LIVEKIT_API_SECRET=your-project-secret
```

Then run:

```bash
npm run avatar:setup
npm run dev
```

The setup command selects an installed Python 3.10+ and installs Boson's official-example dependencies into `.venv-avatar`. On Windows it supports the Python launcher (`py`) and creates a Windows virtual environment; no WSL or Bash is needed. To select an interpreter explicitly, set `AVATAR_SETUP_PYTHON` to its executable path before running the setup command. Restart the running dev command after editing `.env`.

Open http://localhost:5173, enter your topic, choose **Boson talking avatar**, choose a **Student avatar**, click **Start lesson**, wait for the real video track, then **Start microphone**. There is no separate Python command or token copying for the main classroom: the Node server starts and stops the official-example-derived bridge automatically. Voice-only use remains available as **Boson voice + photo** while LiveKit is being configured.

The server creates one isolated room per lesson, mints a short-lived user token, starts the Python bridge, and streams transcript and knowledge events back to React. The same evidence validator handles Maya's tool calls. The avatar's own audio track is the only speaker output. LiveKit handles microphone capture; Boson's server handles turn detection; `DataStreamAudioOutput` drives video/audio playout and clears the buffer when interrupted. Playback acknowledgements supply the heard duration for history truncation. End lesson, tab close, stream disconnection and a 10-minute cap all trigger cleanup.

LiveKit credentials are now configured locally. A headless live test received actual moving Claire video and speech, exercised the learning tool, and verified the room was empty after cleanup. Human-device playback and the perception of lip synchronization still deserve a short browser check. Client/learning integration tests, TypeScript and build checks also pass. Detailed setup and troubleshooting: [AVATAR.md](docs/AVATAR.md).

## Checks and troubleshooting

```bash
npm test
npm run test:avatar  # after npm run avatar:setup
npm run typecheck
npm run build
npm run avatar:config
npm run avatar:check
```

Tests cover arbitrary-topic prompts/tool schemas, independent-assessment gates, Unicode evidence, confirmation rejection, gradual learning, stale-result rejection, cross-topic isolation, local mock lessons, the upstream transcript/resampler, and connection/tool/interruption behavior. They do not prove live API access, speech quality, or lip synchronization.

Credentialed diagnostics, using the starter’s headless probe (Node 22+):

```bash
npm run probe -- --text "Hi Maya, what does the gradient tell us?"
npm run probe -- --say "The gradient points uphill. We take the negative gradient to decrease loss."
```

The second command also calls Boson TTS to synthesize input and requires credit. Probe event captures are gitignored. It is a protocol diagnostic; use the actual browser call to validate microphone and speaker devices.

If the voice connection fails, read the visible error and expand **Event log**. Confirm `BOSON_API_KEY` is set and the account has credit; restart the server after changing `.env`. If the input meter stays flat, check your device and browser permission. `/api/health` tests the local server; `/api/config` indicates only whether a key is configured, not whether it is valid. `/api/token` returns 503 when no key is set.

For a local production-build check:

```bash
npm run build
npm start
```

Open http://localhost:3000. `npm run preview` is a static preview only and does not include the credential server. Both app modes are a local, single-user hackathon prototype. Add authentication and credential issuance limits before deploying publicly. The development server binds to the local network to support tablet pairing; firewall access should be limited to trusted networks.

## Next three small tasks

1. **Developer 1:** complete a microphone lesson on a topic of your choice, interrupt Maya during a pending learning check, and record whether transcripts, speech and learning updates line up.
2. **Developer 3:** test a second subject through the avatar in the browser and refine lesson setup or topic-specific feedback based on that run.
3. **Developer 2:** add held-out teaching examples for several subjects to assess the topic planner and evidence checker beyond the smoke tests.
