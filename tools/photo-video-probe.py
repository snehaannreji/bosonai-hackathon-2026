"""Run from the repo root; uses only the server-side key and documented APIs."""
import argparse
import os
from pathlib import Path
import sys

from dotenv import load_dotenv
import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "avatar"))
from photo_video import ProbeError, run_probe


if __name__ == "__main__":
    load_dotenv(ROOT / ".env")
    parser = argparse.ArgumentParser(description="Generate a standalone talking-photo clip; not a live avatar.")
    parser.add_argument("--image", type=Path, help="Local PNG/JPEG; quote filenames containing ? or spaces.")
    parser.add_argument("--text", default="Hi, I'm Alex. What would you like to teach me today?")
    parser.add_argument("--out", type=Path, default=Path("captures/photo-video.mp4"))
    parser.add_argument("--size", choices=["640x640", "640x480", "480x640"], default="640x480")
    parser.add_argument("--resume", help="Existing video ID; polls and downloads without a new POST.")
    parser.add_argument("--max-wait", type=float, default=300)
    args = parser.parse_args()
    try:
        run_probe(os.environ.get("BOSON_API_KEY"), args.image, args.text, args.out,
                  args.size, args.resume, args.max_wait, report=lambda line: print(line, flush=True))
    except (ProbeError, OSError) as error:
        print("FAIL:", str(error), file=sys.stderr)
        sys.exit(1)
    except requests.RequestException:
        print("FAIL: Network request failed. Check the saved job record and resume its ID; no automatic resubmission.", file=sys.stderr)
        sys.exit(1)
