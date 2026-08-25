/**
 * Every resource claudops creates carries `claudops.instance=<id>`. That label
 * is what makes a complete delete and the startup reconcile of #8 possible --
 * without it an orphaned container is indistinguishable from a foreign one.
 */
export const INSTANCE_LABEL = 'claudops.instance';

export function instanceLabels(instanceId: string): Record<string, string> {
  return { [INSTANCE_LABEL]: instanceId };
}

/** Filter for "every container claudops owns", regardless of instance. */
export const managedFilter = { label: [INSTANCE_LABEL] };

/** Filter for one specific instance. */
export function instanceFilter(instanceId: string): { label: string[] } {
  return { label: [`${INSTANCE_LABEL}=${instanceId}`] };
}

export function instanceIdFromLabels(
  labels: Record<string, string> | undefined,
): string | undefined {
  const id = labels?.[INSTANCE_LABEL];
  return id === undefined || id === '' ? undefined : id;
}

/** Container name, so `docker ps` stays readable for whoever is on the NUC. */
export function containerName(instanceId: string): string {
  return `claudops-${instanceId}`;
}
