import { buildServer } from '../server.js';

const app = await buildServer({ logger: false });
const res = await app.inject({ method: 'GET', url: '/health' });
console.log('STATUS', res.statusCode);
console.log('BODY  ', res.body);

const dash = await app.inject({ method: 'GET', url: '/api/dashboard' });
console.log('DASHBOARD STATUS', dash.statusCode);
console.log('DASHBOARD HEAD', dash.body.slice(0, 400));

await app.close();
process.exit(0);