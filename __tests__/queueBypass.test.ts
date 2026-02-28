import fs from 'fs';
import path from 'path';
import { importAppWithMocks } from './utils/testHelpers';

// Ensure a config file exists for tests
const samplePath = path.join(__dirname, '../config.yaml.sample');
const destPath = path.join(__dirname, '../config.yaml');
if (!fs.existsSync(destPath) && fs.existsSync(samplePath)) {
    fs.copyFileSync(samplePath, destPath);
}

describe('Queue bypass (queue: false)', () => {
    test('task with queue: false in config processes immediately without queuing', async () => {
        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };
        const camOverrides = {
            captureImage: jest.fn().mockResolvedValue('/tmp/fake.jpg'),
            cleanupImageFiles: jest.fn().mockResolvedValue(undefined),
        };
        const mqttOverrides = {
            publish: jest.fn(),
            on: jest.fn(),
            initializeChannels: jest.fn(),
        };
        const { app, config } = await importAppWithMocks({ ai: aiOverrides, camera: camOverrides, mqtt: mqttOverrides });

        // Create a task with queue: false
        if (!config.tasks) (config as any).tasks = {} as any;
        config.tasks!['quick_task'] = {
            ai: Object.keys(config.ai)[0],
            queue: false,
            prompt: {
                text: 'Quick check',
            }
        } as any;

        // processPayload should work with queue: false tasks
        const result = await app.processPayload({ task: 'quick_task', tag: 'quick-001' });

        // Should have been processed (not skipped)
        expect(result).toBeDefined();
        expect(result.skipped).toBeUndefined();

        // Output should be published
        const publishCalls = mqttOverrides.publish.mock.calls;
        const outCall = publishCalls.find((c: any) => typeof c[0] === 'string' && c[0].includes('/OUTPUT'));
        expect(outCall).toBeDefined();
    });

    test('payload-level queue: false override processes task directly', async () => {
        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };
        const camOverrides = {
            captureImage: jest.fn().mockResolvedValue('/tmp/fake.jpg'),
            cleanupImageFiles: jest.fn().mockResolvedValue(undefined),
        };

        const { app } = await importAppWithMocks({ ai: aiOverrides, camera: camOverrides });

        // Direct prompt payload (not a task) should still process fine
        const result = await app.processPayload({ tag: 'bypass-001', queue: false, prompt: { text: 'Analyze' } });

        expect(result).toBeDefined();
        expect(result.skipped).toBeUndefined();
    });

    test('resolveTaskPayload merges task template with payload overrides', async () => {
        const { app, config } = await importAppWithMocks({});

        // Create a task
        if (!config.tasks) (config as any).tasks = {} as any;
        config.tasks!['test_resolve'] = {
            ai: Object.keys(config.ai)[0],
            topic: 'test/topic',
            queue: false,
            prompt: {
                text: 'Default text',
                loader: [{ type: 'camera', source: Object.keys(config.cameras)[0] }]
            }
        } as any;

        const { resolved, taskName, error } = app.resolveTaskPayload({
            task: 'test_resolve',
            tag: 'tag1',
            prompt: { text: 'Override text' }
        });

        expect(error).toBeUndefined();
        expect(taskName).toBe('test_resolve');
        expect(resolved.tag).toBe('tag1');
        expect(resolved.prompt.text).toBe('Override text');
        expect(resolved.prompt.loader).toBeDefined();
    });

    test('resolveTaskPayload returns error for unknown task', async () => {
        const { app } = await importAppWithMocks({});

        const { error, taskName } = app.resolveTaskPayload({
            task: 'nonexistent_task',
            tag: 'tag1',
        });

        expect(error).toBe('Unknown task: nonexistent_task');
        expect(taskName).toBe('nonexistent_task');
    });

    test('resolveTaskPayload returns payload unchanged for non-task payloads', async () => {
        const { app } = await importAppWithMocks({});

        const payload = { tag: 'p1', prompt: { text: 'hello' } };
        const { resolved, taskName, error } = app.resolveTaskPayload(payload);

        expect(error).toBeUndefined();
        expect(taskName).toBeUndefined();
        expect(resolved).toBe(payload); // same reference
    });
});

