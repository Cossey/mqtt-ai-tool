import { MqttService } from './services/mqttService';
import { CameraService } from './services/cameraService';
import { AiService } from './services/aiService';
import { StatusService } from './services/statusService';
import { config, loadConfigForRuntimeReload, applyConfigInPlace, resolveConfigPath } from './config/config';
import { logger } from './utils/logger';
import fs from 'fs';
import { composeTemplateChain, sanitizeOutgoingTopic as sanitizeTopic, extractStructuredFromAiResponse as extractStructuredFromAiResponseUtil, buildJsonSchema as buildJsonSchemaUtil } from './utils/promptUtils';

logger.info('==================== MQTT AI Tool starting ====================');

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
    outputArtifacts: LoaderBinaryOutput[];
    processedIndices: Set<number>;
}

interface LoaderBinaryOutput {
    loaderType: string;
    source: string;
    payload: Buffer;
    index?: number;
}

interface QueueEntry {
    payload: any;
    immediateFilesPromise?: Promise<ImmediateLoaderResult>;
}

interface ControlCommand {
    cmd: 'pause' | 'resume' | 'cancel' | 'reload';
    param?: 'all' | 'index' | 'tag' | 'task' | 'immediate';
    name?: string[];
    value?: number;
}

// Input queue for sequential processing
const inputQueue: QueueEntry[] = [];
let processing = false;

// Counters for MQTT status topics
let runningCount = 0;
let immediateCount = 0;

// Control/pause state
let dequeuePaused = false;
let immediateStartPaused = false;
let pauseValue = 0; // -1: paused indefinitely, 0: unpaused, >0: seconds remaining
let pauseCountdownTimer: NodeJS.Timeout | null = null;

// Runtime config reload state
const CONFIG_RELOAD_DEBOUNCE_MS = 1500;
let reloadPauseActive = false;
let reloadInProgress = false;
let reloadPending = false;
let reloadDebounceTimer: NodeJS.Timeout | null = null;
let configWatcher: fs.FSWatcher | null = null;
let watchedConfigPath: string | null = null;

async function initialize() {
    try {
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
            logger.debug('New INPUT received, enqueueing');
            enqueueInput(payload);
        });

        mqttService.on('control', (message: string) => {
            handleControlMessage(message);
        });

        ensureConfigReloadWatcher();

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

export function enqueueInput(payload: any) {
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

    const tagLabel = typeof payload.tag === 'string' && payload.tag.length > 0 ? payload.tag : 'none';
    const taskLabel = typeof payload.task === 'string' && payload.task.length > 0 ? payload.task : 'none';

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
        logger.info(`Processing non-queued INPUT immediately (tag="${tagLabel}", task="${taskLabel}")`);
        runningCount++;
        publishRunningCount();
        processPayload(payload)
            .catch(err => logger.error(`Failed to process non-queued input: ${err}`))
            .finally(() => { runningCount--; publishRunningCount(); });
        return;
    }

    // For queued tasks, check for immediate loaders
    const loaders = payload.prompt?.loader || taskTemplate?.prompt?.loader;
    const hasImmediateLoaders = Array.isArray(loaders) && loaders.some((l: any) => l.immediate === true);

    const entry: QueueEntry = { payload };

    if (hasImmediateLoaders && !immediateStartPaused && !reloadPauseActive) {
        logger.debug(`Starting immediate loader processing for queued INPUT (tag="${payload.tag}")`);
        immediateCount++;
        publishImmediateCount();
        entry.immediateFilesPromise = processImmediateLoaders(payload).finally(() => {
            immediateCount--;
            publishImmediateCount();
        });
    } else if (hasImmediateLoaders && immediateStartPaused) {
        logger.debug(`Immediate loader start is paused; skipping pre-processing for tag="${payload.tag}"`);
    }

    inputQueue.push(entry);
    logger.info(`Queued INPUT at position ${inputQueue.length} (tag="${tagLabel}", task="${taskLabel}")`);
    publishQueueCount();
    if (!processing) {
        processNextInput().catch(err => logger.error(`Failed to process next input: ${err}`));
    }
}

