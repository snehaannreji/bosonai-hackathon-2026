"""Headless end-to-end avatar smoke test using LiveKit's official room client.
No hardware or credentials are printed. It joins the same server endpoints as
React, checks real audio/video frames and learning events, and releases its room.
"""
import asyncio
import argparse
import hashlib
import json
from pathlib import Path
import struct
import threading
import time
import zlib

import requests
from livekit import rtc

BASE = "http://localhost:5173/api/avatar"


def post(path, body=None):
    response = requests.post(BASE + path, json=body or {}, timeout=35)
    if not response.ok:
        raise RuntimeError(response.json().get("error", f"Local server returned {response.status_code}"))
    return response.json()


def png(frame, path):
    rgb = frame.convert(rtc.VideoBufferType.RGB24)
    width, height = rgb.width, rgb.height
    data = bytes(rgb.data)
    stride = width * 3
    def chunk(kind, value):
        return struct.pack("!I", len(value)) + kind + value + struct.pack("!I", zlib.crc32(kind + value) & 0xffffffff)
    rows = b"".join(b"\0" + data[y * stride:(y + 1) * stride] for y in range(height))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!2I5B", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


async def main(topic, explanation, avatar_id=None):
    def prepare():
        response = requests.post("http://localhost:5173/api/lessons", json={"topic": topic}, timeout=45)
        response.raise_for_status()
        return response.json()["lesson"]
    definition = await asyncio.to_thread(prepare)
    print("Topic:", definition["topic"], "| Concepts:", [c["label"] for c in definition["concepts"]], flush=True)
    selection = {"lessonId": definition["id"]}
    if avatar_id: selection["avatarId"] = avatar_id
    lesson = await asyncio.to_thread(post, "/lessons", selection)
    print("Local avatar lesson reserved; avatar:", lesson.get("avatarId", "server default"), flush=True)
    room = rtc.Room()
    loop = asyncio.get_running_loop()
    ready = asyncio.Event()
    attached = asyncio.Event()
    transcript_done = asyncio.Event()
    messages = []
    errors = []
    counter = {"video_frames": 0, "audio_frames": 0, "audio_samples": 0, "unique_video_frames": 0}
    checksums = set()
    tasks = set()
    streams = []
    response_holder = []
    capture_dir = Path("captures"); capture_dir.mkdir(exist_ok=True)

    def handle(message):
        messages.append(message)
        if message.get("kind") == "ready": ready.set()
        if message.get("kind") == "error": errors.append(message.get("message", "Avatar failed")); ready.set(); transcript_done.set()
        if message.get("kind") == "knowledge":
            state = message["state"]
            print("Learning state:", {key: value["status"] for key, value in state.items()}, flush=True)
        event = message.get("event", {})
        if event.get("type") == "session.created": print("Reported model:", event.get("session", {}).get("model"), flush=True)
        if event.get("type") == "response.output_audio_transcript.done":
            print("Alex:", event.get("transcript"), flush=True); transcript_done.set()

    def events():
        try:
            response = requests.get(BASE + f"/lessons/{lesson['id']}/events", stream=True, timeout=(5, 120))
            response_holder.append(response)
            response.raise_for_status(); loop.call_soon_threadsafe(attached.set)
            for line in response.iter_lines(chunk_size=1):
                if line.startswith(b"data: "):
                    loop.call_soon_threadsafe(handle, json.loads(line[6:]))
        except Exception as error:
            loop.call_soon_threadsafe(handle, {"kind": "error", "message": "Avatar event stream ended: " + type(error).__name__})

    async def video(track):
        stream = rtc.VideoStream(track); streams.append(stream)
        async for event in stream:
            counter["video_frames"] += 1
            checksums.add(hashlib.sha256(bytes(event.frame.data)).digest())
            counter["unique_video_frames"] = len(checksums)
            if counter["video_frames"] in (1, 75):
                png(event.frame, capture_dir / f"avatar-live-frame-{counter['video_frames']}.png")

    async def audio(track):
        stream = rtc.AudioStream(track, sample_rate=24000, num_channels=1); streams.append(stream)
        async for event in stream:
            counter["audio_frames"] += 1
            counter["audio_samples"] += event.frame.samples_per_channel

    @room.on("track_subscribed")
    def on_track(track, _publication, participant):
        if participant.identity != "boson-avatar": return
        print("Subscribed to avatar", "video" if track.kind == rtc.TrackKind.KIND_VIDEO else "audio", flush=True)
        pending = asyncio.create_task(video(track) if track.kind == rtc.TrackKind.KIND_VIDEO else audio(track))
        tasks.add(pending); pending.add_done_callback(tasks.discard)

    try:
        threading.Thread(target=events, daemon=True).start()
        await asyncio.wait_for(attached.wait(), 20)
        print("Server event stream attached; connecting LiveKit user.", flush=True)
        await room.connect(lesson["url"], lesson["token"])
        print("LiveKit user connected; starting Boson avatar.", flush=True)
        await asyncio.to_thread(post, f"/lessons/{lesson['id']}/start")
        await asyncio.wait_for(ready.wait(), 100)
        if errors: raise RuntimeError(errors[0])
        await asyncio.to_thread(post, f"/lessons/{lesson['id']}/text", {"text": f"Hi Alex. We are learning {topic}. What do you think the main idea is?"})
        await asyncio.wait_for(transcript_done.wait(), 35)
        if errors: raise RuntimeError(errors[0])
        await asyncio.sleep(8)  # allow real-time playout of the short spoken reply
        transcript_done.clear()
        await asyncio.to_thread(post, f"/lessons/{lesson['id']}/text", {"text": explanation})
        await asyncio.wait_for(transcript_done.wait(), 35)
        if errors: raise RuntimeError(errors[0])
        await asyncio.sleep(8)
        print("Live media:", json.dumps(counter), flush=True)
        if counter["video_frames"] < 10 or counter["unique_video_frames"] < 2 or counter["audio_samples"] < 2400:
            raise RuntimeError("Expected moving video and actual audio frames were not received.")
        print("PASS: real avatar video and speech reached the LiveKit user.", flush=True)
        (capture_dir / "avatar-live-probe-summary.json").write_text(json.dumps({"topic": topic, "concepts": definition["concepts"], "media": counter, "learning_updates": [m["state"] for m in messages if m.get("kind") == "knowledge"]}, indent=2))
    finally:
        try: await asyncio.to_thread(post, f"/lessons/{lesson['id']}/end")
        finally:
            await room.disconnect()
            for stream in streams: await stream.aclose()
            for pending in tasks: pending.cancel()
            if tasks: await asyncio.gather(*tasks, return_exceptions=True)
            for response in response_holder: response.close()
        print("Test room disconnected and avatar release requested.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--topic", default="Photosynthesis")
    parser.add_argument("--avatar-id", help="Optional catalog ID; otherwise uses the server's BOSON_AVATAR_ID/default.")
    parser.add_argument("--explanation", default="Plants need sunlight, water and carbon dioxide for photosynthesis. Chlorophyll in chloroplasts absorbs light, and plants use that energy to make glucose, storing chemical energy and releasing oxygen as a byproduct.")
    args = parser.parse_args()
    try: asyncio.run(main(args.topic, args.explanation, args.avatar_id))
    except Exception as error:
        print("FAIL:", type(error).__name__, str(error), flush=True)
        raise SystemExit(1)
