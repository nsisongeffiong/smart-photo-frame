# Frame uploader

A small, phone-friendly web app for adding photos to the smart photo frame without a terminal. It does what the manual routine did:

1. make a folder per album under `/srv/photos`,
2. copy photos in,
3. `mogrify -auto-orient -resize 2560x2560\> -quality 82 -strip` each one.

Open the page on your phone, sign in, pick an album (or make one), choose photos. Each photo is resized, rotated upright, stripped of location data, saved into the album, and appears on the frame at its next rescan (within a minute).

## Why this is a separate service

The frame mounts the photo folder **read-only** on purpose, so a flaw in the page the iPad loads can never change your photos. Writing needs a second, small app with its own password. This is that app. The frame is unchanged.

```
phone ──https──> uploader (password, read-write) ──> /srv/photos <── frame (read-only) <── iPad
```

## What it does with a photo

| Step | Detail |
|---|---|
| Accepts | JPEG, PNG, WebP, GIF (still), TIFF, AVIF. Up to `MAX_UPLOAD_MB` each. |
| Orientation | Applies the EXIF rotation, so portraits are stored upright. |
| Size | Shrinks to fit `MAX_EDGE` px (2560) on the long side. Never enlarges. |
| Quality | JPEG at `JPEG_QUALITY` (82), mozjpeg encoder. |
| Colour | Converts wide-gamut (Display P3) photos to sRGB, then drops the profile, so colours do not shift on the iPad. |
| Metadata | Removes all of it, including GPS location. |
| Output | `.jpg`, or `.png` for images with transparency. These are formats the iPad's Safari 12 can show. |
| Name | Sanitised. A repeat name gets `-2`, `-3`; nothing is overwritten. |
| Permissions | Files `644`, folders `755`, so the frame's unprivileged container can read them. |

Refused with a plain-language reason: non-images, SVG, animated GIFs, truncated files, images over `MAX_PIXELS` (decompression-bomb guard), and any album already at `FRAME_MAX_PHOTOS_PER_ALBUM`, because the frame silently never shows photo 501 onwards.

**iPhone HEIC:** this server cannot decode HEVC-based HEIC (the prebuilt image library ships without that decoder). Safari on iOS normally converts to JPEG when you pick photos from the library with the standard picker; if a HEIC file does arrive you get a message saying so. Setting Camera > Formats > *Most Compatible* avoids it entirely.

## Deploy with Coolify (about ten minutes)

1. **Find who owns the photo folder** on the VPS and note the two numbers:
   ```bash
   stat -c '%u:%g' /srv/photos
   ```
2. **DNS:** add an `A` record for the new name (for example `upload.example.com`) pointing at the VPS. If the domain is on Cloudflare, use *DNS only* (grey cloud) so Coolify can obtain its certificate.
3. **Coolify:** *New resource* → the same GitHub repository → build pack **Docker Compose**.
   - Base directory: `/uploader`
   - Compose file: `/docker-compose.yaml`
   - Domain for the `photo-uploader` service: `https://upload.example.com:3000`
4. **Environment variables** (see `.env.example`):
   - `UPLOAD_PASSWORD` (required, 12+ characters). If it contains a `$`, tick *Is Literal* in Coolify.
   - `UPLOAD_UID` and `UPLOAD_GID` from step 1.
   - Optionally `SESSION_SECRET` (`openssl rand -hex 32`) so you stay signed in across restarts.
5. **Deploy.** The container refuses to start, with the reason in its log, if the password is weak or the photo folder is not writable by that user.
6. Open the address on your phone, sign in, and *Add to Home Screen* if you like.

**Why its own hostname, not a path or port on the frame's address.** It is a separate container because it needs write access and the frame must keep a read-only mount. A separate hostname also gives it a separate browser origin, so a script injected into the frame's page (which carries the frame key in its address) can never reach this service's cookie or API. Coolify can route a path prefix, but both apps use `/api/...` and the page would have to be rebuilt to live under a prefix. Coolify's domain field cannot publish an extra public port. A subdomain is one DNS record and Coolify issues the certificate.

