import type {
  BuildingBlocks,
  ImageStatus,
  ProjectChanges,
  ProjectRecord,
  ProjectRepository,
} from '../db/projects.ts';
import { projectImageTag } from '../docker/labels.ts';
import { shortId } from '../ids.ts';
import type { SecretCipher } from '../secrets/cipher.ts';

export interface CreateProjectInput {
  name: string;
  repoUrl: string;
  repoBranch?: string | undefined;
  /** Encrypted before it is stored; the plaintext never leaves this module
   *  except on its way into a container. */
  gitToken?: string | undefined;
  buildingBlocks?: Partial<BuildingBlocks> | undefined;
}

export interface UpdateProjectInput {
  name?: string | undefined;
  repoUrl?: string | undefined;
  repoBranch?: string | null | undefined;
  /** Left out the stored PAT stays, `null` removes it, a string replaces it. */
  gitToken?: string | null | undefined;
  buildingBlocks?: Partial<BuildingBlocks> | undefined;
}

/** The project's image, as the API shows it. Without the log -- that one can be
 *  megabytes and has its own endpoint. */
export interface ProjectImageView {
  /** The tag, whether or not it has been built yet. Derived from the id, so it
   *  is stable across renames. */
  tag: string;
  status: ImageStatus;
  builtAt: string | null;
}

/** What the API returns. No token field on purpose -- only whether one is set. */
export interface ProjectView {
  id: string;
  name: string;
  repoUrl: string;
  repoBranch: string | null;
  buildingBlocks: BuildingBlocks;
  image: ProjectImageView;
  hasGitToken: boolean;
  /** How many instances point at this project -- what the UI warns with and the
   *  delete refuses over. */
  instanceCount: number;
  createdAt: string;
  updatedAt: string;
}

/** The build log of one project, for the endpoint that hands it out. */
export interface ProjectBuildLog {
  status: ImageStatus;
  builtAt: string | null;
  /** Empty rather than null: a caller printing this wants a string. */
  log: string;
}

/** Everything an instance needs from its project, PAT included. The only place
 *  a decrypted token leaves this module. */
export interface ProjectTemplate {
  id: string;
  repoUrl: string;
  repoBranch: string | null;
  gitToken: string | undefined;
  /** The image the container is started from. */
  image: string;
  /** Whether that image exists yet. An instance cannot start before it does --
   *  there is no fallback to installing at container start. */
  imageStatus: ImageStatus;
}

/** Everything the builder needs to turn a project into an image. */
export interface ProjectBuildSpec {
  id: string;
  tag: string;
  buildingBlocks: BuildingBlocks;
}

export class ProjectNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`project '${id}' does not exist`);
    this.name = 'ProjectNotFoundError';
  }
}

export class ProjectNameTakenError extends Error {
  constructor(readonly projectName: string) {
    super(`a project named '${projectName}' already exists`);
    this.name = 'ProjectNameTakenError';
  }
}

/** The project exists but its image does not -- not built yet, still building,
 *  or the build failed. Starting an instance is pointless until it is there. */
export class ProjectImageNotReadyError extends Error {
  constructor(
    readonly id: string,
    readonly status: ImageStatus,
  ) {
    super(
      status === 'failed'
        ? `the image of project '${id}' failed to build -- see its build log`
        : `the image of project '${id}' is not ready yet (${status})`,
    );
    this.name = 'ProjectImageNotReadyError';
  }
}

/** Deleting a project that instances still reference would leave them without
 *  the template they were started from. */
export class ProjectInUseError extends Error {
  constructor(
    readonly id: string,
    readonly instanceCount: number,
  ) {
    super(
      `project '${id}' still has ${String(instanceCount)} instance(s) -- delete those first`,
    );
    this.name = 'ProjectInUseError';
  }
}

export interface ProjectServiceOptions {
  cipher: SecretCipher;
  generateId?: () => string;
  now?: () => Date;
}

/** better-sqlite3 reports a unique index as a plain Error; the column is in the
 *  message and nowhere else. */
function isNameTaken(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed: projects.name');
}

function differs(next: BuildingBlocks, current: BuildingBlocks): boolean {
  return next.dotnet !== current.dotnet || next.playwright !== current.playwright;
}

