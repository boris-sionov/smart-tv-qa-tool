import {Injectable} from '@angular/core';
import {invoke} from '@tauri-apps/api/core';
import {downloadDir, join} from '@tauri-apps/api/path';
import {open as showOpenDialog, save as showSaveDialog} from '@tauri-apps/plugin-dialog';
import {AdbPackageInfo} from '../core/services/adb.service';

/** A phone plugged in over USB, as `adb devices -l` lists it. */
export interface UsbPhone {
    serial: string;
    /** `device`, `unauthorized` (the phone is asking "Allow USB debugging?") or `offline`. */
    state: string;
    model: string | null;
}

/** An app QA tests on phones. A pattern ending in `*` matches every package id that starts so. */
export interface PhoneApp {
    pattern: string;
    name: string;
    icon: string;
}

/**
 * The only apps the phone page lists. Every FreeTV build is `tv.freetv.mobile.android` plus an
 * environment suffix (`.uat`); Mizrahi Tefahot is its "account management" app.
 */
export const PHONE_APPS: PhoneApp[] = [
    {pattern: 'tv.freetv.mobile.android*', name: 'FreeTV', icon: 'bi-tv'},
    {pattern: 'com.MizrahiTefahot.nh', name: 'Mizrahi Tefahot — Account', icon: 'bi-bank'},
];

/** The display name for an installed package: the app's name, plus the environment suffix. */
export function phoneAppName(id: string): string {
    const app = PHONE_APPS.find(a => a.pattern.endsWith('*') ? id.startsWith(a.pattern.slice(0, -1)) : id === a.pattern);
    if (!app) return id;
    const suffix = app.pattern.endsWith('*') ? id.slice(app.pattern.length - 1).replace(/^\./, '') : '';
    return suffix ? `${app.name} ${suffix.toUpperCase()}` : app.name;
}

export function phoneAppIcon(id: string): string {
    return PHONE_APPS.find(a => a.pattern.endsWith('*') ? id.startsWith(a.pattern.slice(0, -1)) : id === a.pattern)?.icon
        ?? 'bi-app';
}

/** Phone-only ADB calls; uninstall, force-stop and install are shared with Android TV (`AdbService`). */
@Injectable({providedIn: 'root'})
export class PhoneService {

    listPhones(): Promise<UsbPhone[]> {
        return invoke<UsbPhone[]>('plugin:adb-manager|adb_list_usb_devices');
    }

    async listApps(serial: string): Promise<AdbPackageInfo[]> {
        const packages = await invoke<AdbPackageInfo[]>('plugin:adb-manager|adb_list_packages_matching',
            {serial, patterns: PHONE_APPS.map(a => a.pattern)});
        return packages
            .map(p => ({...p, name: phoneAppName(p.id)}))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    launch(serial: string, packageId: string): Promise<void> {
        return invoke<void>('plugin:adb-manager|adb_launch_launcher', {serial, packageId});
    }

    /**
     * Saves the phone's logcat to a file the user picks, starting in Downloads with a name that
     * says which phone and when. Resolves with the path, or `null` when the dialog was cancelled.
     */
    async saveLogs(serial: string, phoneName: string | null): Promise<string | null> {
        const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
        const name = `${(phoneName ?? serial).replace(/[^\w.-]+/g, '-')}_logcat_${stamp}.txt`;
        const path = await showSaveDialog({
            title: 'Save phone logs',
            defaultPath: await join(await downloadDir(), name),
            filters: [{name: 'Log', extensions: ['txt', 'log']}],
        });
        if (!path) return null;
        await invoke<number>('plugin:adb-manager|adb_save_logcat', {serial, path});
        return path;
    }

    /** Lets QA pick one or more `.apk` / `.xapk` files. */
    async chooseInstallFiles(): Promise<string[]> {
        const picked = await showOpenDialog({
            title: 'Install on the phone',
            filters: [{name: 'Android package', extensions: ['apk', 'xapk']}],
            multiple: true,
        });
        return picked ?? [];
    }

    /** Installs one app's APKs together — one path is a plain install, several are its splits. */
    installApks(serial: string, apkPaths: string[]): Promise<void> {
        return invoke<void>('plugin:adb-manager|adb_install_multiple', {serial, apkPaths, downgrade: true});
    }

    /** Installs an XAPK (base + split APKs, OBB data); resolves with its package id. */
    installXapk(serial: string, path: string, uninstallFirst = false): Promise<string> {
        return invoke<string>('plugin:adb-manager|adb_install_xapk', {serial, path, downgrade: true, uninstallFirst});
    }

    /** Opens a scrcpy window mirroring the phone; `false` when scrcpy is not installed. */
    openScrcpy(serial: string, title: string | null): Promise<boolean> {
        return invoke<boolean>('plugin:adb-manager|scrcpy_open', {serial, title});
    }
}
