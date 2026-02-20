# MQTT AI Tool

A flexible tool to submit files, camera captures, MQTT messages, or database extracts to AI backends for automated analysis.

## Overview

The MQTT AI Tool is a TypeScript/Node.js application that listens for JSON `INPUT` requests over MQTT and processes arbitrary files, RTSP camera captures, MQTT topic messages, and database extracts through configurable AI backends (OpenAI-compatible by default). It supports multi-file and multi-image capture for temporal analysis, CSV/inline database attachments, and both inline or file attachments from MQTT topics.

## Features

- **Single INPUT topic**: Submit JSON requests to `<basetopic>/INPUT`; requests are queued and processed sequentially.
- **Multiple loaders**: Camera, URL, File, MQTT topic, and Database (MariaDB) loaders are supported.
- **Flexible attachments**: Attach files, embed data inline, or attach CSV exports of query results.
- **RTSP Camera Support**: Capture high-quality images using FFmpeg when requested by a loader.
- **AI Backends**: Send attached files and prompts to configurable AI backends (OpenAI-compatible by default).
- **Real-time progress & metrics**: Live processing updates are published to `<basetopic>/PROGRESS`; performance and historical metrics go to `<basetopic>/STATS`.
- **Queue visibility**: `<basetopic>/QUEUED` publishes the current queue size (retained).
- **Graceful operation**: Automatic cleanup, LWT `ONLINE`/`OFFLINE` status on `<basetopic>/ONLINE`, and graceful shutdown handling.
- **Docker-friendly**: Works well in containers and supports secret-mounted password files for credentials.
- **Structured responses**: Optional JSON schema-based responses provide consistent outputs.

## How it Works

### MQTT Topic Structure

The application uses a simplified global topic set under the base topic:

- **`<basetopic>/INPUT`** - Accepts a JSON object to request analysis (see format below)
- **`<basetopic>/OUTPUT`** - Returns JSON objects with the AI result for each processed request (base `OUTPUT` is not retained; per-request runtime responses are published non‑retained).
- **`<basetopic>/PROGRESS`** - Plain text status updates during processing (format: `"cameraName: status"` or just `"status"`). Retained.
- **`<basetopic>/STATS`** - JSON object with performance and historical metrics (includes `camera` and `stats` fields). Retained.
- **`<basetopic>/QUEUED`** - Plain text number indicating how many INPUT requests are queued. Retained.
- **`<basetopic>/ONLINE`** - Indicates service status: `"YES"` when online, `"NO"` when offline (Last Will and Testament). Retained.

## Database configuration

You can declare database connections (MariaDB only) in `config.yaml` under a `databases` section:

```yaml
databases:
  main:
    type: mariadb
    server: 192.168.1.10
    port: 3306
    username: dbuser
    password_file: /run/secrets/db_password
    database: exampledb
```

AI backend example showing `token_file` option (Docker secret):

```yaml
ai:
  openai:
    endpoint: https://api.openai.com/v1/chat/completions
    token_file: /run/secrets/openai_token
    model: "gpt-4-vision-preview"
```

MQTT configuration example (supports `password_file` for Docker secrets):

```yaml
mqtt:
  server: mqtt.example.local
  port: 1883
  basetopic: mqttai
  username: mqttuser
  password_file: /run/secrets/mqtt_password
  client: mqtt-ai-tool
```

Camera config examples (simple string or expanded object):

```yaml
cameras:
  # simple string form:
  garage: rtsp://user:pass@camera/stream

  # expanded form with secrets:
  gate:
    url: rtsp://192.168.1.50:554/stream1
    username: user
    password_file: /run/secrets/gate_cam_password
```

Database loader example in `INPUT` JSON:

```json
{
  "tag": "db-query-1",
  "prompt": {
    "text": "Please analyze the attached CSV data",
    "loader": [
      {
        "type": "database",
        "source": "main",
        "options": {
            "query": "SELECT id, name, value FROM metrics ORDER BY timestamp DESC LIMIT 100",
            "attach": "csv"  // "csv" (default) or "inline"
        }
      }
    ]
  }
}
```

- `attach: "csv"` will convert the query result to a CSV file and attach it to the AI request
- `attach: "inline"` will append the CSV-formatted results into the prompt text itself


MQTT loader example in `INPUT` JSON:

