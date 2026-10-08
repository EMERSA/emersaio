import { DataTexture, FloatType, NearestFilter, RedFormat, type Texture } from 'three';
import type { DepthSource } from './DepthSource.ts';
import {
  azureGreyToMm,
  type DepthClipping,
  type FovTangents,
  KINECTRON_CLIPPING,
  kinectV2GreyToMm,
  SENSOR_TANGENTS,
} from './depthMath.ts';

export type KinectronKinectType = 'azure' | 'windows';
export type KinectronFeed = 'depth' | 'rawDepth';

/** One frame of a Kinectron image feed: a data URL in `src` (client 1.x), or an Image element whose src is one (0.x). */
export interface KinectronImageFrame {
  src?: string;
  width?: number;
  height?: number;
}

/** One frame of the 1.x raw depth feed: 16-bit millimetres, 0 where the sensor saw nothing. */
export interface KinectronRawDepthFrame {
  depthValues: ArrayLike<number>;
  width?: number;
  height?: number;
}

/** What a raw depth callback may receive: the 1.x frame object, or the 0.x client's bare array of millimetres. */
export type KinectronRawDepthPayload = KinectronRawDepthFrame | ArrayLike<number>;

/**
 * The slice of the Kinectron browser client this source talks to, as a structural type: the page constructs the
 * client itself from a script it serves (the production CSP allows scripts from self alone, so nothing is fetched
 * from a CDN here) and passes the instance in. Checked against kinectron/kinectron for client 1.x (the study in
 * docs/research/kinectron-study.md): new Kinectron(host | { host, port, path, secure, role, config }) connects by
 * itself, `on(event, cb)` is a Map.set (one handler per event, no off), 'ready' fires on every connection open
 * including reconnects, isConnected(), initKinect() is a Promise with no timeout, startDepth(cb) where cb gets
 * { src, width, height, raw, timestamp } holding an 8-bit depth image, startRawDepth(cb) where cb gets
 * { depthValues: Uint16Array, width, height, timestamp }, stopAll() and close(). There is no peer.connect() to
 * call and no makeConnection() in 1.x; setKinectType is ignored by the 1.x server (Azure only). The 0.x client's
 * makeConnection(), setKinectType() and its bare-array raw frames are accepted too.
 *
 * Because the events are single-slot, a client belongs to exactly one source: never share one between two
 * sources, or with the page's own handlers.
 */
export interface KinectronClient {
  setKinectType?(type: KinectronKinectType): void;
  on?(event: 'ready' | 'error', callback: (detail?: unknown) => void): void;
  isConnected?(): boolean;
  makeConnection?(): void;
  initKinect?(callback?: () => void): Promise<unknown> | undefined;
  startDepth(callback: (frame: KinectronImageFrame | HTMLImageElement) => void): void;
  startRawDepth?(callback: (frame: KinectronRawDepthPayload) => void): void;
  stopAll?(): void;
  close?(): void;
}

/** The 1.x constructor config, or a plain host string (the only form the 0.x client takes). */
export type KinectronClientConfig =
  | string
  | { host: string; port?: number; path?: string; secure?: boolean; role?: string; config?: unknown };

export type KinectronConstructor = new (config: KinectronClientConfig) => KinectronClient;

export interface KinectronDepthSourceOptions {
  /** The Kinectron server's address (an IP, or the bare ngrok-free.app host). */
  host: string;
  port?: number;
  /** PeerJS path and TLS for the 1.x constructor; the defaults are the app's own ("/" on 9001, plain). */
  path?: string;
  secure?: boolean;
  /** The processed 8-bit depth image (default), or the 16-bit raw depth, preferred for a face (12 mm per level otherwise). */
  feed?: KinectronFeed;
  /** Which sensor is streaming; sets the field of view, the frame size and the grey decode. Azure Kinect by default. */
  kinectType?: KinectronKinectType;
  /**
   * A client the page made (new Kinectron(host)). Without one, a Kinectron constructor on the global object (the
   * dev harness page loads kinectron-client.js from its own origin) is used; otherwise the source stays not ready.
   * The source owns the client's 'ready', 'error' and frame slots from then on.
   */
  client?: KinectronClient;
  /** Clipping in metres for the colour ramp and the hit test; the sensor's own range by default. */
  near?: number;
  far?: number;
  /**
   * Whether to call initKinect() when the first feed request brings no frame within `autoInitAfterMs` (2 s): the
   * call re-opens the device for every client of the server, so it is a fallback, not the first move. On by default.
   */
  autoInit?: boolean;
  autoInitAfterMs?: number;
  /** initKinect() has no timeout of its own; after this long the feed is requested again regardless (5 s). */
  initTimeoutMs?: number;
}

