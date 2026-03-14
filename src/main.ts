import { loadConfig } from "./config/config.js";
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
};

await start();
