import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { Config, MqttConfig } from '../types';
import { logger } from '../utils/logger';
import { buildJsonSchema } from '../utils/promptUtils';

// Add sanitization helper
const sanitizeConfig = (config: Config): any => {
    return {
        ...config,
        mqtt: {
            ...config.mqtt,
            username: config.mqtt.username ? '*****' : undefined,
            password: config.mqtt.password ? '*****' : undefined,
            password_file: config.mqtt.password_file ? '*****' : undefined,
        },
        ai: Object.fromEntries(
            Object.entries(config.ai).map(([name, ai]) => [
                name,
                {
                    ...ai,
                    token: ai.token ? '*****' : undefined,
                    token_file: ai.token_file ? '*****' : undefined,
                },
            ])
        ),
        cameras: Object.fromEntries(
            Object.entries(config.cameras).map(([name, cam]) => {
                if (typeof cam === 'string') return [name, sanitizeRtspUrl(cam)];
                return [
                    name,
                    {
                        ...cam,
                        url: sanitizeRtspUrl(cam.url),
                        username: cam.username ? '*****' : undefined,
                        password: cam.password ? '*****' : undefined,
                        password_file: cam.password_file ? '*****' : undefined,
                    },
                ];
            })
        ),
        databases: config.databases
            ? Object.fromEntries(
                  Object.entries(config.databases).map(([name, db]) => [
                      name,
                      {
                          ...db,
                          password: db.password ? '*****' : undefined,
                          password_file: db.password_file ? '*****' : undefined,
                      },
                  ])
              )
            : undefined,
    };
};

const sanitizeRtspUrl = (rtspUrl: string): string => {
    try {
        const url = new URL(rtspUrl);
        if (url.username || url.password) {
            return `${url.protocol}//*****:*****@${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}${url.search || ''}`;
        }
        return rtspUrl;
    } catch (error) {
        return rtspUrl.replace(/rtsp:\/\/.*/, 'rtsp://*****:*****@*****/****');
    }
};

type RuntimeReloadResult = {
    success: boolean;
    configPath: string;
    config?: Config;
    error?: string;
};

const BLOCKED_RUNTIME_MQTT_FIELDS: Array<keyof MqttConfig> = [
    'server',
    'port',
    'basetopic',
    'username',
    'password',
    'password_file',
    'client',
];

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const cloneConfigValue = <T>(value: T): T => {
    if (Array.isArray(value)) {
        return value.map((item) => cloneConfigValue(item)) as T;
    }

    if (isPlainObject(value)) {
        const cloned: Record<string, unknown> = {};
        for (const [key, nested] of Object.entries(value)) {
            cloned[key] = cloneConfigValue(nested);
        }
        return cloned as T;
    }

    return value;
};

const replaceObjectInPlace = (target: Record<string, unknown>, source: Record<string, unknown>) => {
    for (const key of Object.keys(target)) {
        if (!(key in source)) {
            delete target[key];
        }
    }

    for (const [key, value] of Object.entries(source)) {
        if (isPlainObject(value)) {
            if (!isPlainObject(target[key])) {
                target[key] = {};
            }
            replaceObjectInPlace(target[key] as Record<string, unknown>, value);
            continue;
        }

        if (Array.isArray(value)) {
            target[key] = value.map((item) => cloneConfigValue(item));
            continue;
        }

        target[key] = value;
    }
};

const isDockerConfigOverrideActive = (): boolean => !!(process.env.CONFIG_FILE && fs.existsSync('/.dockerenv'));

export const resolveConfigPath = (): string => {
    if (isDockerConfigOverrideActive()) {
        return process.env.CONFIG_FILE as string;
    }

    return path.join(__dirname, '../../config.yaml');
};