describe('Immediate loader processing', () => {
    test('processPayload skips loaders at pre-processed indices', async () => {
        const capturedPrompt = { value: '' };
        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockImplementation(async (_aiName: string, files: string[], promptText: string) => {
                capturedPrompt.value = promptText;
                return { choices: [{ message: { content: 'ok' } }] };
            }),
        };
        const camOverrides = {
            captureImage: jest.fn().mockResolvedValue('/tmp/fake.jpg'),
            cleanupImageFiles: jest.fn().mockResolvedValue(undefined),
        };

        const { app, config } = await importAppWithMocks({ ai: aiOverrides, camera: camOverrides });

        const payload = {
            tag: 'immediate-test',
            prompt: {
                text: 'Analyze images',
                loader: [
                    { type: 'camera', source: Object.keys(config.cameras)[0], immediate: true, options: { captures: 1, interval: 0 } },
                    { type: 'camera', source: Object.keys(config.cameras)[0], options: { captures: 1, interval: 0 } },
                ]
            }
        };

        // Simulate pre-processed results for loader index 0
        const preProcessed = {
            files: ['/tmp/preProcessed1.jpg'],
            promptAdditions: [],
            processedIndices: new Set([0]),
        };

        await app.processPayload(payload, preProcessed);

        // AI should have been called with 2 files: 1 pre-processed + 1 from the non-immediate loader
        const filesArg = aiOverrides.sendFilesAndPrompt.mock.calls[0][1] as string[];
        expect(filesArg).toContain('/tmp/preProcessed1.jpg');
        expect(filesArg).toContain('/tmp/fake.jpg');
        expect(filesArg.length).toBe(2);

        // captureImage should have been called only once (for the non-immediate loader)
        expect(camOverrides.captureImage).toHaveBeenCalledTimes(1);
    });

    test('processPayload injects prompt additions from pre-processed loaders', async () => {
        const capturedPrompt = { value: '' };
        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockImplementation(async (_aiName: string, _files: string[], promptText: string) => {
                capturedPrompt.value = promptText;
                return { choices: [{ message: { content: 'ok' } }] };
            }),
        };
        const camOverrides = {
            captureImage: jest.fn().mockResolvedValue('/tmp/fake.jpg'),
            cleanupImageFiles: jest.fn().mockResolvedValue(undefined),
        };

        const { app } = await importAppWithMocks({ ai: aiOverrides, camera: camOverrides });

        const payload = {
            tag: 'prompt-additions-test',
            prompt: {
                text: 'Base prompt',
                loader: [
                    { type: 'mqtt', source: 'topic1', immediate: true, options: { attach: 'inline' } },
                ]
            }
        };

        // Simulate pre-processed results with a prompt addition
        const preProcessed = {
            files: [],
            promptAdditions: ['\n\nMQTT topic mqttai/topic1 contents:\nhello world'],
            processedIndices: new Set([0]),
        };

        await app.processPayload(payload, preProcessed);

        // The prompt should include the pre-processed addition
        expect(capturedPrompt.value).toContain('Base prompt');
        expect(capturedPrompt.value).toContain('hello world');
    });

    test('processPayload without preProcessed works normally', async () => {
        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };
        const camOverrides = {
            captureImage: jest.fn().mockResolvedValue('/tmp/fake.jpg'),
            cleanupImageFiles: jest.fn().mockResolvedValue(undefined),
        };

        const { app, config } = await importAppWithMocks({ ai: aiOverrides, camera: camOverrides });

        const payload = {
            tag: 'normal-test',
            prompt: {
                text: 'Normal processing',
                loader: [
                    { type: 'camera', source: Object.keys(config.cameras)[0], options: { captures: 1, interval: 0 } },
                ]
            }
        };

        // No preProcessed - normal behavior
        await app.processPayload(payload);

        expect(camOverrides.captureImage).toHaveBeenCalledTimes(1);
        expect(aiOverrides.sendFilesAndPrompt).toHaveBeenCalledTimes(1);
    });

    test('loaders with immediate: true are only processed once when pre-processed', async () => {
        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };
        const camOverrides = {
            captureImage: jest.fn().mockResolvedValue('/tmp/fake.jpg'),
            cleanupImageFiles: jest.fn().mockResolvedValue(undefined),
        };

        const { app, config } = await importAppWithMocks({ ai: aiOverrides, camera: camOverrides });

        const cameras = Object.keys(config.cameras);
        const payload = {
            tag: 'dedup-test',
            prompt: {
                text: 'Multi-loader test',
                loader: [
                    { type: 'camera', source: cameras[0], immediate: true, options: { captures: 1, interval: 0 } },
                    { type: 'camera', source: cameras[0], immediate: true, options: { captures: 1, interval: 0 } },
                    { type: 'camera', source: cameras[0], options: { captures: 1, interval: 0 } },
                ]
            }
        };

        // Pre-processed: loaders 0 and 1 were immediate
        const preProcessed = {
            files: ['/tmp/pre1.jpg', '/tmp/pre2.jpg'],
            promptAdditions: [],
            processedIndices: new Set([0, 1]),
        };

        await app.processPayload(payload, preProcessed);

        // Only the non-immediate loader (index 2) should call captureImage
        expect(camOverrides.captureImage).toHaveBeenCalledTimes(1);

        // AI should get 3 files total: 2 pre-processed + 1 from non-immediate
        const filesArg = aiOverrides.sendFilesAndPrompt.mock.calls[0][1] as string[];
        expect(filesArg.length).toBe(3);
    });
});

