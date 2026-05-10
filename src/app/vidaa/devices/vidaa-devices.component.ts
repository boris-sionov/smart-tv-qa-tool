import {Component, OnInit} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {VidaaStateService, VidaaSavedDevice} from '../vidaa-state.service';
import {VidaaService} from '../vidaa.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';

@Component({
    selector: 'app-vidaa-devices',
    templateUrl: './vidaa-devices.component.html',
    styleUrls: ['./vidaa-devices.component.scss'],
})
export class VidaaDevicesComponent implements OnInit {

    devices: VidaaSavedDevice[] = [];
    newName = '';
    newIp = '';
    connecting = false;

    constructor(
        public state: VidaaStateService,
        private vidaa: VidaaService,
        private modalService: NgbModal,
    ) {}

    ngOnInit(): void {
        this.devices = this.state.getSavedDevices();
    }

    async addDevice(): Promise<void> {
        const name = this.newName.trim();
        const ip = this.newIp.trim();
        if (!name || !ip) return;
        this.connecting = true;
        try {
            await this.vidaa.getDeviceInfo(ip);
            const device: VidaaSavedDevice = {name, ip};
            this.state.saveDevice(device);
            this.devices = this.state.getSavedDevices();
            this.state.select(device);
            this.newName = '';
            this.newIp = '';
        } catch (e) {
            MessageDialogComponent.open(this.modalService, {
                title: 'Cannot connect to TV',
                message: (e as Error).message,
                error: e as Error,
                positive: 'Close',
            });
        } finally {
            this.connecting = false;
        }
    }

    async removeDevice(dev: VidaaSavedDevice): Promise<void> {
        const confirm = MessageDialogComponent.open(this.modalService, {
            title: 'Remove Device',
            message: `Remove "${dev.name}" (${dev.ip})?`,
            positive: 'Remove', positiveStyle: 'danger', negative: 'Cancel', autofocus: 'negative',
        });
        if (!await confirm.result.catch(() => false)) return;
        this.state.removeDevice(dev);
        this.devices = this.state.getSavedDevices();
    }

    selectDevice(dev: VidaaSavedDevice): void {
        this.state.select(dev);
    }

    isSelected(dev: VidaaSavedDevice): boolean {
        return this.state.selected$.value?.ip === dev.ip;
    }
}
