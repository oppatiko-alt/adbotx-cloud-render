from __future__ import annotations

import asyncio
import re
import time
from typing import Iterable


def estimate_duration_ms(text: str, wpm: int) -> int:
    if not text.strip():
        return 0
    words = len(re.findall(r"[0-9A-Za-z]+", text))
    if words == 0:
        return 0
    words_per_minute = max(wpm, 60)
    minutes = words / words_per_minute
    return int(minutes * 60 * 1000)


def _emphasis_offsets(text: str, duration_ms: int) -> list[int]:
    indices = [idx for idx, ch in enumerate(text) if ch in "!?"]
    if not indices or duration_ms <= 0:
        return []
    total = max(len(text) - 1, 1)
    return [int((idx / total) * duration_ms) for idx in indices]


def build_avatar_schedule(
    text: str, duration_ms: int, mouth_cycle_ms: int = 120
) -> list[tuple[int, dict]]:
    schedule: list[tuple[int, dict]] = []
    schedule.append((0, {"type": "avatar", "event": "speaking", "value": True}))

    t = 0
    while t < duration_ms:
        schedule.append((t, {"type": "avatar", "event": "mouth", "value": "open"}))
        close_time = min(t + mouth_cycle_ms // 2, duration_ms)
        schedule.append((close_time, {"type": "avatar", "event": "mouth", "value": "close"}))
        t += mouth_cycle_ms

    for offset in _emphasis_offsets(text, duration_ms):
        schedule.append((offset, {"type": "avatar", "event": "emphasis", "value": 0.8}))

    schedule.append((duration_ms, {"type": "avatar", "event": "speaking", "value": False}))
    schedule.append((duration_ms, {"type": "avatar", "event": "idle", "value": True}))
    schedule.sort(key=lambda item: item[0])
    return schedule


async def play_avatar_timeline(
    websocket, text: str, duration_ms: int, cancel_event: asyncio.Event
) -> None:
    schedule = build_avatar_schedule(text, duration_ms)
    start = time.monotonic()

    for offset_ms, payload in schedule:
        if cancel_event.is_set():
            break
        delay = (offset_ms / 1000) - (time.monotonic() - start)
        if delay > 0:
            await asyncio.sleep(delay)
        if cancel_event.is_set():
            break
        await websocket.send_json(payload)
