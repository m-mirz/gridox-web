<script lang="ts">
  import type { Linked, Schedule, Written } from '../worker/protocol';
  import Links from './Links.svelte';

  /**
   * Schedules on one time axis, a lane each. A yes/no value holds between time points as the
   * schedule's interpolation says: `previous` until the next point, `next` since the one before;
   * otherwise it is drawn at its points only. A date the schedule writes of its own, such as
   * `cancelledDateTime`, is a line across its lane; `marks` are lines across every lane. A lane
   * names what its schedule is `about`, as schedules' own names often say little (`NCP386`, `RAS`).
   */
  let {
    schedules,
    marks = [],
    onnavigate,
  }: {
    schedules: (Schedule & { about?: Linked[] })[];
    marks?: { at: string; label: string }[];
    onnavigate: (id: string) => void;
  } = $props();

  let width = $state(600);
  const LANE = 34;
  const PAD = 14;

  const ms = (text: string | null) => {
    const t = text === null ? NaN : Date.parse(text);
    return Number.isNaN(t) ? null : t;
  };

  /** What a lane draws: its points by time, and its own dates. */
  let lanes = $derived(
    schedules.map((schedule) => ({
      schedule,
      points: schedule.points
        .map((p) => ({ ...p, t: ms(p.atTime) }))
        .filter((p): p is typeof p & { t: number } => p.t !== null),
      dates: schedule.values.filter((v) => v.time).flatMap((v) => (ms(v.value) === null ? [] : [{ ...v, t: ms(v.value)! }])),
    })),
  );

  let span = $derived.by(() => {
    const times = [
      ...lanes.flatMap((l) => [...l.points.map((p) => p.t), ...l.dates.map((d) => d.t)]),
      ...marks.flatMap((m) => (ms(m.at) === null ? [] : [ms(m.at)!])),
    ];
    if (!times.length) return null;
    let [from, to] = [Math.min(...times), Math.max(...times)];
    const pad = to > from ? (to - from) * 0.06 : 3_600_000;
    return { from: from - pad, to: to + pad };
  });

  const x = (t: number) => (span ? PAD + ((t - span.from) / (span.to - span.from)) * (width - 2 * PAD) : 0);

  const DAY = 86_400_000;
  /** A time in UTC, as short as the axis's span allows. */
  const format = (t: number, long = false) => {
    const iso = new Date(t).toISOString();
    const date = iso.slice(0, 10);
    const clock = iso.slice(11, 16);
    if (long) return `${date} ${clock} UTC`;
    return span && span.to - span.from > 4 * DAY ? date : `${date.slice(5)} ${clock}`;
  };

  const MINUTE = 60_000;
  /** Tick steps, the first that leaves room for each label taken: round minutes to years. */
  const STEPS = [1, 5, 15, 30, 60, 180, 360, 720].map((m) => m * MINUTE).concat([1, 2, 7, 14, 30, 91, 182, 365].map((d) => d * DAY));

  let ticks = $derived.by(() => {
    if (!span) return [];
    const room = Math.max(2, Math.floor(width / 110));
    const step = STEPS.find((s) => (span!.to - span!.from) / s <= room) ?? (span.to - span.from) / room;
    // Days and longer from midnight UTC; months and years as close as a fixed step allows.
    const found: number[] = [];
    for (let t = Math.ceil(span.from / step) * step; t <= span.to; t += step) found.push(t);
    return found;
  });

  /** A point's yes/no value, if it has one. */
  const flag = (values: Written[]) => {
    const found = values.find((v) => v.value === 'true' || v.value === 'false');
    return found ? found.value === 'true' : null;
  };

  /** The stretches over which a yes/no value holds, by interpolation. */
  function stretches(lane: (typeof lanes)[number]) {
    if (!span) return [];
    const kind = lane.schedule.interpolation;
    const points = lane.points.filter((p) => flag(p.values) !== null);
    return points.flatMap((p, i) => {
      const on = flag(p.values)!;
      if (kind === 'previous') return [{ from: p.t, to: points[i + 1]?.t ?? span!.to, on }];
      if (kind === 'next') return [{ from: points[i - 1]?.t ?? span!.from, to: p.t, on }];
      return [];
    });
  }

  const describe = (values: Written[]) => values.map((v) => `${v.key} ${v.value}`).join(', ');

  /** Which points of a lane can carry their value as a label without running into the next one. */
  function labelled(lane: (typeof lanes)[number]): Set<string> {
    const shown = new Set<string>();
    let last = -Infinity;
    for (const p of lane.points) {
      if (flag(p.values) !== null || !p.values.length) continue;
      const at = x(p.t);
      if (at - last >= 7 * Math.max(4, p.values[0].value.length)) {
        shown.add(p.id);
        last = at;
      }
    }
    return shown;
  }

  function keyed(event: KeyboardEvent, id: string) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onnavigate(id);
    }
  }
</script>

