# Builder stage: install dev dependencies and build
FROM node:22 AS builder
WORKDIR /usr/src/app

# Copy package files and install all dependencies (including dev deps for build)
COPY package*.json ./
RUN npm ci

# Copy project files and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY config/ ./config/
RUN npm run build

# Runtime stage: minimal image with only production deps and ffmpeg
FROM node:22-slim AS runtime

# Install ffmpeg and certificates with minimal packages
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Create a non-root user to run the app
RUN useradd --user-group --create-home --shell /bin/false appuser || true

# Copy package files and install only production deps
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --progress=false

# Copy built artifacts and config from builder stage
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/config ./config

# Ensure logs and temp files are writeable by appuser
RUN mkdir -p /usr/src/app/tmp && chown -R appuser:appuser /usr/src/app

# Use non-root user
USER appuser

EXPOSE 3000

CMD ["node", "dist/app.js"]