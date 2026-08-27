import {Component, Injector, OnDestroy, OnInit, ViewChild} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {noop, Observable, Subscription} from 'rxjs';
import {Device, PackageInfo, RawPackageInfo} from '../types';
import {AppManagerService, DeviceManagerService, RepositoryItem} from '../core/services';
import {IconStampResult} from '../core/services/app-manager.service';
import {LgRemoteService} from '../core/services/lg-remote.service';
import {fetch as tauriFetch} from '@tauri-apps/plugin-http';
import {RemoteFileService} from '../core/services/remote-file.service';
import {MessageDialogComponent} from '../shared/components/message-dialog/message-dialog.component';
import {ProgressDialogComponent} from '../shared/components/progress-dialog/progress-dialog.component';
import {keyBy} from 'lodash';
import {open as showOpenDialog} from '@tauri-apps/plugin-dialog';
import {open as openUrl} from '@tauri-apps/plugin-shell';
import {basename, downloadDir} from "@tauri-apps/api/path";
import {APP_ID_HBCHANNEL} from "../shared/constants";
import {HbchannelRemoveComponent} from "./hbchannel-remove/hbchannel-remove.component";
import {StatStorageInfoComponent} from "../shared/components/stat-storage-info/stat-storage-info.component";
import {DetailsComponent} from "./details/details.component";
import {InstalledComponent} from "./installed/installed.component";

/**
 * - `developer`: only what was sideloaded in dev mode (dev/listApps over SSH)
 * - `apps`: every app on the TV, narrowed to the brands QA tracks
 */
export type AppsScope = 'developer' | 'apps';

const APPS_SCOPE_KEY = 'smart-tv-qa-lg-apps-scope';

@Component({
    selector: 'app-apps',
    templateUrl: './apps.component.html',
    styleUrls: ['./apps.component.scss']
})
export class AppsComponent implements OnInit, OnDestroy {

    packages$?: Observable<PackageInfo[] | null>;
    device: Device | null = null;
    devices$?: Observable<Device[]|null>;
    appsScope: AppsScope = AppsComponent.restoreScope();

    @ViewChild('storageInfo') storageInfo?: StatStorageInfoComponent;
    @ViewChild('installedComponent') installedComponent?: InstalledComponent;

    private deviceSubscription?: Subscription;
    private packagesSubscription?: Subscription;

    constructor(
        public deviceManager: DeviceManagerService,
        private modalService: NgbModal,
        private appManager: AppManagerService,
        private fileService: RemoteFileService,
        private lgRemote: LgRemoteService,
    ) {
    }

    ngOnInit(): void {
        this.devices$ = this.deviceManager.devices$;
        this.deviceSubscription = this.deviceManager.selected$.subscribe((device) => {
            this.device = device;
            if (device) {
                this.loadPackages();
            } else {
                this.packages$ = undefined;
                this.packagesSubscription?.unsubscribe();
                this.packagesSubscription = undefined;
            }
        });
    }

    ngOnDestroy(): void {
        this.deviceSubscription?.unsubscribe();
        this.packagesSubscription?.unsubscribe();
        this.packagesSubscription = undefined;
    }

    loadPackages(): void {
        const device = this.device;
        if (!device) return;
        const all = this.appsScope !== 'developer';
        this.packagesSubscription?.unsubscribe();
        this.packages$ = all ? this.appManager.allPackages$(device) : this.appManager.packages$(device);
        this.packagesSubscription = this.packages$.subscribe({
            next: noop, error: noop
        });
        (all ? this.appManager.loadAll(device) : this.appManager.load(device)).catch(noop);
    }

    setAppsScope(scope: AppsScope): void {
        if (this.appsScope === scope) return;
        this.appsScope = scope;
        localStorage.setItem(APPS_SCOPE_KEY, scope);
        this.loadPackages();
    }

    private static restoreScope(): AppsScope {
        // Default to the filtered list, like the Samsung and Android TV pages.
        return localStorage.getItem(APPS_SCOPE_KEY) === 'developer' ? 'developer' : 'apps';
    }

    async openInstallChooser(): Promise<void> {
        if (!this.device) return;
        const path = await showOpenDialog({
            filters: [{name: 'IPK package', extensions: ['ipk']}],
            multiple: false,
            defaultPath: await downloadDir(),
        }).then(result => result);
        if (!path) {
            return;
        }
        const progress = ProgressDialogComponent.open(this.modalService);
        const component = progress.componentInstance as ProgressDialogComponent;
        let icons: IconStampResult | undefined;
        try {
            icons = await this.appManager.installByPath(this.device, path,
                (progress, statusText) => component.update(statusText, progress));
        } catch (e) {
            console.warn(e);
            this.handleInstallationError(await basename(path), e as Error);
        } finally {
            progress.close(true);
        }
        // The install itself worked; say so when the environment icon didn't follow, instead of
        // leaving a generic tile and no explanation.
        if (icons?.problems.length) {
            MessageDialogComponent.open(this.modalService, {
                title: 'App icon not updated',
                message: `${icons.stamped.length ? `Stamped ${icons.stamped.join(', ')}. ` : ''}`
                    + `The app is installed, but its icon was left as the IPK shipped it:\n\n`
                    + icons.problems.join('\n'),
                positive: 'Close',
            });
        }
    }

