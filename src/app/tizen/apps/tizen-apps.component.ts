import {Component, OnDestroy, OnInit} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {Subscription} from 'rxjs';
import {open as openUrl} from '@tauri-apps/plugin-shell';
import {SdbAppInfo, SdbService, WgtIcon} from '../../core/services/sdb.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {ProgressDialogComponent, ProgressStep} from '../../shared/components/progress-dialog/progress-dialog.component';
import {tizenSerial, TizenDevice, TizenStateService} from '../tizen-state.service';
import {TizenWizardComponent} from '../wizard/tizen-wizard.component';
import {TizenRemoteDialogComponent} from '../remote-dialog/tizen-remote-dialog.component';
import {isKnownApp, isPriorityApp} from '../../shared/known-apps';
import {tizenEnvironmentIcon} from '../../shared/app-environment-icons';
import {renderEnvironmentBadge, readIcon} from '../../shared/environment-badge';

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

    /**
     * The environment badge for a WGT about to be installed, or `null` when it should keep its
     * packaged icon.
     *
     * Every FreeTV build ships the same green icon, so a TV holding PreProd and UAT side by side
     * shows two identical tiles — and two PreProd builds a week apart are worse still, since
     * nothing on the tile says which one is on the TV. The badge carries the build version for
     * exactly that, which is why it is drawn here rather than picked from a bundled file.
     *
     * webOS fixes the same problem after the install, writing the icon over SFTP. A retail Samsung
     * TV refuses sdb writes to `/opt/share/webappservice/apps_icon/`, so here the icon goes into
     * the package instead — which the install flow is already rebuilding and re-signing anyway.
     *
     * Best-effort: a WGT we cannot read, or artwork we cannot draw, installs with the icon it
     * shipped rather than failing an install over a picture.
     */
    private async environmentIconFor(path: string): Promise<{label: string; wgtIcon: WgtIcon} | null> {
        try {
            const info = await this.sdb.readWgtInfo(path);
            const icon = tizenEnvironmentIcon(info.version, info.id, info.name);
            if (!icon) {
                if (isPriorityApp(info.id, info.name)) {
                    console.log(`[install] no environment marker on ${info.id} — keeping its packaged icon`);
                }
                return null;
            }
            const png = icon.label
                ? await renderEnvironmentBadge(icon.base, icon.label)
                : await readIcon(icon.base);
            console.log(`[install] ${info.id}: baking in the ${icon.describe} icon as ${info.icon}`);
            return {label: icon.describe, wgtIcon: {entry: info.icon, png}};
        } catch (e) {
            console.warn('[install] could not draw an environment icon', e);
            return null;
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

        const icon = await this.environmentIconFor(path);

        const INSTALL_STEPS: ProgressStep[] = [
            {key: 'disconnecting', label: 'Disconnecting from TizenBrew'},
            {key: 'waiting',       label: 'Waiting for port to release'},
            {key: 'certificate',   label: 'Matching certificate to TV'},
            {key: 'connecting',    label: 'Connecting with SDB'},
            {key: 'connected',     label: 'Connection established'},
            {key: 'building',      label: icon ? `Building package with the ${icon.label} icon` : 'Building package'},
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
                icon?.wgtIcon,
            );
            dialog.update('Refreshing app list…', 95, 'done');
            if (this.serial) this.state.invalidateApps(this.serial);
            await this.loadApps();
            dialog.update('Done', 100, 'done');
        } catch (e) {
            progressClosed = true;
            progress.close(true);
            const msg = typeof e === 'string' ? e : ((e as Error)?.message ?? String(e));
            // Match the bracketed pkgmgr codes (`install failed[118, -12]`) rather than a
            // bare '-11' / '-12', which also turn up in paths and version strings.
            const friendly =
                /\[\s*\d+\s*,\s*-11\s*]/.test(msg)
                    ? 'Author certificate mismatch — uninstall the app from the TV first, then try again.'
                    : /\[\s*\d+\s*,\s*-12\s*]/.test(msg)
                        ? 'The TV rejected the package signature. Its DUID is most likely missing from '
                          + 'the Samsung distributor certificate that signed the build — add this TV in '
                          + 'Certificate Manager, then try again.'
                        : msg;
            MessageDialogComponent.open(this.modalService, {
                title: 'Install failed',
                message: friendly || 'Unknown error — check that the TV is connected and the certificate is valid.',
                // Keep the raw CLI output reachable — the friendly text is a guess at the cause.
                error: friendly === msg ? undefined : Object.assign(new Error(friendly), {details: msg}),
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