```json
{
  "tag": "mqtt-sample",
  "prompt": {
    "text": "Please analyze or summarize the following data",
    "loader": [
      {
        "type": "mqtt",
        "source": "sensors/temperature",
        "options": {
            "attach": "inline",
            "timeout": 5000
        }
      }
    ]
  }
}
```

- `source` can be a full MQTT topic or a topic relative to the configured `basetopic` (e.g., `sensors/temperature` -> `mqttai/sensors/temperature`).
- `attach` options: `inline` (append textual payload to the prompt), `file` (save the payload to a temp file and attach it), or `image` (if the payload is a binary image it will be saved and attached as an image file). `file` works for binary or text payloads.
- `timeout` controls how long (ms) to wait for a message on the specified topic (default 5000ms).

> Note: Per-camera trigger topics have been removed. Use the global `<basetopic>/INPUT` format and reference `cameras` from the `config.yaml` via loader entries.

### INPUT JSON format (example)

#### Using Task Templates (Recommended for Repetitive Tasks)

To avoid repeating the same JSON configuration for common tasks, you can define **task templates** in your `config.yaml`:

```yaml
tasks:
  garage_check:
    ai: openai
    topic: garage/monitoring
    prompt:
      template: garage_prompt
      loader:
        - type: camera
          source: garage
          options:
            captures: 1

  gate_motion:
    ai: openai
    topic: gate/security
    prompt:
      template: gate_motion_prompt
      loader:
        - type: camera
          source: gate
          options:
            captures: 5
            interval: 2000

  # Task with multiple template chaining
  comprehensive_check:
    ai: openai
    topic: monitoring/comprehensive
    prompt:
      template: ["gate_prompt", "garage_prompt"]
      text: "Provide a combined analysis of both locations"
      loader:
        - type: camera
          source: gate
        - type: camera
          source: garage

  daily_report:
    ai: openai
    prompt:
      text: "Generate a daily report based on the data"
      loader:
        - type: database
          source: main
          options:
            query: "SELECT * FROM events WHERE date = CURDATE()"
            attach: csv
```

Then your INPUT becomes much simpler:

```json
{
    "task": "garage_check",
    "tag": "check-001"
}
```

You can also override any task fields in the INPUT:

```json
{
    "task": "gate_motion",
    "tag": "motion-alert",
    "topic": "gate/alerts/urgent"
}
```

**Task Template Fields:**

- **`ai`** (optional) - AI backend to use for this task
- **`topic`** (optional) - Default topic routing for this task's outputs
- **`prompt`** (required) - Prompt configuration including:
  - `template` - Single template name or array of template names for chaining (e.g., `["template1", "template2"]`)
  - `text` - Inline prompt text
  - `output` - Structured output schema (old-style shorthand). When `prompt.template` is an array, `output`/`response_format` from each template are **merged** (union of properties) into a single `response_format` that will be sent to the AI; duplicate property definitions follow **last‑wins** (the rightmost template overrides). An inline `prompt.output` in the INPUT will always override template-defined schemas.
  - `loader` - Array of loader configurations

**INPUT with Task Reference:**

- **`task`** (required) - Name of task template from config
- **`tag`** (optional) - Request identifier
- **`topic`** (optional) - Override task's default topic
- **`ai`** (optional) - Override task's AI backend
- **`prompt`** (optional) - Override any prompt fields from the task template

#### Standard INPUT JSON Format (Full Specification)

```json
{
    "tag": "my-request-123",
    "topic": "gate/security",
    "ai": "openai",
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

**Fields:**

- **`tag`** (optional) - Identifier for this request; returned in OUTPUT for correlation
- **`topic`** (optional) - Custom subtopic for OUTPUT/PROGRESS/STATS routing (e.g., `"gate/security"`)
- **`ai`** (optional) - Name of AI backend from config; defaults to first configured backend
- **`prompt.template`** (optional) - Name of prompt template from config
- **`prompt.text`** (optional) - Inline prompt text; injected into template's `{{prompt}}` placeholder or appended
- **`prompt.output`** (optional) - Inline JSON schema for structured responses
- **`prompt.files`** (optional) - Array of local file paths to attach
- **`prompt.loader`** (optional) - Array of loader objects (camera, url, file, mqtt, database)

#### OUTPUT JSON (returned on `<basetopic>/OUTPUT`)

```json
{
    "tag": "my-request-123",
    "time": 4.12,
    "model": "gpt-4-vision-preview",
    "text": "(any return text from the AI)",
    "json": { /* the structured output object from the model (if available), otherwise null */ }
}
```

### Topic Routing

If an INPUT contains an optional `topic` property, the response and progress updates will be published to sub-topics instead of the base topics:

- **OUTPUT**: `<basetopic>/OUTPUT/<topic>` instead of `<basetopic>/OUTPUT`
- **PROGRESS**: `<basetopic>/PROGRESS/<topic>` instead of `<basetopic>/PROGRESS`
- **STATS**: `<basetopic>/STATS/<topic>` instead of `<basetopic>/STATS`

The `topic` value is validated (wildcards and control characters are disallowed) and may include `/` separators for hierarchical subtopics. If invalid, all three topics will fall back to their base paths and a warning will be logged.

**Examples of valid and invalid `topic` values:**

```text
# Valid - simple subtopic preserved:
topic = "BACKYARD/SECURITY"
  -> OUTPUT:   <basetopic>/OUTPUT/BACKYARD/SECURITY
  -> PROGRESS: <basetopic>/PROGRESS/BACKYARD/SECURITY
  -> STATS:    <basetopic>/STATS/BACKYARD/SECURITY

