<script lang="ts">
  import type { Width } from './resize.svelte';

  /** A panel's edge to drag, or to focus and move with the arrow keys. Its parent is positioned. */
  let { width, label }: { width: Width; label: string } = $props();
</script>

<svelte:window onresize={width.fit} />

<!-- A focusable separator is a widget in ARIA: its width changes with the arrow keys. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="resize"
  class:left={width.options.side === 'left'}
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuemin={width.min}
  aria-valuemax={width.max}
  aria-valuenow={width.value}
  tabindex="0"
  title="Drag, or use the arrow keys, to change the width"
  onpointerdown={width.drag}
  onkeydown={width.keyed}
></div>

<style>
  .resize {
    position: absolute;
    top: 0;
    right: -3px;
    bottom: 0;
    z-index: 3;
    width: 6px;
    cursor: col-resize;
    touch-action: none;
  }

  .resize.left {
    right: auto;
    left: -3px;
  }

  .resize:hover,
  .resize:focus-visible {
    background: var(--accent);
    outline: none;
    opacity: 0.5;
  }

  /* On a phone the panels are not side by side, and are not resized. */
  @media (max-width: 48rem) {
    .resize {
      display: none;
    }
  }
</style>
