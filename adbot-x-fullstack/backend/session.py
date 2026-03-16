from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
import asyncio
from typing import Optional
import uuid


class ConversationState(str, Enum):
    IDLE = "idle"
    LISTENING = "listening"
    THINKING = "thinking"
    SPEAKING = "speaking"


class STTState(str, Enum):
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    READY = "ready"
    LISTENING = "listening"
    FINALIZING = "finalizing"
    ERROR = "error"
    STOPPED = "stopped"


@dataclass
class SessionContext:
    session_id: str
    state: ConversationState = ConversationState.IDLE
    stt_state: STTState = STTState.READY
    memory: list[dict] = field(default_factory=list)
    history: list[dict] = field(default_factory=list)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    response_task: Optional[asyncio.Task] = None
    tts_task: Optional[asyncio.Task] = None
    avatar_task: Optional[asyncio.Task] = None
    cancel_event: Optional[asyncio.Event] = None
    perception: Optional[dict] = None
    perception_last_seen: Optional[datetime] = None
    active_avatar: Optional[str] = None
    identified_person: Optional[str] = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def new_cancel_event(self) -> asyncio.Event:
        self.cancel_event = asyncio.Event()
        return self.cancel_event

    def add_turn(self, user_text: str, response_text: str) -> dict:
        self.memory.append({"role": "user", "text": user_text})
        self.memory.append({"role": "model", "text": response_text})
        entry = {
            "id": str(uuid.uuid4()),
            "session_id": self.session_id,
            "user_text": user_text,
            "response_text": response_text,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        self.history.append(entry)
        return entry


class SessionStore:
    def __init__(self, memory_window: int = 10, history_limit: int = 200) -> None:
        self._sessions: dict[str, SessionContext] = {}
        self._memory_window = memory_window
        self._history_limit = history_limit

    def get_or_create(self, session_id: str) -> SessionContext:
        session = self._sessions.get(session_id)
        if session is None:
            session = SessionContext(session_id=session_id)
            self._sessions[session_id] = session
        return session

    def get(self, session_id: str) -> Optional[SessionContext]:
        return self._sessions.get(session_id)

    def delete(self, session_id: str) -> None:
        if session_id in self._sessions:
            del self._sessions[session_id]

    def add_turn(self, session: SessionContext, user_text: str, response_text: str) -> dict:
        entry = session.add_turn(user_text, response_text)

        max_items = max(self._memory_window, 1) * 2
        if len(session.memory) > max_items:
            session.memory = session.memory[-max_items:]

        if len(session.history) > self._history_limit:
            session.history = session.history[-self._history_limit :]

        return entry
