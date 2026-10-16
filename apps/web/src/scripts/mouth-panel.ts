/**
 * The Mouth panel of the kinect harness (pages/dev/kinect.astro, development only): tune the mouth shape of each of
 * the 22 visemes live. Pick a sound, hold its shape to judge it still, move the sliders for the ARKit blendshapes its
 * recipe uses, play a tour stop with the recipes as they stand, and copy all 22 back as JSON for
 * packages/being/src/face/tables/mouthShapes.ts. Left and right shapes move together.
 */
import type { BeingHandle, MouthRecipe, TourScript, TourStop } from '@emersa/being';

/** The 22 Microsoft visemes, with words that show them. */
const SOUNDS = [
  'silence',
  'ae: cat, about, cup',
  'aa: father',
  'ao: law, dog',
  'eh: bed, book',
  'er: bird',
  'iy: see, sit, yes',
  'uw: too, we',
  'ow: go',
  'aw: how',
  'oy: toy',
  'ay: my',
  'h: hat',
  'r: red',
  'l: let',
  's: see, zoo',
  'sh: she, chin, joy',
  'th: the, thin',
  'f: fat, van',
  'd: do, to, no',
  'k: cat, go, sing',
  'p: pat, bat, mat',
] as const;

/** The sliders: one ARKit shape, or a left and right pair moved together. */
const SHAPES: ReadonlyArray<readonly [label: string, names: readonly string[]]> = [
  ['Jaw open', ['jawOpen']],
  ['Funnel', ['mouthFunnel']],
  ['Pucker', ['mouthPucker']],
  ['Press', ['mouthPressLeft', 'mouthPressRight']],
  ['Close', ['mouthClose']],
  ['Roll lower lip', ['mouthRollLower']],
  ['Roll upper lip', ['mouthRollUpper']],
  ['Stretch', ['mouthStretchLeft', 'mouthStretchRight']],
  ['Smile', ['mouthSmileLeft', 'mouthSmileRight']],
  ['Upper lip up', ['mouthUpperUpLeft', 'mouthUpperUpRight']],
  ['Lower lip down', ['mouthLowerDownLeft', 'mouthLowerDownRight']],
  ['Shrug upper lip', ['mouthShrugUpper']],
  ['Shrug lower lip', ['mouthShrugLower']],
  ['Tongue out', ['tongueOut']],
];

export function bindMouthPanel(host: HTMLElement, handle: BeingHandle, defaults: readonly MouthRecipe[]): void {
  const panel = host.querySelector<HTMLElement>('[data-mouth]');
  if (!panel) return;
  const recipes: Array<Record<string, number>> = defaults.map((recipe) => ({ ...recipe }));
  const sound = panel.querySelector<HTMLSelectElement>('[data-mouth-sound]');
  const hold = panel.querySelector<HTMLInputElement>('[data-mouth-hold]');
  const close = panel.querySelector<HTMLInputElement>('[data-mouth-close]');
  const sliders = panel.querySelector<HTMLElement>('[data-mouth-sliders]');
  const stop = panel.querySelector<HTMLSelectElement>('[data-mouth-stop]');
  const play = panel.querySelector<HTMLButtonElement>('[data-mouth-play]');
  const copy = panel.querySelector<HTMLButtonElement>('[data-mouth-copy]');
  const out = panel.querySelector<HTMLElement>('[data-mouth-status]');
  if (!sound || !hold || !sliders) return;
  const say = (text: string): void => {
    if (out) out.textContent = text;
  };

  for (const [index, label] of SOUNDS.entries()) sound.append(new Option(`${index} ${label}`, String(index)));
  sound.value = '21';
  const viseme = (): number => Number(sound.value);

  const inputs = SHAPES.map(([label, names]) => {
    const field = document.createElement('label');
    field.className = 'field range';
    const name = document.createElement('span');
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    const value = document.createElement('output');
    value.className = 'num';
    field.append(name, input, value);
    sliders.append(field);
    input.addEventListener('input', () => {
      const recipe = recipes[viseme()] ?? {};
      const amount = Number(input.value);
      for (const shape of names) {
        if (amount > 0) recipe[shape] = amount;
        else delete recipe[shape];
      }
      value.textContent = amount.toFixed(2);
      handle.face.setMouthRecipe(viseme(), recipe);
    });
    return { input, value, names };
  });

  const show = (): void => {
    const recipe = recipes[viseme()] ?? {};
    for (const { input, value, names } of inputs) {
      const amount = Math.max(...names.map((shape) => recipe[shape] ?? 0));
      input.value = String(amount);
      value.textContent = amount.toFixed(2);
    }
    handle.face.holdViseme(hold.checked ? viseme() : null);
  };
  sound.addEventListener('change', show);
  hold.addEventListener('change', show);
  close?.addEventListener('change', () => handle.setFraming(close.checked ? 'portrait' : 'bust'));
  show();

  // The tour's stops with their baked clips, played with the recipes as they stand.
  const stops: TourStop[] = [];
  void fetch('/tour/script.json')
    .then((response) => response.json() as Promise<TourScript>)
    .then((script) => {
      for (const item of script.stops) {
        stops.push(item);
        stop?.append(new Option(item.id, String(stops.length - 1)));
      }
    })
    .catch(() => say('The tour script did not load.'));
  play?.addEventListener('click', () => {
    const item = stops[Number(stop?.value ?? 0)];
    if (!item) return;
    hold.checked = false;
    handle.face.holdViseme(null);
    handle.stopSpeaking();
    void handle.speak({ text: item.text, ...(item.voice ? { clip: item.voice } : {}) });
  });

  copy?.addEventListener('click', () => {
    const json = JSON.stringify(recipes, null, 2);
    navigator.clipboard.writeText(json).then(
      () => say('Copied all 22 recipes as JSON.'),
      () => {
        console.log(json);
        say('The clipboard is not available; the JSON is in the console.');
      },
    );
  });
}
