import fs from 'fs';
import os from 'os';
import path from 'path';
import { importAppWithMocks } from './utils/testHelpers';

describe('Loader tests: MQTT and Database', () => {
    test('MQTT loader inline text attaches inline contents to prompt', async () => {
        const mqttOverrides = {
            fetchTopicMessage: async (_t: string) => ({ payload: 'hello world', isBinary: false }),
            publish: jest.fn(),
            publishProgress: jest.fn(),
            publishStats: jest.fn(),
            on: jest.fn(),
            initializeChannels: jest.fn(),
        };

        const sent = { called: false, prompt: '', files: [] as string[] };
        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockImplementation(async (_aiName: string, files: string[], promptText: string) => {
                sent.called = true;
                sent.files = files;
                sent.prompt = promptText;
                return { choices: [{ message: { content: 'ok' } }] };
            }),
        };

        const { app, config } = await importAppWithMocks({ mqtt: mqttOverrides, ai: aiOverrides });

        const payload = { tag: 'mqttInline', prompt: { text: 'Check', loader: [{ type: 'mqtt', source: 'topic1', options: { attach: 'inline' } }] } } as any;
        await app.processPayload(payload);

        expect(sent.called).toBeTruthy();
        expect(sent.prompt).toMatch(/MQTT topic .*contents/);
        expect(sent.files.length).toBe(0);
    });

    test('MQTT loader file attach writes temp file and passes to AI', async () => {
        const mqttOverrides = {
            fetchTopicMessage: async (_t: string) => ({ payload: Buffer.from([0xff, 0xd8, 0xff, 0xdb]), isBinary: true }),
            publish: jest.fn(),
            on: jest.fn(),
            initializeChannels: jest.fn(),
        };

        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };

        const camOverrides = { cleanupImageFiles: jest.fn().mockResolvedValue(undefined) };
        const { app } = await importAppWithMocks({ mqtt: mqttOverrides, ai: aiOverrides, camera: camOverrides });

        const spy = jest.spyOn(app.aiService, 'sendFilesAndPrompt');

        const payload = { tag: 'mqttFile', prompt: { text: 'Check', loader: [{ type: 'mqtt', source: 'topic1', options: { attach: 'file' } }] } } as any;
        const res = await app.processPayload(payload);

        expect(spy).toHaveBeenCalled();
        const filesArg = (spy.mock.calls[0] as any)[1] as string[];
        expect(filesArg.length).toBeGreaterThan(0);
        // verify file exists and then remove
        for (const f of filesArg) {
            expect(fs.existsSync(f)).toBeTruthy();
            fs.unlinkSync(f);
        }
    });

    test('Database loader inline attaches csv inline to prompt', async () => {
        // mariadb mock
        const rows = [{ A: '1', B: 'x' }, { A: '2', B: 'y' }];
        const mariadbMock = {
            createConnection: async () => ({
                query: async (_q: string) => rows,
                end: async () => {},
            }),
        } as any;

        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };

        const camOverrides = { cleanupImageFiles: jest.fn().mockResolvedValue(undefined) };
        const { app, config } = await importAppWithMocks({ mariadb: mariadbMock, ai: aiOverrides, camera: camOverrides });

        // Avoid reading password_file by setting password directly in config
        if (config?.databases?.main) config.databases.main.password = 'testpass';

        const spy = jest.spyOn(app.aiService, 'sendFilesAndPrompt');

        const payload = { tag: 'dbInline', prompt: { text: 'DB check', loader: [{ type: 'database', source: 'main', options: { query: 'select * from t', attach: 'inline' } }] } } as any;
        await app.processPayload(payload);

        expect(spy).toHaveBeenCalled();
        const promptArg = (spy.mock.calls[0] as any)[2] as string;
        expect(promptArg).toMatch(/Database main query results/);
    });

    test('Database loader csv attachment writes a CSV temp file passed to AI', async () => {
        const rows = [{ A: '1', B: 'x' }];
        const mariadbMock = {
            createConnection: async () => ({
                query: async (_q: string) => rows,
                end: async () => {},
            }),
        } as any;

        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };

        const camOverrides = { cleanupImageFiles: jest.fn().mockResolvedValue(undefined) };
        const { app, config } = await importAppWithMocks({ mariadb: mariadbMock, ai: aiOverrides, camera: camOverrides });

        // Avoid reading password_file by setting password directly in config
        if (config?.databases?.main) config.databases.main.password = 'testpass';

        const spy = jest.spyOn(app.aiService, 'sendFilesAndPrompt');

        const payload = { tag: 'dbCsv', prompt: { text: 'DB csv', loader: [{ type: 'database', source: 'main', options: { query: 'select * from t', attach: 'csv' } }] } } as any;
        await app.processPayload(payload);

        expect(spy).toHaveBeenCalled();
        const filesArg = (spy.mock.calls[0] as any)[1] as string[];
        expect(filesArg.length).toBeGreaterThan(0);
        for (const f of filesArg) {
            expect(fs.existsSync(f)).toBeTruthy();
            fs.unlinkSync(f);
        }
    });

    test('Database loader handles query failure by reporting error', async () => {
        const mariadbMock = {
            createConnection: async () => ({
                query: async (_q: string) => { throw new Error('DB query failed'); },
                end: async () => {},
            }),
        } as any;

        const aiOverrides = { sendFilesAndPrompt: jest.fn() };
        const statusOverrides = {
            updateStatus: jest.fn(),
            recordError: jest.fn(),
            recordSuccess: jest.fn(),
        };
        const camOverrides = { cleanupImageFiles: jest.fn().mockResolvedValue(undefined), captureImage: jest.fn().mockResolvedValue('/tmp/fake.jpg') };

        const { app, config } = await importAppWithMocks({ mariadb: mariadbMock, ai: aiOverrides, status: statusOverrides, camera: camOverrides });
        if (config?.databases?.main) config.databases.main.password = 'testpass';

        const payload = { tag: 'dbQueryFail', prompt: { text: 'DB fail', loader: [ { type: 'camera', source: Object.keys(config.cameras)[0], options: { captures: 1, interval: 0 } }, { type: 'database', source: 'main', options: { query: 'select *', attach: 'inline' } } ] } } as any;

        await expect(app.processPayload(payload)).rejects.toThrow('DB query failed');
        // Ensure we recorded the camera error
        expect(statusOverrides.recordError).toHaveBeenCalled();
    });

    test('Database loader handles connection failure by reporting error', async () => {
        const mariadbMock = {
            createConnection: async () => { throw new Error('connect fail'); },
        } as any;

        const aiOverrides = { sendFilesAndPrompt: jest.fn() };
        const statusOverrides = {
            updateStatus: jest.fn(),
            recordError: jest.fn(),
            recordSuccess: jest.fn(),
        };
        const camOverrides = { cleanupImageFiles: jest.fn().mockResolvedValue(undefined), captureImage: jest.fn().mockResolvedValue('/tmp/fake.jpg') };

        const { app, config } = await importAppWithMocks({ mariadb: mariadbMock, ai: aiOverrides, status: statusOverrides, camera: camOverrides });
        if (config?.databases?.main) config.databases.main.password = 'testpass';

        const payload = { tag: 'dbConnFail', prompt: { text: 'DB conn fail', loader: [ { type: 'camera', source: Object.keys(config.cameras)[0], options: { captures: 1, interval: 0 } }, { type: 'database', source: 'main', options: { query: 'select *', attach: 'inline' } } ] } } as any;

        await expect(app.processPayload(payload)).rejects.toThrow('connect fail');
        expect(statusOverrides.recordError).toHaveBeenCalled();
    });
});