    launchApp(id: string): void {
        if (!this.device) return;
        this.appManager.launch(this.device, id).then(noop);
    }

    killApp(id: string): void {
        if (!this.device) return;
        this.appManager.close(this.device, id).then(noop);
    }

    stressRunningId: string | null = null;
    stressStatus: string = '';
    stressPassCount = 0;
    stressFailCount = 0;
    stressResults: Array<{cycle: number, pass: boolean, timestamp: string, title: string, channel: string, type: string, label: string, buttons: string[]}> = [];
    stressFinishedFor: string | null = null;
    stressCountdown = 0;
    stressPhase: '' | 'after-launch' | 'after-kill' = '';
    stressTotalRemaining = 0;
    private stressAbort = false;
    private stressCurrentCycle = 0;
    private stressTotalCycles = 0;
    private stressAfterLaunchSec = 0;
    private stressAfterKillSec = 0;
    private readonly READINESS_SELECTOR = 'h1.metadata__title';

    stressPromptForId: string | null = null;
    stressPromptCycles = 2;

    openStressPrompt(id: string): void {
        if (this.stressRunningId === id) {
            this.stressAbort = true;
            return;
        }
        if (!this.device || this.stressRunningId) return;
        this.stressPromptCycles = 2;
        this.stressPromptForId = id;
    }

    confirmStressPrompt(): void {
        const id = this.stressPromptForId;
        const cycles = Math.max(1, Math.floor(this.stressPromptCycles || 0));
        this.stressPromptForId = null;
        if (id) this.toggleStressTest(id, cycles);
    }

    cancelStressPrompt(): void {
        this.stressPromptForId = null;
    }

