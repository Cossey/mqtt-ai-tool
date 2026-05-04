# MQTT AI Tool

A TypeScript/Node.js service that accepts MQTT `INPUT` requests, collects data from loaders (camera, URL, MQTT, database), sends prompt + attachments to an AI backend, and publishes results and operational state back to MQTT.

## Overview

This project is designed for automation workflows where an MQTT message should trigger AI analysis.

Key capabilities:

- Single global `INPUT` topic for AI requests.
- Optional queue bypass (`queue: false`) for immediate processing.
- Immediate loaders (`immediate: true`) for early data capture while queued.
- Reusable task templates in `config.yaml`.
- Plain-text `PROGRESS` and JSON `STATS` telemetry.
- Queue control via `CONTROL` (pause/resume/cancel/clear/reload).
- Pause state exposure via retained integer `PAUSE` topic.
- Optional Home Assistant/OpenHAB MQTT discovery (`ha: true` per task).

## MQTT Topics

All topics are rooted at `<basetopic>`.

- `<basetopic>/INPUT`
  - AI request messages (JSON).
- `<basetopic>/CONTROL`
  - Queue/control commands (text or JSON).
  - Publish as non-retained.
- `<basetopic>/OUTPUT`
  - AI outputs (JSON).
  - Runtime responses are non-retained.
- `<basetopic>/PROGRESS`
  - Plain-text processing status, retained.
- `<basetopic>/STATS`
  - JSON performance/health metrics, retained.
- `<basetopic>/QUEUED`
  - Number of waiting queued requests (excludes currently running), retained.
- `<basetopic>/RUNNING`
  - Number of currently processing requests (queued and bypassed), retained.
- `<basetopic>/IMMEDIATE`
  - Number of currently running immediate-loader sets, retained.
- `<basetopic>/PAUSE`
  - Integer pause state, retained:
    - `-1`: paused with no timeout
    - `0`: unpaused
    - `>0`: paused with countdown seconds remaining
- `<basetopic>/ONLINE`
  - Service availability (`YES`/`NO`), retained via LWT.

## CONTROL Commands

Use `<basetopic>/CONTROL` for non-AI queue operations.

Rules:

- Command keywords are case-insensitive.
- Task/tag matching values are case-sensitive.
- Text commands do not support spaced task/tag names.
- JSON commands support spaced names via `name`.
- Invalid/no-match commands are ignored (no side effects).

### Text Commands

```text
pause
pause 50
pause immediate
pause 50 immediate
resume
clear
cancel all
cancel index 1
cancel tag sec-frontdoor
cancel task garage_check
reload
```

### JSON Commands

```json
{ "cmd": "pause" }
{ "cmd": "pause", "value": 50 }
{ "cmd": "pause", "param": "immediate" }
{ "cmd": "pause", "param": "immediate", "value": 50 }
{ "cmd": "resume" }
{ "cmd": "cancel", "param": "all" }
{ "cmd": "cancel", "param": "index", "value": 1 }
{ "cmd": "cancel", "param": "tag", "name": "front door" }
{ "cmd": "cancel", "param": "tag", "name": ["front door", "garage"] }
{ "cmd": "cancel", "param": "task", "name": "garage_check" }
{ "cmd": "reload" }
```

Control semantics:

- `cancel index` is 1-based, oldest-first, waiting queue only.
- `pause` pauses dequeue only.
- `pause immediate` pauses dequeue and blocks new immediate-loader starts.
- `resume` unpauses both dequeue and immediate-loader starts.
- In-flight immediate work is not hard-killed in v1; canceled queued entries are removed and immediate temp artifacts are cleaned up when that work returns.

## Runtime Config Reload

The service supports runtime config reload from three trigger paths:

- Process signal: `SIGHUP`
- MQTT control command: text `reload` on `<basetopic>/CONTROL`
- MQTT control command: JSON `{ "cmd": "reload" }` on `<basetopic>/CONTROL`

