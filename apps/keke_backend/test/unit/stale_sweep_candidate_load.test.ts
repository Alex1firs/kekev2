/**
 * The candidate load must happen inside a transaction.
 *
 * This is a regression guard with a production incident behind it. The load used
 * `SELECT ... FOR UPDATE SKIP LOCKED` built straight off the repository, and
 * TypeORM refuses a pessimistic lock outside a transaction. Every sweep threw
 * "An open transaction is required for pessimistic lock" before examining a
 * single ride, so the whole coordination policy was silently inert in production
 * while the process looked healthy and logged a clean start.
 *
 * Nothing in the existing suites caught it, because they all test the policy as a
 * pure function and never execute the query path. These tests hold the seam that
 * broke: the query is built from a transactional manager, and it still asks for
 * the skip-locked read the sweeper's concurrency story depends on.
 */
import { loadStaleRideConfig } from '../../src/config/stale_ride_config';
import { AppDataSource } from '../../src/config/data_source';
import { StaleRideSweeper } from '../../src/services/stale_ride_sweeper';

/** A query builder that records what the sweeper asked of it. */
const recordingQueryBuilder = () => {
    const calls: { lock?: string; onLocked?: string; limit?: number } = {};
    const qb: Record<string, unknown> = {};
    for (const method of ['where', 'andWhere', 'orderBy']) {
        qb[method] = jest.fn(() => qb);
    }
    qb.limit = jest.fn((n: number) => { calls.limit = n; return qb; });
    qb.setLock = jest.fn((mode: string) => { calls.lock = mode; return qb; });
    qb.setOnLocked = jest.fn((mode: string) => { calls.onLocked = mode; return qb; });
    qb.getMany = jest.fn(async () => []);
    return { qb, calls };
};

describe('the sweep loads its candidates inside a transaction', () => {
    const config = { ...loadStaleRideConfig(), batchSize: 7 };
    const now = new Date('2026-07-26T06:00:00Z');

    // loadCandidates is private, and deliberately so — this reaches past that to
    // pin the behaviour rather than the API.
    const loadCandidates = (cfg = config) =>
        (StaleRideSweeper as unknown as {
            loadCandidates(c: typeof config, n: Date): Promise<unknown[]>;
        }).loadCandidates(cfg, now);

    afterEach(() => jest.restoreAllMocks());

    it('builds the query from the transactional manager, not the bare repository', async () => {
        const { qb } = recordingQueryBuilder();
        const managerRepo = { createQueryBuilder: jest.fn(() => qb) };

        const transaction = jest.spyOn(AppDataSource, 'transaction')
            .mockImplementation(((run: (m: unknown) => unknown) =>
                Promise.resolve(run({ getRepository: () => managerRepo }))) as never);

        // If the sweeper ever reaches for the bare repository again, this fails
        // loudly here rather than at 90-second intervals in production.
        const bareRepository = jest.spyOn(AppDataSource, 'getRepository')
            .mockImplementation(() => {
                throw new Error('loadCandidates must not use the non-transactional repository');
            });

        await expect(loadCandidates()).resolves.toEqual([]);

        expect(transaction).toHaveBeenCalledTimes(1);
        expect(managerRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
        expect(bareRepository).not.toHaveBeenCalled();
    });

    it('still asks for the skip-locked read the concurrency story depends on', async () => {
        const { qb, calls } = recordingQueryBuilder();
        jest.spyOn(AppDataSource, 'transaction')
            .mockImplementation(((run: (m: unknown) => unknown) =>
                Promise.resolve(run({ getRepository: () => ({ createQueryBuilder: () => qb }) }))) as never);

        await loadCandidates();

        // Waiting on a locked row instead of skipping it would let one row a live
        // transaction is holding stall the entire pass.
        expect(calls.lock).toBe('pessimistic_write');
        expect(calls.onLocked).toBe('skip_locked');
        expect(calls.limit).toBe(7);
    });

    it('surfaces a failing load instead of reporting an empty sweep', async () => {
        jest.spyOn(AppDataSource, 'transaction')
            .mockRejectedValue(new Error('An open transaction is required for pessimistic lock') as never);

        // The distinction that matters: "no rides were actionable" and "the query
        // died" must never look the same to a caller.
        await expect(loadCandidates()).rejects.toThrow(/open transaction/);
    });
});
