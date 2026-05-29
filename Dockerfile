FROM node:20-bookworm-slim

# Install system dependencies required for Playwright, yt-dlp, FFmpeg, etc.
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./

# Install npm dependencies (ignore scripts during initial install so we control playwright install)
RUN npm install --ignore-scripts

# Install Playwright chromium browser explicitly with its dependencies
RUN npx playwright install --with-deps chromium

# Copy the rest of the application
COPY . .

# Expose the port (Render provides the PORT env var dynamically)
EXPOSE 3000

# Start the server with unhandled rejections as warnings to prevent crashes
CMD ["npm", "start"]
