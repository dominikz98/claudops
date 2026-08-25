import type {
  BuildingBlocks,
  ProjectChanges,
  ProjectRecord,
  ProjectRepository,
} from '../db/projects.ts';
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

/** What the API returns. No token field on purpose -- only whether one is set. */
export interface ProjectView {
  id: string;
  name: string;
  repoUrl: string;
  repoBranch: string | null;
  buildingBlocks: BuildingBlocks;
  hasGitToken: boolean;
  /** How many instances point at this project -- what the UI warns with and the
   *  delete refuses over. */
  instanceCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Everything an instance needs from its project, PAT included. The only place
 *  a decrypted token leaves this module. */
export interface ProjectTemplate {
  id: string;
  repoUrl: string;
  repoBranch: string | null;
  gitToken: string | undefined;
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
      hasGitToken: record.sealedGitToken !== null,
      instanceCount,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
