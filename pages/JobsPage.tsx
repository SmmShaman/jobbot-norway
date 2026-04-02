
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { JobTable } from '../components/JobTable';
import { api } from '../services/api';
import { Job, ExportHistory, JobTableExportInfo } from '../types';
import { Download, Loader2, RefreshCw, Clock, Calendar, FileSpreadsheet, FileText, History, X, Trash2, Printer } from 'lucide-react';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

interface ScanScheduleInfo {
  enabled: boolean;
  timeUtc: string;
  nextScanIn: string;
  nextScanDate: string;
}

const calculateNextScan = (scanTimeUtc: string): { nextScanIn: string; nextScanDate: string } => {
  if (!scanTimeUtc) return { nextScanIn: 'Not scheduled', nextScanDate: '' };

  const [hours, minutes] = scanTimeUtc.split(':').map(Number);
  const now = new Date();
  const nowUtc = new Date(now.toISOString());

  // Create next scan time in UTC
  let nextScan = new Date(Date.UTC(
    nowUtc.getUTCFullYear(),
    nowUtc.getUTCMonth(),
    nowUtc.getUTCDate(),
    hours,
    minutes,
    0
  ));

  // If scan time already passed today, schedule for tomorrow
  if (nextScan <= nowUtc) {
    nextScan.setUTCDate(nextScan.getUTCDate() + 1);
  }

  const diffMs = nextScan.getTime() - nowUtc.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  // Convert to Norway time (UTC+1 or UTC+2 for DST)
  const norwayTime = new Date(nextScan.getTime());
  const norwayTimeStr = norwayTime.toLocaleTimeString('no-NO', {
    timeZone: 'Europe/Oslo',
    hour: '2-digit',
    minute: '2-digit'
  });

  let nextScanIn = '';
  if (diffHours > 0) {
    nextScanIn = `${diffHours} год ${diffMinutes} хв`;
  } else {
    nextScanIn = `${diffMinutes} хв`;
  }

  return {
    nextScanIn,
    nextScanDate: `${norwayTimeStr} (Norway)`
  };
};

interface JobsPageProps {
  setSidebarCollapsed?: (collapsed: boolean) => void;
}

interface ExportColumnConfig {
  key: string;
  label: string;
  excelHeader: string;
  pdfHeader: string;
  pdfWidth: number;
  pdfAlign?: 'center';
  getValue: (job: Job) => string;
  isHyperlink?: boolean;
}

const APPLICATION_STATUS_LABELS: Record<string, string> = {
  draft: 'Чернетка',
  approved: 'Затверджено',
  sending: 'Надсилається',
  manual_review: 'Перевірка',
  sent: 'Відправлено',
  failed: 'Помилка',
  rejected: 'Відхилено',
};

const FORM_TYPE_LABELS: Record<string, string> = {
  finn_easy: 'FINN Easy',
  external_form: 'Форма',
  external_registration: 'Реєстрація',
  email: 'Email',
  processing: 'Обробка',
  skyvern_failed: 'Помилка',
  unknown: '-',
};

