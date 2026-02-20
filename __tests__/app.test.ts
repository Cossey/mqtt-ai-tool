// Ensure a config file exists for tests (copy sample to config.yaml)
import fs from 'fs';
import path from 'path';
const samplePath = path.join(__dirname, '../config.yaml.sample');
const destPath = path.join(__dirname, '../config.yaml');
if (!fs.existsSync(destPath) && fs.existsSync(samplePath)) {
    fs.copyFileSync(samplePath, destPath);
}

let processPayload: any;
let mqttService: any;
let aiService: any;
let statusService: any;
let cameraService: any;
let config: any;

// Mock the MQTT service so it doesn't attempt a real broker connection during tests
jest.mock('../src/services/mqttService', () => {
    return {
        MqttService: class {
            constructor() {}
            on() {}
            publish(_t: string, _m: string, _r?: boolean) {}
            publishProgress(_c: any, _s: any) {}
            publishStats(_c: any, _s: any) {}
            initializeChannels(_c: any) {}
            async fetchTopicMessage(_t: string, _timeout: number) { return { payload: '', isBinary: false }; }
            gracefulShutdown() {}
        },
    };
});

beforeAll(async () => {
    const app = await import('../src/app');
    processPayload = app.processPayload;
    mqttService = app.mqttService;
    aiService = app.aiService;
    statusService = app.statusService;
    cameraService = app.cameraService;

    const cfg = await import('../src/config/config');
    config = cfg.config;
});