const loadConfigFromPath = (configPath: string): Config => {
    if (!fs.existsSync(configPath)) {
        throw new Error(`Configuration file not found: ${configPath}`);
    }

    const fileContents = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(fileContents) as Config;

    // Validate configuration
    if (!config.mqtt || !config.ai || !config.cameras) {
        throw new Error('Invalid configuration: Missing required sections (mqtt, ai, cameras)');
    }

    if (!config.mqtt.server || !config.mqtt.basetopic) {
        throw new Error('Invalid MQTT configuration: Missing server or basetopic');
    }

    // Ensure at least one AI backend exists and is valid
    if (!config.ai || Object.keys(config.ai).length === 0) {
        throw new Error('Invalid configuration: No AI backends configured under `ai`');
    }

    for (const [name, ai] of Object.entries(config.ai)) {
        if (!ai.endpoint) {
            throw new Error(`Invalid AI configuration for ${name}: Missing endpoint`);
        }

        // If token_file is specified, warn if file not present (we'll read it later at runtime)
        if (!ai.token && ai.token_file) {
            try {
                if (!fs.existsSync(ai.token_file)) {
                    logger.warn(`AI backend ${name} specifies token_file '${ai.token_file}' which does not exist`);
                }
            } catch (e) {
                logger.warn(`Could not verify token_file for AI backend ${name}: ${e}`);
            }
        }
    }

    if (!config.cameras || Object.keys(config.cameras).length === 0) {
        throw new Error('Invalid configuration: No cameras configured');
    }

    // Validate camera configs - support both string endpoints and detailed objects
    for (const [name, cam] of Object.entries(config.cameras)) {
        if (typeof cam === 'string') {
            if (!cam || typeof cam !== 'string') {
                throw new Error(`Invalid camera configuration for ${name}: Missing or invalid endpoint`);
            }
        } else if (typeof cam === 'object') {
            if (!cam.url || typeof cam.url !== 'string') {
                throw new Error(`Invalid camera configuration for ${name}: Missing 'url'`);
            }
            if (cam.captures === undefined) cam.captures = 1;
            if (cam.interval === undefined) cam.interval = 1000;
        } else {
            throw new Error(`Invalid camera configuration for ${name}: Must be string or object`);
        }
    }

    // Validate optional databases
    if (config.databases) {
        for (const [name, db] of Object.entries(config.databases)) {
            if (!db.type || db.type !== 'mariadb') {
                throw new Error(`Invalid database configuration for ${name}: unsupported or missing type (only 'mariadb' supported)`);
            }
            if (!db.server || !db.database) {
                throw new Error(`Invalid database configuration for ${name}: missing server or database`);
            }
        }
    }

    processPromptsConfig(config);
    processDatabasesConfig(config);

    // Read MQTT password from file if specified and password not provided
    if (!config.mqtt.password && config.mqtt.password_file) {
        try {
            if (fs.existsSync(config.mqtt.password_file)) {
                config.mqtt.password = fs.readFileSync(config.mqtt.password_file, 'utf8').trim();
                logger.debug('Loaded MQTT password from password_file');
            } else {
                logger.warn(`MQTT password_file '${config.mqtt.password_file}' does not exist`);
            }
        } catch (e) {
            logger.warn(`Could not read MQTT password_file: ${e}`);
        }
    }

    // Ensure port is a number
    if (typeof config.mqtt.port === 'string') {
        const port = parseInt(config.mqtt.port as any, 10);
        if (isNaN(port)) {
            throw new Error('MQTT port must be a valid number');
        }
        config.mqtt.port = port;
    }

    return config;
};

export const getBlockedRuntimeMqttChanges = (currentConfig: Config, nextConfig: Config): string[] => {
    const changed: string[] = [];

    for (const field of BLOCKED_RUNTIME_MQTT_FIELDS) {
        if (currentConfig.mqtt[field] !== nextConfig.mqtt[field]) {
            changed.push(String(field));
        }
    }

    return changed;
};

export const loadConfigForRuntimeReload = (currentConfig: Config): RuntimeReloadResult => {
    const configPath = resolveConfigPath();

    try {
        const nextConfig = loadConfigFromPath(configPath);
        const blocked = getBlockedRuntimeMqttChanges(currentConfig, nextConfig);
        if (blocked.length > 0) {
            return {
                success: false,
                configPath,
                error: `Runtime reload rejected: MQTT fields requiring restart changed: ${blocked.join(', ')}`,
            };
        }

        return {
            success: true,
            configPath,
            config: nextConfig,
        };
    } catch (e) {
        return {
            success: false,
            configPath,
            error: String(e),
        };
    }
};