<div class="timeline" data-testid="timeline" bind:clientWidth={width}>
  {#if !span}
    <p class="sub">Nothing to draw: these schedules have no time points.</p>
  {:else}
    <svg class="axis" {width} height="22" aria-hidden="true">
      {#each ticks as t}
        <line x1={x(t)} x2={x(t)} y1="16" y2="22" />
        <text x={x(t)} y="12" text-anchor="middle">{format(t)}</text>
      {/each}
    </svg>
    {#each lanes as lane (lane.schedule.id)}
      {@const withValue = labelled(lane)}
      <div class="lane">
        <div class="label">
          <button type="button" class="link" onclick={() => onnavigate(lane.schedule.id)}>{lane.schedule.label ?? lane.schedule.id}</button>
          <small>{lane.schedule.class}{lane.schedule.interpolation ? `, ${lane.schedule.interpolation}` : ''}</small>
          {#if lane.schedule.about?.length}<span class="sub">for</span> <Links inline links={lane.schedule.about} {onnavigate} />{/if}
        </div>
        <svg {width} height={LANE} role="group" aria-label={`Time points of ${lane.schedule.label ?? lane.schedule.id}`}>
          <line class="base" x1={PAD} x2={width - PAD} y1={LANE / 2} y2={LANE / 2} />
          {#each stretches(lane) as s}
            <rect class:on={s.on} class="stretch" x={x(s.from)} width={Math.max(1, x(s.to) - x(s.from))} y={LANE / 2 - 4} height="8" />
          {/each}
          {#each marks as m}
            {#if ms(m.at) !== null}
              <line class="mark" x1={x(ms(m.at)!)} x2={x(ms(m.at)!)} y1="0" y2={LANE}><title>{m.label}</title></line>
            {/if}
          {/each}
          {#each lane.dates as d}
            <line class="date" x1={x(d.t)} x2={x(d.t)} y1="2" y2={LANE - 2}><title>{d.key} {format(d.t, true)}</title></line>
          {/each}
          {#each lane.points as p (p.id)}
            {@const on = flag(p.values)}
            <g
              class="point"
              role="button"
              tabindex="0"
              aria-label={`${format(p.t, true)}: ${describe(p.values)}`}
              onclick={() => onnavigate(p.id)}
              onkeydown={(e) => keyed(e, p.id)}
            >
              <title>{format(p.t, true)}: {describe(p.values)}</title>
              <circle cx={x(p.t)} cy={LANE / 2} r="5" class:on={on === true} class:off={on === false} />
              {#if withValue.has(p.id)}
                <text x={x(p.t)} y={LANE / 2 - 8} text-anchor="middle">{p.values[0].value}</text>
              {/if}
            </g>
          {/each}
        </svg>
        <ol class="points">
          {#each lane.schedule.points as p (p.id)}
            <li><time datetime={p.atTime ?? undefined}>{p.atTime ?? 'no atTime'}</time> {describe(p.values)}</li>
          {/each}
          {#each lane.dates as d}
            <li class="dated">{d.key} <time datetime={d.value}>{d.value}</time></li>
          {/each}
        </ol>
      </div>
    {/each}
    <p class="sub legend">
      <span class="key on"></span> active, enabled or available
      <span class="key off"></span> not
      <span class="key date"></span> a date of the schedule's own
      {#if marks.length}<span class="key mark"></span> exclusive actions active together{/if}
      · Times in UTC.
    </p>
  {/if}
</div>

<style>
  /* The lanes take their width from the timeline's, measured after a resize: until then they
     must not widen the page. */
  .timeline {
    min-width: 0;
    margin: 0.5rem 0;
    overflow: hidden;
  }

  svg {
    display: block;
    max-width: 100%;
  }

  .axis text,
  .point text {
    fill: var(--muted);
    font-size: 0.7rem;
  }

  .axis line,
  .base {
    stroke: var(--line);
  }

  .lane + .lane {
    margin-top: 0.4rem;
    padding-top: 0.4rem;
    border-top: 1px solid var(--line);
  }

  .label {
    overflow-wrap: anywhere;
  }

  .label small,
  .sub {
    color: var(--muted);
  }

  .link {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }

  .stretch {
    fill: var(--line);
  }

  .stretch.on {
    fill: var(--accent);
    opacity: 0.6;
  }

  circle {
    fill: var(--muted);
    stroke: var(--bg);
    stroke-width: 1.5;
  }

  circle.on {
    fill: var(--accent);
  }

  circle.off {
    fill: var(--bg);
    stroke: var(--muted);
  }

  .point {
    cursor: pointer;
  }

  .point:focus-visible {
    outline: 2px solid var(--focus);
  }

  .date {
    stroke: var(--violation);
    stroke-width: 2;
    stroke-dasharray: 3 2;
  }

  .mark {
    stroke: var(--warn);
    stroke-width: 6;
    opacity: 0.35;
  }

  .points {
    display: flex;
    flex-wrap: wrap;
    gap: 0 1rem;
    margin: 0.2rem 0 0;
    padding: 0;
    list-style: none;
    color: var(--muted);
    font-size: 0.8rem;
  }

  .legend {
    font-size: 0.8rem;
  }

  .key {
    display: inline-block;
    width: 0.8rem;
    height: 0.5rem;
    margin-left: 0.5rem;
    background: var(--line);
  }

  .key.on {
    background: var(--accent);
  }

  .key.date {
    width: 2px;
    height: 0.8rem;
    background: var(--violation);
  }

  .key.mark {
    background: var(--warn);
    opacity: 0.5;
  }
</style>
