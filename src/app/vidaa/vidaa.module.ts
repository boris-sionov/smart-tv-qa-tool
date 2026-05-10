import {NgModule} from '@angular/core';
import {CommonModule} from '@angular/common';
import {RouterModule, Routes} from '@angular/router';
import {FormsModule} from '@angular/forms';
import {NgbDropdownModule, NgbTooltipModule} from '@ng-bootstrap/ng-bootstrap';

import {SharedModule} from '../shared/shared.module';
import {VidaaComponent} from './vidaa.component';
import {VidaaAppsComponent} from './apps/vidaa-apps.component';
import {VidaaInfoComponent} from './info/vidaa-info.component';
import {VidaaDevicesComponent} from './devices/vidaa-devices.component';

const routes: Routes = [
    {
        path: '',
        component: VidaaComponent,
        children: [
            {path: 'apps', component: VidaaAppsComponent},
            {path: 'info', component: VidaaInfoComponent},
            {path: 'devices', component: VidaaDevicesComponent},
            {path: '', redirectTo: 'apps', pathMatch: 'full'},
        ],
    },
];

@NgModule({
    declarations: [
        VidaaComponent,
        VidaaAppsComponent,
        VidaaInfoComponent,
        VidaaDevicesComponent,
    ],
    imports: [
        CommonModule,
        FormsModule,
        SharedModule,
        NgbTooltipModule,
        NgbDropdownModule,
        RouterModule.forChild(routes),
    ],
})
export class VidaaModule {}
