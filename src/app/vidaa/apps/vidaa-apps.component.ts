import {Component, OnDestroy, OnInit} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {Subscription} from 'rxjs';
import {errorMessage, VidaaApp, VidaaResolution, VidaaService, VidaaState} from '../../core/services/vidaa.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {appEnvironment, isPriorityApp} from '../../shared/known-apps';
import {presetForUrl, VIDAA_PRESETS, VidaaPreset} from '../vidaa-presets';

@Component({
    selector: 'app-vidaa-apps',
    templateUrl: './vidaa-apps.component.html',
    // The Tizen list's look — rows, actions, panels — plus a few VIDAA-only pieces.
    styleUrls: ['../../tizen/apps/tizen-apps.component.scss', './vidaa-apps.component.scss'],
})
export class VidaaAppsComponent implements OnInit, OnDestroy {
    readonly presets = VIDAA_PRESETS;
    state!: VidaaState;

    code = '';
    connecting = false;
    connectError: string | null = null;

    /** Id (or preset name) of the row whose action is running. */
    busy: string | null = null;

    showCustom = false;
    custom = {name: '', url: '', iconUrl: '', resolution: 'hisense' as VidaaResolution};

    private sub?: Subscription;

    constructor(private vidaa: VidaaService, private modalService: NgbModal) {}

    ngOnInit(): void {
        this.sub = this.vidaa.state$.subscribe(s => this.state = s);
        this.vidaa.refresh().catch(() => undefined);
    }

    ngOnDestroy(): void {
        this.sub?.unsubscribe();
    }

    get apps(): VidaaApp[] {
        return [...this.state.apps].sort((a, b) => {
            const ap = isPriorityApp(a.AppName, a.URL), bp = isPriorityApp(b.AppName, b.URL);
            if (ap !== bp) return ap ? -1 : 1;
            return a.AppName.localeCompare(b.AppName);
        });
    }

    get tvLabel(): string {
        const info = this.state.tvInfo;
        if (!info) return 'Hisense TV';
        return [info['Model'], info['LAN IP']].filter(Boolean).join(' · ');
    }

    onCodeInput(value: string): void {
        this.code = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        this.connectError = null;
    }

    async connect(): Promise<void> {
        if (this.code.length !== 6 || this.connecting) return;
        this.connecting = true;
        this.connectError = null;
        try {
            await this.vidaa.connect(this.code);
            this.code = '';
        } catch (e) {
            this.connectError = errorMessage(e);
        } finally {
            this.connecting = false;
        }
    }

    async disconnect(): Promise<void> {
        await this.vidaa.disconnect().catch(() => undefined);
    }

    environment(app: VidaaApp): string | null {
        return presetForUrl(app.URL)?.environment ?? appEnvironment(app.URL, app.AppName);
    }

    installedFrom(preset: VidaaPreset): VidaaApp | undefined {
        return this.state.apps.find(a => presetForUrl(a.URL) === preset);
    }

    async installPreset(preset: VidaaPreset): Promise<void> {
        await this.runInstall(preset.name, preset.url, preset.iconUrl, 'hisense', preset.name);
    }

    async installCustom(): Promise<void> {
        const {name, url, iconUrl, resolution} = this.custom;
        if (await this.runInstall(name.trim(), url.trim(), iconUrl.trim(), resolution, 'custom')) {
            this.custom = {name: '', url: '', iconUrl: '', resolution: 'hisense'};
            this.showCustom = false;
        }
    }

    private async runInstall(name: string, url: string, iconUrl: string, resolution: VidaaResolution, key: string): Promise<boolean> {
        if (this.busy) return false;
        // DevKit refuses a URL that is already installed; say so before the TV does.
        const existing = this.state.apps.find(a => a.URL === url);
        if (existing) {
            this.fail('Already installed', `"${existing.AppName}" already uses this URL. Remove it first to reinstall.`);
            return false;
        }
        this.busy = key;
        try {
            await this.vidaa.install(name, url, iconUrl, resolution);
            return true;
        } catch (e) {
            this.fail('Install failed', errorMessage(e), e);
            return false;
        } finally {
            this.busy = null;
        }
    }

    async launch(app: VidaaApp): Promise<void> {
        if (this.busy) return;
        this.busy = app.Id;
        try {
            await this.vidaa.launch(app);
        } catch (e) {
            this.fail('Failed to launch app', errorMessage(e), e);
        } finally {
            this.busy = null;
        }
    }

    async close(app: VidaaApp): Promise<void> {
        if (this.busy) return;
        this.busy = 'close:' + app.Id;
        try {
            await this.vidaa.close();
        } catch (e) {
            this.fail('Failed to close app', errorMessage(e), e);
        } finally {
            this.busy = null;
        }
    }

    async remove(app: VidaaApp): Promise<void> {
        if (this.busy) return;
        const confirm = MessageDialogComponent.open(this.modalService, {
            title: 'Remove App',
            message: `Remove "${app.AppName}" from the TV?`,
            positive: 'Remove',
            positiveStyle: 'danger',
            negative: 'Cancel',
            autofocus: 'negative',
        });
        if (!await confirm.result.catch(() => false)) return;
        this.busy = app.Id;
        try {
            await this.vidaa.uninstall(app);
        } catch (e) {
            this.fail('Failed to remove app', errorMessage(e), e);
        } finally {
            this.busy = null;
        }
    }

    private fail(title: string, message: string, error?: unknown): void {
        MessageDialogComponent.open(this.modalService, {
            title,
            message,
            error: error instanceof Error ? error : undefined,
            positive: 'Close',
        });
    }
}
