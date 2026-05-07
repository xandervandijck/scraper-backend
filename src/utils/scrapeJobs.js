'use strict';

const { ScraperEngine } = require('../lib/scraper.js');
const { getAnalyzer } = require('../lib/analyzers/analyzerFactory.js');
const { createOne, findMany, findOne, requireList, updateOne } = require('./store.js');
const wsServer = require('./wsServer.js');

const activeJobs = new Map();

function normalizeDomain(raw) {
  try {
    const url = raw?.startsWith('http') ? raw : `https://${raw}`;
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase().trim();
  } catch {
    return raw?.toLowerCase().replace(/^www\./, '').trim() ?? null;
  }
}

function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function leadToData(lead, workspaceId, listId, useCase) {
  const domain = normalizeDomain(lead.domain ?? lead.website);
  const analysisData = lead.analysisData ?? {};

  return {
    workspace_id: workspaceId,
    list_id: listId,
    company_name: lead.companyName ?? null,
    domain,
    website: lead.website ?? null,
    email: lead.email ?? null,
    email_valid: lead.emailValid ?? null,
    email_validation_score: lead.emailValidationScore ?? null,
    email_validation_reason: lead.emailValidationReason ?? null,
    score: lead.score ?? analysisData.score ?? null,
    erp_score: useCase === 'erp' ? (lead.score ?? null) : null,
    erp_breakdown: useCase === 'erp' ? (analysisData.breakdown ?? null) : null,
    use_case: useCase,
    analysis_data: analysisData,
    sector: lead.sector ?? null,
    country: lead.country ?? null,
    city: lead.city ?? null,
    phone: lead.phone ?? null,
    address: lead.address ?? null,
    description: (lead.description ?? '').slice(0, 500),
    source: 'puppeteer',
    category: lead.category ?? lead.sector ?? null,
    unique_identifier: lead.uniqueIdentifier ?? null,
    all_emails: jsonArray(lead.allEmails),
    has_vacancies: lead.hasVacancies ?? null,
    job_titles: jsonArray(lead.jobTitles),
    vacancy_links: jsonArray(lead.vacancyLinks),
    signals: lead.signals ?? analysisData.signals ?? {},
    lead_status: lead.status ?? analysisData.status ?? 'nieuw',
    assessment: lead.assessment ?? analysisData.assessment ?? null,
    assessment_reason: lead.assessmentReason ?? analysisData.assessmentReason ?? null,
  };
}

async function insertLeadDeduped(lead, workspaceId, listId, useCase) {
  const data = leadToData(lead, workspaceId, listId, useCase);
  if (!data.domain) return { inserted: false, reason: 'invalid_domain' };

  const domainDuplicate = await findOne('lead', {
    filters: {
      workspace_id: { $eq: workspaceId },
      domain: { $eq: data.domain },
    },
  });
  if (domainDuplicate) return { inserted: false, reason: 'duplicate' };

  if (data.unique_identifier) {
    const identifierDuplicate = await findOne('lead', {
      filters: {
        workspace_id: { $eq: workspaceId },
        unique_identifier: { $eq: data.unique_identifier },
      },
    });
    if (identifierDuplicate) return { inserted: false, reason: 'duplicate' };
  }

  const inserted = await createOne('lead', data);
  return { inserted: true, id: inserted.id };
}

function hasVacancySignal(lead) {
  return Boolean(
    lead.hasVacancies ||
      lead.analysisData?.hasVacancies ||
      (Array.isArray(lead.jobTitles) && lead.jobTitles.length > 0) ||
      (Array.isArray(lead.vacancyLinks) && lead.vacancyLinks.length > 0) ||
      (Array.isArray(lead.analysisData?.jobTitles) && lead.analysisData.jobTitles.length > 0) ||
      (Array.isArray(lead.analysisData?.vacancyTitles) && lead.analysisData.vacancyTitles.length > 0) ||
      (Array.isArray(lead.analysisData?.vacancyLinks) && lead.analysisData.vacancyLinks.length > 0) ||
      lead.analysisData?.jobPageUrl,
  );
}

function requiresVacancySignal(useCase, config) {
  return config.requireVacancySignal ?? ['prospecting', 'recruitment'].includes(useCase);
}

function isJobRunning(workspaceId) {
  return activeJobs.has(workspaceId);
}

function getJobStatus(workspaceId) {
  const job = activeJobs.get(workspaceId);
  return job ? { running: true, sessionId: job.sessionId, counters: job.counters } : { running: false };
}

function stopJob(workspaceId) {
  const job = activeJobs.get(workspaceId);
  if (!job) return false;
  job.engine.requestStop();
  return true;
}

function forceStopJob(workspaceId) {
  const job = activeJobs.get(workspaceId);
  if (job) job.engine.requestStop();
  activeJobs.delete(workspaceId);
}

