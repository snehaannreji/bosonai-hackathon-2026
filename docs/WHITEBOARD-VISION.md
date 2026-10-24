# Whiteboard video investigation and local proof of concept

**Historical native-video investigation.** A separate event-driven Vertex AI image-analysis fallback is now implemented and tested. See [current setup and actual whiteboard-to-voice results](WHITEBOARD-FALLBACK.md). This page preserves the earlier native-protocol findings; its blocked status is not the status of the new fallback.

Status, October 24, 2026: **whiteboard editing and local canvas-video capture are implemented; model vision is blocked by the missing private Realtime 1.5 camera-input protocol.** No drawing has been delivered to Higgs. No recognition result, recognition latency, or visual learning success is claimed.

## Architecture inspected before implementation

| Path | Actual implementation |
| --- | --- |
| Voice + photo | Browser microphone → official PCM16 capture/resampler → `input_audio_buffer.append` on a Boson WebSocket → `response.output_audio.delta` → browser playback. |
| Talking avatar input | Browser microphone published to LiveKit; Python subscribes only to audio from participant `user`, then forwards PCM to the same Boson audio WebSocket. |
| Talking avatar output | Higgs audio → official `DataStreamAudioOutput` → Boson's avatar participant → synchronized audio/video tracks → browser. This is output video, not model camera input. |
| Video source identifiers today | Browser attaches output video only from participant `boson-avatar`; worker forwards input audio only from participant `user`, deduplicated by track SID. No input-video source is selected or encoded for Higgs. |
| Whiteboard now | An origin-clean 640×480 drawing canvas → `captureStream(0)` + `requestFrame()` on changes, capped at 3 FPS → a local HTML video preview. No network image requests or video publications occur. |

The LiveKit agent subscribes to the room, but its `track_subscribed` handler filters for `KIND_AUDIO`. Publishing a canvas video track alone would produce no model input. Neither the existing browser client nor Python bridge has an image/video encoder, a Boson video-input event, or a WebRTC camera path into the model. The preview's method for distinguishing camera/whiteboard streams is **unknown**, not inferred from LiveKit track names.

**Existing interruption limitation:** this checkout's `avatar/agent.py:send_microphone_frame` drops microphone frames while avatar playback is active, to suppress speaker echo. It therefore does not establish the full-duplex behavior shown in the deck. This work preserves that existing behavior. The ordinary voice client still has the starter's interruption/truncation logic. Concurrent whiteboard recognition, voice barge-in and avatar synchronization cannot be certified without the private visual protocol and a live hardware test.

## Evidence and sources

