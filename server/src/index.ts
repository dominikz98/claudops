import { openDatabase } from './db/index.ts';
import { InstanceRepository } from './db/instances.ts';
import { DockerodeEngine } from './docker/dockerode-engine.ts';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { ActivityTracker } from './instances/activity.ts';
import { buildStatusApp } from './status/app.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.databaseFile);
  const engine = new DockerodeEngine(config.dockerSocket);

  // One tracker, two apps: the status listener writes what the containers
  // report, the API reads it into every instance view.
  const activity = new ActivityTracker();

  const app = buildApp({
    db,
    engine,
    activity,
    statusTokens: config.statusTokens,
    statusPort: config.statusPort,
    baseImage: config.baseImage,
    projectContext: config.projectContext,
    dotnetChannel: config.dotnetChannel,
    instanceEnv: config.instanceEnv,
    instanceLimits: config.instanceLimits,
    uploadLimits: config.uploadLimits,
    cipher: config.cipher,
    auth: config.auth,
    secureCookie: config.secureCookie,
    webRoot: config.webRoot,
    tmuxSession: config.tmuxSession,
    logLevel: config.logLevel,
  });

  // Said once at startup rather than only when somebody tries: a private
  // repository is the common case, and finding out at project-create time that
  // no PAT can be stored is a worse moment to learn it.
  if (!config.cipher.available) {
    app.log.warn('no CLAUDOPS_SECRET_KEY set -- projects can be created, but without a PAT');
  }

  // Docker being down is not a reason to refuse to start: /health reports it
  // and the existing instances stay listable once it comes back.
  try {
    await engine.ping();
    app.log.info('Docker Engine reachable');
  } catch (error) {
    app.log.warn({ err: error }, 'Docker Engine unreachable at startup');
  }

  /**
   * The port instance containers report to. Separate from the API's because a
   * container's egress firewall can only be opened per address and port: this
   * one carries a single route that takes a hook report and answers 204, and
   * the API's carries the login and everything behind it.
   */
  const statusApp = buildStatusApp({
    instances: new InstanceRepository(db),
    activity,
    tokens: config.statusTokens,
    logLevel: config.logLevel,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await Promise.allSettled([app.close(), statusApp.close()]);
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  await statusApp.listen({ host: config.statusHost, port: config.statusPort });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`configuration error: ${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
