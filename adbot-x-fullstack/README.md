# adbot-x fullstack

Bu repo artik cloud-first calisir. Mobil uygulama icin PC'nin acik kalmasi gerekmez.

## Mimari

- Android app (Capacitor): UI + kamera + mikrofon + websocket client
- Cloud backend (FastAPI): LLM + TTS + session + websocket

App ilk acilista backend URL ister. URL kaydedilir ve bir sonraki acilista tekrar sorulmaz.

## 1) Backend'i Buluta Al (PC'siz zorunlu)

Render ornegi:

1. Yeni Web Service olustur.
2. Root dir: `adbot-x-fullstack/backend`
3. Build command: `pip install -r requirements.txt`
4. Start command: `uvicorn server:app --host 0.0.0.0 --port $PORT`

Gerekli env varlar:

- `DEEPGRAM_API_KEY`
- `GEMINI_API_KEY`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `SIMLI_API_KEY`
- `SIMLI_FACE_ID` (veya profil bazli `SIMLI_FACE_ID_*`)
- `CORS_ORIGINS` (ornek: `*` veya app domain)

Health kontrol:

- `https://YOUR_BACKEND_DOMAIN/api/health`

## 2) Android APK Uret

```bash
cd adbot-x-fullstack/frontend
npm install --legacy-peer-deps
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
```

APK yolu:

- `frontend/android/app/build/outputs/apk/debug/app-debug.apk`

## 3) Telefonda Ilk Acilis

1. App'i ac.
2. `Set Backend` tusuna bas.
3. `https://YOUR_BACKEND_DOMAIN` yaz ve `Save URL`.
4. Mikrofon/kamera izinlerini ver.

Bu adimdan sonra uygulama direkt buluttaki backend ile calisir. PC kapali olsa da calismaya devam eder.

## Lokal Test (Opsiyonel)

Backend:

```bash
cd adbot-x-fullstack/backend
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```

Frontend web:

```bash
cd adbot-x-fullstack/frontend
npm start
```
