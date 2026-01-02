import { MqttService } from './services/mqttService';
import { CameraService } from './services/cameraService';
import { AiService } from './services/aiService';
import { StatusService } from './services/statusService';
import { config } from './config/config';
import { logger } from './utils/logger';
import fs from 'fs';
import { composeTemplateChain, sanitizeOutgoingTopic as sanitizeTopic, extractStructuredFromAiResponse as extractStructuredFromAiResponseUtil, buildJsonSchema as buildJsonSchemaUtil } from './utils/promptUtils';

export const mqttService = new MqttService(config.mqtt);
export const cameraService = new CameraService();
export const aiService = new AiService(config.ai);
export const statusService = new StatusService();

// Wire up status service events to MQTT publishing
statusService.on('statusUpdate', (cameraName: string | undefined, status: string) => {
    mqttService.publishProgress(cameraName, status);
});

statusService.on('statsUpdate', (cameraName: string, stats: any) => {
    mqttService.publishStats(cameraName, stats);
});

// Input queue for sequential processing
const inputQueue: any[] = [];
let processing = false;

async function initialize() {
    try {
        logger.info('Starting MQTT AI Tool application...');

        mqttService.on('connected', () => {
            logger.info('MQTT connection established, initializing channels...');
            mqttService.initializeChannels(config.cameras);
        });

        mqttService.on('input', (payload: any) => {
            logger.info('New INPUT received, enqueueing');
            enqueueInput(payload);
        });

        logger.info('Application initialization complete, waiting for MQTT connection...');
    } catch (error) {
        logger.error('Failed to initialize application: ' + error);
        process.exit(20);
    }
}

function enqueueInput(payload: any) {
    inputQueue.push(payload);
    publishQueueCount();
    if (!processing) {
        processNextInput().catch(err => logger.error(`Failed to process next input: ${err}`));
    }
}

function publishQueueCount() {
    const count = inputQueue.length;
    mqttService.publish(`${config.mqtt.basetopic}/QUEUED`, String(count), true);
}

