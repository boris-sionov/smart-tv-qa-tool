import {Component} from '@angular/core';
import {Router} from '@angular/router';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {PhoneService, UsbPhone} from '../phone.service';
import {phoneName, PhoneStateService} from '../phone-state.service';
import {mirrorPhone} from '../scrcpy-help/scrcpy-help.component';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {extractMessage} from '../../core/utils/error.utils';

/**
 * Manage: every phone plugged in over USB, from the list `PhoneStateService` polls.
 *
 * A phone goes through a few states after it is plugged in: adb lists it as `authorizing`,
 * `connecting` or `offline` for a moment (shown with a spinner), then `unauthorized` until
 * someone taps Allow on the phone (the shell pops up a message, and closes it once it is allowed),
 * then `device`.
 */
@Component({
    selector: 'app-phones',
    templateUrl: './phones.component.html',
    styleUrls: ['../../android-tv/devices/android-tv-devices.component.scss', './phones.component.scss'],
})
export class PhonesComponent {
    readonly name = phoneName;

    constructor(
        public state: PhoneStateService,
        private service: PhoneService,
        private router: Router,
        private modalService: NgbModal,
    ) {}

    get phones(): UsbPhone[] | null {
        return this.state.phones;
    }

    /** Whether adb is still bringing the phone up: neither usable nor waiting for Allow. */
    connecting(phone: UsbPhone): boolean {
        return phone.state !== 'device' && phone.state !== 'unauthorized';
    }

    isSelected(phone: UsbPhone): boolean {
        return this.state.current?.serial === phone.serial;
    }

    askApproval(phone: UsbPhone, event: Event): void {
        event.stopPropagation();
        this.state.askApproval$.next(phone.serial);
    }

    open(phone: UsbPhone): void {
        if (phone.state !== 'device') return;
        this.state.select(phone.serial);
        void this.router.navigate(['/android-phone/apps']);
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
            await mirrorPhone(this.service, this.modalService, phone.serial, phoneName(phone));
        } catch (e) {
            MessageDialogComponent.open(this.modalService, {
                title: 'scrcpy did not start', message: extractMessage(e, 'scrcpy did not start'), positive: 'Close',
            });
        }
    }
}
