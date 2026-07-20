/**
 * In-memory Redis for tests. Every import of `../config/redis` is remapped here
 * by jest.config.js `moduleNameMapper`, so production code under test transparently
 * uses this mock and never connects to a real Redis server.
 *
 * ioredis-mock supports the commands the reservation code relies on:
 * SET ... NX EX, GET, MGET, DEL, and EVAL (the ownership-checked release).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RedisMock = require('ioredis-mock');

export const redis = new RedisMock();
export default redis;