# Valid - colons inside a segment are replaced with underscores:
topic = "Back/yard:weird"
  -> OUTPUT:   <basetopic>/OUTPUT/Back/yard_weird
  -> PROGRESS: <basetopic>/PROGRESS/Back/yard_weird
  -> STATS:    <basetopic>/STATS/Back/yard_weird

# Invalid - wildcards not allowed (falls back to base topics):
topic = "Bad/+/Topic"
  -> OUTPUT:   <basetopic>/OUTPUT
  -> PROGRESS: <basetopic>/PROGRESS
  -> STATS:    <basetopic>/STATS
  (warning logged)
```

Use slashes to create subtopics; each segment will be sanitized (whitespace → underscore, unsafe characters replaced), but `/` will be preserved to allow hierarchical subtopics.

This feature is useful for organizing multiple concurrent workflows or separating different logical processing streams.

### Prompt rules

- Requests must include a `prompt` object that contains either `prompt.template` **or** `prompt.text` (or both). Requests missing both will be ignored and an error message will be published to `<basetopic>/OUTPUT` with the same `tag`.
- If `prompt.template` is present but not found in `config.prompts` and no `prompt.text` is provided, the request will be ignored and an error published to `<basetopic>/OUTPUT`.
- When both `prompt.template` and `prompt.text` are provided, `prompt.text` will be injected into a `{{prompt}}` placeholder in the template if present; otherwise it will be appended to the template separated by a blank line.
- `prompt.template` may also be an array of template names (e.g., `"template": ["t1","t2"]`). Templates are concatenated in order: the later templates are inserted into earlier ones using a `{{template}}` placeholder if present; otherwise they are appended. Templates are processed left-to-right so `t1` is the outermost template. Placeholders `{{template}}` and `{{prompt}}` may appear multiple times and will be replaced at every occurrence.

#### Template chaining — structured output merging

- When multiple templates are chained the prompt *text* composition behavior is unchanged (the later/inner templates are embedded into earlier/outer templates). For structured outputs, however, the runtime now **merges** `output`/`response_format` definitions from every template in the chain into a single schema that is sent to the AI.
- Merge rules (summary):
  - Properties are combined (union) across templates.
  - `required` is the union but follows the **last‑wins** policy for properties that are redefined later in the chain.
  - If the same property is defined more than once, the definition from the **rightmost** (last) template in the array **overrides** earlier definitions.
  - Nested object properties are merged recursively with the same last‑wins rule.
  - If a template uses a non-`json_schema` response_format or incompatible types are encountered, the rightmost template's response_format is used for that branch (last‑wins fallback).
- Precedence: inline `prompt.output` provided in the INPUT always overrides the merged template schema (inline wins highest).

Example: chaining `["status","status-driveway"]` will produce a merged `response_format` containing the timestamp/summary fields from `status` plus the driveway-specific observables from `status-driveway`; if both templates define the same observable, the `status-driveway` definition (rightmost) takes precedence.

### Home Assistant / OpenHAB MQTT discovery

- You can automatically expose task outputs to Home Assistant (and OpenHAB which supports the same discovery format) using MQTT discovery.
- Configuration:
  - `mqtt.homeassistant` (optional, default: `homeassistant`) — discovery prefix/topic.
  - `task.ha` (optional, default: `false`) — opt-in per task to publish discovery entries.
- Behavior:
  - When the MQTT client connects the app will publish Home Assistant discovery messages for every task with `ha: true`.
  - Discovery messages are published retained under `<mqtt.homeassistant>/<entity_domain>/<object_id>/config` so Home Assistant/OpenHAB can auto-discover entities.
  - Each discovered entity uses `state_topic` = `<basetopic>/OUTPUT/<task.topic>` (sanitized). For `object`-typed outputs we do **not** publish the object itself as a single HA entity; instead each child property is published as its own entity using dotted names (for example: `<Task> <Property>.Value`, `<Task> <Property>.Confidence`, `<Task> <Property>.BestGuess`). The `Value` child will be mapped according to its declared type and the full object remains available in `json_attributes_topic`.
- How detection works: the discovery generator reads the merged `response_format` (templates + task `prompt.output`) and exposes top-level keys as appropriate HA entities based on output type.

Supported mappings (structured output → Home Assistant discovery domain):

- String  → `text`
- Number  → `number`
- Integer → `number`
- Boolean → `binary_sensor` (maps Yes/No/true/false → ON/OFF)
- Array   → `sensor` (state = length; full array in attributes)
- Enum    → `sensor` (discovery includes `options`)
- Object  → `sensor` (state = `.Value`, full object in attributes)

Example (enable discovery for a task):

```yaml
mqtt:
  homeassistant: homeassistant

