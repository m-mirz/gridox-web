/**
 * A panel's width, as dragged or keyed at one of its edges (`Edge.svelte`), kept in this browser.
 * `side` is the edge it is resized at: moving a right edge right widens the panel, a left edge left.
 */
export interface WidthOptions {
  /** Where it is kept in this browser. */
  key: string;
  initial: number;
  min: number;
  max: number;
  side: 'left' | 'right';
  /** How much of the window to leave to the rest of the page, at least. */
  room?: number;
}

export class Width {
  value = $state(0);

  constructor(readonly options: WidthOptions) {
    let kept = 0;
    try {
      kept = Number(localStorage.getItem(options.key));
    } catch {
      // Remembering is a convenience.
    }
    this.value = this.clamp(kept || options.initial);
  }

  get min() {
    return this.options.min;
  }

  get max() {
    return this.options.max;
  }

  clamp(width: number): number {
    const { min, max, room } = this.options;
    const most = room === undefined ? max : Math.min(max, innerWidth - room);
    return Math.round(Math.max(min, Math.min(most, width)));
  }

  set(width: number) {
    this.value = this.clamp(width);
    try {
      localStorage.setItem(this.options.key, String(this.value));
    } catch {
      // A convenience.
    }
  }

  /** Within the window again, after it changed size. */
  fit = () => {
    this.value = this.clamp(this.value);
  };

  drag = (event: PointerEvent) => {
    const handle = event.currentTarget as HTMLElement;
    const sign = this.options.side === 'right' ? 1 : -1;
    const start = this.value - sign * event.clientX;
    handle.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => this.set(start + sign * e.clientX);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };

  /** The arrow keys move the edge as they point; Home and End make it narrowest and widest. */
  keyed = (event: KeyboardEvent) => {
    const step = (event.shiftKey ? 64 : 16) * (this.options.side === 'right' ? 1 : -1);
    if (event.key === 'ArrowLeft') this.set(this.value - step);
    else if (event.key === 'ArrowRight') this.set(this.value + step);
    else if (event.key === 'Home') this.set(this.options.min);
    else if (event.key === 'End') this.set(this.options.max);
    else return;
    event.preventDefault();
  };
}
