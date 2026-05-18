import {Component, OnInit} from '@angular/core';
import {NgbActiveModal, NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {SdbService} from '../../../core/services/sdb.service';
import {CreateAuthorCertComponent} from '../create-author/create-author.component';

type DistributorChoice = 'public' | 'partner' | 'custom';

@Component({
    selector: 'app-create-profile',
    templateUrl: './create-profile.component.html',
    styleUrls: ['./create-profile.component.scss'],
})
export class CreateProfileComponent implements OnInit {
    profileName = '';

    authorPath = '';
    authorPassword = '';
    authorName = '';

    distributorChoice: DistributorChoice = 'public';
    publicCertPath = '';
    partnerCertPath = '';
    bundledPassword = '';
    customDistributorPath = '';
    customDistributorPassword = '';

    setActive = true;
    busy = false;
    error: string | null = null;

    constructor(
        public modal: NgbActiveModal,
        private modalService: NgbModal,
        private sdb: SdbService,
    ) {}

    async ngOnInit(): Promise<void> {
        const bundled = await this.sdb.getBundledDistributorCerts();
        this.publicCertPath = bundled.publicCert;
        this.partnerCertPath = bundled.partnerCert;
        this.bundledPassword = bundled.password;
    }

    async createNewAuthor(): Promise<void> {
        const ref = this.modalService.open(CreateAuthorCertComponent, {
            size: 'lg', centered: true, scrollable: true,
        });
        try {
            const result = await ref.result;
            if (result?.path) {
                this.authorPath = result.path;
                this.authorPassword = result.password;
                this.authorName = result.name;
            }
        } catch { /* dismissed */ }
    }

    async chooseAuthor(): Promise<void> {
        const path = await this.sdb.openP12Chooser();
        if (path) {
            this.authorPath = path;
            this.authorName = path.split('/').pop()?.replace(/\.p12$/, '') ?? '';
        }
    }

    async chooseCustomDistributor(): Promise<void> {
        const path = await this.sdb.openP12Chooser();
        if (path) this.customDistributorPath = path;
    }

    get canSubmit(): boolean {
        if (!this.profileName.trim() || !this.authorPath || !this.authorPassword || this.busy) return false;
        if (this.distributorChoice === 'custom') {
            return !!this.customDistributorPath && !!this.customDistributorPassword;
        }
        return true;
    }

    private get distributorPath(): string {
        switch (this.distributorChoice) {
            case 'public': return this.publicCertPath;
            case 'partner': return this.partnerCertPath;
            case 'custom': return this.customDistributorPath;
        }
    }

    private get distributorPassword(): string {
        return this.distributorChoice === 'custom'
            ? this.customDistributorPassword
            : this.bundledPassword;
    }

    async submit(): Promise<void> {
        if (!this.canSubmit) return;
        this.busy = true;
        this.error = null;
        try {
            await this.sdb.createProfile({
                name: this.profileName.trim(),
                author: this.authorPath,
                authorPassword: this.authorPassword,
                distributor: this.distributorPath,
                distributorPassword: this.distributorPassword,
                active: this.setActive,
            });
            this.modal.close(this.profileName.trim());
        } catch (e) {
            this.error = (e as Error).message || 'Failed to create profile';
        } finally {
            this.busy = false;
        }
    }
}