describe('Loader output topic publishing', () => {
    test('MQTT loader publishes LOADER binary before OUTPUT publish with qos=1', async () => {
        const eventLog: string[] = [];
        const mqttOverrides = {
            fetchTopicMessage: async (_t: string) => ({ payload: Buffer.from([0x01, 0x02, 0x03]), isBinary: true }),
            publishBinary: jest.fn().mockImplementation((_topic: string, _payload: Buffer, _retain?: boolean, _qos?: 0 | 1 | 2) => {
                eventLog.push('binary');
            }),
            publish: jest.fn().mockImplementation((_topic: string) => {
                eventLog.push('output');
            }),
            on: jest.fn(),
            initializeChannels: jest.fn(),
        };

        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };

        const { app, config } = await importAppWithMocks({ mqtt: mqttOverrides, ai: aiOverrides });

        await app.processPayload({
            tag: 'outOrder',
            prompt: {
                text: 'Check',
                loader: [{ type: 'mqtt', source: 'topic1', options: { attach: 'inline', output: true } }],
            },
        } as any);

        expect(mqttOverrides.publishBinary).toHaveBeenCalledWith(
            `${config.mqtt.basetopic}/OUTPUT/LOADER/mqtt/topic1`,
            expect.any(Buffer),
            false,
            1
        );

        const binaryIndex = eventLog.indexOf('binary');
        const outputIndex = eventLog.indexOf('output');
        expect(binaryIndex).toBeGreaterThanOrEqual(0);
        expect(outputIndex).toBeGreaterThanOrEqual(0);
        expect(binaryIndex).toBeLessThan(outputIndex);

        const outputCall = mqttOverrides.publish.mock.calls.find((c: any[]) => String(c[0]).includes('/OUTPUT'));
        expect(outputCall).toBeDefined();
        const outputPayload = JSON.parse(outputCall[1]);
        expect(outputPayload.loader_state).toBe('ready');
    });

    test('camera loader publishes one LOADER topic per capture index', async () => {
        const createdImages: string[] = [];
        const cameraName = 'gatecam';

        const camOverrides = {
            captureImage: jest.fn().mockImplementation(async () => {
                const tmpPath = path.join(os.tmpdir(), `mqttai_test_cam_${Date.now()}_${Math.random()}.jpg`);
                fs.writeFileSync(tmpPath, Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
                createdImages.push(tmpPath);
                return tmpPath;
            }),
            cleanupImageFiles: jest.fn().mockResolvedValue(undefined),
        };

        const mqttOverrides = {
            publishBinary: jest.fn(),
            publish: jest.fn(),
            on: jest.fn(),
            initializeChannels: jest.fn(),
        };

        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };

        const { app, config } = await importAppWithMocks({ camera: camOverrides, mqtt: mqttOverrides, ai: aiOverrides });
        config.cameras[cameraName] = config.cameras[cameraName] || config.cameras[Object.keys(config.cameras)[0]];

        await app.processPayload({
            tag: 'camOut',
            prompt: {
                text: 'Check',
                loader: [{ type: 'camera', source: cameraName, options: { captures: 2, interval: 0, output: true } }],
            },
        } as any);

        expect(mqttOverrides.publishBinary).toHaveBeenCalledWith(
            `${config.mqtt.basetopic}/OUTPUT/LOADER/camera/${cameraName}/1`,
            expect.any(Buffer),
            false,
            1
        );
        expect(mqttOverrides.publishBinary).toHaveBeenCalledWith(
            `${config.mqtt.basetopic}/OUTPUT/LOADER/camera/${cameraName}/2`,
            expect.any(Buffer),
            false,
            1
        );

        for (const filePath of createdImages) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    });

    test('database loader publishes CSV bytes to LOADER topic when output is enabled', async () => {
        const rows = [{ A: '1', B: 'x' }];
        const mariadbMock = {
            createConnection: async () => ({
                query: async (_q: string) => rows,
                end: async () => {},
            }),
        } as any;

        const mqttOverrides = {
            publishBinary: jest.fn(),
            publish: jest.fn(),
            on: jest.fn(),
            initializeChannels: jest.fn(),
        };

        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };

        const camOverrides = { cleanupImageFiles: jest.fn().mockResolvedValue(undefined) };
        const { app, config } = await importAppWithMocks({ mariadb: mariadbMock, mqtt: mqttOverrides, ai: aiOverrides, camera: camOverrides });
        if (config?.databases?.main) config.databases.main.password = 'testpass';

        await app.processPayload({
            tag: 'dbOut',
            prompt: {
                text: 'DB output',
                loader: [{ type: 'database', source: 'main', options: { query: 'select * from t', attach: 'inline', output: true } }],
            },
        } as any);

        expect(mqttOverrides.publishBinary).toHaveBeenCalledWith(
            `${config.mqtt.basetopic}/OUTPUT/LOADER/database/main`,
            expect.any(Buffer),
            false,
            1
        );

        const payloadBuffer = mqttOverrides.publishBinary.mock.calls[0][1] as Buffer;
        expect(payloadBuffer.toString('utf8')).toContain('A,B');
    });

    test('loaders without options.output do not publish LOADER binary topics', async () => {
        const mqttOverrides = {
            fetchTopicMessage: async (_t: string) => ({ payload: 'hello', isBinary: false }),
            publishBinary: jest.fn(),
            publish: jest.fn(),
            on: jest.fn(),
            initializeChannels: jest.fn(),
        };

        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };

        const { app } = await importAppWithMocks({ mqtt: mqttOverrides, ai: aiOverrides });

        await app.processPayload({
            tag: 'noOutputFlag',
            prompt: {
                text: 'No output',
                loader: [{ type: 'mqtt', source: 'topic1', options: { attach: 'inline' } }],
            },
        } as any);

        expect(mqttOverrides.publishBinary).not.toHaveBeenCalled();
    });

    test('loader_state is incomplete when mqtt.loader_publish timeout mode is enabled and a LOADER publish fails', async () => {
        const mqttOverrides = {
            fetchTopicMessage: async (_t: string) => ({ payload: Buffer.from([0x01, 0x02, 0x03]), isBinary: true }),
            publishBinaryWithTimeout: jest.fn().mockRejectedValue(new Error('publish timeout')),
            publishBinary: jest.fn(),
            publish: jest.fn(),
            on: jest.fn(),
            initializeChannels: jest.fn(),
        };

        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };

        const { app, config } = await importAppWithMocks({ mqtt: mqttOverrides, ai: aiOverrides });
        config.mqtt.loader_publish = 50;

        await app.processPayload({
            tag: 'timeoutMode',
            prompt: {
                text: 'Check',
                loader: [{ type: 'mqtt', source: 'topic1', options: { attach: 'inline', output: true } }],
            },
        } as any);

        expect(mqttOverrides.publishBinaryWithTimeout).toHaveBeenCalled();
        expect(mqttOverrides.publishBinary).not.toHaveBeenCalled();

        const outputCall = mqttOverrides.publish.mock.calls.find((c: any[]) => String(c[0]).includes('/OUTPUT'));
        expect(outputCall).toBeDefined();
        const outputPayload = JSON.parse(outputCall[1]);
        expect(outputPayload.loader_state).toBe('incomplete');
    });
});
