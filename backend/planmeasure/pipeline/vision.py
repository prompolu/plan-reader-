"""Vision model providers.

The vision model is used for *ambiguous* cases only (low-confidence page
classification, two dimensions that fit an opening almost equally well). It
never supplies numbers: for associations it may only pick one of the candidate
dimension ids that were read from the drawing, or answer "none".
"""

from __future__ import annotations

import base64
import io
import json
import logging
from typing import Any

from PIL import Image, ImageDraw

from .types import PAGE_TYPES

log = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You assist a measurement-extraction tool for architectural drawings. "
    "You look at drawing images and answer strictly in the requested JSON format. "
    "Only report what is visible in the image. If you cannot tell, say so with low confidence "
    "or choose 'none' - never guess or assume standard sizes."
)

CLASSIFY_SCHEMA = {
    "type": "object",
    "properties": {
        "page_type": {"type": "string", "enum": PAGE_TYPES},
        "confidence": {"type": "number"},
        "rationale": {"type": "string"},
    },
    "required": ["page_type", "confidence", "rationale"],
    "additionalProperties": False,
}


def _adjudicate_schema(labels: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "choice": {"type": "string", "enum": labels + ["none"]},
            "confidence": {"type": "number"},
            "rationale": {"type": "string"},
        },
        "required": ["choice", "confidence", "rationale"],
        "additionalProperties": False,
    }


class NullVisionProvider:
    name = "none"
    model = None

    def available(self) -> bool:
        return False

    def classify_page(self, image_png: bytes, text_excerpt: str) -> dict[str, Any] | None:
        return None

    def adjudicate_association(self, image_png: bytes, question: dict[str, Any]) -> dict[str, Any] | None:
        return None


def annotate_candidates(image_png: bytes, question: dict[str, Any]) -> tuple[bytes, dict[str, str]]:
    """Draw the opening (red) and lettered candidate boxes (blue) onto the crop."""
    img = Image.open(io.BytesIO(image_png)).convert("RGB")
    draw = ImageDraw.Draw(img)
    ox, oy = question["crop_origin"]["x"], question["crop_origin"]["y"]
    k = float(question.get("px_per_unit", 1.0))

    def tr(b):
        return [(b["x"] - ox) * k, (b["y"] - oy) * k, (b["x"] + b["width"] - ox) * k, (b["y"] + b["height"] - oy) * k]

    draw.rectangle(tr(question["opening"]["bbox"]), outline=(220, 30, 30), width=3)
    labels: dict[str, str] = {}
    for i, c in enumerate(question["candidates"]):
        lab = chr(ord("A") + i)
        labels[lab] = c["id"]
        r = tr(c["bbox"])
        draw.rectangle(r, outline=(30, 90, 220), width=2)
        draw.text((r[0], max(r[1] - 12, 0)), lab, fill=(30, 90, 220))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), labels


class AnthropicVisionProvider:
    """Claude via the official Anthropic SDK (structured JSON output)."""

    name = "anthropic"

    def __init__(self, api_key: str | None, model: str = "claude-opus-5-5", effort: str = "medium", timeout: float = 90.0):
        import anthropic

        self._anthropic = anthropic
        self.model = model
        self.effort = effort
        self.client = anthropic.Anthropic(api_key=api_key, timeout=timeout, max_retries=2) if api_key else anthropic.Anthropic(timeout=timeout, max_retries=2)

    def available(self) -> bool:
        return True

    def _ask(self, image_png: bytes, prompt: str, schema: dict[str, Any]) -> dict[str, Any] | None:
        a = self._anthropic
        data = base64.standard_b64encode(image_png).decode("ascii")
        try:
            resp = self.client.beta.messages.create(
                model=self.model,
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": schema}},
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}},
                            {"type": "text", "text": prompt},
                        ],
                    }
                ],
            )
        except a.RateLimitError as exc:
            log.warning("vision rate limited: %s", exc)
            return None
        except a.APIStatusError as exc:
            log.warning("vision API error %s: %s", exc.status_code, exc)
            return None
        except a.APIConnectionError as exc:
            log.warning("vision connection error: %s", exc)
            return None
        if resp.stop_reason == "refusal":
            return None
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), None)
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return None

    def classify_page(self, image_png: bytes, text_excerpt: str) -> dict[str, Any] | None:
        prompt = (
            "Classify this architectural drawing sheet. Page types: "
            + ", ".join(PAGE_TYPES)
            + ". Text found on the sheet (may be partial):\n"
            + text_excerpt[:3000]
        )
        return self._ask(image_png, prompt, CLASSIFY_SCHEMA)

    def adjudicate_association(self, image_png: bytes, question: dict[str, Any]) -> dict[str, Any] | None:
        img, labels = annotate_candidates(image_png, question)
        role = question["role"]
        prompt = (
            f"The red box is an opening ({question['opening'].get('kind')}, tag {question['opening'].get('tag') or 'none'}) "
            f"on a {question['view_type'].replace('_', ' ')}. The blue lettered boxes are dimension texts read from the drawing: "
            + "; ".join(f"{lab} = \"{next(c['text'] for c in question['candidates'] if c['id'] == cid)}\"" for lab, cid in labels.items())
            + f". Which lettered dimension measures the {role} of the red opening, judging by the dimension line, its "
            "terminators and extension lines? Answer 'none' if none of them clearly does."
        )
        ans = self._ask(img, prompt, _adjudicate_schema(list(labels)))
        if not ans:
            return None
        choice = ans.get("choice")
        ans["choice"] = labels.get(choice, "none") if choice != "none" else "none"
        return ans


class FakeVisionProvider:
    """Deterministic provider for tests."""

    name = "fake"
    model = "fake-vision"

    def __init__(self, page_type: str | None = None, choice_index: int | None = 0):
        self.page_type = page_type
        self.choice_index = choice_index
        self.calls: list[tuple[str, dict]] = []

    def available(self) -> bool:
        return True

    def classify_page(self, image_png: bytes, text_excerpt: str) -> dict[str, Any] | None:
        self.calls.append(("classify", {}))
        if not self.page_type:
            return None
        return {"page_type": self.page_type, "confidence": 0.9, "rationale": "fake"}

    def adjudicate_association(self, image_png: bytes, question: dict[str, Any]) -> dict[str, Any] | None:
        self.calls.append(("adjudicate", question))
        if self.choice_index is None:
            return {"choice": "none", "confidence": 0.9, "rationale": "fake"}
        return {"choice": question["candidates"][self.choice_index]["id"], "confidence": 0.9, "rationale": "fake"}


def get_vision_provider(provider: str, api_key: str | None, model: str, effort: str = "medium"):
    if provider == "anthropic":
        try:
            return AnthropicVisionProvider(api_key, model=model, effort=effort)
        except Exception as exc:  # SDK missing or misconfigured
            log.warning("vision provider unavailable: %s", exc)
    return NullVisionProvider()
