import {Component, OnDestroy, OnInit} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {Subscription} from 'rxjs';
import {open as openUrl} from '@tauri-apps/plugin-shell';
import {SdbAppInfo, SdbService} from '../../core/services/sdb.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {ProgressDialogComponent, ProgressStep} from '../../shared/components/progress-dialog/progress-dialog.component';
import {tizenSerial, TizenDevice, TizenStateService} from '../tizen-state.service';
import {TizenWizardComponent} from '../wizard/tizen-wizard.component';
import {TizenRemoteDialogComponent} from '../remote-dialog/tizen-remote-dialog.component';
import {isKnownApp, isPriorityApp} from '../../shared/known-apps';

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

    constructor(private sdb: SdbService, private state: TizenStateService, private modalService: NgbModal) {}

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

    isAllowed(app: SdbAppInfo): boolean {
        return isKnownApp(app.name, app.id, app.runtimeId, app.tizenId);
    }

    // Sort order: FreeTV first, then the rest alphabetically
    isPriority(app: SdbAppInfo): boolean {
        return isPriorityApp(app.name, app.id, app.runtimeId, app.tizenId);
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

    async loadApps(force = false): Promise<void> {
        if (!this.serial) return;
        if (!force) {
            const cached = this.state.getCachedApps(this.serial);
            if (cached) {
                this.apps = cached.apps;
                this.appVersions = cached.versions;
                return;
            }
        }
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
            this.state.setCachedApps(this.serial, {apps: this.apps ?? [], versions: this.appVersions});
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

    openRemote(): void {
        if (!this.selected || !this.serial) return;
        const ref = this.modalService.open(TizenRemoteDialogComponent, {centered: true});
        const inst = ref.componentInstance as TizenRemoteDialogComponent;
        inst.device = this.selected;
        inst.serial = this.serial;
        inst.wgtApps = (this.filteredApps ?? []).filter(a => !!a.tizenId);
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
            if (this.serial) this.state.invalidateApps(this.serial);
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
            this.state.invalidateApps(this.serial);
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
