import fs from 'fs';
import path from 'path';

// ensure config exists like other tests
const samplePath = path.join(__dirname, '../config.yaml.sample');
const destPath = path.join(__dirname, '../config.yaml');
if (!fs.existsSync(destPath) && fs.existsSync(samplePath)) {
    fs.copyFileSync(samplePath, destPath);
}

let app: any;
let mqttService: any;
let aiService: any;
let config: any;

beforeAll(async () => {
    const mod = await import('../src/app');
    app = mod;
    mqttService = mod.mqttService;
    aiService = mod.aiService;
    const cfg = await import('../src/config/config');
    config = cfg.config;
});

describe('topic routing for OUTPUT subtopics', () => {
    beforeEach(() => {
        jest.spyOn(mqttService, 'publish').mockImplementation(() => {});
        jest.spyOn(aiService, 'sendFilesAndPrompt').mockResolvedValue({ choices: [{ message: { content: 'ok' } }] } as any);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(() => {
        // ensure MQTT client timers are stopped to allow Jest to exit cleanly
        try {
            if (mqttService && typeof mqttService.gracefulShutdown === 'function') mqttService.gracefulShutdown();
            if (mqttService && mqttService.client && typeof mqttService.client.end === 'function') mqttService.client.end();
        } catch (e) {
            // ignore
        }
    });

    test('publishes to nested subtopic when topic includes / segments', async () => {
        const payload = { tag: 't1', prompt: { text: 'Hello' }, topic: 'BACKYARD/SECURITY' } as any;
        await app.processPayload(payload);

        const publishCalls = (mqttService.publish as jest.Mock).mock.calls;
        const outCall = publishCalls.find((c: any) => typeof c[0] === 'string' && c[0] === `${config.mqtt.basetopic}/OUTPUT/BACKYARD/SECURITY`);
        expect(outCall).toBeDefined();
    });

    test('invalid topic with wildcard falls back to base OUTPUT and publishes warning', async () => {
        const payload = { tag: 't2', prompt: { text: 'Hello' }, topic: 'Bad/+/Topic' } as any;
        await app.processPayload(payload);

        const publishCalls = (mqttService.publish as jest.Mock).mock.calls;
        // there should be a publish to the base OUTPUT for the warning
        const warningCall = publishCalls.find((c: any) => c[0] === `${config.mqtt.basetopic}/OUTPUT` && String(c[1]).includes('Invalid topic specified'));
        expect(warningCall).toBeDefined();

        // and the actual result should also be published to base OUTPUT (since fallback)
        const resultCall = publishCalls.find((c: any) => c[0] === `${config.mqtt.basetopic}/OUTPUT` && String(c[1]).includes('tag":"t2"'));
        expect(resultCall).toBeDefined();
    });
});
