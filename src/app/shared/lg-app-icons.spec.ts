import {lgEnvironmentIcon} from './lg-app-icons';

describe('lgEnvironmentIcon', () => {
    it('picks an icon per FreeTV environment', () => {
        expect(lgEnvironmentIcon('tv.freetv.portal.preprod', 'FreeTV')?.environment).toBe('PreProd');
        expect(lgEnvironmentIcon('tv.freetv.portal.preprodtest', 'FreeTV')?.environment).toBe('PreProd Test');
        expect(lgEnvironmentIcon('tv.freetv.portal.uat', 'FreeTV')?.environment).toBe('UAT');
        expect(lgEnvironmentIcon('tv.freetv.portal.prod-for-uat', 'FreeTV')?.environment).toBe('Prod on UAT');
    });

    it('shares the PROD TEST badge between the test builds', () => {
        const preprodTest = lgEnvironmentIcon('tv.freetv.portal.preprodtest', 'FreeTV');
        expect(preprodTest?.asset).toBe('assets/lg-icons/freetv-lg-prod-test-icon.png');
        expect(lgEnvironmentIcon('tv.freetv.portal.test', 'FreeTV')?.asset).toBe(preprodTest?.asset);
    });

    it('sends UAT and prod-for-uat to the same icon', () => {
        expect(lgEnvironmentIcon('tv.freetv.portal.uat', 'FreeTV')?.asset)
            .toBe('assets/lg-icons/freetv-lg-uat-icon.png');
        expect(lgEnvironmentIcon('tv.freetv.portal.prod-for-uat', 'FreeTV')?.asset)
            .toBe('assets/lg-icons/freetv-lg-uat-icon.png');
    });

    it('leaves apps we ship no icon for alone', () => {
        // Not FreeTV — a Sting or Netflix build must keep its own icon.
        expect(lgEnvironmentIcon('il.co.stingtv.uat', 'Sting TV UAT')).toBeNull();
        expect(lgEnvironmentIcon('netflix', 'Netflix')).toBeNull();
        // FreeTV, but an environment with no badged icon.
        expect(lgEnvironmentIcon('tv.freetv.portal.stg', 'FreeTV Staging')).toBeNull();
        // No environment marker at all.
        expect(lgEnvironmentIcon('tv.freetv.portal', 'FreeTV')).toBeNull();
    });

    it('reads the environment off the title when the id has none', () => {
        expect(lgEnvironmentIcon('com.example.player', 'FreeTV UAT')?.environment).toBe('UAT');
    });
});
