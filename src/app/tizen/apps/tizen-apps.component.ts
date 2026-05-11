import {Component, OnDestroy, OnInit} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {Subscription} from 'rxjs';
import {open as openUrl} from '@tauri-apps/plugin-shell';
import {SdbAppInfo, SdbService} from '../../core/services/sdb.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {ProgressDialogComponent} from '../../shared/components/progress-dialog/progress-dialog.component';
import {tizenSerial, TizenDevice, TizenStateService} from '../tizen-state.service';

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
    installingTizenBrew = false;
    inspecting: string | null = null;
    private sub?: Subscription;

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

    async installWgt(): Promise<void> {
        if (!this.serial || this.installing) return;

        const path = await this.sdb.openWgtChooser().catch(() => null);
        if (!path) return;

        const progress = ProgressDialogComponent.open(this.modalService);
        const component = progress.componentInstance as ProgressDialogComponent;
        let progressClosed = false;
        this.installing = true;
        try {
            component.update('Installing package...', 30);
            await this.sdb.install(this.serial, path);
            component.update('Refreshing app list...', 80);
            await this.loadApps();
            component.update('Done', 100);
        } catch (e) {
            progressClosed = true;
            progress.close(true);
            MessageDialogComponent.open(this.modalService, {
                title: 'Install failed',
                message: (e as Error).message,
                error: e as Error,
                positive: 'Close',
            });
            return;
        } finally {
            this.installing = false;
            if (!progressClosed) progress.close(true);
        }
    }

    async installViaTizenBrew(): Promise<void> {
        if (!this.serial || this.installingTizenBrew) return;

        const path = await this.sdb.openWgtChooser().catch(() => null);
        if (!path) return;

        const progress = ProgressDialogComponent.open(this.modalService);
        const component = progress.componentInstance as ProgressDialogComponent;
        let progressClosed = false;
        this.installingTizenBrew = true;
        try {
            component.update('Testing TizenBrew install...', 25);
            const output = await this.sdb.installViaTizenBrew(this.serial, path);
            component.update('Refreshing app list...', 80);
            await this.loadApps();
            component.update('Done', 100);
            progressClosed = true;
            progress.close(true);
            MessageDialogComponent.open(this.modalService, {
                title: 'TizenBrew install output',
                message: this.lastRelevantLines(output),
                positive: 'Close',
                size: 'lg',
            });
        } catch (e) {
            progressClosed = true;
            progress.close(true);
            MessageDialogComponent.open(this.modalService, {
                title: 'TizenBrew install failed',
                message: this.lastRelevantLines((e as Error).message),
                error: e as Error,
                positive: 'Close',
                size: 'lg',
            });
            return;
        } finally {
            this.installingTizenBrew = false;
            if (!progressClosed) progress.close(true);
        }
    }

    private lastRelevantLines(output: string): string {
        const lines = output.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim() !== '');
        return lines.slice(-16).join('\n') || '(no output)';
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
            MessageDialogComponent.open(this.modalService, {
                title: 'Inspect failed',
                message: (e as Error).message,
                error: e as Error,
                positive: 'Close',
            });
        } finally {
            this.inspecting = null;
        }
    }
}
