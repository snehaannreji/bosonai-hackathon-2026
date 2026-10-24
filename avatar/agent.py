"""Boson's official realtime/LiveKit avatar bridge, with a local Node IPC adapter.
The classroom starts --managed; direct CLI use remains available for diagnostics.
Microphone transport and synchronized avatar playout use LiveKit's SDKs.
"""
import asyncio
import base64
import json
import os
import random
import signal
import sys
import threading
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

import requests
import websockets
from dotenv import load_dotenv
from livekit import api, rtc
from livekit.agents.voice.avatar import DataStreamAudioOutput

if "--check" in sys.argv:
    print("Avatar dependencies ready.")
    sys.exit(0)

load_dotenv()
MANAGED = "--managed" in sys.argv
ROOM = os.environ.get("TEACHBACK_ROOM", "avatar-demo")
AGENT_IDENTITY = "agent"
AVATAR_IDENTITY = "boson-avatar"
AVATAR_ID = os.environ.get("TEACHBACK_AVATAR_ID") or os.environ.get("BOSON_AVATAR_ID") or "builtin_claire_v1"
AUDIO_RENDERER = os.environ.get("TEACHBACK_AUDIO_RENDERER", "realtime")
MAX_DURATION_SECONDS = 600
BOSON = {"Authorization": f"Bearer {os.environ['BOSON_API_KEY']}"}
BOSON_BASE_URL = os.environ.get("BOSON_BASE_URL", "https://api.boson.ai").rstrip("/").removesuffix("/v1") + "/v1"
BOSON_REALTIME_URL = os.environ.get("BOSON_REALTIME_URL", "wss://api.boson.ai/v1/realtime")


def report(kind, **values):
    print(json.dumps({"kind": kind, **values}), flush=True)


def response_logs_fact(event):
    response = event.get("response") if isinstance(event, dict) else None
    output = response.get("output", []) if isinstance(response, dict) else []
    if any(
        isinstance(item, dict)
        and item.get("type") == "function_call"
        and item.get("name") == "update_understanding"
        for item in output
    ):
        return True
    return event.get("type") == "response.function_call_arguments.done" and event.get("name") == "update_understanding"


def should_apply_emotion(has_fact_log):
    return not has_fact_log


def choose_speech_emotion(rng=random.random):
    if rng() >= 0.5:
        return None
    return random.choices(
        ("anger", "sadness", "amusement", "contentment", "contemplation", "surprise"),
        weights=(4, 4, 1, 1, 1, 1),
        k=1,
    )[0]


def install_stop_handlers(loop, stop):
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            signal.signal(sig, lambda _signum, _frame: loop.call_soon_threadsafe(stop.set))


async def send_microphone_frame(ws, frame):
    """Continuously forward the user's LiveKit microphone to Realtime.

    Browser/LiveKit echo cancellation handles the remote avatar audio. Dropping
    frames while the avatar speaks prevents Realtime's native full-duplex VAD
    from ever detecting a human barge-in.
    """
    audio = base64.b64encode(bytes(frame.data)).decode()
    await ws.send(json.dumps({"type": "input_audio_buffer.append", "audio": audio}))


def livekit_token(identity, *, publish, subscribe, publish_on_behalf=None):
    token = (api.AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
             .with_identity(identity)
             .with_grants(api.VideoGrants(room_join=True, room=ROOM,
                                         can_publish=publish, can_subscribe=subscribe,
                                         can_publish_data=True,
                                         can_publish_sources=["camera", "microphone"] if publish else None))
             .with_ttl(timedelta(seconds=MAX_DURATION_SECONDS + 300)))
    if publish_on_behalf:
        token = token.with_kind("agent").with_attributes({"lk.publish_on_behalf": publish_on_behalf})
    return token.to_jwt()


