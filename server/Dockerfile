# Build from the REPOSITORY ROOT so the shared engine (../assets) is included:
#   docker build -f server/Dockerfile -t ph-payroll .
FROM node:20-bookworm-slim

# Build tools in case better-sqlite3 needs to compile (falls back from prebuilt).
# tzdata so the app's date logic (cut-offs, period generation, reminders) runs on
# Philippine time rather than the container's default UTC.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ tzdata \
    && rm -rf /var/lib/apt/lists/*

# Payroll dates are Philippine local time.
ENV TZ=Asia/Manila

WORKDIR /app

# Install server dependencies first (better layer caching).
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev

# App code + the shared offline engine used by the admin UI.
COPY server ./server
COPY assets ./assets

WORKDIR /app/server
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
EXPOSE 3000

# SQLite database lives on a persistent volume mounted at /data.
VOLUME ["/data"]

CMD ["node", "src/index.js"]
