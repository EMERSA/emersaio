/**
 * @emersa/being/tour: the scripted tour controller, the page adapter it drives and the action whitelist the
 * brain guardrails share with it.
 */
export {
  MAX_ACTIONS,
  type ParsedActions,
  parseAction,
  parseActions,
  SECTION_PATTERN,
  SELECTOR_PATTERN,
} from './actions.ts';
export { createNoopAdapter, type PageAdapter } from './PageAdapter.ts';
export {
  createTour,
  type TourController,
  type TourOptions,
  type TourState,
  type TourStatus,
  type TourStorage,
} from './Tour.ts';
export {
  DEFAULT_DWELL_MS,
  hasVoice,
  isTourScript,
  loadTourScript,
  parseProgress,
  stopIndex,
  TOUR_STORAGE_KEY,
  type TourProgress,
  type TourScript,
  type TourStop,
  type VoiceClip,
} from './TourScript.ts';
