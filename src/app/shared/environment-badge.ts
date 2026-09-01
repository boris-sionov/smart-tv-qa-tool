/**
 * Draws the environment badges onto a FreeTV icon.
 *
 * webOS and Android TV pick a bundled PNG per environment, because the badge only ever says
 * PREPROD or UAT. Tizen's also carries the build version, so there is no finite set of files to
 * ship and the icon is composed at install time instead.
 *
 * Two badges on opposite corners rather than one wide pill along the bottom: the environment is
 * what you look for first and the version is what you check second, and a single pill holding
 * both had to run nearly the icon's full width to stay legible, crowding the logo above it.
 * Corner-anchored, each pill grows only as far as its own text needs.
 *
 * Geometry is in the 512×512 space the artwork is drawn at, and scales with whatever base it is
 * given.
 */

/** Badge fill, sampled from the bundled webOS icons so the platforms match. */
const ENVIRONMENT_FILL = '#C41F64';
/** The version reads as secondary, so it takes a darker ground rather than a second magenta. */
const VERSION_FILL = 'rgba(18, 24, 42, 0.92)';
const OUTLINE = '#FFFFFF';
const TEXT = '#FFFFFF';

/** Every length is a fraction of the icon's width, so the badges follow the artwork's size. */
const FONT = 52 / 512;
const PAD_X = 22 / 512;
const PAD_Y = 14 / 512;
const STROKE = 7 / 512;
/** Gap from the icon's edge, enough that a launcher rounding the corners does not bite in. */
const MARGIN = 22 / 512;
/** Widest a single pill may get; a long environment shrinks its own type rather than overrun. */
const MAX_WIDTH = 0.8;

/** Arial first, deliberately: 'Arial Black' renders ~11% wider and overruns the pill's budget. */
const FONT_STACK = `Arial, 'Helvetica Neue', Helvetica, sans-serif`;

type Corner = 'top-left' | 'bottom-right';

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

/** Draws one pill tucked into `corner`, shrinking its type until it fits. */
function drawPill(
    ctx: CanvasRenderingContext2D, label: string, corner: Corner, fill: string, w: number, h: number,
): void {
    const padX = PAD_X * w;
    const padY = PAD_Y * w;
    const margin = MARGIN * w;

    // Shrink rather than passing a maxWidth to fillText, which condenses the glyphs into what
    // looks like a different typeface.
    let fontPx = Math.round(FONT * w);
    let metrics: TextMetrics;
    for (;;) {
        ctx.font = `bold ${fontPx}px ${FONT_STACK}`;
        metrics = ctx.measureText(label);
        if (metrics.width + 2 * padX <= MAX_WIDTH * w || fontPx <= 0.6 * FONT * w) break;
        fontPx -= 1;
    }

    // Cap height, not the font's full line box: the labels are caps and digits, so the box would
    // reserve descender room nothing uses and leave the pill looking bottom-heavy.
    const capHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent || fontPx;
    const pillW = metrics.width + 2 * padX;
    const pillH = capHeight + 2 * padY;
    const x = corner === 'top-left' ? margin : w - margin - pillW;
    const y = corner === 'top-left' ? margin : h - margin - pillH;

    roundedRect(ctx, x, y, pillW, pillH);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = STROKE * w;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();

    ctx.fillStyle = TEXT;
    ctx.fillText(label, x + pillW / 2, y + pillH / 2);
}

/**
 * Renders the environment and version badges over `baseAsset` and returns the PNG bytes.
 *
 * Either label may be absent — a build with no version still gets its environment badge.
 *
 * Throws rather than returning a half-drawn icon: the caller installs the packaged artwork
 * instead, which is a worse icon but never a broken one.
 */
export async function renderEnvironmentBadge(
    baseAsset: string, environment: string, version?: string | null,
): Promise<Uint8Array> {
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

    if (environment) drawPill(ctx, environment, 'top-left', ENVIRONMENT_FILL, w, h);
    if (version) drawPill(ctx, version, 'bottom-right', VERSION_FILL, w, h);

    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Canvas produced no PNG — it may have been tainted by the base image');
    return new Uint8Array(await blob.arrayBuffer());
}

/** The same badges as a data URL, for our own list rather than for writing into a package. */
export async function renderEnvironmentBadgeUrl(
    baseAsset: string, environment: string, version?: string | null,
): Promise<string> {
    const png = await renderEnvironmentBadge(baseAsset, environment, version);
    // A data URL rather than a blob: URL — it survives being cached and re-rendered by Angular
    // without anyone having to remember to revoke it.
    let binary = '';
    for (let i = 0; i < png.length; i += 0x8000) {
        binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
    }
    return `data:image/png;base64,${btoa(binary)}`;
}

/** Reads bundled artwork straight through, for a base that needs no badge drawn on it. */
export async function readIcon(asset: string): Promise<Uint8Array> {
    return new Uint8Array(await (await fetchAsset(asset)).arrayBuffer());
}