tasks:
  status-driveway:
    ha: true
    topic: status/driveway
    prompt:
      template: ["status", "status-driveway"]
```

- Discovery is published automatically on MQTT connect; you can also call the exported `publishHaDiscovery()` function to re-publish discovery at runtime.



### Progress Status Values

The `/PROGRESS` topic provides real-time plain text status updates during processing. The format is `"cameraName: status"` when a camera is involved, or just `"status"` for non-camera operations. The `/STATS` topic contains performance metrics and historical stats in JSON format.

- **`"Idle"`** - Ready to process INPUT requests
- **`"Starting capture"`** - Beginning data capture process
- **`"Capturing"`** - Individual capture in progress
- **`"Waiting for next capture"`** - Interval delay between captures
- **`"Processing with AI"`** - Sending to AI service for analysis
- **`"Publishing response"`** - Publishing AI results to `<basetopic>/OUTPUT`
- **`"Cleaning up"`** - Removing temporary files
- **`"Complete"`** - Successfully finished processing
- **`"Error"`** - Error occurred during processing
- **`"Offline"`** - Service shutting down

### Statistics Format

The `/STATS` topic publishes a JSON object with performance metrics:

```json
{
    "camera": "gate",
    "stats": {
        "lastErrorDate": "2023-01-01T12:00:00.000Z",
        "lastErrorType": "Connection timeout",
        "lastSuccessDate": "2023-01-01T12:05:00.000Z",
        "lastAiProcessTime": 2.5,
        "lastTotalProcessTime": 8.2,
        "loader": {
            "camera": {
                "gate": {
                    "lastCaptureTime": 0.8,
                    "lastTotalCaptureTime": 5.2
                }
            },
            "url": {
                "1": {
                    "lastDownloadTime": 1.5,
                    "lastHTTPCode": 200,
                    "lastFileSize": 2048576
                }
            },
            "database": {
                "main": {
                    "1": {
                        "lastQueryTime": 0.3,
                        "lastQueryRows": 42
                    }
                }
            }
        }
    }
}
```

**Statistics Properties:**

- **`camera`** - Name of the camera or source (present when a camera loader is used)
- **`stats.lastErrorDate`** - ISO timestamp of most recent error (including AI errors)
- **`stats.lastErrorType`** - Description of the last error that occurred
- **`stats.lastSuccessDate`** - ISO timestamp of most recent successful processing
- **`stats.lastAiProcessTime`** - Time in seconds for AI processing only
- **`stats.lastTotalProcessTime`** - Total time in seconds from INPUT reception to completion

**Loader-Specific Statistics:**

- **`stats.loader.camera.<source>.lastCaptureTime`** - Average time in seconds per single image capture (excluding intervals between captures)
- **`stats.loader.camera.<source>.lastTotalCaptureTime`** - Total time in seconds from first capture start to last capture finish (including intervals)
- **`stats.loader.url.<index>.lastDownloadTime`** - Time in seconds to download the URL
- **`stats.loader.url.<index>.lastHTTPCode`** - HTTP response code (e.g., 200, 404, 500)
- **`stats.loader.url.<index>.lastFileSize`** - Downloaded file size in bytes
- **`stats.loader.database.<source>.<index>.lastQueryTime`** - Time in seconds to execute the database query
- **`stats.loader.database.<source>.<index>.lastQueryRows`** - Number of rows returned by the query

**Note about `<index>`:** The index is 1-based and specific to each loader type (not the overall array index). For example, if you have 3 URL loaders and 2 database loaders in your INPUT, they will be indexed as url/1, url/2, url/3 and database/source/1, database/source/2 respectively.

### Multiple Loaders and Cameras

**Sequential Processing:** When an INPUT contains multiple loaders (including multiple camera loaders), they are processed **sequentially** (one after another), not in parallel. This ensures predictable resource usage and clear progress tracking.

**Progress Updates:** During multi-loader processing:

- PROGRESS shows which loader is currently being processed (e.g., `"Processing loader 2 of 5 (camera)"`)
- When a camera loader is active, the status includes the camera name (e.g., `"gate: Capturing (3 of 5)"`)
- For non-camera loaders without a primary camera, generic status is shown (e.g., `"Fetching URL 2 of 3"`)

**Statistics Tracking:** Each loader's metrics are tracked independently and can be reviewed in the STATS topic after processing completes.

### Workflow

1. **Initialization**: Application connects to MQTT broker, publishes `ONLINE: YES`, and initializes base channels.
2. **Trigger**: Publish a JSON request to `<basetopic>/INPUT` to start analysis (see INPUT format). Requests without a valid prompt are skipped and an error published to `<basetopic>/OUTPUT`.
3. **Progress**: Live status updates are published to `<basetopic>/PROGRESS` as plain text (e.g., `"garage: Capturing"` or just `"Processing with AI"`). Use `<basetopic>/STATS` for performance and historical metrics in JSON format.
4. **Image Capture**: Application captures one or multiple high-quality images from RTSP camera (if requested by loaders).
5. **AI Processing**: Captured files and loader data are sent to the configured AI backend together with the resolved prompt.
6. **Result Publishing**: AI outputs (structured object if available) are published to `<basetopic>/OUTPUT`.
7. **Statistics Update**: Performance metrics (times and last success/error) are published to `<basetopic>/STATS`.
8. **Queued / Reset**: There is no per-camera reset; the queue length is reflected on `<basetopic>/QUEUED` and completed requests are returned via `<basetopic>/OUTPUT`.
9. **Cleanup**: All temporary files are deleted automatically after processing.

### Multi-Image Capture

The application supports capturing multiple sequential images to provide AI with temporal context for motion detection and analysis:

- **Single Image Mode** (default): Traditional single snapshot capture
- **Multi-Image Mode**: Capture 2-10+ sequential images with configurable intervals
- **AI Context**: Multiple images are sent in chronological order with enhanced prompts
- **Motion Analysis**: AI can detect movement, direction, and changes across the sequence
- **Progress Tracking**: Status updates show capture progress (e.g., "Taking snapshot 3/5")

## Installation & Setup

### Prerequisites

- Node.js 18+ (for bare metal installation)
- FFmpeg (for camera image capture)
- MQTT broker
- OpenAI-compatible API endpoint with vision support

## Configuration

Create a `config.yaml` file based on the provided `config.yaml.sample`. The configuration has four primary sections:

- **`ai`**: Map of AI backends (name -> endpoint, token, type, default model)
- **`cameras`**: Map of camera names to RTSP endpoints (simple name -> endpoint mapping)
- **`prompts`**: Decoupled prompts which reference an `ai` backend and optionally override the model; prompts may include `output` to declare a JSON schema for structured responses
- **`tasks`**: Pre-configured task templates that combine prompts with loaders, reducing repetitive JSON in INPUT requests

### `ai` Example

```yaml
ai:
  openai:
    endpoint: https://api.openai.com/v1/chat/completions
    token: your-api-token
    type: openai
    model: "gpt-4-vision-preview"
