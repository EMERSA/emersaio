import { ListenerSet, type SpeechIn } from '../SpeechIn.ts';

export interface TypedInOptions {
  /** The text field; Enter submits it. Optional so the shell can call submit() from its own form handling. */
  input?: HTMLInputElement | HTMLTextAreaElement;
  /** A form whose submit event should be captured instead of the Enter key. */
  form?: HTMLFormElement;
  /** Empty the field after a submission. */
  clearOnSubmit?: boolean;
}

/**
 * Speech in without speech: a text field. Always present, so every visitor can talk to the being, and the
 * only path on browsers without microphone or recognition support.
 */
export class TypedIn implements SpeechIn {
  readonly name = 'typed';
  private readonly transcripts = new ListenerSet<[string, boolean]>();
  private readonly levels = new ListenerSet<[number]>();
  private readonly input: HTMLInputElement | HTMLTextAreaElement | undefined;
  private readonly form: HTMLFormElement | undefined;
  private readonly clearOnSubmit: boolean;
  private detach: (() => void) | undefined;

  constructor(options: TypedInOptions = {}) {
    this.input = options.input;
    this.form = options.form;
    this.clearOnSubmit = options.clearOnSubmit ?? true;
  }

  start(): Promise<void> {
    if (this.detach !== undefined) return Promise.resolve();
    const { input, form } = this;
    if (form !== undefined) {
      const onSubmit = (event: Event): void => {
        event.preventDefault();
        this.submit(input?.value ?? '');
      };
      form.addEventListener('submit', onSubmit);
      this.detach = () => form.removeEventListener('submit', onSubmit);
    } else if (input !== undefined) {
      // Typed as HTMLElement so the keydown overload carries a KeyboardEvent for both field kinds.
      const field: HTMLElement = input;
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        this.submit(input.value);
      };
      field.addEventListener('keydown', onKeyDown);
      this.detach = () => field.removeEventListener('keydown', onKeyDown);
    } else {
      this.detach = () => undefined;
    }
    return Promise.resolve();
  }

  stop(): void {
    this.detach?.();
    this.detach = undefined;
  }

  /** Hand in a line as a final transcript. Blank lines are ignored and report false. */
  submit(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed === '') return false;
    if (this.clearOnSubmit && this.input !== undefined) this.input.value = '';
    this.transcripts.emit(trimmed, true);
    return true;
  }

  onTranscript(listener: (text: string, final: boolean) => void): () => void {
    return this.transcripts.add(listener);
  }

  /** Typing has no audio level; the listener is kept so the interface holds, but it never fires. */
  onLevel(listener: (level: number) => void): () => void {
    return this.levels.add(listener);
  }
}
