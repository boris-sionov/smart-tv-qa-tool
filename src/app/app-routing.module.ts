import {NgModule} from '@angular/core';
import {RouterModule, Routes} from '@angular/router';
import {HomeComponent} from './home/home.component';
import {NavMoreComponent} from './home/nav-more/nav-more.component';

const routes: Routes = [
    {
        path: '',
        loadChildren: () => import('./platform-selector/platform-selector.module').then(m => m.PlatformSelectorModule),
    },
    {
        path: 'lg',
        component: HomeComponent,
        children: [
            {path: 'apps', loadChildren: () => import('./apps').then(m => m.AppsModule)},
            {path: 'files', loadChildren: () => import('./files').then(m => m.FilesModule)},
            {path: 'terminal', loadChildren: () => import('./terminal').then(m => m.TerminalModule)},
            {path: 'debug', loadChildren: () => import('./debug').then(m => m.DebugModule)},
            {path: 'info', loadChildren: () => import('./info').then(m => m.InfoModule)},
            {path: 'devices', loadComponent: () => import('./devices/devices.component').then(m => m.DevicesComponent)},
            {path: 'nav-more', component: NavMoreComponent},
            {path: '', redirectTo: 'apps', pathMatch: 'full'},
        ]
    },
    {
        path: 'android-tv',
        loadChildren: () => import('./android-tv/android-tv.module').then(m => m.AndroidTvModule),
    },
    {
        path: 'vidaa',
        loadChildren: () => import('./vidaa/vidaa.module').then(m => m.VidaaModule),
    },
    {path: '**', redirectTo: ''},
];

@NgModule({
    imports: [RouterModule.forRoot(routes)],
    exports: [RouterModule]
})
export class AppRoutingModule {}
