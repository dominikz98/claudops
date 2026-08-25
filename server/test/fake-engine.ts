import {
  DockerUnavailableError,
  ImageNotFoundError,
  type ContainerSpec,
  type ContainerSummary,
  type DockerEngine,
} from '../src/docker/engine.ts';
import { instanceIdFromLabels } from '../src/docker/labels.ts';

interface FakeContainer {
  containerId: string;
  spec: ContainerSpec;
  state: string;
}

/**
 * In-memory stand-in for the Docker Engine. Same contract as DockerodeEngine,
 * which is why the service and route tests need no daemon.
 */
export class FakeDockerEngine implements DockerEngine {
  readonly containers = new Map<string, FakeContainer>();
  readonly knownImages = new Set<string>(['claudops-base']);

  /** Set to make every call behave as if the daemon were down. */
  unavailable = false;
  /** Set to make the next runContainer fail after the row already exists. */
  failNextRun: Error | undefined;

  private sequence = 0;

  async ping(): Promise<void> {
    this.guard();
    return Promise.resolve();
  }

  async runContainer(spec: ContainerSpec): Promise<string> {
    this.guard();

    if (this.failNextRun !== undefined) {
      const error = this.failNextRun;
      this.failNextRun = undefined;
      throw error;
    }
    if (!this.knownImages.has(spec.image)) throw new ImageNotFoundError(spec.image);

    this.sequence += 1;
    const containerId = `container-${this.sequence}`;
    this.containers.set(containerId, { containerId, spec, state: 'running' });
    return Promise.resolve(containerId);
  }

  async removeContainer(containerId: string): Promise<void> {
    this.guard();
    // Missing is not an error -- delete stays idempotent.
    this.containers.delete(containerId);
    return Promise.resolve();
  }

  async listManagedContainers(): Promise<ContainerSummary[]> {
    this.guard();
    return Promise.resolve(
      [...this.containers.values()]
        .filter((container) => instanceIdFromLabels(container.spec.labels) !== undefined)
        .map((container) => ({
          containerId: container.containerId,
          instanceId: instanceIdFromLabels(container.spec.labels),
          state: container.state,
          status: `Up (${container.state})`,
        })),
    );
  }

  /** Test helpers -------------------------------------------------------- */

  specFor(instanceId: string): ContainerSpec | undefined {
    return [...this.containers.values()].find((c) => c.spec.instanceId === instanceId)?.spec;
  }

  setState(containerId: string, state: string): void {
    const container = this.containers.get(containerId);
    if (container !== undefined) container.state = state;
  }

  /** A container on the same host that claudops does not own. */
  addUnmanagedContainer(containerId: string): void {
    this.containers.set(containerId, {
      containerId,
      spec: {
        instanceId: '',
        name: containerId,
        image: 'someone-else',
        env: {},
        labels: {},
      },
      state: 'running',
    });
  }

  /** Simulate a container that vanished behind the server's back. */
  forget(containerId: string): void {
    this.containers.delete(containerId);
  }

  private guard(): void {
    if (this.unavailable) throw new DockerUnavailableError(new Error('connect ECONNREFUSED'));
  }
}
