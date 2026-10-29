import {Injectable} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {SdbService} from '../core/services/sdb.service';
import {TizenPrerequisitesComponent} from '../shared/components/tizen-prerequisites/tizen-prerequisites.component';
import {TizenStateService} from './tizen-state.service';

/**
 * The Samsung requirements check, kept for the life of the app. Run quietly on entering Samsung;
 * the button next to Add New Device on the Manage page opens the list any time. Only the list
 * saves its results: a quiet check that saved them would hide from the list what changed since
 * QA last looked.
 */
@Injectable({providedIn: 'root'})
export class TizenRequirementsService {
    /** Whether the last check found something missing; the Manage button turns amber then. */
    missing = false;
    private checked = false;
    private shown = false;

    constructor(private sdb: SdbService, private state: TizenStateService, private modalService: NgbModal) {}

    /** Opens the requirements list, then checks again in case something was fixed meanwhile. */
    async open(): Promise<void> {
        await TizenPrerequisitesComponent.open(this.modalService);
        await this.run();
    }

    /**
     * Checks quietly — once per app start when everything is there, on every call while something
     * is missing — and opens the list the first time something is missing.
     */
    async autoCheck(): Promise<void> {
        if (this.checked && !this.missing) return;
        await this.run();
        if (this.missing && !this.shown) {
            this.shown = true;
            await this.open();
        }
    }

    private async run(): Promise<void> {
        try {
            const result = await this.sdb.checkPrerequisites(this.state.getStudioPath());
            this.missing = result.checks.some(c => c.status === 'fail');
            this.checked = true;
        } catch {
            // The check itself failing says nothing about the tools; leave the last answer.
        }
    }
}
