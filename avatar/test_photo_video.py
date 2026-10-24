"""Protocol tests use mocked HTTP; they do not spend Boson credit."""
import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import requests

from photo_video import BASE, ProbeError, payload_for, run_probe


def response(body=None, content=None, status=200):
    result = MagicMock()
    result.ok = status < 400
    result.status_code = status
    result.json.return_value = body
    result.iter_content.return_value = [content] if content else []
    result.__enter__.return_value = result
    return result


class PhotoVideoTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.image = self.root / "alex?.jpg"
        self.image.write_bytes(b"\xff\xd8\xff" + b"test-photo")
        self.output = self.root / "clip.mp4"
        self.client = MagicMock()
        self.client.post.return_value = response({"id": "video_test"})
        self.messages = []

    def run_probe(self, **kwargs):
        return run_probe("private-test-key", self.image, "Hi, I'm Alex.", self.output,
                         client=self.client, report=self.messages.append, **kwargs)

    def test_documented_payload_has_only_one_driving_input(self):
        payload, digest = payload_for(self.image, "Hi!", "640x480")
        self.assertEqual(set(payload), {"model", "ref_image", "input_tts", "size"})
        self.assertEqual(payload["input_tts"], {"model": "higgs-tts-3", "input": "Hi!", "voice": "default"})
        self.assertEqual(base64.b64decode(payload["ref_image"].split(",")[1]), self.image.read_bytes())
        self.assertEqual(len(digest), 64)

    def test_rejects_invalid_and_oversize_images_before_network(self):
        self.image.write_text("not a JPEG")
        with self.assertRaises(ProbeError): self.run_probe()
        self.client.post.assert_not_called()
        with self.image.open("wb") as file: file.truncate(10 * 1024 * 1024 + 1)
        with self.assertRaises(ProbeError): self.run_probe()
        self.client.post.assert_not_called()

    def test_polls_then_downloads_only_after_completed(self):
        content = b"\x00\x00\x00\x18ftypmp42" + b"test-data"
        self.client.get.side_effect = [response({"status": "queued"}),
                                       response({"status": "completed", "progress": 100}),
                                       response(content=content)]
        with patch("photo_video.time.sleep"):
            record = self.run_probe()
        self.client.post.assert_called_once()
        self.assertEqual(self.output.read_bytes(), content)
        self.assertEqual(self.client.get.call_args.args[0], BASE + "/videos/video_test/content")
        self.assertFalse(record["live_avatar"])
        saved = self.output.with_suffix(".json").read_text()
        self.assertNotIn("private-test-key", saved)
        self.assertNotIn("base64", saved)

    def test_failed_job_persists_id_without_downloading_or_retrying(self):
        self.client.get.return_value = response({"status": "failed", "error": "private response"})
        with self.assertRaisesRegex(ProbeError, "marked the job failed"): self.run_probe()
        self.client.post.assert_called_once()
        self.client.get.assert_called_once()
        self.assertEqual(json.loads(self.output.with_suffix(".json").read_text())["id"], "video_test")

    def test_resume_never_posts(self):
        self.client.get.side_effect = [response({"status": "completed"}), response(content=b"\0\0\0\x18ftypmp42")]
        self.run_probe(resume="video_existing")
        self.client.post.assert_not_called()
        self.assertEqual(self.client.get.call_args_list[0].args[0], BASE + "/videos/video_existing")

    def test_ambiguous_create_failure_is_never_retried(self):
        self.client.post.side_effect = requests.Timeout("secret text must not be logged")
        with self.assertRaisesRegex(ProbeError, "acceptance is unknown") as caught:
            self.run_probe()
        self.assertNotIn("secret text", str(caught.exception))
        self.client.post.assert_called_once()
        self.client.get.assert_not_called()

    def test_http_errors_do_not_expose_response_bodies(self):
        self.client.post.return_value = response({"error": "private-test-key"}, status=401)
        with self.assertRaisesRegex(ProbeError, "HTTP 401") as caught: self.run_probe()
        self.assertNotIn("private-test-key", str(caught.exception))
        self.client.post.assert_called_once()

    def test_timeout_preserves_job_for_resume(self):
        self.client.get.return_value = response({"status": "in_progress"})
        with patch("photo_video.time.monotonic", side_effect=[0, 2]):
            with self.assertRaisesRegex(ProbeError, "Resume the saved ID"): self.run_probe(max_wait=1)
        self.assertEqual(json.loads(self.output.with_suffix(".json").read_text())["id"], "video_test")
        self.client.post.assert_called_once()

    def test_rejects_non_mp4_download(self):
        self.client.get.side_effect = [response({"status": "completed"}), response(content=b"this is not a video")]
        with self.assertRaisesRegex(ProbeError, "not an MP4"): self.run_probe()
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
