# Custom talking portrait: verified paths

Checked October 23, 2026, using the team's configured Boson key. No credentials or source portraits are committed.

## What works

An authenticated `GET https://api.boson.ai/v1/avatars` returned HTTP 200 with only these three entries, all `is_public: true`:

| Name | avatar_id |
| --- | --- |
| Claire | builtin_claire_v1 |
| Emma | builtin_emma_v1 |
| James | builtin_james_v1 |

No owned/custom avatar was returned. This describes this key's current catalog, not every capability Boson may enable privately.

The supplied local `alex?.jpg` was successfully submitted to the documented `POST /v1/videos` API with an inline JPEG `ref_image` and this sole driving input:

```json
{
  "model": "higgs-tts-3",
  "input": "Hi, I'm Alex. What would you like to teach me today?",
  "voice": "default"
}
```

The outer model is `higgs-avatar`, the field above is `input_tts`, and the output size is `640x480`. No audio `input` or undocumented fields were sent. The tool polled `GET /v1/videos/{video_id}` until `completed`, then downloaded `GET /v1/videos/{video_id}/content`.

**Actual result:** job `video_f97c81e7216b49e58c443fc9`, MP4 208,436 bytes, H.264 640×480 video lasting 4.542 seconds, 109 decoded frames with 109 distinct pixel hashes, and AAC audio lasting 4.565 seconds with nonzero samples. Source and output frames were visually inspected: the supplied portrait appears with changing facial/mouth poses. This verifies photo-driven generated animation with an audio track. It does not certify perceptual lip synchronization or the spoken wording; review playback for those.

Local artifacts (gitignored):

- `captures/custom-alex.mp4`: generated clip, with Boson's AI disclosure.
- `captures/custom-alex.json`: resumable job record, source SHA-256 and submitted line; no image data/key.
- `captures/custom-alex-media-check.json`: decoded media measurements.
- `captures/custom-alex-frame-{1,40,80}.png`: inspected frames.
- `captures/custom-avatar-access.json`: redacted catalog result.

This clip is a capability test. It is not installed as the live student, looped, or presented as an interruptible conversation.

## Repeat the standalone test

Use the existing root `.env` with `BOSON_API_KEY`; LiveKit is unnecessary for this generated-video test. Node 22.22+ and the avatar Python environment are used by these scripts:

```bash
npm run avatar:setup  # only if .venv-avatar is not installed yet
npm run probe:photo -- --image '/full/path/student.jpg' --out captures/student-test.mp4
```

The supplied filename contains a literal question mark, so quote it:

```bash
npm run probe:photo -- --image '/Users/adelaiderow/Downloads/alex?.jpg' --out captures/alex-second-test.mp4
```

**Each new submission consumes API credit.** Use a new output name for an intentional new job. The input must be a PNG/JPEG with the correct file signature, at most 10 MB. `--text`, `--size`, and `--max-wait` are optional. Default text is the short Alex greeting above. Output artifacts are private local files under ignored `captures/` by default; selecting another output directory changes that.

On a polling/network failure, use the saved ID and the same output path, without uploading again:

```bash
npm run probe:photo -- --resume video_YOUR_SAVED_ID --out captures/student-test.mp4
```

Resume performs only GET requests. A create connection failure can have an unknown outcome; the tool never automatically retries the POST. If no ID was received, check Boson's job history/support before resubmitting. The script refuses to overwrite an existing MP4. HTTP error bodies are omitted to avoid accidentally logging uploaded data or credentials.

## Why live custom photos remain unverified

The published OpenAPI specification exposes `GET /v1/avatars` but no avatar creation, upload or registration operation. `POST /v1/avatar/sessions` accepts `model`, `avatar_id`, `transport`, `output`, and `max_duration_seconds`; it has no `ref_image` field. Its `avatar_id` documentation explicitly allows public presets or avatars owned by the API key, but does not explain how to create the owned avatars. No guessed endpoint or unsupported live-session field was tested.