```

### `cameras` Example

```yaml
cameras:
  gate: rtsp://user:pass@192.168.1.50:554/stream1
  driveway: rtsp://user:pass@192.168.1.53:554/stream1
```

### `prompts` Example

```yaml
prompts:
  gate_prompt:
    ai: openai
    prompt: |
      Describe the gate image and detect whether the gate is open. Also indicate visibility as Good/Poor/Unknown.
    output:
      GateOpen:
        type: string
        enum: ["Yes", "No", "Unknown"]
```

### `tasks` Example

```yaml
tasks:
  garage_check:
    ai: openai
    topic: garage/monitoring
    prompt:
      template: garage_prompt
      loader:
        - type: camera
          source: garage
          options:
            captures: 1

  gate_motion:
    ai: openai
    topic: gate/security
    prompt:
      template: gate_motion_prompt
      loader:
        - type: camera
          source: gate
          options:
            captures: 5
            interval: 2000

  daily_report:
    ai: openai
    prompt:
      text: "Generate a comprehensive daily report"
      loader:
        - type: database
          source: main
          options:
            query: "SELECT * FROM events WHERE date = CURDATE()"
            attach: csv
        - type: url
          source: "https://api.example.com/weather"
```

Note: Capture counts and intervals are provided via the INPUT `loader` entries or in task templates.

## Deployment Options

### Bare Metal

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Place your config file:**

   ```bash
   cp config.yaml.sample config.yaml
   # Edit config.yaml with your settings
   ```

3. **Run the application:**

   ```bash
   npm start

   # With debug logging
   LOG_LEVEL=debug npm start
   ```

### Docker

#### Using Pre-built Image

```bash
docker run -d \
  --name mqtt-ai-tool \
  -v /path/to/your/config.yaml:/usr/src/app/config.yaml \
  kosdk/mqtt-ai-tool:latest
