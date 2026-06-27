import {Component, OnInit} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {noop} from 'rxjs';
import {SdbService} from '../../core/services/sdb.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {tizenSerial, TizenDevice, TizenStateService} from '../tizen-state.service';
import {TizenWizardComponent} from '../wizard/tizen-wizard.component';

@Component({
    selector: 'app-tizen-devices',
    templateUrl: './tizen-devices.component.html',
    styleUrls: ['./tizen-devices.component.scss'],
})
export class TizenDevicesComponent implements OnInit {
    devices: TizenDevice[] = [];
    busy = false;

    constructor(
        public state: TizenStateService,
        private sdb: SdbService,
        private modalService: NgbModal,
    ) {}

    ngOnInit(): void {
        this.devices = this.state.getSavedDevices();
    }

    openAddWizard(): void {
        const ref = this.modalService.open(TizenWizardComponent, {
            size: 'lg', centered: true, scrollable: true,
        });
        ref.result.then(() => {
            this.devices = this.state.getSavedDevices();
        }).catch(noop);
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
