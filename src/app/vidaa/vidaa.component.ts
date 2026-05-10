import {Component, OnInit} from '@angular/core';
import {Router} from '@angular/router';
import {VidaaStateService, VidaaSavedDevice} from './vidaa-state.service';

@Component({
    selector: 'app-vidaa',
    templateUrl: './vidaa.component.html',
    styleUrls: ['./vidaa.component.scss'],
})
export class VidaaComponent implements OnInit {

    devices: VidaaSavedDevice[] = [];

    constructor(public state: VidaaStateService, private router: Router) {}

    ngOnInit(): void {
        this.devices = this.state.getSavedDevices();
        const current = this.state.selected$.value;
        if (!current && this.devices.length > 0) {
            this.state.select(this.devices[0]);
        }
    }

    onDevicesChanged(): void {
        this.devices = this.state.getSavedDevices();
        const sel = this.state.selected$.value;
        if (!sel || !this.devices.find(d => d.ip === sel.ip)) {
            this.state.select(this.devices[0] ?? null);
        }
    }

    goBack(): void {
        this.router.navigate(['/']);
    }
}
