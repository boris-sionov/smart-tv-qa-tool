import {NgModule} from '@angular/core';
import {CommonModule} from '@angular/common';
import {RouterModule, Routes} from '@angular/router';
import {PlatformSelectorComponent} from './platform-selector.component';

const routes: Routes = [{path: '', component: PlatformSelectorComponent}];

@NgModule({
    declarations: [PlatformSelectorComponent],
    imports: [CommonModule, RouterModule.forChild(routes)],
})
export class PlatformSelectorModule {}
