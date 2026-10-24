# Hackathon opening slides: integration findings

Source: team-provided `Boson-Opening-2026.pdf` (22 pages, October 23–24, 2026). Relevant pages were text-extracted and visually inspected. The PDF contains no embedded files or hyperlink/annotation instructions on the relevant pages.

- **Slide 8:** a Higgs Realtime + Higgs Avatar live-call demo names a photo, voice and text prompt as its inputs. It establishes the demonstrated capability but supplies no API request.
- **Slide 16:** Higgs Avatar is demonstrated from one image with expression, lip sync and head motion. The slide labels the pipeline image + speech → video.
- **Slides 7 and 17:** the exact research-preview model ID is `higgs-realtime-1.5-preview`. Slide 17 describes concurrent listening/speaking and face video from the same model.
- **Slide 18:** the preview is described as producing face frames at 25 fps. This is a capability description, not a client framing or event schema.
- **Slide 15:** the starter is the same official Higgs Realtime Tutorial already used by TeachBack.

## Checked in this project

A single-turn call with the existing key at the standard realtime endpoint requested `higgs-realtime-1.5-preview`. The session acknowledged that exact model and returned audio and a transcript. The resolved session exposed only the standard audio/session fields and no image, avatar, or video fields. This confirms access to the named model through the current audio protocol, not native-video integration.

The default model, `.env.example` and local `.env` now request that exact preview ID. Existing explicit model/endpoint overrides remain available. There is no automatic downgrade.

## Still needed from Boson

A minimal official example for `higgs-realtime-1.5-preview` that specifies:

1. How a reference photo is supplied or registered.
2. Which endpoint and session fields enable native avatar output.
3. The video/audio event format and synchronization/interrupt behavior expected of clients.
4. Whether that preview mode needs LiveKit or returns native video on a separate transport.

The public preset-avatar route implemented in this app requires LiveKit Cloud and a catalog avatar ID. The opening deck describes preview capabilities beyond that public route; it does not prove the same registration or transport requirements apply. No guessed photo field, hidden endpoint, or fake animated video was added.
