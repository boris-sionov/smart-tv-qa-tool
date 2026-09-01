import {enableProdMode} from '@angular/core';
import {platformBrowserDynamic} from '@angular/platform-browser-dynamic';

import {AppModule} from './app/app.module';
import {AppConfig} from './environments/environment';
import ReleaseInfo from './release.json';
import {browserTracingIntegration, defaultStackParser, init as initSentry} from "@sentry/angular";
import {attachConsole} from '@tauri-apps/plugin-log';

initSentry({
    dsn: "https://93c623f5a47940f0b7bac7d0d5f6a91f@o4504977150377984.ingest.sentry.io/4504978685689856",
    tracePropagationTargets: [],
    integrations: [
        browserTracingIntegration()
    ],
    enabled: !!ReleaseInfo.version,
    environment: AppConfig.environment,
    release: ReleaseInfo.version || 'local',
    stackParser: (stack: string, skipFirst?: number) => {
        // noinspection HttpUrlsUsage
        stack = stack.replace(/@tauri:\/\//g, "@http://");
        return defaultStackParser(stack, skipFirst);
    },
    beforeBreadcrumb: (breadcrumb) => {
        return breadcrumb.level !== 'debug' ? breadcrumb : null;
    },
    beforeSendTransaction: () => {
        return null;
    },
    beforeSend: (event, hint) => {
        const originalException: any = hint.originalException;
        if (originalException && originalException['reason']) {
            if (originalException['unhandled'] !== true) {
                return null;
            }
        }
        return event;
    },
    // Set tracesSampleRate to 1.0 to capture 100%
    // of transactions for performance monitoring.
    // We recommend adjusting this value in production
    tracesSampleRate: 1.0,
});

if (AppConfig.production) {
    enableProdMode();
}

// Send the webview's console to the Rust log, so what the UI reports about an install ends up in
// ~/Library/Logs/<bundle id>/ alongside the backend's own lines. Without this the frontend's
// diagnostics exist only in devtools, which a release build does not open — a silent failure in
// there is invisible after the fact.
attachConsole().catch(err => console.error('Could not attach the console to the log file', err));

platformBrowserDynamic()
    .bootstrapModule(AppModule, {
        preserveWhitespaces: false
    })
    .catch(err => console.error(err));

const darkTheme = window.matchMedia('(prefers-color-scheme: dark)');

document.documentElement.setAttribute('data-bs-theme', darkTheme.matches ? 'dark' : 'light');
if (darkTheme.addEventListener) {
    darkTheme.addEventListener('change', (media) => {
        document.documentElement.setAttribute('data-bs-theme', media.matches ? 'dark' : 'light');
    });
} else {
    // noinspection JSDeprecatedSymbols
    darkTheme.addListener?.((ev) => document.documentElement.setAttribute(
        'data-bs-theme', ev.matches ? 'dark' : 'light'));
}
