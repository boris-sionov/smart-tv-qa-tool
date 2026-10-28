import {Component} from '@angular/core';
import {Router} from '@angular/router';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {APP_VERSION} from '../core/build-info';
import {TizenPrerequisitesComponent} from '../shared/components/tizen-prerequisites/tizen-prerequisites.component';

@Component({
    selector: 'app-platform-selector',
    templateUrl: './platform-selector.component.html',
    styleUrls: ['./platform-selector.component.scss']
})
export class PlatformSelectorComponent {
    readonly appVersion = APP_VERSION;

    constructor(private router: Router, private modalService: NgbModal) {}

    openLg(): void {
        this.router.navigate(['/lg']);
    }

    openAndroid(): void {
        this.router.navigate(['/android-tv']);
    }

    openTizen(): void {
        this.router.navigate(['/tizen']);
    }

    /** Checks this computer has what the Samsung flows need, then offers to open the section. */
    async checkTizen(): Promise<void> {
        if (await TizenPrerequisitesComponent.open(this.modalService, 'Open Samsung')) this.openTizen();
    }

    openVidaa(): void {
        this.router.navigate(['/vidaa']);
    }

}
