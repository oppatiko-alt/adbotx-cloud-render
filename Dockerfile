FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY adbot-x-fullstack/backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY adbot-x-fullstack/backend/ ./

CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8000}"]