- Team-provided opening deck, slide 11: a simultaneous live camera/microphone demonstration; drink identification and changing finger counts. Slide 17 describes audio/video arriving while the model speaks. The slides prove a demonstrated research capability, but supply no endpoint, request fields, codec, source IDs, SDK, or receiving-track binding. There are no embedded files with an implementation. This corrects the earlier slide review, which focused on face output and omitted slide 11.
- Local `.env.example`, runtime config, SDK requirements, tutorial chapters, tools, and source code contain no private camera example. The user confirmed no additional private SDK/documentation is available.
- The refreshed [official realtime client event reference](https://docs.boson.ai/api-reference/realtime/client-events) documents audio buffers and text/tool items, with no image/video input events. The [current OpenAPI](https://docs.boson.ai/openapi.json), [docs index](https://docs.boson.ai/llms.txt), and [official starter](https://github.com/boson-ai/Higgs-Realtime-Tutorial) do not provide the private preview protocol. Absence there does **not** prove the private model cannot accept vision.
- Another [official hackathon repository](https://github.com/boson-ai/hackathon-m3-api-card-public) was inspected; it concerns HiggsAudioM3 chunked audio-in/text-out, a different model/API. Its protocol was not substituted for Realtime 1.5.

## Credentialed session discovery/control

Run the existing app, then:

```bash
npm run probe:vision
```

This uses the local `/api/token` ephemeral credential, the configured secure WebSocket/model URL and supported `session.update`, `conversation.item.create`, `response.create` events. It does not guess vision events, upload images, or inject drawing descriptions. It stores a sanitized report under ignored `captures/whiteboard-vision-probe.json`, never primary keys, temporary secrets, complete session responses, or raw audio. It consumes one short Realtime session. Exit code **2** means visual integration remains blocked; **1** means discovery/control failed.

The actual run acknowledged **`higgs-realtime-1.5-preview`**, produced **166 audio chunks**, and exposed these session keys: `audio`, `id`, `instructions`, `max_output_tokens`, `model`, `object`, `output_modalities`, `temperature`, `tool_choice`, `tools`, `truncation`, `type`. Its audio-input keys were `format`, `noise_reduction`, `transcription`, `turn_detection`; no visual-input keys were advertised.

Asked only whether it currently receives visual input, the model replied:

> I don't receive any visual input right now. I have no images or video to look at, so I can't describe anything I'm seeing.

That is a **negative control**, not an image-understanding test or proof that a separate private protocol is unavailable. Zero visual frames were sent. The report explicitly records `recognitionTestRun: false`, latency `null`, concurrent-update status `null`, and interruption/avatar tests `false`.

## Try the whiteboard and local video source

```bash
npm run dev
```

Open **http://localhost:5173/vision-lab** for the isolated experiment, or use the whiteboard below the normal classroom. Existing credentials and Python setup are unchanged. There are no new packages or vision keys.

- Draw freehand with mouse/touch; use arrow, line, rectangle, circle, text and eraser tools. Text supports plain Unicode math such as `∇L = 2θ` and `x²`, not a LaTeX layout engine. Click the canvas to place typed text. Undo and Clear are available.
- **Test local capture** creates a genuine canvas video track. The preview's decoded-frame counter is a browser playback metric, not a count of frames received by Higgs. With no drawing changes, few/no additional frames are expected. Check the browser tab stays foreground during timing tests.
- The local experiment buttons render actual successive pixels: blank → red circle → circle plus blue arrow → blue arrow only. No button labels, shape objects, or descriptions are transmitted to any model. Observe the local preview after each action to check it follows the latest pixels.
- **Start sharing whiteboard** checks `/api/vision/status`, then reports the missing adapter. It never labels local capture as **Streaming**. **Stop sharing whiteboard** clears the attempt/error and stops the local capture, without touching the microphone or avatar tracks.
- Capture is stopped on component unmount; pending readiness requests are aborted. The board is in memory only and clears on reload. Prototype limits are 300 marks and 2,000 points per freehand stroke. No toolbar, cursor, transcript or other UI is part of the captured canvas.

A small native canvas was chosen for this blocked protocol experiment: the drawing surface is already a reliable video source, without introducing tldraw plus an asynchronous SVG/HTML rasterization loop. No call to `captureStream()` on a tldraw editor is assumed. A richer editor can later replace the renderer while retaining a dedicated capture canvas.

The capture scheduler coalesces changes to at most 3 requested frames per second (nominal up to ~333 ms before a requested frame, plus browser encoding/decoding). Browsers lacking `requestFrame()` use `captureStream(3)` native change capture. This is **not measured end-to-end model latency**; background-tab throttling can increase delay. No periodic image-analysis fallback exists.

### Checks actually performed

In desktop Chrome, the lab was opened and a real canvas track played in the local `<video>`. The current canvas and video preview were visually compared: a red circle plus blue arrow matched; removing the circle left only the blue arrow in both; clearing left both blank. The decoded-frame counter advanced from 2 to 3 to 4 across those updates. Clicking **Start sharing whiteboard** displayed the missing-protocol error while the preview remained explicitly labeled **Not sent to AI**. No model recognition is implied by these browser observations. Local update latency was not timed.

That browser test exposed and corrected a missing initial redraw before `video.play()` and the need to repaint current pixels immediately after each manual frame request, so a final erase does not wait for a later stroke. A spurious line in ellipse rendering was also corrected. Automated checks cover erasure/blank redraws, coordinate scaling, frame-request ordering, rapid-change coalescing, native-capture fallback, resource cleanup, capture failures and the capability/vision-claim boundary. Existing conversation/learning/avatar tests remain included.

Final checks: **139 JavaScript tests and 17 Python tests pass (156 total)**; the TypeScript/production build passes with the existing large-bundle warning. The running `/api/vision/status` endpoint reports the exact preview model with `adapterReady: false`, `transport: null`, and `modelVisionConfirmed: false`. Local browser observations are recorded in ignored `captures/whiteboard-local-validation.json`; the sanitized real model control is in `captures/whiteboard-vision-probe.json`.

## Exact missing Boson information

Ask the Boson engineers for the **minimal working camera + microphone example used for slide 11 on `higgs-realtime-1.5-preview`**, plus confirmation that the same mode is enabled for this key:

1. Exact endpoint, authentication/ephemeral-token scopes, private SDK/version and session fields that enable simultaneous audio/video input. Confirm whether the public audio endpoint serves that mode or a different preview endpoint is needed.
2. Input contract: browser `MediaStreamTrack`/WebRTC, a specifically consumed LiveKit track, encoded frames on a WebSocket, or another transport. For encoded frames, provide event/envelope schema, codecs, timestamps, dimensions/FPS, ordering and backpressure/drop rules.
3. Source association: camera identity, track SID/name/source, stream ID, or session binding; how to replace the camera with one canvas source; how microphone and frame timestamps share a clock; how to avoid the avatar output being consumed as input.
4. Receiver confirmation: subscription/ingestion acknowledgement, last-frame timestamp/sequence, freshness/reset semantics on erasure and stop, and any event proving the model consumed a frame. A LiveKit publish acknowledgement alone is insufficient.
5. Full-duplex turn/interruption configuration for that mode, and whether Higgs Avatar via the current LiveKit bridge can remain the output path.

No imagined `input_video_buffer.append`, OpenAI `input_image`, image-analysis endpoint, or undocumented registration route was sent to Boson.

## After the protocol is supplied

Keep `captureWhiteboard().stream.getVideoTracks()[0]` as the single visual source. Implement the official adapter in the existing conversation session; if it uses LiveKit, explicitly bind the intended `user` video publication to the model receiver and replace a camera source rather than blindly adding one. Do not enable `adapterReady` by configuration alone: the client intentionally fails closed until a real transport is implemented. Change the student's no-vision guard only once delivery and frame freshness are real.

Then run the requested live sequence with speech and actual pixels, without textual shape hints:

| Stage | Ask the student | Required evidence |
| --- | --- | --- |
| Blank | What is on the board now? | Current blank frame, no invented shapes. |
| Red circle | What shape and color are visible? | Red circle from pixels. |
| Add blue arrow | What changed? | New blue arrow and its relationship to the circle. |
| Erase circle while speaking | What remains? | Blue arrow only; no stale circle. |

Record actual response transcripts, drawing/capture/receiver timestamps, change-to-correct-response delay, one update during student speech, one spoken interruption, avatar continuity, stop/restart behavior, and a visually different control drawing with no spoken description. Only then mark model vision confirmed and connect visual evidence to learning. The current learning dashboard never updates from local shape metadata.

References: [canvas capture](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream), [manual frame requests](https://developer.mozilla.org/en-US/docs/Web/API/CanvasCaptureMediaStreamTrack/requestFrame), [LiveKit track publishing](https://docs.livekit.io/transport/media/publish/). These describe transport primitives, not Boson's private model input contract.
