import {Component, Input} from '@angular/core';
import {NgbActiveModal, NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {SdbAppInfo} from '../../core/services/sdb.service';
import {TizenRemoteService} from '../../core/services/tizen-remote.service';
import {TizenDevice} from '../tizen-state.service';
import {TizenStressWizardComponent} from '../stress-wizard/tizen-stress-wizard.component';

@Component({
    selector: 'app-tizen-remote-dialog',
    templateUrl: './tizen-remote-dialog.component.html',
    styleUrls: ['./tizen-remote-dialog.component.scss'],
})
export class TizenRemoteDialogComponent {
    @Input() device!: TizenDevice;
    @Input() wgtApps: SdbAppInfo[] = [];
    @Input() serial = '';

    pressing: string | null = null;
    error: string | null = null;

    constructor(
        public modal: NgbActiveModal,
        private modalService: NgbModal,
        private tizenRemote: TizenRemoteService,
    ) {}

    async press(key: string): Promise<void> {
        if (this.pressing) return;
        this.pressing = key;
        this.error = null;
        try {
            await this.tizenRemote.pressKey(this.device, key);
        } catch (e) {
            this.error = (e as Error).message ?? String(e);
        } finally {
            this.pressing = null;
        }
    }

    openStress(): void {
        this.modal.dismiss();
        const ref = this.modalService.open(TizenStressWizardComponent, {
            size: 'lg', centered: true, backdrop: 'static',
        });
        const inst = ref.componentInstance as TizenStressWizardComponent;
        inst.apps = this.wgtApps;
        inst.serial = this.serial;
        inst.device = this.device;
    }
}
