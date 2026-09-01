/**
 * Draws the environment badge onto a FreeTV icon.
 *
 * webOS and Android TV pick a bundled PNG per environment, because the badge only ever says
 * PREPROD or UAT. Tizen's says `PREPROD-1.26.0` — the build version is in it — so there is no
 * finite set of files to ship and the icon is composed at install time instead.
 *
 * Geometry is in the 512×512 space the artwork is drawn at, and scales with whatever base it is
 * given. The pill is deliberately shorter than the one baked into the webOS icons: it has to hold
 * three times the text without swallowing the logo above it.
 */

/** Badge fill, sampled from the bundled webOS icons so the two platforms match. */
const PILL = '#C41F64';
const OUTLINE = '#FFFFFF';
const TEXT = '#FFFFFF';

/** Every length is a fraction of the icon's width, so the badge follows the artwork's size. */
const FONT = 44 / 512;
const PAD_X = 24 / 512;
const PAD_Y = 14 / 512;
const STROKE = 6 / 512;
/** Where the pill's bottom edge sits, as a fraction of the icon's height. */
const BASELINE = 0.93;
/** Widest the pill may get. A long environment and a four-part version shrink the type instead. */
const MAX_WIDTH = 0.88;

/** Arial first, deliberately: 'Arial Black' renders ~11% wider and overruns the pill's budget. */
const FONT_STACK = `Arial, 'Helvetica Neue', Helvetica, sans-serif`;

/**
 * Decodes bundled artwork into something safe to draw and then read back.
 *
 * Not `new Image()` with a `src`: a release build serves the page from `tauri://localhost`, and
 * WKWebView treats an image fetched through that custom scheme as cross-origin, so drawing it
 * taints the canvas and `toBlob()` then fails — the badge silently never appears while everything
 * works in `tauri dev`, which serves over plain http. Bytes fetched here and handed to
 * `createImageBitmap` are origin-clean whatever the scheme.
 */
async function decodeAsset(asset: string): Promise<ImageBitmap | HTMLImageElement> {
    const blob = await fetchAsset(asset);
    if (typeof createImageBitmap === 'function') {
        return createImageBitmap(blob);
    }
    // No createImageBitmap: a blob: URL is same-origin, so this stays untainted too.
    const url = URL.createObjectURL(blob);
    try {
        return await new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`Cannot decode ${asset}`));
            img.src = url;
        });
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function fetchAsset(asset: string): Promise<Blob> {
    const response = await fetch(new URL(asset, document.baseURI));
    if (!response.ok) {
        throw new Error(`Cannot read ${asset}: HTTP ${response.status}`);
    }
    return response.blob();
}

function roundedRect(
    ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
): void {
    const r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(x + r, y + h);
    ctx.arc(x + r, y + r, r, Math.PI / 2, -Math.PI / 2);
    ctx.closePath();
}

/**
 * Renders `label` as a pill over `baseAsset` and returns the PNG bytes.
 *
 * Throws rather than returning a half-drawn icon — the caller installs the packaged artwork
 * instead, which is a worse icon but never a broken one.
 */
export async function renderEnvironmentBadge(baseAsset: string, label: string): Promise<Uint8Array> {
    const base = await decodeAsset(baseAsset);
    const w = base.width || 512;
    const h = base.height || 512;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Cannot get a 2D canvas context');

    ctx.drawImage(base, 0, 0, w, h);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const padX = PAD_X * w;
    const padY = PAD_Y * w;
    // Shrink the type until the pill fits rather than passing a maxWidth to fillText, which
    // condenses the glyphs and makes a long label look like a different typeface.
    let fontPx = Math.round(FONT * w);
    let metrics: TextMetrics;
    for (;;) {
        ctx.font = `bold ${fontPx}px ${FONT_STACK}`;
        metrics = ctx.measureText(label);
        if (metrics.width + 2 * padX <= MAX_WIDTH * w || fontPx <= 0.6 * FONT * w) break;
        fontPx -= 1;
    }
    // Cap height, not the font's full line box: the label is all caps and digits, so the box would
    // reserve descender room nothing uses and leave the pill looking bottom-heavy.
    const capHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent || fontPx;
    const pillH = capHeight + 2 * padY;
    const pillW = Math.min(metrics.width + 2 * padX, MAX_WIDTH * w);
    const x = (w - pillW) / 2;
    const y = h * BASELINE - pillH;

    roundedRect(ctx, x, y, pillW, pillH);
    ctx.fillStyle = PILL;
    ctx.fill();
    ctx.lineWidth = STROKE * w;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();

    ctx.fillStyle = TEXT;
    ctx.fillText(label, w / 2, y + pillH / 2);

    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Canvas produced no PNG — it may have been tainted by the base image');
    return new Uint8Array(await blob.arrayBuffer());
}

/** Reads bundled artwork straight through, for a base that needs no badge drawn on it. */
export async function readIcon(asset: string): Promise<Uint8Array> {
    return new Uint8Array(await (await fetchAsset(asset)).arrayBuffer());
}
