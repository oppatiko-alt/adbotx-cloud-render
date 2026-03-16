from pathlib import Path
import os

from dotenv import load_dotenv


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")


SYSTEM_PROMPT = (
    "Sen Ali Aydin'sin. Kidemli Yazilim Muhendisisin ve AI Agent'lar konusunda "
    "uzmanlasmis bir profesyonelsin.\n\n"
    "Kisilik ozelliklerin:\n"
    "- Naif, samimi ve kibar bir beyefendisin\n"
    "- samimi esprili bir iletisim tarzin var\n"
    "- Yazilim muhendisligi ve ozellikle AI Agent teknolojileri konusunda derin bilgi sahibisin\n"
    "- Insanlara yardimci olmaktan keyif alirsin\n"
    "- Teknik konulari anlasilir sekilde aciklayabilirsin\n"
    "- Turkce konusuyorsun, nazik ve saygili bir uslubun var\n\n"
    "Uzmanlik alanlarin:\n"
    "- Yapay zeka ve AI Agent sistemleri\n"
    "- LLM (Large Language Models) entegrasyonlari\n"
    "- Otonom sistemler ve akilli asistanlar\n"
    "- Yazilim mimarisi ve gelistirme\n\n"
    "Su anda arkadaşlarınla sohbet ediyorsun."
    "sorulara cevap ver. Kisa ve oz cevaplar ver, 2-3 cumleyi gecme. "
    "Kibar, samimi ve kurumsal bir uslup kullan."
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

        self.character_name = os.environ.get("CHARACTER_NAME", "Ali Aydin")
        self.character_title = os.environ.get(
            "CHARACTER_TITLE", "Kidemli Yazilim Muhendisi | AI Agent Uzmani"
        )
        self.system_prompt = os.environ.get("SYSTEM_PROMPT", SYSTEM_PROMPT)

        self.llm_model = os.environ.get("LLM_MODEL", "gemini-2.5-flash-lite")
        self.llm_max_tokens = int(os.environ.get("LLM_MAX_TOKENS", "200"))
        self.llm_temperature = float(os.environ.get("LLM_TEMPERATURE", "0.7"))
        self.llm_memory_window = int(os.environ.get("LLM_MEMORY_WINDOW", "10"))

        self.tts_model_id = os.environ.get("TTS_MODEL_ID", "eleven_multilingual_v2")

        self.stt_mode = os.environ.get("STT_MODE", "external")
        self.speech_rate_wpm = int(os.environ.get("SPEECH_RATE_WPM", "170"))


settings = Settings()
