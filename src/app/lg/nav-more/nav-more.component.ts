import {Component} from '@angular/core';
import {ActivatedRoute, RouterLink} from "@angular/router";
import {LgComponent} from "../lg.component";
import ReleaseInfo from '../../../release.json';
import {SharedModule} from "../../shared/shared.module";
import {ExternalLinkDirective} from "../../shared/directives";

@Component({
    selector: 'app-nav-more',
    standalone: true,
    imports: [
        RouterLink,
        SharedModule,
        ExternalLinkDirective
    ],
    templateUrl: './nav-more.component.html',
    styleUrl: './nav-more.component.scss'
})
export class NavMoreComponent {
    lgRoute: ActivatedRoute | null;
    readonly appVersion: string;

    constructor(
        public route: ActivatedRoute,
        public parent: LgComponent,
    ) {
        this.lgRoute = route.parent;
        this.appVersion = ReleaseInfo.version;
    }
}
