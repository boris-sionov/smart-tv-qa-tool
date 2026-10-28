import {Component, Input, OnInit} from '@angular/core';
import {CommonModule} from '@angular/common';
import {NgbActiveModal, NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {SdbService, TizenPrereqCheck} from '../../../core/services/sdb.service';
import {TizenStateService} from '../../../tizen/tizen-state.service';
import {extractMessage} from '../../../core/utils/error.utils';
import {ExternalLinkDirective} from '../../directives';
import {FixGuide, fixGuidesFor, osLabel} from './tizen-fix-guides';

/**
 * Lists what the Samsung flows need on this machine — sdb, Tizen Studio, its CLI and Java, the
 * certificate profiles — with ✓ / ✕ and a fix for each miss, so QA finds out before an install
 * fails halfway. Closes with `true` when the user picks the continue button.
 */
@Component({
    selector: 'app-tizen-prerequisites',
    standalone: true,
    imports: [CommonModule, ExternalLinkDirective],
    templateUrl: './tizen-prerequisites.component.html',
    styleUrls: ['./tizen-prerequisites.component.scss'],
})
export class TizenPrerequisitesComponent implements OnInit {
    /** Label of the button that closes with `true`; no button when unset. */
    @Input() continueLabel: string | null = null;

    checks: TizenPrereqCheck[] = [];
    studioPath: string | null = null;
    /** How to fix what failed, for this computer's OS. */
    guides: FixGuide[] = [];
    os = '';
    running = false;
    error: string | null = null;

    constructor(
        public modal: NgbActiveModal,
        private sdb: SdbService,
        private state: TizenStateService,
    ) {}

    static open(modalService: NgbModal, continueLabel: string | null = null): Promise<boolean> {
        const ref = modalService.open(TizenPrerequisitesComponent, {centered: true, scrollable: true, size: 'lg'});
        (ref.componentInstance as TizenPrerequisitesComponent).continueLabel = continueLabel;
        return ref.result.then(r => r === true, () => false);
    }

    ngOnInit(): void {
        void this.run();
    }

    get failed(): number {
        return this.checks.filter(c => c.status === 'fail').length;
    }

    get warned(): number {
        return this.checks.filter(c => c.status === 'warn').length;
    }

    async run(): Promise<void> {
        this.running = true;
        this.error = null;
        try {
            const result = await this.sdb.checkPrerequisites(this.state.getStudioPath(), this.state.getCertProfile());
            this.checks = result.checks;
            this.studioPath = result.studioPath;
            this.guides = fixGuidesFor(result);
            this.os = osLabel(result.os, result.arch);
        } catch (e) {
            this.error = extractMessage(e, 'Could not run the checks');
        } finally {
            this.running = false;
        }
    }

    async openCertificateManager(): Promise<void> {
        if (!this.studioPath) return;
        try {
            await this.sdb.openCertificateManager(this.studioPath);
        } catch (e) {
            this.error = extractMessage(e, 'Failed to open Certificate Manager');
        }
    }

    get certificatesFailing(): boolean {
        return this.checks.some(c => ['profiles', 'cert-profile', 'duids'].includes(c.id) && c.status !== 'ok');
    }
}
