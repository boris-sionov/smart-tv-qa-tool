import {Component, OnDestroy, OnInit} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {Subscription} from 'rxjs';
import {open as openUrl} from '@tauri-apps/plugin-shell';
import {errorMessage, VidaaApp, VidaaResolution, VidaaService, VidaaState} from '../../core/services/vidaa.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {appEnvironment, isPriorityApp} from '../../shared/known-apps';
import {DEVTOOLS_PORTS, devtoolsLauncher, devtoolsUpstream, launcherTarget, presetForUrl, VIDAA_PRESETS} from '../vidaa-presets';

@Component({
    selector: 'app-vidaa-apps',
    templateUrl: './vidaa-apps.component.html',
    // The Tizen list's look — rows, actions, panels — plus a few VIDAA-only pieces.
    styleUrls: ['../../tizen/apps/tizen-apps.component.scss', './vidaa-apps.component.scss'],
})
export class VidaaAppsComponent implements OnInit, OnDestroy {
    readonly presets = VIDAA_PRESETS;
    state!: VidaaState;

    code = '';
    connecting = false;
    connectError: string | null = null;

    /** Id (or preset name) of the row whose action is running. */
    busy: string | null = null;

    showInstall = false;
    custom = {name: '', url: '', iconUrl: '', resolution: 'hisense' as VidaaResolution, devtools: false};

    /** Upstream origins whose DevTools proxy is already running in this session. */
    private proxiesStarted = new Set<string>();

    private sub?: Subscription;

    constructor(private vidaa: VidaaService, private modalService: NgbModal) {}

    ngOnInit(): void {
        this.sub = this.vidaa.state$.subscribe(s => {
            this.state = s;
            if (s.connected) this.startProxiesFor(s.apps);
        });
        this.vidaa.refresh().catch(() => undefined);
    }

    ngOnDestroy(): void {
        this.sub?.unsubscribe();
    }

    get apps(): VidaaApp[] {
        return [...this.state.apps].sort((a, b) => {
            const ap = isPriorityApp(a.AppName, a.URL), bp = isPriorityApp(b.AppName, b.URL);
            if (ap !== bp) return ap ? -1 : 1;
            return a.AppName.localeCompare(b.AppName);
        });
    }

    get tvLabel(): string {
        const info = this.state.tvInfo;
        if (!info) return 'Hisense TV';
        return [info['Model'], info['LAN IP']].filter(Boolean).join(' · ');
    }

    onCodeInput(value: string): void {
        this.code = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        this.connectError = null;
    }

    async connect(): Promise<void> {
        if (this.code.length !== 6 || this.connecting) return;
        this.connecting = true;
        this.connectError = null;
        try {
            await this.vidaa.connect(this.code);
            this.code = '';
        } catch (e) {
            this.connectError = errorMessage(e);
        } finally {
            this.connecting = false;
        }
    }

    async disconnect(): Promise<void> {
        await this.vidaa.disconnect().catch(() => undefined);
    }

    /** The address a row stands for: a launcher's FreeTV URL, or the URL itself. */
    displayUrl(app: VidaaApp): string {
        return launcherTarget(app.URL) ?? app.URL;
    }

    /** Installed "with DevTools": goes through this Mac when the QA tool is reachable, else direct. */
    isLauncher(app: VidaaApp): boolean {
        return !!launcherTarget(app.URL);
    }

    environment(app: VidaaApp): string | null {
        const url = launcherTarget(app.URL) ?? devtoolsUpstream(app.URL)?.url ?? app.URL;
        return presetForUrl(url)?.environment ?? appEnvironment(url, app.AppName);
    }

    /**
     * An older install whose URL points at this computer's proxy. It only loads while the QA tool
     * runs on the TV's network, so the row says so; installs are always direct now.
     */
    isProxied(app: VidaaApp): boolean {
        return !!devtoolsUpstream(app.URL);
    }

    /** Inspect works for FreeTV builds on a host the DevTools proxy knows. */
    canInspect(app: VidaaApp): boolean {
        return !!this.inspectTarget(app);
    }

    /** The FreeTV URL to serve through the proxy for this row. */
    private inspectTarget(app: VidaaApp): {origin: string; path: string} | null {
        const url = launcherTarget(app.URL) ?? devtoolsUpstream(app.URL)?.url ?? app.URL;
        try {
            const u = new URL(url);
            return DEVTOOLS_PORTS[u.origin] ? {origin: u.origin, path: u.pathname + u.search} : null;
        } catch {
            return null;
        }
    }

    /**
     * An app installed with DevTools only loads while its proxy runs, so start the proxies for
     * whatever is installed — after a restart of the QA tool too.
     */
    private startProxiesFor(apps: VidaaApp[]): void {
        for (const app of apps) {
            const target = launcherTarget(app.URL);
            const origin = target ? new URL(target).origin : devtoolsUpstream(app.URL)?.origin;
            if (!origin || !DEVTOOLS_PORTS[origin] || this.proxiesStarted.has(origin)) continue;
            this.proxiesStarted.add(origin);
            this.vidaa.rememberDevtoolsOrigin(origin);
            this.vidaa.devtoolsStart(origin).catch(e => {
                this.proxiesStarted.delete(origin);
                console.warn('[vidaa] DevTools proxy', origin, e);
            });
        }
    }