const EXPORT_COLUMNS: ExportColumnConfig[] = [
  {
    key: 'title', label: 'Назва', excelHeader: 'Назва', pdfHeader: 'Title', pdfWidth: 55,
    getValue: (job) => job.title,
  },
  {
    key: 'company', label: 'Компанія', excelHeader: 'Компанія', pdfHeader: 'Company', pdfWidth: 35,
    getValue: (job) => job.company,
  },
  {
    key: 'location', label: 'Місце', excelHeader: 'Місце', pdfHeader: 'Location', pdfWidth: 25,
    getValue: (job) => job.location,
  },
  {
    key: 'added', label: 'Додано', excelHeader: 'Додано', pdfHeader: 'Added', pdfWidth: 22, pdfAlign: 'center',
    getValue: (job) => job.scannedAt ? new Date(job.scannedAt).toLocaleDateString('uk-UA') : '-',
  },
  {
    key: 'deadline', label: 'Frist', excelHeader: 'Frist', pdfHeader: 'Deadline', pdfWidth: 22, pdfAlign: 'center',
    getValue: (job) => job.deadline || '-',
  },
  {
    key: 'match', label: 'Збіг', excelHeader: 'Збіг', pdfHeader: 'Match', pdfWidth: 18, pdfAlign: 'center',
    getValue: (job) => job.matchScore ? job.matchScore + '%' : '-',
  },
  {
    key: 'soknad', label: 'Søknad', excelHeader: 'Søknad', pdfHeader: 'Soknad', pdfWidth: 22, pdfAlign: 'center',
    getValue: (job) => job.application_status ? (APPLICATION_STATUS_LABELS[job.application_status] || job.application_status) : '-',
  },
  {
    key: 'formtype', label: 'Подача', excelHeader: 'Подача', pdfHeader: 'Form Type', pdfWidth: 22, pdfAlign: 'center',
    getValue: (job) => {
      if (job.has_enkel_soknad) return 'FINN Easy';
      return job.application_form_type ? (FORM_TYPE_LABELS[job.application_form_type] || job.application_form_type) : '-';
    },
  },
  {
    key: 'url', label: 'Лінк', excelHeader: 'URL', pdfHeader: 'URL', pdfWidth: 55,
    getValue: (job) => job.url,
    isHyperlink: true,
  },
  {
    key: 'description', label: 'Опис', excelHeader: 'Опис вакансії', pdfHeader: 'Description', pdfWidth: 80,
    getValue: (job) => job.description ? job.description.substring(0, 500) : '-',
  },
  {
    key: 'cover_letter', label: 'Søknad текст', excelHeader: 'Søknad (текст)', pdfHeader: 'Cover Letter', pdfWidth: 80,
    getValue: (job) => '-', // Dynamic — overridden by exportLang state
  },
];

const COLUMN_STORAGE_KEY = 'jobbot-export-columns';

