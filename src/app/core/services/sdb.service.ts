import {Injectable} from '@angular/core';
import {Channel, invoke} from '@tauri-apps/api/core';
import {homeDir} from '@tauri-apps/api/path';
import {open as showOpenDialog} from '@tauri-apps/plugin-dialog';
import {DeviceProvider, DeviceInfo, Platform, PlatformApp, PlatformDevice} from '../models/device-provider.interface';

export interface SdbDevice {
    serial: string;
    state: string;
}

export interface SdbAppInfo {
    id: string;
    name: string;
    versionName?: string | null;
    runtimeId?: string | null;
    tizenId?: string | null;
}

export interface TizenInfoEntry {
    key: string;
    value: string;
}

export interface InstallProgress {
    step: 'disconnecting' | 'waiting' | 'connecting' | 'connected' | 'building' | 'installing' | 'done';
    message: string;
    percent: number;
}

/** What a WGT's `config.xml` declares, as `tizen_read_wgt_info` reports it. */
export interface TizenWgtInfo {
    id: string;
    name: string;
    /** Entry the package calls its icon — `icon.png` unless `config.xml` says otherwise. */
    icon: string;
}

/** An icon to bake into a package before it is signed. */
export interface WgtIcon {
    /** Entry to replace, from `TizenWgtInfo.icon`. */
    entry: string;
    png: Uint8Array;
}

/**
 * Bytes for the IPC hop. Chunked because spreading ~150 KB into `String.fromCharCode`
 * in one call overflows the argument stack.
 */
function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

export interface TizenCertProfile {
    name: string;
    active: boolean;
    /** DUIDs of the TVs this profile's distributor certificate was issued for. */
    duids: string[];
}

export interface TizenStudioInfo {
    path: string;
    version: string;
    profiles: TizenCertProfile[];
}

interface RawTizenAppInfo {
    id: string;
    name: string;
    versionName: string;
    runtimeId: string | null;
    tizenId: string | null;
}

@Injectable({providedIn: 'root'})
export class SdbService implements DeviceProvider {

    readonly platform: Platform = 'tizen';

    private normalizeSerial(host: string, defaultPort = 26101): string {
        return host.includes(':') ? host : `${host}:${defaultPort}`;
    }

    // -----------------------------------------------------------------------
    // Device connection
    // -----------------------------------------------------------------------

    async connect(host: string, port = 26101): Promise<string> {
        const serial = this.normalizeSerial(host, port);
        return invoke<string>('plugin:adb-manager|tizen_connect', {serial});
    }

    async disconnect(_serial: string): Promise<void> {
        // Native TCP connections are stateless per-command — nothing to close
    }

    async listConnectedDevices(): Promise<PlatformDevice[]> {
        // Native mode: connectivity is verified per-command; no persistent session list
        return [];
    }

    async ensureConnected(_serial: string): Promise<void> {
        // Native TCP connections are created fresh per command — no persistent state needed
    }

    // -----------------------------------------------------------------------
    // Package management
    // -----------------------------------------------------------------------

    async install(serial: string, filePath: string): Promise<string> {
        const s = this.normalizeSerial(serial);
        return invoke<string>('plugin:adb-manager|tizen_install', {serial: s, filePath});
    }

    async signAndInstall(_serial: string, _filePath: string, _profileName: string): Promise<string> {
        throw new Error(
            'Sign & Install requires Tizen CLI tools (Tizen Studio or VS Code Tizen Extension).\n' +
            'Use "Install" with a pre-signed package instead.'
        );
    }

    async uninstall(serial: string, appId: string, _runtimeId?: string | null): Promise<string> {
        const s = this.normalizeSerial(serial);
        return invoke<string>('plugin:adb-manager|tizen_uninstall', {serial: s, appId});
    }

    async getAppVersion(serial: string, appId: string): Promise<string> {
        const s = this.normalizeSerial(serial);
        return invoke<string>('plugin:adb-manager|tizen_get_app_version', {serial: s, appId})
            .catch(() => '');
    }

    async listApps(serial: string): Promise<PlatformApp[]> {
        const s = this.normalizeSerial(serial);
        const raw = await invoke<RawTizenAppInfo[]>('plugin:adb-manager|tizen_list_apps', {serial: s});
        return raw.map(a => ({id: a.id, name: a.name, versionName: a.versionName, tizenId: a.tizenId, runtimeId: a.runtimeId}));
    }

    // -----------------------------------------------------------------------
    // DeviceProvider bridge
    // -----------------------------------------------------------------------

    async getAppIcon(_serial: string, _appId: string): Promise<string | null> {
        return null;
    }

    async launchApp(serial: string, appId: string): Promise<void> {
        await this.launch(serial, appId);
    }

    async killApp(serial: string, appId: string): Promise<void> {
        await this.kill(serial, appId);
    }

    async installApp(serial: string, filePath: string): Promise<void> {
        await this.install(serial, filePath);
    }

    async uninstallApp(serial: string, appId: string): Promise<void> {
        await this.uninstall(serial, appId);
    }

    async openPackageChooser(): Promise<string | null> {
        return this.openWgtChooser();
    }

