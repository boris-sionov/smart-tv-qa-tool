import {Component, OnDestroy, OnInit} from '@angular/core';
import {Router} from '@angular/router';
import {NgbModal, NgbModalRef} from '@ng-bootstrap/ng-bootstrap';
import {Subscription} from 'rxjs';
import {PhoneStateService} from './phone-state.service';
import {PhoneApprovalComponent} from './approval/phone-approval.component';

/**
 * The Android Phone shell: platform switcher and Apps / Info / Manage on top. It keeps the phone
 * list polled while the section is open, and pops up the "Allow USB debugging?" message whenever a
 * phone is waiting for it, whichever page is showing.
 */
@Component({
    selector: 'app-android-phone',
    templateUrl: './android-phone.component.html',
    styleUrls: ['../android-tv/android-tv.component.scss'],
})
export class AndroidPhoneComponent implements OnInit, OnDestroy {
    /** The approval popup, and the phone it is for. */
    private approval?: {serial: string, ref: NgbModalRef};
    /** Phones whose approval popup QA closed; it is not opened again until they are re-plugged. */
    private dismissed = new Set<string>();
    private sub?: Subscription;

    constructor(private router: Router, private state: PhoneStateService, private modalService: NgbModal) {}

    ngOnInit(): void {
        this.sub = this.state.changed$.subscribe(() => this.followApproval());
        this.sub.add(this.state.askApproval$.subscribe(serial => this.askApproval(serial)));
        this.state.start();
    }

    ngOnDestroy(): void {
        this.sub?.unsubscribe();
        this.state.stop();
        this.approval?.ref.dismiss();
    }

    go(path: string): void {
        void this.router.navigate([path]);
    }

    /** Opens the popup again for a phone whose popup was closed. */
    private askApproval(serial: string): void {
        this.dismissed.delete(serial);
        this.followApproval();
    }

    /**
     * Opens the approval popup for the first phone waiting for Allow, and closes it once that phone
     * is allowed or unplugged.
     */
    private followApproval(): void {
        const phones = this.state.phones ?? [];
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
}
