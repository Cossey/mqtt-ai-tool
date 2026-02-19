import { MqttClient, connect } from 'mqtt';
import { EventEmitter } from 'events';
import { MqttConfig, CameraStats } from '../types';
import { logger } from '../utils/logger';
import fs from 'fs';

export class MqttService extends EventEmitter {
    private client!: MqttClient;
    private config: MqttConfig;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = -1;
    private reconnectInterval = 5000;

    constructor(config: MqttConfig) {
        super();
        this.config = config;
        logger.info('Initializing MQTT service...');
        logger.debug(`Base topic configured as: "${this.config.basetopic}"`);
        logger.debug(`Expected topic structure: ${this.config.basetopic}/<SUBTOPIC> (INPUT/OUTPUT/STATS/QUEUED)`);
        this.initializeConnection();
    }

    private sanitizeMqttConfig(): string {
        const user = (this.config as any).username || (this.config as any).user;
        return `mqtt://${user ? '*****' : 'anonymous'}:*****@${this.config.server}:${this.config.port}`;
    }

    private initializeConnection() {
        try {
            logger.info(`Connecting to MQTT broker at ${this.config.server}:${this.config.port}`);
            logger.debug(`MQTT connection string: ${this.sanitizeMqttConfig()}`);

            const onlineTopic = `${this.config.basetopic}/ONLINE`;

            this.client = connect(`mqtt://${this.config.server}:${this.config.port}`, {
                username: this.config.username,
                password: this.config.password || (this.config.password_file ? fs.readFileSync(this.config.password_file, 'utf8').trim() : undefined),
                clientId: this.config.client,
                reconnectPeriod: this.reconnectInterval,
                connectTimeout: 30000,
                keepalive: 60,
                clean: true,
                rejectUnauthorized: false,
                // Last Will and Testament configuration
                will: {
                    topic: onlineTopic,
                    payload: 'NO',
                    qos: 1,
                    retain: true,
                },
            });

            this.client.on('connect', () => {
                logger.info('Connected to MQTT broker successfully');
                this.reconnectAttempts = 0;

                // Publish online status as "YES" when connected
                this.publish(onlineTopic, 'YES', true);
                logger.info(`Published online status to: ${onlineTopic}`);

                // Subscribe to the single INPUT topic for JSON requests
                const inputTopic = `${this.config.basetopic}/INPUT`;
                logger.debug(`Subscribing to input topic: "${inputTopic}"`);
                this.subscribe(inputTopic);

                // Initialize status topics
                const queuedTopic = `${this.config.basetopic}/QUEUED`;
                this.publish(queuedTopic, '0', true);

                this.emit('connected');
            });

            this.client.on('reconnect', () => {
                this.reconnectAttempts++;
                logger.info(`Attempting to reconnect to MQTT broker (attempt ${this.reconnectAttempts})...`);
            });

            this.client.on('offline', () => {
                logger.warn('MQTT client is offline, will attempt to reconnect...');
            });

            this.client.on('error', (error) => {
                logger.error(`MQTT connection issue: ${error.message}. Retrying...`);
            });

            this.client.on('message', (topic: string, message: unknown) => {
                // Log binary payloads generically; no per-camera image topics are assumed anymore
                if (Buffer.isBuffer(message)) {
                    logger.debug(`Received MQTT message - Topic: "${topic}", Binary data: ${message.length} bytes`);
                    this.handleMessage(topic, message.toString());
                } else {
                    logger.debug(`Received MQTT message - Topic: "${topic}", Message: "${String(message)}"`);
                    this.handleMessage(topic, String(message));
                }
            });
        } catch (error) {
            logger.error(`Failed to initialize MQTT connection: ${error}. Retrying in ${this.reconnectInterval}ms...`);
            setTimeout(() => this.initializeConnection(), this.reconnectInterval);
        }
    }


