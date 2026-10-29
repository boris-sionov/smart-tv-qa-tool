import {Component, OnInit} from '@angular/core';
import {Router} from '@angular/router';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {TizenPrerequisitesComponent} from '../shared/components/tizen-prerequisites/tizen-prerequisites.component';
import {SdbService} from '../core/services/sdb.service';
import {tizenSerial, TizenDevice, TizenStateService} from './tizen-state.service';

/**
 * The Samsung requirements check, kept for the life of the app: a warning (TVs not covered by a
 * certificate) does not count as missing.
 */
const requirements = {checked: false, missing: false, shown: false};

@Component({
    selector: 'app-tizen',
    templateUrl: './tizen.component.html',
    styleUrls: ['./tizen.component.scss'],
})
export class TizenComponent implements OnInit {
    devices: TizenDevice[] = [];
    selected: TizenDevice | null = null;

    constructor(
        public state: TizenStateService,
        private sdb: SdbService,
        private router: Router,
        private modalService: NgbModal,
    ) {}

    ngOnInit(): void {
        this.devices = this.state.getSavedDevices();
        this.selected = this.state.selected$.value ?? this.devices[0] ?? null;
        if (this.selected) this.state.select(this.selected);
        void this.autoCheck();
    }

    onDevicesChanged(): void {
        this.devices = this.state.getSavedDevices();
        if (!this.selected || !this.devices.find(d => tizenSerial(d) === tizenSerial(this.selected!))) {
            this.selected = this.devices[0] ?? null;
            this.state.select(this.selected);
        }
    }

    /** Whether the last check found something missing; the navbar button shows only then. */
    get requirementsMissing(): boolean {
        return requirements.missing;
    }

    /** Opens the requirements list, then checks again in case something was fixed meanwhile. */
    async checkRequirements(): Promise<void> {
        await TizenPrerequisitesComponent.open(this.modalService);
        await this.runCheck();
    }

    /**
     * Checks the requirements quietly on entering Samsung — once per app start when everything
     * is there, on every entry while something is missing — and opens the list the first time
     * something is missing.
     */
    private async autoCheck(): Promise<void> {
        if (requirements.checked && !requirements.missing) return;
        await this.runCheck();
        if (requirements.missing && !requirements.shown) {
            requirements.shown = true;
            await this.checkRequirements();
        }
    }

    private async runCheck(): Promise<void> {
        try {
            const result = await this.sdb.checkPrerequisites(this.state.getStudioPath(), this.state.getCertProfile());
            requirements.missing = result.checks.some(c => c.status === 'fail');
            requirements.checked = true;
        } catch {
            // The check itself failing says nothing about the tools; leave the last answer.
        }
    }

    goBack(): void {
        this.router.navigate(['/']);
    }

    openLg(): void {
        this.router.navigate(['/lg']);
    }

    openAndroid(): void {
        this.router.navigate(['/android-tv']);
    }

    openTizen(): void {
        this.router.navigate(['/tizen']);
    }

    openVidaa(): void {
        this.router.navigate(['/vidaa']);
    }
}
