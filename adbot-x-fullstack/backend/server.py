import asyncio
import base64
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware

from avatar import estimate_duration_ms, play_avatar_timeline
from config import settings
from services import LLMService, TTSService
from session import ConversationState, SessionStore, STTState


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


app = FastAPI(title=settings.app_title)
api_router = APIRouter(prefix="/api")

store = SessionStore(memory_window=settings.llm_memory_window)
llm_service = LLMService(settings)
tts_service = TTSService(settings)

SECURITY_BLACKLIST = {
    "hack",
    "bomb",
    "terror",
    "silah",
    "patlat",
    "uyusturucu",
    "illegal",
    "yasadisi",
}
BLOCKED_MESSAGE = "Bu konuda su an yorum yapamam."
ALLOWED_EMOTIONS = {"happy", "neutral", "angry", "sad"}
ALLOWED_AGE_RANGES = {"18-25", "25-40", "40+", "unknown"}
ALLOWED_GENDERS = {"male", "female", "unknown"}
ALLOWED_PERSONS = {
    "Ali Aydın",
    "Toprak Mert Yürekli",
    "Mustafa Göçmezler",
    "Ali Raşit Sipahi",
    "Yasin",
    "unknown",
}


def _normalize_person(value: Optional[str]) -> str:
    if not value:
        return "unknown"
    raw = str(value).strip()
    if raw in ALLOWED_PERSONS:
        return raw
    key = raw.casefold()
    mapping = {
        "ali": "Ali Aydın",
        "ali aydin": "Ali Aydın",
        "ali aydın": "Ali Aydın",
        "toprak": "Toprak Mert Yürekli",
        "toprak mert yurekli": "Toprak Mert Yürekli",
        "toprak mert yürekli": "Toprak Mert Yürekli",
        "mustafa": "Mustafa Göçmezler",
        "mustafa gocmezler": "Mustafa Göçmezler",
        "mustafa göçmezler": "Mustafa Göçmezler",
        "rasit": "Ali Raşit Sipahi",
        "raşit": "Ali Raşit Sipahi",
        "ali rasit": "Ali Raşit Sipahi",
        "ali raşit": "Ali Raşit Sipahi",
        "ali rasit sipahi": "Ali Raşit Sipahi",
        "ali raşit sipahi": "Ali Raşit Sipahi",
        "yasin": "Yasin",
    }
    return mapping.get(key, "unknown")


class ChatRequest(BaseModel):
    text: str
    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()))


class ChatResponse(BaseModel):
    response_text: str
    audio_base64: Optional[str] = None
    session_id: str


class TTSRequest(BaseModel):
    text: str


def _check_security(text: str) -> bool:
    text_lower = text.lower()
    return not any(word in text_lower for word in SECURITY_BLACKLIST)


def _sanitize_perception_payload(data: dict) -> Optional[dict]:
    active_avatar = _normalize_person(data.get("active_avatar"))
    identified_person = _normalize_person(data.get("identified_person"))

    emotion = data.get("emotion")
    if emotion not in ALLOWED_EMOTIONS:
        emotion = "neutral"

    age_range = data.get("age_range", "unknown")
    if age_range not in ALLOWED_AGE_RANGES:
        age_range = "unknown"

    gender = data.get("gender", "unknown")
    if gender not in ALLOWED_GENDERS:
        gender = "unknown"

    confidence_raw = data.get("confidence", 0)
    try:
        confidence = max(0.0, min(float(confidence_raw), 1.0))
    except (TypeError, ValueError):
        confidence = 0.0

    ts_raw = data.get("ts")
    try:
        ts = int(ts_raw)
    except (TypeError, ValueError):
        ts = int(datetime.now(timezone.utc).timestamp())

    return {
        "active_avatar": active_avatar,
        "identified_person": identified_person,
        "emotion": emotion,
        "age_range": age_range,
        "gender": gender,
        "confidence": confidence,
        "ts": ts,
    }