Optional file-change reload can be enabled by setting environment variable `MQTT_AI_CONFIG_RELOAD=true`.
When enabled, the config file is watched and reload attempts are debounced (about 1.5s).

Reload behavior:

- Reload waits for active processing to finish before applying changes.
- On validation failure, current runtime config stays active and the service keeps running.
- Home Assistant discovery is republished after successful reload.

Runtime reload scope and limits:

- Most config sections can be reloaded at runtime (AI backends, prompts, tasks, cameras, databases, and non-connection MQTT fields such as `homeassistant` and `loader_publish`).
- MQTT connection settings cannot be changed at runtime and require process restart: `server`, `port`, `basetopic`, `username`, `password`, `password_file`, `client`.

## INPUT Request Format

Two styles are supported: task reference (recommended) and full inline request.

### Task Reference (Recommended)

```json
{
  "task": "garage_check",
  "tag": "check-001"
}
```

Optional overrides can be provided (`topic`, `ai`, `queue`, `prompt.*`).

### Full Inline Request

```json
{
  "tag": "my-request-123",
  "topic": "gate/security",
  "ai": "openai",
  "queue": true,
  "prompt": {
    "template": "gate_prompt",
    "text": "Custom prompt text",
    "output": {
      "FieldA": { "type": "string" }
    },
    "files": ["/path/to/local/file.txt"],
    "loader": [
      { "type": "camera", "source": "gate", "options": { "captures": 3, "interval": 1000 } },
      { "type": "url", "source": "https://example.com/file.pdf" }
    ]
  }
}
```

### OUTPUT Format

AI response envelope is published to `<basetopic>/OUTPUT` (or routed subtopic when `topic` is used):

```json
{
  "tag": "my-request-123",
  "time": 4.12,
  "model": "gpt-4-vision-preview",
  "text": "AI textual response",
  "json": { "Structured": "Result" },
  "loader_state": "none"
}
```

`json` is `null` when structured extraction is not available.

`loader_state` indicates LOADER publish result for this request:

- `none`: no loader had `options.output: true`.
- `ready`: LOADER publishes were issued (`loader_publish: 0`) or fully confirmed (`loader_publish > 0`).
- `incomplete`: one or more LOADER publishes failed or timed out in confirmation mode (`loader_publish > 0`).

### Loader Output Topics

When a loader has `options.output: true`, the loaded bytes are also published as binary MQTT payloads on LOADER subtopics:

`<basetopic>/OUTPUT[/<topic>]/LOADER/<loaderType>/<source>/<index?>`

- Camera loader: image bytes (one topic per capture when `captures > 1`, using `.../<index>`).
- Database loader: CSV bytes from query results.
- MQTT loader: topic payload bytes (binary passthrough; text encoded as UTF-8 bytes).

Publish sequencing for request completion is:

1. LOADER binary topics are published first.
2. AI OUTPUT JSON envelope is published second.

This ordering is intended for consumers that react to OUTPUT and then fetch LOADER data on demand (for example openHAB rules).

Loader publish mode is controlled by `mqtt.loader_publish` in `config.yaml`:

- `0` (default): fire-and-forget LOADER publish.
- `>0`: wait up to N milliseconds for each LOADER publish callback before emitting OUTPUT.
- No retries are performed.

## Queue and Loader Behavior

### Default Queueing

- Requests are queued and processed sequentially.
- `QUEUED` reflects only waiting items.
- `RUNNING` reflects currently active processing.

### Queue Bypass

Set `queue: false` in task config or request payload to process immediately (outside sequential queue).

### Immediate Loaders

In queued requests, loaders with `immediate: true` can pre-run while waiting in queue.

- Useful for time-sensitive captures.
- Pre-collected files/prompt additions are merged when the request reaches the front.
- `IMMEDIATE` reflects active pre-processing sets.

### Multi-Loader Execution

Within `processPayload`, loader execution is sequential in request order for deterministic behavior and simpler telemetry.