export class ProjectService {
  private readonly cipher: SecretCipher;
  private readonly generateId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly repository: ProjectRepository,
    options: ProjectServiceOptions,
  ) {
    this.cipher = options.cipher;
    this.generateId = options.generateId ?? shortId;
    this.now = options.now ?? (() => new Date());
  }

  create(input: CreateProjectInput): ProjectView {
    const timestamp = this.now().toISOString();
    const record: ProjectRecord = {
      id: this.generateId(),
      name: input.name,
      repoUrl: input.repoUrl,
      repoBranch: input.repoBranch ?? null,
      buildingBlocks: {
        dotnet: input.buildingBlocks?.dotnet ?? false,
        playwright: input.buildingBlocks?.playwright ?? false,
      },
      sealedGitToken: this.seal(input.gitToken),
      // Nothing is built yet, and saying so is what makes the caller start a
      // build: the route reads this status rather than being told separately.
      image: { status: 'pending', log: null, builtAt: null },
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      this.repository.insert(record);
    } catch (error) {
      if (isNameTaken(error)) throw new ProjectNameTakenError(input.name);
      throw error;
    }

    return this.view(record, 0);
  }

  list(): ProjectView[] {
    const counts = this.repository.instanceCounts();
    return this.repository.list().map((record) => this.view(record, counts.get(record.id) ?? 0));
  }

  get(id: string): ProjectView {
    return this.view(this.require(id), this.repository.countInstances(id));
  }

  update(id: string, input: UpdateProjectInput): ProjectView {
    const current = this.require(id);
    const changes: ProjectChanges = { updatedAt: this.now().toISOString() };

    if (input.name !== undefined) changes.name = input.name;
    if (input.repoUrl !== undefined) changes.repoUrl = input.repoUrl;
    if (input.repoBranch !== undefined) changes.repoBranch = input.repoBranch;
    if (input.buildingBlocks !== undefined) {
      // A PATCH that names one block must not silently clear the other.
      changes.buildingBlocks = {
        dotnet: input.buildingBlocks.dotnet ?? current.buildingBlocks.dotnet,
        playwright: input.buildingBlocks.playwright ?? current.buildingBlocks.playwright,
      };

      // Only a real change invalidates the image. Sending the same blocks again
      // -- which the UI does on every save -- must not put the project back to
      // `pending`, because that would block instance creation for a rebuild
      // nobody needs.
      if (differs(changes.buildingBlocks, current.buildingBlocks)) {
        changes.imageStatus = 'pending';
      }
    }
    if (input.gitToken !== undefined) {
      changes.sealedGitToken = input.gitToken === null ? null : this.seal(input.gitToken);
    }

    let updated: ProjectRecord | undefined;
    try {
      updated = this.repository.update(id, changes);
    } catch (error) {
      if (isNameTaken(error)) throw new ProjectNameTakenError(input.name ?? current.name);
      throw error;
    }
    if (updated === undefined) throw new ProjectNotFoundError(id);

    return this.view(updated, this.repository.countInstances(id));
  }

  delete(id: string): void {
    this.require(id);

    // Checked here rather than left to the foreign key: the count is what makes
    // the answer useful, and the message says how many are in the way.
    const instanceCount = this.repository.countInstances(id);
    if (instanceCount > 0) throw new ProjectInUseError(id, instanceCount);

    this.repository.delete(id);
  }

  /** For the instance service. Decrypts the PAT, so a project whose token no
   *  longer opens fails here rather than inside the container. */
  template(id: string): ProjectTemplate {
    const record = this.require(id);
    return {
      id: record.id,
      repoUrl: record.repoUrl,
      repoBranch: record.repoBranch,
      gitToken:
        record.sealedGitToken === null ? undefined : this.cipher.open(record.sealedGitToken),
      image: projectImageTag(record.id),
      imageStatus: record.image.status,
    };
  }

  /** What the builder needs. Separate from `template` because a build has no
   *  business decrypting a PAT. */
  buildSpec(id: string): ProjectBuildSpec {
    const record = this.require(id);
    return {
      id: record.id,
      tag: projectImageTag(record.id),
      buildingBlocks: record.buildingBlocks,
    };
  }

  /**
   * Puts the image back to `pending` -- an explicit rebuild. Also the way out of
   * `failed`, which the builder never leaves on its own so that a broken
   * Dockerfile is not retried forever.
   */
  requeueImage(id: string): ProjectView {
    this.require(id);
    this.repository.setImageState(id, 'pending', null);
    return this.get(id);
  }

  buildLog(id: string): ProjectBuildLog {
    const record = this.require(id);
    return {
      status: record.image.status,
      builtAt: record.image.builtAt,
      log: record.image.log ?? '',
    };
  }

  private require(id: string): ProjectRecord {
    const record = this.repository.get(id);
    if (record === undefined) throw new ProjectNotFoundError(id);
    return record;
  }

  /** An empty string is no token: the UI submits blank fields as empty, and
   *  storing that would look like a PAT that never works. */
  private seal(token: string | undefined): string | null {
    return token === undefined || token === '' ? null : this.cipher.seal(token);
  }

  private view(record: ProjectRecord, instanceCount: number): ProjectView {
    return {
      id: record.id,
      name: record.name,
      repoUrl: record.repoUrl,
      repoBranch: record.repoBranch,
      buildingBlocks: record.buildingBlocks,
      image: {
        tag: projectImageTag(record.id),
        status: record.image.status,
        builtAt: record.image.builtAt,
      },
      hasGitToken: record.sealedGitToken !== null,
      instanceCount,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
