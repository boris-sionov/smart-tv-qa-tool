import {Component, OnDestroy, OnInit} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {Subscription} from 'rxjs';
import {open as openUrl} from '@tauri-apps/plugin-shell';
import {fetch as tauriFetch} from '@tauri-apps/plugin-http';
import {SdbAppInfo, SdbService} from '../../core/services/sdb.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {ProgressDialogComponent, ProgressStep} from '../../shared/components/progress-dialog/progress-dialog.component';
import {tizenSerial, TizenDevice, TizenStateService} from '../tizen-state.service';
import {TizenWizardComponent} from '../wizard/tizen-wizard.component';
import {TizenRemoteService} from '../../core/services/tizen-remote.service';

@Component({
    selector: 'app-tizen-apps',
    templateUrl: './tizen-apps.component.html',
    styleUrls: ['./tizen-apps.component.scss'],
})
export class TizenAppsComponent implements OnInit, OnDestroy {
    selected: TizenDevice | null = null;
    devices: TizenDevice[] = [];
    apps: SdbAppInfo[] | null = null;
    appVersions: Map<string, string> = new Map();
    appsError?: Error;
    loadingApps = false;
    installing = false;
    inspecting: string | null = null;
    killing: string | null = null;
    certBannerDismissed = false;
    private sub?: Subscription;

    get certProfile(): string | null { return this.state.getCertProfile(); }
    get showCertBanner(): boolean {
        return !!this.serial && !this.certProfile && !this.certBannerDismissed;
    }

    constructor(private sdb: SdbService, private state: TizenStateService, private modalService: NgbModal, private tizenRemote: TizenRemoteService) {}

    ngOnInit(): void {
        this.devices = this.state.getSavedDevices();
        this.sub = this.state.selected$.subscribe(dev => {
            this.selected = dev;
            this.apps = null;
            this.appsError = undefined;
            if (dev) this.loadApps();
        });
    }

    ngOnDestroy(): void {
        this.sub?.unsubscribe();
    }

    get serial(): string | null {
        return this.selected ? tizenSerial(this.selected) : null;
    }

    // Apps to show — any environment variant of these brands
    private static readonly ALLOWED_PATTERN =
        /freetv|stingtv|sting\.tv|\bsting\b|yesplus|yes\.plus|\byes\b|partnertv|partner\.tv|\bpartner\b|cellcomtv|cellcom\.tv|\bcellcom\b|\bhot\b|nexttv|next\.tv|\bnext\b|disney|netflix|hbomax|hbo\.max|\bhbo\b|warnermedia/i;

    // Sort order: FreeTV first, then the rest alphabetically
    private static readonly FREETV_PATTERN = /freetv/i;

    isAllowed(app: SdbAppInfo): boolean {
        const re = TizenAppsComponent.ALLOWED_PATTERN;
        return re.test(app.name) || re.test(app.id) || re.test(app.runtimeId ?? '') || re.test(app.tizenId ?? '');
    }

    isPriority(app: SdbAppInfo): boolean {
        const re = TizenAppsComponent.FREETV_PATTERN;
        return re.test(app.name) || re.test(app.id) || re.test(app.runtimeId ?? '') || re.test(app.tizenId ?? '');
    }