function publishQueueCount() {
    mqttService.publish(`${config.mqtt.basetopic}/QUEUED`, String(inputQueue.length), true);
}

function publishRunningCount() {
    mqttService.publish(`${config.mqtt.basetopic}/RUNNING`, String(runningCount), true);
}

function publishImmediateCount() {
    mqttService.publish(`${config.mqtt.basetopic}/IMMEDIATE`, String(immediateCount), true);
}

function publishPauseValue() {
    mqttService.publish(`${config.mqtt.basetopic}/PAUSE`, String(pauseValue), true);
}

function clearPauseCountdownTimer() {
    if (pauseCountdownTimer) {
        clearInterval(pauseCountdownTimer);
        pauseCountdownTimer = null;
    }
}

function resumeProcessingFromPause() {
    clearPauseCountdownTimer();
    dequeuePaused = false;
    immediateStartPaused = false;
    pauseValue = 0;
    publishPauseValue();

    if (!processing && inputQueue.length > 0) {
        processNextInput().catch(err => logger.error(`Failed to process next input after resume: ${err}`));
    }
}

function applyPause(seconds: number | undefined, pauseImmediate: boolean) {
    clearPauseCountdownTimer();

    dequeuePaused = true;
    immediateStartPaused = pauseImmediate;

    if (seconds === undefined) {
        pauseValue = -1;
        publishPauseValue();
        return;
    }

    pauseValue = seconds;
    publishPauseValue();

    pauseCountdownTimer = setInterval(() => {
        if (pauseValue <= 1) {
            resumeProcessingFromPause();
            return;
        }

        pauseValue -= 1;
        publishPauseValue();
    }, 1000);
}

function parsePositiveInteger(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        return value;
    }

    if (typeof value === 'string') {
        if (!/^[0-9]+$/.test(value)) return undefined;
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }

    return undefined;
}

function normalizeNameList(value: unknown): string[] {
    if (typeof value === 'string') {
        return value.length > 0 ? [value] : [];
    }

    if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
    }

    return [];
}

function parseJsonControlCommand(payload: unknown): ControlCommand | null {
    if (!payload || typeof payload !== 'object') return null;

    const obj = payload as Record<string, unknown>;
    const cmdRaw = typeof obj.cmd === 'string' ? obj.cmd.toLowerCase() : '';
    const paramRaw = typeof obj.param === 'string' ? obj.param.toLowerCase() : undefined;
    const names = normalizeNameList(obj.name);
    const value = parsePositiveInteger(obj.value);

    if (cmdRaw === 'clear') {
        return { cmd: 'cancel', param: 'all' };
    }

    if (cmdRaw === 'resume') {
        return { cmd: 'resume' };
    }

    if (cmdRaw === 'pause') {
        if (paramRaw !== undefined && paramRaw !== 'immediate') return null;
        if (obj.value !== undefined && value === undefined) return null;

        return {
            cmd: 'pause',
            param: paramRaw as ControlCommand['param'] | undefined,
            value,
        };
    }

    if (cmdRaw === 'cancel') {
        if (!paramRaw) return null;

        if (paramRaw === 'all') {
            return { cmd: 'cancel', param: 'all' };
        }

        if (paramRaw === 'index') {
            if (value === undefined) return null;
            return { cmd: 'cancel', param: 'index', value };
        }

        if (paramRaw === 'tag' || paramRaw === 'task') {
            if (names.length === 0) return null;
            return {
                cmd: 'cancel',
                param: paramRaw,
                name: names,
            };
        }

        return null;
    }

    if (cmdRaw === 'reload') {
        if (obj.param !== undefined || obj.value !== undefined || obj.name !== undefined) return null;
        return { cmd: 'reload' };
    }

    return null;
}

