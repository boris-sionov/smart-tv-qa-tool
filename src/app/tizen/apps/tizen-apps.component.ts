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
    appsError?: Error;
    loadingApps = false;
    installing = false;
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

    private static readonly ALLOWED_PATTERN = /freetv|\b(sting|yes|partner|cellcom|hot|next)\b/i;

    get filteredApps(): SdbAppInfo[] | null {
        if (!this.apps) return null;
        const re = TizenAppsComponent.ALLOWED_PATTERN;
        return this.apps
            .filter(app => re.test(app.name) || re.test(app.id))
            .sort((a, b) => {
                const aFtv = /freetv/i.test(a.name) || /freetv/i.test(a.id);
                const bFtv = /freetv/i.test(b.name) || /freetv/i.test(b.id);
                if (aFtv !== bFtv) return aFtv ? -1 : 1;
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
        this.appsError = undefined;
        try {
            this.apps = await this.sdb.listApps(this.serial);
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
        this.installing = true;
        try {
            component.update('Installing package...', 30);
            await this.sdb.install(this.serial, path);
            component.update('Refreshing app list...', 80);
            await this.loadApps();
            component.update('Done', 100);
        } catch (e) {
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
            progress.close(true);
        }
    }

    launchApp(app: SdbAppInfo): void {
        if (!this.serial) return;
        this.sdb.launch(this.serial, app.id)
            .catch(e => MessageDialogComponent.open(this.modalService, {
                title: 'Failed to launch app',
                message: (e as Error).message,
                error: e as Error,
                positive: 'Close',
            }));
    }

    killApp(app: SdbAppInfo): void {
        if (!this.serial) return;
        this.sdb.kill(this.serial, app.id)
            .catch(e => MessageDialogComponent.open(this.modalService, {
                title: 'Failed to kill app',
                message: (e as Error).message,
                error: e as Error,
                positive: 'Close',
            }));
    }

    async inspectApp(app: SdbAppInfo): Promise<void> {
        if (!this.serial || !this.selected) return;
        this.inspecting = app.id;
        try {
            const port = await this.sdb.debug(this.serial, app.id);
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