export async function processPayload(payload: any) {
    const startTime = Date.now();

    // Determine primary camera for status updates (if any)
    const primaryCamera = Array.isArray(payload?.prompt?.loader)
        ? payload.prompt.loader.find((l: any) => l.type === 'camera')?.source
        : undefined;

    try {
        // Determine AI backend
        let aiName = payload.ai;
        if (!aiName) {
            aiName = Object.keys(config.ai)[0]; // first configured ai backend
            logger.debug(`No ai specified in payload, using default backend: ${aiName}`);
        }

        const aiBackend = config.ai[aiName];
        if (!aiBackend) {
            throw new Error(`Unknown AI backend: ${aiName}`);
        }

        // Resolve prompt
        let promptText = '';
        let responseFormat = undefined as any;

        // Validate prompt existence: must provide either prompt.template or prompt.text
        if (!payload.prompt || (!payload.prompt.template && !payload.prompt.text)) {
            logger.warn('INPUT payload missing both prompt.template and prompt.text - skipping processing');
            mqttService.publish(`${config.mqtt.basetopic}/OUTPUT`, JSON.stringify({ tag: payload.tag, error: 'Missing prompt.template and prompt.text' }), false);
            if (primaryCamera) statusService.recordError(primaryCamera, 'Missing prompt.template and prompt.text');
            return { skipped: true };
        }

        // Resolve template(s): support single name or an array of names to chain
        let templateText: string | undefined = undefined;
        let templateModel: string | undefined = undefined;
        let templateResponseFormat: any = undefined;

        if (payload.prompt && payload.prompt.template) {
            const res = composeTemplateChain(payload.prompt.template, config.prompts);
            templateText = res.text;
            templateModel = res.model;
            templateResponseFormat = res.response_format;

            if (!templateText && !payload.prompt.text) {
                logger.warn(`Unknown prompt template(s) and no prompt.text provided - skipping`);
                mqttService.publish(`${config.mqtt.basetopic}/OUTPUT`, JSON.stringify({ tag: payload.tag, error: `Unknown prompt template(s)` }), false);
                if (primaryCamera) statusService.recordError(primaryCamera, `Unknown prompt template(s)`);
                return { skipped: true };
            }

            if (templateResponseFormat) responseFormat = templateResponseFormat;
        }

        // Compose final promptText
        if (payload.prompt && payload.prompt.text) {
            const inlineText = payload.prompt.text;

            if (templateText && /{{\s*prompt\s*}}/.test(templateText)) {
                promptText = templateText.replace(/{{\s*prompt\s*}}/g, inlineText);
            } else if (templateText) {
                promptText = `${templateText}\n\n${inlineText}`;
            } else {
                promptText = inlineText;
            }

            if (payload.prompt.output) {
                // If inline output is provided, construct response_format
                responseFormat = {
                    type: 'json_schema',
                    json_schema: {
                        name: `${payload.tag || 'inline'}_output`,
                        strict: true,
                        schema: {
                            type: 'object',
                            properties: buildJsonSchema(payload.prompt.output),
                            additionalProperties: false,
                            required: Object.keys(payload.prompt.output || {}),
                        },
                    },
                };
            }
        } else if (templateText) {
            // No inline text but we have a template chain
            promptText = templateText;
        }

        // If model override exists, prioritize inline override, then first template model, then backend default
        if (!payload.prompt?.model && templateModel) {
            // templateModel is set from first (leftmost) template that specified a model
            // We do not assign here; usedModel computed later
        }

        // Collect files from payload.files and loader entries
        const tempFiles: string[] = [];

        if (payload.files && Array.isArray(payload.files)) {
            for (const f of payload.files) {
                try {
                    if (fs.existsSync(f)) {
                        tempFiles.push(f);
                    } else {
                        logger.warn(`File specified in payload not found on disk: ${f}`);
                    }
                } catch (err) {
                    logger.error(`Error checking file ${f}: ${err}`);
                }
            }
        }

        // Handle loaders
        if (payload.prompt && payload.prompt.loader && Array.isArray(payload.prompt.loader)) {
            // If we have a primary camera, set status
            if (primaryCamera) {
                statusService.updateStatus(primaryCamera, 'Starting capture');
            }

            for (let lIdx = 0; lIdx < payload.prompt.loader.length; lIdx++) {
                const loader = payload.prompt.loader[lIdx];
                const loaderNum = lIdx + 1;
                const loaderTotal = payload.prompt.loader.length;

                // Generic loader progress update
                if (primaryCamera) statusService.updateStatus(primaryCamera, `Processing loader ${loaderNum} of ${loaderTotal} (${loader.type})`);
                else statusService.updateStatus(undefined, `Processing loader ${loaderNum} of ${loaderTotal} (${loader.type})`);

                if (loader.type === 'camera') {
                    const source = loader.source;
                    const cam = config.cameras[source];
                    if (!cam) throw new Error(`Unknown camera source: ${source}`);

                    // Resolve camera RTSP URL and credentials
                    let rtspUrl: string;
                    if (typeof cam === 'string') {
                        rtspUrl = cam;
                    } else {
                        // camera object with separate creds
                        const url = new URL(cam.url);
                        url.username = cam.username || url.username || '';
                        let pass = cam.password;
                        if (!pass && cam.password_file) {
                            try {
                                if (fs.existsSync(cam.password_file)) pass = fs.readFileSync(cam.password_file, 'utf8').trim();
                                else logger.warn(`Camera ${source} password_file '${cam.password_file}' does not exist`);
                            } catch (e) {
                                logger.warn(`Could not read camera password_file for ${source}: ${e}`);
                            }
                        }
                        url.password = pass || url.password || '';
                        rtspUrl = url.toString();
                    }

                    const captures = loader.options?.captures || 1;
                    const interval = loader.options?.interval || 1000;

                    for (let i = 0; i < captures; i++) {
                        // Update capture status with capture count
                        if (primaryCamera) statusService.updateStatus(source, `Capturing (${i + 1} of ${captures})`);
                        else statusService.updateStatus(undefined, `Capturing (${i + 1} of ${captures})`);

                        const imagePath = await cameraService.captureImage(rtspUrl);
                        tempFiles.push(imagePath);

                        if (i < captures - 1 && interval > 0) {
                            if (primaryCamera) statusService.updateStatus(source, `Waiting for next capture (${i + 1} of ${captures})`);
                            else statusService.updateStatus(undefined, `Waiting for next capture (${i + 1} of ${captures})`);
                            await new Promise(r => setTimeout(r, interval));
                        } else {
                            // Mark individual capture completed
                            if (primaryCamera) statusService.updateStatus(source, `Captured (${i + 1} of ${captures})`);
                            else statusService.updateStatus(undefined, `Captured (${i + 1} of ${captures})`);
                        }
                    }
                } else if (loader.type === 'url') {
                    const sourceUrl = loader.source;

                    // Progress update for URL fetch with loader counts
                    if (primaryCamera) statusService.updateStatus(primaryCamera, `Fetching URL ${loaderNum} of ${loaderTotal}: ${sourceUrl}`);
                    else statusService.updateStatus(undefined, `Fetching URL ${loaderNum} of ${loaderTotal}: ${sourceUrl}`);

                    const tmpPath = await downloadUrlToTemp(sourceUrl);
                    tempFiles.push(tmpPath);

                    // Mark URL fetch completed
                    if (primaryCamera) statusService.updateStatus(primaryCamera, `URL fetched (${loaderNum} of ${loaderTotal})`);
                    else statusService.updateStatus(undefined, `URL fetched (${loaderNum} of ${loaderTotal})`);
                } else if (loader.type === 'database') {
                    const source = loader.source;
                    const dbConfig = config.databases?.[source];
                    if (!dbConfig) throw new Error(`Unknown database source: ${source}`);
                    if (dbConfig.type !== 'mariadb') throw new Error(`Unsupported database type for ${source}: ${dbConfig.type}`);

                    // Progress update for DB query (with loader counts)
                    if (primaryCamera) statusService.updateStatus(primaryCamera, `Querying DB ${loaderNum} of ${loaderTotal}: ${source}`);
                    else statusService.updateStatus(undefined, `Querying DB ${loaderNum} of ${loaderTotal}: ${source}`);

                    const query = loader.options?.query;

                    if (!query) throw new Error(`Database loader for ${source} missing 'query' option`);

                    const attach = loader.options?.attach || 'csv'; // 'csv' or 'inline'

                    const mariadb = (await import('mariadb')).default || (await import('mariadb'));

                    const conn = await mariadb.createConnection({
                        host: dbConfig.server,
                        port: dbConfig.port || 3306,
                        user: dbConfig.username,
                        password: dbConfig.password || (dbConfig.password_file ? fs.readFileSync(dbConfig.password_file, 'utf8').trim() : undefined),
                        database: dbConfig.database,
                    });

                    try {
                        const rows = await conn.query(query);

                        // Ensure rows is an array of objects
                        const resultRows = Array.isArray(rows) ? rows : [rows];

                        if (attach === 'csv') {
                            // Convert to CSV
                            const csv = rowsToCsv(resultRows);
                            const os = await import('os');
                            const path = await import('path');
                            const tmpName = `mqttai_db_${source}_${Date.now()}_${Math.round(Math.random() * 10000)}.csv`;
                            const tmpPath = path.join(os.tmpdir(), tmpName);
                            fs.writeFileSync(tmpPath, csv);
                            tempFiles.push(tmpPath);
                        } else { // inline
                            promptText = `${promptText}\n\nDatabase ${source} query results:\n${rowsToCsv(resultRows)}`;
                        }
                    } finally {
                        try { await conn.end(); } catch (e) { logger.warn(`Error closing DB connection: ${e}`); }
                    }
                } else if (loader.type === 'mqtt') {
                    const source = loader.source;
                    if (!source) throw new Error('MQTT loader requires a "source" topic');

                    // Support relative topic names under basetopic
                    const topic = source.startsWith(config.mqtt.basetopic) ? source : `${config.mqtt.basetopic}/${source}`;
                    const timeout = loader.options?.timeout || 5000;
                    const attach = loader.options?.attach || 'inline'; // 'inline', 'file', or 'image'

                    logger.info(`Fetching MQTT topic '${topic}' for loader`);

                    // Progress update for MQTT topic fetch
                    if (primaryCamera) statusService.updateStatus(primaryCamera, `Fetching MQTT topic: ${topic}`);
                    else statusService.updateStatus(undefined, `Fetching MQTT topic: ${topic}`);

                    const { payload, isBinary } = await mqttService.fetchTopicMessage(topic, timeout);

                    // Mark MQTT fetch completed
                    if (primaryCamera) statusService.updateStatus(primaryCamera, 'MQTT topic fetched');
                    else statusService.updateStatus(undefined, 'MQTT topic fetched');

                    if (isBinary && Buffer.isBuffer(payload)) {
                        const buf: Buffer = payload as Buffer;
                        const mime = detectMime(buf);

                        if (attach === 'inline') {
                            // For binary payloads, inline as base64 text
                            promptText = `${promptText}\n\nMQTT topic ${topic} returned binary data (base64): ${buf.toString('base64')}`;
                        } else {
                            // Write to temp file and attach
                            const tmpPath = await writeBufferToTemp(buf, topic, mime);
                            tempFiles.push(tmpPath);
                        }
                    } else {
                        // treat as text
                        const text = String(payload);
                        if (attach === 'inline') {
                            promptText = `${promptText}\n\nMQTT topic ${topic} contents:\n${text}`;
                        } else {
                            // write to tmp file
                            const tmpPath = await writeBufferToTemp(Buffer.from(text, 'utf8'), topic, 'text/plain');
                            tempFiles.push(tmpPath);
                        }
                    }
                } else {
                    logger.warn(`Unknown loader type: ${loader.type}`);
                }
            }
        }

        // Before sending to AI, update status if we have a camera
        if (primaryCamera) statusService.updateStatus(primaryCamera, 'Processing with AI');

        // Determine which model will be used (inline override -> template chain override -> backend default)
        const usedModel = (payload.prompt && payload.prompt.model) || templateModel || aiBackend.model;

        // Send to AI service: delegate to AiService to handle different backends
        const aiStart = Date.now();
        const response = await aiService.sendFilesAndPrompt(aiName, tempFiles, promptText, responseFormat, usedModel);
        const aiEnd = Date.now();

        // Compute timing
        const totalTime = (Date.now() - startTime) / 1000;
        const aiTime = (aiEnd - aiStart) / 1000;

        // Build output object with structured JSON (if available) and model info
        const structured = extractStructuredFromAiResponse(response, responseFormat);

        const out = {
            tag: payload.tag,
            time: totalTime,
            model: usedModel,
            text: extractTextFromAiResponse(response),
            json: structured || null,
        };

        // Determine output topic: support optional payload.topic which maps to basetopic/OUTPUT/<topic>
        let outputTopic = `${config.mqtt.basetopic}/OUTPUT`;
        if (payload.topic && typeof payload.topic === 'string') {
            const sanitized = sanitizeOutgoingTopic(payload.topic);
            if (sanitized) {
                outputTopic = `${config.mqtt.basetopic}/OUTPUT/${sanitized}`;
            } else {
                logger.warn(`Invalid payload.topic provided: ${payload.topic} - falling back to base OUTPUT topic`);
                // publish a warning to base OUTPUT (do not change behavior of stats)
                mqttService.publish(`${config.mqtt.basetopic}/OUTPUT`, JSON.stringify({ tag: payload.tag, warning: 'Invalid topic specified; using base OUTPUT' }), false);
            }
        }

        mqttService.publish(outputTopic, JSON.stringify(out), false);

        // Publish completion and status updates for camera if applicable
        if (primaryCamera) {
            statusService.updateStatus(primaryCamera, 'Publishing response');
        }

        // Clean up temp files (including images captured)
        if (primaryCamera) statusService.updateStatus(primaryCamera, 'Cleaning up');
        await cameraService.cleanupImageFiles(tempFiles);

        // After cleanup, record success which sets the status to 'Complete'
        if (primaryCamera) statusService.recordSuccess(primaryCamera, aiTime, totalTime);

        const endTime = Date.now();
        logger.info(`INPUT processing completed for tag="${payload?.tag}" in ${(endTime - startTime) / 1000}s`);

        return { outputTopic, out };
    } catch (error) {
        logger.error(`Error processing INPUT payload: ${error}`);
        // Record error on camera stats if we have one
        if (primaryCamera) statusService.recordError(primaryCamera, error as any);
        throw error;
    }
}

