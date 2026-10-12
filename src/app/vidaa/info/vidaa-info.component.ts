import {Component, OnDestroy, OnInit} from '@angular/core';
import {Subscription} from 'rxjs';
import {VidaaService, VidaaState} from '../../core/services/vidaa.service';

@Component({
    selector: 'app-vidaa-info',
    templateUrl: './vidaa-info.component.html',
    styleUrls: ['./vidaa-info.component.scss'],
})
export class VidaaInfoComponent implements OnInit, OnDestroy {
    state!: VidaaState;
    private sub?: Subscription;

    constructor(private vidaa: VidaaService) {}

    ngOnInit(): void {
        this.sub = this.vidaa.state$.subscribe(s => this.state = s);
    }

    ngOnDestroy(): void {
        this.sub?.unsubscribe();
    }

    get rows(): [string, string][] {
        return Object.entries(this.state.tvInfo ?? {}).map(([k, v]) => [k.trim(), String(v)]);
    }

    clearLog(): void {
        this.vidaa.clearLog();
    }
}
