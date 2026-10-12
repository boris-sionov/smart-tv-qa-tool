import {Component, OnDestroy, OnInit} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {noop, Subscription} from 'rxjs';
import {AdbService, AdbPackageInfo} from '../../core/services/adb.service';
import {AdbStateService, deviceSerial, SavedDevice} from '../adb-state.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {ProgressDialogComponent} from '../../shared/components/progress-dialog/progress-dialog.component';
import {extractMessage} from '../../core/utils/error.utils';
import {environmentIcon} from '../../shared/app-environment-icons';
import {ApkLibraryComponent, LibraryPick} from '../library/apk-library.component';

/** pm's answers when an APK cannot replace the installed app without an uninstall first. */
const REPLACE_REFUSED = /INSTALL_FAILED_UPDATE_INCOMPATIBLE|INSTALL_FAILED_VERSION_DOWNGRADE/;

// OTT apps whose icon was extracted from the APK and bundled under assets/app-icons.
const EXTRACTED_ICONS = ['tv.freetv.androidtv', 'tv.freetv.androidtv.uat', 'il.co.stingtv.staging', 'il.co.partnertv.atv', 'com.stingtv.androidtv', 'com.stingtv.androidtv.staging', 'il.co.partnertv.atv.staging', 'tv.partner.androidtv', 'tv.partner.androidtv.staging', 'tv.yes.androidtv', 'com.yes.yestv', 'com.cellcom.cellcom_tv', 'tv.cellcom.androidtv', 'tv.cellcom.androidtv.stg', 'com.netflix.ninja', 'com.hbo.hbomax', 'com.disneyplus', 'com.hotstar.androidtv'];

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
    private iconPaths = new Map<string, string>();

    constructor(private adb: AdbService, private state: AdbStateService, private modalService: NgbModal) {}

    /** The icon to draw for an app, or `null` for the ATV placeholder. */
    iconPath(packageId: string): string | null {
        return this.iconPaths.get(packageId) ?? null;
    }

    /**
     * Takes a new app list and works out what each row's icon is.
     *
     * A FreeTV build gets the badged icon for its environment — PREPROD, UAT, PROD TEST — because
     * every FreeTV APK ships the same green icon and the list would otherwise be a row of
     * identical tiles. Everything else keeps the icon extracted from its APK.
     *
     * Resolved here rather than in `iconPath`, which the template calls on every row on every
     * change-detection pass.
     */
    private setPackages(packages: AdbPackageInfo[] | null): void {
        this.packages = packages;
        this.iconPaths = new Map((packages ?? []).flatMap(pkg => {
            const asset = environmentIcon('android-tv', pkg.id, pkg.name)?.asset
                ?? (EXTRACTED_ICONS.includes(pkg.id) ? `assets/app-icons/${pkg.id}.png` : null);
            return asset ? [[pkg.id, asset] as const] : [];
        }));
    }

    ngOnInit(): void {
        this.sub = new Subscription();

        this.sub.add(this.state.selected$.subscribe(dev => {
            this.selected = dev;
            this.setPackages(null);
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
                this.setPackages(cached);
                return;
            }
        }
        this.packagesError = undefined;
        this.loading = true;
        this.setPackages(null);
        try {
            const packages = await this.adb.listPackages(this.serial);
            this.setPackages(packages);
            this.state.setCachedPackages(this.serial, packages);
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

    /**
     * Installs an APK picked from the shared library with `adb install -r -d`.
     *
     * `-d` is not enough on a retail TV: Android honours it only for a debuggable app, so a
     * release build answers INSTALL_FAILED_VERSION_DOWNGRADE anyway — and an APK signed with a
     * different key (store build over a CI one) answers INSTALL_FAILED_UPDATE_INCOMPATIBLE. Both
     * need an uninstall first, which clears the app's data and login, so that is asked.
     */
    async installFromLibrary(): Promise<void> {
        const serial = this.serial;
        if (!serial) return;
        const picker = this.modalService.open(ApkLibraryComponent, {size: 'lg', centered: true, scrollable: true});
        const pick: LibraryPick | null = await picker.result.catch(() => null);
        if (!pick) return;
        const label = pick.kind === 'store'
            ? `Store ${pick.version}`
            : `${pick.build.label} ${pick.build.version}${/debug/i.test(pick.build.file) ? ' (debug)' : ''}`;

        const progress = ProgressDialogComponent.open(this.modalService);
        const dialog = progress.componentInstance as ProgressDialogComponent;
        dialog.setSteps([
            {key: 'fetch', label: 'Getting the APK from the library'},
            {key: 'install', label: 'Installing on TV'},
        ]);
        try {
            dialog.update(`Getting ${label}…`, 20, 'fetch');
            const path = pick.kind === 'store' ? await this.adb.fetchFromLibrary(pick.apk.location) : pick.build.path;
            dialog.update(`Installing ${label}…`, 60, 'install');
            try {
                await this.adb.install(serial, path, true);
            } catch (e) {
                const message = extractMessage(e, '');
                if (!REPLACE_REFUSED.test(message)) throw e;
                const {packageId} = await this.adb.apkManifest(path);
                const confirm = MessageDialogComponent.open(this.modalService, {
                    title: 'Uninstall first?',
                    message: (message.includes('VERSION_DOWNGRADE')
                        ? `The TV refused to downgrade ${packageId} to ${label} — Android allows that only for debug builds.`
                        : `${label} is signed with a different key than the ${packageId} on the TV.`)
                        + ' It installs after an uninstall, which also clears the app\'s data and login.',
                    positive: 'Uninstall and install', positiveStyle: 'danger', negative: 'Cancel', autofocus: 'negative',
                });
                if (!await confirm.result.catch(() => false)) return;
                dialog.update(`Uninstalling ${packageId}…`, 75, 'install');
                await this.adb.uninstall(serial, packageId);
                dialog.update(`Installing ${label}…`, 85, 'install');
                await this.adb.install(serial, path, true);
            }
            dialog.update('Done', 100, 'done');
            this.state.invalidatePackages(serial);
            await this.loadPackages(true);
        } catch (e) {
            dialog.fail();
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
