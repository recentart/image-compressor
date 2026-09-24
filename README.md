# Free Image Compressor

A small, static website that compresses JPG, PNG and WebP images to a target file size
(100 KB, 200 KB, 500 KB, 1 MB or a custom size). Everything happens in the visitor's browser:
there is no backend, no database, no upload endpoint, no accounts, no analytics and no ads.

Plain HTML, CSS and JavaScript. No build step, no dependencies, no environment variables.

## Files

```
public/            ← the whole website (this is the folder you deploy)
  index.html       page markup, SEO title/description, privacy section
  styles.css       layout, light/dark themes
  app.js           file picking, drag and drop, settings, results, download
  worker.js        the compression engine (runs in a Web Worker so the page never freezes)
  favicon.svg
  _headers         Cloudflare Pages security headers (Content-Security-Policy etc.)
README.md
```

## How compression works

1. If the image is already at or under the target, it is **not touched**: the original file is
   offered for download unchanged.
2. Otherwise, at full size, the engine searches for the **highest quality** that fits the target.
3. If even the lowest allowed quality is too big, it reduces the width and height in small steps
   (100% → 90% → 80% → 70% → 60% → 50% → 40% → 33% → 25%), keeping the aspect ratio, and
   searches again at each step. It never goes below 25% of the original width or height.
4. If nothing fits, it stops and explains why, showing the smallest size it could reach.

The result always shows the original and final size, reduction, original and final dimensions,
whether the dimensions were reduced, and the quality used.

| Input | How it gets smaller | "Quality" shown |
|---|---|---|
| JPG | JPEG quality 92 down to 50 | e.g. `78 / 100` |
| WebP | WebP quality 92 down to 50 | e.g. `78 / 100` |
| PNG, **Lossless optimization** (default) | Picks the smallest exact PNG type (palette, gray, RGB or RGBA), per-row filters, compression. Pixels stay identical. | `Lossless` |
| PNG, **Reduce colors** (opt-in) | Lossless first, then 256, 128 or 64 colors (median cut + k-means) | e.g. `128 colors (reduced)` |
| PNG, **Convert to WebP** (opt-in) | Output becomes `.webp`, quality 92 down to 50 | e.g. `70 / 100` |

PNG never pretends to have a JPEG-style quality slider. Reducing colors or changing the format only
happens when the user picks that option, and the result says so.

## Run it locally

The page uses a Web Worker, which browsers don't allow from `file://`, so opening
`index.html` by double-clicking won't work. Serve the `public` folder with any static server:

```bash
npx serve public
```

or, with Python installed:

```bash
python -m http.server 8080 --directory public
```

Then open the address it prints (for example http://localhost:3000 or http://localhost:8080).

The `_headers` file is only applied by Cloudflare Pages, not by these local servers.

## Deploy to Cloudflare Pages (free plan)

No build command, no framework preset and no environment variables are needed. The site is just
the `public` folder.

**Option A: upload from the dashboard (no Git needed)**

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Pages → Upload assets**.
2. Name the project (for example `free-image-compressor`).
3. Drag the `public` folder in and click **Deploy**.
4. Re-upload the folder whenever you change something.

**Option B: connect a Git repository (deploys on every push)**

1. Push this project to GitHub or GitLab.
2. In the dashboard: **Workers & Pages → Create → Pages → Connect to Git**, then pick the repository.
3. Build settings: Framework preset **None**, Build command **(leave empty)**,
   Build output directory **`public`**.
4. Click **Save and Deploy**.

**Option C: command line**

```bash
npx wrangler pages deploy public --project-name free-image-compressor
```

The first run opens a browser window to log in to Cloudflare.

After deploying, you can add a custom domain under the project's **Custom domains** tab. Once the
final URL is known, you may also add `<link rel="canonical" href="https://your-domain/">` to
`index.html`.

### Security headers

`public/_headers` sets a strict Content-Security-Policy. Among other things it includes
`connect-src 'none'`, so the page cannot send network requests (fetch/XHR) at all. That backs up the
privacy promise. If you ever add a third-party script, font or analytics, you must update that
policy or it will be blocked.

## Browser support

Needs `OffscreenCanvas` in workers and `CompressionStream`: current Chrome, Edge, Firefox
(113+) and Safari (16.4+).

Safari cannot create WebP files. There, WebP images can't be compressed (the page says so) and the
PNG "Convert to WebP" option is disabled. JPG and PNG work normally.

## Known limitations

- One image at a time (no batch mode).
- Animated PNG/WebP can't be compressed (only the first frame would survive), and the page says
  so. GIF, HEIC, AVIF, SVG and other formats are rejected with a clear message.
- Images are processed as 8-bit sRGB: 16-bit PNGs become 8-bit, and embedded color profiles are
  converted to sRGB by the browser.
- Compressed files don't keep metadata (EXIF, GPS). Photo rotation from EXIF is applied first,
  so images stay the right way up.
- Maximum 100 megapixels. Very large images may still exceed a phone browser's memory limits.
- 1 KB = 1,000 bytes and 1 MB = 1,000,000 bytes, so a file under "100 KB" here also passes a check
  that uses 1,024-byte kilobytes.