## Loader System

Loaders enrich a request by collecting files or text before sending the final prompt to the AI backend.

### Loader Object Shape

Each loader entry is defined in `prompt.loader[]`:

```json
{
  "type": "camera|url|mqtt|database",
  "source": "...",
  "immediate": true,
  "options": {}
}
```

- `type`: loader implementation to run.
- `source`: source identifier (meaning depends on type).
- `immediate` (optional): if `true`, pre-process this loader while the task is waiting in queue.
- `options` (optional): loader-specific settings.
  - `options.output` (optional, default `false`): when `true`, publish loader bytes to `.../OUTPUT/.../LOADER/...`.

### Execution Lifecycle

1. Task/payload is resolved (task template + payload overrides).
2. If queued and any loader has `immediate: true`, those loaders can run before dequeue.
3. When the task is processed, pre-processed loader outputs are injected.
4. Remaining loaders run sequentially in configured order.
5. AI request is sent using merged prompt text and collected files.
6. Temp files created by loaders are cleaned up after processing.

Notes:

- Immediate loaders are skipped during main loader pass if already pre-processed.
- If immediate starts are paused (`pause immediate`), immediate pre-processing is deferred.
- If a queued item is canceled after immediate pre-processing started, temp files are cleaned once the immediate work resolves.

### Loader Type: Camera

Purpose: capture one or more images from a configured camera source.

- `source`: camera key under `cameras` in `config.yaml`.
- `options.captures` (default `1`): number of captures.
- `options.interval` (default `1000` ms): delay between captures.
- `options.output` (default `false`): publish captured image bytes to LOADER topics.

Behavior:

- Supports camera config as a plain URL string or object (`url`, `username`, `password`/`password_file`).
- Produces file attachments (image paths) for AI input.
- Updates loader timing stats for capture durations.

### Loader Type: URL

Purpose: download remote content and attach it as a file.

- `source`: URL to fetch.

Behavior:

- Downloads response body to a temp file (binary-safe).
- Tracks HTTP status code, file size, and download duration in stats.
- Always contributes as a file attachment (no inline mode for URL loader).

### Loader Type: MQTT

Purpose: fetch one message from a topic and attach inline or as file.

- `source`: topic name.
  - If it already starts with `<basetopic>`, it is used as-is.
  - Otherwise it is prefixed as `<basetopic>/<source>`.
- `options.timeout` (default `5000` ms): wait timeout for first message.
- `options.attach` (default `inline`): `inline` or file mode.
- `options.output` (default `false`): publish fetched MQTT payload bytes to LOADER topics.

Behavior:

- Subscribes, waits for first message, then unsubscribes.
- For text payloads:
  - `attach: inline` appends topic content to prompt text.
  - File mode writes a temp text file and attaches it.
- For binary payloads:
  - `attach: inline` appends base64 text to prompt.
  - File mode writes binary to temp file; extension is inferred when possible.

### Loader Type: Database

Purpose: run a MariaDB query and attach results inline or as CSV.

- `source`: database key under `databases` in `config.yaml`.
- `options.query` (required): SQL query text.
- `options.attach` (default `csv`): `csv` or `inline`.
- `options.output` (default `false`): publish CSV result bytes to LOADER topics.

Behavior:

- Supports database type `mariadb`.
- Uses `password` or `password_file` from database config.
- Query results are converted to CSV.
  - `attach: csv` writes CSV to temp file and attaches it.
  - `attach: inline` appends CSV text to prompt.
- Updates database loader stats (query duration and row count).

### Error Handling

- Unknown loader sources or missing required options (for example database `query`) fail the current request.
- A failing loader aborts payload processing; AI submission does not continue.
- Errors are logged and reflected in status/error metrics when a primary camera context is available.

### Temp Files and Cleanup