describe('processPayload integration tests (mocked services)', () => {
    beforeEach(() => {
        jest.spyOn(mqttService, 'publish').mockImplementation(() => {});
        jest.spyOn(aiService, 'sendFilesAndPrompt').mockResolvedValue({ choices: [{ message: { content: 'default' } }] } as any);
        jest.spyOn(statusService, 'updateStatus').mockImplementation(() => {});
        jest.spyOn(statusService, 'recordError').mockImplementation(() => {});
        jest.spyOn(statusService, 'recordSuccess').mockImplementation(() => {});
        jest.spyOn(cameraService, 'captureImage').mockResolvedValue('/tmp/fake.jpg');
        jest.spyOn(cameraService, 'cleanupImageFiles').mockResolvedValue(undefined as any);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('skips payload missing prompt and publishes error', async () => {
        await processPayload({ tag: 'noPrompt' } as any);
        expect(mqttService.publish).toHaveBeenCalledWith(`${config.mqtt.basetopic}/OUTPUT`, expect.stringContaining('Missing prompt.template and prompt.text'), false);
    });

    test('skips unknown template and no text', async () => {
        await processPayload({ tag: 'noTemplate', prompt: { template: 'does_not_exist' } } as any);
        expect(mqttService.publish).toHaveBeenCalledWith(`${config.mqtt.basetopic}/OUTPUT`, expect.stringContaining('Unknown prompt template(s)'), false);
    });

    test('structured AI response sets json in output', async () => {
        (aiService.sendFilesAndPrompt as jest.Mock).mockResolvedValue({ choices: [{ message: { content: { Detected: 'Yes' } } }] });
        const res = await processPayload({ tag: 'structured', prompt: { text: 'Analyze image' } } as any);

        // Ensure publish called with OUTPUT and the payload is parseable JSON
        const publishCalls = (mqttService.publish as jest.Mock).mock.calls;
        // Find call that published to OUTPUT (may be only call)
        const outCall = publishCalls.find((c: any) => typeof c[0] === 'string' && c[0].startsWith(`${config.mqtt.basetopic}/OUTPUT`));
        expect(outCall).toBeDefined();
        const outObj = JSON.parse(outCall[1]);
        expect(outObj.json).toEqual({ Detected: 'Yes' });
        expect(outObj.model).toBeDefined();
    });

    test('unstructured AI response results in null json', async () => {
        (aiService.sendFilesAndPrompt as jest.Mock).mockResolvedValue({ choices: [{ message: { content: 'Just some text description' } }] });
        const res = await processPayload({ tag: 'unstructured', prompt: { text: 'Describe' } } as any);

        const publishCalls = (mqttService.publish as jest.Mock).mock.calls;
        const outCall = publishCalls.find((c: any) => typeof c[0] === 'string' && c[0].startsWith(`${config.mqtt.basetopic}/OUTPUT`));
        expect(outCall).toBeDefined();
        const outObj = JSON.parse(outCall[1]);
        expect(outObj.json).toBeNull();
        expect(outObj.text).toMatch(/Just some text/);
    });

    test('OUTPUT tag is empty string when not provided in INPUT', async () => {
        (aiService.sendFilesAndPrompt as jest.Mock).mockResolvedValue({ choices: [{ message: { content: 'OK' } }] });
        await processPayload({ prompt: { text: 'No tag provided' } } as any);

        const publishCalls = (mqttService.publish as jest.Mock).mock.calls;
        const outCall = publishCalls.find((c: any) => typeof c[0] === 'string' && c[0].startsWith(`${config.mqtt.basetopic}/OUTPUT`));
        expect(outCall).toBeDefined();
        const outObj = JSON.parse(outCall[1]);
        expect(outObj.tag).toBe('');
    });

    test('publishes Home Assistant discovery for tasks with ha:true', async () => {
        // enable HA in config and mark a task for discovery
        config.mqtt.homeassistant = 'homeassistant';
        // ensure tasks map exists and enable HA discovery for a gate_motion task (create if missing)
        if (!config.tasks) config.tasks = {} as any;
        if (!config.tasks['gate_motion']) {
            config.tasks['gate_motion'] = { topic: 'gate/security', prompt: { template: 'driveway_motion' } } as any;
        }
        config.tasks['gate_motion'].ha = true;
        expect(config.tasks['gate_motion'].ha).toBe(true);

        // call discovery publisher
        (mqttService.publish as jest.Mock).mockClear();
        await (await import('../src/app')).publishHaDiscovery();

        const publishCalls = (mqttService.publish as jest.Mock).mock.calls;
        const discoveryCalls = publishCalls.filter((c: any) => typeof c[0] === 'string' && c[0].startsWith('homeassistant/sensor/'));
        expect(discoveryCalls.length).toBeGreaterThan(0);

        // find a discovery payload that includes VehicleMovement mapping (from driveway_motion prompt)
        const vehicleDiscovery = discoveryCalls.find((c: any) => String(c[1]).includes('VehicleMovement'));
        expect(vehicleDiscovery).toBeDefined();

        const payload = JSON.parse(vehicleDiscovery[1]);
        // state_topic should point to the task's OUTPUT subtopic (sanitized)
        expect(payload.state_topic).toBe(`${config.mqtt.basetopic}/OUTPUT/gate/security`);
        // value_template should reference the top-level VehicleMovement field
        expect(payload.value_template).toMatch(/value_json\.VehicleMovement/);

    });

    test('HA discovery maps structured output types to HA entity domains', async () => {
        // create a temporary task with various output types
        if (!config.tasks) config.tasks = {} as any;
        config.tasks['ha_type_test'] = {
            topic: 'ha/test',
            ha: true,
            prompt: {
                output: {
                    StringField: { type: 'string' },
                    NumberField: { type: 'number' },
                    IntegerField: { type: 'integer' },
                    BooleanField: { type: 'boolean' },
                    ArrayField: { type: 'array', items: { type: 'string' } },
                    EnumField: { type: 'string', enum: ['A','B'] },
                    ObjectField: { type: 'object', properties: { Value: { type: 'string' } } }
                }
            }
        } as any;

        (mqttService.publish as jest.Mock).mockClear();
        await (await import('../src/app')).publishHaDiscovery();

        const calls = (mqttService.publish as jest.Mock).mock.calls;
        const domains: Record<string, string> = {};
        for (const c of calls) {
            const topic: string = c[0];
            if (!topic.startsWith('homeassistant/')) continue;
            const body = JSON.parse(c[1]);
            const name = body.name as string;
            const prop = name.split(' ')[1];
            const domain = topic.split('/')[1];
            domains[prop] = domain;
        }

        expect(domains.StringField).toBe('text');
        expect(domains.NumberField).toBe('number');
        expect(domains.IntegerField).toBe('number');
        expect(domains.BooleanField).toBe('binary_sensor');
        expect(domains.ArrayField).toBe('sensor');
        expect(domains.EnumField).toBe('sensor');
        expect(domains.ObjectField).toBe('sensor');

        // Enum discovery should include options in the payload
        const enumDiscovery = calls.find((c: any) => String(c[1]).includes('EnumField'));
        expect(enumDiscovery).toBeDefined();
        const enumPayload = JSON.parse(enumDiscovery[1]);
        expect(enumPayload.options).toEqual(expect.arrayContaining(['A','B']));
    });

    test('status updates are emitted for camera loader and output published to sanitized topic', async () => {
        (aiService.sendFilesAndPrompt as jest.Mock).mockResolvedValue({ choices: [{ message: { content: 'OK' } }] });

        const payload = {
            tag: 'cameraTest',
            topic: 'Back/yard:weird',
            prompt: {
                text: 'Camera check',
                loader: [ { type: 'camera', source: Object.keys(config.cameras)[0], options: { captures: 1, interval: 0 } } ]
            }
        } as any;

        const res = await processPayload(payload);

        // Ensure status updates happened with loader/capture counts and lifecycle events
        const statusCalls = (statusService.updateStatus as jest.Mock).mock.calls.map((c: any) => c[1]);
        expect(statusCalls.some((s: string) => s.includes('Processing loader'))).toBeTruthy();
        expect(statusCalls.some((s: string) => s.includes('Capturing (1 of 1)'))).toBeTruthy();
        expect(statusCalls.some((s: string) => s.includes('Publishing response'))).toBeTruthy();
        expect(statusCalls.some((s: string) => s.includes('Cleaning up'))).toBeTruthy();
        // recordSuccess should have been called after cleanup
        expect(statusService.recordSuccess).toHaveBeenCalled();

        // Ensure the publish used a sanitized topic
        const publishCalls = (mqttService.publish as jest.Mock).mock.calls;
        const outCall = publishCalls.find((c: any) => typeof c[0] === 'string' && c[0].startsWith(`${config.mqtt.basetopic}/OUTPUT`));
        expect(outCall).toBeDefined();
        const topicUsed = outCall[0];
        expect(topicUsed).toContain('/OUTPUT/');
        // sub-topic (after /OUTPUT/) should NOT contain ':' but may contain '/'
        const sub = topicUsed.split('/OUTPUT/')[1];
        expect(sub).not.toContain(':');
        expect(sub).toContain('/');
    });
});
