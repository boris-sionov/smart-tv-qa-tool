import {Injectable, NgZone} from '@angular/core';
import {Channel, invoke} from '@tauri-apps/api/core';
import {info as logInfo, warn as logWarn} from '@tauri-apps/plugin-log';
import {BehaviorSubject} from 'rxjs';

/** One app as DevKit lists it. Sideloaded ids are `debug-<AppName>`. */
export interface VidaaApp {
    Id: string;
    AppName: string;
    URL: string;
    IconURL?: string;
    StoreType?: string;
    InstallTime?: string;
}

/** TV_INFO as DevKit pushes it: "VIDAA Version", "Model", "LAN IP", "Support Background Running", … */
export type VidaaTvInfo = Record<string, string>;

export interface VidaaState {
    connected: boolean;
    tvInfo: VidaaTvInfo | null;
    apps: VidaaApp[];
    /** TV_Log / WEBLOG lines, newest last. The TV only sends these on its own. */
    log: string[];
    /** Why the last session ended, when it ended without us asking. */
    lostReason: string | null;
}

type VidaaEvent =
    | {event: 'tvInfo'; data: VidaaTvInfo}
    | {event: 'apps'; data: VidaaApp[]}
    | {event: 'log'; data: string}
    | {event: 'disconnected'; data: string};

interface Snapshot {
    connected: boolean;
    tvInfo: VidaaTvInfo | null;
    apps: VidaaApp[];
}

/** A DevTools proxy the QA tool runs for one upstream origin. */
export interface DevtoolsProxy {
    origin: string;
    port: number;
    lanIp: string;
}

/** A page on the TV that loaded Chii's target script and can be inspected. */
export interface DevtoolsTarget {
    id: string;
    url: string;
    title: string;
    ip: string;
    port: number;
    connectedAt: number;
}

/** Resolution codes DevKit uses; `hisense` is the form's "1080P". */
export type VidaaResolution = 'hisense' | 'store';

const LOG_LIMIT = 2000;

/**
 * The VIDAA DevKit session, held by the `vidaa` Rust plugin — it outlives page navigation, so
 * this service re-reads it on start rather than assuming a fresh state.
 *
 * Errors from the plugin arrive as `{reason, message}` objects; callers show `message`.
 */
@Injectable({providedIn: 'root'})
export class VidaaService {
    readonly state$ = new BehaviorSubject<VidaaState>({
        connected: false, tvInfo: null, apps: [], log: [], lostReason: null,
    });

    constructor(private zone: NgZone) {
        this.refresh().catch(e => console.warn('[vidaa] status', e));
    }

    async refresh(): Promise<void> {
        const snap = await invoke<Snapshot>('plugin:vidaa|vidaa_status');
        this.patch({connected: snap.connected, tvInfo: snap.tvInfo, apps: snap.apps ?? []});
    }

    async connect(code: string): Promise<void> {
        const onEvent = new Channel<VidaaEvent>();
        onEvent.onmessage = ev => this.zone.run(() => this.handle(ev));
        const snap = await invoke<Snapshot>('plugin:vidaa|vidaa_connect', {code, onEvent});
        this.patch({connected: true, tvInfo: snap.tvInfo, apps: snap.apps ?? [], log: [], lostReason: null});
        vidaaLog(`connected to ${snap.tvInfo?.['Model'] ?? 'TV'}`);
    }

    async disconnect(): Promise<void> {
        await invoke('plugin:vidaa|vidaa_disconnect');
        this.patch({connected: false, tvInfo: null, apps: [], lostReason: null});
    }

    async install(name: string, url: string, iconUrl: string, resolution: VidaaResolution = 'hisense'): Promise<void> {
        vidaaLog(`install ${name} -> ${url}`);
        try {
            await invoke('plugin:vidaa|vidaa_install', {name, url, iconUrl, resolution});
        } catch (e) {
            vidaaLog(`install ${name} failed: ${errorMessage(e)}`, true);
            throw e;
        }
    }

    async launch(app: Pick<VidaaApp, 'URL' | 'StoreType'>): Promise<void> {
        vidaaLog(`launch ${app.URL}`);
        await invoke('plugin:vidaa|vidaa_launch', {url: app.URL, resolution: app.StoreType || 'hisense'});
    }

    /** Closes the web app in the foreground, whichever it is — the TV runs one at a time. */
    async close(): Promise<void> {
        vidaaLog('close foreground app');
        await invoke('plugin:vidaa|vidaa_close');
    }

    async uninstall(app: VidaaApp): Promise<void> {
        vidaaLog(`uninstall ${app.Id}`);
        await invoke('plugin:vidaa|vidaa_uninstall', {id: app.Id});
    }

    /** Starts (or reuses) the DevTools proxy for `origin`; the TV's IP picks the right LAN address. */
    async devtoolsStart(origin: string): Promise<DevtoolsProxy> {
        const tvIp = this.state$.value.tvInfo?.['LAN IP'] || null;
        return invoke<DevtoolsProxy>('plugin:vidaa|vidaa_devtools_start', {origin, tvIp});
    }

    /** Pages attached to the DevTools proxies, newest first. */
    async devtoolsTargets(): Promise<DevtoolsTarget[]> {
        return invoke<DevtoolsTarget[]>('plugin:vidaa|vidaa_devtools_targets');
    }

    clearLog(): void {
        this.patch({log: []});
    }

    private handle(ev: VidaaEvent): void {
        switch (ev.event) {
            case 'tvInfo':
                this.patch({tvInfo: ev.data});
                break;
            case 'apps':
                this.patch({apps: ev.data});
                break;
            case 'log':
                this.patch({log: [...this.state$.value.log, ev.data].slice(-LOG_LIMIT)});
                break;
            case 'disconnected':
                vidaaLog(`disconnected: ${ev.data}`, true);
                this.patch({connected: false, lostReason: ev.data});
                break;
        }
    }

    private patch(change: Partial<VidaaState>): void {
        this.state$.next({...this.state$.value, ...change});
    }
}

export function errorMessage(e: unknown): string {
    if (e && typeof e === 'object') {
        const {message, reason} = e as {message?: unknown; reason?: unknown};
        if (message) return String(message);
        if (reason === 'Timeout') return 'The TV did not answer in time.';
        if (reason) return String(reason);
    }
    return String(e);
}

/** console.log never reaches the log file in a release build — see AGENTS.md → Logs. */
function vidaaLog(message: string, warning = false): void {
    const line = `[VIDAA] ${message}`;
    (warning ? console.warn : console.log)(line);
    (warning ? logWarn : logInfo)(line).catch(() => undefined);
}
