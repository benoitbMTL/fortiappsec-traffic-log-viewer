# ---------------------------------------
# FortiAppSec Traffic Logs Viewer
# Python 3.11 + Gunicorn
# ---------------------------------------
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Install OS deps (pandas/pyarrow need build tools & lib)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Python deps first to leverage Docker layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the app
COPY . .

# Default port used by the Flask app / Gunicorn
ENV PORT=8000

# Expose for clarity (optional)
EXPOSE 8000

# Start with Gunicorn (prod-ready)
# - 3 workers; adjust if you have more CPU
CMD ["gunicorn", "-w", "3", "-b", "0.0.0.0:8000", "app:app"]
