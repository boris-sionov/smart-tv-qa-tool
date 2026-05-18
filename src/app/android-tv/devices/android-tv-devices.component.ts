import {Component, OnInit} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {noop} from 'rxjs';
import {AdbService} from '../../core/services/adb.service';
import {AdbStateService, deviceSerial, SavedDevice} from '../adb-state.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {AndroidTvWizardComponent} from '../wizard/android-tv-wizard.component';

@Component({
    selector: 'app-android-tv-devices',
    templateUrl: './android-tv-devices.component.html',
    styleUrls: ['./android-tv-devices.component.scss'],
})
export class AndroidTvDevicesComponent implements OnInit {

    devices: SavedDevice[] = [];

    constructor(public state: AdbStateService, private adb: AdbService, private modalService: NgbModal) {}

    ngOnInit(): void {
        this.devices = this.state.getSavedDevices();
    }

    openAddWizard(): void {
        const ref = this.modalService.open(AndroidTvWizardComponent, {
            size: 'lg', centered: true, scrollable: true,
        });
        ref.result.then(() => {
            this.devices = this.state.getSavedDevices();
        }).catch(noop);
    }

    editDevice(dev: SavedDevice): void {
        const ref = this.modalService.open(AndroidTvWizardComponent, {
            size: 'lg', centered: true, scrollable: true,
        });
        const instance = ref.componentInstance as AndroidTvWizardComponent;
        instance.editMode = true;
        instance.name = dev.name;
        instance.ip = dev.ip;
        ref.result.then(() => {
            this.devices = this.state.getSavedDevices();
        }).catch(noop);
    }

    async removeDevice(dev: SavedDevice): Promise<void> {
        const confirm = MessageDialogComponent.open(this.modalService, {
            title: 'Remove Device',
            message: `Remove "${dev.name}" (${dev.ip})?`,
            positive: 'Remove', positiveStyle: 'danger', negative: 'Cancel', autofocus: 'negative',
        });
        if (!await confirm.result.catch(() => false)) return;
        await this.adb.disconnect(deviceSerial(dev)).catch(noop);
        this.state.removeDevice(dev);
        this.devices = this.state.getSavedDevices();
    }

    selectDevice(dev: SavedDevice): void {
        this.state.select(dev);
        this.adb.connect(deviceSerial(dev)).catch(noop);
    }

    isSelected(dev: SavedDevice): boolean {
        const sel = this.state.selected$.value;
        return !!sel && sel.ip === dev.ip && sel.port === dev.port;
    }
}