```

#### Using Custom Config Location (Docker)

```bash
docker run -d \
  --name mqtt-ai-tool \
  -e CONFIG_FILE=/app/config/custom-config.yaml \
  -e LOG_LEVEL=debug \
  -v /path/to/your/config.yaml:/app/config/custom-config.yaml \
  kosdk/mqtt-ai-tool:latest
```

#### Docker Compose Example

```yaml
version: '3.8'
services:
  mqtt-ai-tool:
    image: kosdk/mqtt-ai-tool:latest
    container_name: mqtt-ai-tool
    environment:
      - CONFIG_FILE=/app/config/config.yaml
      - LOG_LEVEL=info
    volumes:
      - ./config.yaml:/app/config/config.yaml
    restart: unless-stopped
```

## Usage Examples

### Examples

#### Using Task Templates (Simplified)

```bash
# Simple task reference - uses all defaults from task config
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"task":"garage_check","tag":"check-001"}'

# Task reference with topic override
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"task":"gate_motion","tag":"motion-alert","topic":"gate/alerts/urgent"}'

# Task reference with AI backend override
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"task":"daily_report","tag":"report-001","ai":"openai-gpt4"}'
```

#### Camera loader (single image)

```bash
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"tag":"req1","prompt":{"template":"garage_prompt","loader":[{"type":"camera","source":"garage","options":{"captures":1}}]}}'
```

#### Camera loader with topic routing

```bash
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"tag":"gate-check","topic":"gate/security","prompt":{"template":"gate_prompt","loader":[{"type":"camera","source":"gate","options":{"captures":1}}]}}'
# This will publish results to:
# - mqttai/OUTPUT/gate/security
# - mqttai/PROGRESS/gate/security (during processing)
# - mqttai/STATS/gate/security (on completion)
```

#### Camera loader (multi-image)

```bash
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"tag":"driveway-motion","prompt":{"template":"driveway_motion","loader":[{"type":"camera","source":"driveway","options":{"captures":5,"interval":3000}}]}}'
```

#### URL loader

```bash
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"tag":"file-1","prompt":{"text":"Analyze this file","loader":[{"type":"url","source":"https://example.com/report.pdf"}]}}'
```

#### Database loader (CSV attach)

```bash
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"tag":"db1","prompt":{"text":"Analyze DB results","loader":[{"type":"database","source":"main","options":{"query":"SELECT * FROM metrics LIMIT 50","attach":"csv"}}]}}'
```

#### Database loader (inline)

```bash
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"tag":"db-inline","prompt":{"text":"Summarize these rows","loader":[{"type":"database","source":"main","options":{"query":"SELECT id,value FROM metrics ORDER BY timestamp DESC LIMIT 20","attach":"inline"}}]}}'
```

#### MQTT loader (inline text)

```bash
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"tag":"mqtt-inline","prompt":{"text":"Include recent sensor reading","loader":[{"type":"mqtt","source":"sensors/temperature","options":{"attach":"inline","timeout":3000}}]}}'
```

#### MQTT loader (attach as file)

```bash
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"tag":"mqtt-file","prompt":{"text":"Attach latest topic payload","loader":[{"type":"mqtt","source":"sensors/data","options":{"attach":"file"}}]}}'
```

#### MQTT loader (image)

```bash
# Publish an image to the topic first (binary payload)
# Then request it via loader (attach as image file)
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"tag":"mqtt-image","prompt":{"text":"Analyze image from topic","loader":[{"type":"mqtt","source":"cameras/front/image","options":{"attach":"image","timeout":5000}}]}}'
```

#### Multiple loaders (combining camera, URL, and database)

```bash
# This example shows multiple loaders in a single INPUT request
# Loaders are processed sequentially: camera -> URL -> database
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"tag":"comprehensive-analysis","prompt":{"text":"Analyze the camera image along with the PDF report and recent database records","loader":[{"type":"camera","source":"gate","options":{"captures":1}},{"type":"url","source":"https://example.com/report.pdf"},{"type":"database","source":"main","options":{"query":"SELECT * FROM events WHERE date > NOW() - INTERVAL 24 HOUR","attach":"csv"}}]}}'
# STATS will include: loader.camera.gate, loader.url.1, and loader.database.main.1
```

### Monitor results and queue

```bash
mosquitto_sub -h mqtt-server -t "mqttai/OUTPUT" -v
mosquitto_sub -h mqtt-server -t "mqttai/QUEUED" -v
mosquitto_sub -h mqtt-server -t "mqttai/STATS" -v
mosquitto_sub -h mqtt-server -t "mqttai/PROGRESS" -v
```

## Multi-Image Capture Benefits

### Motion Detection

- **Direction Analysis**: Detect people/vehicles entering or leaving
- **Speed Estimation**: Understand movement speed across frames
- **Path Tracking**: Follow object movement through the scene

### Context Understanding

- **Activity Patterns**: Understand what happened over time
- **Change Detection**: Identify what changed between frames
- **Event Sequencing**: Understand the order of events

### Use Cases

- **Security Monitoring**: Detect intrusions with movement context
- **Traffic Analysis**: Monitor vehicle flow and parking changes
- **Wildlife Observation**: Track animal behavior over time
- **Package Delivery**: Detect delivery events with full context

## Monitoring & Troubleshooting

### Environment Variables

- **`LOG_LEVEL`**: Controls logging verbosity
  - `error`: Only errors
  - `warn`: Warnings and errors
  - `info`: Info, warnings, and errors (default)
  - `debug`: Debug, info, warnings, and errors
  - `verbose`: Very detailed logging
  - `silly`: Everything
- **`CONFIG_FILE`**: Custom config file path (Docker only)

### Log Files

- **Console output**: Real-time application logs
- **error.log**: Error-level logs only
- **combined.log**: All log levels

### Performance Monitoring

Use the `<basetopic>/STATS` topic to monitor performance and historical metrics; subscribe to `<basetopic>/PROGRESS` for live status updates:

```bash
# Subscribe to PROGRESS for live status updates and STATS for performance metrics
mosquitto_sub -h mqtt-server -t "mqttai/PROGRESS" -v
mosquitto_sub -h mqtt-server -t "mqttai/STATS" -v