- Camera captures, URL downloads, MQTT file attachments, and database CSV outputs are created as temp files.
- After AI processing, temp files are cleaned automatically.
- Canceled queued entries with in-flight immediate loaders schedule cleanup when that immediate work completes.

### Example Loader Config

```yaml
tasks:
  gate_motion:
    ai: openai
    prompt:
      text: Analyze current state and summarize.
      loader:
        - type: camera
          source: gate
          immediate: true
          options:
            captures: 3
            interval: 1500
            output: true

        - type: url
          source: https://example.com/context.pdf

        - type: mqtt
          source: sensors/temperature
          options:
            attach: inline
            timeout: 3000
            output: true

        - type: database
          source: main
          options:
            query: SELECT ts, value FROM metrics ORDER BY ts DESC LIMIT 50
            attach: csv
            output: true
```

## Topic Routing

If an INPUT payload contains `topic`, output/telemetry are routed to subtopics:

- `OUTPUT/<topic>`
- `OUTPUT/<topic>/LOADER/...` (when loader `options.output: true`)
- `PROGRESS/<topic>`
- `STATS/<topic>`

Validation notes:

- Wildcards/control characters are rejected.
- Invalid topic falls back to base topics.
- Topic segments are sanitized; `/` hierarchy is preserved.

## Prompt and Template Rules

- Request must provide `prompt.template` and/or `prompt.text`.
- Unknown template without fallback text is rejected.
- If template contains `{{prompt}}`, inline text is injected; otherwise appended.
- Template chaining is supported with `prompt.template` as string array.

### Structured Output Merge in Template Chains

When chaining templates:

- Output schemas are merged across templates.
- Duplicate property definitions are last-wins (rightmost template wins).
- Nested object properties merge recursively with same precedence.
- Inline `prompt.output` in INPUT overrides template-derived schema.

## Configuration

Create `config.yaml` (copy from `config.yaml.sample`) with these sections:

- `mqtt`
- `ai`
- `cameras`
- `prompts`
- `tasks`
- `databases` (optional)

### Minimal Example

```yaml
mqtt:
  server: mqtt.example.local
  port: 1883
  basetopic: mqttai
  loader_publish: 0
  username: mqttuser
  password_file: /run/secrets/mqtt_password
  client: mqtt-ai-tool

ai:
  openai:
    endpoint: https://api.openai.com/v1/chat/completions
    token_file: /run/secrets/openai_token
    model: gpt-4-vision-preview

cameras:
  garage: rtsp://user:pass@camera/stream
  gate:
    url: rtsp://192.168.1.50:554/stream1
    username: user
    password_file: /run/secrets/gate_cam_password

prompts:
  gate_prompt:
    ai: openai
    prompt: |
      Describe the gate image and determine whether it is open.
    output:
      GateOpen:
        type: string
        enum: ["Yes", "No", "Unknown"]

tasks:
  garage_check:
    ai: openai
    queue: false
    topic: garage/monitoring
    prompt:
      template: gate_prompt
      loader:
        - type: camera
          source: garage
          options:
            captures: 1

  gate_motion:
    ai: openai
    topic: gate/security
    prompt:
      template: gate_prompt
      loader:
        - type: camera
          source: gate
          immediate: true
          options:
            captures: 5
            interval: 2000

databases:
  main:
    type: mariadb
    server: 192.168.1.10
    port: 3306
    username: dbuser
    password_file: /run/secrets/db_password
    database: exampledb
```

## Home Assistant / OpenHAB Discovery

Enable with:

- `mqtt.homeassistant` (optional, default `homeassistant`)
- `task.ha: true` per task

Behavior summary:

- Discovery payloads are published retained on MQTT connect.
- `state_topic` points at task output topic.
- Availability uses `<basetopic>/ONLINE` with `YES`/`NO`.
- Structured object wrappers are exposed as child entities (for example `.Value`, `.Confidence`, `.BestGuess`, `.Reasoning`).

## Run and Deploy

### Prerequisites