    async getDeviceInfo(serial: string): Promise<DeviceInfo> {
        const s = this.normalizeSerial(serial);
        // Samsung Tizen has no getprop — read /etc/info.ini via dedicated command
        return invoke<DeviceInfo>('plugin:adb-manager|tizen_get_device_info', {serial: s})
            .catch(() => ({model: '', manufacturer: '', osVersion: ''}));
    }

    // -----------------------------------------------------------------------
    // App lifecycle
    // -----------------------------------------------------------------------

    async launch(serial: string, appId: string): Promise<string> {
        const s = this.normalizeSerial(serial);
        return invoke<string>('plugin:adb-manager|tizen_launch', {serial: s, appId});
    }

    async kill(serial: string, appId: string): Promise<string> {
        const s = this.normalizeSerial(serial);
        return invoke<string>('plugin:adb-manager|tizen_kill', {serial: s, appId});
    }

    async debug(serial: string, appId: string): Promise<number> {
        const s = this.normalizeSerial(serial);
        return invoke<number>('plugin:adb-manager|tizen_debug', {serial: s, appId});
    }

    // -----------------------------------------------------------------------
    // Device info helpers
    // -----------------------------------------------------------------------

    async getDeviceDuid(serial: string): Promise<string> {
        const s = this.normalizeSerial(serial);
        return invoke<string>('plugin:adb-manager|tizen_get_duid', {serial: s});
    }

    async shell(serial: string, command: string): Promise<string> {
        const s = this.normalizeSerial(serial);
        return invoke<string>('plugin:adb-manager|tizen_shell', {serial: s, command});
    }

    async tizenDaemonCommand(serial: string, command: string): Promise<string> {
        const s = this.normalizeSerial(serial);
        return invoke<string>('plugin:adb-manager|tizen_daemon_command', {serial: s, command});
    }

    // -----------------------------------------------------------------------
    // Certificate / profile management
    // These require Tizen CLI tools and cannot run without Tizen Studio.
    // -----------------------------------------------------------------------

    async getCertificateProfiles(): Promise<string[]> {
        return [];
    }

    /** What the WGT's `config.xml` says about itself, without installing anything. */
    async readWgtInfo(filePath: string): Promise<TizenWgtInfo> {
        return invoke<TizenWgtInfo>('plugin:adb-manager|tizen_read_wgt_info', {filePath});
    }

    async installSigned(
        serial: string,
        filePath: string,
        certProfile: string,
        studioPath: string,
        onProgress?: (p: InstallProgress) => void,
        icon?: WgtIcon,
    ): Promise<string> {
        const s = this.normalizeSerial(serial);
        const ch = new Channel<InstallProgress>();
        if (onProgress) ch.onmessage = onProgress;
        return invoke<string>('plugin:adb-manager|tizen_install_signed', {
            serial: s, filePath, certProfile, tizenStudioPath: studioPath, onProgress: ch,
            iconPngBase64: icon ? toBase64(icon.png) : null,
            iconEntry: icon?.entry ?? null,
        });
    }

    async detectTizenStudio(): Promise<TizenStudioInfo> {
        const home = await homeDir().catch(() => '');
        return invoke<TizenStudioInfo>('plugin:adb-manager|tizen_detect_studio', {homeDir: home});
    }

    async openCertificateManager(studioPath: string): Promise<void> {
        return invoke('plugin:adb-manager|tizen_open_certificate_manager', {studioPath});
    }

    async openDeviceManager(studioPath: string): Promise<void> {
        return invoke('plugin:adb-manager|tizen_open_device_manager', {studioPath});
    }

    async isTizenCliAvailable(): Promise<boolean> {
        return false;
    }

    async getBundledDistributorCerts(): Promise<{publicCert: string; partnerCert: string; password: string}> {
        throw new Error('Certificate management requires the Tizen Extension for VS Code.');
    }

    async createAuthorCert(_opts: {
        name: string; password: string; email?: string;
        country?: string; organization?: string; department?: string;
    }): Promise<string> {
        throw new Error('Certificate creation requires the Tizen Extension for VS Code.');
    }

    async createProfile(_opts: {
        name: string; author: string; authorPassword: string;
        distributor: string; distributorPassword: string;
        distributor2?: string; distributor2Password?: string; active: boolean;
    }): Promise<void> {
        throw new Error('Profile management requires the Tizen Extension for VS Code.');
    }

    async setActiveProfile(_name: string): Promise<void> {
        throw new Error('Profile management requires the Tizen Extension for VS Code.');
    }

    async deleteProfile(_name: string): Promise<void> {
        throw new Error('Profile management requires the Tizen Extension for VS Code.');
    }

    async getActiveProfile(): Promise<string | null> {
        return null;
    }

    // -----------------------------------------------------------------------
    // File chooser
    // -----------------------------------------------------------------------

    async openWgtChooser(): Promise<string | null> {
        return showOpenDialog({
            filters: [{name: 'Tizen package', extensions: ['wgt', 'tmg', 'tpk']}],
            multiple: false,
        });
    }

    async openP12Chooser(): Promise<string | null> {
        return showOpenDialog({
            filters: [{name: 'PKCS#12 certificate', extensions: ['p12']}],
            multiple: false,
        });
    }
}
