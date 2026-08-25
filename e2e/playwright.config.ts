import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * The acceptance criteria of issue #5 are all browser-interactive, so they are
 * checked in a browser -- against a real server, a real Docker daemon and a
 * real container. `./run.sh` builds what this needs before calling it.
 */

const PORT = process.env.CLAUDOPS_E2E_PORT ?? '18091';
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests',
  // Serial from top to bottom: the tests share one Docker daemon and one
  // server, and the console specs deliberately build on each other.
  workers: 1,
  fullyParallel: false,
  // Pulling an image, starting a container and waiting for tmux is slower than
  // Playwright's default assumes.
  timeout: 120_000,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
  webServer: {
    // The built server, not `tsx watch` -- this is the artefact that runs on
    // the NUC. The database is thrown away with `.tmp` on every run so the
    // instance list starts empty.
    command: 'node ../server/dist/index.js',
    url: `${BASE_URL}/health`,
    // /health only answers 200 once Docker is reachable, which is exactly the
    // precondition these tests need.
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      CLAUDOPS_HOST: '127.0.0.1',
      CLAUDOPS_PORT: PORT,
      CLAUDOPS_DB: '.tmp/claudops.db',
      CLAUDOPS_BASE_IMAGE: process.env.CLAUDOPS_E2E_IMAGE ?? 'claudops-base:e2e',
      // Not docker/project: the real template installs a dotnet SDK and a
      // Chromium, which would add minutes to every run. The stub takes the same
      // build args and writes them into the image instead, which is what these
      // tests assert on -- docker/project/smoke-test.sh covers the layers.
      CLAUDOPS_PROJECT_CONTEXT: resolve(import.meta.dirname, '../docker/project-stub'),
      // A project keeps its PAT encrypted, so the server needs a key. `run.sh`
      // generates one; the fallback keeps a bare `playwright test` working and
      // is a test key, not a secret -- the database it protects is thrown away
      // with `.tmp` on every run.
      CLAUDOPS_SECRET_KEY:
        process.env.CLAUDOPS_E2E_SECRET_KEY ??
        '2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a',
      CLAUDOPS_LOG_LEVEL: 'warn',
    },
  },
});
