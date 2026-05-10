import {Component, OnDestroy, OnInit} from '@angular/core';
import {Subscription} from 'rxjs';
import {VidaaService, VidaaDeviceInfo} from '../vidaa.service';
import {VidaaStateService, VidaaSavedDevice} from '../vidaa-state.service';

@Component({
    selector: 'app-vidaa-info',
    templateUrl: './vidaa-info.component.html',
    styleUrls: ['./vidaa-info.component.scss'],
})
export class VidaaInfoComponent implements OnInit, OnDestroy {

    info: VidaaDeviceInfo | null = null;
    infoError?: Error;
    loading = false;
    selected: VidaaSavedDevice | null = null;

    private sub?: Subscription;

    constructor(private vidaa: VidaaService, private state: VidaaStateService) {}

    ngOnInit(): void {
        this.sub = this.state.selected$.subscribe(dev => {
            this.selected = dev;
            this.info = null;
            this.infoError = undefined;
            if (dev) this.loadInfo();
        });
    }

    ngOnDestroy(): void {
        this.sub?.unsubscribe();
    }

    async loadInfo(): Promise<void> {
        if (!this.selected) return;
        this.loading = true;
        this.infoError = undefined;
        this.info = null;
        try {
            this.info = await this.vidaa.getDeviceInfo(this.selected.ip);
        } catch (e) {
            this.infoError = e as Error;
        } finally {
            this.loading = false;
        }
    }
}