    private handleMessage(topic: string, message: string, isBinaryTopic: boolean = false) {
        // No per-camera binary/image topic handling — all inputs come via the global INPUT topic
        if (isBinaryTopic) {
            logger.debug(`Ignoring binary image topic: "${topic}"`);
            return;
        }

        logger.debug(`Processing message - Topic: "${topic}", Message: "${message}"`);

        // Check if topic starts with our configured basetopic
        if (!topic.startsWith(this.config.basetopic + '/')) {
            logger.warn(`Topic "${topic}" does not start with configured basetopic: "${this.config.basetopic}"`);
            return;
        }

        // Remove the basetopic from the beginning to get the remaining path
        const targetTopic = topic.substring(this.config.basetopic.length + 1);

        // Check for simple single-topic commands under the base topic
        if (targetTopic === 'INPUT') {
            logger.info('Received INPUT message');
            try {
                const payload = JSON.parse(message);

                // Ignore empty initialization payloads (empty objects or objects without prompt)
                if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) {
                    logger.debug('Ignoring empty INPUT payload (initialization message)');
                    return;
                }

                // Check if this is just an initialization message without actual content
                if (!payload.prompt && !payload.task && !payload.ai && !payload.topic) {
                    logger.debug('Ignoring INPUT payload without required fields (initialization message)');
                    return;
                }

                this.emit('input', payload);
            } catch (error) {
                logger.error(`Failed to parse INPUT payload as JSON: ${error}`);
            }
            return;
        }

        if (targetTopic.toUpperCase() === 'ONLINE') {
            logger.debug(`Ignoring online status topic: "${topic}"`);
            return;
        }