# Example PROGRESS update (plain text):
garage: Capturing

# Example PROGRESS update (no camera):
Processing with AI

# Example STATS update (JSON):
{
  "camera": "garage",
  "stats": {
    "lastSuccessDate": "2023-10-15T14:30:25.123Z",
    "lastAiProcessTime": 3.2,
    "lastTotalProcessTime": 12.8
  }
}
```

### Common Issues

- **MQTT Connection**: Check server address, credentials, and network connectivity
- **Camera Access**: Verify RTSP URLs and camera credentials
- **AI API**: Confirm endpoint URL, API token, and model supports vision
- **Multi-Image Timeouts**: Increase AI timeout for multiple image processing
- **Disk Space**: Ensure adequate space for temporary image files
- **Memory Usage**: Multiple large images may require more RAM

### Performance Considerations

- **Capture Duration**: Total time = (captures - 1) × interval
- **AI Processing Time**: Increases with number of images
- **Network Bandwidth**: Multiple images require more upload bandwidth
- **Storage**: Temporary files are automatically cleaned up

## Configuration Reference

### MQTT Settings

- `server`: MQTT broker hostname/IP
- `port`: MQTT broker port (typically 1883)
- `basetopic`: Base topic for all MQTT communications
- `username`/`password`: MQTT authentication credentials (or use `password_file` for Docker secrets)
- `client`: MQTT client identifier

### AI Backend Settings

- `endpoint`: AI API endpoint URL
- `token`: API authentication token (or use `token_file` for Docker secrets)
- `type`: Backend type (e.g., `openai`)
- `model`: Default AI model name (must support vision/image input for camera loaders)

### Camera Settings

Cameras are defined as a simple map of name to RTSP URL:

```yaml
cameras:
  camera_name: rtsp://user:pass@192.168.1.50:554/stream1
