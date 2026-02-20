export interface MqttConfig {
    server: string;
    port: number;
    basetopic: string;
    username?: string; // was 'user'
    password?: string;
    password_file?: string;
    client?: string;
    homeassistant?: string; // Home Assistant discovery prefix (optional)
}

export interface AiConfig {
    endpoint: string;
    token?: string;
    token_file?: string; // optional path to load token from file (e.g., Docker secret)
    type?: string; // e.g., 'openai'
    model?: string; // default model for this AI backend
}

export interface JsonSchemaProperty {
    type: string;
    description?: string;
    enum?: string[];
}

export interface JsonSchema {
    type: string;
    properties: Record<string, JsonSchemaProperty>;
    additionalProperties: boolean;
    required: string[];
}

export interface ResponseFormatSchema {
    type: string;
    json_schema: {
        name: string;
        strict: boolean;
        schema: JsonSchema;
    };
}

export interface PromptConfig {
    model?: string; // optional override
    ai?: string; // ai name from `ai` section
    prompt: string;
    output?: Record<string, JsonSchemaProperty>;
    response_format?: ResponseFormatSchema;
}

export interface CameraDetails {
    url: string; // RTSP or other endpoint without embedded credentials
    username?: string;
    password?: string;
    password_file?: string; // optional path to a file (e.g., Docker secret)
    captures?: number; // Number of images to capture (default: 1)
    interval?: number; // Milliseconds between captures (default: 1000)
}

export type CameraConfig = string | CameraDetails;

export interface DatabaseConfig {
    type: 'mariadb';
    server: string;
    port?: number;
    username?: string;
    password?: string;
    password_file?: string;
    database: string;
}

export interface TaskConfig {
    ai?: string; // AI backend to use
    topic?: string; // Optional topic routing
    ha?: boolean; // expose outputs to Home Assistant discovery (optional, default false)
    prompt: {
        template?: string | string[]; // Prompt template name(s)
        text?: string; // Inline prompt text
        output?: Record<string, JsonSchemaProperty>; // Structured output schema
        model?: string; // Optional model override
        files?: string[]; // Files to attach
        loader?: Array<{
            type: string;
            source: string;
            options?: Record<string, any>;
        }>;
    };
}

export interface Config {
    mqtt: MqttConfig;
    ai: Record<string, AiConfig>;
    cameras: Record<string, CameraConfig>;
    prompts?: Record<string, PromptConfig>;
    databases?: Record<string, DatabaseConfig>;
    tasks?: Record<string, TaskConfig>;
}

export interface AiResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: {
            role: string;
            content: string;
        };
        finish_reason: string;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

export interface CameraStats {
    lastErrorDate?: string; // ISO datetime string
    lastErrorType?: string;
    lastSuccessDate?: string; // ISO datetime string
    lastAiProcessTime?: number; // seconds
    lastTotalProcessTime?: number; // seconds
    loader?: {
        camera?: Record<string, {
            lastCaptureTime?: number; // seconds per single capture (not including intervals)
            lastTotalCaptureTime?: number; // seconds from start to finish of all captures
        }>;
        url?: Record<number, {
            lastDownloadTime?: number; // seconds
            lastHTTPCode?: number; // HTTP response code
            lastFileSize?: number; // bytes
        }>;
        database?: Record<string, Record<number, {
            lastQueryTime?: number; // seconds
            lastQueryRows?: number; // number of rows returned
        }>>;
    };
}

export interface CameraStatusManager {
    updateStatus(cameraName: string | undefined, status: string): void;
    updateStats(cameraName: string, stats: Partial<CameraStats>): void;
    getStats(cameraName: string): CameraStats;
    getStatus(cameraName: string): string;
}