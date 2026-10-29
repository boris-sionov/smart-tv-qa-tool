import {Component, OnDestroy, OnInit} from '@angular/core';
import {Router} from '@angular/router';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {PhoneService, UsbPhone} from '../phone.service';
import {mirrorPhone} from '../scrcpy-help/scrcpy-help.component';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {extractMessage} from '../../core/utils/error.utils';

/** How often the list asks adb which phones are plugged in. */
const POLL_MS = 2000;

/** The phones plugged in over USB, refreshed while the page is open. */
@Component({
    selector: 'app-phones',
    templateUrl: './phones.component.html',
    styleUrls: ['../../android-tv/devices/android-tv-devices.component.scss', './phones.component.scss'],
})
export class PhonesComponent implements OnInit, OnDestroy {

    phones: UsbPhone[] | null = null;
    error: string | null = null;
    private timer?: ReturnType<typeof setInterval>;

    constructor(private service: PhoneService, private router: Router, private modalService: NgbModal) {}

    ngOnInit(): void {
        void this.refresh();
        this.timer = setInterval(() => void this.refresh(), POLL_MS);
    }

    ngOnDestroy(): void {
        clearInterval(this.timer);
    }

    async refresh(): Promise<void> {
        try {
            this.phones = await this.service.listPhones();
            this.error = null;
        } catch (e) {
            this.error = extractMessage(e, 'adb did not answer');
        }
    }

    name(phone: UsbPhone): string {
        return phone.model ?? 'Android phone';
    }

    open(phone: UsbPhone): void {
        if (phone.state !== 'device') return;
        void this.router.navigate(['/android-phone', phone.serial]);
    }

    async pullLogs(phone: UsbPhone, event: Event): Promise<void> {
        event.stopPropagation();
        try {
            const path = await this.service.saveLogs(phone.serial, phone.model);
            if (path) MessageDialogComponent.open(this.modalService, {title: 'Logs saved', message: path, positive: 'Close'});
        } catch (e) {
            MessageDialogComponent.open(this.modalService, {
                title: 'Failed to pull logs', message: extractMessage(e, 'Failed to pull logs'), positive: 'Close',
            });
        }
    }

    async mirror(phone: UsbPhone, event: Event): Promise<void> {
        event.stopPropagation();
        try {
            await mirrorPhone(this.service, this.modalService, phone.serial, this.name(phone));
        } catch (e) {
            MessageDialogComponent.open(this.modalService, {
                title: 'scrcpy did not start', message: extractMessage(e, 'scrcpy did not start'), positive: 'Close',
            });
        }
    }
}
