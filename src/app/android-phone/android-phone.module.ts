import {NgModule} from '@angular/core';
import {CommonModule} from '@angular/common';
import {RouterModule, Routes} from '@angular/router';
import {NgbDropdownModule} from '@ng-bootstrap/ng-bootstrap';

import {SharedModule} from '../shared/shared.module';
import {AndroidPhoneComponent} from './android-phone.component';
import {PhonesComponent} from './phones/phones.component';
import {PhoneAppsComponent} from './apps/phone-apps.component';
import {PhoneInfoComponent} from './info/phone-info.component';
import {PhoneStatusComponent} from './status/phone-status.component';

const routes: Routes = [
    {
        path: '',
        component: AndroidPhoneComponent,
        children: [
            {path: 'apps', component: PhoneAppsComponent},
            {path: 'info', component: PhoneInfoComponent},
            {path: 'devices', component: PhonesComponent},
            {path: '', redirectTo: 'apps', pathMatch: 'full'},
        ]
    }
];

@NgModule({
    declarations: [AndroidPhoneComponent, PhonesComponent, PhoneAppsComponent, PhoneInfoComponent, PhoneStatusComponent],
    imports: [CommonModule, SharedModule, NgbDropdownModule, RouterModule.forChild(routes)],
})
export class AndroidPhoneModule {}
