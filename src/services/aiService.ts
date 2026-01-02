import axios, { AxiosError } from 'axios';
import fs from 'fs';
import { AiResponse, ResponseFormatSchema, AiConfig } from '../types';
import { logger } from '../utils/logger';

export class AiService {
    private aiBackends: Record<string, AiConfig>;

    constructor(aiBackends: Record<string, AiConfig>) {
        this.aiBackends = aiBackends;
        logger.debug(`AI Service initialized with backends: ${Object.keys(aiBackends).join(', ')}`);
    }

    private getBackendConfig(aiName: string): AiConfig {
        const cfg = this.aiBackends[aiName];
        if (!cfg) throw new Error(`AI backend not found: ${aiName}`);

        // If token is missing but token_file is specified, attempt to read it now
        if (!cfg.token && cfg.token_file) {
            try {
                if (fs.existsSync(cfg.token_file)) {
                    cfg.token = fs.readFileSync(cfg.token_file, 'utf8').trim();
                    logger.debug(`Loaded token for AI backend '${aiName}' from token_file`);
                } else {
                    logger.warn(`AI backend '${aiName}' specifies token_file '${cfg.token_file}' which does not exist`);
                }
            } catch (e) {
                logger.warn(`Could not read token_file for AI backend '${aiName}': ${e}`);
            }
        }

        return cfg;
    }

    private mimeTypeForFile(filename: string): string {
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        switch (ext) {
            case 'jpg':
            case 'jpeg':
                return 'image/jpeg';
            case 'png':
                return 'image/png';
            case 'txt':
                return 'text/plain';
            case 'json':
                return 'application/json';
            case 'pdf':
                return 'application/pdf';
            default:
                return 'application/octet-stream';
        }
    }

    public async sendFilesAndPrompt(
        aiName: string,
        filePaths: string[],
        prompt: string,
        responseFormat?: ResponseFormatSchema,
        modelOverride?: string
    ): Promise<any> {
        logger.info(`Preparing to send ${filePaths.length} file(s) to AI backend '${aiName}' with prompt: "${prompt?.slice?.(0, 80)}"`);

        const backend = this.getBackendConfig(aiName);

        // Build content with prompt text
        const content: any[] = [
            {
                type: 'text',
                text: prompt,
            },
        ];

        // Attach files as base64 data URIs when present
        for (const fp of filePaths || []) {
            try {
                const buf = fs.readFileSync(fp);
                const b64 = buf.toString('base64');
                const mime = this.mimeTypeForFile(fp);

                // For images, keep image_url type for backward compatibility
                if (mime.startsWith('image/')) {
                    content.push({
                        type: 'image_url',
                        image_url: { url: `data:${mime};base64,${b64}` },
                    });
                } else {
                    content.push({
                        type: 'file',
                        file: {
                            filename: fp.split('/').pop(),
                            content: `data:${mime};base64,${b64}`,
                        },
                    });
                }
            } catch (err) {
                logger.error(`Failed to read file ${fp}: ${err}`);
            }
        }

        const requestBody: any = {
            model: modelOverride || backend.model,
            messages: [
                {
                    role: 'user',
                    content,
                },
            ],
            max_tokens: 300,
        };

        if (responseFormat) {
            requestBody.response_format = responseFormat;
            logger.debug(`Using structured output with schema: ${responseFormat.json_schema?.name}`);
        }

        logger.info(`Sending request to AI endpoint: ${backend.endpoint}`);

        try {
            const response = await axios.post(backend.endpoint, requestBody, {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: backend.token ? `Bearer ${backend.token}` : undefined,
                },
                timeout: 120000,
            });

            logger.info(`AI response received successfully`);
            logger.debug(`AI response status: ${response.status}`);
            logger.debug(`AI response data: ${JSON.stringify(response.data)}`);

            return response.data;
        } catch (error: unknown) {
            logger.error(`AI service error: ${error}`);

            if (error instanceof AxiosError) {
                logger.error(`AI service HTTP error status: ${error.response?.status}`);
                logger.error(`AI service HTTP error data: ${JSON.stringify(error.response?.data)}`);
            } else if (error instanceof Error) {
                logger.error(`AI service error message: ${error.message}`);
            }

            throw error;
        }
    }

    // Backwards-compatible helpers
    public async sendImageAndPrompt(
        aiName: string,
        imagePath: string,
        prompt: string,
        responseFormat?: ResponseFormatSchema
    ) {
        return this.sendFilesAndPrompt(aiName, [imagePath], prompt, responseFormat);
    }

    public async sendImagesAndPrompt(
        aiName: string,
        imagePaths: string[],
        prompt: string,
        responseFormat?: ResponseFormatSchema
    ) {
        return this.sendFilesAndPrompt(aiName, imagePaths, prompt, responseFormat);
    }
}
