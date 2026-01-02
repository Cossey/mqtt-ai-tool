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

The application now uses a simplified global topic set under the base topic. Replace the previous per-camera trigger topics with these global channels.

- **`<basetopic>/INPUT`** - Accepts a JSON object to request analysis (see format below)
- **`<basetopic>/OUTPUT`** - Returns JSON objects with the AI result for each processed request
- **`<basetopic>/STATS`** - Performance and historical metrics. Use **`<basetopic>/PROGRESS`** for live status updates (camera-specific fields included in payload).
- **`<basetopic>/QUEUED`** - Retained number indicating how many INPUT requests are queued

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

```json
{
    "tag": "my-request-123",
    "ai": "openai",                       # optional, if missing the first configured AI backend will be used
    "prompt": {
        "template": "gate_prompt",        # optional - name of a prompt from config
        "text": "Custom prompt text",     # optional - inline text; if template provided, text will be injected into a {{prompt}} placeholder if present or appended to the template
        "output": {                         # optional - inline output schema
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

Note: If an INPUT contains an optional `topic` property, the response will be published to `<basetopic>/OUTPUT/<topic>` instead of the base `OUTPUT` topic. The `topic` value is validated (wildcards and control characters are disallowed) and may include `/` separators for subtopics. If invalid, the response will fall back to the base `<basetopic>/OUTPUT` topic and a warning will be logged/published.

Examples of valid and invalid `topic` values:

```text
# Valid - simple subtopic preserved:
topic = "BACKYARD/SECURITY"  -> publishes to <basetopic>/OUTPUT/BACKYARD/SECURITY

# Valid - colons inside a segment are replaced with underscores:
topic = "Back/yard:weird"    -> publishes to <basetopic>/OUTPUT/Back/yard_weird

# Invalid - wildcards not allowed (falls back to base OUTPUT and warning published):
topic = "Bad/+/Topic"        -> publishes to <basetopic>/OUTPUT (warning published)
```

Use slashes to create subtopics; each segment will be sanitized (whitespace → underscore, unsafe characters replaced), but `/` will be preserved to allow hierarchical subtopics.

### Prompt rules

- Requests must include a `prompt` object that contains either `prompt.template` **or** `prompt.text` (or both). Requests missing both will be ignored and an error message will be published to `<basetopic>/OUTPUT` with the same `tag`.
- If `prompt.template` is present but not found in `config.prompts` and no `prompt.text` is provided, the request will be ignored and an error published to `<basetopic>/OUTPUT`.
- When both `prompt.template` and `prompt.text` are provided, `prompt.text` will be injected into a `{{prompt}}` placeholder in the template if present; otherwise it will be appended to the template separated by a blank line.
- `prompt.template` may also be an array of template names (e.g., `"template": ["t1","t2"]`). Templates are concatenated in order: the later templates are inserted into earlier ones using a `{{template}}` placeholder if present; otherwise they are appended. Templates are processed left-to-right so `t1` is the outermost template. Placeholders `{{template}}` and `{{prompt}}` may appear multiple times and will be replaced at every occurrence.

### Camera Status Values

The `/PROGRESS` topic provides real-time status updates during processing (each payload includes a `camera` field when applicable). The `/STATS` topic contains performance metrics and historical stats.

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

### Camera Statistics

The `/STATS` topic publishes a JSON object with performance metrics (payload includes `camera` when applicable):

```json
{
    "lastErrorDate": "2023-01-01T12:00:00.000Z",
    "lastErrorType": "Connection timeout",
    "lastSuccessDate": "2023-01-01T12:05:00.000Z",
    "lastAiProcessTime": 2.5,
    "lastTotalProcessTime": 8.2
}
```

**Statistics Properties:**

- **`lastErrorDate`** - ISO timestamp of most recent error
- **`lastErrorType`** - Description of the last error that occurred
- **`lastSuccessDate`** - ISO timestamp of most recent successful processing
- **`lastAiProcessTime`** - Time in seconds for AI processing only
- **`lastTotalProcessTime`** - Total time in seconds from INPUT reception to completion

### Workflow

1. **Initialization**: Application connects to MQTT broker and initializes base channels and per-camera `PROGRESS` entries.
2. **Trigger**: Publish a JSON request to `<basetopic>/INPUT` to start analysis (see INPUT format). Requests without a valid prompt are skipped and an error published to `<basetopic>/OUTPUT`.
3. **Progress**: Live status updates are published to `<basetopic>/PROGRESS` (payloads include `camera` when applicable). Use `<basetopic>/STATS` for performance and historical metrics.
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

Create a `config.yaml` file based on the provided `config.yaml.sample`. The configuration now has three primary sections:

- **`ai`**: Map of AI backends (name -> endpoint, token, type, default model)
- **`cameras`**: Map of camera names to RTSP endpoints (simple name -> endpoint mapping)
- **`prompts`**: Decoupled prompts which reference an `ai` backend and optionally override the model; prompts may include `output` to declare a JSON schema for structured responses

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

Note: Capture counts and intervals are provided via the INPUT `loader` entries when requesting analysis (e.g., use `loader.type: camera` with `options.captures`).

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

#### Camera loader (single image)

```bash
mosquitto_pub -h mqtt-server -t "mqttai/INPUT" -m '{"tag":"req1","prompt":{"template":"garage_prompt","loader":[{"type":"camera","source":"garage","options":{"captures":1}}]}}'
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

### Monitor results and queue

```bash
mosquitto_sub -h mqtt-server -t "mqttai/OUTPUT" -v
mosquitto_sub -h mqtt-server -t "mqttai/QUEUED" -v
mosquitto_sub -h mqtt-server -t "mqttai/STATS" -v
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

Use the `<basetopic>/STATS` topic to monitor performance and historical metrics; subscribe to `<basetopic>/PROGRESS` for live status updates (payloads include a `camera` field when applicable):

```bash
# Subscribe to PROGRESS for live status updates and STATS for performance metrics
mosquitto_sub -h mqtt-server -t "mqttai/PROGRESS" -v
mosquitto_sub -h mqtt-server -t "mqttai/STATS" -v

# Example PROGRESS update:
{
  "camera": "garage",
  "status": "Capturing"
}

# Example STATS update:
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
- `user`/`password`: MQTT authentication credentials
- `client`: MQTT client identifier

### OpenAI Settings

- `endpoint`: AI API endpoint URL
- `api_token`: API authentication token
- `model`: AI model name (must support vision/image input)

### Camera Settings

- `endpoint`: RTSP stream URL with credentials
- `prompt`: Text prompt for AI analysis. If both `prompt.template` and `prompt.text` are provided, the `prompt.text` will be inserted into the template at a `{{prompt}}` placeholder if present; otherwise it will be appended to the template with a blank line separator.
- `captures`: Number of sequential images (1-10+, default: 1)
- `interval`: Milliseconds between captures (≥0, default: 1000)
- `output`: Optional structured output schema

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
- Monitor the `<basetopic>/STATS` topic for real-time status and performance information (payload includes `camera` when applicable)
- Verify configuration settings
- Ensure network connectivity to MQTT broker and AI endpoint
- Test with single image before using multi-image capture
- Monitor disk space and memory usage for multi-image scenarios
- Open an issue on the project repository