function parseTextControlCommand(rawMessage: string): ControlCommand | null {
    const trimmed = rawMessage.trim();
    if (!trimmed) return null;

    const tokens = trimmed.split(/\s+/);
    const cmd = tokens[0].toLowerCase();

    if (cmd === 'resume') {
        return tokens.length === 1 ? { cmd: 'resume' } : null;
    }

    if (cmd === 'clear') {
        return tokens.length === 1 ? { cmd: 'cancel', param: 'all' } : null;
    }

    if (cmd === 'pause') {
        if (tokens.length === 1) return { cmd: 'pause' };

        if (tokens.length === 2) {
            if (tokens[1].toLowerCase() === 'immediate') {
                return { cmd: 'pause', param: 'immediate' };
            }

            const seconds = parsePositiveInteger(tokens[1]);
            return seconds !== undefined ? { cmd: 'pause', value: seconds } : null;
        }

        if (tokens.length === 3) {
            const seconds = parsePositiveInteger(tokens[1]);
            if (seconds !== undefined && tokens[2].toLowerCase() === 'immediate') {
                return { cmd: 'pause', value: seconds, param: 'immediate' };
            }
        }

        return null;
    }

    if (cmd === 'cancel') {
        if (tokens.length === 2 && tokens[1].toLowerCase() === 'all') {
            return { cmd: 'cancel', param: 'all' };
        }

        if (tokens.length === 3) {
            const selector = tokens[1].toLowerCase();
            if (selector === 'index') {
                const index = parsePositiveInteger(tokens[2]);
                return index !== undefined ? { cmd: 'cancel', param: 'index', value: index } : null;
            }

            if (selector === 'tag') {
                return { cmd: 'cancel', param: 'tag', name: [tokens[2]] };
            }

            if (selector === 'task') {
                return { cmd: 'cancel', param: 'task', name: [tokens[2]] };
            }
        }

        return null;
    }

    if (cmd === 'reload') {
        return tokens.length === 1 ? { cmd: 'reload' } : null;
    }

    return null;
}

export function parseControlMessage(rawMessage: string): ControlCommand | null {
    const trimmed = rawMessage.trim();
    if (!trimmed) return null;

    try {
        const parsed = JSON.parse(trimmed);
        const cmd = parseJsonControlCommand(parsed);
        if (cmd) return cmd;
    } catch {
        // If it's not JSON, fall back to text command parsing.
    }

    return parseTextControlCommand(trimmed);
}

async function cleanupTempFilesSafe(filePaths: string[]) {
    const uniquePaths = Array.from(new Set(filePaths));
    if (uniquePaths.length === 0) return;

    try {
        await cameraService.cleanupImageFiles(uniquePaths);
    } catch (err) {
        logger.warn(`Failed to cleanup temporary files: ${err}`);
    }
}

function scheduleCanceledImmediateCleanup(entry: QueueEntry) {
    if (!entry.immediateFilesPromise) return;

    entry.immediateFilesPromise
        .then(async (result) => {
            if (result.files.length > 0) {
                await cleanupTempFilesSafe(result.files);
            }
        })
        .catch((err) => {
            logger.debug(`Immediate loader cleanup skipped due to error after cancel: ${err}`);
        });
}

