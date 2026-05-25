# syntax=docker/dockerfile:1.7

# Node 22 on Debian Bookworm (slim) — small base, full apt access.
# Matches the Node version Render auto-installs (22.16.x) so no surprises.
FROM node:22-bookworm-slim

# ─── System deps for Playwright Chromium (headless) ────────────────────────
# Pulled from the official Playwright dependency list, trimmed to headless-
# only essentials (no X11 GUI bits since we never run headed on Render).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg \
        libnss3 libnspr4 \
        libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
        libcups2 \
        libdrm2 libgbm1 \
        libdbus-1-3 \
        libxkbcommon0 libxcomposite1 libxdamage1 libxext6 \
        libxfixes3 libxrandr2 libxshmfence1 \
        libpango-1.0-0 libcairo2 \
        libasound2 \
        fonts-liberation fonts-noto-color-emoji fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ─── Install Node deps + Playwright Chromium binary in cached layer ────────
# Copy package files first so Docker can cache this layer when only app
# source changes (huge speedup on subsequent deploys).
COPY package*.json ./

# PLAYWRIGHT_BROWSERS_PATH controls where the Chromium binary lands. Pointing
# it at /ms-playwright (instead of ~/.cache) means it persists with the image
# and isn't wiped between container restarts.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Disable npm audit + funding noise + skip postinstall (we run playwright
# install explicitly below — postinstall would just duplicate it).
RUN npm install --no-audit --no-fund --omit=dev --ignore-scripts && \
    npx --yes playwright install chromium

# ─── Copy app source (this layer rebuilds on every code change) ────────────
COPY . .

# Render injects PORT at runtime; server.js reads process.env.PORT.
EXPOSE 3000

# --unhandled-rejections=warn keeps the process alive when browser-use leaks
# a Playwright timeout. server.js also strips browser-use's process.exit
# handlers (see server.js line ~265).
CMD ["node", "--unhandled-rejections=warn", "server.js"]
