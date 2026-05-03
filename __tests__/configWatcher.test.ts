import fs from 'fs';
import { importAppWithMocks } from './utils/testHelpers';

describe('config reload watcher', () => {
    const originalEnvValue = process.env.MQTT_AI_CONFIG_RELOAD;

    afterEach(() => {
        jest.restoreAllMocks();
        if (originalEnvValue === undefined) {
            delete process.env.MQTT_AI_CONFIG_RELOAD;
        } else {
            process.env.MQTT_AI_CONFIG_RELOAD = originalEnvValue;
        }
    });

    test('enables watcher when MQTT_AI_CONFIG_RELOAD=true', async () => {
        process.env.MQTT_AI_CONFIG_RELOAD = 'true';

        const close = jest.fn();
        const watchSpy = jest.spyOn(fs, 'watch').mockImplementation((() => ({ close } as unknown as fs.FSWatcher)) as any);

        await importAppWithMocks({});

        expect(watchSpy).toHaveBeenCalled();
    });
});