/** Frame sizes by sensor and feed: Azure depth NFOV unbinned, Azure raw and depth-key NFOV 2x2 binned, Kinect v2. */
export const KINECTRON_FRAME_SIZE: Readonly<
  Record<KinectronKinectType, Record<KinectronFeed, { width: number; height: number }>>
> = {
  azure: { depth: { width: 640, height: 576 }, rawDepth: { width: 320, height: 288 } },
  windows: { depth: { width: 512, height: 424 }, rawDepth: { width: 512, height: 424 } },
};

export const AUTO_INIT_AFTER_MS = 2000;
export const INIT_TIMEOUT_MS = 5000;

const warnedOnce = new Set<string>();
/** Said once per page per message key: a missing sensor must never fill the console at frame rate. */
const warnOnce = (key: string, message: string): void => {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(`[being] KinectronDepthSource: ${message}`);
};

/** An error detail from the client, in a sentence: its `error` or `message` field, or the value itself. */
export function formatKinectronError(detail: unknown): string {
  if (detail && typeof detail === 'object') {
    const d = detail as { error?: unknown; message?: unknown };
    if (d.error !== undefined && d.error !== null) return String(d.error);
    if (d.message !== undefined && d.message !== null) return String(d.message);
  }
  return String(detail);
}

/**
 * Live Kinect depth over Kinectron as a source. Every frame ends up as metres in a float R32F texture (0 where
 * the sensor saw nothing): the raw feed's 16-bit millimetres directly, the image feed's 8-bit grey decoded per
 * sensor (Azure 0.5 to 4 m, Kinect v2 inverted at 17 mm per level). The cloud back-projects the metres itself,
 * so nothing is re-encoded through 8 bits on the way. Everything fails soft: no client, no DOM or a client that
 * throws leaves a source that is simply never ready.
 */
export class KinectronDepthSource implements DepthSource {
  readonly kind = 'kinectron' as const;
  readonly encoding = 'metres' as const;
  readonly fovTangents: FovTangents;
  width: number;
  height: number;
  ready = false;
  texture: Texture;
  private readonly type: KinectronKinectType;
  private readonly feed: KinectronFeed;
  private readonly autoInit: boolean;
  private readonly autoInitAfterMs: number;
  private readonly initTimeoutMs: number;
  private client: KinectronClient | null = null;
  /** True when this source constructed the client (and so closes it), false when the page handed one in. */
  private readonly ownsClient: boolean;
  private requested = false;
  private initTried = false;
  private frames = 0;
  private clipping: DepthClipping;
  private disposed = false;
  private metres: Float32Array;
  private readonly canvas: HTMLCanvasElement | null = null;
  private readonly context: CanvasRenderingContext2D | null = null;
  private readonly image: HTMLImageElement | null = null;
  private initTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly onDepth = (frame: KinectronImageFrame | HTMLImageElement): void => {
    if (this.disposed) return;
    if (!this.image) {
      warnOnce('no-dom', 'no document to decode frames in; the source stays empty.');
      return;
    }
    const src = frame && typeof frame === 'object' ? (frame as KinectronImageFrame).src : undefined;
    if (typeof src !== 'string' || src === '') return;
    // Decoding is asynchronous; a frame that lands before the last one decoded simply replaces it.
    this.image.src = src;
  };

  private readonly onImageLoad = (): void => {
    const image = this.image;
    const context = this.context;
    const canvas = this.canvas;
    if (!image || !context || !canvas || this.disposed) return;
    const width = image.naturalWidth || this.width;
    const height = image.naturalHeight || this.height;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    this.resize(width, height);
    const decode = this.type === 'windows' ? kinectV2GreyToMm : azureGreyToMm;
    const out = this.metres;
    for (let i = 0; i < width * height; i += 1) out[i] = decode(pixels[i * 4] ?? 0) / 1000;
    this.commit();
  };

