import {Component, OnDestroy, OnInit} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {Subscription} from 'rxjs';
import {VidaaService, VidaaApp} from '../vidaa.service';
import {VidaaStateService, VidaaSavedDevice} from '../vidaa-state.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {ProgressDialogComponent} from '../../shared/components/progress-dialog/progress-dialog.component';

const KNOWN_URLS: {label: string; url: string}[] = [
    {label: 'FreeTV PreProd', url: 'https://uat-web.freetv.tv/apps/smarttv/preprod/hisense/index.html'},
];

@Component({
    selector: 'app-vidaa-apps',
    templateUrl: './vidaa-apps.component.html',
    styleUrls: ['./vidaa-apps.component.scss'],
})
export class VidaaAppsComponent implements OnInit, OnDestroy {

    apps: VidaaApp[] | null = null;
    appsError?: Error;
    loading = false;
    selected: VidaaSavedDevice | null = null;
    devices: VidaaSavedDevice[] = [];

    installUrl = '';
    installName = '';
    installing = false;
    knownUrls = KNOWN_URLS;

    private sub?: Subscription;

    constructor(
        private vidaa: VidaaService,
        private state: VidaaStateService,
        private modalService: NgbModal,
    ) {}

    ngOnInit(): void {
        this.sub = new Subscription();
        this.sub.add(this.state.selected$.subscribe(dev => {
            this.selected = dev;
            this.apps = null;
            this.appsError = undefined;
            if (dev) this.loadApps();
        }));
        this.devices = this.state.getSavedDevices();
    }

    ngOnDestroy(): void {
        this.sub?.unsubscribe();
    }

    selectDevice(ip: string): void {
        if (!ip) { this.state.select(null); return; }
        const dev = this.state.getSavedDevices().find(d => d.ip === ip);
        if (dev) this.state.select(dev);
    }

    async loadApps(): Promise<void> {
        if (!this.selected) return;
        this.appsError = undefined;
        this.loading = true;
        this.apps = null;
        try {
            this.apps = await this.vidaa.listApps(this.selected.ip);
        } catch (e) {
            this.appsError = e as Error;
        } finally {
            this.loading = false;
        }
    }

    useKnownUrl(entry: {label: string; url: string}): void {
        this.installUrl = entry.url;
        this.installName = entry.label;
    }

    async installApp(): Promise<void> {
        if (!this.selected || !this.installUrl.trim() || !this.installName.trim()) return;
        this.installing = true;
        const progress = ProgressDialogComponent.open(this.modalService);
        const comp = progress.componentInstance as ProgressDialogComponent;
        try {
            comp.update(`Installing "${this.installName}"…`, 50);
            await this.vidaa.installApp(this.selected.ip, this.installUrl.trim(), this.installName.trim());
            comp.update('Refreshing app list…', 85);
            await this.loadApps();
            this.installUrl = '';
            this.installName = '';
        } catch (e) {
            MessageDialogComponent.open(this.modalService, {
                title: 'Install failed',
                message: (e as Error).message,
                error: e as Error,
                positive: 'Close',
            });
        } finally {
            progress.close(true);
            this.installing = false;
        }
    }

    async uninstallApp(app: VidaaApp): Promise<void> {
        if (!this.selected) return;
        const confirm = MessageDialogComponent.open(this.modalService, {
            title: 'Remove App',
            message: `Remove "${app.AppName}"?`,
            positive: 'Remove', positiveStyle: 'danger', negative: 'Cancel', autofocus: 'negative',
        });
        if (!await confirm.result.catch(() => false)) return;
        const progress = ProgressDialogComponent.open(this.modalService);
        try {
            await this.vidaa.uninstallApp(this.selected.ip, app.Id);
            await this.loadApps();
        } catch (e) {
            MessageDialogComponent.open(this.modalService, {
                title: 'Remove failed', message: (e as Error).message, error: e as Error, positive: 'Close',
            });
        } finally {
            progress.close(true);
        }
    }

    inspectApp(): void {
        if (!this.selected) return;
        this.vidaa.inspect(this.selected.ip).catch(e =>
            MessageDialogComponent.open(this.modalService, {
                title: 'Inspect failed', message: (e as Error).message, error: e as Error, positive: 'Close',
            }));
    }
}
