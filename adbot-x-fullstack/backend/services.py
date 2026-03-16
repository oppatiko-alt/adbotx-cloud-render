from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import AsyncGenerator, Optional

import httpx

logger = logging.getLogger(__name__)

PERCEPTION_TTL_SECONDS = 8


def _tone_instructions(
    perception: Optional[dict],
    perception_last_seen: Optional[datetime],
) -> str:
    if not perception or not perception_last_seen:
        return ""
    age = (datetime.now(timezone.utc) - perception_last_seen).total_seconds()
    if age > PERCEPTION_TTL_SECONDS:
        return ""

    emotion = perception.get("emotion")
    if not emotion:
        return ""

    tone = ""
    if emotion == "angry":
        tone = "User seems frustrated. Be calm, short, and de-escalate."
    elif emotion == "sad":
        tone = "Use a gentle, supportive, and concise tone."
    elif emotion == "happy":
        tone = "Use a warm, energetic, and concise tone."
    elif emotion == "neutral":
        tone = "Use a clear and concise tone."

    if not tone:
        return ""

    return (
        "Behavior adjustment based on user affect:\n"
        f"- {tone}\n"
        "- Do not mention emotion, age, or gender.\n"
        "- Do not say you inferred anything from camera or perception.\n"
    )


class LLMService:
    def __init__(self, settings) -> None:
        self._api_key = settings.gemini_api_key
        self._model = settings.llm_model
        self._max_tokens = settings.llm_max_tokens
        self._temperature = settings.llm_temperature
        self._system_prompt = settings.system_prompt
        self._memory_window = settings.llm_memory_window

    async def stream_response(
        self,
        user_text: str,
        memory: list[dict],
        perception: Optional[dict] = None,
        perception_last_seen: Optional[datetime] = None,
    ) -> AsyncGenerator[str, None]:
        if not self._api_key:
            yield "Su anda yanit veremiyorum."
            return

        try:
            import google.generativeai as genai

            genai.configure(api_key=self._api_key)

            system_prompt = self._system_prompt
            tone_hint = _tone_instructions(perception, perception_last_seen)
            if tone_hint:
                system_prompt = f"{system_prompt}\n\n{tone_hint}"

            messages = [{"role": "user", "parts": [system_prompt]}]
            for msg in memory[-self._memory_window :]:
                messages.append({"role": msg["role"], "parts": [msg["text"]]})
            messages.append({"role": "user", "parts": [user_text]})

            model = genai.GenerativeModel(self._model)
            response = model.generate_content(
                messages,
                generation_config=genai.types.GenerationConfig(
                    max_output_tokens=self._max_tokens,
                    temperature=self._temperature,
                ),
                stream=True,
            )

            for chunk in response:
                if chunk.text:
                    yield chunk.text
        except Exception as exc:  # pragma: no cover - network/provider errors
            logger.exception("LLM error: %s", exc)
            yield "Su anda yanit veremiyorum."


class TTSService:
    def __init__(self, settings) -> None:
        self._api_key = settings.elevenlabs_api_key
        self._voice_id = settings.elevenlabs_voice_id
        self._model_id = settings.tts_model_id
        self._edge_voice = settings.edge_tts_voice
        self._edge_rate = settings.edge_tts_rate

    async def _synthesize_elevenlabs(self, text: str, voice_id: str) -> bytes:
        if not self._api_key or not voice_id:
            return b""

        url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream"
        headers = {
            "Accept": "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": self._api_key,
        }
        payload = {
            "text": text,
            "model_id": self._model_id,
            "voice_settings": {
                "stability": 0.5,
                "similarity_boost": 0.75,
                "style": 0.0,
                "use_speaker_boost": True,
            },
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                async with client.stream("POST", url, headers=headers, json=payload) as response:
                    if response.status_code != 200:
                        logger.error(
                            "TTS error %s: %s", response.status_code, await response.aread()
                        )
                        return b""
                    chunks = [chunk async for chunk in response.aiter_bytes()]
                    return b"".join(chunks)
        except Exception as exc:  # pragma: no cover - network/provider errors
            logger.exception("ElevenLabs TTS error: %s", exc)
            return b""

    async def _synthesize_edge_tts(self, text: str) -> bytes:
        try:
            import edge_tts
        except Exception as exc:  # pragma: no cover - optional dependency import errors
            logger.exception("Edge TTS import error: %s", exc)
            return b""

        try:
            communicator = edge_tts.Communicate(
                text=text,
                voice=self._edge_voice,
                rate=self._edge_rate,
            )
            audio = bytearray()
            async for chunk in communicator.stream():
                if chunk.get("type") == "audio":
                    audio.extend(chunk.get("data", b""))
            return bytes(audio)
        except Exception as exc:  # pragma: no cover - provider/network errors
            logger.exception("Edge TTS error: %s", exc)
            return b""

    async def synthesize(self, text: str, voice_id: Optional[str] = None) -> bytes:
        normalized_text = (text or "").strip()
        if not normalized_text:
            return b""

        selected_voice = (voice_id or self._voice_id or "").strip()
        elevenlabs_audio = await self._synthesize_elevenlabs(normalized_text, selected_voice)
        if elevenlabs_audio:
            return elevenlabs_audio

        logger.warning("Falling back to Edge TTS voice: %s", self._edge_voice)
        return await self._synthesize_edge_tts(normalized_text)
