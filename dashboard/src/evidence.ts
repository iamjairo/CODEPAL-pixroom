import type {
  DashboardEvent,
  DashboardTokenLane,
} from '../../src/dashboard/types.js';

export function isIdleHeadroomSample(
  event: DashboardEvent,
): boolean {
  return event.type === 'headroom.sample' &&
    event.requests.value === 0 &&
    event.tokensText.value === 0 &&
    event.tokensSent.value === 0 &&
    event.outputTokens.value === 0 &&
    event.tokensSaved.value === 0 &&
    (event.costSaved?.value ?? 0) === 0;
}

export function selectVisibleEvidenceEvents(
  events: readonly DashboardEvent[],
): readonly DashboardEvent[] {
  const hasHeadroomUsage = events.some(
    (event) => event.type === 'headroom.sample' && !isIdleHeadroomSample(event),
  );
  const latestHealthyIdleIndex = hasHeadroomUsage
    ? -1
    : events.findLastIndex(
      (event) => event.type === 'headroom.sample' && isIdleHeadroomSample(event) && event.healthy,
    );

  return events.filter(
    (event, index) => !isIdleHeadroomSample(event) || index === latestHealthyIdleIndex,
  );
}

export function selectVisibleTokenLanes(
  lanes: readonly DashboardTokenLane[],
): readonly DashboardTokenLane[] {
  return lanes.filter((lane) => lane.source !== 'headroom' ||
    lane.tokensText !== 0 ||
    lane.tokensSent !== 0 ||
    lane.tokensSaved !== 0 ||
    lane.appliedStages !== 0);
}