        logger.debug(`Non-INPUT message on topic: "${targetTopic}"`);
        // we ignore other non-binary messages by default
        return;
    }

    public subscribe(topic: string) {
        if (this.client && this.client.connected) {
            this.client.subscribe(topic, (err) => {
                if (err) {
                    logger.error(`Failed to subscribe to ${topic}: ${err.message}`);
                } else {
                    logger.info(`Successfully subscribed to: "${topic}"`);
                }
            });
        } else {
            logger.warn(`Cannot subscribe to ${topic}: MQTT client not connected`);
        }
    }

    /**
     * Fetch a single message from an arbitrary MQTT topic. Subscribes to the topic,
     * waits for the first message or times out, then unsubscribes.
     */
    public async fetchTopicMessage(topic: string, timeoutMs: number = 5000): Promise<{ payload: Buffer | string; isBinary: boolean }> {
        return new Promise((resolve, reject) => {
            if (!this.client || !this.client.connected) {
                return reject(new Error('MQTT client not connected'));
            }

            let finished = false;
            const onMessage = (t: string, payload: Buffer) => {
                if (t === topic) {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    this.client.removeListener('message', onMessage);
                    try {
                        this.client.unsubscribe(topic);
                    } catch (e) {
                        logger.warn(`Error unsubscribing from ${topic}: ${e}`);
                    }
                    const isBinary = Buffer.isBuffer(payload);
                    resolve({ payload, isBinary });
                }
            };

            const timer = setTimeout(() => {
                if (finished) return;
                finished = true;
                this.client.removeListener('message', onMessage);
                try {
                    this.client.unsubscribe(topic);
                } catch (e) {
                    logger.warn(`Error unsubscribing (timeout) from ${topic}: ${e}`);
                }
                reject(new Error(`Timeout waiting for message on topic ${topic}`));
            }, timeoutMs);

            this.client.on('message', onMessage);
            this.client.subscribe(topic, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.client.removeListener('message', onMessage);
                    reject(err);
                }
            });
        });
    }

    public publish(topic: string, message: string, retain: boolean = false) {
        if (this.client && this.client.connected) {
            logger.info(`Publishing to "${topic}": "${message}"${retain ? ' (retained)' : ''}`);
            this.client.publish(topic, message, { retain }, (err) => {
                if (err) {
                    logger.error(`Failed to publish to ${topic}: ${err.message}`);
                } else {
                    logger.debug(`Successfully published to "${topic}"`);
                }
            });
        } else {
            logger.warn(`Cannot publish to ${topic}: MQTT client not connected`);
        }
    }

    public publishBinary(topic: string, data: Buffer, retain: boolean = false) {
        if (this.client && this.client.connected) {
            logger.info(`Publishing binary data to "${topic}": ${data.length} bytes${retain ? ' (retained)' : ''}`);
            this.client.publish(topic, data, { retain }, (err) => {
                if (err) {
                    logger.error(`Failed to publish binary data to ${topic}: ${err.message}`);
                } else {
                    logger.debug(`Successfully published binary data to "${topic}"`);
                }
            });
        } else {
            logger.warn(`Cannot publish binary data to ${topic}: MQTT client not connected`);
        }
    }

    public publishStats(cameraName: string, stats: CameraStats, subtopic?: string | null) {
        let topic = `${this.config.basetopic}/STATS`;
        if (subtopic && typeof subtopic === 'string' && subtopic.length > 0) {
            topic = `${this.config.basetopic}/STATS/${subtopic}`;
        }
        const message = JSON.stringify({ camera: cameraName, stats });
        this.publish(topic, message, true); // Retained
    }

    /**
     * Publish a short progress/status update as plain text (no JSON). Uses the PROGRESS topic and retains the message.
     * If cameraName is provided, the message will be: "<cameraName>: <status>" otherwise it's just the status text.
     * If subtopic is provided, publishes to PROGRESS/<subtopic> instead of PROGRESS.
     */
    public publishProgress(cameraName: string | undefined, status: string, subtopic?: string | null) {
        let topic = `${this.config.basetopic}/PROGRESS`;
        if (subtopic && typeof subtopic === 'string' && subtopic.length > 0) {
            topic = `${this.config.basetopic}/PROGRESS/${subtopic}`;
        }
        const message = cameraName && cameraName.length > 0 ? `${cameraName}: ${status}` : status;
        this.publish(topic, message, true); // Retained
    }

    // Backwards compatibility wrapper (deprecated)
    public publishStatus(cameraName: string | undefined, status: string) {
        logger.warn('publishStatus is deprecated; use publishProgress instead');
        this.publishProgress(cameraName, status);
    }

    public initializeChannels(cameras: Record<string, any>) {
        logger.info(`Initializing MQTT base channels for project...`);
        logger.debug(`Using basetopic: "${this.config.basetopic}"`);

        const inputTopic = `${this.config.basetopic}/INPUT`;
        const outputTopic = `${this.config.basetopic}/OUTPUT`;
        const statsTopic = `${this.config.basetopic}/STATS`;
        const progressTopic = `${this.config.basetopic}/PROGRESS`;
        const queuedTopic = `${this.config.basetopic}/QUEUED`;

        // Initialize retained base topics
        this.publish(inputTopic, JSON.stringify({}), true);
        // do NOT publish an initial base OUTPUT (runtime responses are published non-retained to OUTPUT and subtopics)
        this.publish(statsTopic, JSON.stringify({}), true);
        // PROGRESS is plain text; initialize with a generic Idle message
        this.publish(progressTopic, 'Idle', true);
        this.publish(queuedTopic, '0', true);

        // Initialize per-camera progress entries (retain) so a meaningful PROGRESS message exists early
        if (cameras && Object.keys(cameras).length > 0) {
            Object.keys(cameras).forEach(name => {
                // publish per-camera Idle messages (plain text: "<camera>: Idle")
                this.publish(progressTopic, `${name}: Idle`, true);
            });
        }

        logger.info('Base channel initialization complete');
    }


    public gracefulShutdown() {
        logger.info('Performing graceful MQTT shutdown...');
        if (this.client && this.client.connected) {
            const onlineTopic = `${this.config.basetopic}/ONLINE`;
            // Publish offline status before disconnecting
            this.client.publish(onlineTopic, 'NO', { retain: true }, (err) => {
                if (err) {
                    logger.error(`Failed to publish offline status: ${err.message}`);
                } else {
                    logger.info('Published offline status');
                }
                this.client.end();
            });
        }
    }

    public connect() {
        logger.info('Manual connection requested...');
        if (this.client) {
            this.client.reconnect();
        } else {
            this.initializeConnection();
        }
    }

    public isConnected(): boolean {
        return this.client && this.client.connected;
    }
}
