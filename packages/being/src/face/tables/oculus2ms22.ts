/**
 * The 15 Oculus visemes (used by HeadTTS, Kokoro bakes and most game lip-sync tools) onto the Microsoft set.
 * Oculus merges voiced and unvoiced pairs the same way Azure does, so the mapping loses nothing visible.
 */
export const OCULUS_VISEMES = [
  'sil',
  'PP',
  'FF',
  'TH',
  'DD',
  'kk',
  'CH',
  'SS',
  'nn',
  'RR',
  'aa',
  'E',
  'I',
  'O',
  'U',
] as const;

export type OculusViseme = (typeof OCULUS_VISEMES)[number];

export const oculus2ms22: Readonly<Record<OculusViseme, number>> = {
  sil: 0,
  PP: 21,
  FF: 18,
  TH: 17,
  DD: 19,
  kk: 20,
  CH: 16,
  SS: 15,
  nn: 19,
  RR: 13,
  aa: 1,
  E: 4,
  I: 6,
  O: 8,
  U: 7,
};

const isOculusViseme = (name: string): name is OculusViseme => Object.hasOwn(oculus2ms22, name);

/** Name or Oculus index to a Microsoft id; anything unknown is silence rather than a wrong mouth shape. */
export const oculusToMs22 = (viseme: string | number): number => {
  const name = typeof viseme === 'number' ? OCULUS_VISEMES[viseme] : viseme;
  return name !== undefined && isOculusViseme(name) ? oculus2ms22[name] : 0;
};
