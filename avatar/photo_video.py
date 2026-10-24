"""Isolated, documented Boson photo-to-video probe; never creates a live room.

Protocol: https://docs.boson.ai/models/higgs-avatar/input-options
Do not reuse the resulting clip as a live avatar or invent a registration route.
"""
import base64
import hashlib
import json
import re
import time
from pathlib import Path

import requests

BASE = "https://api.boson.ai/v1"
MAX_IMAGE_BYTES = 10 * 1024 * 1024


class ProbeError(RuntimeError):
    pass


def payload_for(image, text, size):
    image = Path(image)
    if not 0 < image.stat().st_size <= MAX_IMAGE_BYTES:
        raise ProbeError("Image must be nonempty and at most 10 MB.")
    data = image.read_bytes()
    if data.startswith(b"\xff\xd8\xff"):
        mime = "image/jpeg"
    elif data.startswith(b"\x89PNG\r\n\x1a\n"):
        mime = "image/png"
    else:
        raise ProbeError("Choose a PNG or JPEG image (checked by file signature).")
    if not text.strip() or len(text) > 5000:
        raise ProbeError("Text must contain 1–5000 characters.")
    if size not in ("640x640", "640x480", "480x640"):
        raise ProbeError("Unsupported video size.")
    return {
        "model": "higgs-avatar",
        "ref_image": "data:" + mime + ";base64," + base64.b64encode(data).decode("ascii"),
        "input_tts": {"model": "higgs-tts-3", "input": text, "voice": "default"},
        "size": size,
    }, hashlib.sha256(data).hexdigest()


def checked(response):
    # Never print response bodies: they could echo a photo or credential.
    if not response.ok:
        raise ProbeError(f"Boson returned HTTP {response.status_code}; response body omitted.")
    return response


def job_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", value):
        raise ProbeError("Invalid video job ID.")
    return value


def run_probe(api_key, image, text, output, size="640x480", resume=None,
              max_wait=300, client=None, report=print):
    """POST once, persist job ID, poll, and download the actual MP4.

    Resume uses GETs only. No POST retry after an ambiguous connection failure.
    requests defaults to zero HTTP retries; callers must preserve that behavior.
    """
    if not api_key:
        raise ProbeError("Set BOSON_API_KEY in the root .env or process environment.")
    if max_wait <= 0:
        raise ProbeError("max-wait must be positive.")
    output = Path(output)
    if output.suffix.lower() != ".mp4" or output.exists():
        raise ProbeError("Choose a new output filename ending in .mp4.")
    metadata_path = output.with_suffix(".json")
    if metadata_path.exists() and not resume:
        raise ProbeError("A job record already exists. Use --resume with its job ID.")
    client = client or requests
    headers = {"Authorization": "Bearer " + api_key}
    output.parent.mkdir(parents=True, exist_ok=True)
    record = {"kind": "generated-video-capability-test", "live_avatar": False}
    if resume:
        identifier = job_id(resume)
        if metadata_path.exists():
            record.update(json.loads(metadata_path.read_text()))
            if record.get("id") != identifier:
                raise ProbeError("Resume ID does not match this output's job record.")
    else:
        if image is None:
            raise ProbeError("Provide --image for a new generation.")
        payload, digest = payload_for(image, text, size)
        record.update(source_name=Path(image).name, source_sha256=digest, text=text, size=size,
                      status="submitting")
        metadata_path.write_text(json.dumps(record, indent=2) + "\n")
        report("Submitting one photo-to-video job (generated clip, not live conversation).")
        try:
            response = checked(client.post(BASE + "/videos", headers=headers, json=payload, timeout=(10, 90)))
        except requests.RequestException as error:
            raise ProbeError("Create request connection failed; acceptance is unknown. No automatic retry. Check Boson job history before resubmitting.") from error
        identifier = job_id(response.json().get("id"))
    record.update(id=identifier, status="submitted")
    metadata_path.write_text(json.dumps(record, indent=2) + "\n")
    report("Video job: " + identifier + " (saved for --resume).")
    deadline = time.monotonic() + max_wait
    previous = None
    while True:
        result = checked(client.get(BASE + "/videos/" + identifier, headers=headers, timeout=(10, 30))).json()
        status = result.get("status")
        if status not in ("queued", "in_progress", "completed", "failed"):
            raise ProbeError("Unrecognized job status; saved ID can be resumed.")
        record.update(status=status, progress=result.get("progress"))
        metadata_path.write_text(json.dumps(record, indent=2) + "\n")
        progress = (status, result.get("progress"))
        if progress != previous:
            report(f"Status: {status}; progress: {result.get('progress', 'unknown')}")
            previous = progress
        if status == "failed":
            raise ProbeError("Boson marked the job failed. Inspect its job details in Boson; no new job was submitted.")
        if status == "completed":
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProbeError("Polling deadline reached. Resume the saved ID; do not submit another job.")
        time.sleep(min(3, remaining))
    partial = output.with_suffix(".mp4.part")
    with checked(client.get(BASE + "/videos/" + identifier + "/content", headers=headers,
                            stream=True, timeout=(10, 90))) as response:
        with partial.open("wb") as target:
            for chunk in response.iter_content(chunk_size=65536):
                if chunk:
                    target.write(chunk)
    with partial.open("rb") as source:
        header = source.read(12)
    if len(header) < 12 or header[4:8] != b"ftyp":
        raise ProbeError("Downloaded content is not an MP4; partial file retained for inspection.")
    partial.replace(output)
    record.update(output=str(output), bytes=output.stat().st_size)
    metadata_path.write_text(json.dumps(record, indent=2) + "\n")
    report("Downloaded generated video: " + str(output))
    return record
