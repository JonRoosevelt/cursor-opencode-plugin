import { loadConfig } from "./config/config.js";
import { syncOpenCodeModels } from "./opencode/syncModels.js";
import { createServer } from "./server/createServer.js";

const start = async (): Promise<void> => {
  const config = loadConfig();
  const server = createServer({ config });

  try {
    await server.listen({
      port: config.port,
      host: config.host
    });
  } catch (error) {
    server.log.error({ error }, "failed to start adapter");
    process.exit(1);
  }

  // Best-effort: sync cursor-agent models into opencode.json so OpenCode's
  // model picker shows the full list. Failures are logged but never fatal.
  syncOpenCodeModels(config, {
    info: (msg) => server.log.info(msg),
    warn: (msg) => server.log.warn(msg)
  }).catch((err: unknown) => {
    server.log.warn({ err }, "syncModels: unexpected error");
  });
};

await start();