export const JobsPage: React.FC<JobsPageProps> = ({ setSidebarCollapsed }) => {
  const { jobId } = useParams<{ jobId?: string }>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanSchedule, setScanSchedule] = useState<ScanScheduleInfo | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [exportHistory, setExportHistory] = useState<ExportHistory[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [profileName, setProfileName] = useState<string>('');
  const [exportLang, setExportLang] = useState<'no' | 'uk'>('no');
  const [exportInfo, setExportInfo] = useState<JobTableExportInfo | null>(null);
  const handleExportInfoChange = useCallback((info: JobTableExportInfo) => {
    setExportInfo(info);
  }, []);

  // Export column toggles (persisted to localStorage)
  const [enabledColumns, setEnabledColumns] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(COLUMN_STORAGE_KEY);
      if (stored) return new Set(JSON.parse(stored) as string[]);
    } catch { /* ignore */ }
    return new Set(EXPORT_COLUMNS.map(c => c.key));
  });
  const activeColumns = EXPORT_COLUMNS.filter(c => enabledColumns.has(c.key)).map(c => {
    if (c.key === 'cover_letter') {
      return { ...c, getValue: (job: Job) => (exportLang === 'uk' ? job.cover_letter_uk : job.cover_letter_no) || '-' };
    }
    return c;
  });

  const toggleColumn = (key: string) => {
    setEnabledColumns(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size <= 1) return prev; // keep at least 1
        next.delete(key);
      } else {
        next.add(key);
      }
      localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  // Fetch profile name for PDF export
  useEffect(() => {
    const fetchProfileName = async () => {
      const profile = await api.cv.getActiveProfile();
      if (profile?.structured_content?.personalInfo?.fullName) {
        setProfileName(profile.structured_content.personalInfo.fullName);
      }
    };
    fetchProfileName();
  }, []);

  // Get display name for PDF export header (from CV profile)
  const getUserDisplayName = (): string => {
    if (profileName) {
      return profileName;
    }
    return 'User';
  };

  // Fetch export history
  const fetchExportHistory = async () => {
    setLoadingHistory(true);
    const history = await api.exports.getExportHistory();
    setExportHistory(history);
    setLoadingHistory(false);
  };

  // Determine which jobs to export: selected > filtered > all
  const getExportJobs = (): { jobsToExport: Job[]; mode: 'selected' | 'filtered' | 'all' } => {
    if (exportInfo && exportInfo.selectedIds.size > 0) {
      return {
        jobsToExport: exportInfo.filteredJobs.filter(j => exportInfo.selectedIds.has(j.id)),
        mode: 'selected',
      };
    }
    if (exportInfo && exportInfo.filteredJobs.length < exportInfo.totalJobsCount) {
      return { jobsToExport: exportInfo.filteredJobs, mode: 'filtered' };
    }
    return { jobsToExport: jobs, mode: 'all' };
  };

  // Count for export button badges — must match getExportJobs() logic exactly
  const { exportCount, isFiltered } = useMemo(() => {
    if (!exportInfo) return { exportCount: jobs.length, isFiltered: false };
    if (exportInfo.selectedIds.size > 0) {
      // Count only selected jobs that are in current filter (same as getExportJobs)
      const count = exportInfo.filteredJobs.filter(j => exportInfo.selectedIds.has(j.id)).length;
      return { exportCount: count, isFiltered: true };
    }
    if (exportInfo.filteredJobs.length < exportInfo.totalJobsCount) {
      return { exportCount: exportInfo.filteredJobs.length, isFiltered: true };
    }
    return { exportCount: jobs.length, isFiltered: false };
  }, [exportInfo, jobs.length]);

  // Build filename based on active date filters
  const buildExportFilename = (format: 'xlsx' | 'pdf'): string => {
    const startDate = exportInfo?.filters?.startDate;
    const endDate = exportInfo?.filters?.endDate;

    if (startDate && endDate) {
      return `vakansii_${startDate}_${endDate}.${format}`;
    }
    if (startDate) {
      return `vakansii_from_${startDate}.${format}`;
    }
    const today = new Date().toISOString().split('T')[0];
    return `vakansii_all_${today}.${format}`;
  };

  // Build PDF header subtitle
  const buildPdfSubtitle = (mode: 'selected' | 'filtered' | 'all', count: number): string => {
    const datePart = new Date().toLocaleDateString('en-GB');
    const startDate = exportInfo?.filters?.startDate;
    const endDate = exportInfo?.filters?.endDate;
    const periodPart = startDate
      ? ` | Period: ${startDate}${endDate ? ' - ' + endDate : ' onwards'}`
      : '';

    if (mode === 'selected') {
      return `Exported: ${datePart} | Selected: ${count} of ${jobs.length} jobs${periodPart}`;
    }
    if (mode === 'filtered') {
      return `Exported: ${datePart} | Filtered: ${count} of ${jobs.length} jobs${periodPart}`;
    }
    return `Exported: ${datePart} | Total: ${count} jobs`;
  };

  // Print selected/filtered jobs
  const handlePrint = () => {
    const { jobsToExport } = getExportJobs();
    if (jobsToExport.length === 0) return;

    const cols = activeColumns;
    const hasDescription = enabledColumns.has('description');
    const hasCoverLetter = enabledColumns.has('cover_letter');

    let html = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <title>JobBot - ${jobsToExport.length} jobs</title>
      <style>
        body { font-family: Arial, sans-serif; font-size: 11px; margin: 20px; }
        h1 { font-size: 16px; margin-bottom: 5px; }
        .subtitle { font-size: 10px; color: #666; margin-bottom: 15px; }
        table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
        th { background: #3b82f6; color: white; padding: 6px 8px; text-align: left; font-size: 10px; }
        td { padding: 5px 8px; border-bottom: 1px solid #e2e8f0; font-size: 10px; }
        tr:nth-child(even) { background: #f8fafc; }
        .job-detail { page-break-inside: avoid; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
        .job-detail h3 { font-size: 13px; margin: 0 0 4px 0; }
        .job-detail .company { font-size: 11px; color: #3b82f6; margin-bottom: 8px; }
        .job-detail .meta { font-size: 9px; color: #666; margin-bottom: 8px; }
        .job-detail .section-title { font-size: 10px; font-weight: bold; color: #334155; margin: 8px 0 4px 0; }
        .job-detail .text { font-size: 10px; line-height: 1.4; white-space: pre-wrap; }
        @media print { body { margin: 10px; } .no-print { display: none; } }
      </style>
    </head><body>`;

    html += `<h1>JobBot Norway - ${getUserDisplayName()}</h1>`;
    html += `<div class="subtitle">${new Date().toLocaleDateString('uk-UA')} | ${jobsToExport.length} vacancies</div>`;

    // If description or cover letter columns enabled, show detailed cards
    if (hasDescription || hasCoverLetter) {
      for (const job of jobsToExport) {
        html += `<div class="job-detail">`;
        html += `<h3>${job.title}</h3>`;
        html += `<div class="company">${job.company} | ${job.location}</div>`;
        html += `<div class="meta">`;
        if (job.deadline) html += `Frist: ${job.deadline} | `;
        if (job.matchScore) html += `Match: ${job.matchScore}% | `;
        html += `${job.source} | ${job.url}`;
        html += `</div>`;

        if (hasDescription && job.description) {
          html += `<div class="section-title">Опис вакансії:</div>`;
          html += `<div class="text">${job.description.substring(0, 1500)}</div>`;
        }
        const coverText = exportLang === 'uk' ? job.cover_letter_uk : job.cover_letter_no;
        if (hasCoverLetter && coverText) {
          html += `<div class="section-title">Søknad (${exportLang === 'uk' ? 'UA' : 'NO'}):</div>`;
          html += `<div class="text">${coverText}</div>`;
        }
        html += `</div>`;
      }
    } else {
      // Table mode (without description/cover letter)
      const tableCols = cols.filter(c => c.key !== 'description' && c.key !== 'cover_letter');
      html += `<table><thead><tr>`;
      tableCols.forEach(c => { html += `<th>${c.label}</th>`; });
      html += `</tr></thead><tbody>`;
      for (const job of jobsToExport) {
        html += `<tr>`;
        tableCols.forEach(c => { html += `<td>${c.getValue(job)}</td>`; });
        html += `</tr>`;
      }
      html += `</tbody></table>`;
    }

    html += `</body></html>`;

    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.onload = () => { printWindow.print(); };
    }
  };

  // Export jobs to Excel or PDF and save to Supabase
  const handleExport = async (format: 'xlsx' | 'pdf') => {
    if (jobs.length === 0) return;

    const { jobsToExport, mode } = getExportJobs();
    if (jobsToExport.length === 0) return;

    const filename = buildExportFilename(format);
    const mimeType = format === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/pdf';

    // 1. FIRST show the save dialog (while user gesture is still active!)
    let fileHandle: any = null;

    if ('showSaveFilePicker' in window) {
      try {
        fileHandle = await (window as any).showSaveFilePicker({
          suggestedName: filename,
          types: [{
            description: format === 'xlsx' ? 'Excel Spreadsheet' : 'PDF Document',
            accept: { [mimeType]: [`.${format}`] }
          }]
        });
      } catch (err: any) {
        if (err.name === 'AbortError') return; // User cancelled
        console.error('Save dialog error:', err);
        fileHandle = null; // Fallback to standard download
      }
    }

    // 2. THEN show loading and generate blob
    setIsExporting(true);

    try {
      let blob: Blob;

      if (format === 'xlsx') {
        // Build AOA (array of arrays) for cell-level control
        const headers = activeColumns.map(c => c.excelHeader);
        const rows = jobsToExport.map(job => activeColumns.map(col => col.getValue(job)));
        const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

        // Add hyperlinks to URL column
        const urlColIdx = activeColumns.findIndex(c => c.isHyperlink);
        if (urlColIdx >= 0) {
          jobsToExport.forEach((job, i) => {
            const cellRef = XLSX.utils.encode_cell({ r: i + 1, c: urlColIdx });
            const cell = ws[cellRef];
            const url = activeColumns[urlColIdx].getValue(job);
            if (cell && url && url !== '-') {
              cell.l = { Target: url, Tooltip: job.title };
            }
          });
        }

        // Set column widths
        ws['!cols'] = activeColumns.map(col =>
          ({ wch: col.key === 'url' ? 50 : col.key === 'title' ? 30 : 15 })
        );

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Вакансії');
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        blob = new Blob([wbout], { type: mimeType });
      } else {
        // PDF landscape
        const doc = new jsPDF({ orientation: 'landscape' });

        doc.setFontSize(16);
        doc.setFont('helvetica', 'bold');
        doc.text(`Jobs - JobBot Norway for ${getUserDisplayName()}!`, 14, 15);
        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        doc.text(buildPdfSubtitle(mode, jobsToExport.length), 14, 22);

        const pdfHeaders = [activeColumns.map(c => c.pdfHeader)];
        const pdfBody = jobsToExport.map(job => activeColumns.map(c => c.getValue(job)));

        // Proportional width redistribution for A4 landscape (297 - 20 margins = 277)
        const totalW = activeColumns.reduce((s, c) => s + c.pdfWidth, 0);
        const scale = 277 / totalW;
        const columnStyles: Record<number, any> = {};
        activeColumns.forEach((col, i) => {
          columnStyles[i] = {
            cellWidth: Math.round(col.pdfWidth * scale),
            ...(col.pdfAlign ? { halign: col.pdfAlign } : {}),
          };
        });

        autoTable(doc, {
          head: pdfHeaders,
          body: pdfBody,
          startY: 28,
          styles: {
            fontSize: 7,
            cellPadding: 3,
            overflow: 'linebreak',
            valign: 'middle'
          },
          headStyles: {
            fillColor: [59, 130, 246],
            textColor: 255,
            fontStyle: 'bold',
            halign: 'center'
          },
          alternateRowStyles: {
            fillColor: [248, 250, 252]
          },
          columnStyles,
          margin: { left: 10, right: 10 }
        });

        blob = doc.output('blob');
      }

      // 3. Save file
      if (fileHandle) {
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        // Fallback: standard download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      }

      // 4. Save to Supabase Storage for history
      const filtersApplied = exportInfo?.filters;
      const result = await api.exports.saveExport(blob, filename, format, jobsToExport.length, filtersApplied);
      if (!result.success) {
        console.error('Failed to save export to cloud:', result.error);
      }

      // Refresh history if modal is open
      if (showHistory) {
        fetchExportHistory();
      }
    } catch (err) {
      console.error('Export error:', err);
      alert('Помилка експорту. Перевірте консоль.');
    } finally {
      setIsExporting(false);
    }
  };

  // Delete export from history
  const handleDeleteExport = async (exp: ExportHistory) => {
    if (!confirm(`Видалити "${exp.filename}"?`)) return;
    const success = await api.exports.deleteExport(exp.id, exp.file_path);
    if (success) {
      setExportHistory(prev => prev.filter(e => e.id !== exp.id));
    }
  };

  // Download export from history
  const handleDownloadExport = async (exp: ExportHistory) => {
    if (exp.download_url) {
      window.open(exp.download_url, '_blank');
    } else {
      const url = await api.exports.getDownloadUrl(exp.file_path);
      if (url) {
        window.open(url, '_blank');
      }
    }
  };

  // Format file size
  const formatSize = (bytes?: number) => {
    if (!bytes) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Fetch scan schedule settings
  useEffect(() => {
    const fetchScanSchedule = async () => {
      try {
        const settings = await api.settings.getSettings();
        if (settings) {
          const { nextScanIn, nextScanDate } = calculateNextScan(settings.scan_time_utc || '09:00');
          setScanSchedule({
            enabled: settings.is_auto_scan_enabled || false,
            timeUtc: settings.scan_time_utc || '09:00',
            nextScanIn,
            nextScanDate
          });
        }
      } catch (e) {
        console.error("Failed to fetch scan schedule:", e);
      }
    };
    fetchScanSchedule();

    // Update countdown every minute
    const interval = setInterval(() => {
      if (scanSchedule?.timeUtc) {
        const { nextScanIn, nextScanDate } = calculateNextScan(scanSchedule.timeUtc);
        setScanSchedule(prev => prev ? { ...prev, nextScanIn, nextScanDate } : null);
      }
    }, 60000);

    return () => clearInterval(interval);
  }, []);

  // isBackgroundUpdate param ensures we don't show the full-screen loader on auto-refresh
  const fetchJobs = useCallback(async (isBackgroundUpdate = false) => {
    try {
        if (!isBackgroundUpdate) setLoading(true);
        console.log("JobsPage: Fetching jobs from API...");

        const data = await api.getJobs();
        console.log("JobsPage: Received jobs:", data.length);

        // Critical Fix: Only update state if data is a valid array.
        // We do NOT clear the state on error to prevent flickering or disappearance.
        if (Array.isArray(data)) {
             setJobs(data);
        } else {
             console.error("JobsPage: Invalid data format received", data);
        }
    } catch (err) {
        console.error("JobsPage: Fetch error", err);
    } finally {
        if (!isBackgroundUpdate) setLoading(false);
    }
  }, []);

  // Initial load + Realtime Subscription
  useEffect(() => {
    fetchJobs();

    // Subscribe to DB changes (Telegram Bot, etc.)
    const unsubscribe = api.subscribeToChanges(() => {
        console.log("JobsPage: Realtime update detected. Refreshing list...");
        fetchJobs(true); // background update
    });

    return () => {
        unsubscribe();
    };
  }, [fetchJobs]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            Jobs Market
            <span className="flex h-2 w-2 relative">
               <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
               <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
            </span>
          </h2>
          <p className="text-slate-500">Manage and track your opportunities.</p>

          {/* Scan Schedule Info */}
          {scanSchedule && (
            <div className={`mt-2 flex items-center gap-3 text-xs ${scanSchedule.enabled ? 'text-green-600' : 'text-slate-400'}`}>
              <div className="flex items-center gap-1">
                <Clock size={12} />
                <span>
                  {scanSchedule.enabled ? (
                    <>Сканування щодня о <b>{scanSchedule.nextScanDate}</b></>
                  ) : (
                    'Автосканування вимкнено'
                  )}
                </span>
              </div>
              {scanSchedule.enabled && (
                <div className="flex items-center gap-1 bg-green-50 px-2 py-0.5 rounded-full border border-green-200">
                  <Calendar size={12} />
                  <span>Наступне через <b>{scanSchedule.nextScanIn}</b></span>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => fetchJobs(false)}
            className="flex items-center gap-2 text-slate-600 bg-white border border-slate-300 px-4 py-2 rounded-lg hover:bg-slate-50 text-sm font-medium"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
          <button
            onClick={() => handleExport('xlsx')}
            disabled={isExporting || jobs.length === 0}
            className="flex items-center gap-2 text-white bg-emerald-600 px-4 py-2 rounded-lg hover:bg-emerald-700 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isExporting ? <Loader2 size={16} className="animate-spin" /> : <FileSpreadsheet size={16} />}
            Excel{isFiltered ? ` (${exportCount})` : ''}
          </button>
          <button
            onClick={() => handleExport('pdf')}
            disabled={isExporting || jobs.length === 0}
            className="flex items-center gap-2 text-white bg-red-600 px-4 py-2 rounded-lg hover:bg-red-700 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isExporting ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
            PDF{isFiltered ? ` (${exportCount})` : ''}
          </button>
          <button
            onClick={() => handlePrint()}
            disabled={isExporting || jobs.length === 0}
            className="flex items-center gap-2 text-white bg-purple-600 px-4 py-2 rounded-lg hover:bg-purple-700 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Printer size={16} />
            Print{isFiltered ? ` (${exportCount})` : ''}
          </button>
          <div className="flex items-center bg-white border border-slate-300 rounded-lg overflow-hidden">
            <button onClick={() => setExportLang('no')} className={`px-3 py-2 text-xs font-medium ${exportLang === 'no' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}>🇳🇴 NO</button>
            <button onClick={() => setExportLang('uk')} className={`px-3 py-2 text-xs font-medium ${exportLang === 'uk' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}>🇺🇦 UA</button>
          </div>
          <button
            onClick={() => { setShowHistory(true); fetchExportHistory(); }}
            className="flex items-center gap-2 text-slate-600 bg-white border border-slate-300 px-4 py-2 rounded-lg hover:bg-slate-50 text-sm font-medium"
            title="Історія експортів"
          >
            <History size={16} />
          </button>
        </div>
      </div>

      {/* Export History Modal */}
      {showHistory && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowHistory(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <History size={20} /> Історія експортів
              </h3>
              <button onClick={() => setShowHistory(false)} className="text-slate-400 hover:text-slate-600">
                <X size={20} />
              </button>
            </div>
            <div className="p-4 overflow-y-auto max-h-[60vh]">
              {loadingHistory ? (
                <div className="flex justify-center py-8">
                  <Loader2 size={24} className="animate-spin text-blue-600" />
                </div>
              ) : exportHistory.length === 0 ? (
                <div className="text-center py-8 text-slate-400">
                  <History size={48} className="mx-auto mb-2 opacity-50" />
                  <p>Немає збережених експортів</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {exportHistory.map(exp => (
                    <div key={exp.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors">
                      <div className="flex items-center gap-3">
                        {exp.format === 'xlsx' ? (
                          <FileSpreadsheet size={24} className="text-emerald-600" />
                        ) : (
                          <FileText size={24} className="text-red-600" />
                        )}
                        <div>
                          <p className="font-medium text-slate-900 text-sm">{exp.filename}</p>
                          <p className="text-xs text-slate-500">
                            {new Date(exp.created_at).toLocaleString('uk-UA')} • {exp.jobs_count} вакансій • {formatSize(exp.file_size)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleDownloadExport(exp)}
                          className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                          title="Завантажити"
                        >
                          <Download size={18} />
                        </button>
                        <button
                          onClick={() => handleDeleteExport(exp)}
                          className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                          title="Видалити"
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {loading && jobs.length === 0 ? (
        <div className="flex justify-center items-center h-64 bg-white rounded-xl border border-slate-200">
          <div className="flex flex-col items-center gap-2">
            <Loader2 size={32} className="animate-spin text-blue-600" />
            <p className="text-slate-500">Loading jobs from database...</p>
          </div>
        </div>
      ) : jobs.length === 0 ? (
        <div className="flex justify-center items-center h-64 bg-white rounded-xl border border-slate-200">
           <div className="text-center">
             <p className="text-slate-800 font-medium">No jobs found yet.</p>
             <p className="text-slate-500 text-sm mt-1">Start a scan to find opportunities.</p>
             <button onClick={() => fetchJobs(false)} className="mt-4 text-blue-600 hover:underline text-sm">Try refreshing again</button>
           </div>
        </div>
      ) : (
        <JobTable jobs={jobs} onRefresh={() => fetchJobs(true)} setSidebarCollapsed={setSidebarCollapsed} onExportInfoChange={handleExportInfoChange} exportColumns={enabledColumns} onToggleExportColumn={toggleColumn} initialExpandedJobId={jobId} />
      )}
    </div>
  );
};
