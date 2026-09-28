# --- frontend build -------------------------------------------------------------
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- API + worker ------------------------------------------------------------------
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng fonts-dejavu-core libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 app
WORKDIR /app
COPY backend/pyproject.toml ./
COPY backend/planmeasure ./planmeasure
RUN pip install ".[anthropic,s3,redis]"
COPY backend/alembic.ini ./
COPY backend/migrations ./migrations
COPY --from=web /web/dist /app/frontend_dist
ENV PM_FRONTEND_DIST=/app/frontend_dist PM_STORAGE_DIR=/data/storage
RUN mkdir -p /data/storage && chown -R app:app /data
USER app
EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && uvicorn planmeasure.main:app --host 0.0.0.0 --port 8000 --proxy-headers"]
