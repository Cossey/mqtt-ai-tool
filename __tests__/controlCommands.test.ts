import fs from 'fs';
import path from 'path';
import { importAppWithMocks } from './utils/testHelpers';

const samplePath = path.join(__dirname, '../config.yaml.sample');
const destPath = path.join(__dirname, '../config.yaml');
if (!fs.existsSync(destPath) && fs.existsSync(samplePath)) {
    fs.copyFileSync(samplePath, destPath);
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('CONTROL command handling', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('parses text and JSON control commands', async () => {
        const { app } = await importAppWithMocks({});

        expect(app.parseControlMessage('cancel index 2')).toEqual({ cmd: 'cancel', param: 'index', value: 2 });
        expect(app.parseControlMessage('pause 15 immediate')).toEqual({ cmd: 'pause', value: 15, param: 'immediate' });
        expect(app.parseControlMessage('{"cmd":"cancel","param":"tag","name":["front door"]}')).toEqual({
            cmd: 'cancel',
            param: 'tag',
            name: ['front door'],
        });
    });

    test('pause countdown publishes PAUSE updates and auto-resumes', async () => {
        jest.useFakeTimers();

        const publishCalls: Array<[string, string, boolean]> = [];
        const mqttOverrides = {
            publish: jest.fn((...args: any[]) => publishCalls.push(args as any)),
            on: jest.fn(),
            initializeChannels: jest.fn(),
        };

        const { app, config } = await importAppWithMocks({ mqtt: mqttOverrides });

        app.handleControlMessage('pause 2 immediate');
        expect(publishCalls.some(c => c[0] === `${config.mqtt.basetopic}/PAUSE` && c[1] === '2')).toBe(true);

        jest.advanceTimersByTime(1000);
        expect(publishCalls.some(c => c[0] === `${config.mqtt.basetopic}/PAUSE` && c[1] === '1')).toBe(true);

        jest.advanceTimersByTime(1000);
        const pauseCalls = publishCalls.filter(c => c[0] === `${config.mqtt.basetopic}/PAUSE`);
        expect(pauseCalls[pauseCalls.length - 1][1]).toBe('0');
    });

    test('cancel index is 1-based oldest-first', async () => {
        const publishCalls: Array<[string, string, boolean]> = [];
        const mqttOverrides = {
            publish: jest.fn((...args: any[]) => publishCalls.push(args as any)),
            on: jest.fn(),
            initializeChannels: jest.fn(),
        };
        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };

        const { app, config } = await importAppWithMocks({ mqtt: mqttOverrides, ai: aiOverrides });

        app.handleControlMessage('pause');
        app.enqueueInput({ tag: 'a', prompt: { text: 'A' } });
        app.enqueueInput({ tag: 'b', prompt: { text: 'B' } });
        app.enqueueInput({ tag: 'c', prompt: { text: 'C' } });

        app.handleControlMessage('cancel index 2');
        app.handleControlMessage('resume');

        await sleep(250);

        const outputCalls = publishCalls.filter(c => c[0].startsWith(`${config.mqtt.basetopic}/OUTPUT`));
        const tags = outputCalls.map(c => JSON.parse(c[1]).tag);
        expect(tags).toEqual(['a', 'c']);
    });

    test('cancel tag supports spaced names via JSON name array', async () => {
        const publishCalls: Array<[string, string, boolean]> = [];
        const mqttOverrides = {
            publish: jest.fn((...args: any[]) => publishCalls.push(args as any)),
            on: jest.fn(),
            initializeChannels: jest.fn(),
        };
        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };

        const { app, config } = await importAppWithMocks({ mqtt: mqttOverrides, ai: aiOverrides });

        app.handleControlMessage('pause');
        app.enqueueInput({ tag: 'front door', prompt: { text: 'front' } });
        app.enqueueInput({ tag: 'garage', prompt: { text: 'garage' } });
        app.enqueueInput({ tag: 'backyard', prompt: { text: 'back' } });

        app.handleControlMessage(JSON.stringify({ cmd: 'cancel', param: 'tag', name: ['front door', 'garage'] }));
        app.handleControlMessage('resume');

        await sleep(250);

        const outputCalls = publishCalls.filter(c => c[0].startsWith(`${config.mqtt.basetopic}/OUTPUT`));
        const tags = outputCalls.map(c => JSON.parse(c[1]).tag);
        expect(tags).toEqual(['backyard']);
    });

    test('pause immediate blocks new immediate-loader starts', async () => {
        const camOverrides = {
            captureImage: jest.fn().mockResolvedValue('/tmp/fake.jpg'),
            cleanupImageFiles: jest.fn().mockResolvedValue(undefined),
        };

        const { app, config } = await importAppWithMocks({ camera: camOverrides });

        if (!config.tasks) (config as any).tasks = {} as any;
        config.tasks!['imm_task'] = {
            ai: Object.keys(config.ai)[0],
            prompt: {
                text: 'Immediate loader test',
                loader: [
                    { type: 'camera', source: Object.keys(config.cameras)[0], immediate: true, options: { captures: 1, interval: 0 } },
                ],
            },
        } as any;

        app.handleControlMessage('pause immediate');
        app.enqueueInput({ task: 'imm_task', tag: 'imm-paused' });

        await sleep(50);
        expect(camOverrides.captureImage).not.toHaveBeenCalled();
    });

    test('cancel on queued entry cleans up immediate-loader files when they complete', async () => {
        let resolveCapture: (path: string) => void;
        const capturePromise = new Promise<string>(resolve => {
            resolveCapture = resolve;
        });

        const camOverrides = {
            captureImage: jest.fn().mockImplementation(async () => capturePromise),
            cleanupImageFiles: jest.fn().mockResolvedValue(undefined),
        };
        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };

        const { app, config } = await importAppWithMocks({ camera: camOverrides, ai: aiOverrides });

        if (!config.tasks) (config as any).tasks = {} as any;
        config.tasks!['imm_cancel_task'] = {
            ai: Object.keys(config.ai)[0],
            prompt: {
                text: 'Immediate cancel test',
                loader: [
                    { type: 'camera', source: Object.keys(config.cameras)[0], immediate: true, options: { captures: 1, interval: 0 } },
                ],
            },
        } as any;

        app.handleControlMessage('pause');
        app.enqueueInput({ task: 'imm_cancel_task', tag: 'cancel-me' });

        await sleep(30);
        app.handleControlMessage('cancel all');

        resolveCapture!('/tmp/immediate.jpg');
        await sleep(80);

        expect(camOverrides.cleanupImageFiles).toHaveBeenCalledWith(expect.arrayContaining(['/tmp/immediate.jpg']));
    });
});