def _track_task(task: asyncio.Task, label: str) -> asyncio.Task:
    def _done_callback(done_task: asyncio.Task) -> None:
        try:
            done_task.result()
        except asyncio.CancelledError:
            return
        except Exception:  # pragma: no cover - background task errors
            logger.exception("Task failed (%s)", label)

    task.add_done_callback(_done_callback)
    return task


async def _safe_send_json(websocket: Optional[WebSocket], payload: dict) -> None:
    if websocket is None:
        return
    try:
        await websocket.send_json(payload)
    except Exception:  # pragma: no cover - closed socket
        logger.debug("WebSocket send failed")


async def _cancel_inflight(session, websocket: Optional[WebSocket], reason: str) -> None:
    if session.cancel_event and not session.cancel_event.is_set():
        session.cancel_event.set()

    for task in (session.response_task, session.tts_task, session.avatar_task):
        if task and not task.done():
            task.cancel()

    session.response_task = None
    session.tts_task = None
    session.avatar_task = None
    session.state = ConversationState.LISTENING

    await _safe_send_json(websocket, {"type": "state", "state": "listening"})
    await _safe_send_json(websocket, {"type": "avatar", "event": "speaking", "value": False})
    await _safe_send_json(websocket, {"type": "avatar", "event": "idle", "value": True})


async def _stream_llm(session, websocket: Optional[WebSocket], user_text: str, cancel_event):
    full_response = ""
    async for chunk in llm_service.stream_response(
        user_text,
        session.memory,
        perception=session.perception,
        perception_last_seen=session.perception_last_seen,
    ):
        if cancel_event.is_set():
            return ""
        full_response += chunk
        await _safe_send_json(websocket, {"type": "response_chunk", "text": chunk})
    return full_response


async def _run_response(session, websocket: Optional[WebSocket], user_text: str, cancel_event):
    current_task = asyncio.current_task()
    try:
        if not _check_security(user_text):
            await _safe_send_json(
                websocket,
                {"type": "response_complete", "text": BLOCKED_MESSAGE, "blocked": True},
            )
            await _safe_send_json(websocket, {"type": "state", "state": "idle"})
            return

        full_response = await _stream_llm(session, websocket, user_text, cancel_event)
        if cancel_event.is_set() or session.cancel_event is not cancel_event:
            return

        if full_response:
            store.add_turn(session, user_text, full_response)

        await _safe_send_json(websocket, {"type": "state", "state": "speaking"})

        voice_id = settings.voice_id_for_avatar(session.active_avatar)
        session.tts_task = _track_task(
            asyncio.create_task(tts_service.synthesize(full_response, voice_id=voice_id)), "tts"
        )
        audio_bytes = await session.tts_task
        session.tts_task = None

        if cancel_event.is_set() or session.cancel_event is not cancel_event:
            return

        if audio_bytes:
            audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
            await _safe_send_json(websocket, {"type": "audio", "data": audio_base64})

        await _safe_send_json(websocket, {"type": "response_complete", "text": full_response})

        duration_ms = estimate_duration_ms(full_response, settings.speech_rate_wpm)
        session.avatar_task = _track_task(
            asyncio.create_task(
                play_avatar_timeline(websocket, full_response, duration_ms, cancel_event)
            ),
            "avatar",
        )

        if cancel_event.is_set() or session.cancel_event is not cancel_event:
            return

        session.state = ConversationState.IDLE
        await _safe_send_json(websocket, {"type": "state", "state": "idle"})
    except Exception:  # pragma: no cover - unexpected runtime errors
        logger.exception("Response flow failed")
        await _safe_send_json(websocket, {"type": "state", "state": "idle"})
    finally:
        if session.response_task is current_task:
            session.response_task = None


@api_router.get("/")
async def root():
    return {"message": "AVM Robot API"}


@api_router.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "deepgram": bool(settings.deepgram_api_key),
        "gemini": bool(settings.gemini_api_key),
        "elevenlabs": bool(settings.elevenlabs_api_key),
        "simli": bool(settings.simli_api_key),
    }


