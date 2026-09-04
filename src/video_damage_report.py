#!/usr/bin/env python3
"""Generate a regional damage-assessment summary from sampled drone-video frames.

This is an experimental Avaris prototype component. It samples a video at a
fixed interval, requests a building-damage assessment for each frame, then
combines those frame-level assessments into one regional summary.
"""

import argparse
import base64
import os
from pathlib import Path
from typing import Any

import cv2

DEFAULT_MODEL = os.getenv("AVARIS_OPENAI_MODEL", "gpt-5.6-terra")


def encode_image(image_path: Path) -> str:
    with image_path.open("rb") as image_file:
        return base64.b64encode(image_file.read()).decode("utf-8")


def get_individual_damage_report(client: Any, image_path: Path, model: str) -> str:
    base64_image = encode_image(image_path)
    prompt_text = (
        "This image was captured by a drone for post-catastrophe damage assessment. "
        "Return JSON with two fields: 'damage_level' (none, mild, moderate, or severe) "
        "and 'notes' (a concise briefing for adjusters or claim handlers). Base the "
        "damage level on buildings and structures rather than environmental debris. "
        "The notes may mention road obstructions, debris, or other visible field risks."
    )
    response = client.responses.create(
        model=model,
        input=[
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt_text},
                    {
                        "type": "input_image",
                        "image_url": f"data:image/jpeg;base64,{base64_image}",
                        "detail": "auto",
                    },
                ],
            }
        ],
    )
    return response.output_text.strip()


def sample_frames_from_video(
    video_path: Path, sample_interval_seconds: float = 10, output_folder: Path = Path("samples")
) -> list[Path]:
    output_folder.mkdir(parents=True, exist_ok=True)
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise ValueError(f"Could not open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if fps <= 0:
        cap.release()
        raise ValueError("Video reports an invalid frame rate.")

    duration_seconds = total_frames / fps
    sample_images: list[Path] = []
    current_time = 0.0

    while current_time < duration_seconds:
        cap.set(cv2.CAP_PROP_POS_MSEC, current_time * 1000)
        ret, frame = cap.read()
        if not ret:
            break

        sample_image_path = output_folder / f"sample_{int(current_time)}.jpg"
        if cv2.imwrite(str(sample_image_path), frame):
            sample_images.append(sample_image_path)
        current_time += sample_interval_seconds

    cap.release()
    return sample_images


def combine_reports(client: Any, individual_reports: list[str], model: str) -> str:
    combined_prompt = (
        "Combine the following frame-level post-disaster building-damage reports into "
        "one regional JSON assessment. Return 'overall_damage_level' (none, mild, "
        "moderate, or severe) and 'combined_notes' (a concise summary).\n\n"
        + "\n".join(individual_reports)
    )
    response = client.responses.create(
        model=model,
        input=[{"role": "user", "content": [{"type": "input_text", "text": combined_prompt}]}],
    )
    return response.output_text.strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path, help="Path to an input video")
    parser.add_argument("--interval", type=float, default=10.0, help="Seconds between sampled frames")
    parser.add_argument("--samples-dir", type=Path, default=Path("samples"), help="Directory for sampled frames")
    parser.add_argument("--output", type=Path, default=Path("overall_damage_report.json"), help="Output report path")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="OpenAI model ID (or set AVARIS_OPENAI_MODEL)")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.interval <= 0:
        raise SystemExit("--interval must be greater than zero")
    if not args.video.is_file():
        raise SystemExit(f"Video not found: {args.video}")

    try:
        from openai import OpenAI
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: install the project requirements with "
            "`pip install -r requirements.txt`."
        ) from exc

    client = OpenAI()
    print(f"Sampling frames every {args.interval:g} seconds...")
    sample_images = sample_frames_from_video(args.video, args.interval, args.samples_dir)
    if not sample_images:
        raise SystemExit("No frames could be sampled from the input video.")

    reports = []
    for image_path in sample_images:
        print(f"Assessing {image_path}...")
        reports.append(get_individual_damage_report(client, image_path, args.model))

    overall_report = combine_reports(client, reports, args.model)
    args.output.write_text(overall_report + "\n", encoding="utf-8")
    print(f"Saved regional report to {args.output}")


if __name__ == "__main__":
    main()
