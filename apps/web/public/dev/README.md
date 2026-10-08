# Development files for the kinect harness

This folder is served by `astro dev` under `/dev/` and removed from every build (`scripts/postbuild.mjs` deletes
`dist/dev`, and `scripts/preflight.mjs` fails a build that still has it), so nothing here ever deploys.

The harness page is `/dev/kinect` (`apps/web/src/pages/dev/kinect.astro`). To feed the cloud from a live Kinect it
needs the Kinectron browser client as `kinectron-client.js` **in this folder**, loaded from the dev origin when you
press Connect. The file is not vendored here: check its licence and version before copying it in (the project is
MIT-licensed at https://github.com/kinectron/kinectron; the client build lives in that repository's client
package), and keep it out of version control (the `.gitignore` beside this file does that). Once copied, the file
should define a global `Kinectron` constructor: `new Kinectron(host)` or `new Kinectron({ host, port })`, with
`peer.connect()`, `on('ready')`, `setKinectType`, `initKinect`, `startDepth` and `startRawDepth`, which is what
`packages/being/src/data/depth/KinectronDepthSource.ts` talks to (it opens the connection itself).

Without the sensor, the harness also accepts a depth video (white near, black far, as in three.js's
`webgl_video_kinect` example) through the file input, and the sliders for near, far, point size and z offset work
with either source.

The Kinectron runbook, `docs/runbooks/kinectron.md`, says how to run the Kinectron server and where to get the
client.
