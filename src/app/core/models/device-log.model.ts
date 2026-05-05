export type LogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogPlatform = 'android-tv' | 'tizen' | 'vidaa' | 'webos';

export interface DeviceLog {
    id: string;
    deviceId: string;
    platform: LogPlatform;
    application?: string;
    timestamp: Date;
    level: LogLevel;
    tag?: string;
    message: string;
    raw?: string;
}

export interface LogFilter {
    platform?: LogPlatform;
    deviceId?: string;
    level?: LogLevel;
    appId?: string;
}
