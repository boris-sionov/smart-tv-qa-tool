import {Component, OnInit} from '@angular/core';
import {Router} from '@angular/router';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {TizenPrerequisitesComponent} from '../shared/components/tizen-prerequisites/tizen-prerequisites.component';
import {SdbService} from '../core/services/sdb.service';
import {tizenSerial, TizenDevice, TizenStateService} from './tizen-state.service';

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
    }

    onDevicesChanged(): void {
        this.devices = this.state.getSavedDevices();
        if (!this.selected || !this.devices.find(d => tizenSerial(d) === tizenSerial(this.selected!))) {
            this.selected = this.devices[0] ?? null;
            this.state.select(this.selected);
        }
    }

    checkRequirements(): void {
        void TizenPrerequisitesComponent.open(this.modalService);
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
