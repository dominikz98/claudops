import { openDatabase } from './db/index.ts';
import { DockerodeEngine } from './docker/dockerode-engine.ts';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.databaseFile);
  const engine = new DockerodeEngine(config.dockerSocket);

  const app = buildApp({
    db,
    engine,
    baseImage: config.baseImage,
    instanceEnv: config.instanceEnv,
    cipher: config.cipher,
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

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`configuration error: ${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