    get filteredApps(): SdbAppInfo[] | null {
        if (!this.apps) return null;
        return [...this.apps]
            .filter(app => this.isAllowed(app))
            .sort((a, b) => {
                const aPriority = this.isPriority(a);
                const bPriority = this.isPriority(b);
                if (aPriority !== bPriority) return aPriority ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
    }

    selectDevice(serial: string): void {
        const device = this.devices.find(d => tizenSerial(d) === serial) ?? null;
        this.state.select(device);
    }

    async loadApps(): Promise<void> {
        if (!this.serial) return;
        this.loadingApps = true;
        this.apps = null;
        this.appVersions = new Map();
        this.appsError = undefined;
        try {
            this.apps = await this.sdb.listApps(this.serial);
            // Fetch versions for filtered apps in parallel
            if (this.apps && this.filteredApps) {
                const serial = this.serial;
                await Promise.all(this.filteredApps.map(async app => {
                    const ver = app.versionName || await this.sdb.getAppVersion(serial, app.tizenId || app.id);
                    if (ver) this.appVersions.set(app.id, ver);
                }));
            }
        } catch (e) {
            this.appsError = e as Error;
        } finally {
            this.loadingApps = false;
        }
    }

    async configureCert(): Promise<void> {
        const ref = this.modalService.open(TizenWizardComponent, {
            size: 'lg', centered: true, scrollable: true,
        });
        (ref.componentInstance as TizenWizardComponent).startStep = 3;
        await ref.result.catch(() => {});
        // Banner re-evaluates via certProfile getter automatically
    }

    async pressDown(): Promise<void> {
        if (!this.selected) return;
        try {
            await this.tizenRemote.pressKey(this.selected, 'KEY_DOWN');
        } catch (e) {
            MessageDialogComponent.open(this.modalService, {
                title: 'Remote DOWN failed',
                message: (e as Error).message ?? String(e),
                error: e as Error,
                positive: 'Close',
            });
        }
    }

    async installWgt(): Promise<void> {
        if (!this.serial || this.installing) return;

        const path = await this.sdb.openWgtChooser().catch(() => null);
        if (!path) return;

        // Ensure cert profile is configured
        let certProfile = this.state.getCertProfile();
        if (!certProfile) {
            const ref = this.modalService.open(TizenWizardComponent, {
                size: 'lg', centered: true, scrollable: true,
            });
            (ref.componentInstance as TizenWizardComponent).startStep = 3;
            await ref.result.catch(() => {});
            certProfile = this.state.getCertProfile();
            if (!certProfile) return; // user skipped
        }

        // Get Tizen Studio path (saved when cert was configured)
        const studioPath = this.state.getStudioPath();
        if (!studioPath) {
            MessageDialogComponent.open(this.modalService, {
                title: 'Tizen Studio path unknown',
                message: 'Please re-configure your certificate — browse to your SamsungCertificate folder again.',
                positive: 'Configure',
            }).result.then(() => this.configureCert()).catch(() => {});
            return;
        }

        const INSTALL_STEPS: ProgressStep[] = [
            {key: 'disconnecting', label: 'Disconnecting from TizenBrew'},
            {key: 'waiting',       label: 'Waiting for port to release'},
            {key: 'connecting',    label: 'Connecting with SDB'},
            {key: 'connected',     label: 'Connection established'},
            {key: 'building',      label: 'Building package'},
            {key: 'installing',    label: 'Installing on TV'},
        ];

        const progress = ProgressDialogComponent.open(this.modalService);
        const dialog = progress.componentInstance as ProgressDialogComponent;
        dialog.setSteps(INSTALL_STEPS);
        let progressClosed = false;
        this.installing = true;
        try {
            await this.sdb.installSigned(
                this.serial, path, certProfile, studioPath,
                p => dialog.update(p.message, p.percent, p.step),
            );
            dialog.update('Refreshing app list…', 95, 'done');
            await this.loadApps();
            dialog.update('Done', 100, 'done');
        } catch (e) {
            progressClosed = true;
            progress.close(true);
            const msg = typeof e === 'string' ? e : ((e as Error)?.message ?? String(e));
            const friendly =
                msg.includes('-11') ? 'Author certificate mismatch — uninstall the app from the TV first, then try again.' :
                msg.includes('-12') ? 'Unsigned file error — package structure could not be fixed.' :
                msg;
            MessageDialogComponent.open(this.modalService, {
                title: 'Install failed',
                message: friendly || 'Unknown error — check that the TV is connected and the certificate is valid.',
                positive: 'Close',
            });
            return;
        } finally {
            this.installing = false;
            if (!progressClosed) progress.close(true);
        }
    }

launchApp(app: SdbAppInfo): void {
        if (!this.serial) return;
        this.sdb.launch(this.serial, app.runtimeId || app.id)
            .catch(e => MessageDialogComponent.open(this.modalService, {
                title: 'Failed to launch app',
                message: (e as Error).message,
                error: e as Error,
                positive: 'Close',
            }));
    }

    async killApp(app: SdbAppInfo): Promise<void> {
        if (!this.serial || this.killing) return;
        this.killing = app.id;
        const killId = app.runtimeId || app.id;
        console.log('[kill] app:', JSON.stringify({id: app.id, runtimeId: app.runtimeId, tizenId: app.tizenId}), '→ killing with:', killId);
        try {
            const result = await this.sdb.kill(this.serial, killId);
            console.log('[kill] success, result:', result);
        } catch (e) {
            const msg = (e as Error).message ?? '';
            console.error('[kill] error:', msg);
            MessageDialogComponent.open(this.modalService, {
                title: 'Failed to kill app',
                message: msg,
                error: e as Error,
                positive: 'Close',
            });
        } finally {
            this.killing = null;
        }
    }

    canInspect(_app: SdbAppInfo): boolean {
        return true;
    }

    // ── Stress test ──────────────────────────────────────────────────────────

    private readonly READINESS_SELECTOR = 'h1.metadata__title';

    stressRunningId: string | null = null;
    stressStatus = '';
    stressPassCount = 0;
    stressFailCount = 0;
    stressResults: Array<{cycle: number, pass: boolean, timestamp: string, title: string, channel: string, type: string, label: string, buttons: string[]}> = [];
    stressFinishedFor: string | null = null;
    stressCountdown = 0;
    stressPhase: '' | 'after-launch' | 'after-kill' = '';
    stressTotalRemaining = 0;
    stressPromptForId: string | null = null;
    stressPromptCycles = 2;
    private stressAbort = false;
    private stressCurrentCycle = 0;
    private stressTotalCycles = 0;
    private stressAfterLaunchSec = 0;
    private stressAfterKillSec = 0;

    openStressPrompt(app: SdbAppInfo): void {
        const id = app.runtimeId || app.id;
        if (this.stressRunningId === id) { this.stressAbort = true; return; }
        if (!this.serial || this.stressRunningId) return;
        this.stressPromptCycles = 2;
        this.stressPromptForId = id;
    }

    confirmStressPrompt(): void {
        const id = this.stressPromptForId;
        const cycles = Math.max(1, Math.floor(this.stressPromptCycles || 0));
        this.stressPromptForId = null;
        if (id) this.runStressTest(id, cycles);
    }

    cancelStressPrompt(): void { this.stressPromptForId = null; }

    async runStressTest(id: string, cycles = 2, afterLaunchMs = 30_000, afterKillMs = 10_000): Promise<void> {
        if (this.stressRunningId === id) { this.stressAbort = true; return; }
        if (!this.serial || !this.selected || this.stressRunningId) return;

        const serial = this.serial;
        const ip = this.selected.ip;

        this.stressRunningId = id;
        this.stressAbort = false;
        this.stressPassCount = 0;
        this.stressFailCount = 0;
        this.stressResults = [];
        this.stressFinishedFor = id;
        this.stressTotalCycles = cycles;
        this.stressAfterLaunchSec = Math.ceil(afterLaunchMs / 1000);
        this.stressAfterKillSec   = Math.ceil(afterKillMs  / 1000);

        // Find the app entry to get tizenId for debug calls
        const app = this.apps?.find(a => (a.runtimeId || a.id) === id) ?? null;
        const tizenId = app?.tizenId || id;

        try {
            this.stressStatus = 'Pre-flight: closing app…';
            await this.sdb.kill(serial, id).catch(e => console.warn('[Stress] preflight kill', e));
            await this.stressWait(3000);

            for (let i = 1; i <= cycles; i++) {
                if (this.stressAbort) break;
                this.stressCurrentCycle = i;

                // Launch via debug so we get the CDP port immediately —
                // calling debug() after launch would restart the app and we'd check a blank page.
                this.stressStatus = `Cycle ${i}/${cycles}: launching`;
                console.log(`[Stress] ${this.stressStatus}`);
                let debugPort: number | null = null;
                try {
                    debugPort = await this.sdb.debug(serial, tizenId);
                    console.log(`[Stress] debug port: ${debugPort}`);
                } catch (e) {
                    console.error('[Stress] debug launch failed:', e);
                }
                this.stressPhase = 'after-launch';
                if (await this.stressWait(afterLaunchMs)) break;

                const check = await (debugPort !== null
                    ? this.checkTizenElementByPort(ip, debugPort, this.READINESS_SELECTOR)
                    : Promise.resolve({found: false, title: '', channel: '', type: '', label: '', buttons: [] as string[]})
                ).catch(e => { console.warn('[Stress] check failed:', e); return {found: false, title: '', channel: '', type: '', label: '', buttons: [] as string[]}; });
                const friendlyType = this.toFriendlyType(check.type);
                if (check.found) this.stressPassCount++; else this.stressFailCount++;
                this.stressResults.push({cycle: i, pass: check.found, title: check.title, channel: check.channel, type: friendlyType, label: check.label, buttons: check.buttons, timestamp: new Date().toLocaleTimeString()});
                console.log(`[Stress] Cycle ${i}: ${check.found ? `✅ [${friendlyType}] "${check.title}"` : '❌ MISSING'} (pass ${this.stressPassCount} / fail ${this.stressFailCount})`);

                this.stressStatus = `Cycle ${i}/${cycles}: ${check.found ? 'PASS' : 'FAIL'} → killing`;
                await this.sdb.kill(serial, id).catch(e => console.error('[Stress] kill', e));
                this.stressPhase = 'after-kill';
                if (i < cycles && await this.stressWait(afterKillMs)) break;
            }
            this.stressStatus = this.stressAbort
                ? `Stopped (pass ${this.stressPassCount} / fail ${this.stressFailCount})`
                : `Done (pass ${this.stressPassCount} / fail ${this.stressFailCount})`;
        } finally {
            this.stressRunningId = null;
            this.stressCountdown = 0;
            this.stressPhase = '';
            this.stressTotalRemaining = 0;
        }
    }

    private toFriendlyType(raw: string): string {
        if (!raw) return '';
        return raw.toUpperCase() === 'PROGRAMME' ? 'Live' : 'VOD';
    }

    formatDuration(secs: number): string {
        if (secs <= 0) return '0s';
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = secs % 60;
        const parts: string[] = [];
        if (h) parts.push(`${h}h`);
        if (m || h) parts.push(`${m}m`);
        parts.push(`${s}s`);
        return parts.join(' ');
    }

    private computeStressTotalRemaining(): number {
        if (!this.stressRunningId) return 0;
        const cyclesAfterThis = this.stressTotalCycles - this.stressCurrentCycle;
        const perCycleSec = this.stressAfterLaunchSec + this.stressAfterKillSec;
        let remaining = this.stressCountdown;
        if (this.stressPhase === 'after-launch') remaining += this.stressAfterKillSec;
        remaining += cyclesAfterThis * perCycleSec;
        return remaining;
    }

    clearStressResults(): void {
        this.stressResults = [];
        this.stressFinishedFor = null;
        this.stressStatus = '';
    }

    private async checkTizenElementByPort(
        ip: string, port: number, selector: string,
    ): Promise<{found: boolean, title: string, channel: string, type: string, label: string, buttons: string[]}> {
        const resp = await tauriFetch(`http://${ip}:${port}/json`, {method: 'GET'});
        if (!resp.ok) throw new Error(`devtools /json HTTP ${resp.status}`);
        const targets: Array<{webSocketDebuggerUrl?: string, type?: string, url?: string, title?: string}> = await resp.json();
        console.log('[Stress] CDP targets:', targets.map(t => ({type: t.type, title: t.title, url: t.url, ws: t.webSocketDebuggerUrl})));

        const candidates = targets.filter(t => t.type === 'page' && !!t.webSocketDebuggerUrl);
        for (const target of candidates) {
            // Tizen returns localhost in the WS URL — rewrite to the actual TV IP
            const wsUrl = target.webSocketDebuggerUrl!
                .replace(/^ws:\/\/(localhost|127\.0\.0\.1)/, `ws://${ip}`);
            try {
                const result = await this.cdpEvalInTarget(wsUrl, selector);
                console.log(`[Stress] target ${target.url} → found=${result.found}, type="${result.type}", title="${result.title}"`);
                if (result.found) return {found: true, title: result.title, channel: result.channel, type: result.type, label: result.label, buttons: result.buttons};
            } catch (e) {
                console.warn(`[Stress] target ${target.url} eval failed:`, e);
            }
        }
        return {found: false, title: '', channel: '', type: '', label: '', buttons: []};
    }

    private cdpEvalInTarget(wsUrl: string, selector: string): Promise<{found: boolean, count: number, title: string, channel: string, type: string, label: string, buttons: string[]}> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            const timeout = setTimeout(() => { ws.close(); reject(new Error('CDP timeout')); }, 5000);
            const expression = `(() => {
                const sel = ${JSON.stringify(selector)};
                const all = document.querySelectorAll(sel);
                const first = all[0];
                const channelEl = document.querySelector('.metadata__channel-name');
                const labelEl   = document.querySelector('.metadata__item-label');
                const wrap      = document.querySelector('.metadata.wrapper__details');
                const typeClass = wrap ? Array.from(wrap.classList).find(c => c.indexOf('metadata--') === 0) : '';
                const type      = typeClass ? typeClass.replace('metadata--', '') : '';
                const buttons   = Array.from(document.querySelectorAll('.section__bullets .button__title'))
                    .map(b => (b.textContent || '').trim()).filter(t => t.length > 0);
                return {
                    found: all.length > 0, count: all.length,
                    title:   first      ? (first.textContent      || '').trim() : '',
                    channel: channelEl  ? (channelEl.textContent  || '').trim() : '',
                    label:   labelEl    ? (labelEl.textContent    || '').trim() : '',
                    type, buttons,
                    readyState: document.readyState,
                    bodyTags: document.body ? document.body.children.length : 0,
                };
            })()`;
            ws.onopen = () => ws.send(JSON.stringify({
                id: 1, method: 'Runtime.evaluate',
                params: {expression, returnByValue: true, awaitPromise: false},
            }));
            ws.onmessage = (ev) => {
                clearTimeout(timeout);
                try {
                    const data = JSON.parse(ev.data);
                    const v = data?.result?.result?.value;
                    if (!v) {
                        console.warn('[Stress] CDP raw response:', data);
                        resolve({found: false, count: 0, title: '', channel: '', type: '', label: '', buttons: []});
                    } else {
                        console.log('[Stress] CDP page state:', v);
                        resolve({found: v.found, count: v.count, title: v.title, channel: v.channel, type: v.type, label: v.label, buttons: v.buttons || []});
                    }
                } catch (e) { reject(e); }
                finally { ws.close(); }
            };
            ws.onerror = () => { clearTimeout(timeout); reject(new Error('CDP ws error')); };
        });
    }

    private stressWait(ms: number): Promise<boolean> {
        return new Promise(resolve => {
            const step = 250;
            let elapsed = 0;
            this.stressCountdown = Math.ceil(ms / 1000);
            const timer = setInterval(() => {
                elapsed += step;
                this.stressCountdown = Math.max(0, Math.ceil((ms - elapsed) / 1000));
                this.stressTotalRemaining = this.computeStressTotalRemaining();
                if (this.stressAbort) {
                    clearInterval(timer);
                    this.stressCountdown = 0;
                    resolve(true);
                } else if (elapsed >= ms) {
                    clearInterval(timer);
                    this.stressCountdown = 0;
                    resolve(false);
                }
            }, step);
        });
    }

    isStoreApp(app: SdbAppInfo): boolean {
        return !this.canInspect(app);
    }

    async uninstallApp(app: SdbAppInfo): Promise<void> {
        if (!this.serial) return;
        const confirm = MessageDialogComponent.open(this.modalService, {
            title: 'Uninstall App',
            message: `Uninstall "${app.name}"?`,
            positive: 'Uninstall',
            positiveStyle: 'danger',
            negative: 'Cancel',
            autofocus: 'negative',
        });
        if (!await confirm.result.catch(() => false)) return;

        try {
            await this.sdb.uninstall(this.serial, app.tizenId || app.id, app.runtimeId);
            await this.loadApps();
        } catch (e) {
            MessageDialogComponent.open(this.modalService, {
                title: 'Failed to uninstall app',
                message: (e as Error).message,
                error: e as Error,
                positive: 'Close',
            });
        }
    }

async inspectApp(app: SdbAppInfo): Promise<void> {
        if (!this.serial || !this.selected) return;
        this.inspecting = app.id;
        try {
            // Debug requires the tizenId format (e.g. Plusdrei00.FreeTV), not numeric app id
            const debugId = app.tizenId || app.id;
            const port = await this.sdb.debug(this.serial, debugId);
            await openUrl(`http://${this.selected.ip}:${port}`);
        } catch (e) {
            const raw = (e as Error).message ?? '';
            const cannotInspect = /closed|not allowed|permission|denied|unsupported/i.test(raw);
            MessageDialogComponent.open(this.modalService, {
                title: 'Inspect failed',
                message: cannotInspect
                    ? `This app cannot be inspected.\n\nOnly sideloaded development builds support remote inspection.`
                    : raw,
                positive: 'Close',
            });
        } finally {
            this.inspecting = null;
        }
    }
}
