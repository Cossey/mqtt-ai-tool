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
