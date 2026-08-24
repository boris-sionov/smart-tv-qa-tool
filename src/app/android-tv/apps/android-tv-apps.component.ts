import {Component, OnDestroy, OnInit} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {noop, Subscription} from 'rxjs';
import {AdbService, AdbPackageInfo} from '../../core/services/adb.service';
import {AdbStateService, deviceSerial, SavedDevice} from '../adb-state.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {ProgressDialogComponent} from '../../shared/components/progress-dialog/progress-dialog.component';
import {extractMessage} from '../../core/utils/error.utils';

@Component({
    selector: 'app-android-tv-apps',
    templateUrl: './android-tv-apps.component.html',
    styleUrls: ['./android-tv-apps.component.scss']
})
export class AndroidTvAppsComponent implements OnInit, OnDestroy {

    packages: AdbPackageInfo[] | null = null;
    packagesError?: Error;
    loading = false;
    selected: SavedDevice | null = null;
    devices: SavedDevice[] = [];
    private sub?: Subscription;

    getIconPath(packageId: string): string {
        return `assets/app-icons/${packageId}.png`;
    }

    hasIcon(packageId: string): boolean {
        // OTT streaming apps with extracted icons
        const extracted = ['tv.freetv.androidtv', 'tv.freetv.androidtv.uat', 'il.co.stingtv.staging', 'il.co.partnertv.atv', 'com.stingtv.androidtv', 'com.stingtv.androidtv.staging', 'il.co.partnertv.atv.staging', 'tv.partner.androidtv', 'tv.partner.androidtv.staging', 'tv.yes.androidtv', 'com.yes.yestv', 'com.cellcom.cellcom_tv', 'tv.cellcom.androidtv', 'tv.cellcom.androidtv.stg', 'com.netflix.ninja', 'com.hbo.hbomax', 'com.disneyplus', 'com.hotstar.androidtv'];
        return extracted.includes(packageId);
    }

    constructor(private adb: AdbService, private state: AdbStateService, private modalService: NgbModal) {}

    ngOnInit(): void {
        this.sub = new Subscription();

        this.sub.add(this.state.selected$.subscribe(dev => {
            this.selected = dev;
            this.packages = null;
            this.packagesError = undefined;
            if (dev) this.loadPackages();
        }));

        this.devices = this.state.getSavedDevices();
    }

    ngOnDestroy(): void {
        this.sub?.unsubscribe();
    }

    get serial(): string | null {
        const dev = this.state.selected$.value;
        return dev ? deviceSerial(dev) : null;
    }

    selectDevice(deviceSerial: string): void {
        if (!deviceSerial) {
            this.state.select(null);
            return;
        }
        const [ip, portStr] = deviceSerial.split(':');
        const port = parseInt(portStr, 10);
        const devices = this.state.getSavedDevices();
        const device = devices.find(d => d.ip === ip && d.port === port);
        if (device) {
            this.state.select(device);
        }
    }

    async loadPackages(force = false): Promise<void> {
        if (!this.serial) return;
        if (!force) {
            const cached = this.state.getCachedPackages(this.serial);
            if (cached) {
                this.packages = cached;
                return;
            }
        }
        this.packagesError = undefined;
        this.loading = true;
        this.packages = null;
        try {
            this.packages = await this.adb.listPackages(this.serial);
            this.state.setCachedPackages(this.serial, this.packages);
        } catch (e) {
            this.packagesError = new Error(extractMessage(e, 'Failed to load apps'));
        } finally {
            this.loading = false;
        }
    }

    async installApk(): Promise<void> {
        if (!this.serial) return;
        const path = await this.adb.openApkChooser();
        if (!path) return;
        const progress = ProgressDialogComponent.open(this.modalService);
        const component = progress.componentInstance as ProgressDialogComponent;
        try {
            component.update('Installing APK...', 50);
            await this.adb.install(this.serial, path);
            component.update('Extracting app icon...', 75);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for icon extraction to complete
            if (this.serial) this.state.invalidatePackages(this.serial);
            await this.loadPackages();
            window.location.reload(); // Reload to pick up new icons
        } catch (e) {
            MessageDialogComponent.open(this.modalService, {
                title: 'Failed to install', message: extractMessage(e, 'Failed to install'), positive: 'Close',
            });
        } finally {
            progress.close(true);
        }
    }

    launchApp(pkg: AdbPackageInfo): void {
        if (!this.serial) return;
        this.adb.launch(this.serial, pkg.id).catch(e =>
            MessageDialogComponent.open(this.modalService, {
                title: 'Failed to launch', message: extractMessage(e, 'Failed to launch'), positive: 'Close',
            }));
    }

    killApp(pkg: AdbPackageInfo): void {
        if (!this.serial) return;
        this.adb.forceStop(this.serial, pkg.id).catch(e =>
            MessageDialogComponent.open(this.modalService, {
                title: 'Failed to kill', message: extractMessage(e, 'Failed to kill app'), positive: 'Close',
            }));
    }

    async removePackage(pkg: AdbPackageInfo): Promise<void> {
        if (!this.serial) return;
        const confirm = MessageDialogComponent.open(this.modalService, {
            title: 'Uninstall App',
            message: `Uninstall "${pkg.name}"?`,
            positive: 'Uninstall', positiveStyle: 'danger', negative: 'Cancel', autofocus: 'negative',
        });
        if (!await confirm.result.catch(() => false)) return;
        const progress = ProgressDialogComponent.open(this.modalService);
        try {
            await this.adb.uninstall(this.serial, pkg.id);
            this.state.invalidatePackages(this.serial);
            await this.loadPackages();
        } catch (e) {
            MessageDialogComponent.open(this.modalService, {
                title: 'Failed to uninstall', message: extractMessage(e, 'Failed to uninstall'), positive: 'Close',
            });
        } finally {
            progress.close(true);
        }
    }
}