    /** Prefills the install form with a FreeTV build from the URL table. */
    fillPreset(url: string): void {
        const preset = VIDAA_PRESETS.find(p => p.url === url);
        if (preset) this.custom = {...this.custom, name: preset.name, url: preset.url, iconUrl: preset.iconUrl, resolution: 'hisense'};
    }

    async installCustom(): Promise<void> {
        let {name, url} = this.custom;
        const {iconUrl, resolution, devtools} = this.custom;
        name = name.trim();
        url = url.trim();
        if (devtools) {
            // Install a launcher that picks proxied-with-DevTools or direct each time it opens.
            try {
                const origin = new URL(url).origin;
                if (!DEVTOOLS_PORTS[origin]) {
                    this.fail('DevTools not available', `DevTools works for FreeTV builds on ${Object.keys(DEVTOOLS_PORTS).join(' or ')}.`);
                    return;
                }
                const proxy = await this.vidaa.devtoolsStart(origin);
                this.proxiesStarted.add(origin);
                this.vidaa.rememberDevtoolsOrigin(origin);
                url = devtoolsLauncher(url, proxy.lanIp, proxy.port);
                if (!/devtools$/i.test(name)) name = `${name} DevTools`;
            } catch (e) {
                this.fail('Could not start DevTools', errorMessage(e), e);
                return;
            }
        }
        if (await this.runInstall(name, url, iconUrl.trim(), resolution)) {
            this.custom = {name: '', url: '', iconUrl: '', resolution: 'hisense', devtools: false};
            this.showInstall = false;
        }
    }

    private async runInstall(name: string, url: string, iconUrl: string, resolution: VidaaResolution): Promise<boolean> {
        if (this.busy) return false;
        // DevKit refuses a URL that is already installed; say so before the TV does.
        const existing = this.state.apps.find(a => a.URL === url);
        if (existing) {
            this.fail('Already installed', `"${existing.AppName}" already uses this URL. Remove it first to reinstall.`);
            return false;
        }
        this.busy = 'install';
        try {
            await this.vidaa.install(name, url, iconUrl, resolution);
            return true;
        } catch (e) {
            this.fail('Install failed', errorMessage(e), e);
            return false;
        } finally {
            this.busy = null;
        }
    }

    async launch(app: VidaaApp): Promise<void> {
        if (this.busy) return;
        this.busy = app.Id;
        try {
            await this.vidaa.launch(app);
        } catch (e) {
            this.fail('Failed to launch app', errorMessage(e), e);
        } finally {
            this.busy = null;
        }
    }

    async close(app: VidaaApp): Promise<void> {
        if (this.busy) return;
        this.busy = 'close:' + app.Id;
        try {
            await this.vidaa.close();
        } catch (e) {
            this.fail('Failed to close app', errorMessage(e), e);
        } finally {
            this.busy = null;
        }
    }

    /**
     * Opens Chrome DevTools on the app for this session only. Nothing is installed: the build is
     * launched once through this computer's proxy (DevKit launches any URL), so the app on the TV
     * stays the direct install and keeps working without the Mac. Opening it from the TV again
     * runs it directly. Needs the TV and this computer on the same network.
     */
    async inspect(app: VidaaApp): Promise<void> {
        const up = this.inspectTarget(app);
        if (!up || this.busy) return;
        this.busy = 'inspect:' + app.Id;
        try {
            const proxy = await this.vidaa.devtoolsStart(up.origin);
            const pathOnly = up.path.split('?')[0];
            const tvIp = this.state.tvInfo?.['LAN IP'];
            const find = async () => (await this.vidaa.devtoolsTargets()).find(t =>
                t.port === proxy.port && t.url.includes(pathOnly) && (!tvIp || t.ip.endsWith(tvIp)));
            let target = await find();
            if (!target) {
                const url = this.isLauncher(app) ? app.URL : `http://${proxy.lanIp}:${proxy.port}${up.path}`;
                await this.vidaa.launch({URL: url, StoreType: app.StoreType});
                for (let i = 0; i < 30 && !target; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    target = await find();
                }
            }
            if (!target) {
                this.fail('DevTools did not attach',
                    `"${app.AppName}" did not report in within 30 seconds. Inspect needs the TV and this computer on the same network — the TV loads the app from this computer for the session. The installed app is not affected.`);
                return;
            }
            const client = Math.random().toString(36).slice(2, 8);
            const ws = `localhost:${proxy.port}/__chii/client/${client}?target=${target.id}`;
            await openUrl(`http://localhost:${proxy.port}/__chii/front_end/chii_app.html?ws=${encodeURIComponent(ws)}&rtc=false`);
        } catch (e) {
            this.fail('Inspect failed', errorMessage(e), e);
        } finally {
            this.busy = null;
        }
    }

    async remove(app: VidaaApp): Promise<void> {
        if (this.busy) return;
        const confirm = MessageDialogComponent.open(this.modalService, {
            title: 'Remove App',
            message: `Remove "${app.AppName}" from the TV?`,
            positive: 'Remove',
            positiveStyle: 'danger',
            negative: 'Cancel',
            autofocus: 'negative',
        });
        if (!await confirm.result.catch(() => false)) return;
        this.busy = app.Id;
        try {
            await this.vidaa.uninstall(app);
        } catch (e) {
            this.fail('Failed to remove app', errorMessage(e), e);
        } finally {
            this.busy = null;
        }
    }

    private fail(title: string, message: string, error?: unknown): void {
        MessageDialogComponent.open(this.modalService, {
            title,
            message,
            error: error instanceof Error ? error : undefined,
            positive: 'Close',
        });
    }
}
