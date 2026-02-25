import { ScraperEngine } from '../scraper.js';
import { insertLeadDeduped } from './leadService.js';
import { createSession, updateSession } from './sessionService.js';
import { withTransaction, query } from '../db.js';
import { getAnalyzer } from '../analyzers/analyzerFactory.js';

// Per-workspace active jobs — enforces one job per workspace
const activeJobs = new Map();

export const isJobRunning = (workspaceId) => activeJobs.has(workspaceId);

export async function startScrapeJob({ workspaceId, listId, config, broadcast }) {
  if (activeJobs.has(workspaceId)) {
    throw new Error('A job is already running for this workspace');
  }

  const { rows: listRows } = await query('SELECT use_case FROM lead_lists WHERE id=$1', [listId]);
  const useCase = listRows[0]?.use_case ?? 'erp';
  const analyzer = getAnalyzer(useCase);
  const queries = analyzer.generateQueries(config);

  if (!queries.length) throw new Error('No queries generated — check sectorKeys/countryKeys');

  const sessionId = await createSession(workspaceId, listId, config, queries);
  const engine = new ScraperEngine({
    concurrency: config.concurrency ?? 5,
    minScore: config.minScore ?? 50,
    emailValidation: config.emailValidation ?? true,
    deepValidation: config.deepValidation ?? false,
    usePuppeteer: config.usePuppeteer ?? true,
    analyzer,
  });

  const counters = { leadsFound: 0, duplicatesSkipped: 0, errorsCount: 0 };
  activeJobs.set(workspaceId, { engine, sessionId, counters });

  broadcast({ type: 'job_started', sessionId, queries: queries.length });

  // Run async — do not await
  _runJob({ engine, queries, workspaceId, listId, sessionId, counters, config, broadcast, useCase })
    .finally(() => activeJobs.delete(workspaceId));

  return sessionId;
}

async function _runJob({ engine, queries, workspaceId, listId, sessionId, counters, config, broadcast, useCase }) {
  const targetLeads = config.targetLeads ?? 1000;
  try {
    for (const querySpec of queries) {
      if (engine.stopRequested || counters.leadsFound >= targetLeads) break;

      broadcast({ type: 'query_start', query: querySpec.query, sector: querySpec.sector });

      await engine.runQuery(querySpec, {
        sector: querySpec.sector,
        country: querySpec.country,
        onDomainFound: (count) => broadcast({ type: 'domains_found', count }),
        onLeadFound: async (lead) => {
          try {
            const result = await withTransaction((client) =>
              insertLeadDeduped(client, { ...lead, useCase }, workspaceId, listId)
            );
            if (result.inserted) {
              counters.leadsFound++;
              broadcast({ type: 'lead', lead: { ...lead, id: result.id, useCase } });
            } else {
              counters.duplicatesSkipped++;
            }
            // Flush session stats every 10 events
            if ((counters.leadsFound + counters.duplicatesSkipped) % 10 === 0) {
              await updateSession(sessionId, { ...counters, status: 'running' });
              broadcast({ type: 'progress', counters });
            }
          } catch (err) {
            console.error('[ScrapeService] Insert error:', err.message);
            counters.errorsCount++;
          }
        },
        onLog: (level, msg) => broadcast({ type: 'log', level, message: msg }),
        onError: () => { counters.errorsCount++; },
        onSearchProgress: (info) => broadcast({ type: 'search_progress', ...info }),
      });
    }
  } catch (err) {
    console.error('[ScrapeService] Job error:', err.message);
    await updateSession(sessionId, { ...counters, status: 'error' });
    broadcast({ type: 'job_error', error: err.message });
    return;
  }

  const finalStatus = engine.stopRequested ? 'stopped' : 'done';
  await updateSession(sessionId, { ...counters, status: finalStatus });
  broadcast({ type: 'job_done', finalStatus, counters });
}

export function stopJob(workspaceId) {
  const job = activeJobs.get(workspaceId);
  if (!job) return false;
  job.engine.requestStop();
  return true;
}

export function getJobStatus(workspaceId) {
  const job = activeJobs.get(workspaceId);
  return job ? { sessionId: job.sessionId, counters: job.counters } : null;
}
