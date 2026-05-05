import {Component} from '@angular/core';
import {NgbActiveModal} from '@ng-bootstrap/ng-bootstrap';
import {SdbService} from '../../../core/services/sdb.service';

@Component({
    selector: 'app-create-author-cert',
    templateUrl: './create-author.component.html',
    styleUrls: ['./create-author.component.scss'],
})
export class CreateAuthorCertComponent {
    name = '';
    password = '';
    passwordConfirm = '';
    country = 'IL';
    email = '';
    organization = '';
    department = '';

    busy = false;
    error: string | null = null;

    constructor(public modal: NgbActiveModal, private sdb: SdbService) {}

    get canSubmit(): boolean {
        return !!this.name.trim()
            && this.password.length >= 8
            && this.password === this.passwordConfirm
            && !this.busy;
    }

    get passwordsMatch(): boolean {
        return !this.passwordConfirm || this.password === this.passwordConfirm;
    }

    async submit(): Promise<void> {
        if (!this.canSubmit) return;
        this.busy = true;
        this.error = null;
        try {
            const path = await this.sdb.createAuthorCert({
                name: this.name.trim(),
                password: this.password,
                country: this.country.trim() || undefined,
                email: this.email.trim() || undefined,
                organization: this.organization.trim() || undefined,
                department: this.department.trim() || undefined,
            });
            this.modal.close({path, password: this.password, name: this.name.trim()});
        } catch (e) {
            this.error = (e as Error).message || 'Failed to create certificate';
        } finally {
            this.busy = false;
        }
    }
}