describe('MQTT status topics (QUEUED, RUNNING, IMMEDIATE)', () => {
    test('non-queued task publishes RUNNING incremented then decremented', async () => {
        const publishCalls: Array<[string, string, boolean]> = [];
        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };
        const camOverrides = {
            captureImage: jest.fn().mockResolvedValue('/tmp/fake.jpg'),
            cleanupImageFiles: jest.fn().mockResolvedValue(undefined),
        };
        const mqttOverrides = {
            publish: jest.fn((...args: any[]) => publishCalls.push(args as any)),
            on: jest.fn(),
            initializeChannels: jest.fn(),
        };

        const { app, config } = await importAppWithMocks({ ai: aiOverrides, camera: camOverrides, mqtt: mqttOverrides });

        // Create a non-queued task
        if (!config.tasks) (config as any).tasks = {} as any;
        config.tasks!['unqueued_task'] = {
            ai: Object.keys(config.ai)[0],
            queue: false,
            prompt: { text: 'Fast check' },
        } as any;

        // Use enqueueInput which handles the queue bypass and publishes RUNNING
        app.enqueueInput({ task: 'unqueued_task', tag: 'run-test' });

        // Wait for the non-queued processPayload to complete
        await new Promise(r => setTimeout(r, 200));

        const runningCalls = publishCalls.filter(c => typeof c[0] === 'string' && c[0].endsWith('/RUNNING'));

        // Should have at least an increment (1) and then a decrement (0)
        expect(runningCalls.length).toBeGreaterThanOrEqual(2);
        expect(runningCalls[0][1]).toBe('1');
        expect(runningCalls[runningCalls.length - 1][1]).toBe('0');

        // QUEUED should NOT have been incremented (non-queued task)
        const queuedCalls = publishCalls.filter(c => typeof c[0] === 'string' && c[0].endsWith('/QUEUED'));
        for (const call of queuedCalls) {
            expect(call[1]).toBe('0');
        }
    });

    test('queued task publishes QUEUED then RUNNING during processing', async () => {
        let resolveAi: () => void;
        const aiPromise = new Promise<void>(r => { resolveAi = r; });
        const publishCalls: Array<[string, string, boolean]> = [];
        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockImplementation(async () => {
                await aiPromise;
                return { choices: [{ message: { content: 'ok' } }] };
            }),
        };
        const camOverrides = {
            captureImage: jest.fn().mockResolvedValue('/tmp/fake.jpg'),
            cleanupImageFiles: jest.fn().mockResolvedValue(undefined),
        };
        const mqttOverrides = {
            publish: jest.fn((...args: any[]) => publishCalls.push(args as any)),
            on: jest.fn(),
            initializeChannels: jest.fn(),
        };

        const { app } = await importAppWithMocks({ ai: aiOverrides, camera: camOverrides, mqtt: mqttOverrides });

        // Enqueue a normal (queued) task
        app.enqueueInput({ tag: 'queued-test', prompt: { text: 'Analyze' } });

        // Let processNextInput start
        await new Promise(r => setTimeout(r, 50));

        // At this point the task has been dequeued and is running
        const queuedCalls = publishCalls.filter(c => typeof c[0] === 'string' && c[0].endsWith('/QUEUED'));
        const runningCalls = publishCalls.filter(c => typeof c[0] === 'string' && c[0].endsWith('/RUNNING'));

        // QUEUED should have been 1 initially (on enqueue), then 0 after shift
        expect(queuedCalls.some(c => c[1] === '1')).toBe(true);
        expect(queuedCalls.some(c => c[1] === '0')).toBe(true);

        // RUNNING should be 1 while processing
        expect(runningCalls.some(c => c[1] === '1')).toBe(true);

        // Complete the AI call
        resolveAi!();
        await new Promise(r => setTimeout(r, 100));

        // RUNNING should be back to 0
        const finalRunning = publishCalls.filter(c => typeof c[0] === 'string' && c[0].endsWith('/RUNNING'));
        expect(finalRunning[finalRunning.length - 1][1]).toBe('0');
    });

    test('immediate loaders publish IMMEDIATE count', async () => {
        let resolveLoader: () => void;
        const loaderPromise = new Promise<void>(r => { resolveLoader = r; });
        const publishCalls: Array<[string, string, boolean]> = [];
        const camOverrides = {
            captureImage: jest.fn().mockImplementation(async () => {
                await loaderPromise;
                return '/tmp/fake.jpg';
            }),
            cleanupImageFiles: jest.fn().mockResolvedValue(undefined),
        };
        const aiOverrides = {
            sendFilesAndPrompt: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
        };
        const mqttOverrides = {
            publish: jest.fn((...args: any[]) => publishCalls.push(args as any)),
            on: jest.fn(),
            initializeChannels: jest.fn(),
        };

        const { app, config } = await importAppWithMocks({ ai: aiOverrides, camera: camOverrides, mqtt: mqttOverrides });

        // Create a queued task with an immediate loader
        if (!config.tasks) (config as any).tasks = {} as any;
        config.tasks!['imm_task'] = {
            ai: Object.keys(config.ai)[0],
            prompt: {
                text: 'Check camera',
                loader: [
                    { type: 'camera', source: Object.keys(config.cameras)[0], immediate: true, options: { captures: 1, interval: 0 } },
                ],
            },
        } as any;

        app.enqueueInput({ task: 'imm_task', tag: 'imm-test' });

        // Let the immediate loader start
        await new Promise(r => setTimeout(r, 50));

        // IMMEDIATE should have been published as 1
        const immCalls = publishCalls.filter(c => typeof c[0] === 'string' && c[0].endsWith('/IMMEDIATE'));
        expect(immCalls.some(c => c[1] === '1')).toBe(true);

        // Complete the loader
        resolveLoader!();
        await new Promise(r => setTimeout(r, 200));

        // IMMEDIATE should be back to 0
        const finalImm = publishCalls.filter(c => typeof c[0] === 'string' && c[0].endsWith('/IMMEDIATE'));
        expect(finalImm[finalImm.length - 1][1]).toBe('0');
    });
});
