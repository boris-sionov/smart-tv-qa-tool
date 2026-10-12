import {CommonModule} from '@angular/common';
import {NgModule} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {RouterModule, Routes} from '@angular/router';
import {NgbModalModule, NgbTooltipModule} from '@ng-bootstrap/ng-bootstrap';

import {SharedModule} from '../shared/shared.module';
import {VidaaAppsComponent} from './apps/vidaa-apps.component';
import {VidaaInfoComponent} from './info/vidaa-info.component';
import {VidaaComponent} from './vidaa.component';

const routes: Routes = [
    {
        path: '',
        component: VidaaComponent,
        children: [
            {path: 'apps', component: VidaaAppsComponent},
            {path: 'info', component: VidaaInfoComponent},
            {path: '', redirectTo: 'apps', pathMatch: 'full'},
        ],
    },
];

@NgModule({
    declarations: [VidaaComponent, VidaaAppsComponent, VidaaInfoComponent],
    imports: [
        CommonModule,
        FormsModule,
        SharedModule,
        NgbModalModule,
        NgbTooltipModule,
        RouterModule.forChild(routes),
    ],
})
export class VidaaModule {}
