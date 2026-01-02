import path from 'path';
import fs from 'fs';

export type ServiceOverrides = {
    mqtt?: Record<string, any>;
    ai?: Record<string, any>;
    status?: Record<string, any>;
    camera?: Record<string, any>;
    mariadb?: any;
};

export async function importAppWithMocks(overrides: ServiceOverrides = {}) {
    // Ensure test config exists (copy sample if necessary) to avoid loadConfig calling process.exit during imports
    try {
        const samplePath = path.join(__dirname, '../../config.yaml.sample');
        const destPath = path.join(__dirname, '../../config.yaml');
        if (!fs.existsSync(destPath) && fs.existsSync(samplePath)) {
            fs.copyFileSync(samplePath, destPath);
        }
    } catch (e) {
        // ignore any fs errors here; we'll let loadConfig raise if truly missing
    }

    // Reset module registry so mocks take effect
    jest.resetModules();

    // Always mock MqttService with safe defaults and then merge in user overrides
    const mqttDefault = {
        publish: () => {},
        publishProgress: () => {},
        publishStats: () => {},
        on: () => {},
        initializeChannels: () => {},
        fetchTopicMessage: async (_t: string, _timeout: number) => ({ payload: '', isBinary: false }),
        gracefulShutdown: () => {},
    };
    const mqttImpl = { ...mqttDefault, ...(overrides.mqtt || {}) };
    jest.doMock('../../src/services/mqttService', () => ({
        MqttService: class {
            constructor() { Object.assign(this, mqttImpl); }
        },
    }));

    // Mock AiService
    if (overrides.ai) {
        const aiImpl = overrides.ai;
        jest.doMock('../../src/services/aiService', () => ({
            AiService: class {
                constructor() { Object.assign(this, aiImpl); }
            },
        }));
    }

    // Always mock StatusService with safe defaults and merge overrides
    const statusDefault = {
        on: () => {},
        updateStatus: () => {},
        recordError: () => {},
        recordSuccess: () => {},
    };
    const statusImpl = { ...statusDefault, ...(overrides.status || {}) };
    jest.doMock('../../src/services/statusService', () => ({
        StatusService: class {
            constructor() { Object.assign(this, statusImpl); }
        },
    }));

    // Mock CameraService
    if (overrides.camera) {
        const cameraImpl = overrides.camera;
        jest.doMock('../../src/services/cameraService', () => ({
            CameraService: class {
                constructor() { Object.assign(this, cameraImpl); }
            },
        }));
    }

    // Mock mariadb if provided
    if (overrides.mariadb) {
        const m = overrides.mariadb;
        jest.doMock('mariadb', () => ({ default: m, createConnection: m.createConnection }));
    }

    const app = await import('../../src/app');
    const cfg = await import('../../src/config/config');
    return { app, config: cfg.config };
}