function applyCancelCommand(command: ControlCommand) {
    const removedEntries: QueueEntry[] = [];

    if (command.param === 'all') {
        removedEntries.push(...inputQueue.splice(0, inputQueue.length));
    } else if (command.param === 'index' && command.value !== undefined) {
        const idx = command.value - 1;
        if (idx >= 0 && idx < inputQueue.length) {
            const [removed] = inputQueue.splice(idx, 1);
            if (removed) removedEntries.push(removed);
        }
    } else if ((command.param === 'tag' || command.param === 'task') && command.name && command.name.length > 0) {
        const nameSet = new Set(command.name);
        for (let i = inputQueue.length - 1; i >= 0; i--) {
            const entry = inputQueue[i];
            const probe = command.param === 'tag' ? entry.payload?.tag : entry.payload?.task;
            if (typeof probe === 'string' && nameSet.has(probe)) {
                const [removed] = inputQueue.splice(i, 1);
                if (removed) removedEntries.push(removed);
            }
        }
    }

    if (removedEntries.length === 0) {
        logger.info(`Cancel command matched no queued inputs (selector=${command.param || 'unknown'})`);
        return;
    }

    logger.info(`Cancel command removed ${removedEntries.length} queued input(s) (selector=${command.param || 'unknown'})`);

    for (const entry of removedEntries) {
        scheduleCanceledImmediateCleanup(entry);
    }

    publishQueueCount();
}

function isConfigReloadWatchEnabled(): boolean {
    return String(process.env.MQTT_AI_CONFIG_RELOAD || '').toLowerCase() === 'true';
}

function clearReloadDebounceTimer() {
    if (reloadDebounceTimer) {
        clearTimeout(reloadDebounceTimer);
        reloadDebounceTimer = null;
    }
}

function closeConfigReloadWatcher() {
    if (configWatcher) {
        try {
            configWatcher.close();
        } catch (err) {
            logger.warn(`Error closing config watcher: ${err}`);
        }
    }

    configWatcher = null;
    watchedConfigPath = null;
}

function ensureConfigReloadWatcher(configPath?: string) {
    if (!isConfigReloadWatchEnabled()) {
        clearReloadDebounceTimer();
        closeConfigReloadWatcher();
        return;
    }

    const nextPath = configPath || resolveConfigPath();
    if (configWatcher && watchedConfigPath === nextPath) {
        return;
    }

    clearReloadDebounceTimer();
    closeConfigReloadWatcher();

    try {
        configWatcher = fs.watch(nextPath, (eventType) => {
            if (eventType !== 'change' && eventType !== 'rename') return;

            logger.info(`Config file change detected (${eventType}), scheduling runtime reload`);
            clearReloadDebounceTimer();
            reloadDebounceTimer = setTimeout(() => {
                reloadDebounceTimer = null;
                requestConfigReload('CONFIG_FILE_CHANGE');
            }, CONFIG_RELOAD_DEBOUNCE_MS);
        });

        watchedConfigPath = nextPath;
        logger.info(`Config file watcher enabled: ${nextPath}`);
    } catch (err) {
        logger.error(`Failed to start config file watcher on ${nextPath}: ${err}`);
    }
}

