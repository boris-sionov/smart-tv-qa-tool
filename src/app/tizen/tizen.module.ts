import {CommonModule} from '@angular/common';
import {NgModule} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {RouterModule, Routes} from '@angular/router';
import {NgbDropdownModule, NgbTooltipModule} from '@ng-bootstrap/ng-bootstrap';

import {SharedModule} from '../shared/shared.module';
import {TizenAppsComponent} from './apps/tizen-apps.component';
import {TizenDevicesComponent} from './devices/tizen-devices.component';
import {TizenInfoComponent} from './info/tizen-info.component';
import {TizenComponent} from './tizen.component';
import {TizenWizardComponent} from './wizard/tizen-wizard.component';
import {CreateAuthorCertComponent} from './cert/create-author/create-author.component';
import {CreateProfileComponent} from './cert/create-profile/create-profile.component';

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
        CreateAuthorCertComponent,
        CreateProfileComponent,
    ],
    imports: [
        CommonModule,
        FormsModule,
        SharedModule,
        NgbDropdownModule,
        NgbTooltipModule,
        RouterModule.forChild(routes),
    ],
})
export class TizenModule {}