async def main():
    config = json.loads(os.environ["TEACHBACK_SESSION_CONFIG"]) if MANAGED else json.loads(Path(__file__).with_name("session-config.json").read_text())
    model = os.environ.get("BOSON_REALTIME_MODEL", "").strip() or "higgs-realtime-1.5-preview"
    if config["session"]["model"] != model:
        raise RuntimeError("Model changed; rerun npm run avatar:config.")
    endpoint = urlsplit(BOSON_REALTIME_URL)
    query = dict(parse_qsl(endpoint.query)); query["model"] = model
    realtime_url = urlunsplit(endpoint._replace(query=urlencode(query)))
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    install_stop_handlers(loop, stop)
    room = rtc.Room()
    session_id = None
    tasks = set()
    output = None
    def task(coro):
        created = asyncio.create_task(coro); tasks.add(created)
        created.add_done_callback(tasks.discard)
        return created
    try:
        # Official Boson session request. No automatic retries: creation is not idempotent.
        response = await asyncio.to_thread(requests.post, f"{BOSON_BASE_URL}/avatar/sessions",
            headers=BOSON, json={"avatar_id": AVATAR_ID, "transport": {
                "type": "livekit", "url": os.environ["LIVEKIT_URL"], "room_name": ROOM,
                "participant_token": livekit_token(AVATAR_IDENTITY, publish=True, subscribe=False, publish_on_behalf=AGENT_IDENTITY),
                "participant_identity": AVATAR_IDENTITY, "publisher_identity": AGENT_IDENTITY,
            }, "max_duration_seconds": MAX_DURATION_SECONDS}, timeout=60)
        if not response.ok:
            try: code = response.json().get("error", {}).get("code", "request_failed")
            except ValueError: code = "request_failed"
            report("error", message=f"Boson avatar session failed ({response.status_code}: {code}). Check account access, credit, and LiveKit Cloud settings.")
            return
        session_id = response.json()["id"]
        report("avatar_session", id=session_id)
        if stop.is_set(): return
        await room.connect(os.environ["LIVEKIT_URL"], livekit_token(AGENT_IDENTITY, publish=True, subscribe=True))
        output = DataStreamAudioOutput(room, destination_identity=AVATAR_IDENTITY,
            sample_rate=24000, wait_remote_track=rtc.TrackKind.KIND_AUDIO)

        async with websockets.connect(realtime_url, additional_headers=BOSON) as ws:
            await ws.send(json.dumps(config))
            activity = None
            def set_activity(value):
                nonlocal activity
                if activity != value:
                    activity = value; report("activity", activity=value)
            current_item = None
            speaking = False
            truncate_item = None
            forwarded = set()
            tts_generation = 0
            response_transcripts = []
            response_has_fact_log = False
            tagged_items = set()

            @output.on("playback_finished")
            def played(event):
                nonlocal speaking, truncate_item
                speaking = False
                if truncate_item and event.interrupted:
                    item = truncate_item; truncate_item = None
                    # The SDK reports how much actually played, including after clear_buffer.
                    task(ws.send(json.dumps({"type": "conversation.item.truncate", "item_id": item,
                         "content_index": 0, "audio_end_ms": max(0, round(event.playback_position * 1000))})))
                set_activity("listening")

            async def forward_audio(track):
                stream = rtc.AudioStream(track, sample_rate=24000, num_channels=1)
                try:
                    async for event in stream:
                        await send_microphone_frame(ws, event.frame)
                except websockets.ConnectionClosed: pass
                finally:
                    await stream.aclose()

            @room.on("track_subscribed")
            def track_subscribed(track, _publication, participant):
                if participant.identity == "user" and track.kind == rtc.TrackKind.KIND_AUDIO and track.sid not in forwarded:
                    forwarded.add(track.sid); task(forward_audio(track))

            @room.on("participant_disconnected")
            def participant_left(participant):
                if participant.identity == "user": stop.set()

            for participant in room.remote_participants.values():
                for publication in participant.track_publications.values():
                    if publication.track is not None: track_subscribed(publication.track, publication, participant)

            async def commands():
                lines = asyncio.Queue()

                def read_stdin():
                    for line in sys.stdin:
                        loop.call_soon_threadsafe(lines.put_nowait, line)
                    loop.call_soon_threadsafe(lines.put_nowait, None)

                threading.Thread(target=read_stdin, daemon=True).start()
                while (line := await lines.get()) is not None:
                    try:
                        command = json.loads(line)
                        if command.get("kind") == "send": await ws.send(json.dumps(command["event"]))
                    except (ValueError, KeyError): pass
                stop.set()

            async def synthesize_tagged_speech(text, item_id, generation, apply_emotion=True):
                nonlocal current_item, speaking
                if not isinstance(text, str) or not text.strip():
                    return
                emotion = choose_speech_emotion() if apply_emotion else None
                tags = {
                    "anger": "<|emotion:anger|><|style:shouting|>",
                    "sadness": "<|emotion:sadness|><|sfx:crying|>",
                    "amusement": "<|emotion:amusement|>",
                    "contentment": "<|emotion:contentment|>",
                    "contemplation": "<|emotion:contemplation|><|prosody:pause|>",
                    "surprise": "<|emotion:surprise|>",
                }
                speech_input = f"{tags[emotion]}{text.strip()}" if emotion else text.strip()

                def request_audio():
                    response = requests.post(
                        f"{BOSON_BASE_URL}/audio/speech",
                        headers=BOSON,
                        json={
                            "model": "higgs-tts-3",
                            "input": speech_input,
                            "voice": "default",
                            "response_format": "pcm",
                            "stream": True,
                        },
                        stream=True,
                        timeout=180,
                    )
                    response.raise_for_status()
                    return response

                def next_chunk(iterator):
                    try:
                        return True, next(iterator)
                    except StopIteration:
                        return False, b""

                try:
                    response = await asyncio.to_thread(request_audio)
                    with response:
                        pending = bytearray()
                        current_item = item_id
                        received_audio = False
                        emotion_reported = False
                        chunks = iter(response.iter_content(chunk_size=1920))
                        while True:
                            has_chunk, chunk = await asyncio.to_thread(next_chunk, chunks)
                            if not has_chunk:
                                break
                            if generation != tts_generation or stop.is_set():
                                return
                            if not chunk:
                                continue
                            pending.extend(chunk)
                            while len(pending) >= 1920:
                                pcm = bytes(pending[:1920])
                                del pending[:1920]
                                await output.capture_frame(rtc.AudioFrame(pcm, 24000, 1, len(pcm) // 2))
                                if emotion and not emotion_reported:
                                    report("emotion", item_id=item_id, emotion=emotion, transcript=text.strip(), tags=tags[emotion])
                                    emotion_reported = True
                                received_audio = True
                                speaking = True
                                set_activity("speaking")
                        if pending and generation == tts_generation and not stop.is_set():
                            if len(pending) % 2:
                                pending.pop()
                            if pending:
                                pcm = bytes(pending)
                                await output.capture_frame(rtc.AudioFrame(pcm, 24000, 1, len(pcm) // 2))
                                if emotion and not emotion_reported:
                                    report("emotion", item_id=item_id, emotion=emotion, transcript=text.strip(), tags=tags[emotion])
                                    emotion_reported = True
                                received_audio = True
                                speaking = True
                                set_activity("speaking")
                        if not received_audio:
                            raise ValueError("Boson returned an empty PCM stream.")
                        if speaking and generation == tts_generation:
                            output.flush()
                except (requests.RequestException, ValueError) as error:
                    report("tts_error", message=f"Tagged speech synthesis failed ({type(error).__name__}).")
                    if generation == tts_generation:
                        if speaking:
                            output.clear_buffer()
                            speaking = False
                        set_activity("listening")

            async def receive():
                nonlocal current_item, speaking, truncate_item, tts_generation
                nonlocal response_transcripts, response_has_fact_log
                ready_announced = False
                async for message in ws:
                    event = json.loads(message)
                    kind = event["type"]
                    if kind != "response.output_audio.delta": report("server_event", event=event)
                    if kind in ("session.created", "session.updated"):
                        if not ready_announced:
                            ready_announced = True
                            report("ready"); set_activity("listening")
                    elif kind == "response.created":
                        tts_generation += 1
                        response_transcripts = []
                        response_has_fact_log = False
                        report("turn_debug", name="ai_response_started", response_id=event.get("response", {}).get("id"))
                    elif kind == "response.output_audio.delta":
                        if AUDIO_RENDERER != "tagged-tts":
                            if event.get("item_id"): current_item = event["item_id"]
                            pcm = base64.b64decode(event["delta"])
                            await output.capture_frame(rtc.AudioFrame(pcm, 24000, 1, len(pcm) // 2))
                            speaking = True; set_activity("speaking")
                    elif kind == "response.function_call_arguments.done":
                        if event.get("name") == "update_understanding":
                            response_has_fact_log = True
                    elif kind == "response.output_audio_transcript.done" and AUDIO_RENDERER == "tagged-tts":
                        item_id = event.get("item_id")
                        if isinstance(item_id, str) and item_id in tagged_items:
                            report("turn_debug", name="duplicate_tagged_audio_suppressed", item_id=item_id)
                            continue
                        if isinstance(item_id, str):
                            current_item = item_id
                            tagged_items.add(item_id)
                        response_transcripts.append((event.get("transcript", ""), item_id, tts_generation))
                    elif kind == "response.done":
                        report("turn_debug", name="ai_response_finished", response_id=event.get("response", {}).get("id"), status=event.get("response", {}).get("status"))
                        if AUDIO_RENDERER == "tagged-tts":
                            response_has_fact_log = response_has_fact_log or response_logs_fact(event)
                            apply_emotion = should_apply_emotion(response_has_fact_log)
                            for transcript, item_id, generation in response_transcripts:
                                task(synthesize_tagged_speech(transcript, item_id, generation, apply_emotion))
                            response_transcripts = []
                        elif speaking:
                            output.flush()
                        elif activity != "listening":
                            set_activity("listening")
                    elif kind == "input_audio_buffer.speech_started":
                        tts_generation += 1
                        report("turn_debug", name="user_speech_detected", item_id=event.get("item_id"), interrupted=speaking)
                        if speaking:
                            truncate_item = current_item; output.clear_buffer(); speaking = False
                            report("turn_debug", name="avatar_playback_interrupted", item_id=current_item)
                        set_activity("listening")
                    elif kind == "input_audio_buffer.speech_stopped":
                        report("turn_debug", name="user_speech_ended", item_id=event.get("item_id"))
                        set_activity("thinking")
                stop.set()

            receiver = task(receive())
            receiver.add_done_callback(lambda _: stop.set())
            if MANAGED: task(commands())
            await stop.wait()
    finally:
        for pending in list(tasks): pending.cancel()
        if tasks: await asyncio.gather(*tasks, return_exceptions=True)
        if session_id:
            try: await asyncio.to_thread(requests.delete, f"{BOSON_BASE_URL}/avatar/sessions/{session_id}", headers=BOSON, timeout=10)
            except requests.RequestException: pass
        await room.disconnect()


if __name__ == "__main__":
    try: asyncio.run(main())
    except KeyboardInterrupt: pass
    except Exception as error:
        # No headers, tokens or full upstream response bodies in logs.
        report("error", message=f"Avatar agent failed ({type(error).__name__}). Check Python dependencies, LiveKit settings, and network access.")
        sys.exit(1)