Add the new address to Uptime Kuma: `GET /healthz` returns `{"ok":true}`, or 503 if the photo folder stops being writable.

### Tailscale and Home Assistant

Nothing to configure. This service does not talk to Home Assistant and does not use the tailnet, so it holds no Home Assistant token. The only secret it holds is its own password.

After creating an album, add the same name to the album dropdown in Home Assistant (Settings > Devices & services > Helpers) so you can select it. The name must match the folder exactly (`Family`, not `family`). Keeping the dropdown in step automatically is a job for the frame, which already holds a Home Assistant token and already scans the folders; it is deliberately not done here, because an internet-facing service that parses uploaded images should not also hold a full-access key to the house.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `UPLOAD_PASSWORD` | required | 12-128 characters, no leading/trailing space. |
| `SESSION_SECRET` | random per start | 32+ characters; set it to survive restarts. Changing it signs everyone out. |
| `SESSION_HOURS` | 168 | Sign-in lifetime. |
| `TRUST_PROXY` | 1 | Proxies in front. Needed so the brute-force limit sees real client addresses. `false` if none; `2` if Cloudflare's proxy (orange cloud) is on as well as Coolify. |
| `COOKIE_SECURE` | true | Set `false` only for plain-http local testing. |
| `AUTH_MAX_FAILS` / `AUTH_WINDOW_MS` | 10 / 900000 | Wrong passwords allowed per address per window. Across all addresses combined the limit is 5 times this, after which every sign-in is refused until the window ends (people already signed in are unaffected). |
| `MAX_UPLOAD_MB` | 40 | Per file. |
| `MAX_PIXELS` | 50000000 | Refuse images that decode to more than this. 50 MP covers 48 MP phone photos; raise it only if you need more, and test memory first (the container is capped at 768 MB). AVIF has its own fixed limit of 16 MP because it is decoded whole. |
| `MAX_EDGE` | 2560 | Long-side limit. |
| `JPEG_QUALITY` | 82 | |
| `FRAME_MAX_PHOTOS_PER_ALBUM` | 500 | Keep equal to the frame's `MAX_PHOTOS_PER_ALBUM`. `0` disables the check. |
| `MIN_FREE_MB` | 500 | Refuse uploads when the disk has less free than this. |
| `PROCESS_CONCURRENCY` | 1 | Photos converted at once. Up to this many plus 2 uploads can be in flight; any more get a "busy" reply. |
| `PHOTOS_DIR` | /photos | Inside the container. |

All settings are validated at start and every problem is reported at once.

## Security notes

- One shared password. Sign-in sets an `HttpOnly`, `Secure`, `SameSite=Strict` cookie holding an expiry and an HMAC signature, with no server-side session list. Wrong passwords are throttled per client address. Rotating `SESSION_SECRET` revokes every session.
- State-changing requests from another origin are refused as a second layer behind `SameSite`.
- The page ships with a strict Content-Security-Policy (no inline script or style), and the script builds the page from text nodes only.
- Album and file names are validated against the same rules the frame applies; uploaded names are reduced to a safe base name; paths are never built from raw input; symlinks are never followed or listed.
- Images are decoded by `sharp`/libvips with a pixel limit, at most `PROCESS_CONCURRENCY` at a time, and never from SVG.
- The container runs as an unprivileged user with a read-only root filesystem, no capabilities and a memory cap.
- The service never deletes anything except photos you ask it to, inside albums. A folder holding non-photo files is left in place.

## Develop and test

```bash
npm install
npm test                      # 66 tests
FRAME_SERVER=../server.js npm test   # also runs the real frame server against the uploader's output
npm start                     # needs UPLOAD_PASSWORD; add COOKIE_SECURE=false for http://localhost
```

The frame integration test starts the frame's own `server.js` and checks that albums and photos created through the uploader are listed, oriented, and fetchable. It is skipped if the frame source is not found.

Not covered by the tests: how the page looks and feels on a real phone, a real iPhone upload, and the Docker image build.
