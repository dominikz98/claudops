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

/**
 * Project images carry `claudops.project=<id>`. Same reasoning as the instance
 * label one level up: without it an image left behind by a deleted project is
 * indistinguishable from one somebody built by hand.
 */
export const PROJECT_LABEL = 'claudops.project';

export function projectLabels(projectId: string): Record<string, string> {
  return { [PROJECT_LABEL]: projectId };
}

/** Filter for "every image claudops built for a project". */
export const projectImageFilter = { label: [PROJECT_LABEL] };

/** Tag of a project's image. Keyed on the id rather than the name, so renaming
 *  a project does not orphan its image. */
export function projectImageTag(projectId: string): string {
  return `claudops-project-${projectId}`;
}