export const applyConfigInPlace = (target: Config, source: Config) => {
    replaceObjectInPlace(target as unknown as Record<string, unknown>, source as unknown as Record<string, unknown>);
};

const loadConfig = (): Config => {
    const configPath = resolveConfigPath();

    if (isDockerConfigOverrideActive()) {
        logger.info(`Running in Docker: Using config file from environment variable: ${configPath}`);
    } else {
        logger.info(`Using default config file: ${configPath}`);
    }

    try {
        const loaded = loadConfigFromPath(configPath);
        logger.info(`Configuration loaded successfully with ${Object.keys(loaded.cameras).length} cameras`);
        logger.debug(`Configuration summary: ${JSON.stringify(sanitizeConfig(loaded), null, 2)}`);
        return loaded;
    } catch (e) {
        logger.error('Error loading configuration: ' + e);
        process.exit(20);
    }
};

function processPromptsConfig(config: Config) {
    // Validate camera endpoint formats
    for (const [name, cam] of Object.entries(config.cameras)) {
        if (typeof cam === 'string') {
            logger.debug(`Camera ${name}: endpoint=${sanitizeRtspUrl(cam)}`);
        } else {
            logger.debug(`Camera ${name}: endpoint=${sanitizeRtspUrl((cam as any).url)}`);
        }
    }

    // Process prompts: auto-generate response_format if output provided in old-simplified style
    if (config.prompts) {
        for (const [pname, prompt] of Object.entries(config.prompts)) {
            if (!prompt.ai) {
                throw new Error(`Prompt ${pname} missing required 'ai' field referencing an AI backend`);
            }

            if (!config.ai[prompt.ai]) {
                throw new Error(`Prompt ${pname} references unknown AI backend: ${prompt.ai}`);
            }

            if (!prompt.response_format && prompt.output && typeof prompt.output === 'object') {
                prompt.response_format = {
                    type: 'json_schema',
                    json_schema: {
                        name: `${pname}_output`,
                        strict: true,
                        schema: {
                            type: 'object',
                            properties: buildJsonSchema(prompt.output),
                            additionalProperties: false,
                            required: Object.keys(prompt.output),
                        },
                    },
                };
            }
        }
    }

    // Validate tasks configuration
    if (config.tasks) {
        for (const [taskName, task] of Object.entries(config.tasks)) {
            if (!task.prompt) {
                throw new Error(`Task ${taskName} missing required 'prompt' field`);
            }

            // Validate AI backend if specified
            if (task.ai && !config.ai[task.ai]) {
                throw new Error(`Task ${taskName} references unknown AI backend: ${task.ai}`);
            }

            // Validate prompt templates if used
            if (task.prompt.template) {
                const templates = Array.isArray(task.prompt.template) ? task.prompt.template : [task.prompt.template];
                for (const tname of templates) {
                    if (config.prompts && !config.prompts[tname]) {
                        throw new Error(`Task ${taskName} references unknown prompt template: ${tname}`);
                    }
                }
            }

            // Validate camera sources in loaders
            if (task.prompt.loader) {
                for (const loader of task.prompt.loader) {
                    if (loader.type === 'camera' && !config.cameras[loader.source]) {
                        throw new Error(`Task ${taskName} references unknown camera: ${loader.source}`);
                    }
                    if (loader.type === 'database' && (!config.databases || !config.databases[loader.source])) {
                        throw new Error(`Task ${taskName} references unknown database: ${loader.source}`);
                    }
                }
            }

            logger.debug(`Task ${taskName} validated successfully`);
        }
    }
}

function processDatabasesConfig(config: Config) {
    if (!config.databases) return;

    for (const [name, db] of Object.entries(config.databases)) {
        // If password_file is provided, we won't read it here; just log for info
        if (db.password_file) {
            try {
                if (!fs.existsSync(db.password_file)) {
                    logger.warn(`Database ${name} specifies password_file '${db.password_file}' which does not exist`);
                }
            } catch (e) {
                logger.warn(`Could not verify password_file for database ${name}: ${e}`);
            }
        }

        logger.debug(`Database ${name}: type=${db.type}, server=${db.server}${db.port ? `:${db.port}` : ''}, database=${db.database}`);
    }
}

export const config = loadConfig();
