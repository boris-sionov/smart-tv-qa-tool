import {Injectable} from '@angular/core';
import {BehaviorSubject, distinctUntilChanged} from 'rxjs';
import {AdbPackageInfo, AdbService} from '../core/services/adb.service';
import {extractMessage} from '../core/utils/error.utils';

export interface SavedDevice {
    name: string;
    ip: string;
    port: number;
}

export function deviceSerial(d: SavedDevice): string {
    return `${d.ip}:${d.port}`;
}

/**
 * Whether ADB really holds the selected TV. `unauthorized`: the TV is reachable but is showing its
 * "Allow USB debugging?" prompt for this computer.
 */
export type AdbConnection =
    | {device: null, status: 'none'}
    | {device: SavedDevice, status: 'checking' | 'connected' | 'unauthorized'}
    | {device: SavedDevice, status: 'failed', error: string};

const STORAGE_KEY = 'freetv-android-tv-devices';
const SELECTED_STORAGE_KEY = 'freetv-android-tv-selected-device';
const LIBRARY_STORAGE_KEY = 'freetv-android-tv-apk-library';
/** The team's library on freetv-server, reached over Tailscale. */
export const DEFAULT_APK_LIBRARY = 'http://freetv-server:8090/';

@Injectable({providedIn: 'root'})
export class AdbStateService {

    selected$ = new BehaviorSubject<SavedDevice | null>(this.getLastSelectedDevice());
    /** Pages load from the TV once this says `connected`, not as soon as a device is selected. */
    connection$ = new BehaviorSubject<AdbConnection>({device: null, status: 'none'});
    private checkSeq = 0;
    private packagesCache = new Map<string, AdbPackageInfo[]>();

    getCachedPackages(serial: string): AdbPackageInfo[] | null {
        return this.packagesCache.get(serial) ?? null;
    }

    setCachedPackages(serial: string, packages: AdbPackageInfo[]): void {
        this.packagesCache.set(serial, packages);
    }

    invalidatePackages(serial: string): void {
        this.packagesCache.delete(serial);
    }

    constructor(private adb: AdbService) {
        const isInitialized = localStorage.getItem('adb-state-initialized');
        if (!isInitialized) {
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(SELECTED_STORAGE_KEY);
            localStorage.setItem('adb-state-initialized', 'true');
            this.selected$.next(null);
        }
        // A saved selection is not a connection: the app may have been closed for days and the
        // TV asleep or on another network since. Check it whenever the selection changes,
        // including the one restored at startup.
        this.selected$
            .pipe(distinctUntilChanged((a, b) => (a && deviceSerial(a)) === (b && deviceSerial(b))))
            .subscribe(() => this.checkConnection());
    }

    /** Verifies the selected TV's connection and reconnects it if needed. */
    async checkConnection(): Promise<void> {
        const device = this.selected$.value;
        const seq = ++this.checkSeq;
        if (!device) {
            this.connection$.next({device: null, status: 'none'});
            return;
        }
        this.connection$.next({device, status: 'checking'});
        let next: AdbConnection;
        try {
            const state = await this.adb.ensureConnected(deviceSerial(device));
            next = {device, status: state === 'device' ? 'connected' : 'unauthorized'};
        } catch (e) {
            next = {device, status: 'failed', error: extractMessage(e, `Cannot connect to ${device.ip}`)};
        }
        // A newer check (another device picked meanwhile) wins.
        if (seq === this.checkSeq) this.connection$.next(next);
    }

    /** Where the APK library lives: a folder path or a server URL. */
    get apkLibrary(): string {
        return localStorage.getItem(LIBRARY_STORAGE_KEY) || DEFAULT_APK_LIBRARY;
    }

    set apkLibrary(source: string) {
        localStorage.setItem(LIBRARY_STORAGE_KEY, source.trim());
    }

    getSavedDevices(): SavedDevice[] {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
        } catch {
            return [];
        }
    }

    saveDevice(device: SavedDevice): void {
        const list = this.getSavedDevices();
        const idx = list.findIndex(d => d.ip === device.ip && d.port === device.port);
        if (idx >= 0) {
            list[idx] = device;
        } else {
            list.push(device);
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    }

    removeDevice(device: SavedDevice): void {
        const list = this.getSavedDevices().filter(
            d => !(d.ip === device.ip && d.port === device.port)
        );
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
        if (this.selected$.value?.ip === device.ip && this.selected$.value?.port === device.port) {
            this.select(list[0] ?? null);
        }
    }

    select(device: SavedDevice | null): void {
        if (device) {
            localStorage.setItem(SELECTED_STORAGE_KEY, deviceSerial(device));
        } else {
            localStorage.removeItem(SELECTED_STORAGE_KEY);
        }
        this.selected$.next(device);
    }

    private getLastSelectedDevice(): SavedDevice | null {
        const serial = localStorage.getItem(SELECTED_STORAGE_KEY);
        const devices = this.getSavedDevices();
        if (serial) {
            const match = devices.find(d => deviceSerial(d) === serial);
            if (match) return match;
        }
        return devices[0] ?? null;
    }
}
