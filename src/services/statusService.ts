import { EventEmitter } from 'events';
import { CameraStats } from '../types';
import { logger } from '../utils/logger';

export class StatusService extends EventEmitter {
    private cameraStats: Record<string, CameraStats> = {};
    private cameraStatus: Record<string, string> = {};

    constructor() {
        super();
        logger.debug('Status Service initialized');
    }

    public updateStatus(cameraName: string | undefined, status: string): void {
        if (cameraName) {
            this.cameraStatus[cameraName] = status;
            logger.debug(`Status updated for camera ${cameraName}: ${status}`);
        } else {
            logger.debug(`Global status update: ${status}`);
        }

        // Emit event for MQTT publishing (cameraName may be undefined)
        this.emit('statusUpdate', cameraName, status);
    }

    public updateStats(cameraName: string, stats: Partial<CameraStats>): void {
        if (!this.cameraStats[cameraName]) {
            this.cameraStats[cameraName] = {};
        }

        // Deep merge for nested loader stats
        if (stats.loader) {
            if (!this.cameraStats[cameraName].loader) {
                this.cameraStats[cameraName].loader = {};
            }

            if (stats.loader.camera) {
                if (!this.cameraStats[cameraName].loader!.camera) {
                    this.cameraStats[cameraName].loader!.camera = {};
                }
                Object.assign(this.cameraStats[cameraName].loader!.camera!, stats.loader.camera);
            }

            if (stats.loader.url) {
                if (!this.cameraStats[cameraName].loader!.url) {
                    this.cameraStats[cameraName].loader!.url = {};
                }
                Object.assign(this.cameraStats[cameraName].loader!.url!, stats.loader.url);
            }

            if (stats.loader.database) {
                if (!this.cameraStats[cameraName].loader!.database) {
                    this.cameraStats[cameraName].loader!.database = {};
                }
                for (const dbSource in stats.loader.database) {
                    if (!this.cameraStats[cameraName].loader!.database![dbSource]) {
                        this.cameraStats[cameraName].loader!.database![dbSource] = {};
                    }
                    Object.assign(this.cameraStats[cameraName].loader!.database![dbSource], stats.loader.database[dbSource]);
                }
            }

            // Remove loader from stats to avoid double assignment
            const { loader, ...restStats } = stats;
            Object.assign(this.cameraStats[cameraName], restStats);
        } else {
            // Simple update for non-loader fields
            Object.assign(this.cameraStats[cameraName], stats);
        }

        logger.debug(`Stats updated for camera ${cameraName}: ${JSON.stringify(stats)}`);

        // Emit event for MQTT publishing
        this.emit('statsUpdate', cameraName, this.cameraStats[cameraName]);
    }

    public getStats(cameraName: string): CameraStats {
        return this.cameraStats[cameraName] || {};
    }

    public getStatus(cameraName: string): string {
        return this.cameraStatus[cameraName] || 'Idle';
    }

    public recordError(cameraName: string | undefined, error: string | Error): void {
        const errorMessage = error instanceof Error ? error.message : error;
        const now = new Date().toISOString();

        if (cameraName) {
            this.updateStats(cameraName, {
                lastErrorDate: now,
                lastErrorType: errorMessage
            });

            this.updateStatus(cameraName, 'Error');
            logger.debug(`Error recorded for camera ${cameraName}: ${errorMessage}`);
        } else {
            logger.debug(`Global error recorded: ${errorMessage}`);
        }
    }

    public recordSuccess(cameraName: string | undefined, aiProcessTime: number, totalProcessTime: number): void {
        const now = new Date().toISOString();

        if (cameraName) {
            this.updateStats(cameraName, {
                lastSuccessDate: now,
                lastAiProcessTime: aiProcessTime,
                lastTotalProcessTime: totalProcessTime
            });

            this.updateStatus(cameraName, 'Complete');
            logger.debug(`Success recorded for camera ${cameraName}: AI=${aiProcessTime}s, Total=${totalProcessTime}s`);
        } else {
            logger.debug(`Global success recorded: AI=${aiProcessTime}s, Total=${totalProcessTime}s`);
        }
    }

    public getAllCameraStats(): Record<string, CameraStats> {
        return { ...this.cameraStats };
    }

    public getAllCameraStatuses(): Record<string, string> {
        return { ...this.cameraStatus };
    }
}