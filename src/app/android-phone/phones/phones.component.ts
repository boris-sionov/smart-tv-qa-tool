import {Component, OnDestroy, OnInit} from '@angular/core';
import {Router} from '@angular/router';
import {NgbModal, NgbModalRef} from '@ng-bootstrap/ng-bootstrap';
import {PhoneService, UsbPhone} from '../phone.service';
import {mirrorPhone} from '../scrcpy-help/scrcpy-help.component';
import {PhoneApprovalComponent} from '../approval/phone-approval.component';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {extractMessage} from '../../core/utils/error.utils';

/** How often the list asks adb which phones are plugged in. */
const POLL_MS = 2000;

/**
 * The phones plugged in over USB, refreshed while the page is open.
 *
 * A phone goes through a few states after it is plugged in: adb lists it as `authorizing`,
 * `connecting` or `offline` for a moment (shown with a spinner), then `unauthorized` until
 * someone taps Allow on the phone (a popup says so, and closes by itself once it is allowed),
 * then `device`.
 */
@Component({
    selector: 'app-phones',
    templateUrl: './phones.component.html',
    styleUrls: ['../../android-tv/devices/android-tv-devices.component.scss', './phones.component.scss'],
})
export class PhonesComponent implements OnInit, OnDestroy {

    phones: UsbPhone[] | null = null;
    error: string | null = null;
    private timer?: ReturnType<typeof setInterval>;
    /** The approval popup, and the phone it is for. */
    private approval?: {serial: string, ref: NgbModalRef};
    /** Phones whose approval popup QA closed; it is not opened again until they are re-plugged. */
    private dismissed = new Set<string>();

    constructor(private service: PhoneService, private router: Router, private modalService: NgbModal) {}

    ngOnInit(): void {
        void this.refresh();
        this.timer = setInterval(() => void this.refresh(), POLL_MS);
    }

    ngOnDestroy(): void {
        clearInterval(this.timer);
        this.approval?.ref.dismiss();
    }

    async refresh(): Promise<void> {
        try {
            this.phones = await this.service.listPhones();
            this.error = null;
            this.followApproval(this.phones);
        } catch (e) {
            this.error = extractMessage(e, 'adb did not answer');
        }
    }

    /** Whether adb is still bringing the phone up: neither usable nor waiting for Allow. */
    connecting(phone: UsbPhone): boolean {
        return phone.state !== 'device' && phone.state !== 'unauthorized';
    }

    /** Opens the "Allow USB debugging?" popup again from the phone's card. */
    askApproval(phone: UsbPhone, event: Event): void {
        event.stopPropagation();
        this.dismissed.delete(phone.serial);
        this.followApproval(this.phones ?? []);
    }

    /**
     * Opens the approval popup for the first phone waiting for Allow, and closes it once that phone
     * is allowed or unplugged.
     */
    private followApproval(phones: UsbPhone[]): void {
        for (const serial of this.dismissed) {
            if (!phones.some(p => p.serial === serial && p.state === 'unauthorized')) this.dismissed.delete(serial);
        }
        if (this.approval) {
            const phone = phones.find(p => p.serial === this.approval!.serial);
            if (phone?.state !== 'unauthorized') this.approval.ref.close(phone?.state === 'device');
            return;
        }
        const waiting = phones.find(p => p.state === 'unauthorized' && !this.dismissed.has(p.serial));
        if (!waiting) return;
        const ref = PhoneApprovalComponent.open(this.modalService, waiting.model);
        this.approval = {serial: waiting.serial, ref};
        ref.result.then(
            () => this.approval = undefined,
            () => {
                this.approval = undefined;
                this.dismissed.add(waiting.serial);
            });
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
