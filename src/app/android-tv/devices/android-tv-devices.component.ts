import {Component, OnInit} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {noop} from 'rxjs';
import {AdbService} from '../../core/services/adb.service';
import {AdbStateService, deviceSerial, SavedDevice} from '../adb-state.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';

@Component({
    selector: 'app-android-tv-devices',
    templateUrl: './android-tv-devices.component.html',
    styleUrls: ['./android-tv-devices.component.scss'],
})
export class AndroidTvDevicesComponent implements OnInit {

    devices: SavedDevice[] = [];
    newName = '';
    newIp = '';
    newPort = 5555;
    connecting = false;

    constructor(public state: AdbStateService, private adb: AdbService, private modalService: NgbModal) {}

    ngOnInit(): void {
        this.devices = this.state.getSavedDevices();
    }

    async addDevice(): Promise<void> {
        const name = this.newName.trim();
        const ip = this.newIp.trim();
        if (!name || !ip) return;
        this.connecting = true;
        try {
            const result = await this.adb.connect(ip.includes(':') ? ip : `${ip}:${this.newPort}`);
            if (result.toLowerCase().includes('failed') || result.toLowerCase().includes('error')) {
                throw new Error(result.trim());
            }
            const [resolvedIp, resolvedPort] = ip.includes(':')
                ? ip.split(':')
                : [ip, String(this.newPort)];
            const device: SavedDevice = {name, ip: resolvedIp, port: parseInt(resolvedPort, 10)};
            this.state.saveDevice(device);
            this.devices = this.state.getSavedDevices();
            this.state.select(device);
            this.newName = '';
            this.newIp = '';
            this.newPort = 5555;
        } catch (e) {
            MessageDialogComponent.open(this.modalService, {
                title: 'Failed to connect',
                message: (e as Error).message,
                error: e as Error,
                positive: 'Close',
            });
        } finally {
            this.connecting = false;
        }
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
        this.adb.connect(dev.ip).catch(noop);
    }

    isSelected(dev: SavedDevice): boolean {
        const sel = this.state.selected$.value;
        return !!sel && sel.ip === dev.ip && sel.port === dev.port;
    }
}
