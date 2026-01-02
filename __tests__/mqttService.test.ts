// Unit tests for MQTT service publishProgress formatting
import { MqttService } from '../src/services/mqttService';
import { config } from '../src/config/config';

// Mock mqtt.connect to return a fake client to avoid network in tests
jest.mock('mqtt', () => ({
    connect: jest.fn(() => ({
        connected: true,
        publish: jest.fn((topic: string, message: any, opts: any, cb?: any) => cb && cb()),
        subscribe: jest.fn((t: string, cb: any) => cb && cb(null, {})),
        on: jest.fn(),
        removeListener: jest.fn(),
        end: jest.fn(),
    })),
}));

describe('MqttService publishProgress', () => {
    test('publishes plain text messages to PROGRESS topic', async () => {
        const svc = new MqttService(config.mqtt);
        const spyPub = jest.spyOn(svc as any, 'publish');

        svc.publishProgress('BACKYARD', 'Capturing (1 of 3)');
        expect(spyPub).toHaveBeenCalledWith(`${config.mqtt.basetopic}/PROGRESS`, 'BACKYARD: Capturing (1 of 3)', true);

        svc.publishProgress(undefined as any, 'Idle');
        expect(spyPub).toHaveBeenCalledWith(`${config.mqtt.basetopic}/PROGRESS`, 'Idle', true);
    });
});
