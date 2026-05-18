import {Component, OnInit} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {noop} from 'rxjs';
import {SdbService} from '../../core/services/sdb.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {tizenSerial, TizenDevice, TizenStateService} from '../tizen-state.service';
import {TizenWizardComponent} from '../wizard/tizen-wizard.component';
import {CreateProfileComponent} from '../cert/create-profile/create-profile.component';

@Component({
    selector: 'app-tizen-devices',
    templateUrl: './tizen-devices.component.html',
    styleUrls: ['./tizen-devices.component.scss'],
})
export class TizenDevicesComponent implements OnInit {
    devices: TizenDevice[] = [];
    profiles: string[] = [];
    activeProfile: string | null = null;
    busy = false;

    constructor(
        public state: TizenStateService,
        private sdb: SdbService,
        private modalService: NgbModal,
    ) {}

    ngOnInit(): void {
        this.devices = this.state.getSavedDevices();
        this.refreshProfiles();
    }

    private async refreshProfiles(): Promise<void> {
        this.profiles = await this.sdb.getCertificateProfiles().catch(() => []);
        this.activeProfile = await this.sdb.getActiveProfile().catch(() => null);
    }

    openAddWizard(): void {
        const ref = this.modalService.open(TizenWizardComponent, {
            size: 'lg', centered: true, scrollable: true,
        });
        ref.result.then(() => {
            this.devices = this.state.getSavedDevices();
        }).catch(noop);
    }

    openCreateProfile(): void {
        const ref = this.modalService.open(CreateProfileComponent, {
            size: 'lg', centered: true, scrollable: true,
        });
        ref.result.then(() => this.refreshProfiles()).catch(noop);
    }

    async setActive(profile: string): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        try {
            await this.sdb.setActiveProfile(profile);
            await this.refreshProfiles();
        } catch (e) {
            MessageDialogComponent.open(this.modalService, {
                title: 'Failed to switch profile',
                message: (e as Error).message,
                error: e as Error,
                positive: 'Close',
            });
        } finally {
            this.busy = false;
        }
    }

    async removeProfile(profile: string): Promise<void> {
        if (this.busy) return;
        const confirm = MessageDialogComponent.open(this.modalService, {
            title: 'Delete profile',
            message: `Delete profile "${profile}"? The author and distributor certificate files on disk are kept; only this profile entry is removed.`,
            positive: 'Delete', positiveStyle: 'danger', negative: 'Cancel', autofocus: 'negative',
        });
        if (!await confirm.result.catch(() => false)) return;
        this.busy = true;
        try {
            await this.sdb.deleteProfile(profile);
            await this.refreshProfiles();
        } catch (e) {
            MessageDialogComponent.open(this.modalService, {
                title: 'Failed to delete profile',
                message: (e as Error).message,
                error: e as Error,
                positive: 'Close',
            });
        } finally {
            this.busy = false;
        }
    }

    selectDevice(dev: TizenDevice): void {
        this.state.select(dev);
        this.sdb.connect(tizenSerial(dev)).catch(noop);
    }

    editDevice(dev: TizenDevice): void {
        const ref = this.modalService.open(TizenWizardComponent, {
            size: 'lg', centered: true, scrollable: true,
        });
        const instance = ref.componentInstance as TizenWizardComponent;
        instance.name = dev.name;
        instance.ip = dev.ip;
        ref.result.then(() => {
            this.devices = this.state.getSavedDevices();
        }).catch(noop);
    }

    async removeDevice(dev: TizenDevice): Promise<void> {
        const confirm = MessageDialogComponent.open(this.modalService, {
            title: 'Remove Device',
            message: `Remove "${dev.name}" (${tizenSerial(dev)})?`,
            positive: 'Remove',
            positiveStyle: 'danger',
            negative: 'Cancel',
            autofocus: 'negative',
        });
        if (!await confirm.result.catch(() => false)) return;
        await this.sdb.disconnect(tizenSerial(dev)).catch(noop);
        this.state.removeDevice(dev);
        this.devices = this.state.getSavedDevices();
    }

    isSelected(dev: TizenDevice): boolean {
        const selected = this.state.selected$.value;
        return !!selected && selected.ip === dev.ip && selected.port === dev.port;
    }
}
