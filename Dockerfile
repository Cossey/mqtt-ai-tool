# Builder stage: install dev dependencies and build
FROM node:22-alpine AS builder
WORKDIR /usr/src/app

# Copy package files and install all dependencies (including dev deps for build)
COPY package*.json ./
RUN npm ci

# Copy project files and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Runtime stage: minimal image with only production deps and ffmpeg
FROM node:22-slim AS runtime

ENV NODE_ENV=production

# Install ffmpeg, certificates, and create non-root user in a single layer
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --user-group --create-home --shell /bin/false appuser

WORKDIR /usr/src/app

# Copy package files and install only production deps
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --progress=false

# Copy built artifacts from builder stage
COPY --from=builder /usr/src/app/dist ./dist

# Ensure logs and temp files are writeable by appuser
RUN mkdir -p /usr/src/app/tmp && chown -R appuser:appuser /usr/src/app

# Use non-root user
USER appuser

CMD ["node", "dist/app.js"]