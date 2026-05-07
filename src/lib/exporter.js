'use strict';

/**
 * Exporter — CSV and Excel (xlsx) export for leads.
 */

const { createObjectCsvWriter } = require('csv-writer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = './output';

const COLUMNS = [
  { id: 'companyName', title: 'Bedrijfsnaam' },
  { id: 'category', title: 'Categorie / Type' },
  { id: 'website', title: 'Website' },
  { id: 'email', title: 'Email' },
  { id: 'allEmails', title: 'Alle Emails' },
  { id: 'phone', title: 'Telefoon' },
  { id: 'address', title: 'Adres' },
  { id: 'city', title: 'Stad' },
  { id: 'hasVacancies', title: 'Vacatures' },
  { id: 'jobTitles', title: 'Functietitels' },
  { id: 'vacancyLinks', title: 'Vacature Links' },
  { id: 'leadStatus', title: 'Status' },
  { id: 'assessment', title: 'Beoordeling' },
  { id: 'assessmentReason', title: 'Beoordeling Reden' },
  { id: 'signals', title: 'Signalen' },
  { id: 'sector', title: 'Sector' },
  { id: 'country', title: 'Land' },
  { id: 'score', title: 'Score' },
  { id: 'description', title: 'Omschrijving' },
  { id: 'uniqueIdentifier', title: 'Unieke ID' },
  { id: 'foundAt', title: 'Gevonden Op' },
];

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function flattenLead(lead) {
  const analysisData = lead.analysisData ?? lead.analysis_data ?? {};
  const allEmails = lead.allEmails ?? lead.all_emails ?? [];
  const jobTitles = lead.jobTitles ?? lead.job_titles ?? analysisData.jobTitles ?? analysisData.vacancyTitles ?? [];
  const vacancyLinks = lead.vacancyLinks ?? lead.vacancy_links ?? analysisData.vacancyLinks ?? [analysisData.jobPageUrl].filter(Boolean);
  const signals = lead.signals ?? analysisData.signals ?? {};
  const score = lead.score ?? lead.erpScore ?? lead.erp_score ?? analysisData.score ?? 0;

  return {
    companyName: lead.companyName ?? lead.company_name ?? '',
    category: lead.category ?? lead.sector ?? '',
    website: lead.website ?? '',
    email: lead.email ?? '',
    allEmails: Array.isArray(allEmails) ? allEmails.join(', ') : '',
    phone: lead.phone ?? '',
    address: lead.address ?? '',
    city: lead.city ?? '',
    hasVacancies: (lead.hasVacancies ?? lead.has_vacancies ?? analysisData.hasVacancies) ? 'Ja' : 'Nee',
    jobTitles: Array.isArray(jobTitles) ? jobTitles.join(' | ') : '',
    vacancyLinks: Array.isArray(vacancyLinks) ? vacancyLinks.join(' | ') : '',
    leadStatus: lead.status ?? lead.lead_status ?? analysisData.status ?? '',
    assessment: lead.assessment ?? analysisData.assessment ?? '',
    assessmentReason: lead.assessmentReason ?? lead.assessment_reason ?? analysisData.assessmentReason ?? '',
    signals: Object.entries(signals ?? {}).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`).join(' | '),
    sector: lead.sector ?? '',
    country: lead.country ?? '',
    score,
    description: (lead.description ?? '').substring(0, 200),
    uniqueIdentifier: lead.uniqueIdentifier ?? lead.unique_identifier ?? '',
    foundAt: lead.foundAt ?? lead.created_at ?? new Date().toISOString(),
  };
}

async function exportCSV(leads, filename = 'leads.csv') {
  ensureOutputDir();
  const filepath = path.join(OUTPUT_DIR, filename);

  const writer = createObjectCsvWriter({
    path: filepath,
    header: COLUMNS,
    encoding: 'utf8',
  });

  await writer.writeRecords(leads.map(flattenLead));
  return filepath;
}

function exportXLSX(leads, filename = 'leads.xlsx') {
  ensureOutputDir();
  const filepath = path.join(OUTPUT_DIR, filename);

  const rows = leads.map(flattenLead);
  const ws = xlsx.utils.json_to_sheet(rows, {
    header: COLUMNS.map((c) => c.id),
  });

  ws['!cols'] = COLUMNS.map((col) => ({ wch: col.id === 'description' ? 50 : 20 }));

  COLUMNS.forEach((col, i) => {
    const cellRef = xlsx.utils.encode_cell({ r: 0, c: i });
    if (ws[cellRef]) {
      ws[cellRef].v = col.title;
      ws[cellRef].s = {
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: '1E40AF' } },
        alignment: { horizontal: 'center' },
      };
    }
  });

  const scoreColIdx = COLUMNS.findIndex((c) => c.id === 'score');
  rows.forEach((row, rowIdx) => {
    const cellRef = xlsx.utils.encode_cell({ r: rowIdx + 1, c: scoreColIdx });
    if (ws[cellRef]) {
      const score = row.score;
      const color = score >= 70 ? '166534' : score >= 50 ? 'A16207' : '991B1B';
      ws[cellRef].s = { font: { bold: true, color: { rgb: color } } };
    }
  });

  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Leads');
  xlsx.writeFile(wb, filepath);
  return filepath;
}

module.exports = { exportCSV, exportXLSX };
