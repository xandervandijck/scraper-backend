'use strict';

/**
 * Exporter — in-memory CSV and Excel (xlsx) generation, uploaded to DigitalOcean Spaces.
 * Never writes to disk to avoid triggering Strapi's file watcher / nodemon restarts.
 */

const { createObjectCsvStringifier } = require('csv-writer');
const xlsx = require('xlsx');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

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

/** Returns a UTF-8 Buffer of the CSV — no disk I/O. */
function exportCSVBuffer(leads) {
  const stringifier = createObjectCsvStringifier({ header: COLUMNS });
  const header = stringifier.getHeaderString();
  const records = stringifier.stringifyRecords(leads.map(flattenLead));
  return Buffer.from('﻿' + header + records, 'utf8'); // BOM for Excel compatibility
}

/** Returns a Buffer of the XLSX workbook — no disk I/O. */
function exportXLSXBuffer(leads) {
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
  return xlsx.write(wb, { bookType: 'xlsx', type: 'buffer' });
}

function buildS3Client() {
  return new S3Client({
    region: process.env.DO_SPACE_REGION || 'fra1',
    endpoint: process.env.DO_SPACE_ENDPOINT || 'https://fra1.digitaloceanspaces.com',
    credentials: {
      accessKeyId: process.env.DO_SPACE_ACCESS_KEY,
      secretAccessKey: process.env.DO_SPACE_SECRET_KEY,
    },
    forcePathStyle: false,
  });
}

/**
 * Uploads a Buffer to DigitalOcean Spaces and returns the public CDN URL.
 */
async function uploadToSpaces(buffer, filename, contentType) {
  const directory = (process.env.DO_SPACE_DIRECTORY ?? '').replace(/\/$/, '');
  const key = [directory, 'exports', filename].filter(Boolean).join('/');

  const client = buildS3Client();
  await client.send(new PutObjectCommand({
    Bucket: process.env.DO_SPACE_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ACL: process.env.DO_SPACE_ACL || 'public-read',
    ContentDisposition: `attachment; filename="${filename}"`,
  }));

  const cdnBase = (process.env.DO_SPACE_CDN || `https://${process.env.DO_SPACE_BUCKET}.${process.env.DO_SPACE_REGION}.digitaloceanspaces.com`).replace(/\/$/, '');
  return `${cdnBase}/${key}`;
}

module.exports = { exportCSVBuffer, exportXLSXBuffer, uploadToSpaces };
