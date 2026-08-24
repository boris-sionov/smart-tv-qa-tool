import {CommonModule} from '@angular/common';
import {NgModule} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {RouterModule, Routes} from '@angular/router';
import {NgbDropdownModule, NgbModalModule, NgbTooltipModule} from '@ng-bootstrap/ng-bootstrap';

import {SharedModule} from '../shared/shared.module';
import {TizenAppsComponent} from './apps/tizen-apps.component';
import {TizenDevicesComponent} from './devices/tizen-devices.component';
import {TizenInfoComponent} from './info/tizen-info.component';
import {TizenRemoteDialogComponent} from './remote-dialog/tizen-remote-dialog.component';
import {TizenStressWizardComponent} from './stress-wizard/tizen-stress-wizard.component';
import {TizenComponent} from './tizen.component';
import {TizenWizardComponent} from './wizard/tizen-wizard.component';

const routes: Routes = [
    {
        path: '',
        component: TizenComponent,
        children: [
            {path: 'apps', component: TizenAppsComponent},
            {path: 'info', component: TizenInfoComponent},
            {path: 'devices', component: TizenDevicesComponent},
            {path: '', redirectTo: 'apps', pathMatch: 'full'},
        ],
    },
];

@NgModule({
    declarations: [
        TizenComponent,
        TizenAppsComponent,
        TizenInfoComponent,
        TizenDevicesComponent,
        TizenWizardComponent,
        TizenRemoteDialogComponent,
        TizenStressWizardComponent,
    ],
    imports: [
        CommonModule,
        FormsModule,
        SharedModule,
        NgbDropdownModule,
        NgbModalModule,
        NgbTooltipModule,
        RouterModule.forChild(routes),
    ],
})
export class TizenModule {}
