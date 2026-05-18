const path = require('path');
const sharp = require('sharp');

const logo = '/Users/borissionov/Privet/Projects/FreeTV-SmartTV-main/app-core/public/img/Freetv-logo.png';
const outDir = path.resolve('src/assets/lg-icons/previews');

const variants = [
  {name: 'preprod', label: 'PREPROD', fill: '#E62E5C', stroke: '#FFFFFF', text: '#FFFFFF'},
  {name: 'uat', label: 'UAT', fill: '#2563EB', stroke: '#FFFFFF', text: '#FFFFFF'},
];

function badgeSvg(variant) {
  const width = 512;
  const height = 512;
  const badgeWidth = variant.label.length > 3 ? 302 : 212;
  const badgeHeight = 104;
  const x = width - badgeWidth - 10;
  const y = height - badgeHeight - 10;
  const fontSize = variant.label.length > 3 ? 47 : 60;

  return Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="8" stdDeviation="7" flood-color="#000000" flood-opacity="0.34"/>
        </filter>
      </defs>
      <rect x="${x}" y="${y}" width="${badgeWidth}" height="${badgeHeight}" rx="24"
            fill="${variant.fill}" stroke="${variant.stroke}" stroke-width="8" filter="url(#shadow)"/>
      <text x="${x + badgeWidth / 2}" y="${y + badgeHeight / 2 + 20}" text-anchor="middle"
            font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="800"
            letter-spacing="1" fill="${variant.text}">${variant.label}</text>
    </svg>
  `);
}

(async () => {
  const base = await cleanIcon();
  await Promise.all(variants.map((variant) =>
    sharp(base)
      .composite([{input: badgeSvg(variant), top: 0, left: 0}])
      .png()
      .toFile(path.join(outDir, `freetv-lg-${variant.name}-badge.png`))
  ));
  console.log(outDir);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function cleanIcon() {
  const background = {
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: '#9CFF00',
    },
  };

  return sharp(logo)
    .resize({width: 300, withoutEnlargement: false})
    .modulate({brightness: 0})
    .png()
    .toBuffer()
    .then((wordmark) =>
      sharp(background)
        .composite([
          {input: gradientSvg(), top: 0, left: 0},
          {input: wordmark, top: 152, left: 106},
        ])
        .png()
        .toBuffer()
    );
}

function gradientSvg() {
  return Buffer.from(`
    <svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#9CFF00"/>
          <stop offset="0.52" stop-color="#7BEC23"/>
          <stop offset="1" stop-color="#11D49A"/>
        </linearGradient>
      </defs>
      <rect width="512" height="512" fill="url(#bg)"/>
    </svg>
  `);
}