    async toggleStressTest(id: string, cycles = 2, afterLaunchMs = 30_000, afterKillMs = 10_000): Promise<void> {
        if (this.stressRunningId === id) {
            this.stressAbort = true;
            return;
        }
        if (!this.device || this.stressRunningId) return;
        this.stressRunningId = id;
        this.stressAbort = false;
        this.stressPassCount = 0;
        this.stressFailCount = 0;
        this.stressResults = [];
        this.stressFinishedFor = id;
        this.stressTotalCycles = cycles;
        this.stressAfterLaunchSec = Math.ceil(afterLaunchMs / 1000);
        this.stressAfterKillSec = Math.ceil(afterKillMs / 1000);
        const host = this.device.host;
        try {
            // Pre-flight: kill any running instance of this app before starting
            this.stressStatus = 'Pre-flight: closing app if running…';
            console.log(`[Stress] ${this.stressStatus}`);
            await this.appManager.close(this.device, id).catch(e => console.warn('[Stress] preflight close', e));
            await this.stressWait(3000);

            for (let i = 1; i <= cycles; i++) {
                if (this.stressAbort) break;
                this.stressCurrentCycle = i;
                this.stressStatus = `Cycle ${i}/${cycles}: launching`;
                console.log(`[Stress] ${this.stressStatus}`);
                await this.appManager.launch(this.device, id).catch(e => console.error('[Stress] launch', e));
                this.stressPhase = 'after-launch';
                if (await this.stressWait(afterLaunchMs)) break;

                const check = await this.checkTvElement(host, this.READINESS_SELECTOR)
                    .catch(e => { console.warn('[Stress] check failed:', e); return {found: false, title: '', channel: '', type: '', label: '', buttons: [] as string[]}; });
                const friendlyType = this.toFriendlyType(check.type);
                if (check.found) this.stressPassCount++; else this.stressFailCount++;
                this.stressResults.push({cycle: i, pass: check.found, title: check.title, channel: check.channel, type: friendlyType, label: check.label, buttons: check.buttons, timestamp: new Date().toLocaleTimeString()});
                console.log(`[Stress] Cycle ${i}/${cycles}: ${check.found ? `✅ [${friendlyType || '?'}] "${check.title}" buttons=[${check.buttons.join(', ')}]` : '❌ MISSING'} (pass ${this.stressPassCount} / fail ${this.stressFailCount})`);

                this.stressStatus = `Cycle ${i}/${cycles}: ${check.found ? 'PASS' : 'FAIL'} → killing`;
                console.log(`[Stress] ${this.stressStatus}`);
                await this.appManager.close(this.device, id).catch(e => console.error('[Stress] kill', e));
                this.stressPhase = 'after-kill';
                if (i < cycles && await this.stressWait(afterKillMs)) break;
            }
            this.stressStatus = this.stressAbort
                ? `Stopped (pass ${this.stressPassCount} / fail ${this.stressFailCount})`
                : `Done (pass ${this.stressPassCount} / fail ${this.stressFailCount})`;
            console.log(`[Stress] ${this.stressStatus}`);
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
        if (this.stressPhase === 'after-launch') {
            // still need to kill + wait afterKill in current cycle
            remaining += this.stressAfterKillSec;
        }
        remaining += cyclesAfterThis * perCycleSec;
        return remaining;
    }

    clearStressResults(): void {
        this.stressResults = [];
        this.stressFinishedFor = null;
        this.stressStatus = '';
    }

    private async isAppRunning(host: string, appId: string): Promise<boolean> {
        try {
            const resp = await tauriFetch(`http://${host}:9998/json`, {method: 'GET'});
            if (!resp.ok) return false;
            const targets: Array<{type?: string, url?: string, title?: string}> = await resp.json();
            const hit = targets.some(t =>
                t.type === 'page' &&
                ((t.url ?? '').includes(appId) || (t.title ?? '').includes(appId) || (t.url ?? '').includes('/media/developer/apps/usr/palm/applications/' + appId))
            );
            console.log(`[Stress] isAppRunning(${appId}) → ${hit}`);
            return hit;
        } catch (e) {
            console.warn('[Stress] isAppRunning probe failed:', e);
            return false;
        }
    }

    private async checkTvElement(host: string, selector: string): Promise<{found: boolean, title: string, channel: string, type: string, label: string, buttons: string[]}> {
        const resp = await tauriFetch(`http://${host}:9998/json`, {method: 'GET'});
        if (!resp.ok) throw new Error(`devtools /json HTTP ${resp.status}`);
        const targets: Array<{webSocketDebuggerUrl?: string, type?: string, url?: string, title?: string}> = await resp.json();
        console.log('[Stress] CDP targets:', targets.map(t => ({type: t.type, title: t.title, url: t.url})));

        const candidates = targets.filter(t => t.type === 'page' && !!t.webSocketDebuggerUrl);
        for (const target of candidates) {
            try {
                const result = await this.cdpEvalInTarget(target.webSocketDebuggerUrl!, selector);
                console.log(`[Stress] target ${target.url} → found=${result.found}, type="${result.type}", title="${result.title}", label="${result.label}", channel="${result.channel}", buttons=${JSON.stringify(result.buttons)}`);
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
                const labelEl = document.querySelector('.metadata__item-label');
                const wrap = document.querySelector('.metadata.wrapper__details');
                const typeClass = wrap ? Array.from(wrap.classList).find(c => c.indexOf('metadata--') === 0) : '';
                const type = typeClass ? typeClass.replace('metadata--', '') : '';
                const buttons = Array.from(document.querySelectorAll('.section__bullets .button__title'))
                    .map(b => (b.textContent || '').trim())
                    .filter(t => t.length > 0);
                return {
                    found: all.length > 0,
                    count: all.length,
                    title: first ? (first.textContent || '').trim() : '',
                    channel: channelEl ? (channelEl.textContent || '').trim() : '',
                    label: labelEl ? (labelEl.textContent || '').trim() : '',
                    type: type,
                    buttons: buttons,
                    readyState: document.readyState,
                    bodyTags: document.body ? document.body.children.length : 0,
                };
            })()`;
            ws.onopen = () => ws.send(JSON.stringify({
                id: 1, method: 'Runtime.evaluate',
                params: {expression, returnByValue: true, awaitPromise: false}
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
                } catch (e) {
                    reject(e);
                } finally {
                    ws.close();
                }
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

    async pressDown(): Promise<void> {
        if (!this.device) return;
        try {
            await this.lgRemote.pressButton(this.device, 'DOWN');
            console.log('[Remote] DOWN sent');
        } catch (e) {
            console.error('[Remote] DOWN failed:', e);
        }
    }

    inspectApp(): void {
        if (!this.device) return;
        openUrl(`http://${this.device.host}:9998`).then(noop);
    }

    async changeAppIcon(pkg: RawPackageInfo): Promise<void> {
        if (!this.device) return;
        const path = await showOpenDialog({
            filters: [{name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp']}],
            multiple: false,
            defaultPath: '/Users/borissionov/Privet/FreeTV/LG icons',
        });
        if (!path) return;
        const iconPath = `${pkg.folderPath}/${pkg.icon}`;
        const progress = ProgressDialogComponent.open(this.modalService);
        try {
            const component = progress.componentInstance as ProgressDialogComponent;
            component.update('Removing old icon...', 0);
            await this.fileService.rm(this.device, iconPath, false);

            component.update('Uploading new icon...', 50);
            await this.fileService.put(this.device, iconPath, path);

            component.update('Reloading apps...', 90);
            await this.appManager.refresh(this.device);
            this.installedComponent?.forceReloadIcon(pkg.id);
        } catch (e) {
            MessageDialogComponent.open(this.modalService, {
                title: 'Failed to change icon',
                message: (e as Error).message,
                error: e as Error,
                positive: 'Close',
            });
        } finally {
            progress.close(true);
        }
    }

    async removePackage(pkg: RawPackageInfo): Promise<boolean> {
        if (!this.device) return false;
        const confirm = MessageDialogComponent.open(this.modalService, {
            title: 'Uninstall App',
            message: `Uninstall app \"${pkg.title}\"?`,
            positive: 'Uninstall',
            positiveStyle: 'danger',
            negative: 'Cancel',
            autofocus: 'negative',
        });
        if (!await confirm.result.catch(() => false)) return false;
        if (pkg.id === APP_ID_HBCHANNEL) {
            const doubleConfirm = MessageDialogComponent.open(this.modalService, {
                message: HbchannelRemoveComponent,
                positive: 'Yes, uninstall Homebrew Channel',
                positiveStyle: 'danger',
                negative: 'Cancel',
                autofocus: 'negative',
            });
            if (!await doubleConfirm.result.catch(() => false)) return false;
        }
        const progress = ProgressDialogComponent.open(this.modalService);
        try {
            await this.appManager.remove(this.device, pkg.id);
            this.storageInfo?.refresh();
            return true;
        } catch (e) {
            MessageDialogComponent.open(this.modalService, {
                message: `Failed to uninstall ${pkg.title}`,
                error: e as Error,
                positive: 'Close'
            });
            return false;
        } finally {
            progress.close(true);
        }
    }

    async installPackage(item: RepositoryItem, channel: 'stable' | 'beta' = 'stable'): Promise<boolean> {
        const device = this.device;
        if (!device) return false;
        const progress = ProgressDialogComponent.open(this.modalService);
        try {
            const installLocation = await this.appManager.findInstallLocation(device, item.id).catch(() => null);
            if (installLocation && installLocation !== 'developer') {
                MessageDialogComponent.open(this.modalService, {
                    title: `Cannot install ${item.title}`,
                    message: `Another app with the same ID is already installed. If it was install by LG Content Store, you need to uninstall it first.`,
                    positive: 'Close',
                });
                return false;
            }
            const incompatible = await this.appManager.checkIncompatibility(device, item);
            if (incompatible) {
                const incompatibleConfirm = MessageDialogComponent.open(this.modalService, {
                    title: 'Incompatible App',
                    message: `App ${item.title} is marked not compatible with ${device.name}. It may not work properly or not at all.`,
                    positive: 'Install Anyway',
                    positiveStyle: 'danger',
                    negative: 'Cancel',
                    autofocus: 'negative',
                });
                if (!await incompatibleConfirm.result.catch(() => false)) {
                    return false;
                }
            }
            const manifest = channel === 'stable' ? item.manifest : item.manifestBeta;
            if (!manifest) {
                MessageDialogComponent.open(this.modalService, {
                    title: `Failed to install ${item.title}`,
                    message: `No manifest found for ${item.title} in channel ${channel}`,
                    positive: 'Close',
                });
                return false;
            }
            const component = progress.componentInstance as ProgressDialogComponent;
            await this.appManager.installByManifest(device, manifest,
                (progress, statusText) => component.update(statusText, progress));
            this.storageInfo?.refresh();
            return true;
        } catch (e: any) {
            this.handleInstallationError(item.title, e as Error);
            return false;
        } finally {
            progress.close(true);
        }
    }

    openDetails(item: RepositoryItem): void {
        const modalRef = this.modalService.open(DetailsComponent, {
            size: 'lg',
            scrollable: true,
            injector: Injector.create({
                providers: [
                    {provide: RepositoryItem, useValue: item},
                    {provide: 'device', useValue: this.device},
                ],
            }),
        });
        const component = modalRef.componentInstance as DetailsComponent;
        component.parent = this;
    }

    private handleInstallationError(name: string, e: Error) {
        MessageDialogComponent.open(this.modalService, {
            title: `Failed to install ${name}`,
            message: e.message,
            error: e,
            positive: 'Close',
        });
    }
}
