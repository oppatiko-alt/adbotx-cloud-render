from pathlib import Path
import os
from typing import Optional

from dotenv import load_dotenv


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

AVATAR_ALI = "Ali Aydın"
AVATAR_TOPRAK = "Toprak Mert Yürekli"
AVATAR_MUSTAFA = "Mustafa Göçmezler"
AVATAR_RASIT = "Ali Raşit Sipahi"
AVATAR_YASIN = "Yasin"

SYSTEM_PROMPT = (
    "Sen Ali Aydın'sın. Kıdemli Yazılım Mühendisisin ve AI Agent'lar konusunda "
    "uzmanlaşmış bir profesyonelsin.\n\n"
    "Kişilik özelliklerin:\n"
    "- Naif, samimi ve kibar bir beyefendisin\n"
    "- Samimi ve esprili bir iletişim tarzın var\n"
    "- Yazılım mühendisliği ve özellikle AI Agent teknolojileri konusunda derin bilgi sahibisin\n"
    "- İnsanlara yardımcı olmaktan keyif alırsın\n"
    "- Teknik konuları anlaşılır şekilde açıklayabilirsin\n"
    "- Türkçe konuşuyorsun, nazik ve saygılı bir üslubun var\n\n"
    "Uzmanlık alanların:\n"
    "- Yapay zeka ve AI Agent sistemleri\n"
    "- LLM (Large Language Models) entegrasyonları\n"
    "- Otonom sistemler ve akıllı asistanlar\n"
    "- Yazılım mimarisi ve geliştirme\n\n"
    "Şu anda arkadaşlarınla sohbet ediyorsun. Sorulara cevap ver. "
    "Kısa ve öz cevaplar ver, 2-3 cümleyi geçme. "
    "Kibar, samimi ve kurumsal bir üslup kullan."
)


def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


class Settings:
    def __init__(self) -> None:
        self.app_title = os.environ.get("APP_TITLE", "AVM Robot API")
        self.cors_origins = _split_csv(os.environ.get("CORS_ORIGINS", "*"))

        self.deepgram_api_key = os.environ.get("DEEPGRAM_API_KEY", "")
        self.gemini_api_key = os.environ.get("GEMINI_API_KEY", "")
        self.elevenlabs_api_key = os.environ.get("ELEVENLABS_API_KEY", "")
        self.elevenlabs_voice_id = os.environ.get("ELEVENLABS_VOICE_ID", "")
        self.simli_api_key = os.environ.get("SIMLI_API_KEY", "")
        self.simli_face_id = os.environ.get("SIMLI_FACE_ID", "")

        self.simli_face_id_ali = os.environ.get("SIMLI_FACE_ID_ALI", "")
        self.simli_face_id_toprak = os.environ.get("SIMLI_FACE_ID_TOPRAK", "")
        self.simli_face_id_mustafa = os.environ.get("SIMLI_FACE_ID_MUSTAFA", "")
        self.simli_face_id_rasit = os.environ.get("SIMLI_FACE_ID_RASIT", "")
        self.simli_face_id_yasin = os.environ.get("SIMLI_FACE_ID_YASIN", "")

        self.elevenlabs_voice_id_ali = os.environ.get("ELEVENLABS_VOICE_ID_ALI", "")
        self.elevenlabs_voice_id_toprak = os.environ.get("ELEVENLABS_VOICE_ID_TOPRAK", "")
        self.elevenlabs_voice_id_mustafa = os.environ.get("ELEVENLABS_VOICE_ID_MUSTAFA", "")
        self.elevenlabs_voice_id_rasit = os.environ.get("ELEVENLABS_VOICE_ID_RASIT", "")
        self.elevenlabs_voice_id_yasin = os.environ.get("ELEVENLABS_VOICE_ID_YASIN", "")

        self.character_name = os.environ.get("CHARACTER_NAME", "Ali Aydın")
        self.character_title = os.environ.get(
            "CHARACTER_TITLE", "Kıdemli Yazılım Mühendisi | AI Agent Uzmanı"
        )
        self.system_prompt = os.environ.get("SYSTEM_PROMPT", SYSTEM_PROMPT)

        self.llm_model = os.environ.get("LLM_MODEL", "gemini-2.5-flash-lite")
        self.llm_max_tokens = int(os.environ.get("LLM_MAX_TOKENS", "200"))
        self.llm_temperature = float(os.environ.get("LLM_TEMPERATURE", "0.7"))
        self.llm_memory_window = int(os.environ.get("LLM_MEMORY_WINDOW", "10"))

        self.tts_model_id = os.environ.get("TTS_MODEL_ID", "eleven_multilingual_v2")
        self.edge_tts_voice = os.environ.get("EDGE_TTS_VOICE", "tr-TR-AhmetNeural")
        self.edge_tts_rate = os.environ.get("EDGE_TTS_RATE", "+0%")

        self.stt_mode = os.environ.get("STT_MODE", "external")
        self.speech_rate_wpm = int(os.environ.get("SPEECH_RATE_WPM", "170"))

        self.avatar_profiles = {
            AVATAR_ALI: {
                "simli_face_id": self.simli_face_id_ali or self.simli_face_id,
                "elevenlabs_voice_id": self.elevenlabs_voice_id_ali or self.elevenlabs_voice_id,
            },
            AVATAR_TOPRAK: {
                "simli_face_id": self.simli_face_id_toprak or self.simli_face_id,
                "elevenlabs_voice_id": self.elevenlabs_voice_id_toprak or self.elevenlabs_voice_id,
            },
            AVATAR_MUSTAFA: {
                "simli_face_id": self.simli_face_id_mustafa or self.simli_face_id,
                "elevenlabs_voice_id": self.elevenlabs_voice_id_mustafa or self.elevenlabs_voice_id,
            },
            AVATAR_RASIT: {
                "simli_face_id": self.simli_face_id_rasit or self.simli_face_id,
                "elevenlabs_voice_id": self.elevenlabs_voice_id_rasit or self.elevenlabs_voice_id,
            },
            AVATAR_YASIN: {
                "simli_face_id": self.simli_face_id_yasin or self.simli_face_id,
                "elevenlabs_voice_id": self.elevenlabs_voice_id_yasin or self.elevenlabs_voice_id,
            },
        }

    def voice_id_for_avatar(self, avatar_name: Optional[str]) -> str:
        if not avatar_name:
            return self.elevenlabs_voice_id
        profile = self.avatar_profiles.get(avatar_name)
        return (profile or {}).get("elevenlabs_voice_id") or self.elevenlabs_voice_id


settings = Settings()
