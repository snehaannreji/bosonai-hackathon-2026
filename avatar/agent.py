"""Boson's official realtime/LiveKit avatar bridge, with a local Node IPC adapter.
The classroom starts --managed; direct CLI use remains available for diagnostics.
Microphone transport and synchronized avatar playout use LiveKit's SDKs.
"""
import asyncio
import base64
import json
import os
import re
import signal
import sys
from threading import Event as ThreadEvent, Thread
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
MAX_DURATION_SECONDS = 600
BOSON = {"Authorization": f"Bearer {os.environ['BOSON_API_KEY']}"}
BOSON_BASE_URL = os.environ.get("BOSON_BASE_URL", "https://api.boson.ai").rstrip("/").removesuffix("/v1") + "/v1"
BOSON_REALTIME_URL = os.environ.get("BOSON_REALTIME_URL", "wss://api.boson.ai/v1/realtime")


def report(kind, **values):
    print(json.dumps({"kind": kind, **values}), flush=True)


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
    if os.name == "nt":
        # ProactorEventLoop on Windows does not implement add_signal_handler.
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))
    else:
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
    room = rtc.Room()
    session_id = None
    tasks = set()
    output = None
    use_tts = "text" in config["session"].get("output_modalities", [])
    feedback_directness = max(0, min(100, int(os.environ.get("TEACHBACK_FEEDBACK_DIRECTNESS", "35"))))
    character_id = os.environ.get("TEACHBACK_CHARACTER_ID", "alex")
    kevin_learning_started = False
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
            assistant_text = ""
            synthesis_task = None
            synthesis_cancel = None

            async def synthesize_reply(text):
                nonlocal speaking, synthesis_cancel
                cancel = ThreadEvent()
                synthesis_cancel = cancel
                chunks = asyncio.Queue()
                level = feedback_directness
                if character_id == "baby-yoda":
                    delivery = "<|emotion:affection|><|prosody:pitch_high|>"
                elif character_id == "kevin":
                    delivery = "<|emotion:amusement|><|prosody:expressive_high|>"
                elif character_id == "alex" and level >= 70:
                    delivery = "<|emotion:anger|><|prosody:expressive_high|><|prosody:pitch_low|><|prosody:speed_fast|><|sfx:sigh|>Ah "
                elif character_id == "alex" and level >= 35:
                    delivery = "<|emotion:determination|><|prosody:expressive_high|>"
                else:
                    delivery = "<|emotion:affection|><|prosody:pitch_high|>"
                # Give the TTS model explicit vocal controls; Realtime itself
                # only accepts a voice and natural-language delivery guidance.
                if character_id == "kevin":
                    text = re.sub(r"\bbananas?\b", "Banana!", text, flags=re.IGNORECASE)
                    text = re.sub(r"\bBanana!", "<|emotion:amusement|><|prosody:expressive_high|>Banana!", text, count=1)
                first, separator, rest = text.partition(". ")
                spoken = delivery + first + ("<|prosody:pause|> " + rest if separator else "")
                payload = {"model": "higgs-tts-3", "input": spoken,
                           "response_format": "pcm", "stream": True}
                if character_id in ("baby-yoda", "kevin"):
                    try:
                        reference_name = "kevin-reference.mp3" if character_id == "kevin" else "baby-yoda-reference-short.mp3"
                        reference = Path(__file__).resolve().parent.parent / "assets/characters" / reference_name
                        payload["ref_audio"] = base64.b64encode(reference.read_bytes()).decode("ascii")
                    except OSError:
                        pass

                def produce_pcm():
                    try:
                        with requests.post(f"{BOSON_BASE_URL}/audio/speech", headers=BOSON,
                                           json=payload, stream=True, timeout=(10, 90)) as response:
                            response.raise_for_status()
                            for chunk in response.iter_content(chunk_size=4096):
                                if cancel.is_set(): break
                                if chunk: loop.call_soon_threadsafe(chunks.put_nowait, chunk)
                    except Exception as error:
                        loop.call_soon_threadsafe(chunks.put_nowait, error)
                    finally:
                        loop.call_soon_threadsafe(chunks.put_nowait, None)

                producer = asyncio.create_task(asyncio.to_thread(produce_pcm))
                pcm = bytearray()
                frame_bytes = 960 * 2  # 20 ms of mono PCM16 at 24 kHz.
                try:
                    while True:
                        chunk = await chunks.get()
                        if chunk is None: break
                        if isinstance(chunk, Exception): raise chunk
                        pcm.extend(chunk)
                        while len(pcm) >= frame_bytes and not cancel.is_set():
                            frame = bytes(pcm[:frame_bytes]); del pcm[:frame_bytes]
                            await output.capture_frame(rtc.AudioFrame(frame, 24000, 1, 960))
                            speaking = True; set_activity("speaking")
                    if pcm and not cancel.is_set():
                        samples = (len(pcm) + 1) // 2
                        padded = bytes(pcm) + (b"\0" if len(pcm) % 2 else b"")
                        await output.capture_frame(rtc.AudioFrame(padded, 24000, 1, samples))
                        speaking = True; set_activity("speaking")
                    await producer
                    if not cancel.is_set(): output.flush()
                except asyncio.CancelledError:
                    cancel.set()
                    producer.cancel()
                    raise
                except Exception:
                    cancel.set()
                    report("error", message="Higgs TTS could not synthesize the avatar reply. Check BOSON_API_KEY, credit, and network access.")
                finally:
                    if synthesis_cancel is cancel: synthesis_cancel = None

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
                        await ws.send(json.dumps({"type": "input_audio_buffer.append", "audio": base64.b64encode(bytes(event.frame.data)).decode()}))
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
                # Windows' Proactor event loop does not implement
                # connect_read_pipe. Read the parent process' stdin on a
                # daemon thread and hand lines back to the asyncio loop.
                inbox = asyncio.Queue()

                def read_stdin():
                    try:
                        for line in sys.stdin:
                            loop.call_soon_threadsafe(inbox.put_nowait, line)
                    except (OSError, RuntimeError):
                        return
                    try:
                        loop.call_soon_threadsafe(inbox.put_nowait, None)
                    except RuntimeError:
                        pass

                Thread(target=read_stdin, name="avatar-stdin", daemon=True).start()
                while (line := await inbox.get()) is not None:
                    try:
                        command = json.loads(line)
                        if command.get("kind") == "send": await ws.send(json.dumps(command["event"]))
                        elif command.get("kind") == "settings":
                            nonlocal feedback_directness, kevin_learning_started
                            feedback_directness = max(0, min(100, int(command.get("feedbackDirectness", feedback_directness))))
                            if command.get("kevinLearningStarted") is True:
                                kevin_learning_started = True
                    except (ValueError, KeyError): pass
                stop.set()

            async def receive():
                nonlocal current_item, speaking, truncate_item, assistant_text, synthesis_task, feedback_directness, kevin_learning_started
                async for message in ws:
                    event = json.loads(message)
                    kind = event["type"]
                    if not (use_tts and kind in ("response.output_text.delta", "response.output_text.done")) and kind != "response.output_audio.delta": report("server_event", event=event)
                    if kind in ("session.created", "session.updated"):
                        report("ready"); set_activity("listening")
                    elif kind == "response.created":
                        assistant_text = ""
                        set_activity("thinking")
                    elif kind == "response.output_text.delta" and isinstance(event.get("delta"), str):
                        assistant_text += event["delta"]
                        report("server_event", event=event)
                    elif kind == "conversation.item.input_audio_transcription.completed":
                        transcript = str(event.get("transcript", ""))
                        if character_id == "kevin" and re.search(r"\bkevin\b[\s,.:;!?-]*(?:you|u)\s+need\s+to\s+concentrate\b", transcript, flags=re.IGNORECASE):
                            kevin_learning_started = True
                        report("server_event", event=event)
                    elif kind == "response.output_text.done" and isinstance(event.get("text"), str):
                        assistant_text = event["text"]
                        if use_tts and character_id == "kevin":
                            assistant_text = re.sub(r"\bbananas?\b", "Banana!", assistant_text, flags=re.IGNORECASE)
                            event["text"] = assistant_text
                        report("server_event", event=event)
                    elif kind == "response.output_audio.delta":
                        if event.get("item_id"): current_item = event["item_id"]
                        pcm = base64.b64decode(event["delta"])
                        await output.capture_frame(rtc.AudioFrame(pcm, 24000, 1, len(pcm) // 2))
                        speaking = True; set_activity("speaking")
                    elif kind == "response.done":
                        if use_tts and assistant_text.strip():
                            if synthesis_task and not synthesis_task.done():
                                if synthesis_cancel: synthesis_cancel.set()
                                synthesis_task.cancel()
                            synthesis_task = task(synthesize_reply(assistant_text.strip()))
                            assistant_text = ""
                        elif speaking: output.flush()
                        elif activity != "listening": set_activity("listening")
                    elif kind == "input_audio_buffer.speech_started":
                        if use_tts and synthesis_task and not synthesis_task.done():
                            if synthesis_cancel: synthesis_cancel.set()
                            synthesis_task.cancel()
                            output.clear_buffer(); speaking = False
                        if speaking:
                            if not use_tts: truncate_item = current_item
                            output.clear_buffer(); speaking = False
                        set_activity("listening")
                    elif kind == "input_audio_buffer.speech_stopped": set_activity("thinking")
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
