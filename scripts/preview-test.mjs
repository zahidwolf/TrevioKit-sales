// Disposable local UI verification. Never reads .env.local or connects to Atlas.
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { spawn } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
const repl = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '8.0.15' } });
const salt = randomBytes(16).toString('hex');
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '-p', '3110', '-H', '127.0.0.1'], { env: { ...process.env, TREVIOKIT_TEST_PREVIEW: '1', MONGODB_URI: repl.getUri(), MONGODB_DB: 'disposable_ui_test', OWNER_USERNAME: 'ui-test', OWNER_PASSWORD_HASH: salt + ':' + scryptSync('Disposable-test-123!', salt, 64).toString('hex'), SESSION_SECRET: randomBytes(32).toString('hex'), APP_ORIGIN: 'http://localhost:3110' }, stdio: 'inherit' });
async function stop() { server.kill(); await repl.stop(); process.exit(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
