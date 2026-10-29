import {NgModule} from '@angular/core';
import {CommonModule} from '@angular/common';
import {RouterModule, Routes} from '@angular/router';
import {NgbDropdownModule} from '@ng-bootstrap/ng-bootstrap';

import {SharedModule} from '../shared/shared.module';
import {AndroidPhoneComponent} from './android-phone.component';
import {PhonesComponent} from './phones/phones.component';
import {PhoneAppsComponent} from './apps/phone-apps.component';

const routes: Routes = [
    {
        path: '',
        component: AndroidPhoneComponent,
        children: [
            {path: '', component: PhonesComponent},
            {path: ':serial', component: PhoneAppsComponent},
        ]
    }
];

@NgModule({
    declarations: [AndroidPhoneComponent, PhonesComponent, PhoneAppsComponent],
    imports: [CommonModule, SharedModule, NgbDropdownModule, RouterModule.forChild(routes)],
})
export class AndroidPhoneModule {}
