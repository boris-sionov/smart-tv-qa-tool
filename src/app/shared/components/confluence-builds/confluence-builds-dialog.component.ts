import {Component} from '@angular/core';
import {NgbActiveModal, NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {BuildKind} from '../../../core/services/confluence.service';

/** One tab of the dialog: the build kinds it lists. */
export interface BuildTab {
    label: string;
    kinds: BuildKind[];
}
import {PickedBuild} from './confluence-builds.component';

/** {@link ConfluenceBuildsComponent} as a dialog, one tab per {@link BuildTab}; closes with the {@link PickedBuild}. */
@Component({
    selector: 'app-confluence-builds-dialog',
    template: `
      <div class="builds-modal">
        <div class="builds-header">
          <h5>{{ title }}</h5>
          <button class="close-btn" (click)="modal.dismiss()" aria-label="Close"><i class="bi bi-x-lg"></i></button>
        </div>
        <div class="builds-body">
          @if (tabs.length > 1) {
            <div class="tabs" role="tablist">
              @for (t of tabs; track t.label) {
                <button role="tab" [class.active]="t === tab" [attr.aria-selected]="t === tab" (click)="tab = t">{{ t.label }}</button>
              }
            </div>
          }
          <app-confluence-builds [page]="page" [kinds]="tab.kinds" (picked)="modal.close($event)"></app-confluence-builds>
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
      .tabs { display: inline-flex; padding: 3px; margin-bottom: 16px; border-radius: 10px;
        background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08); }
      .tabs button { border: 0; background: none; padding: 7px 18px; border-radius: 8px; color: #A8B8CC;
        font-size: 13px; font-weight: 600; }
      .tabs button.active { background: rgba(91, 159, 245, 0.18); color: #FFFFFF; }
    `],
})
export class ConfluenceBuildsDialogComponent {
    title = 'Install from Confluence';
    page = '';
    tabs: BuildTab[] = [];
    tab!: BuildTab;

    constructor(public modal: NgbActiveModal) {}

    /** Opens the dialog; resolves with the downloaded build, or `null` when closed. */
    static pick(service: NgbModal, title: string, page: string, tabs: BuildTab[]): Promise<PickedBuild | null> {
        const ref = service.open(ConfluenceBuildsDialogComponent, {size: 'lg', centered: true, scrollable: true});
        Object.assign(ref.componentInstance as ConfluenceBuildsDialogComponent, {title, page, tabs, tab: tabs[0]});
        return ref.result.catch(() => null);
    }
}
