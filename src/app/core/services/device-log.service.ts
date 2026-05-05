import {Injectable} from '@angular/core';
import {BehaviorSubject, Observable} from 'rxjs';
import {map} from 'rxjs/operators';
import {DeviceLog, LogFilter, LogLevel, LogPlatform} from '../models/device-log.model';

@Injectable({providedIn: 'root'})
export class DeviceLogService {
    private readonly logs$ = new BehaviorSubject<DeviceLog[]>([]);

    add(entry: Omit<DeviceLog, 'id'>): DeviceLog {
        const log: DeviceLog = {...entry, id: crypto.randomUUID()};
        this.logs$.next([...this.logs$.value, log]);
        return log;
    }

    getLogs$(filter?: LogFilter): Observable<DeviceLog[]> {
        return this.logs$.pipe(
            map(logs => {
                if (!filter) return logs;
                return logs.filter(l => {
                    if (filter.platform && l.platform !== filter.platform) return false;
                    if (filter.deviceId && l.deviceId !== filter.deviceId) return false;
                    if (filter.level && l.level !== filter.level) return false;
                    if (filter.appId && l.application !== filter.appId) return false;
                    return true;
                });
            }),
        );
    }

    getSnapshot(filter?: LogFilter): DeviceLog[] {
        const all = this.logs$.value;
        if (!filter) return all;
        return all.filter(l => {
            if (filter.platform && l.platform !== filter.platform) return false;
            if (filter.deviceId && l.deviceId !== filter.deviceId) return false;
            if (filter.level && l.level !== filter.level) return false;
            if (filter.appId && l.application !== filter.appId) return false;
            return true;
        });
    }

    clear(deviceId?: string): void {
        if (deviceId) {
            this.logs$.next(this.logs$.value.filter(l => l.deviceId !== deviceId));
        } else {
            this.logs$.next([]);
        }
    }

    /**
     * Parse a single Android TV logcat line (adb logcat output) into a DeviceLog.
     * Format: MM-DD HH:MM:SS.mmm  PID   TID  LEVEL TAG: message
     */
    parseAndroidLogcat(raw: string, deviceId: string): DeviceLog | null {
        const m = raw.match(/^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]+):\s*(.*)$/);
        if (!m) return null;
        const levelMap: Record<string, LogLevel> = {V: 'verbose', D: 'debug', I: 'info', W: 'warn', E: 'error', F: 'fatal'};
        return {
            id: crypto.randomUUID(),
            deviceId,
            platform: 'android-tv' as LogPlatform,
            tag: m[3].trim(),
            level: levelMap[m[2]] ?? 'info',
            timestamp: new Date(`${new Date().getFullYear()}-${m[1].trim().replace(' ', 'T')}`),
            message: m[4],
            raw,
        };
    }

    /**
     * Parse a single Samsung Tizen dlog line (sdb dlog output) into a DeviceLog.
     * Format: MM-DD HH:MM:SS.mmm PID:TID LEVEL/TAG: message
     */
    parseTizenDlog(raw: string, deviceId: string): DeviceLog | null {
        const m = raw.match(/^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+\d+:\d+\s+([VDIWEF])\/([^:]+):\s*(.*)$/);
        if (!m) return null;
        const levelMap: Record<string, LogLevel> = {V: 'verbose', D: 'debug', I: 'info', W: 'warn', E: 'error', F: 'fatal'};
        return {
            id: crypto.randomUUID(),
            deviceId,
            platform: 'tizen' as LogPlatform,
            tag: m[3].trim(),
            level: levelMap[m[2]] ?? 'info',
            timestamp: new Date(`${new Date().getFullYear()}-${m[1].trim().replace(' ', 'T')}`),
            message: m[4],
            raw,
        };
    }
}
