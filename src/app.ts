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

// Track the current processing topic (sanitized) for PROGRESS and STATS routing
let currentProcessingTopic: string | null = null;

// Helper: sanitize names for Home Assistant object_id / unique_id
function sanitizeEntityId(s: string): string {
    return String(s || '')
        .toLowerCase()
        // NOTE: hyphens are intentionally preserved here; they are allowed in object_id
        .replace(/[^a-z0-9_\-]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

// Module-level helpers for HA discovery JSON path building
const isSafeIdentifier = (n: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(n));
const jsonPathFromSegments = (segments: string[]): string => {
    // Output JSON is published as { tag, time, model, text, json: { ...aiFields } }
    // so all AI-output properties live under the top-level "json" key.
    let p = 'value_json.json';
    for (const s of segments) {
        if (isSafeIdentifier(s)) p += `.${s}`;
        else p += `['${String(s).replace(/'/g, "\\'")}']`;
    }
    return p;
};

/**
 * Publish Home Assistant MQTT discovery entries for all tasks with `ha: true` in config.
 * - Uses `mqtt.homeassistant` as discovery prefix (defaults to 'homeassistant')
 * - Exposes each top-level output property as a sensor whose state_topic is the task's OUTPUT topic
 */
export function publishHaDiscovery() {
    const haPrefix = config.mqtt.homeassistant || 'homeassistant';
    if (!config.tasks || Object.keys(config.tasks).length === 0) return;

    for (const [taskName, task] of Object.entries(config.tasks)) {
        if (!task || !task.prompt) continue;
        if (!task.ha) continue; // feature opt-in per-task

        // compute the OUTPUT and PROGRESS state topics for this task (use task.topic if present)
        let stateTopic = `${config.mqtt.basetopic}/OUTPUT`;
        let progressTopic = `${config.mqtt.basetopic}/PROGRESS`;
        if (task.topic && typeof task.topic === 'string') {
            const sanitized = sanitizeTopic(task.topic);
            if (sanitized) {
                stateTopic = `${config.mqtt.basetopic}/OUTPUT/${sanitized}`;
                progressTopic = `${config.mqtt.basetopic}/PROGRESS/${sanitized}`;
            }
        }

        // Collect output properties from template chain (merged) and from task.prompt.output (task-level shorthand)
        const properties: Record<string, any> = {};

        // 1) Templates
        if (task.prompt.template) {
            const res = composeTemplateChain(task.prompt.template as any, config.prompts);
            const rf = res.response_format;
            if (rf && rf.type === 'json_schema' && rf.json_schema && rf.json_schema.schema && rf.json_schema.schema.properties) {
                Object.assign(properties, rf.json_schema.schema.properties);
            }
        }

        // 2) Task-level `prompt.output` (old shorthand) overrides/extends template props
        if ((task.prompt as any).output && typeof (task.prompt as any).output === 'object') {
            const built = buildJsonSchemaUtil((task.prompt as any).output);
            Object.assign(properties, built);
        }

        if (Object.keys(properties).length === 0) continue;

        // ── Fixed envelope entities (always present on every OUTPUT message) ──────────
        const sanitizedTaskNameFixed = sanitizeEntityId(taskName).replace(/-/g, '_');
        const fixedAvailability = {
            topic: `${config.mqtt.basetopic}/ONLINE`,
            payload_available: 'YES',
            payload_not_available: 'NO',
        };
        const fixedDevice = {
            identifiers: [`mqttaitool_${sanitizeEntityId(taskName)}`],
            name: `${taskName}`,
        };
        const fixedOrigin = { name: 'mqtt-ai-tool' };

        const fixedEntities: { id: string; name: string; domain: string; valueTemplate: string; extras?: any }[] = [
            { id: 'tag',      name: 'tag',      domain: 'sensor', valueTemplate: '{{ value_json.tag }}' },
            { id: 'time',     name: 'time',     domain: 'sensor', valueTemplate: '{{ value_json.time }}',  extras: { state_class: 'measurement', unit_of_measurement: 's' } },
            { id: 'model',    name: 'model',    domain: 'sensor', valueTemplate: '{{ value_json.model }}' },
            { id: 'text',     name: 'text',     domain: 'sensor', valueTemplate: '{{ value_json.text }}' },
        ];

        for (const fe of fixedEntities) {
            const discoveryTopic = `${haPrefix}/${fe.domain}/${sanitizedTaskNameFixed}/${fe.id}/config`;
            const payload: any = {
                name: fe.name,
                unique_id: `mqttaitool_${sanitizedTaskNameFixed}_${fe.id}`,
                state_topic: stateTopic,
                value_template: fe.valueTemplate,
                availability: fixedAvailability,
                device: fixedDevice,
                origin: fixedOrigin,
                json_attributes_topic: stateTopic,
                ...fe.extras,
            };
            mqttService.publish(discoveryTopic, JSON.stringify(payload), true);
        }

        // progress entity — plain text, separate topic, no value_template or json_attributes_topic
        mqttService.publish(
            `${haPrefix}/sensor/${sanitizedTaskNameFixed}/progress/config`,
            JSON.stringify({
                name: 'progress',
                unique_id: `mqttaitool_${sanitizedTaskNameFixed}_progress`,
                state_topic: progressTopic,
                availability: fixedAvailability,
                device: fixedDevice,
                origin: fixedOrigin,
            }),
            true
        );

        // Publish discovery for each top-level property (recursively traverse nested schemas)

        const publishEntityForPath = (pathSegments: string[], nodeSchema: any) => {
            // displayName used by HA/OpenHAB; convert hyphens to underscores to avoid item-name issues
            const displayName = `${pathSegments.join('.')}`;
            // discovery objectId must not contain hyphens (OpenHAB doesn't like them)
            const objectId = sanitizeEntityId(`${pathSegments.join('_')}`).replace(/-/g, '_');
            // unique_id should avoid hyphens as well
            const uniqueId = `mqttaitool_${taskName.replace(/-/g, '_')}_${pathSegments.join('_')}`;
            const baseJson = jsonPathFromSegments(pathSegments);

            // Decide if this node is an object-wrapper (has a Value property)
            const isWrapper = nodeSchema && nodeSchema.type === 'object' && nodeSchema.properties && nodeSchema.properties.Value;

            // Figure out the type we should map to HA domain from (wrapper.Value OR the node itself)
            const effectiveSchema = isWrapper ? nodeSchema.properties.Value : nodeSchema;
            const effectiveType = (effectiveSchema && effectiveSchema.enum && Array.isArray(effectiveSchema.enum)) ? 'enum' : (effectiveSchema && effectiveSchema.type) || 'string';

            let domain = 'sensor';
            let valueTemplate = `{{ ${isWrapper ? `${baseJson}.Value` : baseJson} }}`;
            const extras: any = {};

            // Preserve previous behaviour: if the schema node itself is declared as an object,
            // map it to a `sensor` by default (and expose attributes). Otherwise infer from the effective type.
            if (nodeSchema && (nodeSchema as any).type === 'object') {
                domain = 'sensor';
                valueTemplate = isWrapper ? `{{ ${baseJson}.Value }}` : `{{ ${baseJson} }}`;
            } else {
                switch (effectiveType) {
                case 'boolean':
                    domain = 'binary_sensor';
                    valueTemplate = isWrapper
                        ? `{% if ${baseJson}.Value == true or ${baseJson}.Value == 'Yes' %}ON{% elif ${baseJson}.Value == 'No' or ${baseJson}.Value == false %}OFF{% else %}UNKNOWN{% endif %}`
                        : `{% if ${baseJson} == true or ${baseJson} == 'Yes' %}ON{% elif ${baseJson} == 'No' or ${baseJson} == false %}OFF{% else %}UNKNOWN{% endif %}`;
                    extras.payload_on = 'ON';
                    extras.payload_off = 'OFF';
                    break;
                case 'integer':
                case 'number':
                    // use sensor domain for read‑only numeric values (number requires command_topic)
                    domain = 'sensor';
                    extras.state_class = 'measurement';
                    break;
                case 'array':
                    domain = 'sensor';
                    // use length as state, keep array in attributes
                    valueTemplate = isWrapper ? `{{ ${baseJson}.Value | length }}` : `{{ ${baseJson} | length }}`;
                    extras.state_class = 'measurement';
                    break;
                case 'enum':
                    domain = 'sensor';
                    extras.options = (effectiveSchema as any).enum;
                    extras.device_class = 'enum';
                    break;
                case 'object':
                    domain = 'sensor';
                    valueTemplate = isWrapper ? `{{ ${baseJson}.Value }}` : `{{ ${baseJson} }}`;
                    break;
                case 'string':
                default:
                    domain = 'sensor';
                    break;
                }
            }

            const sanitizedTaskName = sanitizeEntityId(taskName).replace(/-/g, '_');
            const discoveryTopic = `${haPrefix}/${domain}/${sanitizedTaskName}/${objectId}/config`;
            const payload: any = {
                name: displayName,
                unique_id: uniqueId,
                state_topic: stateTopic,
                value_template: valueTemplate,
                availability: {
                    topic: `${config.mqtt.basetopic}/ONLINE`,
                    payload_available: 'YES',
                    payload_not_available: 'NO',
                },
                device: {
                    // ensure identifier uses sanitized task name (hyphens → underscores)
                    identifiers: [`mqttaitool_${sanitizeEntityId(taskName)}`],
                    name: `${taskName}`,
                },
                origin: {
                    name: 'mqtt-ai-tool',
                },
                json_attributes_topic: stateTopic,
                ...extras,
            };

            mqttService.publish(discoveryTopic, JSON.stringify(payload), true);

            // If wrapper, expose common nested fields as separate entities as well
            if (isWrapper) {
                const subFields = ['Confidence', 'BestGuess', 'Reasoning'];
                for (const sf of subFields) {
                    if (nodeSchema.properties[sf]) {
                        const subPath = pathSegments.concat(sf);
                        publishEntityForPath(subPath, nodeSchema.properties[sf]);
                    }
                }
            }
        };

        const traverseSchema = (pathSegments: string[], schemaNode: any) => {
            if (!schemaNode) return;
            // If node is an object and contains a Value field, treat it as an observable wrapper and publish it
            if (schemaNode.type === 'object' && schemaNode.properties) {
                // If this object is a canonical wrapper (has a Value child) we DO NOT publish the object itself.
                // Instead expose each child property under the dotted path (e.g. Property.Value, Property.Confidence).
                if (schemaNode.properties.Value) {
                    for (const [childName, childSchema] of Object.entries(schemaNode.properties)) {
                        traverseSchema(pathSegments.concat(childName), childSchema);
                    }
                    return;
                }

                // Non-wrapper object: recurse into child properties (do not publish the parent object itself)
                for (const [childName, childSchema] of Object.entries(schemaNode.properties)) {
                    traverseSchema(pathSegments.concat(childName), childSchema);
                }
                return;
            }

            // Primitive / enum / array leaf — publish directly
            publishEntityForPath(pathSegments, schemaNode);
        };

        for (const [propName, propSchema] of Object.entries(properties)) {
            traverseSchema([propName], propSchema as any);
        }
    }
}


// Wire up status service events to MQTT publishing
statusService.on('statusUpdate', (cameraName: string | undefined, status: string) => {
    mqttService.publishProgress(cameraName, status, currentProcessingTopic);
});

statusService.on('statsUpdate', (cameraName: string, stats: any) => {
    mqttService.publishStats(cameraName, stats, currentProcessingTopic);
});

// Queue entry types for sequential processing
interface ImmediateLoaderResult {
    files: string[];
    promptAdditions: string[];
    processedIndices: Set<number>;
}

interface QueueEntry {
    payload: any;
    immediateFilesPromise?: Promise<ImmediateLoaderResult>;
}

// Input queue for sequential processing
const inputQueue: QueueEntry[] = [];
let processing = false;

async function initialize() {
    try {
        logger.info('Starting MQTT AI Tool application...');

        mqttService.on('connected', () => {
            logger.info('MQTT connection established, initializing channels...');
            mqttService.initializeChannels();
            // Publish Home Assistant discovery entries for tasks with ha:true
            try {
                publishHaDiscovery();
                logger.info('Published Home Assistant MQTT discovery entries');
            } catch (e) {
                logger.warn(`Failed to publish HA discovery: ${e}`);
            }
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

/**
 * Resolve a task payload by merging task template with payload overrides.
 * Returns the resolved payload, task name, and any error.
 */
export function resolveTaskPayload(payload: any): { resolved: any; taskName?: string; error?: string } {
    if (!payload.task || typeof payload.task !== 'string') {
        return { resolved: payload };
    }

    const taskName = payload.task;
    const taskTemplate = config.tasks?.[taskName];

    if (!taskTemplate) {
        return { resolved: payload, taskName, error: `Unknown task: ${taskName}` };
    }

    const resolved = {
        ai: payload.ai || taskTemplate.ai,
        topic: payload.topic || taskTemplate.topic,
        tag: payload.tag,
        prompt: {
            template: payload.prompt?.template || taskTemplate.prompt.template,
            text: payload.prompt?.text || taskTemplate.prompt.text,
            output: payload.prompt?.output || taskTemplate.prompt.output,
            model: payload.prompt?.model || taskTemplate.prompt.model,
            files: payload.prompt?.files || taskTemplate.prompt.files,
            loader: payload.prompt?.loader || taskTemplate.prompt.loader
        }
    };

    return { resolved, taskName };
}

function enqueueInput(payload: any) {
    // Additional safety check: ignore empty or invalid payloads
    if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) {
        logger.debug('Skipping empty payload in enqueueInput');
        return;
    }

    // Check if payload has either a prompt field OR a task field (minimum required)
    if (!payload.prompt && !payload.task) {
        logger.debug('Skipping payload without prompt or task field in enqueueInput');
        return;
    }

    // Determine queue setting from task config and payload override
    let shouldQueue = true;
    let taskTemplate: any = null;
    if (payload.task && typeof payload.task === 'string') {
        taskTemplate = config.tasks?.[payload.task];
        if (taskTemplate && taskTemplate.queue !== undefined) {
            shouldQueue = taskTemplate.queue !== false;
        }
    }

    // Payload-level queue override takes priority
    if (payload.queue !== undefined) {
        shouldQueue = payload.queue !== false;
    }

    if (!shouldQueue) {
        // Non-queued: process immediately, bypassing the queue
        logger.info(`Processing non-queued INPUT (tag="${payload.tag}") immediately`);
        processPayload(payload).catch(err => logger.error(`Failed to process non-queued input: ${err}`));
        return;
    }

    // For queued tasks, check for immediate loaders
    const loaders = payload.prompt?.loader || taskTemplate?.prompt?.loader;
    const hasImmediateLoaders = Array.isArray(loaders) && loaders.some((l: any) => l.immediate === true);

    const entry: QueueEntry = { payload };

    if (hasImmediateLoaders) {
        logger.info(`Starting immediate loader processing for queued INPUT (tag="${payload.tag}")`);
        entry.immediateFilesPromise = processImmediateLoaders(payload);
    }

    inputQueue.push(entry);
    publishQueueCount();
    if (!processing) {
        processNextInput().catch(err => logger.error(`Failed to process next input: ${err}`));
    }
}

function publishQueueCount() {
    const count = inputQueue.length;
    mqttService.publish(`${config.mqtt.basetopic}/QUEUED`, String(count), true);
}

/**
 * Process a single loader item and return collected files and prompt text additions.
 * Used by processImmediateLoaders for pre-processing immediate loaders before their turn in the queue.
 */
async function processLoaderItem(
    loader: any,
    loaderNum: number,
    loaderTotal: number,
    loaderTypeIndex: number,
    primaryCamera: string | undefined,
): Promise<{ files: string[]; promptAdditions: string[] }> {
    const files: string[] = [];
    const promptAdditions: string[] = [];

    // Generic loader progress update
    if (primaryCamera) statusService.updateStatus(primaryCamera, `Processing loader ${loaderNum} of ${loaderTotal} (${loader.type})`);
    else statusService.updateStatus(undefined, `Processing loader ${loaderNum} of ${loaderTotal} (${loader.type})`);

    if (loader.type === 'camera') {
        const source = loader.source;
        const cam = config.cameras[source];
        if (!cam) throw new Error(`Unknown camera source: ${source}`);

        let rtspUrl: string;
        if (typeof cam === 'string') {
            rtspUrl = cam;
        } else {
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

        const captureStartTime = Date.now();
        let totalCaptureTime = 0;

        for (let i = 0; i < captures; i++) {
            if (primaryCamera) statusService.updateStatus(source, `Capturing (${i + 1} of ${captures})`);
            else statusService.updateStatus(undefined, `Capturing (${i + 1} of ${captures})`);

            const singleCaptureStart = Date.now();
            const imagePath = await cameraService.captureImage(rtspUrl);
            const singleCaptureEnd = Date.now();
            totalCaptureTime += (singleCaptureEnd - singleCaptureStart) / 1000;

            files.push(imagePath);

            if (i < captures - 1 && interval > 0) {
                if (primaryCamera) statusService.updateStatus(source, `Waiting for next capture (${i + 1} of ${captures})`);
                else statusService.updateStatus(undefined, `Waiting for next capture (${i + 1} of ${captures})`);
                await new Promise(r => setTimeout(r, interval));
            } else {
                if (primaryCamera) statusService.updateStatus(source, `Captured (${i + 1} of ${captures})`);
                else statusService.updateStatus(undefined, `Captured (${i + 1} of ${captures})`);
            }
        }

        const totalElapsedTime = (Date.now() - captureStartTime) / 1000;

        if (primaryCamera) {
            statusService.updateStats(primaryCamera, {
                loader: {
                    camera: {
                        [source]: {
                            lastCaptureTime: totalCaptureTime / captures,
                            lastTotalCaptureTime: totalElapsedTime
                        }
                    }
                }
            });
        }
    } else if (loader.type === 'url') {
        const sourceUrl = loader.source;

        if (primaryCamera) statusService.updateStatus(primaryCamera, `Fetching URL ${loaderNum} of ${loaderTotal}: ${sourceUrl}`);
        else statusService.updateStatus(undefined, `Fetching URL ${loaderNum} of ${loaderTotal}: ${sourceUrl}`);

        const urlStartTime = Date.now();
        const { tmpPath, httpCode, fileSize } = await downloadUrlToTempWithMetrics(sourceUrl);
        const urlElapsedTime = (Date.now() - urlStartTime) / 1000;

        files.push(tmpPath);

        if (primaryCamera) {
            const existingLoaderStats = statusService.getStats(primaryCamera).loader || {};
            const existingUrlStats = existingLoaderStats.url || {};
            statusService.updateStats(primaryCamera, {
                loader: {
                    ...existingLoaderStats,
                    url: {
                        ...existingUrlStats,
                        [loaderTypeIndex]: {
                            lastDownloadTime: urlElapsedTime,
                            lastHTTPCode: httpCode,
                            lastFileSize: fileSize
                        }
                    }
                }
            });
        }

        if (primaryCamera) statusService.updateStatus(primaryCamera, `URL fetched (${loaderNum} of ${loaderTotal})`);
        else statusService.updateStatus(undefined, `URL fetched (${loaderNum} of ${loaderTotal})`);
    } else if (loader.type === 'database') {
        const source = loader.source;
        const dbConfig = config.databases?.[source];
        if (!dbConfig) throw new Error(`Unknown database source: ${source}`);
        if (dbConfig.type !== 'mariadb') throw new Error(`Unsupported database type for ${source}: ${dbConfig.type}`);

        if (primaryCamera) statusService.updateStatus(primaryCamera, `Querying DB ${loaderNum} of ${loaderTotal}: ${source}`);
        else statusService.updateStatus(undefined, `Querying DB ${loaderNum} of ${loaderTotal}: ${source}`);

        const query = loader.options?.query;
        if (!query) throw new Error(`Database loader for ${source} missing 'query' option`);

        const attach = loader.options?.attach || 'csv';

        const mariadb = (await import('mariadb')).default || (await import('mariadb'));

        const conn = await mariadb.createConnection({
            host: dbConfig.server,
            port: dbConfig.port || 3306,
            user: dbConfig.username,
            password: dbConfig.password || (dbConfig.password_file ? fs.readFileSync(dbConfig.password_file, 'utf8').trim() : undefined),
            database: dbConfig.database,
        });

        try {
            const queryStartTime = Date.now();
            const rows = await conn.query(query);
            const queryElapsedTime = (Date.now() - queryStartTime) / 1000;

            const resultRows = Array.isArray(rows) ? rows : [rows];
            const rowCount = resultRows.length;

            if (primaryCamera) {
                const existingLoaderStats = statusService.getStats(primaryCamera).loader || {};
                const existingDbStats = existingLoaderStats.database || {};
                const existingSourceStats = existingDbStats[source] || {};
                statusService.updateStats(primaryCamera, {
                    loader: {
                        ...existingLoaderStats,
                        database: {
                            ...existingDbStats,
                            [source]: {
                                ...existingSourceStats,
                                [loaderTypeIndex]: {
                                    lastQueryTime: queryElapsedTime,
                                    lastQueryRows: rowCount
                                }
                            }
                        }
                    }
                });
            }

            if (attach === 'csv') {
                const csv = rowsToCsv(resultRows);
                const os = await import('os');
                const path = await import('path');
                const tmpName = `mqttai_db_${source}_${Date.now()}_${Math.round(Math.random() * 10000)}.csv`;
                const tmpPath = path.join(os.tmpdir(), tmpName);
                fs.writeFileSync(tmpPath, csv);
                files.push(tmpPath);
            } else {
                promptAdditions.push(`\n\nDatabase ${source} query results:\n${rowsToCsv(resultRows)}`);
            }
        } finally {
            try { await conn.end(); } catch (e) { logger.warn(`Error closing DB connection: ${e}`); }
        }
    } else if (loader.type === 'mqtt') {
        const source = loader.source;
        if (!source) throw new Error('MQTT loader requires a "source" topic');

        const topic = source.startsWith(config.mqtt.basetopic) ? source : `${config.mqtt.basetopic}/${source}`;
        const timeout = loader.options?.timeout || 5000;
        const attach = loader.options?.attach || 'inline';

        logger.info(`Fetching MQTT topic '${topic}' for loader`);

        if (primaryCamera) statusService.updateStatus(primaryCamera, `Fetching MQTT topic: ${topic}`);
        else statusService.updateStatus(undefined, `Fetching MQTT topic: ${topic}`);

        const { payload: mqttPayload, isBinary } = await mqttService.fetchTopicMessage(topic, timeout);

        if (primaryCamera) statusService.updateStatus(primaryCamera, 'MQTT topic fetched');
        else statusService.updateStatus(undefined, 'MQTT topic fetched');

        if (isBinary && Buffer.isBuffer(mqttPayload)) {
            const buf: Buffer = mqttPayload as Buffer;
            const mime = detectMime(buf);

            if (attach === 'inline') {
                promptAdditions.push(`\n\nMQTT topic ${topic} returned binary data (base64): ${buf.toString('base64')}`);
            } else {
                const tmpPath = await writeBufferToTemp(buf, topic, mime);
                files.push(tmpPath);
            }
        } else {
            const text = String(mqttPayload);
            if (attach === 'inline') {
                promptAdditions.push(`\n\nMQTT topic ${topic} contents:\n${text}`);
            } else {
                const tmpPath = await writeBufferToTemp(Buffer.from(text, 'utf8'), topic, 'text/plain');
                files.push(tmpPath);
            }
        }
    } else {
        logger.warn(`Unknown loader type: ${loader.type}`);
    }

    return { files, promptAdditions };
}

/**
 * Process immediate loaders for a queued task in the background.
 * Only processes loaders with immediate: true, before the task reaches the front of the queue.
 */
async function processImmediateLoaders(payload: any): Promise<ImmediateLoaderResult> {
    const result: ImmediateLoaderResult = {
        files: [],
        promptAdditions: [],
        processedIndices: new Set(),
    };

    try {
        // Resolve the task payload to get the full loader list
        const { resolved, error } = resolveTaskPayload(payload);
        if (error) {
            logger.warn(`Cannot process immediate loaders: ${error}`);
            return result;
        }

        const loaders = resolved.prompt?.loader;
        if (!loaders || !Array.isArray(loaders)) return result;

        const primaryCamera = loaders.find((l: any) => l.type === 'camera')?.source;

        for (let lIdx = 0; lIdx < loaders.length; lIdx++) {
            const loader = loaders[lIdx];
            if (!loader.immediate) continue;

            // Compute type-specific index (count all loaders of same type up to this index)
            let typeIndex = 0;
            for (let i = 0; i <= lIdx; i++) {
                if (loaders[i].type === loader.type) typeIndex++;
            }

            logger.info(`Processing immediate loader ${lIdx + 1} of ${loaders.length} (${loader.type})`);

            const loaderResult = await processLoaderItem(
                loader, lIdx + 1, loaders.length, typeIndex, primaryCamera
            );

            result.files.push(...loaderResult.files);
            result.promptAdditions.push(...loaderResult.promptAdditions);
            result.processedIndices.add(lIdx);
        }

        logger.info(`Immediate loader processing complete: ${result.processedIndices.size} loaders processed, ${result.files.length} files collected`);
    } catch (err) {
        logger.error(`Error processing immediate loaders: ${err}`);
    }

    return result;
}

export async function processPayload(payload: any, preProcessed?: ImmediateLoaderResult) {
    const startTime = Date.now();

    // Task resolution: if payload references a task, merge task template with payload overrides
    if (payload.task && typeof payload.task === 'string') {
        const { resolved, taskName, error } = resolveTaskPayload(payload);

        if (error) {
            logger.error(`Unknown task referenced: ${taskName}`);
            mqttService.publish(`${config.mqtt.basetopic}/OUTPUT`, JSON.stringify({
                tag: payload.tag,
                error
            }), false);
            return { skipped: true };
        }

        logger.info(`Resolving task template: ${taskName}`);
        payload = resolved;
        logger.debug(`Task ${taskName} resolved with overrides: ${JSON.stringify(payload)}`);
    }

    // Sanitize and set the current processing topic for PROGRESS/STATS routing
    currentProcessingTopic = null;
    if (payload.topic && typeof payload.topic === 'string') {
        const sanitized = sanitizeTopic(payload.topic);
        if (sanitized) {
            currentProcessingTopic = sanitized;
            logger.debug(`Using topic "${sanitized}" for OUTPUT/PROGRESS/STATS routing`);
        } else {
            logger.warn(`Invalid payload.topic provided: ${payload.topic} - will use base topics`);
            // notify subscribers via MQTT that the requested subtopic was invalid and we're falling back
            try {
                mqttService.publish(`${config.mqtt.basetopic}/OUTPUT`, JSON.stringify({ tag: payload.tag || '', warning: `Invalid topic specified: ${payload.topic}` }), false);
            } catch (e) {
                logger.warn(`Failed to publish invalid-topic warning: ${e}`);
            }
        }
    }

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
            mqttService.publish(`${config.mqtt.basetopic}/OUTPUT`, JSON.stringify({ tag: payload.tag || '', error: 'Missing prompt.template and prompt.text' }), false);
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
                mqttService.publish(`${config.mqtt.basetopic}/OUTPUT`, JSON.stringify({ tag: payload.tag || '', error: `Unknown prompt template(s)` }), false);
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
                            properties: buildJsonSchemaUtil(payload.prompt.output),
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
            // templateModel is set from last (rightmost) template that specified a model (child overrides parent)
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

            // Inject pre-processed immediate loader results
            if (preProcessed) {
                tempFiles.push(...preProcessed.files);
                for (const addition of preProcessed.promptAdditions) {
                    promptText = `${promptText}${addition}`;
                }
            }

            // Loader type counters (1-based index per type)
            const loaderTypeCounters: Record<string, number> = {};

            for (let lIdx = 0; lIdx < payload.prompt.loader.length; lIdx++) {
                const loader = payload.prompt.loader[lIdx];
                const loaderNum = lIdx + 1;
                const loaderTotal = payload.prompt.loader.length;

                // Increment counter for this loader type
                if (!loaderTypeCounters[loader.type]) loaderTypeCounters[loader.type] = 0;
                loaderTypeCounters[loader.type]++;
                const loaderTypeIndex = loaderTypeCounters[loader.type];

                // Skip loaders already processed as immediate
                if (preProcessed?.processedIndices.has(lIdx)) continue;

                // Delegate to the shared loader processor
                const loaderResult = await processLoaderItem(loader, loaderNum, loaderTotal, loaderTypeIndex, primaryCamera);

                tempFiles.push(...loaderResult.files);
                for (const addition of loaderResult.promptAdditions) {
                    promptText = `${promptText}${addition}`;
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
        const structured = extractStructuredFromAiResponseUtil(response, responseFormat);

        const out = {
            tag: payload.tag || '',
            time: totalTime,
            model: usedModel,
            text: extractTextFromAiResponse(response),
            json: structured || null,
        };

        // Determine output topic: use currentProcessingTopic if available
        let outputTopic = `${config.mqtt.basetopic}/OUTPUT`;
        if (currentProcessingTopic) {
            outputTopic = `${config.mqtt.basetopic}/OUTPUT/${currentProcessingTopic}`;
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
    } finally {
        // Clear the current processing topic after processing is complete
        currentProcessingTopic = null;
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

    const entry = inputQueue.shift()!;
    const payload = entry.payload;
    logger.info(`Processing INPUT payload with tag="${payload?.tag}"`);

    try {
        // If immediate loaders were pre-processed, await their results
        let preProcessed: ImmediateLoaderResult | undefined;
        if (entry.immediateFilesPromise) {
            logger.info(`Awaiting immediate loader results for tag="${payload?.tag}"`);
            preProcessed = await entry.immediateFilesPromise;
            logger.info(`Immediate loader results ready: ${preProcessed.files.length} files, ${preProcessed.processedIndices.size} loaders pre-processed`);
        }

        await processPayload(payload, preProcessed);
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
async function downloadUrlToTempWithMetrics(url: string): Promise<{ tmpPath: string; httpCode: number; fileSize: number }> {
    const axios = (await import('axios')).default;
    const os = await import('os');
    const path = await import('path');

    const parsedPath = path.parse(url.split('?')[0]);
    const ext = parsedPath.ext || '';
    const tmpName = `mqttai_url_${Date.now()}_${Math.round(Math.random() * 10000)}${ext}`;
    const tmpPath = path.join(os.tmpdir(), tmpName);

    const response = await axios.get(url, { responseType: 'arraybuffer', validateStatus: () => true });
    const buffer = Buffer.from(response.data);
    fs.writeFileSync(tmpPath, buffer);

    return {
        tmpPath,
        httpCode: response.status,
        fileSize: buffer.length
    };
}

// Graceful shutdown function
async function gracefulShutdown(signal: string) {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    try {
        // Reset PROGRESS to Idle before disconnecting so it doesn't linger with a camera name
        mqttService.publish(`${config.mqtt.basetopic}/PROGRESS`, 'Offline', true);

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