async function processNextInput() {
    if (inputQueue.length === 0) {
        processing = false;
        publishQueueCount();
        return;
    }

    processing = true;
    publishQueueCount();

    const payload = inputQueue.shift();
    logger.info(`Processing INPUT payload with tag="${payload?.tag}"`);

    try {
        await processPayload(payload);
    } catch (error) {
        logger.error(`Error processing INPUT payload: ${error}`);
    } finally {
        // Continue with next input
        processing = false;
        publishQueueCount();
        // Trigger next
        setImmediate(() => processNextInput());
    }
}



function extractTextFromAiResponse(resp: any): string {
    try {
        if (!resp) return '';
        // OpenAI-like: choices[0].message.content
        if (resp.choices && resp.choices.length > 0 && resp.choices[0].message) {
            const content = resp.choices[0].message.content;
            if (typeof content === 'string') return content;
            // if content is structured (object), try to stringify a reasonable text
            if (typeof content === 'object') return JSON.stringify(content);
        }
        if (typeof resp === 'string') return resp;
        // Fallback: try common fields
        if (resp.output && typeof resp.output === 'string') return resp.output;
        return JSON.stringify(resp);
    } catch (e) {
        return '';
    }
}

function extractStructuredFromAiResponse(resp: any, responseFormat?: any): any { return extractStructuredFromAiResponseUtil(resp, responseFormat); }

