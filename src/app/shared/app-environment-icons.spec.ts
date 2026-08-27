import {environmentIcon} from './app-environment-icons';

describe('environmentIcon', () => {
    it('picks an icon per FreeTV environment', () => {
        expect(environmentIcon('webos', 'tv.freetv.portal.preprod', 'FreeTV')?.environment).toBe('PreProd');
        expect(environmentIcon('webos', 'tv.freetv.portal.preprodtest', 'FreeTV')?.environment).toBe('PreProd Test');
        expect(environmentIcon('webos', 'tv.freetv.portal.uat', 'FreeTV')?.environment).toBe('UAT');
        expect(environmentIcon('webos', 'tv.freetv.portal.prod-for-uat', 'FreeTV')?.environment).toBe('Prod on UAT');
        expect(environmentIcon('android-tv', 'tv.freetv.androidtv.uat', 'FreeTV UAT')?.environment).toBe('UAT');
    });

    it('shares the PROD TEST badge between the test builds', () => {
        const preprodTest = environmentIcon('webos', 'tv.freetv.portal.preprodtest', 'FreeTV');
        expect(preprodTest?.asset).toBe('assets/lg-icons/freetv-lg-prod-test-icon.png');
        expect(environmentIcon('webos', 'tv.freetv.portal.test', 'FreeTV')?.asset).toBe(preprodTest?.asset);
    });

    it('sends UAT and prod-for-uat to the same icon', () => {
        expect(environmentIcon('webos', 'tv.freetv.portal.uat', 'FreeTV')?.asset)
            .toBe('assets/lg-icons/freetv-lg-uat-icon.png');
        expect(environmentIcon('webos', 'tv.freetv.portal.prod-for-uat', 'FreeTV')?.asset)
            .toBe('assets/lg-icons/freetv-lg-uat-icon.png');
    });

    it('serves each platform its own icon family', () => {
        expect(environmentIcon('webos', 'tv.freetv.portal.preprod', 'FreeTV')?.asset)
            .toBe('assets/lg-icons/freetv-lg-preprod-icon.png');
        expect(environmentIcon('android-tv', 'tv.freetv.androidtv.preprod', 'FreeTV')?.asset)
            .toBe('assets/android-tv-icons/freetv-atv-preprod-icon.png');
        // webOS ships no PROD badge and falls back to STORE; Android TV has one of its own.
        expect(environmentIcon('webos', 'tv.freetv.portal.prod', 'FreeTV')?.asset)
            .toBe('assets/lg-icons/freetv-lg-store-icon.png');
        expect(environmentIcon('android-tv', 'tv.freetv.androidtv.prod', 'FreeTV')?.asset)
            .toBe('assets/android-tv-icons/freetv-atv-prod-icon.png');
    });

    it('leaves apps we ship no icon for alone', () => {
        // Not FreeTV — a Sting or Netflix build must keep its own icon.
        expect(environmentIcon('webos', 'il.co.stingtv.uat', 'Sting TV UAT')).toBeNull();
        expect(environmentIcon('android-tv', 'il.co.stingtv.staging', 'StingTV Staging')).toBeNull();
        expect(environmentIcon('android-tv', 'com.netflix.ninja', 'Netflix')).toBeNull();
        // FreeTV, but an environment with no badged icon.
        expect(environmentIcon('android-tv', 'tv.freetv.androidtv.stg', 'FreeTV Staging')).toBeNull();
    });

    it('reads an unmarked Android TV build as prod', () => {
        // What QA installs is prod or uat, and only uat is marked.
        const unmarked = environmentIcon('android-tv', 'tv.freetv.androidtv', 'FreeTV');
        expect(unmarked?.environment).toBe('Prod');
        expect(unmarked?.asset).toBe('assets/android-tv-icons/freetv-atv-prod-icon.png');
        expect(environmentIcon('android-tv', 'tv.freetv.androidtv.prod', 'FreeTV')?.asset)
            .toBe(unmarked?.asset);
        // Still nothing for a non-FreeTV app with no marker.
        expect(environmentIcon('android-tv', 'com.netflix.ninja', 'Netflix')).toBeNull();
        // webOS writes to the TV, so it never guesses at an unmarked build.
        expect(environmentIcon('webos', 'tv.freetv.portal', 'FreeTV')).toBeNull();
    });

    it('reads the environment off the title when the id has none', () => {
        expect(environmentIcon('android-tv', 'com.example.player', 'FreeTV UAT')?.environment).toBe('UAT');
    });
});
