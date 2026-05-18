import {NgModule} from '@angular/core';
import {CommonModule} from '@angular/common';
import {RouterModule, Routes} from '@angular/router';
import {FormsModule} from '@angular/forms';
import {NgbDropdownModule, NgbTooltipModule} from '@ng-bootstrap/ng-bootstrap';

import {SharedModule} from '../shared/shared.module';
import {AndroidTvComponent} from './android-tv.component';
import {AndroidTvAppsComponent} from './apps/android-tv-apps.component';
import {AndroidTvInfoComponent} from './info/android-tv-info.component';
import {AndroidTvDevicesComponent} from './devices/android-tv-devices.component';
import {AndroidTvWizardComponent} from './wizard/android-tv-wizard.component';

const routes: Routes = [
    {
        path: '',
        component: AndroidTvComponent,
        children: [
            {path: 'apps', component: AndroidTvAppsComponent},
            {path: 'info', component: AndroidTvInfoComponent},
            {path: 'devices', component: AndroidTvDevicesComponent},
            {path: '', redirectTo: 'apps', pathMatch: 'full'},
        ]
    }
];

@NgModule({
    declarations: [
        AndroidTvComponent,
        AndroidTvAppsComponent,
        AndroidTvInfoComponent,
        AndroidTvDevicesComponent,
        AndroidTvWizardComponent,
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
export class AndroidTvModule {}
