import { loadConfigFromEnv } from "./config.ts";
import { createCloudServer } from "./http.ts";

const config = loadConfigFromEnv();
const cloudServer = createCloudServer(config);
const listening = await cloudServer.listen();

console.log(`cloud-server listening on ${listening.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void cloudServer.close().finally(() => {
      process.exit(0);
    });
  });
}