async function waitForActiveProcessingToDrain() {
    while (processing || runningCount > 0 || immediateCount > 0) {
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}

function resumeAfterReloadPause() {
    reloadPauseActive = false;

    if (!processing && !dequeuePaused && inputQueue.length > 0) {
        processNextInput().catch(err => logger.error(`Failed to process next input after config reload: ${err}`));
    }
}

function friendlyConfigReloadSource(source: string): string {
    switch (source) {
    case 'CONTROL':
        return 'reload command';
    case 'CONFIG_FILE_CHANGE':
        return 'file change';
    case 'SIGHUP':
        return 'SIGHUP';
    case 'QUEUED_RELOAD_REQUEST':
        return 'queued reload request';
    default:
        return source;
    }
}

async function executeConfigReload(source: string) {
    const sourceLabel = friendlyConfigReloadSource(source);
    logger.info(`Config reload requested via ${sourceLabel}`);
    reloadPauseActive = true;

    try {
        await waitForActiveProcessingToDrain();

        const reloadResult = loadConfigForRuntimeReload(config);
        if (!reloadResult.success || !reloadResult.config) {
            logger.warn(`Config reload failed (${sourceLabel}): ${reloadResult.error || 'Unknown error'}`);
            return;
        }

        applyConfigInPlace(config, reloadResult.config);
        aiService.updateBackends(config.ai);

        try {
            publishHaDiscovery();
        } catch (err) {
            logger.warn(`Failed to republish Home Assistant discovery after reload: ${err}`);
        }

        ensureConfigReloadWatcher(reloadResult.configPath);
        logger.info(`Configuration reloaded successfully via ${sourceLabel} from ${reloadResult.configPath}`);
    } finally {
        resumeAfterReloadPause();
    }
}

function requestConfigReload(source: string) {
    if (reloadInProgress) {
        reloadPending = true;
        logger.debug(`Config reload already running; queued another request from ${friendlyConfigReloadSource(source)}`);
        return;
    }

    reloadInProgress = true;

    void (async () => {
        let reloadSource = source;

        try {
            do {
                reloadPending = false;
                await executeConfigReload(reloadSource);
                reloadSource = 'QUEUED_RELOAD_REQUEST';
            } while (reloadPending);
        } catch (err) {
            logger.error(`Unhandled config reload error: ${err}`);
        } finally {
            reloadInProgress = false;
        }
    })();
}

export function handleControlMessage(rawMessage: string) {
    const command = parseControlMessage(rawMessage);
    if (!command) {
        logger.debug(`Ignoring unsupported control message: ${rawMessage}`);
        return;
    }

    if (command.cmd === 'resume') {
        resumeProcessingFromPause();
        return;
    }

    if (command.cmd === 'pause') {
        const pauseImmediate = command.param === 'immediate';
        applyPause(command.value, pauseImmediate);
        return;
    }

    if (command.cmd === 'cancel') {
        applyCancelCommand(command);
        return;
    }

    if (command.cmd === 'reload') {
        requestConfigReload('CONTROL');
    }
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
): Promise<{ files: string[]; promptAdditions: string[]; outputArtifacts: LoaderBinaryOutput[] }> {
    const files: string[] = [];
    const promptAdditions: string[] = [];
    const outputArtifacts: LoaderBinaryOutput[] = [];

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
        const outputEnabled = loader.options?.output === true;

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
            if (outputEnabled) {
                try {
                    const imageBytes = fs.readFileSync(imagePath);
                    outputArtifacts.push({
                        loaderType: 'camera',
                        source,
                        payload: imageBytes,
                        index: captures > 1 ? i + 1 : undefined,
                    });
                } catch (err) {
                    logger.warn(`Failed to read captured image for loader output (${source}): ${err}`);
                }
            }

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
        const outputEnabled = loader.options?.output === true;

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
            const csv = rowsToCsv(resultRows);

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

            if (outputEnabled) {
                outputArtifacts.push({
                    loaderType: 'database',
                    source,
                    payload: Buffer.from(csv, 'utf8'),
                    index: loaderTypeIndex > 1 ? loaderTypeIndex : undefined,
                });
            }

            if (attach === 'csv') {
                const os = await import('os');
                const path = await import('path');
                const tmpName = `mqttai_db_${source}_${Date.now()}_${Math.round(Math.random() * 10000)}.csv`;
                const tmpPath = path.join(os.tmpdir(), tmpName);
                fs.writeFileSync(tmpPath, csv);
                files.push(tmpPath);
            } else {
                promptAdditions.push(`\n\nDatabase ${source} query results:\n${csv}`);
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
        const outputEnabled = loader.options?.output === true;

        logger.debug(`Fetching MQTT topic '${topic}' for loader`);

        if (primaryCamera) statusService.updateStatus(primaryCamera, `Fetching MQTT topic: ${topic}`);
        else statusService.updateStatus(undefined, `Fetching MQTT topic: ${topic}`);

        const { payload: mqttPayload, isBinary } = await mqttService.fetchTopicMessage(topic, timeout);

        if (primaryCamera) statusService.updateStatus(primaryCamera, 'MQTT topic fetched');
        else statusService.updateStatus(undefined, 'MQTT topic fetched');

        if (isBinary && Buffer.isBuffer(mqttPayload)) {
            const buf: Buffer = mqttPayload as Buffer;
            const mime = detectMime(buf);

            if (outputEnabled) {
                outputArtifacts.push({
                    loaderType: 'mqtt',
                    source,
                    payload: buf,
                    index: loaderTypeIndex > 1 ? loaderTypeIndex : undefined,
                });
            }

            if (attach === 'inline') {
                promptAdditions.push(`\n\nMQTT topic ${topic} returned binary data (base64): ${buf.toString('base64')}`);
            } else {
                const tmpPath = await writeBufferToTemp(buf, topic, mime);
                files.push(tmpPath);
            }
        } else {
            const text = String(mqttPayload);
            const textBuffer = Buffer.from(text, 'utf8');

            if (outputEnabled) {
                outputArtifacts.push({
                    loaderType: 'mqtt',
                    source,
                    payload: textBuffer,
                    index: loaderTypeIndex > 1 ? loaderTypeIndex : undefined,
                });
            }

            if (attach === 'inline') {
                promptAdditions.push(`\n\nMQTT topic ${topic} contents:\n${text}`);
            } else {
                const tmpPath = await writeBufferToTemp(textBuffer, topic, 'text/plain');
                files.push(tmpPath);
            }
        }
    } else {
        logger.warn(`Unknown loader type: ${loader.type}`);
    }

    return { files, promptAdditions, outputArtifacts };
}

/**
 * Process immediate loaders for a queued task in the background.
 * Only processes loaders with immediate: true, before the task reaches the front of the queue.
 */
async function processImmediateLoaders(payload: any): Promise<ImmediateLoaderResult> {
    const result: ImmediateLoaderResult = {
        files: [],
        promptAdditions: [],
        outputArtifacts: [],
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

            logger.debug(`Processing immediate loader ${lIdx + 1} of ${loaders.length} (${loader.type})`);

            const loaderResult = await processLoaderItem(
                loader, lIdx + 1, loaders.length, typeIndex, primaryCamera
            );

            result.files.push(...loaderResult.files);
            result.promptAdditions.push(...loaderResult.promptAdditions);
            result.outputArtifacts.push(...loaderResult.outputArtifacts);
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

        logger.debug(`Resolving task template: ${taskName}`);
        payload = resolved;
        logger.debug(`Task ${taskName} resolved with payload overrides`);
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

    const aiFiles: string[] = [];
    const tempFilesToCleanup = new Set<string>();
    let successMetrics: { aiTime: number; totalTime: number } | null = null;

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
        const loaderOutputArtifacts: LoaderBinaryOutput[] = [];

        if (payload.files && Array.isArray(payload.files)) {
            for (const f of payload.files) {
                try {
                    if (fs.existsSync(f)) {
                        aiFiles.push(f);
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
                for (const filePath of preProcessed.files) {
                    aiFiles.push(filePath);
                    tempFilesToCleanup.add(filePath);
                }
                for (const addition of preProcessed.promptAdditions) {
                    promptText = `${promptText}${addition}`;
                }
                loaderOutputArtifacts.push(...(preProcessed.outputArtifacts || []));
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

                for (const filePath of loaderResult.files) {
                    aiFiles.push(filePath);
                    tempFilesToCleanup.add(filePath);
                }
                for (const addition of loaderResult.promptAdditions) {
                    promptText = `${promptText}${addition}`;
                }
                loaderOutputArtifacts.push(...loaderResult.outputArtifacts);
            }
        }

        // Before sending to AI, update status if we have a camera
        if (primaryCamera) statusService.updateStatus(primaryCamera, 'Processing with AI');

        // Determine which model will be used (inline override -> template chain override -> backend default)
        const usedModel = (payload.prompt && payload.prompt.model) || templateModel || aiBackend.model;

        // Send to AI service: delegate to AiService to handle different backends
        const aiStart = Date.now();
        const response = await aiService.sendFilesAndPrompt(aiName, aiFiles, promptText, responseFormat, usedModel);
        const aiEnd = Date.now();

        // Compute timing
        const totalTime = (Date.now() - startTime) / 1000;
        const aiTime = (aiEnd - aiStart) / 1000;

        // Build output object with structured JSON (if available) and model info
        const structured = extractStructuredFromAiResponseUtil(response, responseFormat);

        // Determine loader publish state for OUTPUT envelope
        let loaderState: 'ready' | 'incomplete' | 'none' = 'none';
        const loaderPublishTimeoutMs = Math.max(0, Number(config.mqtt.loader_publish || 0));

        // Determine output topic: use currentProcessingTopic if available
        const outputTopic = buildOutputTopic(currentProcessingTopic);
        if (currentProcessingTopic) {
            logger.debug(`Routing OUTPUT/PROGRESS/STATS via subtopic "${currentProcessingTopic}"`);
        } else {
            logger.debug('Routing OUTPUT/PROGRESS/STATS via base topics');
        }

        // Publish LOADER binary topics first so consumers can fetch on-demand before OUTPUT trigger handling.
        if (loaderOutputArtifacts.length > 0) {
            if (loaderPublishTimeoutMs > 0) {
                logger.debug(`Publishing ${loaderOutputArtifacts.length} LOADER artifact(s) with timeout confirmation (${loaderPublishTimeoutMs}ms)`);
                const publishResults = await Promise.allSettled(loaderOutputArtifacts.map(async (artifact) => {
                    const loaderTopic = buildLoaderOutputTopic(outputTopic, artifact);
                    await mqttService.publishBinaryWithTimeout(loaderTopic, artifact.payload, loaderPublishTimeoutMs, false, 1);
                }));

                const failedCount = publishResults.filter((r) => r.status === 'rejected').length;
                if (failedCount > 0) {
                    loaderState = 'incomplete';
                    logger.warn(`LOADER publish incomplete: failed ${failedCount} of ${loaderOutputArtifacts.length} artifact(s); loader_state="incomplete"`);
                } else {
                    loaderState = 'ready';
                    logger.debug(`LOADER publish confirmed for ${loaderOutputArtifacts.length} artifact(s); loader_state="ready"`);
                }
            } else {
                logger.debug(`Publishing ${loaderOutputArtifacts.length} LOADER artifact(s) in fire-and-forget mode`);
                for (const artifact of loaderOutputArtifacts) {
                    const loaderTopic = buildLoaderOutputTopic(outputTopic, artifact);
                    mqttService.publishBinary(loaderTopic, artifact.payload, false, 1);
                }
                loaderState = 'ready';
                logger.debug(`LOADER publish issued for ${loaderOutputArtifacts.length} artifact(s); loader_state="ready"`);
            }
        } else {
            logger.debug(`No LOADER artifacts for tag="${payload?.tag || ''}"; loader_state="none"`);
        }

        const out = {
            tag: payload.tag || '',
            time: totalTime,
            model: usedModel,
            text: extractTextFromAiResponse(response),
            json: structured || null,
            loader_state: loaderState,
        };

        logger.debug(`Publishing OUTPUT with loader_state="${loaderState}" to topic "${outputTopic}"`);
        mqttService.publish(outputTopic, JSON.stringify(out), false);

        // Publish completion and status updates for camera if applicable
        if (primaryCamera) {
            statusService.updateStatus(primaryCamera, 'Publishing response');
        }

        successMetrics = { aiTime, totalTime };

        const endTime = Date.now();
        logger.info(`INPUT processing completed for tag="${payload?.tag}" in ${(endTime - startTime) / 1000}s`);

        return { outputTopic, out };
    } catch (error) {
        logger.error(`Error processing INPUT payload: ${error}`);
        // Record error on camera stats if we have one
        if (primaryCamera) statusService.recordError(primaryCamera, error as any);
        throw error;
    } finally {
        if (tempFilesToCleanup.size > 0) {
            if (primaryCamera) statusService.updateStatus(primaryCamera, 'Cleaning up');
            await cleanupTempFilesSafe(Array.from(tempFilesToCleanup));
        }

        if (primaryCamera && successMetrics) {
            statusService.recordSuccess(primaryCamera, successMetrics.aiTime, successMetrics.totalTime);
        }

        // Clear the current processing topic after processing is complete
        currentProcessingTopic = null;
    }
}

async function processNextInput() {
    if (dequeuePaused || reloadPauseActive) {
        processing = false;
        return;
    }

    if (inputQueue.length === 0) {
        processing = false;
        return;
    }

    processing = true;

    const entry = inputQueue.shift()!;
    publishQueueCount(); // publish after shift so QUEUED only reflects waiting tasks

    runningCount++;
    publishRunningCount();

    const payload = entry.payload;
    const tagLabel = typeof payload?.tag === 'string' && payload.tag.length > 0 ? payload.tag : 'none';
    const taskLabel = typeof payload?.task === 'string' && payload.task.length > 0 ? payload.task : 'none';
    logger.info(`Dequeued INPUT for processing (tag="${tagLabel}", task="${taskLabel}")`);
    logger.debug(`Processing INPUT payload with tag="${payload?.tag}"`);

    try {
        // If immediate loaders were pre-processed, await their results
        let preProcessed: ImmediateLoaderResult | undefined;
        if (entry.immediateFilesPromise) {
            logger.debug(`Awaiting immediate loader results for tag="${payload?.tag}"`);
            preProcessed = await entry.immediateFilesPromise;
            logger.info(`Immediate loader results ready: ${preProcessed.files.length} files, ${preProcessed.processedIndices.size} loaders pre-processed`);
        }

        await processPayload(payload, preProcessed);
    } catch (error) {
        logger.error(`Error processing INPUT payload: ${error}`);
    } finally {
        // Continue with next input
        processing = false;
        runningCount--;
        publishRunningCount();
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

function buildOutputTopic(currentTopic: string | null): string {
    if (currentTopic && currentTopic.length > 0) {
        return `${config.mqtt.basetopic}/OUTPUT/${currentTopic}`;
    }

    return `${config.mqtt.basetopic}/OUTPUT`;
}

function sanitizeLoaderSegment(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return 'unknown';

    const safe = trimmed
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_\-\.]/g, '_')
        .replace(/^_+|_+$/g, '');

    return safe.length > 0 ? safe : 'unknown';
}

function sanitizeLoaderSourcePath(source: string): string {
    const sanitized = sanitizeTopic(source);
    if (sanitized) return sanitized;

    return sanitizeLoaderSegment(source);
}

function buildLoaderOutputTopic(outputTopic: string, artifact: LoaderBinaryOutput): string {
    const loaderTypeSegment = sanitizeLoaderSegment(artifact.loaderType);
    const sourcePath = sanitizeLoaderSourcePath(artifact.source);
    let topic = `${outputTopic}/LOADER/${loaderTypeSegment}/${sourcePath}`;

    if (artifact.index !== undefined && artifact.index > 0) {
        topic = `${topic}/${artifact.index}`;
    }

    return topic;
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
        clearPauseCountdownTimer();
        clearReloadDebounceTimer();
        closeConfigReloadWatcher();

        // Reset status topics before disconnecting so they don't linger
        mqttService.publish(`${config.mqtt.basetopic}/PROGRESS`, 'Offline', true);
        mqttService.publish(`${config.mqtt.basetopic}/RUNNING`, '0', true);
        mqttService.publish(`${config.mqtt.basetopic}/IMMEDIATE`, '0', true);
        mqttService.publish(`${config.mqtt.basetopic}/PAUSE`, '0', true);

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
process.on('SIGHUP', () => requestConfigReload('SIGHUP'));

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
