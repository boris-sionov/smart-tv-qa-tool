export type Platform = 'android-tv' | 'tizen' | 'vidaa' | 'webos';

export interface PlatformDevice {
    serial: string;
    name?: string;
    state: 'device' | 'offline' | 'unauthorized' | string;
}

export interface PlatformApp {
    id: string;
    name: string;
    versionName: string;
}

export interface DeviceInfo {
    model?: string;
    manufacturer?: string;
    osVersion?: string;
    [key: string]: string | undefined;
}

export interface DeviceProvider {
    readonly platform: Platform;
    connect(host: string, port?: number): Promise<string>;
    disconnect(serial: string): Promise<void>;
    listConnectedDevices(): Promise<PlatformDevice[]>;
    listApps(serial: string): Promise<PlatformApp[]>;
    getAppIcon(serial: string, appId: string): Promise<string | null>;
    launchApp(serial: string, appId: string): Promise<void>;
    killApp(serial: string, appId: string): Promise<void>;
    installApp(serial: string, filePath: string): Promise<void>;
    uninstallApp(serial: string, appId: string): Promise<void>;
    getDeviceInfo(serial: string): Promise<DeviceInfo>;
    openPackageChooser(): Promise<string | null>;
}