function rowsToCsv(rows: any[]): string {
    if (!rows || rows.length === 0) return '';

    const cols = Object.keys(rows[0]);
    const header = cols.join(',');
    const lines = rows.map(r => cols.map(c => {
        const val = r[c] === null || r[c] === undefined ? '' : String(r[c]);
        // Escape quotes and commas
        return `"${val.replace(/"/g, '""')}"`;
    }).join(','));

    return [header, ...lines].join('\n');
}

/* function detectMimeFromBuffer(buf: Buffer): string | undefined {
    if (!buf || buf.length < 4) return undefined;

    // JPEG
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    // PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    // GIF
    if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
    // PDF
    if (buf.slice(0, 4).toString() === '%PDF') return 'application/pdf';

    // Heuristic: check if it's valid UTF-8 text
    const text = buf.toString('utf8');
    const nonPrintable = /[^

 -~]/.test(text);
    if (!nonPrintable) return 'text/plain';

    return undefined;
}

*/

function detectMime(buf: Buffer): string | undefined {
    if (!buf || buf.length < 4) return undefined;

    // JPEG
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    // PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    // GIF
    if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
    // PDF
    if (buf.slice(0, 4).toString() === '%PDF') return 'application/pdf';

    const text = buf.toString('utf8');
    const nonPrintable = /[^\t\n\r\x20-\x7E]/.test(text);
    if (!nonPrintable) return 'text/plain';

    return undefined;
}

