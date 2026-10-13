import {Component, EventEmitter, Input, OnDestroy, OnInit, Output} from '@angular/core';
import {AdbService} from '../../core/services/adb.service';

/** How often to look for the TV's answer, and when to suggest the prompt may be gone. */
const POLL_MS = 2000;
const HINT_AFTER_MS = 30000;

/**
 * Shown while a TV is `unauthorized`: it is reachable over ADB but is waiting for someone to
 * accept its "Allow USB debugging?" prompt for this computer.
 *
 * Polls `adb devices` and emits `approved` as soon as the TV lists as `device`, so QA presses
 * Allow on the TV and the app carries on without another click here. The prompt is only shown
 * while a connection attempt is open, so "Show the prompt again" reconnects.
 */
@Component({
    selector: 'app-adb-approval',
    templateUrl: './adb-approval.component.html',
    styleUrls: ['./adb-approval.component.scss'],
})
export class AdbApprovalComponent implements OnInit, OnDestroy {
    @Input({required: true}) serial!: string;
    @Input() deviceName?: string;
    @Output() approved = new EventEmitter<void>();

    showHint = false;
    reprompting = false;
    private timer?: ReturnType<typeof setTimeout>;
    private since = Date.now();
    private stopped = false;

    constructor(private adb: AdbService) {}

    ngOnInit(): void {
        this.schedule();
    }

    ngOnDestroy(): void {
        this.stopped = true;
        clearTimeout(this.timer);
    }

    async showPromptAgain(): Promise<void> {
        this.reprompting = true;
        this.showHint = false;
        this.since = Date.now();
        try {
            if (await this.adb.ensureConnected(this.serial).catch(() => null) === 'device') this.done();
        } finally {
            this.reprompting = false;
        }
    }

    private schedule(): void {
        if (this.stopped) return;
        this.timer = setTimeout(() => this.poll(), POLL_MS);
    }

    private async poll(): Promise<void> {
        const state = await this.adb.listConnectedDevices()
            .then(list => list.find(d => d.serial === this.serial)?.state)
            .catch(() => undefined);
        if (this.stopped) return;
        if (state === 'device') {
            this.done();
            return;
        }
        // Denied, timed out or dismissed on the TV: the transport closes or stays unauthorized.
        this.showHint = Date.now() - this.since > HINT_AFTER_MS || state === undefined;
        this.schedule();
    }

    private done(): void {
        if (this.stopped) return;
        this.stopped = true;
        clearTimeout(this.timer);
        this.approved.emit();
    }
}
