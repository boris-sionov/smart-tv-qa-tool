import {Injectable} from '@angular/core';
import {Subject} from 'rxjs';
import {PhoneService, UsbPhone} from './phone.service';
import {extractMessage} from '../core/utils/error.utils';

const SELECTED_KEY = 'smart-tv-qa-phone-selected';
/** How often adb is asked which phones are plugged in. */
const POLL_MS = 2000;

/**
 * The phones plugged in by USB, polled while the Phone section is open, and which one the Apps and
 * Info pages show: the last one picked while it is still connected, otherwise the first one that
 * is ready.
 */
@Injectable({providedIn: 'root'})
export class PhoneStateService {
    /** `null` until adb has answered once. */
    phones: UsbPhone[] | null = null;
    /** adb itself did not run — the copy bundled with the tool is missing or broken. */
    adbError: string | null = null;
    /** Fires after every poll and every change of selection. */
    readonly changed$ = new Subject<void>();
    /** A phone whose "Allow USB debugging?" popup should open again (the Manage card's badge). */
    readonly askApproval$ = new Subject<string>();
    private selected: string | null = null;
    private timer?: ReturnType<typeof setInterval>;

    constructor(private service: PhoneService) {
        try {
            this.selected = localStorage.getItem(SELECTED_KEY);
        } catch {
            // No storage: start with the first phone.
        }
    }

    start(): void {
        if (this.timer) return;
        void this.refresh();
        this.timer = setInterval(() => void this.refresh(), POLL_MS);
    }

    stop(): void {
        clearInterval(this.timer);
        this.timer = undefined;
    }

    async refresh(): Promise<void> {
        try {
            this.phones = await this.service.listPhones();
            this.adbError = null;
        } catch (e) {
            this.adbError = extractMessage(e, 'adb did not answer');
        }
        this.changed$.next();
    }

    get current(): UsbPhone | null {
        const phones = this.phones ?? [];
        return phones.find(p => p.serial === this.selected)
            ?? phones.find(p => p.state === 'device')
            ?? phones[0]
            ?? null;
    }

    /** Whether the current phone is usable — the Apps and Info pages show their content only then. */
    get ready(): boolean {
        return this.current?.state === 'device';
    }

    select(serial: string): void {
        this.selected = serial;
        try {
            localStorage.setItem(SELECTED_KEY, serial);
        } catch {
            // Not remembered past this session; harmless.
        }
        this.changed$.next();
    }
}

export function phoneName(phone: UsbPhone | null): string {
    return phone?.model ?? 'Android phone';
}