@api_router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    if not _check_security(request.text):
        return ChatResponse(
            response_text=BLOCKED_MESSAGE, audio_base64=None, session_id=request.session_id
        )

    session = store.get_or_create(request.session_id)
    session.state = ConversationState.THINKING
    cancel_event = session.new_cancel_event()

    response_text = await _stream_llm(session, None, request.text, cancel_event)
    if response_text:
        store.add_turn(session, request.text, response_text)

    audio_bytes = await tts_service.synthesize(response_text)
    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8") if audio_bytes else None
    session.state = ConversationState.IDLE

    return ChatResponse(
        response_text=response_text,
        audio_base64=audio_base64,
        session_id=request.session_id,
    )


@api_router.post("/tts")
async def text_to_speech(request: TTSRequest):
    audio_bytes = await tts_service.synthesize(request.text)
    if not audio_bytes:
        raise HTTPException(status_code=500, detail="TTS generation failed")

    return StreamingResponse(
        iter([audio_bytes]),
        media_type="audio/mpeg",
        headers={"Content-Disposition": "attachment; filename=speech.mp3"},
    )


@api_router.get("/config")
async def get_config():
    avatar_profiles = {
        name: {"simli_face_id": profile.get("simli_face_id", "")}
        for name, profile in settings.avatar_profiles.items()
    }
    return {
        "deepgram_api_key": settings.deepgram_api_key,
        "elevenlabs_voice_id": settings.elevenlabs_voice_id,
        "simli_api_key": settings.simli_api_key,
        "simli_face_id": settings.simli_face_id,
        "avatar_profiles": avatar_profiles,
        "character_name": settings.character_name,
        "character_title": settings.character_title,
    }


@api_router.get("/sessions/{session_id}/history")
async def get_session_history(session_id: str):
    session = store.get(session_id)
    return {"conversations": session.history if session else []}


@api_router.delete("/sessions/{session_id}")
async def clear_session(session_id: str):
    store.delete(session_id)
    return {"message": "Session cleared"}


@api_router.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await websocket.accept()
    logger.info("WebSocket connected: %s", session_id)

    session = store.get_or_create(session_id)
    session.stt_state = STTState.READY if settings.stt_mode == "external" else STTState.CONNECTING

    try:
        while True:
            data = await websocket.receive_json()
            message_type = data.get("type")

            if message_type == "transcript":
                text = (data.get("text") or "").strip()
                is_final = data.get("is_final", True)
                if not text:
                    continue

                async with session.lock:
                    if session.state in (ConversationState.THINKING, ConversationState.SPEAKING):
                        continue

                    session.stt_state = (
                        STTState.FINALIZING if is_final else STTState.LISTENING
                    )
                    if is_final:
                        session.stt_state = STTState.READY

                    if not is_final:
                        session.state = ConversationState.LISTENING
                        await _safe_send_json(websocket, {"type": "state", "state": "listening"})
                        continue

                    session.state = ConversationState.THINKING
                    await _safe_send_json(websocket, {"type": "state", "state": "thinking"})
                    session.cancel_event = asyncio.Event()
                    session.response_task = _track_task(
                        asyncio.create_task(_run_response(session, websocket, text, session.cancel_event)),
                        "response",
                    )
            elif message_type == "audio_frame":
                channels = data.get("channels", 1)
                if channels != 1:
                    logger.warning("Ignored non-mono audio frame")
                session.stt_state = STTState.LISTENING
            elif message_type == "perception":
                payload = _sanitize_perception_payload(data)
                if payload:
                    session.perception = payload
                    session.perception_last_seen = datetime.now(timezone.utc)
                    session.active_avatar = payload.get("active_avatar")
                    session.identified_person = payload.get("identified_person")
            else:
                await _safe_send_json(websocket, {"type": "pong"})
    except WebSocketDisconnect:
        logger.info("WebSocket disconnected: %s", session_id)
    except Exception:
        logger.exception("WebSocket error")
        await websocket.close()
    finally:
        session.stt_state = STTState.DISCONNECTED


app.include_router(api_router)

# Browsers reject credentialed CORS with wildcard origin.
allow_credentials = "*" not in settings.cors_origins

app.add_middleware(
    CORSMiddleware,
    allow_credentials=allow_credentials,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
