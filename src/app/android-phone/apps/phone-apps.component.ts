import {Component, OnInit} from '@angular/core';
import {ActivatedRoute, Router} from '@angular/router';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {AdbPackageInfo, AdbService} from '../../core/services/adb.service';
import {PHONE_APPS, phoneAppIcon, PhoneService} from '../phone.service';
import {mirrorPhone} from '../scrcpy-help/scrcpy-help.component';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {ProgressDialogComponent} from '../../shared/components/progress-dialog/progress-dialog.component';
import {extractMessage} from '../../core/utils/error.utils';

/** pm's answers when an APK cannot replace the installed app without an uninstall first. */
const REPLACE_REFUSED = /INSTALL_FAILED_UPDATE_INCOMPATIBLE|INSTALL_FAILED_VERSION_DOWNGRADE/;

/** The `PHONE_APPS` installed on one phone, with Launch / Kill / Remove, Install APK and Mirror. */
@Component({
    selector: 'app-phone-apps',
    templateUrl: './phone-apps.component.html',
    styleUrls: ['../../android-tv/apps/android-tv-apps.component.scss', './phone-apps.component.scss'],
})
export class PhoneAppsComponent implements OnInit {

    serial = '';
    phoneName = 'Android phone';
    packages: AdbPackageInfo[] | null = null;
    error?: Error;
    readonly appNames = PHONE_APPS.map(a => a.name).join(' and ');
    readonly icon = phoneAppIcon;

    constructor(
        route: ActivatedRoute,
        private router: Router,
        private phones: PhoneService,
        private adb: AdbService,
        private modalService: NgbModal,
    ) {
        this.serial = route.snapshot.paramMap.get('serial') ?? '';
    }

    ngOnInit(): void {
        this.phones.listPhones()
            .then(list => this.phoneName = list.find(p => p.serial === this.serial)?.model ?? this.phoneName)
            .catch(() => undefined);
        void this.load();
    }

    back(): void {
        void this.router.navigate(['/android-phone']);
    }

    async load(): Promise<void> {
        this.packages = null;
        this.error = undefined;
        try {
            this.packages = await this.phones.listApps(this.serial);
        } catch (e) {
            this.error = new Error(extractMessage(e, 'Failed to load apps — is the phone still connected?'));
        }
    }

    async mirror(): Promise<void> {
        try {
            await mirrorPhone(this.phones, this.modalService, this.serial, this.phoneName);
        } catch (e) {
            this.fail('scrcpy did not start', e);
        }
    }

    async pullLogs(): Promise<void> {
        try {
            const path = await this.phones.saveLogs(this.serial, this.phoneName);
            if (path) MessageDialogComponent.open(this.modalService, {title: 'Logs saved', message: path, positive: 'Close'});
        } catch (e) {
            this.fail('Failed to pull logs', e);
        }
    }

    launch(pkg: AdbPackageInfo): void {
        this.phones.launch(this.serial, pkg.id).catch(e => this.fail('Failed to launch', e));
    }

    kill(pkg: AdbPackageInfo): void {
        this.adb.forceStop(this.serial, pkg.id).catch(e => this.fail('Failed to kill', e));
    }

    async remove(pkg: AdbPackageInfo): Promise<void> {
        const confirm = MessageDialogComponent.open(this.modalService, {
            title: 'Uninstall App',
            message: `Uninstall "${pkg.name}" from ${this.phoneName}? Its data and login go with it.`,
            positive: 'Uninstall', positiveStyle: 'danger', negative: 'Cancel', autofocus: 'negative',
        });
        if (!await confirm.result.catch(() => false)) return;
        const progress = ProgressDialogComponent.open(this.modalService);
        try {
            await this.adb.uninstall(this.serial, pkg.id);
            await this.load();
        } catch (e) {
            this.fail('Failed to uninstall', e);
        } finally {
            progress.close(true);
        }
    }

    /**
     * Installs an APK with `adb install -r -d`. A different signing key or a release downgrade is
     * refused by pm; both install after an uninstall, which clears the app's data, so that is asked.
     */
    async installApk(): Promise<void> {
        const path = await this.adb.openApkChooser();
        if (!path) return;
        const progress = ProgressDialogComponent.open(this.modalService);
        const dialog = progress.componentInstance as ProgressDialogComponent;
        try {
            dialog.update('Installing APK…', 50);
            try {
                await this.adb.install(this.serial, path, true);
            } catch (e) {
                const message = extractMessage(e, '');
                if (!REPLACE_REFUSED.test(message)) throw e;
                const {packageId} = await this.adb.apkManifest(path);
                const confirm = MessageDialogComponent.open(this.modalService, {
                    title: 'Uninstall first?',
                    message: (message.includes('VERSION_DOWNGRADE')
                        ? `The phone refused to downgrade ${packageId} — Android allows that only for debug builds.`
                        : `This APK is signed with a different key than the ${packageId} on the phone.`)
                        + ' It installs after an uninstall, which also clears the app\'s data and login.',
                    positive: 'Uninstall and install', positiveStyle: 'danger', negative: 'Cancel', autofocus: 'negative',
                });
                if (!await confirm.result.catch(() => false)) return;
                dialog.update(`Uninstalling ${packageId}…`, 70);
                await this.adb.uninstall(this.serial, packageId);
                dialog.update('Installing APK…', 85);
                await this.adb.install(this.serial, path, true);
            }
            await this.load();
        } catch (e) {
            this.fail('Failed to install', e);
        } finally {
            progress.close(true);
        }
    }

    private fail(title: string, e: unknown): void {
        MessageDialogComponent.open(this.modalService, {title, message: extractMessage(e, title), positive: 'Close'});
    }
}
