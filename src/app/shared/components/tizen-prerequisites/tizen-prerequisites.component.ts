import {Component, OnInit} from '@angular/core';
import {CommonModule} from '@angular/common';
import {NgbActiveModal, NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {SdbService, TizenPrereqCheck, TizenPrerequisites} from '../../../core/services/sdb.service';
import {TizenStateService} from '../../../tizen/tizen-state.service';
import {extractMessage} from '../../../core/utils/error.utils';
import {ExternalLinkDirective} from '../../directives';
import {FixGuide, fixGuidesFor, osLabel} from './tizen-fix-guides';
import {changedChecks, loadSavedCheck, saveCheck} from './saved-check';

/**
 * Lists what the Samsung flows need installed on this machine — sdb, Tizen Studio, its CLI and
 * Java — with ✓ / ✕ and a fix for each miss, so QA finds out before an install fails halfway.
 *
 * It opens on the last saved check, checks again straight away, and marks every row that came out
 * different from the saved one.
 */
@Component({
    selector: 'app-tizen-prerequisites',
    standalone: true,
    imports: [CommonModule, ExternalLinkDirective],
    templateUrl: './tizen-prerequisites.component.html',
    styleUrls: ['./tizen-prerequisites.component.scss'],
})
export class TizenPrerequisitesComponent implements OnInit {
    checks: TizenPrereqCheck[] = [];
    studioPath: string | null = null;
    /** How to fix what failed, for this computer's OS. */
    guides: FixGuide[] = [];
    os = '';
    running = false;
    error: string | null = null;
    /** When the results on screen were checked. */
    checkedAt: number | null = null;
    /** Rows that differ from the check before, with the row as it was (`null`: a new row). */
    changes = new Map<string, TizenPrereqCheck | null>();

    constructor(
        public modal: NgbActiveModal,
        private sdb: SdbService,
        private state: TizenStateService,
    ) {}

    static open(modalService: NgbModal): Promise<void> {
        const ref = modalService.open(TizenPrerequisitesComponent, {centered: true, scrollable: true, size: 'lg'});
        return ref.result.then(() => undefined, () => undefined);
    }

    ngOnInit(): void {
        const saved = loadSavedCheck();
        if (saved) this.show(saved.result, saved.at);
        void this.run();
    }

    get failed(): number {
        return this.checks.filter(c => c.status === 'fail').length;
    }

    async run(): Promise<void> {
        this.running = true;
        this.error = null;
        try {
            const result = await this.sdb.checkPrerequisites(this.state.getStudioPath());
            this.changes = changedChecks(loadSavedCheck()?.result ?? null, result);
            this.show(result, saveCheck(result).at);
        } catch (e) {
            this.error = extractMessage(e, 'Could not run the checks');
        } finally {
            this.running = false;
        }
    }

    private show(result: TizenPrerequisites, at: number): void {
        this.checks = result.checks;
        this.studioPath = result.studioPath;
        this.guides = fixGuidesFor(result);
        this.os = osLabel(result.os, result.arch);
        this.checkedAt = at;
    }

    /** Opens Tizen Studio's Device Manager or Certificate Manager from the Studio the check found. */
    async openTool(tool: 'device' | 'certificate'): Promise<void> {
        if (!this.studioPath) return;
        try {
            await (tool === 'device'
                ? this.sdb.openDeviceManager(this.studioPath)
                : this.sdb.openCertificateManager(this.studioPath));
        } catch (e) {
            this.error = extractMessage(e, `Failed to open ${tool === 'device' ? 'Device' : 'Certificate'} Manager`);
        }
    }
}
