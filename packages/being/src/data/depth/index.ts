/**
 * The depth sources of the kinect cloud (`@emersa/being/depth`): the being's own depth, a depth video, or a live
 * Kinect over Kinectron. A source is handed to createBeing() as options.depthSource or later through
 * handle.setDepthSource(); the maths the cloud uses to back-project them is exported for tests and tools. The
 * video and Kinectron sources are dev-only inputs and are exported from here alone, not from `@emersa/being`, so
 * the home page never carries them: the dev harness imports this subpath for them.
 */
export { BeingDepthSource, type BeingDepthSourceOptions, DEPTH_LAYER } from './BeingDepthSource.ts';
export { blankDepthTexture, type DepthEncoding, type DepthSource, type DepthSourceKind } from './DepthSource.ts';
export {
  azureGreyToMm,
  backProject,
  type CloudGrid,
  cameraTangents,
  DEFAULT_CLIPPING,
  type DepthClipping,
  DISPARITY_FB,
  DISPARITY_SUBPX,
  DROPOUT_HZ,
  decodeDepthProbe,
  disparityStep,
  type FovTangents,
  GREY_HIT_RANGE,
  greyToDistance,
  hash01,
  isHit,
  isJump,
  JUMP_SHARE,
  KINECT_V1_TANGENTS,
  KINECTRON_CLIPPING,
  kinectV2GreyToMm,
  MIRROR_FADE_M,
  MIRROR_FLOOR_ALPHA,
  mirrorFade,
  PERSPECTIVE_MISS,
  POINT_CSS_PX,
  PROBE_RANGE_M,
  pcg,
  perspectiveDepthToDistance,
  pointAlpha,
  pointSizePx,
  quantiseDistance,
  SCATTER_REACH_M,
  SENSOR_FACE,
  SENSOR_HZ,
  SENSOR_TANGENTS,
  type SensorKind,
  scatterFade,
  scatterFor,
  scatterTravel,
  sensorFrame,
} from './depthMath.ts';
export {
  AUTO_INIT_AFTER_MS,
  formatKinectronError,
  INIT_TIMEOUT_MS,
  KINECTRON_FRAME_SIZE,
  type KinectronClient,
  type KinectronClientConfig,
  type KinectronConstructor,
  KinectronDepthSource,
  type KinectronDepthSourceOptions,
  type KinectronFeed,
  type KinectronImageFrame,
  type KinectronKinectType,
  type KinectronRawDepthFrame,
  type KinectronRawDepthPayload,
} from './KinectronDepthSource.ts';
export { VideoDepthSource, type VideoDepthSourceOptions } from './VideoDepthSource.ts';
