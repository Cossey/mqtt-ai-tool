import fs from 'fs';
import path from 'path';
import { config, getBlockedRuntimeMqttChanges, applyConfigInPlace } from '../src/config/config';

const samplePath = path.join(__dirname, '../config.yaml.sample');
const destPath = path.join(__dirname, '../config.yaml');
if (!fs.existsSync(destPath) && fs.existsSync(samplePath)) {
    fs.copyFileSync(samplePath, destPath);
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('config reload helpers', () => {
    test('blocked runtime MQTT field changes are detected', () => {
        const currentConfig = clone(config);
        const nextConfig = clone(config);

        nextConfig.mqtt.basetopic = 'changed-base-topic';
        nextConfig.mqtt.server = 'changed-server';

        const changes = getBlockedRuntimeMqttChanges(currentConfig, nextConfig);
        expect(changes).toEqual(expect.arrayContaining(['basetopic', 'server']));
    });

    test('non-connection MQTT changes are allowed at runtime', () => {
        const currentConfig = clone(config);
        const nextConfig = clone(config);

        nextConfig.mqtt.homeassistant = 'custom-ha-prefix';

        const changes = getBlockedRuntimeMqttChanges(currentConfig, nextConfig);
        expect(changes).toEqual([]);
    });

    test('applyConfigInPlace updates nested values and removes stale keys', () => {
        const target = {
            mqtt: { basetopic: 'old' },
            tasks: { oldTask: { enabled: true } },
        } as any;

        const source = {
            mqtt: { basetopic: 'new' },
            tasks: { newTask: { enabled: true } },
        } as any;

        applyConfigInPlace(target, source);

        expect(target.mqtt.basetopic).toBe('new');
        expect(target.tasks.oldTask).toBeUndefined();
        expect(target.tasks.newTask).toEqual({ enabled: true });
    });
});
