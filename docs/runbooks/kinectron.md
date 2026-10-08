# Kinectron: a live Kinect in the dev harness

`KinectronDepthSource` (`@emersa/being/depth`) feeds the kinect cloud from a real Kinect through a Kinectron
server. It is a development path only: nothing in this runbook ships to production, by construction (see the CSP
note). The being on the site draws its cloud from its own depth and needs none of it.

## The server (a Windows machine with the Kinect)

Kinectron (https://github.com/kinectron/kinectron, MIT) is an Electron app that broadcasts Kinect frames to
browsers over PeerJS. Found on 2026-10-07:

- Releases: https://github.com/kinectron/kinectron/releases. Server 1.0.2 (`Kinectron-Server-1.0.2-win32-x64.zip`,
  6 October 2022) is for the Azure Kinect and pairs with client API 1.0.1. The 0.x line (last 0.4.0, 6 May 2025,
  "Windows 11, with support for Azure Kinect and Kinect 2", marked unmaintained) is the one for a Kinect 2 for
  Windows; its client speaks the older `makeConnection()` API, which the source accepts too.
- Needs Windows 10 or 11 and a USB 3.0 port. Kinectron drives the sensor through Microsoft's SDK for it; if the
  app cannot open the Kinect, install that SDK first.
- Unzip, run the app, plug in the Kinect and press "Open Kinect". The window shows the server's IP address and
  port (9001 by default). The browser machine must reach it: the same network, or an ngrok address made with
  "Create Public Address" and an ngrok authtoken, used as `{ host, port, path, secure: true }`.

## The client script and its licence

- Package `kinectron-client` 1.0.1 on npm, `license: "MIT"` in its package.json. The repository's LICENSE is the
  MIT License, "Copyright (c) 2025 Lisa Jamhoury", and GitHub reports SPDX `MIT`. Checked 2026-10-07.
- The browser build is `client/dist/kinectron.umd.js` in the repository, also served by jsDelivr as
  `https://cdn.jsdelivr.net/npm/kinectron-client@1.0.1/dist/kinectron.umd.js`. Download one copy (pin the version,
  never `@latest`) and keep the MIT notice with it: the package's `LICENSE` file, or the copyright line above.
- Save it as `apps/web/public/dev/kinectron-client.js`. The file is not committed: the `.gitignore` beside it in
  `apps/web/public/dev/` ignores the client and any `.webm` recording. Three reasons: third-party code is not
  vendored into this
  repository; nothing under `public/` ships without a cache rule (`lessons.md`); and `scripts/postbuild.mjs`
  deletes `dist/dev` after every build anyway, with `scripts/preflight.mjs` failing the build if it survives, so
  even a committed copy could never deploy. Never put the CDN URL in a page or in the CSP.

## The harness: /dev/kinect under astro dev

1. `npm run dev`, then open `http://localhost:4321/dev/kinect`. The page exists only in `astro dev`:
   `npm run build` removes `dist/dev*`, and the sitemap filter in `astro.config.mjs` leaves it out.
2. The page loads `/dev/kinectron-client.js` from its own origin, constructs the client and hands it to the
   runtime, which opens the connection (`peer.connect()` on client 1.x, `makeConnection()` on 0.x) and asks for
   the feed once the client reports ready (the structural `KinectronClient` type says which members are used):

   ```js
   const kinectron = new Kinectron(host); // or new Kinectron({ host, port, path, secure })
   const source = new KinectronDepthSource({ host, client: kinectron, kinectType: 'azure', feed: 'depth' });
   handle.setDepthSource(source);
   handle.setLook('kinect');
   ```

   `kinectType` is `'azure'` (640 x 576, the default) or `'windows'` (Kinect 2, 512 x 424) and sets the field of
   view. `feed: 'rawDepth'` asks for the 16-bit raw depth (read as millimetres) and encodes it against the
   clipping itself; `'depth'` takes the server's 8-bit image as it comes. Without a `client`, the source uses a
   global `Kinectron` constructor if the page loaded one, and otherwise stays not ready with one console warning.
3. Tune with `handle.kinect.setClipping(nearM, farM)` (0.85 to 4 m by default; the grey scaling of Kinectron's
   processed image is not documented, so expect to move these), `setPointSize(px)` (3 px on a 600 px tall canvas)
   and `setZOffset(m)` (2 m for a sensor source: a surface that far from the sensor stands on the figure's axis).
   `handle.stats()` reports `points` (the grid size while the cloud draws) and `depth` (the clipping in use).
4. `handle.setDepthSource(null)` returns to the being's own depth. The page owns the source: call
   `source.dispose()` (it stops the feeds) when it is done.

Nothing retries at frame rate: a missing server or sensor means a figure that keeps its own depth and one line in
the console. Assumptions a real sensor has yet to confirm are listed in the `KinectronClient` doc comment
(`packages/being/src/data/depth/KinectronDepthSource.ts`) and in ADR-0005.

## CSP note

Production sends `script-src 'self' 'wasm-unsafe-eval'` and `connect-src 'self'` (`tools/headers.ts`): a CDN
script or a WebSocket to a Kinectron server would be blocked, and neither is wanted there. Nothing has to be
allowed, because production never loads any of this: the harness page and the client script live under `dev/`,
which the build removes. `astro dev` applies no `_headers`, so the local script and the connection work there.
`npm run dev:worker` serves a build through the Worker with the headers on, and that build has no harness.

## The depth video alternative

Without a sensor, `VideoDepthSource` plays a grey depth video: a muted, looping `<video>` whose brightness is
linear depth, white at the near clip, black at the far clip, pure black where there is no data. That is the
format of three's own example input, `examples/textures/kinect.webm` in the three.js repository (MIT; it is not
part of the npm package).

```js
import { SENSOR_TANGENTS, VideoDepthSource } from '@emersa/being/depth';
const source = new VideoDepthSource('/dev/depth.webm', { tangents: SENSOR_TANGENTS.azure });
handle.setDepthSource(source);
```

Serve the file from the same origin (`apps/web/public/dev/`, kept out of git like the script) or with CORS
headers. The default tangents are the first Kinect's, as in the example; pass `SENSOR_TANGENTS.windows` or
`.azure` for a recording from those sensors. Muted autoplay is normally allowed; where a browser refuses, call
`source.play()` inside a click. Clipping and the z offset apply exactly as for a sensor.

## After changing any of this

`npx tsc -p packages/being/tsconfig.json`, `node --test packages/being/test/kinectron.test.ts
packages/being/test/depthMath.test.ts`, and `npm run build` (postbuild and preflight prove the harness is gone).