  private readonly onRawDepth = (payload: KinectronRawDepthPayload): void => {
    if (this.disposed || !payload) return;
    // 1.x hands a frame object; 0.x a bare array (one frame late, which does not matter here). A 1.x error frame
    // has no values at all.
    const frame = payload as KinectronRawDepthFrame;
    const values: ArrayLike<number> | undefined =
      typeof (payload as ArrayLike<number>).length === 'number' ? (payload as ArrayLike<number>) : frame.depthValues;
    if (!values || typeof values.length !== 'number') {
      warnOnce('raw-error', 'the raw depth feed sent a frame with no values (an error frame); it was skipped.');
      return;
    }
    const width = frame.width ?? this.width;
    const height = frame.height ?? Math.max(1, Math.round(values.length / width));
    this.resize(width, height);
    const out = this.metres;
    const count = Math.min(out.length, values.length);
    for (let i = 0; i < count; i += 1) out[i] = (values[i] ?? 0) / 1000;
    for (let i = count; i < out.length; i += 1) out[i] = 0;
    this.commit();
  };

  constructor(options: KinectronDepthSourceOptions) {
    const type = options.kinectType ?? 'azure';
    const feed = options.feed ?? 'depth';
    this.type = type;
    this.feed = feed;
    this.fovTangents = SENSOR_TANGENTS[type];
    const sensorRange = KINECTRON_CLIPPING[type];
    this.clipping = { near: options.near ?? sensorRange.near, far: options.far ?? sensorRange.far };
    this.autoInit = options.autoInit !== false;
    this.autoInitAfterMs = options.autoInitAfterMs ?? AUTO_INIT_AFTER_MS;
    this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    const size = KINECTRON_FRAME_SIZE[type][feed];
    this.width = size.width;
    this.height = size.height;
    this.metres = new Float32Array(this.width * this.height);
    this.texture = createMetresTexture(this.metres, this.width, this.height);

    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = this.width;
      canvas.height = this.height;
      this.canvas = canvas;
      this.context = canvas.getContext('2d', { willReadFrequently: true });
      this.image = new Image();
      this.image.addEventListener('load', this.onImageLoad);
    }