async function writeBufferToTemp(buf: Buffer, topic: string, mime?: string): Promise<string> {
    const os = await import('os');
    const path = await import('path');
    const safeTopic = topic.replace(/[\/:]/g, '_').replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const ext = mime && mime.indexOf('/') !== -1 ? `.${mime.split('/')[1]}` : '';
    const tmpName = `mqttai_${safeTopic}_${Date.now()}${ext}`;
    const tmpPath = path.join(os.tmpdir(), tmpName);
    fs.writeFileSync(tmpPath, buf);
    return tmpPath;
}
function buildJsonSchema(properties: any): any { return buildJsonSchemaUtil(properties); }

function sanitizeOutgoingTopic(t: string): string | null { return sanitizeTopic(t); }

async function downloadUrlToTemp(url: string): Promise<string> {
    const axios = (await import('axios')).default;
    const os = await import('os');
    const path = await import('path');

    const parsedPath = path.parse(url.split('?')[0]);
    const ext = parsedPath.ext || '';
    const tmpName = `mqttai_url_${Date.now()}_${Math.round(Math.random() * 10000)}${ext}`;
    const tmpPath = path.join(os.tmpdir(), tmpName);

    const response = await axios.get(url, { responseType: 'arraybuffer', validateStatus: () => true });
    fs.writeFileSync(tmpPath, Buffer.from(response.data));
    return tmpPath;
}

// Graceful shutdown function
async function gracefulShutdown(signal: string) {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    try {
        // Update all camera statuses to offline
        const cameras = Object.keys(config.cameras);
        cameras.forEach(cameraName => {
            statusService.updateStatus(cameraName, 'Offline');
        });

        mqttService.gracefulShutdown();

        // Give MQTT client time to send the offline message
        await new Promise((resolve) => setTimeout(resolve, 1000));

        logger.info('Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        logger.error(`Error during graceful shutdown: ${error}`);
        process.exit(1);
    }
}

// Handle process signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    process.exit(1);
});

// Start the application
initialize().catch((error) => {
    logger.error(`Failed to start application: ${error}`);
    process.exit(1);
});
