/**
 * The product-shot extras of the dev harness, in a module of their own so the home page never downloads or parses
 * them: createBeing() imports this only when the options ask for the ring, the ribbon or the reflection, and the
 * face look of the home page asks for none. Nothing in here is reachable from the runtime chunk otherwise.
 */
export { DataRing } from './DataRing.ts';
export { FLOOR_RADIUS_M, FloorReflection } from './FloorReflection.ts';
export { FIGURE_RIBBON, Ribbon } from './Ribbon.ts';