    const own = options.client === undefined;
    const client = options.client ?? constructClient(options);
    this.ownsClient = own && client !== null;
    if (!client) {
      warnOnce(
        'no-client',
        'no client: pass new Kinectron(host) as options.client, or load kinectron-client.js from your own origin first.',
      );
      return;
    }
    this.client = client;
    try {
      this.connect(client);
    } catch (error) {
      warnOnce('connect-threw', `the client threw while connecting: ${formatKinectronError(error)}`);
    }
  }

  setClipping(nearM: number, farM: number): void {
    if (!(nearM > 0) || !(farM > nearM)) return;
    this.clipping = { near: nearM, far: farM };
  }

  /** The metres the ramp spans: the clipping. */
  range(): DepthClipping {
    return { ...this.clipping };
  }

  update(): void {
    // Frames arrive through the client's callbacks; nothing to poll.
  }

  /**
   * Stop what this source started and let go of the client: stopAll() only if this source requested a feed (it
   * stops every client's feeds on the server), close() only on a client this source constructed, and the texture
   * is disposed. A client the page handed in stays open for the page.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.clearInitTimer();
    this.image?.removeEventListener('load', this.onImageLoad);
    const client = this.client;
    this.client = null;
    try {
      if (this.requested) client?.stopAll?.();
      if (this.ownsClient) client?.close?.();
    } catch {
      // A client that has already gone away has nothing left to stop.
    }
    this.texture.dispose();
  }

  private connect(client: KinectronClient): void {
    if (typeof client.makeConnection === 'function') {
      // 0.x: set the sensor, connect, then ask for the feed straight away, as the Kinectron examples do.
      client.setKinectType?.(this.type);
      client.makeConnection();
      this.requestFeed();
      return;
    }
    // 1.x supports the Azure Kinect alone; the server ignores setKinectType.
    if (this.type === 'windows') {
      warnOnce('azure-only', 'client 1.x streams from an Azure Kinect only; "windows" is decoded as Kinect v2 anyway.');
    }
    if (typeof client.on === 'function') {
      client.on('ready', this.onReady);
      client.on('error', (detail) =>
        warnOnce('error', `the connection reported an error: ${formatKinectronError(detail)}`),
      );
    }
    // The 1.x constructor connects by itself; there is nothing to call. A client already connected starts now, and
    // 'ready' (which fires on every open, reconnects included) re-requests the feed each time.
    if (client.isConnected?.() ?? typeof client.on !== 'function') this.onReady();
  }

  /** Idempotent: a connection open, or another one after a drop, asks for the feed again and nothing else twice. */
  private readonly onReady = (): void => {
    if (this.disposed || !this.client) return;
    this.requestFeed();
  };

  /** Ask for the feed now; if no frame lands within 2 s, try initKinect() once, raced against 5 s, then ask again. */
  private requestFeed(): void {
    const client = this.client;
    if (!client || this.disposed) return;
    try {
      if (this.feed === 'rawDepth' && typeof client.startRawDepth === 'function') client.startRawDepth(this.onRawDepth);
      else client.startDepth(this.onDepth);
      this.requested = true;
    } catch (error) {
      warnOnce('start-threw', `the client threw while starting the ${this.feed} feed: ${formatKinectronError(error)}`);
      return;
    }
    if (!this.autoInit || this.initTried || typeof client.initKinect !== 'function') return;
    this.clearInitTimer();
    const framesBefore = this.frames;
    this.initTimer = setTimeout(() => {
      this.initTimer = null;
      if (this.disposed || this.frames !== framesBefore || this.initTried) return;
      this.initTried = true;
      this.initKinect();
    }, this.autoInitAfterMs);
  }

  /** initKinect() never settles while the server blocks API calls, hence the race against a timeout. */
  private initKinect(): void {
    const client = this.client;
    if (!client || typeof client.initKinect !== 'function') return;
    let settled = false;
    const again = (): void => {
      if (settled || this.disposed) return;
      settled = true;
      this.clearInitTimer();
      this.requestFeed();
    };
    try {
      const init = client.initKinect();
      if (init && typeof (init as Promise<unknown>).then === 'function') {
        (init as Promise<unknown>).then(again, (error: unknown) => {
          warnOnce('init-failed', `initKinect failed: ${formatKinectronError(error)}`);
          again();
        });
      } else {
        again();
        return;
      }
    } catch (error) {
      warnOnce('init-threw', `initKinect threw: ${formatKinectronError(error)}`);
      again();
      return;
    }
    this.initTimer = setTimeout(() => {
      this.initTimer = null;
      if (!settled)
        warnOnce('init-hung', `initKinect did not settle within ${this.initTimeoutMs} ms; asking for the feed again.`);
      again();
    }, this.initTimeoutMs);
  }

  private clearInitTimer(): void {
    if (this.initTimer !== null) clearTimeout(this.initTimer);
    this.initTimer = null;
  }

  private resize(width: number, height: number): void {
    if (width === this.width && height === this.height && this.metres.length === width * height) return;
    this.width = width;
    this.height = height;
    this.metres = new Float32Array(width * height);
    this.texture.dispose();
    this.texture = createMetresTexture(this.metres, width, height);
  }

  private commit(): void {
    this.frames += 1;
    this.texture.needsUpdate = true;
    this.ready = true;
  }
}

/** Metres in the red channel of a float texture, sampled nearest so every grid cell reads one texel. */
function createMetresTexture(data: Float32Array, width: number, height: number): DataTexture {
  const texture = new DataTexture(data, width, height, RedFormat, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** The dev harness route: a Kinectron constructor the page loaded from its own origin. */
function constructClient(options: KinectronDepthSourceOptions): KinectronClient | null {
  const ctor = (globalThis as { Kinectron?: unknown }).Kinectron;
  if (typeof ctor !== 'function') return null;
  try {
    const needsObject = options.port !== undefined || options.path !== undefined || options.secure !== undefined;
    const config: KinectronClientConfig = needsObject
      ? { host: options.host, port: options.port, path: options.path, secure: options.secure }
      : options.host;
    return new (ctor as KinectronConstructor)(config);
  } catch (error) {
    warnOnce('ctor-threw', `the Kinectron constructor threw: ${formatKinectronError(error)}`);
    return null;
  }
}
