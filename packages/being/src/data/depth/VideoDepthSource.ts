import { NearestFilter, type Texture, VideoTexture } from 'three';
import { blankDepthTexture, type DepthSource } from './DepthSource.ts';
import { type FovTangents, KINECT_V1_TANGENTS } from './depthMath.ts';

export interface VideoDepthSourceOptions {
  /** The depth camera's field of view; the first Kinect's by default, as in the three example. */
  tangents?: FovTangents;
  /** Frame size reported before the video has loaded. */
  width?: number;
  height?: number;
}

/**
 * A depth video as a source, the input of three's webgl_video_kinect example: a muted, looping <video> (same origin,
 * or served with CORS headers) sampled with nearest filtering so every grid cell reads one texel. The renderer
 * refreshes a VideoTexture by itself each frame. Brightness is linear depth across the cloud's clipping, decoded
 * as (r + g + b) / 3: the example's kinect.webm is not grey but a white-cyan-blue-black ramp from a modified
 * libfreenect viewer, and the average of the channels recovers about 768 levels of it. White is near, black far.
 */
export class VideoDepthSource implements DepthSource {
  readonly kind = 'video' as const;
  readonly encoding = 'grey' as const;
  readonly fovTangents: FovTangents;
  readonly texture: Texture;
  private readonly video: HTMLVideoElement | null;
  private readonly fallbackWidth: number;
  private readonly fallbackHeight: number;

  constructor(src: string, options: VideoDepthSourceOptions = {}) {
    this.fovTangents = options.tangents ?? KINECT_V1_TANGENTS;
    this.fallbackWidth = options.width ?? 640;
    this.fallbackHeight = options.height ?? 480;
    if (typeof document === 'undefined') {
      this.video = null;
      this.texture = blankDepthTexture();
      return;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.src = src;
    const texture = new VideoTexture(video);
    texture.minFilter = NearestFilter;
    texture.magFilter = NearestFilter;
    texture.generateMipmaps = false;
    this.video = video;
    this.texture = texture;
    // A muted video may autoplay; where it may not, play() from a gesture starts it.
    void video.play().catch(() => undefined);
  }

  get width(): number {
    return this.video?.videoWidth || this.fallbackWidth;
  }

  get height(): number {
    return this.video?.videoHeight || this.fallbackHeight;
  }

  /** HAVE_CURRENT_DATA or better: there is a frame to sample. */
  get ready(): boolean {
    return (this.video?.readyState ?? 0) >= 2;
  }

  /** Start (or restart) playback, for a page that has to do so inside a gesture. */
  play(): Promise<void> {
    return this.video ? this.video.play() : Promise.resolve();
  }

  update(): void {
    // Nothing per frame: the renderer uploads the current video frame when it samples the texture.
  }

  dispose(): void {
    this.texture.dispose();
    const video = this.video;
    if (!video) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}
