import {Component} from '@angular/core';
import {NgbActiveModal, NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {BuildKind} from '../../../core/services/confluence.service';
import {PickedBuild} from './confluence-builds.component';

/** {@link ConfluenceBuildsComponent} as a dialog; closes with the {@link PickedBuild}. */
@Component({
    selector: 'app-confluence-builds-dialog',
    template: `
      <div class="builds-modal">
        <div class="builds-header">
          <h5>{{ title }}</h5>
          <button class="close-btn" (click)="modal.dismiss()" aria-label="Close"><i class="bi bi-x-lg"></i></button>
        </div>
        <div class="builds-body">
          <app-confluence-builds [page]="page" [kinds]="kinds" (picked)="modal.close($event)"></app-confluence-builds>
        </div>
      </div>`,
    styles: [`
      .builds-modal { background: linear-gradient(160deg, #16213A 0%, #0F172B 100%); color: #FFFFFF; border-radius: 16px; }
      .builds-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
      .builds-header h5 { margin: 0; font-weight: 700; }
      .builds-body { padding: 20px 24px 22px; }
      .close-btn { width: 36px; height: 36px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.05); color: #A8B8CC; }
      .close-btn:hover { color: #FFFFFF; }
    `],
})
export class ConfluenceBuildsDialogComponent {
    title = 'Install from Confluence';
    page = '';
    kinds: BuildKind[] = [];

    constructor(public modal: NgbActiveModal) {}

    /** Opens the dialog; resolves with the downloaded build, or `null` when closed. */
    static pick(service: NgbModal, title: string, page: string, kinds: BuildKind[]): Promise<PickedBuild | null> {
        const ref = service.open(ConfluenceBuildsDialogComponent, {size: 'lg', centered: true, scrollable: true});
        Object.assign(ref.componentInstance as ConfluenceBuildsDialogComponent, {title, page, kinds});
        return ref.result.catch(() => null);
    }
}
