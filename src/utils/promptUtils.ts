import { PromptConfig } from '../types';
import { logger } from '../utils/logger';

export function sanitizeOutgoingTopic(t: string): string | null {
    try {
        if (!t || typeof t !== 'string') return null;
        // Trim spaces and leading/trailing slashes
        let s = t.trim();
        s = s.replace(/^\/+|\/+$/g, '');
        if (s.length === 0) return null;
        // Disallow wildcard characters anywhere
        if (s.includes('+') || s.includes('#')) return null;
        // Split into segments and sanitize each segment individually, preserving '/'
        const segments = s.split('/').map(seg => seg.trim()).filter(seg => seg.length > 0);
        if (segments.length === 0) return null;

        const sanitizedSegments: string[] = [];
        for (const seg of segments) {
            // Disallow path traversal tokens
            if (seg === '.' || seg === '..') return null;
            // Disallow NUL and control chars
            if (/^[\u0000-\u001F\u007F]+$/.test(seg)) return null;
            if (/[\u0000-\u001F\u007F]/.test(seg)) return null;
            // Replace whitespace with underscore
            let sseg = seg.replace(/\s+/g, '_');
            // Replace colons with underscore (common in names that include namespaces)
            sseg = sseg.replace(/:+/g, '_');
            // Remove any remaining unsafe characters, allow alphanumeric, underscores, dashes and dots
            sseg = sseg.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
            if (sseg.length === 0) return null;
            sanitizedSegments.push(sseg);
        }

        const result = sanitizedSegments.join('/');
        if (result.length === 0) return null;
        return result;
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

// Merge two property maps (left then right) where right overrides duplicates.
function mergeProperties(left: Record<string, any> | undefined, right: Record<string, any> | undefined): Record<string, any> {
    const out: Record<string, any> = {};
    if (left) {
        for (const [k, v] of Object.entries(left)) {
            out[k] = JSON.parse(JSON.stringify(v));
        }
    }
    if (right) {
        for (const [k, v] of Object.entries(right)) {
            if (out[k] && out[k].type === 'object' && v.type === 'object' && out[k].properties && v.properties) {
                // recursively merge nested object properties (right wins on duplicate subkeys)
                out[k] = {
                    ...out[k],
                    properties: mergeProperties(out[k].properties, v.properties),
                };
                // if the right side defines items/required/other details, copy them across
                if (v.required) out[k].required = v.required.slice();
                if (v.additionalProperties !== undefined) out[k].additionalProperties = v.additionalProperties;
            } else {
                // right side overrides entirely for non-object or conflicting types
                out[k] = JSON.parse(JSON.stringify(v));
            }
        }
    }
    return out;
}

// Merge two JSON-schema objects (both with { type: 'object', properties: {...}, required: [...], additionalProperties: bool })
function mergeJsonSchema(left: any, right: any): any {
    const leftProps = left?.properties || {};
    const rightProps = right?.properties || {};

    // start with left properties then apply right (right wins for duplicates)
    const mergedProperties = mergeProperties(leftProps, rightProps);

    // compute required with last-wins for properties that are re-defined by right
    const requiredMap: Record<string, boolean> = {};

    // initialize from left
    for (const k of Object.keys(leftProps)) {
        requiredMap[k] = Array.isArray(left.required) && left.required.includes(k);
    }

    // apply right (overrides previous entries for keys present in right)
    for (const k of Object.keys(rightProps)) {
        requiredMap[k] = Array.isArray(right.required) && right.required.includes(k);
    }

    const required = Object.entries(requiredMap).filter(([_k, v]) => v).map(([k]) => k);

    return {
        type: 'object',
        properties: mergedProperties,
        additionalProperties: right.additionalProperties !== undefined ? right.additionalProperties : left.additionalProperties,
        required,
    };
}

// Merge multiple response_format objects (supports json_schema merging). Rightmost definitions take precedence for duplicates.
function mergeResponseFormats(formats: any[]): any {
    if (!formats || formats.length === 0) return undefined;
    if (formats.length === 1) return JSON.parse(JSON.stringify(formats[0]));

    // Start from the left and fold-right with last-wins semantics for conflicts
    let acc = JSON.parse(JSON.stringify(formats[0]));
    for (let i = 1; i < formats.length; i++) {
        const next = formats[i];
        if (acc.type === 'json_schema' && next.type === 'json_schema') {
            acc = JSON.parse(JSON.stringify(acc));
            acc.json_schema = acc.json_schema || {};
            acc.json_schema.schema = mergeJsonSchema(acc.json_schema.schema || {}, next.json_schema.schema || {});
            // prefer the rightmost name/strict if present
            acc.json_schema.name = next.json_schema?.name || acc.json_schema.name;
            acc.json_schema.strict = next.json_schema?.strict !== undefined ? next.json_schema.strict : acc.json_schema.strict;
        } else {
            // fallback: types differ or unsupported - last wins
            acc = JSON.parse(JSON.stringify(next));
        }
    }

    return acc;
}

export function composeTemplateChain(templateNames: string[] | string, promptsConfig: Record<string, PromptConfig> | undefined): { text?: string; model?: string; response_format?: any } {
    const names = Array.isArray(templateNames) ? templateNames : [templateNames];

    if (!promptsConfig) return { text: undefined };

    const configs = names.map((n) => ({ name: n, cfg: promptsConfig[n] || null }));
    const anyFound = configs.some((c) => c.cfg !== null);
    if (!anyFound) return { text: undefined };

    // collect model (rightmost wins) and collect all response_format entries for merging
    let templateModel: string | undefined;
    const responseFormats: any[] = [];
    for (const entry of configs) {
        if (entry.cfg) {
            if (entry.cfg.model) templateModel = entry.cfg.model; // overwrite => rightmost wins
            if (entry.cfg.response_format) responseFormats.push(entry.cfg.response_format);
        }
    }

    let templateResponseFormat: any | undefined = undefined;
    if (responseFormats.length === 1) templateResponseFormat = responseFormats[0];
    else if (responseFormats.length > 1) templateResponseFormat = mergeResponseFormats(responseFormats);

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
