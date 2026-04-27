#!/usr/bin/env node
/**
 * Extract app icons from connected Android TV device and save to src/assets/app-icons/
 * Automatically discovers all installed third-party packages and fetches icons from Google Play Store.
 * Falls back to APK extraction if Play Store icon is unavailable.
 * Usage: npx tsx extract-icons.ts
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import gplay from 'google-play-scraper';

const ICON_DIR = path.join(__dirname, 'src', 'assets', 'app-icons');
const TEMP_DIR = '/tmp/freetv-icon-extract';

// OTT streaming apps to extract icons for
const OTT_APPS = [
    'tv.freetv.androidtv',
    'tv.freetv.androidtv.uat',
    'il.co.stingtv.staging',
    'com.stingtv.androidtv',
    'com.stingtv.androidtv.staging',
    'il.co.partnertv.atv',
    'il.co.partnertv.atv.staging',
    'tv.partner.androidtv',
    'tv.partner.androidtv.staging',
    'tv.yes.androidtv',
    'com.yes.yestv',
    'com.cellcom.cellcom_tv',
    'tv.cellcom.androidtv',
    'tv.cellcom.androidtv.stg',
    'com.netflix.ninja',
    'com.hbo.hbomax',
    'com.disneyplus',
    'com.hotstar.androidtv',
];

function run(cmd: string): string {
    try {
        return execSync(cmd, { encoding: 'utf-8' }).trim();
    } catch (e) {
        throw new Error(`Command failed: ${cmd}\n${(e as Error).message}`);
    }
}

function getEnvironmentLabel(packageId: string): string | null {
    if (packageId.includes('uat')) return 'UAT';
    if (packageId.includes('staging')) return 'STG';
    return null; // PROD - no label
}

async function addEnvironmentLabel(iconPath: string, label: string | null): Promise<void> {
    if (!label) return;

    const pyCode = `
from PIL import Image, ImageDraw, ImageFont

icon_path = "${iconPath}"
label = "${label}"

img = Image.open(icon_path).convert('RGBA')
width, height = img.size

# Create a new image with extra space at bottom for label
label_height = int(height * 0.18)
new_img = Image.new('RGBA', (width, height + label_height), (255, 255, 255, 0))

# Paste original icon at top
new_img.paste(img, (0, 0), img)

# Draw gradient background for label (top: darker, bottom: lighter)
draw = ImageDraw.Draw(new_img)

# Create gradient effect - draw multiple thin rectangles with slightly different colors
for i in range(label_height):
    # Gradient from dark (51, 65, 85) at top to darker (30, 41, 59) at bottom
    r = int(51 - (21 * i / label_height))
    g = int(65 - (24 * i / label_height))
    b = int(85 - (26 * i / label_height))
    alpha = 240
    draw.line([(0, height + i), (width, height + i)], fill=(r, g, b, alpha))

# Add subtle top border/highlight
draw.line([(0, height), (width, height)], fill=(100, 150, 200, 80), width=2)

# Add text in center of label with bold styling
font_size = int(width / 5.5)
try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
except:
    font = ImageFont.load_default()

# Get text dimensions
bbox = draw.textbbox((0, 0), label, font=font)
text_width = bbox[2] - bbox[0]
text_height = bbox[3] - bbox[1]
text_x = (width - text_width) // 2
text_y = height + (label_height - text_height) // 2

# Draw text with slight shadow effect
shadow_offset = 2
draw.text((text_x + shadow_offset, text_y + shadow_offset), label, font=font, fill=(0, 0, 0, 80))

# Draw main text with bright color
draw.text((text_x, text_y), label, font=font, fill=(255, 255, 255, 255))

new_img.save(icon_path)
`;

    run(`python3 << 'EOF'\n${pyCode}\nEOF`);
}

async function downloadFromPlayStore(packageId: string): Promise<string | null> {
    try {
        const app = await gplay.app({ appId: packageId });
        // Use icon field which is the 1:1 square app icon (not 16:9 banner)
        if (app.icon) {
            // Google Play icon format: get square icon by using standard icon field
            return app.icon;
        }
    } catch (e) {
        // Silent fail, will try APK extraction
    }
    return null;
}

async function extractIcon(packageId: string): Promise<boolean> {
    console.log(`📦 Extracting icon for ${packageId}...`);

    // Try Play Store first
    const playStoreIcon = await downloadFromPlayStore(packageId);
    if (playStoreIcon) {
        try {
            const outIcon = path.join(ICON_DIR, `${packageId}.png`);
            const response = await import('https').then(m => new Promise<Buffer>((resolve, reject) => {
                require('https').get(playStoreIcon, (res: any) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () => resolve(Buffer.concat(chunks)));
                    res.on('error', reject);
                }).on('error', reject);
            }));
            fs.writeFileSync(outIcon, response);
            const envLabel = getEnvironmentLabel(packageId);
            if (envLabel) {
                await addEnvironmentLabel(outIcon, envLabel);
            }
            console.log(`✅ Downloaded from Play Store${envLabel ? ` (${envLabel})` : ''}`);
            return true;
        } catch (e) {
            console.warn(`⚠️  Failed to download from Play Store, trying APK extraction...`);
        }
    }

    // Fall back to APK extraction
    try {
        const pathOut = run(`adb shell pm path ${packageId}`);
        const lines = pathOut.split('\n').map(l => l.trim()).filter(l => l);

        if (lines.length === 0) {
            console.warn(`⚠️  Package not found on device`);
            return false;
        }

        const apkPath = lines[0].replace('package:', '').trim();
        if (!apkPath) {
            console.warn(`⚠️  Could not parse APK path`);
            return false;
        }

        const tempApk = path.join(TEMP_DIR, `${packageId}.apk`);
        run(`adb pull "${apkPath}" "${tempApk}"`);

        const pyCode = [
            `import zipfile,sys,re`,
            `z=zipfile.ZipFile(sys.argv[1])`,
            `f=z.namelist()`,
            `d=lambda n:next((v for x,v in [('xxxhdpi',4),('xxhdpi',3),('xhdpi',2),('hdpi',1),('mdpi',0)] if x in n),-1)`,
            `b=[n for n in f if any(x in n.lower() for x in ['banner','ic_banner']) and (n.endswith('.png') or n.endswith('.webp')) and 'nodpi' not in n]`,
            `i=[n for n in f if re.search(r'mipmap-[^/]+/',n) and (n.endswith('.png') or n.endswith('.webp')) and 'nodpi' not in n and '_foreground' not in n.lower() and '_background' not in n.lower()]`,
            `p=([n for n in i if re.search(r'/ic_launcher\\.(png|webp)$',n)] or i)`,
            `c=(sorted(b,key=d,reverse=True) or sorted(p,key=d,reverse=True))`,
            `best=c[0] if c else None`,
            `sys.exit(1) if not best else None`,
            `open(sys.argv[2],'wb').write(z.read(best))`,
        ].join(';');

        const outIcon = path.join(ICON_DIR, `${packageId}.png`);
        run(`python3 -c "${pyCode}" "${tempApk}" "${outIcon}"`);
        const envLabel = getEnvironmentLabel(packageId);
        if (envLabel) {
            await addEnvironmentLabel(outIcon, envLabel);
        }
        console.log(`✅ Extracted from APK${envLabel ? ` (${envLabel})` : ''}`);
        run(`rm -f "${tempApk}"`);
        return true;
    } catch (e) {
        console.error(`❌ Failed: ${(e as Error).message}`);
        return false;
    }
}

async function getInstalledApps(): Promise<string[]> {
    try {
        const out = run('adb shell pm list packages -3');
        return out.split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('package:'))
            .map(line => line.replace('package:', ''))
            .filter(pkg => pkg && !pkg.startsWith('io.appium'));
    } catch (e) {
        console.error('❌ Failed to get installed packages. Make sure ADB device is connected.');
        throw e;
    }
}

async function main() {
    console.log('🎬 FreeTV QA Tool - Icon Extractor\n');

    // Create directories
    run(`mkdir -p "${TEMP_DIR}"`);
    if (!fs.existsSync(ICON_DIR)) {
        fs.mkdirSync(ICON_DIR, { recursive: true });
    }

    console.log(`📂 Saving icons to: ${ICON_DIR}\n`);

    // Get installed packages from device
    console.log('🔍 Discovering installed OTT apps on device...\n');
    const allPackages = await getInstalledApps();
    const packages = allPackages.filter(pkg => OTT_APPS.includes(pkg));
    console.log(`Found ${packages.length} OTT apps out of ${allPackages.length} installed apps\n`);

    // Extract all app icons
    let successCount = 0;
    for (const pkg of packages) {
        const success = await extractIcon(pkg);
        if (success) successCount++;
    }

    // Cleanup
    run(`rm -rf "${TEMP_DIR}"`);
    console.log(`\n✨ Done! Extracted ${successCount} icons to src/assets/app-icons/`);

    // Show extracted apps and generate component code
    const extractedApps = fs.readdirSync(ICON_DIR)
        .filter(f => f.endsWith('.png'))
        .map(f => f.replace('.png', ''))
        .sort();

    if (extractedApps.length > 0) {
        console.log('\n📦 Extracted apps:');
        extractedApps.forEach(app => console.log(`  - ${app}`));

        // Generate component code snippet
        console.log('\n📝 Update android-tv-apps.component.ts hasIcon() method:');
        console.log('─'.repeat(60));
        console.log('    hasIcon(packageId: string): boolean {');
        console.log('        // List of apps we\'ve extracted icons for');
        console.log(`        const extracted = [${extractedApps.map(app => `'${app}'`).join(', ')}];`);
        console.log('        return extracted.includes(packageId);');
        console.log('    }');
        console.log('─'.repeat(60));
    }
}

main().catch(e => {
    console.error(`\n❌ Error: ${e.message}`);
    process.exit(1);
});
