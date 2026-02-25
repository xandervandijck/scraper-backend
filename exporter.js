/**
 * Exporter — CSV and Excel (xlsx) export for leads.
 */

import { createObjectCsvWriter } from 'csv-writer';
import xlsx from 'xlsx';
import path from 'path';
import fs from 'fs';

const OUTPUT_DIR = './output';

const COLUMNS = [
  { id: 'companyName', title: 'Bedrijfsnaam' },
  { id: 'website', title: 'Website' },
  { id: 'email', title: 'Email' },
  { id: 'phone', title: 'Telefoon' },
  { id: 'address', title: 'Adres' },
  { id: 'sector', title: 'Sector' },
  { id: 'country', title: 'Land' },
  { id: 'erpScore', title: 'ERP Score' },
  { id: 'erpLogistics', title: 'Logistiek Score' },
  { id: 'erpComplexity', title: 'Complexiteit Score' },
  { id: 'erpB2b', title: 'B2B Score' },
  { id: 'erpGrowth', title: 'Groei Score' },
  { id: 'emailValid', title: 'Email Geldig' },
  { id: 'emailScore', title: 'Email Score' },
  { id: 'emailReason', title: 'Email Reden' },
  { id: 'description', title: 'Omschrijving' },
  { id: 'foundAt', title: 'Gevonden Op' },
];

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function flattenLead(lead) {
  return {
    companyName: lead.companyName ?? '',
    website: lead.website ?? '',
    email: lead.email ?? '',
    phone: lead.phone ?? '',
    address: lead.address ?? '',
    sector: lead.sector ?? '',
    country: lead.country ?? '',
    erpScore: lead.erpScore ?? 0,
    erpLogistics: lead.erpBreakdown?.logistics?.score ?? 0,
    erpComplexity: lead.erpBreakdown?.complexity?.score ?? 0,
    erpB2b: lead.erpBreakdown?.b2b?.score ?? 0,
    erpGrowth: lead.erpBreakdown?.growth?.score ?? 0,
    emailValid: lead.emailValid ? 'Ja' : 'Nee',
    emailScore: lead.emailValidationScore ?? 0,
    emailReason: lead.emailValidationReason ?? '',
    description: (lead.description ?? '').substring(0, 200),
    foundAt: lead.foundAt ?? new Date().toISOString(),
  };
}

export async function exportCSV(leads, filename = 'leads.csv') {
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

export function exportXLSX(leads, filename = 'leads.xlsx') {
  ensureOutputDir();
  const filepath = path.join(OUTPUT_DIR, filename);

  const rows = leads.map(flattenLead);
  const ws = xlsx.utils.json_to_sheet(rows, {
    header: COLUMNS.map((c) => c.id),
  });

  // Set column widths
  ws['!cols'] = COLUMNS.map((col) => ({ wch: col.id === 'description' ? 50 : 20 }));

  // Header row styling via custom header row
  const headerRow = {};
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

  // Color-code ERP score column
  const scoreColIdx = COLUMNS.findIndex((c) => c.id === 'erpScore');
  rows.forEach((row, rowIdx) => {
    const cellRef = xlsx.utils.encode_cell({ r: rowIdx + 1, c: scoreColIdx });
    if (ws[cellRef]) {
      const score = row.erpScore;
      const color = score >= 70 ? '166534' : score >= 50 ? 'A16207' : '991B1B';
      ws[cellRef].s = { font: { bold: true, color: { rgb: color } } };
    }
  });

  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'ERP Leads');
  xlsx.writeFile(wb, filepath);
  return filepath;
}

export default { exportCSV, exportXLSX };
