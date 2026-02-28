# Copilot Coding Agent Instructions

## Project Overview

MQTT AI Tool is a TypeScript/Node.js application that listens for JSON requests over MQTT, processes files/camera captures/database queries/MQTT messages through configurable AI backends (OpenAI-compatible), and publishes results back to MQTT topics. It runs as a long-lived service, typically in Docker.

## Tech Stack

- **Language:** TypeScript (strict mode, ES2020 target, CommonJS modules)
- **Runtime:** Node.js 18/20/22
- **Package Manager:** npm
- **Testing:** Jest with ts-jest preset
- **Containerization:** Docker (multi-stage build, node:22-alpine builder, node:22-slim runtime)
- **Key Dependencies:** mqtt, axios, ffmpeg-static, winston (logging), js-yaml (config), mariadb, form-data

## Repository Structure

```
src/
  app.ts              # Main application: queue management, payload processing, loader orchestration, HA discovery
  config/
    config.ts         # Loads and validates config.yaml
  services/
    aiService.ts      # AI backend HTTP communication (OpenAI-compatible)
    cameraService.ts  # RTSP camera image capture via FFmpeg
    mqttService.ts    # MQTT client wrapper (publish, subscribe, LWT)
    statusService.ts  # PROGRESS/STATS state management
  types/
    index.ts          # All TypeScript interfaces and type definitions
    mariadb.d.ts      # MariaDB module type declarations
  utils/
    logger.ts         # Winston logger configuration
    promptUtils.ts    # Prompt template chaining, JSON schema building, response extraction
__tests__/
  app.test.ts         # Core application tests
  loaders.test.ts     # Loader-specific tests (camera, URL, database, MQTT)
  mqttService.test.ts # MQTT service tests
  promptUtils.test.ts # Prompt utility tests
  topicRouting.test.ts # Topic routing tests
  queueBypass.test.ts # Queue bypass and immediate loader tests
  utils/
    testHelpers.ts    # importAppWithMocks() helper for isolated module testing
config.yaml.sample    # Sample configuration file (copy to config.yaml to use)
```

## Build & Test Commands

- **Install dependencies:** `npm ci`
- **Build (TypeScript → JS):** `npm run build`
- **Run tests:** `npm test` (runs `jest --runInBand`)
- **Start (dev):** `npm start` (uses ts-node)
- **Start (production):** `node dist/app.js`

## Testing Guidelines

- All tests live in `__tests__/` and match the pattern `**/__tests__/**/*.test.ts`.
- Tests use **module-level mocking** via the `importAppWithMocks()` helper in `__tests__/utils/testHelpers.ts`. This function uses `jest.doMock()` to replace service constructors before importing `app.ts`, providing full isolation.
- When writing new tests, always use `importAppWithMocks()` with appropriate service overrides rather than importing `app.ts` directly. Pass mock implementations for `mqtt`, `ai`, `status`, `camera`, and `mariadb` as needed.
- Tests run with `--runInBand` (sequential) because module mocking requires isolated module registries.
- After any code change, all existing tests must continue to pass. Run `npm test` to verify.
- When adding new features, add corresponding test coverage in a relevant test file or create a new `__tests__/<feature>.test.ts` file.

## Architecture Notes

### Queue System
- Incoming MQTT INPUT messages are enqueued and processed sequentially by default.
- Tasks can bypass the queue with `queue: false` (on the task config or in the payload).
- Individual loaders within queued tasks can be marked `immediate: true` to begin processing (e.g., capturing camera images) while the task waits in the queue.

### Loader Processing
- All loader types (camera, url, database, mqtt) are handled by the `processLoaderItem()` function in `app.ts`.
- Both `processImmediateLoaders()` (background pre-processing) and `processPayload()` (main processing) delegate to `processLoaderItem()` — there is a single source of truth for loader logic.
- When modifying loader behavior, only edit `processLoaderItem()`.

### Task Resolution
- `resolveTaskPayload()` in `app.ts` merges a named task template (from `config.yaml`) with payload-level overrides. Both `enqueueInput()` and `processPayload()` use this function.

### Prompt System
- Prompt templates are defined in `config.yaml` under `prompts:` and can be chained (array of template names).
- `composeTemplateChain()` in `promptUtils.ts` resolves and concatenates chained templates.
- Structured output schemas are built via `buildJsonSchema()` in `promptUtils.ts`.

### MQTT Topics
All topics are under `config.mqtt.basetopic`:
- `INPUT` — accepts JSON requests
- `OUTPUT` / `OUTPUT/<topic>` — AI results (non-retained)
- `PROGRESS` / `PROGRESS/<topic>` — status updates (retained)
- `STATS` / `STATS/<topic>` — performance metrics (retained)
- `QUEUED` — number of tasks waiting in the queue, does not include the currently processing task (retained)
- `RUNNING` — number of tasks/prompts currently being processed, whether queued or unqueued (retained)
- `IMMEDIATE` — number of immediate loader sets running in the background for queued tasks; 0 = none active (retained)
- `ONLINE` — LWT online/offline status (retained)

### Home Assistant Discovery
Tasks with `ha: true` publish MQTT discovery payloads so that Home Assistant auto-creates sensor entities for each output field.

## Configuration

The application reads `config.yaml` at startup (see `config.yaml.sample` for the full reference). Key sections:
- `mqtt:` — broker connection, basetopic, HA discovery prefix
- `ai:` — named AI backends with endpoint, token/token_file, model
- `cameras:` — named RTSP camera URLs or detailed objects with credentials
- `prompts:` — reusable prompt templates with optional structured output schemas
- `databases:` — MariaDB connection details
- `tasks:` — pre-defined task templates combining AI backend, prompt, loaders, and options

Credentials support `password_file` / `token_file` for Docker secrets.

## Code Style & Conventions

- TypeScript strict mode is enabled (`strict: true`, `strictNullChecks`, `noImplicitAny`, `noImplicitReturns`).
- All interfaces and types are defined in `src/types/index.ts`.
- Use `logger` (Winston) for all logging — never use `console.log` in source files.
- Prefer `async/await` over raw Promises.
- Keep functions focused and avoid duplication — extract shared logic into helper functions.
- Use descriptive variable names; avoid abbreviations except for well-known ones (e.g., `db`, `config`, `idx`).

## CI/CD

Two GitHub Actions workflows run on push/PR to `main`:
1. **Node Build/Test** (`node.build.yml`) — builds and tests across Node 18/20/22.
2. **Docker Build** (`docker.build.yml`) — builds the Docker image to verify it compiles.

Both must pass before merging.
