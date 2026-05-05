import {Component, ViewChild, ElementRef, AfterViewInit} from '@angular/core';
import {NgbActiveModal} from '@ng-bootstrap/ng-bootstrap';
import {AdbService} from '../../core/services/adb.service';
import {AdbStateService, SavedDevice} from '../adb-state.service';
import {extractMessage} from '../../core/utils/error.utils';

const DEFAULT_PORT = 5555;

@Component({
    selector: 'app-android-tv-wizard',
    templateUrl: './android-tv-wizard.component.html',
    styleUrls: ['./android-tv-wizard.component.scss'],
})
export class AndroidTvWizardComponent implements AfterViewInit {
    @ViewChild('wizardBody') wizardBody?: ElementRef<HTMLDivElement>;

    editMode = false;
    skipSetupGuide = false;
    currentStep: 1 | 2 = 1;
    scrolledToBottom = false;

    name = '';
    ip = '';
    connecting = false;
    error: string | null = null;

    ngOnInit(): void {
        if (this.editMode || this.shouldSkipGuide()) {
            this.currentStep = 2;
        }
        this.skipSetupGuide = this.shouldSkipGuide();
    }

    ngAfterViewInit(): void {
        this.attachScrollListener();
    }

    private attachScrollListener(): void {
        if (!this.wizardBody) return;
        const el = this.wizardBody.nativeElement;
        // If all content already fits — unlock immediately
        if (el.scrollHeight <= el.clientHeight + 10) {
            this.scrolledToBottom = true;
            return;
        }
        el.addEventListener('scroll', () => this.onWizardScroll(el));
    }

    private onWizardScroll(el: HTMLDivElement): void {
        const isAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
        this.scrolledToBottom = isAtBottom;
    }

    private shouldSkipGuide(): boolean {
        return localStorage.getItem('freetv-atv-skip-setup-guide') === 'true';
    }

    onDontShowAgainChange(): void {
        if (this.skipSetupGuide) {
            localStorage.setItem('freetv-atv-skip-setup-guide', 'true');
        } else {
            localStorage.removeItem('freetv-atv-skip-setup-guide');
        }
    }

    showSetupGuide(): void {
        this.currentStep = 1;
    }

    constructor(
        public modal: NgbActiveModal,
        private adb: AdbService,
        private state: AdbStateService,
    ) {}

    next(): void {
        this.currentStep = 2;
    }

    back(): void {
        this.currentStep = 1;
    }

    get canSubmit(): boolean {
        return !!this.name.trim() && !!this.ip.trim() && !this.connecting;
    }

    async submit(): Promise<void> {
        if (!this.canSubmit) return;
        const name = this.name.trim();
        const ip = this.ip.trim();
        this.connecting = true;
        this.error = null;
        try {
            await this.adb.connect(`${ip}:${DEFAULT_PORT}`);
            const device: SavedDevice = {name, ip, port: DEFAULT_PORT};
            this.state.saveDevice(device);
            this.state.select(device);
            this.modal.close(device);
        } catch (e: unknown) {
            this.error = extractMessage(e, 'Failed to connect');
        } finally {
            this.connecting = false;
        }
    }
}
