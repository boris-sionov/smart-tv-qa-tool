import {Injectable} from '@angular/core';
import {invoke} from '@tauri-apps/api/core';
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

    async installViaTizenBrew(serial: string, filePath: string): Promise<string> {
        const s = this.normalizeSerial(serial);
        return invoke<string>('plugin:adb-manager|tizen_install_tizen_brew', {serial: s, filePath});
    }

    async getTizenBrewDeviceDetails(serial: string): Promise<{systemInfo: TizenInfoEntry[], daemonError: string}> {
        const s = this.normalizeSerial(serial);
        return invoke<{systemInfo: TizenInfoEntry[], daemonError: string}>(
            'plugin:adb-manager|tizen_tizen_brew_device_details', {serial: s}
        ).catch(() => ({systemInfo: [], daemonError: 'TizenBrew daemon not available'}));
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
            filters: [{name: 'Tizen package', extensions: ['tpk', 'wgt']}],
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