The hackathon opening slides demonstrate a photo-driven live avatar and describe native face-video output from `higgs-realtime-1.5-preview`. They name the model but contain no reference-photo request, video event schema, or registration protocol. Previously verified access to that exact model covers its standard audio/tool protocol only. The public documentation index also supplies no preview-specific photo/video instructions. See [the material review](HACKATHON-SLIDES.md).

`POST /v1/videos/stream` streams generated fragmented MP4 with the same reference-image request; its existence alone does not establish a persistent, bidirectional session or a supported interruption protocol. Repeated per-turn clips would require new synchronization/cancellation machinery and have not been substituted for the official live bridge.

## Exact request for Boson's engineers

> Our key can run `higgs-realtime-1.5-preview` audio/tools, list Claire/Emma/James, and generate a custom-photo clip with `POST /v1/videos` + `ref_image` + `input_tts`. For a persistent interruptible custom student, please provide **one supported minimal example** for either path:
>
> 1. **Photo → registered avatar:** exact registration/upload method, URL, authentication and request schema; response `avatar_id`; readiness polling; how it becomes owned by/listed for our key; image requirements; enablement/allowlist requirements and cleanup. Confirm the returned ID works with `/v1/avatar/sessions` and its existing LiveKit `clear_buffer`/playback acknowledgements.
> 2. **Realtime 1.5 native video:** exact WebSocket/session endpoint and reference-image/session fields; output modality settings; video/audio event schema, codecs, framing, timestamps and synchronization; supported cancellation/barge-in behavior; whether LiveKit is required; and whether this capability is enabled for our key.
>
> The opening deck shows the capability but does not specify this wire protocol. We have not guessed a registration endpoint. A runnable official example and enablement confirmation are sufficient to proceed.

## Classroom and checks

The classroom uses its existing Boson/LiveKit integration with either a listed preset or an account-owned avatar ID. Its catalog no longer filters out owned avatars. `BOSON_AVATAR_ID` sets the default when listed; an unavailable configured ID produces a notice and falls back to a listed preset. Leaving it blank prefers an owned avatar when available. The selected ID reaches the same official session request through the managed worker. Voice transport, interruption handling, topic planning and learning assessment code were not changed. The browser photo uploader still represents a local still portrait. Photo registration itself remains unavailable until Boson provides instructions; no registration endpoint was invented. See [configuration details](AVATAR.md#account-owned-custom-avatars).

The new `avatar/photo_video.py` library and `tools/photo-video-probe.py` CLI are isolated from the classroom. Nine mocked protocol tests cover the exact request fields, image limits, completion-before-download, failed jobs, resume without POST, ambiguous-create failures, safe errors, polling deadline and invalid content. With the account-avatar configuration update, all 82 frontend/server tests and 13 Python tests pass; the TypeScript/production build passes with the existing bundle-size warning. These include private-ID propagation, configured selection, preset fallback and rejection of unknown IDs. Live server checks confirmed the default catalog selection, rejected an unknown-ID reservation, and reserved/released an unused default-ID token without starting a provider session. A real private-ID session cannot yet be tested because the current catalog has none. The real generated-video request above completed successfully, and its source SHA-256 still matches the supplied local portrait.

Official references: [input options and limits](https://docs.boson.ai/models/higgs-avatar/input-options), [create video](https://docs.boson.ai/api-reference/videos/create-a-video), [retrieve video](https://docs.boson.ai/api-reference/videos/retrieve-a-video), [download MP4](https://docs.boson.ai/api-reference/videos/download-content), [live sessions](https://docs.boson.ai/models/higgs-avatar/realtime-sessions), [avatar catalog](https://docs.boson.ai/api-reference/avatar-realtime/list-avatars), [published OpenAPI](https://docs.boson.ai/openapi.json), [documentation index](https://docs.boson.ai/llms.txt).