```

Or in expanded form with secrets support:

```yaml
cameras:
  camera_name:
    url: rtsp://192.168.1.50:554/stream1
    username: user
    password_file: /run/secrets/camera_password
```

### Prompt Template Settings

Prompt templates reference an AI backend and contain the prompt text:

- `ai`: Name of the AI backend to use
- `prompt`: Prompt text (may include `{{prompt}}` and `{{template}}` placeholders)
- `model`: (optional) Override the default model for this prompt
- `output`: (optional) JSON schema for structured responses

### Task Template Settings

Task templates combine prompts with loaders and other settings to create reusable configurations:

- `ai`: (optional) AI backend to use for this task
- `topic`: (optional) Default topic routing for OUTPUT/PROGRESS/STATS
- `prompt`: (required) Prompt configuration object:
  - `template`: (optional) Single prompt template name (string) or array of template names (string[]) for chaining. When multiple templates are provided, they are processed left-to-right with later templates inserted into earlier ones using `{{template}}` placeholders (e.g., `["base_template", "specific_template"]`)
  - `text`: (optional) Inline prompt text
  - `output`: (optional) JSON schema for structured responses
  - `model`: (optional) Model override
- `files`: (optional) Array of file paths to attach
- `loader`: (optional) Array of loader configurations

Tasks are referenced in INPUT using `{"task": "task_name"}` and can have fields overridden by the INPUT payload.
  - `files`: (optional) Array of file paths to attach
  - `loader`: (optional) Array of loader configurations

Tasks are referenced in INPUT using `{"task": "task_name"}` and can have fields overridden by the INPUT payload.

### Database Settings

- `type`: Database type (currently only `mariadb` is supported)
- `server`: Database server hostname/IP
- `port`: Database port (default: 3306)
- `username`: Database username
- `password`: Database password (or use `password_file` for Docker secrets)
- `database`: Database name

### Loader Options (specified in INPUT JSON)

When using loaders in the INPUT JSON, the following options are available:

**Camera loader:**

- `source`: Camera name from config
- `options.captures`: Number of sequential images (1-10+, default: 1)
- `options.interval`: Milliseconds between captures (≥0, default: 1000)

**URL loader:**

- `source`: URL to download

**File loader:**

- `source`: Local file path

**MQTT loader:**

- `source`: MQTT topic to fetch
- `options.attach`: `"inline"`, `"file"`, or `"image"`
- `options.timeout`: Timeout in milliseconds (default: 5000)

**Database loader:**

- `source`: Database name from config
- `options.query`: SQL query to execute
- `options.attach`: `"csv"` (attach as file) or `"inline"` (embed in prompt)

> Refer to [Structured model outputs - OpenAI API](https://platform.openai.com/docs/guides/structured-outputs) for more information about the output schema.

### Multi-Image Guidelines

- **Optimal Captures**: 3-5 images for most motion detection scenarios
- **Interval Timing**: 1-5 seconds depending on expected motion speed
- **Total Duration**: Keep under 30 seconds to avoid timeout issues
- **Prompt Design**: Include context about sequential analysis in prompts

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes with appropriate tests
4. Submit a pull request

## License

This project is licensed under the BSD 3-Clause License. See the [LICENSE](LICENSE) file for details.

## Support

For issues and questions:

- Check the application logs for error details
- Monitor the `<basetopic>/PROGRESS` topic for real-time status updates (plain text)
- Monitor the `<basetopic>/STATS` topic for performance metrics (JSON format with `camera` and `stats` fields)
- Verify configuration settings
- Ensure network connectivity to MQTT broker and AI endpoint
- Test with single image before using multi-image capture
- Monitor disk space and memory usage for multi-image scenarios
- Open an issue on the project repository
