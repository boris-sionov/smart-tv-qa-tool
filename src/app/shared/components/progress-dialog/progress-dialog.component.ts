import {Component, NgZone} from '@angular/core';
import {NgbModal, NgbModalRef} from '@ng-bootstrap/ng-bootstrap';

export interface ProgressStep {
    key: string;
    label: string;
}

export type StepStatus = 'pending' | 'active' | 'done' | 'failed';

@Component({
    selector: 'app-progress-dialog',
    templateUrl: './progress-dialog.component.html',
    styleUrls: ['./progress-dialog.component.scss']
})
export class ProgressDialogComponent {

    message?: string;
    progress?: number;
    secondaryProgress?: number;

    steps: ProgressStep[] = [];
    currentStepKey?: string;
    hasFailed = false;

    protected readonly isNaN = isNaN;

    constructor(private zone: NgZone) {}

    setSteps(steps: ProgressStep[]): void {
        this.zone.run(() => { this.steps = steps; });
    }

    update(message?: string, progress?: number, stepKey?: string): void {
        this.zone.run(() => {
            this.message = message;
            this.progress = progress;
            if (stepKey !== undefined) this.currentStepKey = stepKey;
        });
    }

    fail(stepKey?: string): void {
        this.zone.run(() => {
            this.hasFailed = true;
            if (stepKey !== undefined) this.currentStepKey = stepKey;
        });
    }

    updateSecondary(message?: string, progress?: number): void {
        this.zone.run(() => { this.secondaryProgress = progress; });
    }

    stepStatus(step: ProgressStep): StepStatus {
        if (!this.currentStepKey || this.steps.length === 0) return 'pending';
        const currentIdx = this.steps.findIndex(s => s.key === this.currentStepKey);
        const thisIdx    = this.steps.findIndex(s => s.key === step.key);
        if (thisIdx < currentIdx) return 'done';
        if (thisIdx === currentIdx) return this.hasFailed ? 'failed' : 'active';
        return 'pending';
    }

    static open(service: NgbModal): NgbModalRef {
        return service.open(ProgressDialogComponent, {
            centered: true,
            backdrop: 'static',
            keyboard: false
        });
    }
}