- Node.js 18+
- FFmpeg
- MQTT broker
- AI endpoint/model that supports your media inputs

### Local Run

```bash
npm install
cp config.yaml.sample config.yaml
npm start
```

Debug logging:

```bash
LOG_LEVEL=debug npm start
```

### Docker

```bash
docker run -d \
  --name mqtt-ai-tool \
  -v /path/to/config.yaml:/usr/src/app/config.yaml \
  kosdk/mqtt-ai-tool:latest
```

Docker with explicit config path:

```bash
docker run -d \
  --name mqtt-ai-tool \
  -e CONFIG_FILE=/usr/src/app/config/custom-config.yaml \
  -e LOG_LEVEL=debug \
  -v /path/to/config.yaml:/usr/src/app/config/custom-config.yaml \
  kosdk/mqtt-ai-tool:latest
```

## Example MQTT Commands

### Task-based INPUT

```bash
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"task":"garage_check","tag":"check-001"}'
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"task":"gate_motion","tag":"urgent-alert","queue":false}'
```

### Inline Loader INPUT

```bash
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"tag":"db1","prompt":{"text":"Analyze DB results","loader":[{"type":"database","source":"main","options":{"query":"SELECT * FROM metrics LIMIT 50","attach":"csv"}}]}}'
```

```bash
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"tag":"mqtt-inline","prompt":{"text":"Include recent sensor reading","loader":[{"type":"mqtt","source":"sensors/temperature","options":{"attach":"inline","timeout":3000}}]}}'
```

### CONTROL Publish Examples

```bash
mosquitto_pub -h mqtt-server -r false -t "mqttai/CONTROL" -m "pause 30"
mosquitto_pub -h mqtt-server -r false -t "mqttai/CONTROL" -m "pause 30 immediate"
mosquitto_pub -h mqtt-server -r false -t "mqttai/CONTROL" -m "cancel index 1"
mosquitto_pub -h mqtt-server -r false -t "mqttai/CONTROL" -m '{"cmd":"cancel","param":"tag","name":["front door","garage"]}'
mosquitto_pub -h mqtt-server -r false -t "mqttai/CONTROL" -m "resume"
```

### Monitor Topics

```bash
mosquitto_sub -h mqtt-server -t "mqttai/OUTPUT" -v
mosquitto_sub -h mqtt-server -t "mqttai/PROGRESS" -v
mosquitto_sub -h mqtt-server -t "mqttai/STATS" -v
mosquitto_sub -h mqtt-server -t "mqttai/QUEUED" -v
mosquitto_sub -h mqtt-server -t "mqttai/RUNNING" -v
mosquitto_sub -h mqtt-server -t "mqttai/IMMEDIATE" -v
mosquitto_sub -h mqtt-server -t "mqttai/PAUSE" -v
```

## Monitoring and Troubleshooting

### Environment Variables

- `LOG_LEVEL`: `error`, `warn`, `info`, `debug`, `verbose`, `silly`
- `CONFIG_FILE`: config path override (useful in containerized deployments)
- `MQTT_AI_CONFIG_RELOAD`: set to `true` to enable debounced config file watch reloads

### Common Issues

- MQTT connection/auth failures: verify broker host, port, credentials, ACLs.
- Camera capture failures: validate RTSP URL and credentials.
- AI request failures/timeouts: verify endpoint/token/model and increase upstream timeout if needed.
- Slow runs with multi-image capture: tune `captures` and `interval`.

### Performance Notes

- Total capture time grows with `(captures - 1) * interval`.
- AI latency usually dominates end-to-end time for large payloads.
- `STATS` provides per-loader and total timing to guide tuning.

## Development

Run tests:

```bash
npm test
```

## License

BSD 3-Clause. See [LICENSE](LICENSE).

## Support

- Check logs first.
- Watch `PROGRESS` for live status and `STATS` for metrics.

## Note

This project was vibe coded on Raptor Mini and GPT-5.3-Codex High.