function queryKey(querySpec) {
  return String(querySpec.query ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function cleanText(value, max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function buildProspectingContinuationQueries(config, round) {
  const searchTerm = cleanText(config.searchTerm ?? config.query ?? config.keyword ?? config.sector ?? '', 80);
  const location = cleanText(config.location ?? config.city ?? config.region ?? '', 80);
  const country = cleanText(config.country ?? config.countryKey ?? 'NL', 40).toUpperCase();
  if (!searchTerm || !location) return [];

  const tld = country === 'BE' ? 'site:.be' : country === 'DE' ? 'site:.de' : 'site:.nl';
  const locale = country === 'BE' ? 'België' : country === 'DE' ? 'Deutschland' : 'Nederland';
  const base = `${searchTerm} ${location}`;
  const batches = [
    [
      `${base} vacatures ${tld}`,
      `${base} "werken bij" ${tld}`,
      `${base} personeel gezocht ${tld}`,
    ],
    [
      `${base} jobs ${tld}`,
      `${base} careers ${tld}`,
      `${base} openstaande vacatures ${tld}`,
    ],
    [
      `${base} contactgegevens ${tld}`,
      `${base} e-mail telefoon ${tld}`,
      `${base} officiële website ${tld}`,
    ],
    [
      `${base} "contact" "${location}" ${tld}`,
      `${base} "over ons" "${location}" ${tld}`,
      `${base} adres telefoon ${locale} ${tld}`,
    ],
    [
      `${base} "info@" ${tld}`,
      `${base} "mailto:" ${tld}`,
      `${base} bedrijven ${location} ${tld}`,
    ],
    [
      `${searchTerm} in de buurt van ${location} ${tld}`,
      `${searchTerm} regio ${location} contact ${tld}`,
      `${searchTerm} omgeving ${location} website ${tld}`,
    ],
  ];

  return (batches[(round - 1) % batches.length] ?? []).map((query) => ({
    query,
    sector: searchTerm,
    sectorKey: searchTerm.toLowerCase().replace(/\s+/g, '_'),
    country: location,
    countryKey: country,
  }));
}

function buildContinuationQueries({ config, useCase, baseQueries, round }) {
  if (useCase === 'prospecting') {
    return buildProspectingContinuationQueries(config, round);
  }

  const modifiers = [
    'contact email',
    'officiële website',
    'bedrijf telefoon',
    'over ons contact',
    'info mail',
  ];
  const modifier = modifiers[(round - 1) % modifiers.length];
  return baseQueries.map((querySpec) => ({
    ...querySpec,
    query: `${querySpec.query} ${modifier}`,
  }));
}

async function startScrapeJob({ workspaceId, listId, config }) {
  if (activeJobs.has(workspaceId)) {
    throw new Error('A job is already running for this workspace');
  }

  const list = await requireList(listId, workspaceId);
  const useCase = list.use_case ?? 'erp';
  const analyzer = getAnalyzer(useCase);
  const queries = analyzer.generateQueries(config);
  if (!queries.length) throw new Error('No queries generated');

  const session = await createOne('session', {
    workspace_id: workspaceId,
    list_id: listId,
    status: 'running',
    config,
    queries_used: queries,
    leads_found: 0,
    duplicates_skipped: 0,
    errors_count: 0,
  });

  const engine = new ScraperEngine({
    concurrency: config.concurrency ?? 5,
    minScore: config.minScore ?? (useCase === 'prospecting' ? 0 : useCase === 'recruitment' ? 30 : 50),
    emailValidation: config.emailValidation ?? (useCase === 'prospecting' ? false : true),
    deepValidation: config.deepValidation ?? false,
    usePuppeteer: config.usePuppeteer ?? true,
    searchResultsPerQuery: config.searchResultsPerQuery ?? 30,
    analyzer,
  });

  const counters = { leadsFound: 0, duplicatesSkipped: 0, errorsCount: 0 };
  activeJobs.set(workspaceId, { engine, sessionId: session.id, counters });

  wsServer.broadcast(workspaceId, 'job_started', { sessionId: session.id, queries: queries.length });

  runJob({ engine, queries, workspaceId, listId, sessionId: session.id, counters, config, useCase })
    .finally(() => activeJobs.delete(workspaceId));

  return { sessionId: session.id, queries: queries.length };
}

async function flushSession(sessionId, counters, status = 'running') {
  await updateOne('session', sessionId, {
    leads_found: counters.leadsFound,
    duplicates_skipped: counters.duplicatesSkipped,
    errors_count: counters.errorsCount,
    status,
    finished_at: ['done', 'stopped', 'error'].includes(status) ? new Date().toISOString() : null,
  });
}

async function runJob({ engine, queries, workspaceId, listId, sessionId, counters, config, useCase }) {
  const targetLeads = config.targetLeads ?? 1000;
  const continueUntilTarget = config.continueUntilTarget ?? true;
  const maxQueries = config.maxQueries ?? Math.max(queries.length, targetLeads * 5, 250);
  const maxStalledQueries = config.maxStalledQueries ?? 50;
  const queryQueue = [...queries];
  const baseQueries = [...queries];
  const allQueriesUsed = [...queries];
  const seenQueries = new Set(queryQueue.map(queryKey));
  let continuationRound = 0;
  let stalledQueries = 0;
  const requireVacancySignal = requiresVacancySignal(useCase, config);

  try {
    while (!engine.stopRequested && counters.leadsFound < targetLeads) {
      if (!queryQueue.length) {
        if (!continueUntilTarget || seenQueries.size >= maxQueries || stalledQueries >= maxStalledQueries) break;

        continuationRound++;
        const before = queryQueue.length;
        for (const nextQuery of buildContinuationQueries({ config, useCase, baseQueries, round: continuationRound })) {
          const key = queryKey(nextQuery);
          if (!key || seenQueries.has(key) || seenQueries.size >= maxQueries) continue;
          seenQueries.add(key);
          queryQueue.push(nextQuery);
          allQueriesUsed.push(nextQuery);
        }

        if (queryQueue.length === before) break;
        await updateOne('session', sessionId, { queries_used: allQueriesUsed });
        wsServer.broadcast(workspaceId, 'log', {
          level: 'info',
          message: `Extra zoekronde ${continuationRound}: ${queryQueue.length} nieuwe queries toegevoegd`,
        });
      }

      const querySpec = queryQueue.shift();
      const leadsBeforeQuery = counters.leadsFound;

      wsServer.broadcast(workspaceId, 'query_start', { sector: querySpec.sector, country: querySpec.country });

      await engine.runQuery(querySpec, {
        sector: querySpec.sector,
        country: querySpec.country,
        onDomainFound: (count) => {
          wsServer.broadcast(workspaceId, 'domains_found', { count });
        },
        onSearchProgress: (info) => {
          wsServer.broadcast(workspaceId, 'search_progress', info);
        },
        onLeadFound: async (lead) => {
          try {
            if (requireVacancySignal && !hasVacancySignal(lead)) {
              counters.duplicatesSkipped++;
              wsServer.broadcast(workspaceId, 'log', {
                level: 'info',
                message: `Skip ${lead.domain ?? lead.website ?? lead.companyName}: geen vacature of functietitel gevonden`,
              });
              return;
            }

            const result = await insertLeadDeduped({ ...lead, useCase }, workspaceId, listId, useCase);
            if (result.inserted) {
              counters.leadsFound++;
              wsServer.broadcast(workspaceId, 'lead', {
                sessionId,
                lead: {
                  companyName: lead.companyName,
                  domain: lead.domain,
                  email: lead.email,
                  score: lead.score,
                  sector: lead.sector,
                  country: lead.country,
                  city: lead.city ?? null,
                },
                counters: { ...counters },
              });
            } else {
              counters.duplicatesSkipped++;
            }

            if ((counters.leadsFound + counters.duplicatesSkipped) % 10 === 0) {
              await flushSession(sessionId, counters);
              wsServer.broadcast(workspaceId, 'progress', { sessionId, counters: { ...counters } });
            }
          } catch (err) {
            strapi.log.error(`[Scrape] Insert failed: ${err.message}`);
            counters.errorsCount++;
          }
        },
        onError: () => {
          counters.errorsCount++;
          wsServer.broadcast(workspaceId, 'progress', { sessionId, counters: { ...counters } });
        },
        onLog: (level, message) => {
          strapi.log[level === 'success' ? 'info' : level]?.(message);
          wsServer.broadcast(workspaceId, 'log', { level, message });
        },
      });

      if (counters.leadsFound === leadsBeforeQuery) {
        stalledQueries++;
      } else {
        stalledQueries = 0;
      }
    }
  } catch (err) {
    strapi.log.error(`[Scrape] Job failed: ${err.message}`);
    await flushSession(sessionId, counters, 'error');
    wsServer.broadcast(workspaceId, 'job_error', { sessionId, message: err.message });
    return;
  }

  const finalStatus = engine.stopRequested ? 'stopped' : 'done';
  await flushSession(sessionId, counters, finalStatus);
  wsServer.broadcast(workspaceId, 'job_done', { sessionId, status: finalStatus, counters: { ...counters } });
}

async function getSessions(workspaceId, listId = null) {
  const filters = { workspace_id: { $eq: workspaceId } };
  if (listId) filters.list_id = { $eq: listId };
  const sessions = await findMany('session', {
    filters,
    sort: ['createdAt:desc'],
    pagination: { pageSize: 50 },
  });
  const lists = await findMany('list', {
    filters: { workspace_id: { $eq: workspaceId } },
    fields: ['name'],
    pagination: { pageSize: 50000 },
  });
  const names = Object.fromEntries(lists.map((list) => [list.id, list.name]));
  return sessions.map((session) => ({ ...session, list_name: names[session.list_id] ?? null }));
}

module.exports = {
  isJobRunning,
  getJobStatus,
  stopJob,
  forceStopJob,
  startScrapeJob,
  getSessions,
};
