import { PromptConfig } from '../types';
import { logger } from '../utils/logger';

export function sanitizeOutgoingTopic(t: string): string | null {
    try {
        if (!t || typeof t !== 'string') return null;
        // Trim spaces and leading/trailing slashes
        let s = t.trim();
        s = s.replace(/^\/+/, '').replace(/\/+$/, '');
        if (s.length === 0) return null;
        // Disallow wildcard characters
        if (s.includes('+') || s.includes('#')) return null;
        // Disallow NUL and control chars
        if (/[\u0000-\u001F\u007F]/.test(s)) return null;
        // Replace path separators and colons with underscores
        s = s.replace(/[\/:]+/g, '_');
        // Replace whitespace with underscore
        s = s.replace(/\s+/g, '_');
        // Remove any remaining unsafe characters, allow alphanumeric, underscores, dashes and dots
        s = s.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
        if (s.length === 0) return null;
        return s;
    } catch (e) {
        logger.warn(`sanitizeOutgoingTopic error: ${e}`);
        return null;
    }
}

export function extractStructuredFromAiResponse(resp: any, responseFormat?: any): any {
    try {
        if (!resp) return null;

        // 1) Preferred: top-level 'output' object (OpenAI structured outputs)
        if (resp.output && typeof resp.output === 'object' && Object.keys(resp.output).length > 0) {
            return resp.output;
        }

        // 2) Some APIs return data.output or result.output
        if (resp.data && resp.data.output && typeof resp.data.output === 'object') return resp.data.output;
        if (resp.result && resp.result.output && typeof resp.result.output === 'object') return resp.result.output;

        // 3) Check choices[0].message.content for structured output
        if (resp.choices && resp.choices.length > 0 && resp.choices[0].message) {
            const content = resp.choices[0].message.content;
            if (typeof content === 'object' && Object.keys(content).length > 0) {
                return content; // structured object directly returned
            }
            if (typeof content === 'string') {
                const trimmed = content.trim();
                // Exact JSON object/array
                if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                    try {
                        return JSON.parse(trimmed);
                    } catch (e) {
                        // Not valid JSON
                    }
                }

                // Try to extract the first JSON object-looking substring
                const firstJsonMatch = trimmed.match(/\{[\s\S]*\}/);
                if (firstJsonMatch) {
                    try {
                        return JSON.parse(firstJsonMatch[0]);
                    } catch (e) {
                        // ignore parse errors
                    }
                }
            }
        }

        // If responseFormat indicates json_schema but we couldn't extract, return null rather than raw response
        return null;
    } catch (e) {
        logger.warn(`Failed to extract structured output from AI response: ${e}`);
        return null;
    }
}

export function buildJsonSchema(properties: any): any {
    return Object.fromEntries(
        Object.entries(properties).map(([key, prop]: [string, any]) => [
            key,
            {
                ...prop,
                ...(prop.type === 'object' &&
                    prop.properties && {
                        properties: buildJsonSchema(prop.properties),
                        additionalProperties: false,
                        required: Object.keys(prop.properties),
                    }),
                ...(prop.type === 'array' &&
                    prop.items?.type === 'object' &&
                    prop.items.properties && {
                        items: {
                            ...prop.items,
                            properties: buildJsonSchema(prop.items.properties),
                            additionalProperties: false,
                            required: Object.keys(prop.items.properties),
                        },
                    }),
            },
        ])
    );
}

export function composeTemplateChain(templateNames: string[] | string, promptsConfig: Record<string, PromptConfig> | undefined): { text?: string; model?: string; response_format?: any } {
    const names = Array.isArray(templateNames) ? templateNames : [templateNames];

    if (!promptsConfig) return { text: undefined };

    const configs = names.map((n) => ({ name: n, cfg: promptsConfig[n] || null }));
    const anyFound = configs.some((c) => c.cfg !== null);
    if (!anyFound) return { text: undefined };

    // pick first model/response_format from left-to-right
    let templateModel: string | undefined;
    let templateResponseFormat: any | undefined;
    for (const entry of configs) {
        if (entry.cfg) {
            if (!templateModel && entry.cfg.model) templateModel = entry.cfg.model;
            if (!templateResponseFormat && entry.cfg.response_format) templateResponseFormat = entry.cfg.response_format;
        }
    }

    // compose right-to-left
    let current = '';
    for (let i = configs.length - 1; i >= 0; i--) {
        const entry = configs[i];
        if (!entry.cfg) {
            logger.warn(`Template '${entry.name}' not found, skipping`);
            continue;
        }
        const tText = entry.cfg.prompt || '';
        if (!current) {
            current = tText;
        } else {
            if (/{{\s*template\s*}}/.test(tText)) {
                current = tText.replace(/{{\s*template\s*}}/g, current);
            } else {
                current = `${tText}\n\n${current}`;
            }
        }
    }

    return { text: current, model: templateModel, response_format: templateResponseFormat };
}
