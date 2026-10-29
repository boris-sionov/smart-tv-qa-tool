import {Component, OnDestroy, OnInit} from '@angular/core';
import {NgbActiveModal, NgbModal, NgbModalRef} from '@ng-bootstrap/ng-bootstrap';

/** When to suggest that the prompt may have gone away. */
const HINT_AFTER_MS = 30000;

/**
 * The popup shown while a plugged-in phone is `unauthorized`: it is waiting for someone to tap
 * Allow on its "Allow USB debugging?" prompt. The same message Android TV shows in place
 * (`AdbApprovalComponent`), as a popup because the phone list has nowhere to put it.
 *
 * It does no polling of its own: the phone list already asks adb every 2 s and closes the popup
 * with `true` once the phone lists as `device`, or `false` when it is unplugged.
 */
@Component({
    selector: 'app-phone-approval',
    standalone: true,
    templateUrl: './phone-approval.component.html',
    styleUrls: ['../../android-tv/approval/adb-approval.component.scss', './phone-approval.component.scss'],
})
export class PhoneApprovalComponent implements OnInit, OnDestroy {
    phoneName = 'the phone';
    showHint = false;
    private timer?: ReturnType<typeof setTimeout>;

    constructor(public modal: NgbActiveModal) {}

    static open(modalService: NgbModal, phoneName: string | null): NgbModalRef {
        const ref = modalService.open(PhoneApprovalComponent, {centered: true, backdrop: 'static'});
        if (phoneName) (ref.componentInstance as PhoneApprovalComponent).phoneName = phoneName;
        return ref;
    }

    ngOnInit(): void {
        this.timer = setTimeout(() => this.showHint = true, HINT_AFTER_MS);
    }

    ngOnDestroy(): void {
        clearTimeout(this.timer);
    }
}
