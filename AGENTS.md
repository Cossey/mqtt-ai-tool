# AGENTS

This file defines repository-level guidance for coding agents working in this project.

## Scope

- Applies to the entire repository.
- Use this as the primary quick-reference guide.
- Detailed background guidance is also available in `.github/agents.md`.

## Project Summary

MQTT AI Tool is a TypeScript/Node.js service that:

- listens on MQTT INPUT,
- gathers context through loaders (camera, url, mqtt, database),
- sends prompt plus attachments to configured AI backends,
- publishes results and operational telemetry back to MQTT topics.

## Key Commands

- Install: `npm ci`
- Build: `npm run build`
- Test (all): `npm test`
- Start (dev): `npm start`
- Start (prod): `node dist/app.js`

## High-Value Contracts

When changing behavior, preserve these contracts unless explicitly requested otherwise.

1. OUTPUT envelope
- OUTPUT messages include: `tag`, `time`, `model`, `text`, `json`, `loader_state`.
- `loader_state` values:
  - `none`: no loader had `options.output: true`
  - `ready`: LOADER publishes were issued (fire-and-forget) or fully confirmed (timeout mode)
  - `incomplete`: one or more LOADER publishes failed/timed out in timeout mode

2. LOADER publish ordering
- Publish LOADER topics before OUTPUT for each request.
- LOADER publish QoS is 1.

3. Loader publish mode
- Controlled by `mqtt.loader_publish`.
- `0`: fire-and-forget.
- `>0`: wait up to N milliseconds for publish confirmation callbacks.
- No retry logic.

4. Topic routing
- If request includes `topic`, route OUTPUT/PROGRESS/STATS under that subtopic.
- LOADER topics follow `OUTPUT/<topic>/LOADER/...` when routing is active.

## Testing Expectations

- Keep tests green after every change.
- Run at least:
  - `npm run build`
  - `npm test`
- Add/adjust tests for behavioral changes, especially in:
  - `__tests__/app.test.ts`
  - `__tests__/loaders.test.ts`
  - `__tests__/topicRouting.test.ts`
  - `__tests__/queueBypass.test.ts`

## Test Style Guidance

- Prefer `importAppWithMocks()` from `__tests__/utils/testHelpers.ts` for app-level tests.
- Mock service constructors at module import boundaries with Jest mocks.
- Keep assertions focused on externally observable contracts (topics, payload shape, sequencing).

## Coding Conventions

- TypeScript strict mode is enabled; preserve strong typing.
- Prefer small, focused functions and shared helpers over duplicated logic.
- Use project logger in source files (avoid console logging in src code).
- Keep edits minimal and scoped to the requested change.

## Configuration Notes

Main config sections in `config.yaml`:

- `mqtt`
- `ai`
- `cameras`
- `prompts`
- `tasks`
- `databases` (optional)

Secret-friendly options include `password_file` and `token_file`.
