import {Component, OnDestroy, OnInit} from '@angular/core';
import {Subscription} from 'rxjs';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {AdbPackageInfo, AdbService} from '../../core/services/adb.service';
import {PHONE_APPS, phoneAppIcon, PhoneService} from '../phone.service';
import {phoneName, PhoneStateService} from '../phone-state.service';
import {mirrorPhone} from '../scrcpy-help/scrcpy-help.component';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {ProgressDialogComponent} from '../../shared/components/progress-dialog/progress-dialog.component';
import {extractMessage} from '../../core/utils/error.utils';

/** pm's answers when an APK cannot replace the installed app without an uninstall first. */
const REPLACE_REFUSED = /INSTALL_FAILED_UPDATE_INCOMPATIBLE|INSTALL_FAILED_VERSION_DOWNGRADE/;

interface InstallJob {
    kind: 'apks' | 'xapk';
    paths: string[];
    /** For APKs: the package they declare, which an uninstall-first needs. */
    packageId?: string;
    label: string;
}

function fileName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
}

/** The `PHONE_APPS` installed on the current phone, with Launch / Kill / Remove, Install APK and Mirror. */
@Component({
    selector: 'app-phone-apps',
    templateUrl: './phone-apps.component.html',
    styleUrls: ['../../android-tv/apps/android-tv-apps.component.scss', './phone-apps.component.scss'],
})
export class PhoneAppsComponent implements OnInit, OnDestroy {

    /** The phone whose apps are listed, or '' while there is none ready. */
    serial = '';
    packages: AdbPackageInfo[] | null = null;
    error?: Error;
    readonly appNames = PHONE_APPS.map(a => a.name).join(' and ');
    readonly icon = phoneAppIcon;
    readonly name = phoneName;
    private sub?: Subscription;

    constructor(
        public state: PhoneStateService,
        private phones: PhoneService,
        private adb: AdbService,
        private modalService: NgbModal,
    ) {}

    get phoneName(): string {
        return phoneName(this.state.current);
    }

    ngOnInit(): void {
        // Opens on the connected phone, and follows it: a phone that becomes ready, is picked in
        // the dropdown or is unplugged reloads the list.
        this.sub = this.state.changed$.subscribe(() => this.follow());
        this.follow();
    }

    ngOnDestroy(): void {
        this.sub?.unsubscribe();
    }

    switchTo(serial: string): void {
        this.state.select(serial);
    }

    private follow(): void {
        const serial = this.state.ready ? this.state.current!.serial : '';
        if (serial === this.serial) return;
        this.serial = serial;
        this.packages = null;
        this.error = undefined;
        if (serial) void this.load();
    }

    async load(): Promise<void> {
        const serial = this.serial;
        this.packages = null;
        this.error = undefined;
        try {
            const packages = await this.phones.listApps(serial);
            if (serial === this.serial) this.packages = packages;
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
     * Installs the `.apk` / `.xapk` files QA picks, one app at a time.
     *
     * APKs of the same package are one app's splits and go in together (`install-multiple`); an
     * XAPK carries its own splits and OBB data. A different signing key or a release downgrade is
     * refused by pm; both install after an uninstall, which clears the app's data, so that is
     * asked per app. One app failing does not stop the rest; the summary lists each.
     */
    async installApk(): Promise<void> {
        const files = await this.phones.chooseInstallFiles();
        if (!files.length) return;
        const jobs = await this.installJobs(files);

        const progress = ProgressDialogComponent.open(this.modalService);
        const dialog = progress.componentInstance as ProgressDialogComponent;
        dialog.setSteps(jobs.map((job, i) => ({key: `job${i}`, label: job.label})));
        const results: string[] = [];
        for (const [i, job] of jobs.entries()) {
            dialog.update(`Installing ${job.label}…`, Math.round(100 * i / jobs.length), `job${i}`);
            try {
                await this.installJob(job);
                results.push(`✓ ${job.label}`);
            } catch (e) {
                dialog.fail(`job${i}`);
                results.push(`✕ ${job.label} — ${extractMessage(e, 'failed')}`);
            }
        }
        progress.close(true);
        await this.load();
        if (jobs.length > 1 || results.some(r => r.startsWith('✕'))) {
            MessageDialogComponent.open(this.modalService, {
                title: results.every(r => r.startsWith('✓')) ? 'Installed' : 'Install finished with errors',
                message: results.join('\n'), positive: 'Close',
            });
        }
    }

    /** One install per app: each XAPK on its own, APKs grouped by the package they declare. */
    private async installJobs(files: string[]): Promise<InstallJob[]> {
        const jobs: InstallJob[] = [];
        const byPackage = new Map<string, string[]>();
        for (const path of files) {
            if (path.toLowerCase().endsWith('.xapk')) {
                jobs.push({kind: 'xapk', paths: [path], label: fileName(path)});
                continue;
            }
            const packageId = await this.adb.apkManifest(path).then(m => m.packageId, () => path);
            byPackage.set(packageId, [...byPackage.get(packageId) ?? [], path]);
        }
        for (const [packageId, paths] of byPackage) {
            jobs.push({
                kind: 'apks', paths, packageId,
                label: paths.length === 1 ? fileName(paths[0]) : `${packageId} (${paths.length} split APKs)`,
            });
        }
        return jobs;
    }

    private async installJob(job: InstallJob): Promise<void> {
        const install = (uninstallFirst: boolean) => job.kind === 'xapk'
            ? this.phones.installXapk(this.serial, job.paths[0], uninstallFirst).then(() => undefined)
            : (uninstallFirst ? this.adb.uninstall(this.serial, job.packageId!) : Promise.resolve())
                .then(() => this.phones.installApks(this.serial, job.paths));
        try {
            await install(false);
        } catch (e) {
            const message = extractMessage(e, '');
            if (!REPLACE_REFUSED.test(message)) throw e;
            const confirm = MessageDialogComponent.open(this.modalService, {
                title: 'Uninstall first?',
                message: (message.includes('VERSION_DOWNGRADE')
                    ? `The phone refused to downgrade to ${job.label} — Android allows that only for debug builds.`
                    : `${job.label} is signed with a different key than the app on the phone.`)
                    + ' It installs after an uninstall, which also clears the app\'s data and login.',
                positive: 'Uninstall and install', positiveStyle: 'danger', negative: 'Skip', autofocus: 'negative',
            });
            if (!await confirm.result.catch(() => false)) throw new Error('skipped — the installed app was kept');
            await install(true);
        }
    }

    private fail(title: string, e: unknown): void {
        MessageDialogComponent.open(this.modalService, {title, message: extractMessage(e, title), positive: 'Close'});
    }
}
