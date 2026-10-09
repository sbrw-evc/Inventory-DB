import { buildApp } from './app.js';
import { initSystem } from './system/init.js';

const port = Number(process.env.PORT ?? 8080);
await initSystem();
const app = await buildApp({ logger: true });
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
