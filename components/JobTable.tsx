
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Job, Application, JobTableExportInfo } from '../types';
import { ExternalLink, MapPin, Building, ChevronDown, ChevronUp, FileText, Bot, Loader2, CheckSquare, Square, Sparkles, Download, AlertCircle, PenTool, Calendar, RefreshCw, X, CheckCircle, Rocket, Eye, EyeOff, ListChecks, DollarSign, Smartphone, RotateCw, Shield, Flame, Zap, StopCircle, Copy, Check, Brain, HelpCircle } from 'lucide-react';
import { api } from '../services/api';
import { useLanguage } from '../contexts/LanguageContext';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer } from 'recharts';
import { DateRangePicker } from './DateRangePicker';

interface JobTableProps {
  jobs: Job[];
  onRefresh?: () => void;
  setSidebarCollapsed?: (collapsed: boolean) => void;
  onExportInfoChange?: (info: JobTableExportInfo) => void;
  exportColumns?: Set<string>;
  onToggleExportColumn?: (key: string) => void;
  initialExpandedJobId?: string;
}

const HelpTip: React.FC<{ text: string }> = ({ text }) => (
  <span className="relative group inline-flex items-center">
    <HelpCircle size={14} className="text-slate-400 hover:text-blue-500 cursor-help transition-colors" />
    <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-xs text-white bg-slate-800 rounded-lg shadow-lg whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-50 max-w-xs text-center">
      {text}
      <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800" />
    </span>
  </span>
);

export const JobTable: React.FC<JobTableProps> = ({ jobs, onRefresh, setSidebarCollapsed, onExportInfoChange, exportColumns, onToggleExportColumn, initialExpandedJobId }) => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [loadingDesc, setLoadingDesc] = useState<string | null>(null);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  
  // Application State
  const [applicationData, setApplicationData] = useState<Application | null>(null);
  const [isGeneratingApp, setIsGeneratingApp] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isFillingFinnForm, setIsFillingFinnForm] = useState(false);
  const [isRefreshingStatus, setIsRefreshingStatus] = useState(false);
  const [reanalyzingRadarId, setReanalyzingRadarId] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Copy to clipboard helper
  const copyToClipboard = async (text: string, fieldId: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldId);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // Accordion State
  const [openSections, setOpenSections] = useState<{ai: boolean, tasks: boolean, desc: boolean, app: boolean}>({
      ai: true,
      tasks: true,
      desc: false,
      app: false 
  });

  // Bulk Selection State
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isProcessingBulk, setIsProcessingBulk] = useState(false);

  // Filter State
  const [showDateDropdown, setShowDateDropdown] = useState(false);
  const dateDropdownRef = useRef<HTMLDivElement>(null);
  const companyDropdownRef = useRef<HTMLDivElement>(null);

  const [searchParams, setSearchParams] = useSearchParams();

  // Resolve "period" shortcut to date range
  const resolveInitialDates = (): { startDate: string; endDate: string } => {
    const period = searchParams.get('period');
    if (period) {
      const end = new Date();
      const start = new Date();
      if (period === 'week') start.setDate(end.getDate() - 7);
      else if (period === 'month') start.setDate(end.getDate() - 30);
      else if (period === '3days') start.setDate(end.getDate() - 3);
      else if (period === 'today') { /* start = today */ }
      return {
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
      };
    }
    return {
      startDate: searchParams.get('from') || '',
      endDate: searchParams.get('to') || '',
    };
  };

  const initialDates = resolveInitialDates();

  const [filters, setFilters] = useState({
    title: searchParams.get('title') || '',
    company: searchParams.get('company') || '',
    location: searchParams.get('location') || '',
    startDate: initialDates.startDate,
    endDate: initialDates.endDate,
    minScore: Number(searchParams.get('score')) || 0,
    appStatusFilter: (searchParams.get('appStatus') || 'all') as 'all' | 'sent' | 'written_not_sent' | 'not_written',
    formTypeFilter: (searchParams.get('formType') || 'all') as 'all' | 'finn_easy' | 'external_form' | 'external_registration' | 'unknown' | 'no_url',
    deadlineFilter: (searchParams.get('deadline') || 'all') as 'all' | 'expired' | 'active' | 'no_deadline',
    sourceFilter: (searchParams.get('source') || 'all') as 'all' | 'FINN' | 'NAV' | 'LINKEDIN'
  });

  // Excluded companies filter
  const [excludedCompanies, setExcludedCompanies] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('jobbot_excluded_companies');
      if (stored) return new Set(JSON.parse(stored) as string[]);
    } catch { /* ignore */ }
    return new Set();
  });

  // Sync filters → URL search params
  useEffect(() => {
    const params = new URLSearchParams();
    if (filters.title) params.set('title', filters.title);
    if (filters.company) params.set('company', filters.company);
    if (filters.location) params.set('location', filters.location);
    if (filters.startDate) params.set('from', filters.startDate);
    if (filters.endDate) params.set('to', filters.endDate);
    if (filters.minScore > 0) params.set('score', String(filters.minScore));
    if (filters.appStatusFilter !== 'all') params.set('appStatus', filters.appStatusFilter);
    if (filters.formTypeFilter !== 'all') params.set('formType', filters.formTypeFilter);
    if (filters.deadlineFilter !== 'all') params.set('deadline', filters.deadlineFilter);
    if (filters.sourceFilter !== 'all') params.set('source', filters.sourceFilter);
    setSearchParams(params, { replace: true });
  }, [filters]);

  const toggleExcludeCompany = (company: string) => {
    setExcludedCompanies(prev => {
      const next = new Set(prev);
      if (next.has(company)) next.delete(company);
      else next.add(company);
      localStorage.setItem('jobbot_excluded_companies', JSON.stringify([...next]));
      return next;
    });
  };

  const clearExcludedCompanies = () => {
    setExcludedCompanies(new Set());
    localStorage.removeItem('jobbot_excluded_companies');
  };

  const [showExcludedDropdown, setShowExcludedDropdown] = useState(false);
  const [companySearchInDropdown, setCompanySearchInDropdown] = useState('');

  // Unique companies sorted by job count (desc) for the exclusion dropdown
  const { uniqueCompanies, companyCounts } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const job of jobs) {
      const c = String(job.company || '').trim();
      if (c && c !== 'Unknown Company') counts.set(c, (counts.get(c) || 0) + 1);
    }
    const sorted = [...counts.keys()].sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
    return { uniqueCompanies: sorted, companyCounts: counts };
  }, [jobs]);

  // Helper: Check if deadline is estimated (ASAP/Snarest)
  const isEstimatedDeadline = (deadline?: string): boolean => {
    return deadline?.startsWith('~') ?? false;
  };

  // Helper: Get source logo/icon
  const getSourceBadge = (source: string, size: 'sm' | 'md' = 'sm') => {
    const sourceUpper = (source || '').toUpperCase();
    const sizeClasses = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
    const badgeClasses = size === 'sm' ? 'text-[9px] px-1.5 py-0.5' : 'text-[10px] px-2 py-1';

    if (sourceUpper === 'FINN') {
      return (
        <span className={`${badgeClasses} rounded font-bold bg-[#06bffc] text-white flex items-center gap-1`} title="FINN.no">
          <svg className={sizeClasses} viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
          </svg>
          FINN
        </span>
      );
    }

    if (sourceUpper === 'NAV') {
      return (
        <span className={`${badgeClasses} rounded font-bold bg-[#c30000] text-white flex items-center gap-1`} title="NAV / Arbeidsplassen">
          <svg className={sizeClasses} viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z"/>
          </svg>
          NAV
        </span>
      );
    }

    if (sourceUpper === 'LINKEDIN') {
      return (
        <span className={`${badgeClasses} rounded font-bold bg-[#0a66c2] text-white flex items-center gap-1`} title="LinkedIn">
          <svg className={sizeClasses} viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.32 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.79M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z"/>
          </svg>
          LinkedIn
        </span>
      );
    }

    // Default/unknown source
    return (
      <span className={`${badgeClasses} rounded font-medium bg-slate-200 text-slate-600 uppercase`}>
        {source || '?'}
      </span>
    );
  };

  // Helper: Get recruitment agency/company logo based on external_apply_url domain
  const getApplyBadge = (externalUrl?: string) => {
    if (!externalUrl) return null;

    // Extract domain from URL
    let domain = '';
    try {
      const url = new URL(externalUrl);
      domain = url.hostname.toLowerCase().replace('www.', '');
    } catch {
      return null;
    }

    // Map of known domains to their branding
    const domainBranding: Record<string, { name: string; color: string; shortName: string }> = {
      // Recruitment platforms
      'webcruiter.com': { name: 'Webcruiter', color: '#0066cc', shortName: 'WC' },
      'webcruiter.no': { name: 'Webcruiter', color: '#0066cc', shortName: 'WC' },
      'jobylon.com': { name: 'Jobylon', color: '#ff6b35', shortName: 'JB' },
      'teamtailor.com': { name: 'Teamtailor', color: '#5c5ce0', shortName: 'TT' },
      'easycruit.com': { name: 'Easycruit', color: '#00a651', shortName: 'EC' },
      'recman.no': { name: 'Recman', color: '#1e3a5f', shortName: 'RM' },
      'varbi.com': { name: 'Varbi', color: '#00b4d8', shortName: 'VB' },
      'greenhouse.io': { name: 'Greenhouse', color: '#3ab549', shortName: 'GH' },
      'lever.co': { name: 'Lever', color: '#5d4dcd', shortName: 'LV' },
      'workday.com': { name: 'Workday', color: '#0875e1', shortName: 'WD' },
      'smartrecruiters.com': { name: 'SmartRecruiters', color: '#01b3e3', shortName: 'SR' },
      'talentech.io': { name: 'Talentech', color: '#6c5ce7', shortName: 'TL' },
      'cvpartner.com': { name: 'CV Partner', color: '#ff5722', shortName: 'CV' },
      'hrmanager.no': { name: 'HR Manager', color: '#2196f3', shortName: 'HR' },
      'recruitee.com': { name: 'Recruitee', color: '#2f80ed', shortName: 'RC' },
      'breezy.hr': { name: 'Breezy', color: '#00c4b4', shortName: 'BZ' },
      'ashbyhq.com': { name: 'Ashby', color: '#4f46e5', shortName: 'AB' },

      // Norwegian companies with own portals
      'nammo.com': { name: 'Nammo', color: '#c8102e', shortName: 'NM' },
      'norskhydro.com': { name: 'Hydro', color: '#005b82', shortName: 'HY' },
      'equinor.com': { name: 'Equinor', color: '#ff1243', shortName: 'EQ' },
      'dnb.no': { name: 'DNB', color: '#007272', shortName: 'DNB' },
      'telenor.com': { name: 'Telenor', color: '#00b0f0', shortName: 'TN' },
      'storebrand.no': { name: 'Storebrand', color: '#003087', shortName: 'SB' },
      'gjensidige.no': { name: 'Gjensidige', color: '#f26722', shortName: 'GJ' },
      'sparebank1.no': { name: 'SpareBank 1', color: '#002776', shortName: 'SB1' },
      'posten.no': { name: 'Posten', color: '#e32636', shortName: 'PN' },
      'bring.com': { name: 'Bring', color: '#7cc242', shortName: 'BR' },
      'nrk.no': { name: 'NRK', color: '#26292a', shortName: 'NRK' },
      'ntnu.no': { name: 'NTNU', color: '#00509e', shortName: 'NTNU' },
      'uio.no': { name: 'UiO', color: '#b01c2e', shortName: 'UiO' },
      'uib.no': { name: 'UiB', color: '#d30000', shortName: 'UiB' },
      'sintef.no': { name: 'SINTEF', color: '#003366', shortName: 'SNT' },
      'nibio.no': { name: 'NIBIO', color: '#4caf50', shortName: 'NB' },

      // Government/public
      'dfo.no': { name: 'DFØ', color: '#1a237e', shortName: 'DFØ' },
      'nav.no': { name: 'NAV', color: '#c30000', shortName: 'NAV' },
      'kommune.no': { name: 'Kommune', color: '#2e7d32', shortName: 'KM' },
    };

    // Find matching domain
    let branding = null;
    for (const [key, value] of Object.entries(domainBranding)) {
      if (domain.includes(key) || domain.endsWith(key.split('.')[0] + '.' + key.split('.')[1])) {
        branding = value;
        break;
      }
    }

    // If no specific branding found, extract company name from subdomain or domain
    if (!branding) {
      const parts = domain.split('.');
      let companyName = parts[0];

      // Handle subdomains like "nammo.webcruiter.com" -> show "nammo"
      if (parts.length > 2 && domainBranding[parts.slice(-2).join('.')]) {
        companyName = parts[0].toUpperCase();
        const platform = domainBranding[parts.slice(-2).join('.')];
        return (
          <span
            className="text-[9px] px-1.5 py-0.5 rounded font-bold text-white flex items-center gap-1"
            style={{ backgroundColor: platform.color }}
            title={`${companyName} via ${platform.name}`}
          >
            {companyName.slice(0, 4).toUpperCase()}
          </span>
        );
      }

      // Generic external badge with domain hint
      return (
        <span
          className="text-[9px] px-1.5 py-0.5 rounded font-bold bg-slate-500 text-white flex items-center gap-1"
          title={domain}
        >
          {companyName.slice(0, 4).toUpperCase()}
        </span>
      );
    }

    return (
      <span
        className="text-[9px] px-1.5 py-0.5 rounded font-bold text-white flex items-center gap-1"
        style={{ backgroundColor: branding.color }}
        title={branding.name}
      >
        {branding.shortName}
      </span>
    );
  };

  // Helper: Check if job deadline is expired
  const isDeadlineExpired = (job: Job): boolean => {
    if (!job.deadline) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Remove ~ prefix if present for date parsing
    const deadlineStr = job.deadline.startsWith('~') ? job.deadline.slice(1) : job.deadline;
    const deadline = new Date(deadlineStr);
    return deadline < today;
  };

  // Helper: Format deadline for display
  const formatDeadline = (deadline?: string): string => {
    if (!deadline) return '—';
    // Check if it's an estimated deadline (starts with ~)
    if (deadline.startsWith('~')) {
      const dateStr = deadline.slice(1); // Remove ~ prefix
      const date = new Date(dateStr);
      const formatted = date.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short' });
      return `~${formatted}`; // Show with ~ prefix to indicate "Snarest"
    }
    const date = new Date(deadline);
    return date.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short' });
  };

  // --- AUTO-EXPAND from URL parameter ---
  useEffect(() => {
    if (initialExpandedJobId && jobs.length > 0 && expandedJobId !== initialExpandedJobId) {
      const job = jobs.find(j => j.id === initialExpandedJobId);
      if (job) {
        toggleExpand(job);
      }
    }
  }, [initialExpandedJobId, jobs.length]);

  // --- UNIVERSAL POLLING EFFECT (Only for expanded job application status) ---
  useEffect(() => {
    let interval: any;

    if (expandedJobId) {
        // Reduced frequency to avoid overload, kept specific to open job
        interval = setInterval(async () => {
            await refreshApplicationStatus();
        }, 5000);
    }

    return () => clearInterval(interval);
  }, [expandedJobId]);

  const refreshApplicationStatus = async () => {
      if (!expandedJobId) return;
      setIsRefreshingStatus(true);
      const updatedApp = await api.getApplication(expandedJobId);
      if (updatedApp) {
          setApplicationData(prev => {
              // Only trigger update if status actually changed
              if (JSON.stringify(prev) !== JSON.stringify(updatedApp)) {
                  if (onRefresh) onRefresh();
                  return updatedApp;
              }
              return prev;
          });
      }
      setIsRefreshingStatus(false);
  };


  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dateDropdownRef.current && !dateDropdownRef.current.contains(event.target as Node)) {
        setShowDateDropdown(false);
      }
      if (companyDropdownRef.current && !companyDropdownRef.current.contains(event.target as Node)) {
        setShowExcludedDropdown(false);
        setCompanySearchInDropdown('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // DEFENSIVE FILTERING
  const filteredJobs = useMemo(() => {
    if (!Array.isArray(jobs)) return [];
    
    return jobs.filter(job => {
      if (!job) return false; // Safety check
      
      // Defensive coding: Ensure safe strings before toLowerCase to prevent crashes
      const safeTitle = String(job.title || '');
      const safeCompany = String(job.company || '');
      const safeLocation = String(job.location || '');

      const matchTitle = safeTitle.toLowerCase().includes((filters.title || '').toLowerCase());
      const matchCompany = safeCompany.toLowerCase().includes((filters.company || '').toLowerCase())
        && !excludedCompanies.has(safeCompany);
      const matchLocation = safeLocation.toLowerCase().includes((filters.location || '').toLowerCase());
      
      let matchDate = true;
      if (filters.startDate || filters.endDate) {
         // Use string comparison on YYYY-MM-DD to avoid timezone issues
         const dateStr = job.scannedAt || job.postedDate;
         if (!dateStr) return false;

         // Extract YYYY-MM-DD from ISO string or locale string
         let jobDateStr: string;
         if (dateStr.includes('T')) {
            // ISO format: "2026-03-17T12:00:00Z" → "2026-03-17"
            jobDateStr = dateStr.split('T')[0];
         } else {
            // Try to parse locale date and convert to YYYY-MM-DD
            const parsed = new Date(dateStr);
            if (isNaN(parsed.getTime())) return false;
            jobDateStr = parsed.toISOString().split('T')[0];
         }

         if (filters.startDate && jobDateStr < filters.startDate) matchDate = false;
         if (filters.endDate && jobDateStr > filters.endDate) matchDate = false;
      }

      // Score Filter (slider - minimum score)
      let matchScore = true;
      if (filters.minScore > 0) {
        const score = job.matchScore || 0;
        matchScore = score >= filters.minScore;
      }

      // Application Status Filter
      let matchAppStatus = true;
      if (filters.appStatusFilter !== 'all') {
        const status = job.application_status;
        const hasApp = !!job.application_id;

        if (filters.appStatusFilter === 'sent') {
          // Sent applications (sent or sending)
          matchAppStatus = status === 'sent' || status === 'sending';
        } else if (filters.appStatusFilter === 'written_not_sent') {
          // Written but not sent (draft, approved, failed, manual_review)
          matchAppStatus = hasApp && status !== 'sent' && status !== 'sending';
        } else if (filters.appStatusFilter === 'not_written') {
          // No application written yet
          matchAppStatus = !hasApp;
        }
      }

      // Form Type Filter (Application method)
      let matchFormType = true;
      if (filters.formTypeFilter !== 'all') {
        if (filters.formTypeFilter === 'no_url') {
          matchFormType = !job.external_apply_url;
        } else if (filters.formTypeFilter === 'finn_easy') {
          // For FINN Easy, check both flag and form_type
          matchFormType = job.has_enkel_soknad || job.application_form_type === 'finn_easy';
        } else {
          const formType = job.application_form_type || 'unknown';
          matchFormType = formType === filters.formTypeFilter;
        }
      }

      // Deadline Filter
      let matchDeadline = true;
      if (filters.deadlineFilter !== 'all') {
        const expired = isDeadlineExpired(job);
        const hasDeadline = !!job.deadline;

        if (filters.deadlineFilter === 'expired') {
          matchDeadline = expired;
        } else if (filters.deadlineFilter === 'active') {
          matchDeadline = hasDeadline && !expired;
        } else if (filters.deadlineFilter === 'no_deadline') {
          matchDeadline = !hasDeadline;
        }
      }

      // Source Filter (FINN/NAV/LINKEDIN)
      let matchSource = true;
      if (filters.sourceFilter !== 'all') {
        const jobSource = (job.source || '').toUpperCase();
        matchSource = jobSource === filters.sourceFilter;
      }

      return matchTitle && matchCompany && matchLocation && matchDate && matchScore && matchAppStatus && matchFormType && matchDeadline && matchSource;
    });
  }, [jobs, filters]);

  // Report filtered/selected state to parent for export
  useEffect(() => {
    onExportInfoChange?.({
      filteredJobs,
      selectedIds,
      filters,
      totalJobsCount: jobs.length,
    });
  }, [filteredJobs, selectedIds, filters, jobs.length]);

  const clearDateFilter = () => {
    setFilters(prev => ({ ...prev, startDate: '', endDate: '' }));
    setShowDateDropdown(false);
  };

  const hasValidAnalysis = (job: Job) => {
    if (!job.ai_recommendation) return false;
    if (job.ai_recommendation.length < 20) return false; 
    return true;
  };

  const jobsToExtract = useMemo(() => {
    return filteredJobs.filter(job => 
      selectedIds.has(job.id) && 
      (!job.description || job.description.length < 50) && 
      !descriptions[job.id]
    );
  }, [selectedIds, filteredJobs, descriptions]);

  const jobsToAnalyze = useMemo(() => {
    // Allow re-analyze of any selected job with description (for profile updates)
    return filteredJobs.filter(job =>
      selectedIds.has(job.id) &&
      (job.description && job.description.length >= 50 || descriptions[job.id])
    );
  }, [selectedIds, filteredJobs, descriptions]);

  // Jobs to check for Enkel søknad (all selected jobs)
  const jobsToCheckEnkel = useMemo(() => {
    return filteredJobs.filter(job => selectedIds.has(job.id));
  }, [selectedIds, filteredJobs]);

  // Jobs needing Skyvern URL extraction (no external_apply_url)
  const jobsNeedingUrlExtraction = useMemo(() => {
    return jobs.filter(job => !job.external_apply_url && job.url);
  }, [jobs]);

  // Jobs eligible for Auto-Apply (external forms, not FINN, not already sent)
  const jobsToAutoApply = useMemo(() => {
    return filteredJobs.filter(job =>
      selectedIds.has(job.id) &&
      job.external_apply_url &&  // Has external URL
      !job.has_enkel_soknad &&   // Not FINN Easy
      job.application_form_type !== 'finn_easy' &&  // Not FINN Easy
      job.application_status !== 'sent' &&  // Not already sent
      job.application_status !== 'sending'  // Not currently sending
    );
  }, [selectedIds, filteredJobs]);

  // --- AURA STYLE LOGIC ---
  const getAuraStyle = (job: Job) => {
      if (!job.aura) return '';
      
      const status = job.aura.status;
      // Apply a subtle inset shadow glow based on status
      if (status === 'Toxic') return 'shadow-[inset_0_0_20px_rgba(239,68,68,0.15)] border-l-red-500';
      if (status === 'Growth') return 'shadow-[inset_0_0_20px_rgba(34,197,94,0.15)] border-l-green-500';
      if (status === 'Chill') return 'shadow-[inset_0_0_20px_rgba(59,130,246,0.15)] border-l-blue-500';
      if (status === 'Grind') return 'shadow-[inset_0_0_20px_rgba(168,85,247,0.15)] border-l-purple-500';
      
      return '';
  };

  const getRowStyles = (job: Job, isSelected: boolean) => {
    const base = "transition-all border-l-4 relative overflow-hidden";
    let colors = "";
    const s = (job.status || '').toUpperCase();

    // PRIORITY 1: Check for expired deadline - RED background
    const expired = isDeadlineExpired(job);
    if (expired) {
      if (isSelected) {
        return `${base} bg-red-100 border-l-red-600`;
      }
      return `${base} bg-red-50 border-l-red-500 hover:bg-red-100`;
    }

    // Priority to Aura Glow if analyzed
    const auraGlow = getAuraStyle(job);

    if (s.includes('ANALYZED')) {
        colors = auraGlow ? `bg-white ${auraGlow} hover:brightness-95` : "bg-purple-50/60 border-l-purple-500 hover:bg-purple-100";
    } else if (s.includes('APPLIED') || s.includes('SENT') || s.includes('MANUAL_REVIEW')) {
        colors = "bg-green-50/60 border-l-green-500 hover:bg-green-100";
    } else if (s.includes('REJECTED') || s.includes('FAILED')) {
        colors = "bg-red-50/60 border-l-red-500 hover:bg-red-100";
    } else {
        colors = "bg-white border-l-blue-400 hover:bg-slate-50";
    }

    if (isSelected) {
      return `${base} bg-blue-50 border-l-blue-600`;
    }
    return `${base} ${colors}`;
  };

  const toggleExpand = async (job: Job) => {
    if (expandedJobId === job.id) {
      setExpandedJobId(null);
      setApplicationData(null);
      if (setSidebarCollapsed) setSidebarCollapsed(false);
      navigate({ pathname: '/jobs', search: searchParams.toString() }, { replace: true });
      return;
    }

    if (setSidebarCollapsed) setSidebarCollapsed(true);

    setExpandedJobId(job.id);
    navigate({ pathname: `/jobs/${job.id}`, search: searchParams.toString() }, { replace: true });
    setApplicationData(null);
    setPendingManualSend(false);
    
    const app = await api.getApplication(job.id);
    if (app) {
        setApplicationData(app);
        setOpenSections({ ai: true, tasks: true, desc: false, app: true });
    } else {
        setOpenSections({ ai: true, tasks: true, desc: false, app: false });
    }

    if (!descriptions[job.id] && !job.description) {
      setLoadingDesc(job.id);
      const result = await api.extractJobText(job.id, job.url);
      if (result.success && result.text) {
        setDescriptions(prev => ({ ...prev, [job.id]: result.text! }));
      }
      setLoadingDesc(null);
    } else if (job.description) {
       setDescriptions(prev => ({ ...prev, [job.id]: job.description! }));
    }
  };

  const toggleSection = (key: 'ai' | 'tasks' | 'desc' | 'app') => {
      setOpenSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleWriteSoknad = async (job: Job) => {
     if (!descriptions[job.id] && !job.description) {
         alert("Description missing. Extract details first.");
         return;
     }
     setIsGeneratingApp(true);
     setOpenSections(prev => ({ ...prev, app: true }));
     
     const result = await api.generateApplication(job.id);
     setIsGeneratingApp(false);
     
     if (result.success && result.application) {
         setApplicationData(result.application);
         if (onRefresh) onRefresh(); 
     } else {
         alert("Failed to generate application: " + result.message);
     }
  };

  const handleApproveApp = async () => {
    if (!applicationData) return;
    setIsApproving(true);
    const result = await api.approveApplication(applicationData.id);
    setIsApproving(false);
    if (result.success) {
        setApplicationData({ ...applicationData, status: 'approved' });
        if (onRefresh) onRefresh();
    } else {
        alert("Error approving application: " + result.message);
    }
  };

  const handleSendSkyvern = async () => {
     if (!applicationData) return;
     setIsSending(true);
     const result = await api.sendApplication(applicationData.id);
     setIsSending(false);
     if (result.success) {
         setApplicationData({ ...applicationData, status: 'sending' });
         if (onRefresh) onRefresh();
     } else {
         alert("Failed to send: " + result.message);
     }
  };

  const handleRetrySend = async () => {
      if (!applicationData) return;
      setIsSending(true);
      const result = await api.retrySend(applicationData.id);
      setIsSending(false);
      if (result.success) {
          setApplicationData({ ...applicationData, status: 'approved' });
          if (onRefresh) onRefresh();
      } else {
          alert("Error retrying: " + result.message);
      }
  };

  const [pendingManualSend, setPendingManualSend] = useState(false);

  const handleMarkAsSent = async () => {
      if (!applicationData) return;
      setIsSending(true);
      const result = await api.markAsSent(applicationData.id);
      setIsSending(false);
      if (result.success) {
          setApplicationData({ ...applicationData, status: 'sent', sent_at: new Date().toISOString() });
          setPendingManualSend(false);
          if (onRefresh) onRefresh();
      } else {
          alert("Помилка: " + result.message);
      }
  };

  const handleCancelTask = async () => {
      if (!applicationData) return;
      if (!window.confirm('Ви впевнені? Задачу буде зупинено.')) return;

      setIsCancelling(true);
      const result = await api.cancelTask(applicationData.id);
      setIsCancelling(false);
      if (result.success) {
          setApplicationData({ ...applicationData, status: 'approved' });
          if (onRefresh) onRefresh();
      } else {
          alert("Помилка зупинки: " + result.message);
      }
  };

  // Check if job has FINN Easy Apply (enkel søknad)
  const isFinnEasyApply = (job: Job): boolean => {
      // Priority 1: Check has_enkel_soknad flag
      if (job.has_enkel_soknad) return true;
      // Priority 2: Check application_form_type
      if (job.application_form_type === 'finn_easy') return true;
      // Priority 3: Check URL (fallback)
      if (job.external_apply_url && job.external_apply_url.includes('finn.no/job/apply')) return true;
      return false;
  };

  // Check if application was already sent (block duplicate submissions)
  const isApplicationSent = (job: Job): boolean => {
      return job.application_status === 'sent' || job.application_status === 'sending';
  };

  // Handle filling FINN Easy Apply form via Skyvern
  const handleFillFinnForm = async (job: Job) => {
      if (!isFinnEasyApply(job)) {
          alert("Автозаповнення доступне лише для FINN Enkel Søknad");
          return;
      }
      if (!applicationData) {
          alert("Спочатку напишіть søknad!");
          return;
      }

      // Block duplicate submissions
      if (isApplicationSent(job)) {
          alert("⚠️ Заявку на цю вакансію вже відправлено! Повторна відправка заблокована.");
          return;
      }

      setIsFillingFinnForm(true);
      try {
          const result = await api.fillFinnForm(job.id, applicationData.id);
          if (result.success) {
              let msg = "✅ Заявка відправлена на заповнення! Очікуйте код 2FA в Telegram.";
              if (result.workerWarning) {
                  msg += "\n\n⚠️ " + result.workerWarning;
              }
              alert(msg);
              if (onRefresh) onRefresh();
          } else {
              alert("❌ Помилка: " + result.message);
          }
      } catch (e: any) {
          alert("❌ Помилка: " + e.message);
      } finally {
          setIsFillingFinnForm(false);
      }
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredJobs.length && filteredJobs.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredJobs.map(j => j.id)));
    }
  };

  const toggleSelectOne = (id: string) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedIds(newSet);
  };

  const handleBulkExtract = async () => {
    if (jobsToExtract.length === 0) return;
    setIsProcessingBulk(true);
    let count = 0;
    for (const job of jobsToExtract) {
      const result = await api.extractJobText(job.id, job.url);
      if (result.success && result.text) {
         setDescriptions(prev => ({ ...prev, [job.id]: result.text! }));
         count++;
      }
    }
    setIsProcessingBulk(false);
    if (count > 0 && onRefresh) onRefresh();
  };

  const handleBulkAnalyze = async () => {
    if (jobsToAnalyze.length === 0) return;
    setIsProcessingBulk(true);
    const idsToAnalyze = jobsToAnalyze.map(j => j.id);
    const result = await api.analyzeJobs(idsToAnalyze);
    setIsProcessingBulk(false);
    if (result.success) {
      setTimeout(() => {
         if (onRefresh) onRefresh();
      }, 2000);
    } else {
      alert("Analysis failed: " + result.message);
    }
  };

  // Check Enkel søknad for selected jobs (re-fetch pages)
  const handleCheckEnkelSoknad = async () => {
    if (jobsToCheckEnkel.length === 0) return;
    setIsProcessingBulk(true);
    let count = 0;
    for (const job of jobsToCheckEnkel) {
      const result = await api.extractJobText(job.id, job.url);
      if (result.success) {
        count++;
      }
    }
    setIsProcessingBulk(false);
    if (count > 0 && onRefresh) onRefresh();
  };

  // Bulk Auto-Apply for external forms (not FINN)
  const handleBulkAutoApply = async () => {
    if (jobsToAutoApply.length === 0) return;

    const confirmMessage = `🚀 Auto-Apply для ${jobsToAutoApply.length} вакансій?\n\nСистема:\n1. Створить søknad (якщо немає)\n2. Відправить на заповнення через Skyvern\n3. Зареєструється на сайті (якщо потрібно)\n\nПродовжити?`;
    if (!confirm(confirmMessage)) return;

    setIsProcessingBulk(true);
    let successCount = 0;
    let errorCount = 0;

    for (const job of jobsToAutoApply) {
      try {
        // Step 1: Check if application exists, if not - generate one
        let appId = job.application_id;

        if (!appId) {
          // Need description first
          if (!job.description && !descriptions[job.id]) {
            console.log(`[AutoApply] Extracting description for job ${job.id}`);
            const extractResult = await api.extractJobText(job.id, job.url);
            if (!extractResult.success) {
              console.error(`[AutoApply] Failed to extract description for ${job.id}`);
              errorCount++;
              continue;
            }
          }

          // Generate application
          console.log(`[AutoApply] Generating application for job ${job.id}`);
          const genResult = await api.generateApplication(job.id);
          if (!genResult.success || !genResult.application) {
            console.error(`[AutoApply] Failed to generate application for ${job.id}:`, genResult.message);
            errorCount++;
            continue;
          }
          appId = genResult.application.id;
        }

        // Step 2: Set application status to 'sending'
        console.log(`[AutoApply] Setting status to sending for app ${appId}`);
        const sendResult = await api.sendApplication(appId);
        if (!sendResult.success) {
          console.error(`[AutoApply] Failed to set sending status for ${appId}:`, sendResult.message);
          errorCount++;
          continue;
        }

        successCount++;
        console.log(`[AutoApply] Successfully queued job ${job.id} (${job.company})`);
      } catch (e: any) {
        console.error(`[AutoApply] Error processing job ${job.id}:`, e);
        errorCount++;
      }
    }

    setIsProcessingBulk(false);

    // Show result
    if (successCount > 0) {
      alert(`✅ Auto-Apply завершено!\n\n✓ Успішно: ${successCount}\n✗ Помилок: ${errorCount}\n\nauto_apply.py обробить заявки.`);
      if (onRefresh) onRefresh();
    } else {
      alert(`❌ Жодна заявка не була відправлена.\nПомилок: ${errorCount}`);
    }
  };

  // Re-analyze single job to generate Radar data
  const handleReanalyzeForRadar = async (jobId: string) => {
    setReanalyzingRadarId(jobId);
    try {
      const result = await api.analyzeJobs([jobId]);
      if (result.success) {
        setTimeout(() => {
          if (onRefresh) onRefresh();
        }, 1500);
      } else {
        alert("Radar generation failed: " + result.message);
      }
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      setReanalyzingRadarId(null);
    }
  };

  // Re-analyze selected jobs (including already analyzed)
  const jobsToReanalyze = useMemo(() => {
    return filteredJobs.filter(job =>
      selectedIds.has(job.id) &&
      (job.description && job.description.length >= 50 || descriptions[job.id])
    );
  }, [selectedIds, filteredJobs, descriptions]);

  const handleReanalyze = async () => {
    if (jobsToReanalyze.length === 0) return;
    if (!confirm(`🤖 Проаналізувати ${jobsToReanalyze.length} вакансій?\n\nЦе оновить оцінку релевантності для вибраних вакансій.`)) return;

    setIsProcessingBulk(true);
    const jobIds = jobsToReanalyze.map(j => j.id);
    const result = await api.analyzeJobs(jobIds);
    setIsProcessingBulk(false);

    if (result.success !== false) {
      alert(`✅ Проаналізовано ${jobIds.length} вакансій!`);
      if (onRefresh) onRefresh();
    } else {
      alert(`❌ Помилка: ${result.message}`);
    }
  };

  const renderStatusBadge = (app: Application) => {
      const badgeBase = "px-2 py-1 text-xs rounded-full font-bold flex items-center gap-1";
      let badgeContent = null;
      let sourceBadge = null;

      if (app.skyvern_metadata && app.skyvern_metadata.source === 'telegram') {
          sourceBadge = <span className="px-2 py-1 bg-indigo-50 text-indigo-600 text-xs rounded-full flex items-center gap-1 font-medium border border-indigo-100"><Smartphone size={10}/> Telegram</span>;
      }

      if (app.status === 'sending') {
          badgeContent = (
            <div className="flex items-center gap-2">
               <span className={`${badgeBase} bg-yellow-100 text-yellow-800`}>
                 <Loader2 size={12} className="animate-spin"/> Sending...
               </span>
               <button onClick={handleCancelTask} disabled={isCancelling} className="text-red-400 hover:text-red-600 disabled:opacity-50" title="Зупинити задачу">
                  {isCancelling ? <Loader2 size={14} className="animate-spin"/> : <StopCircle size={14}/>}
               </button>
               <button onClick={refreshApplicationStatus} className="text-slate-400 hover:text-blue-600" title="Force Refresh">
                  <RotateCw size={12} className={isRefreshingStatus ? "animate-spin" : ""} />
               </button>
            </div>
          );
      } else if (app.status === 'manual_review') {
          badgeContent = <span className={`${badgeBase} bg-green-100 text-green-800`}><CheckCircle size={12}/> Skyvern Done</span>;
      } else if (app.status === 'sent') {
           badgeContent = <span className={`${badgeBase} bg-blue-100 text-blue-800`}><Rocket size={12}/> {t('jobs.status.sent')}</span>;
      } else if (app.status === 'failed') {
          badgeContent = <span className={`${badgeBase} bg-red-100 text-red-800`}><AlertCircle size={12}/> Failed</span>;
      } else if (app.status === 'approved') {
          badgeContent = <span className={`${badgeBase} bg-green-50 text-green-700`}><CheckCircle size={12}/> Approved</span>;
      }

      return <div className="flex gap-2 items-center">{sourceBadge}{badgeContent}</div>;
  };

  // Component to render expansion details
  const renderExpansionContent = (job: Job) => (
    <div className="flex flex-col border-l-[4px] border-blue-600 bg-white animate-fade-in shadow-inner">
      
      {/* 1. AI Analysis & RADAR */}
      <div className="border-b border-slate-100">
         <div onClick={() => toggleSection('ai')} className="flex items-center justify-between p-3 cursor-pointer hover:bg-slate-50">
            <div className="flex items-center gap-2 text-purple-700 font-bold text-sm"><Bot size={16} /> {t('jobs.sections.aiAnalysis')}</div>
            <div className="flex items-center gap-4">
                {job.cost_usd ? (
                    <span className="text-xs text-slate-400 flex items-center gap-1 bg-slate-100 px-2 py-0.5 rounded-full">
                        <DollarSign size={10} /> Cost: ${job.cost_usd.toFixed(4)}
                    </span>
                ) : null}
                <div className="text-slate-400">{openSections.ai ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</div>
            </div>
         </div>
         
         {openSections.ai && (
            <div className="px-4 pb-4 pt-1 bg-white">
                {/* GRID LAYOUT: RADAR vs TEXT */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {/* LEFT: RADAR CHART */}
                    <div className="md:col-span-1 h-[200px] relative flex items-center justify-center bg-slate-50 rounded-lg border border-slate-100 p-2">
                        {job.radarData ? (
                            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                                <RadarChart cx="50%" cy="50%" outerRadius="70%" data={job.radarData}>
                                <PolarGrid />
                                <PolarAngleAxis dataKey="subject" tick={{ fontSize: 10 }} />
                                <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
                                <Radar
                                    name="Fit"
                                    dataKey="A"
                                    stroke="#8884d8"
                                    fill="#8884d8"
                                    fillOpacity={0.6}
                                />
                                </RadarChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="text-center flex flex-col items-center justify-center gap-3">
                                <div className="text-slate-400 text-xs italic">
                                    Radar data not available for this job.
                                </div>
                                <button
                                    onClick={() => handleReanalyzeForRadar(job.id)}
                                    disabled={reanalyzingRadarId === job.id}
                                    className="bg-gradient-to-r from-purple-500 to-blue-500 text-white px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 hover:from-purple-600 hover:to-blue-600 transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {reanalyzingRadarId === job.id ? (
                                        <>
                                            <Loader2 size={14} className="animate-spin" />
                                            Generating...
                                        </>
                                    ) : (
                                        <>
                                            <Zap size={14} />
                                            Generate Radar
                                        </>
                                    )}
                                </button>
                            </div>
                        )}
                        
                        {/* AURA EXPLANATION OVERLAY */}
                        {job.aura && (
                            <div className="absolute top-2 right-2 text-[10px] bg-white/80 p-1.5 rounded shadow backdrop-blur-sm max-w-[150px]">
                                <b>Aura: {job.aura.status}</b><br/>
                                {job.aura.tags.map(tag => <span key={tag} className="inline-block mr-1 mb-1 px-1 bg-slate-100 rounded">{tag}</span>)}
                            </div>
                        )}
                    </div>

                    {/* RIGHT: TEXT ANALYSIS */}
                    <div className="md:col-span-2 text-sm text-slate-700 max-h-[200px] overflow-y-auto custom-scrollbar p-2">
                        {hasValidAnalysis(job) ? <p className="whitespace-pre-wrap">{job.ai_recommendation}</p> : <span className="text-slate-400 italic">No analysis available.</span>}
                    </div>
                </div>
            </div>
         )}
      </div>

      {/* 2. Tasks Summary */}
      <div className="border-b border-slate-100">
         <div onClick={() => toggleSection('tasks')} className="flex items-center justify-between p-3 cursor-pointer hover:bg-slate-50">
            <div className="flex items-center gap-2 text-blue-700 font-bold text-sm"><ListChecks size={16} /> {t('jobs.sections.duties')}</div>
            <div className="text-slate-400">{openSections.tasks ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</div>
         </div>
         {openSections.tasks && (
            <div className="px-4 pb-4 pt-1 text-sm text-slate-700 bg-white">
                {job.tasks_summary ? (
                    <div className="whitespace-pre-wrap bg-blue-50/50 p-3 rounded-lg border border-blue-100 text-slate-800">{job.tasks_summary}</div>
                ) : (
                    <span className="text-slate-400 italic">Summary not available yet. Run analysis to generate.</span>
                )}
            </div>
         )}
      </div>

      {/* 3. Description */}
      <div className="border-b border-slate-100">
         <div onClick={() => toggleSection('desc')} className="flex items-center justify-between p-3 cursor-pointer hover:bg-slate-50">
            <div className="flex items-center gap-2 text-slate-700 font-bold text-sm"><FileText size={16} /> {t('jobs.sections.description')}</div>
            <div className="text-slate-400">{openSections.desc ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</div>
         </div>
         {openSections.desc && <div className="px-4 pb-4 pt-1 text-sm text-slate-600 bg-white max-h-[300px] overflow-y-auto">{loadingDesc === job.id ? <Loader2 className="animate-spin mx-auto" /> : <div className="whitespace-pre-wrap">{descriptions[job.id] || job.description || "No description."}</div>}</div>}
      </div>

      {/* 4. Application */}
      <div className="">
         <div onClick={() => toggleSection('app')} className="flex items-center justify-between p-3 cursor-pointer hover:bg-green-50/50 bg-green-50/20">
            <div className="flex items-center gap-2 text-green-700 font-bold text-sm"><PenTool size={16} /> {t('jobs.sections.application')}</div>
            
            <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                {applicationData ? (
                    <>
                        {renderStatusBadge(applicationData)}
                        {applicationData.status === 'draft' && <button onClick={handleApproveApp} disabled={isApproving} className="text-xs bg-green-600 text-white px-3 py-1.5 rounded hover:bg-green-700 flex items-center gap-1 shadow-sm">{isApproving ? <Loader2 size={12} className="animate-spin"/> : <CheckCircle size={12}/>} {t('jobs.actions.approve')}</button>}
                        {applicationData.status === 'approved' && !pendingManualSend &&
                            <button onClick={() => setPendingManualSend(true)} className="text-xs bg-amber-500 text-white px-3 py-1.5 rounded hover:bg-amber-600 flex items-center gap-1 shadow-sm"><ExternalLink size={12}/> {t('jobs.actions.sendManually')}</button>
                        }
                        {applicationData.status === 'approved' && pendingManualSend &&
                            <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg">
                                <span className="text-xs text-amber-700">{t('jobs.actions.sendManually')}?</span>
                                <button onClick={handleMarkAsSent} disabled={isSending} className="text-xs bg-green-600 text-white px-3 py-1.5 rounded hover:bg-green-700 flex items-center gap-1 shadow-sm">{isSending ? <Loader2 size={12} className="animate-spin"/> : <CheckCircle size={12}/>} {t('jobs.actions.confirmSent')}</button>
                                <button onClick={() => setPendingManualSend(false)} className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1"><X size={12}/></button>
                            </div>
                        }
                        {(applicationData.status === 'failed' || applicationData.status === 'manual_review') &&
                            <button onClick={handleRetrySend} disabled={isSending} className="text-xs bg-orange-500 text-white px-3 py-1.5 rounded hover:bg-orange-600 flex items-center gap-1 shadow-sm">
                                <RotateCw size={12}/> {t('jobs.actions.resetStatus')}
                            </button>
                        }
                        {applicationData.status === 'sent' &&
                            <button onClick={handleRetrySend} disabled={isSending} className="text-xs bg-slate-400 text-white px-3 py-1.5 rounded hover:bg-slate-500 flex items-center gap-1 shadow-sm">
                                <RotateCw size={12}/> {t('jobs.actions.resetStatus')}
                            </button>
                        }
                        {/* FINN Easy Apply Button */}
                        {isFinnEasyApply(job) ? (
                            isApplicationSent(job) ? (
                                <span
                                    className="text-xs bg-green-100 text-green-700 px-3 py-1.5 rounded flex items-center gap-1 cursor-not-allowed"
                                    title="Заявку вже відправлено на цю вакансію"
                                >
                                    <CheckCircle size={12}/> Відправлено
                                </span>
                            ) : (
                                <button
                                    onClick={() => handleFillFinnForm(job)}
                                    disabled={isFillingFinnForm || applicationData.status === 'sending'}
                                    className="text-xs bg-gradient-to-r from-blue-600 to-cyan-600 text-white px-3 py-1.5 rounded hover:from-blue-700 hover:to-cyan-700 flex items-center gap-1 shadow-sm disabled:opacity-50"
                                    title="Заповнити форму на FINN.no"
                                >
                                    {isFillingFinnForm ? <Loader2 size={12} className="animate-spin"/> : <Zap size={12}/>}
                                    FINN Søknad
                                </button>
                            )
                        ) : job.external_apply_url ? (
                            <span
                                className="text-xs bg-slate-200 text-slate-500 px-3 py-1.5 rounded flex items-center gap-1 cursor-not-allowed"
                                title={`Автозаповнення недоступне. URL: ${job.external_apply_url}`}
                            >
                                <ExternalLink size={12}/> Вручну
                            </span>
                        ) : null}
                    </>
                ) : (
                    <button onClick={() => handleWriteSoknad(job)} disabled={(!descriptions[job.id] && !job.description)} className={`text-xs px-3 py-1.5 rounded font-medium text-white flex items-center gap-1 shadow-sm ${(!descriptions[job.id] && !job.description) ? 'bg-slate-300' : 'bg-green-600 hover:bg-green-700'}`}><Sparkles size={12} /> {t('jobs.actions.writeSoknad')}</button>
                )}
                <div className="text-slate-400 pl-2 border-l">{openSections.app ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</div>
            </div>
         </div>
         
         {openSections.app && (
            <div className="p-6 border-t border-slate-100 text-sm bg-white">
               {isGeneratingApp ? <div className="text-center py-8 text-slate-500"><Loader2 className="animate-spin mx-auto mb-2" /> Writing...</div> : 
               applicationData ? (
                  <div className="space-y-4">
                      <div className="flex justify-between items-center">
                        <h5 className="font-bold text-xs text-slate-500">Norsk</h5>
                        <div className="flex items-center gap-2">
                          {applicationData.cost_usd && <span className="text-[10px] text-slate-400">Est. Cost: ${applicationData.cost_usd.toFixed(4)}</span>}
                          <button
                            onClick={() => copyToClipboard(applicationData.cover_letter_no || '', `no-${applicationData.id}`)}
                            className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                            title="Копіювати норвезький текст"
                          >
                            {copiedField === `no-${applicationData.id}` ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                            {copiedField === `no-${applicationData.id}` ? 'Скопійовано!' : 'Копіювати'}
                          </button>
                        </div>
                      </div>
                      <div
                        onClick={() => copyToClipboard(applicationData.cover_letter_no || '', `no-${applicationData.id}`)}
                        className="p-3 bg-slate-50 rounded border whitespace-pre-wrap cursor-pointer hover:bg-slate-100 transition-colors"
                        title="Натисни щоб скопіювати"
                      >
                        {applicationData.cover_letter_no}
                      </div>
                      {applicationData.cover_letter_uk && (
                        <div>
                          <div className="flex justify-between items-center">
                            <h5 className="font-bold text-xs text-slate-500">Ukrainian</h5>
                            <button
                              onClick={() => copyToClipboard(applicationData.cover_letter_uk || '', `uk-${applicationData.id}`)}
                              className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                              title="Копіювати український текст"
                            >
                              {copiedField === `uk-${applicationData.id}` ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                              {copiedField === `uk-${applicationData.id}` ? 'Скопійовано!' : 'Копіювати'}
                            </button>
                          </div>
                          <div
                            onClick={() => copyToClipboard(applicationData.cover_letter_uk || '', `uk-${applicationData.id}`)}
                            className="p-3 bg-slate-50 rounded border whitespace-pre-wrap text-slate-600 cursor-pointer hover:bg-slate-100 transition-colors mt-1"
                            title="Натисни щоб скопіювати"
                          >
                            {applicationData.cover_letter_uk}
                          </div>
                        </div>
                      )}
                  </div>
               ) : <div className="text-center py-4 text-slate-400 italic">No application generated yet.</div>}
            </div>
         )}
      </div>

    </div>
  );

  return (
    <div className="space-y-4">
      {/* TOOLBAR */}
      <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm flex flex-col md:flex-row flex-wrap md:items-center gap-3">
        <div className="flex-1 flex items-center gap-2 min-w-[200px]">
            {/* Company filter with exclusion dropdown */}
            <div className="relative flex-1 hidden md:block" ref={companyDropdownRef}>
                <Building className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
                <input
                  type="text"
                  placeholder={t('jobs.companyPlaceholder')}
                  className={`w-full pl-8 pr-8 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${excludedCompanies.size > 0 ? 'border-red-300 bg-red-50/30' : 'border-slate-200'}`}
                  value={filters.company}
                  onChange={e => setFilters({...filters, company: e.target.value})}
                />
                <button
                  onClick={() => setShowExcludedDropdown(!showExcludedDropdown)}
                  className={`absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded ${excludedCompanies.size > 0 ? 'text-red-500 hover:bg-red-100' : 'text-slate-400 hover:bg-slate-100'}`}
                  title={excludedCompanies.size > 0 ? `Виключено: ${excludedCompanies.size}` : 'Виключити компанії'}
                >
                  <EyeOff size={14} />
                  {excludedCompanies.size > 0 && (
                    <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] font-bold rounded-full w-3.5 h-3.5 flex items-center justify-center">{excludedCompanies.size}</span>
                  )}
                </button>
                {showExcludedDropdown && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-lg shadow-xl border z-50 p-2 min-w-[280px] max-h-[400px] flex flex-col">
                    <div className="flex items-center justify-between mb-2 pb-2 border-b">
                      <span className="text-xs font-semibold text-slate-700">Виключити компанії</span>
                      {excludedCompanies.size > 0 && (
                        <button onClick={() => { clearExcludedCompanies(); }} className="text-xs text-red-500 hover:text-red-700">Очистити ({excludedCompanies.size})</button>
                      )}
                    </div>
                    <input
                      type="text"
                      placeholder="Пошук компанії..."
                      className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded mb-2 focus:outline-none focus:ring-1 focus:ring-blue-400"
                      value={companySearchInDropdown}
                      onChange={e => setCompanySearchInDropdown(e.target.value)}
                      autoFocus
                    />
                    <div className="overflow-y-auto flex-1 max-h-[280px]">
                      {uniqueCompanies
                        .filter(c => c.toLowerCase().includes(companySearchInDropdown.toLowerCase()))
                        .map(c => (
                        <label key={c} className="flex items-center gap-2 py-1 px-1 hover:bg-slate-50 rounded cursor-pointer text-sm">
                          <input
                            type="checkbox"
                            checked={excludedCompanies.has(c)}
                            onChange={() => toggleExcludeCompany(c)}
                            className="rounded border-slate-300 text-red-500 focus:ring-red-400"
                          />
                          <span className={`truncate ${excludedCompanies.has(c) ? 'text-red-500 line-through' : 'text-slate-700'}`}>{c}</span>
                          <span className="ml-auto text-[10px] text-slate-400">{companyCounts.get(c) || 0}</span>
                        </label>
                      ))}
                    </div>
                    <button
                      onClick={() => { setShowExcludedDropdown(false); setCompanySearchInDropdown(''); }}
                      className="mt-2 pt-2 border-t w-full py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
                    >
                      Готово{excludedCompanies.size > 0 ? ` (виключено: ${excludedCompanies.size})` : ''}
                    </button>
                  </div>
                )}
            </div>
            <div className="relative flex-1 hidden md:block">
                <MapPin className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
                <input type="text" placeholder={t('jobs.locationPlaceholder')} className="w-full pl-8 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" value={filters.location} onChange={e => setFilters({...filters, location: e.target.value})} />
            </div>
            <div className="relative" ref={dateDropdownRef}>
                <button onClick={() => setShowDateDropdown(!showDateDropdown)} className={`flex items-center gap-2 px-3 py-2 text-sm border rounded-lg hover:bg-slate-50 ${filters.startDate || filters.endDate ? 'bg-blue-50 text-blue-700 border-blue-200' : 'border-slate-200 text-slate-600'}`}>
                    <Calendar size={14} /> <span>{filters.startDate ? 'Filtered' : t('jobs.dateFilter')}</span>
                </button>
                {showDateDropdown && (
                    <DateRangePicker
                        startDate={filters.startDate}
                        endDate={filters.endDate}
                        onRangeChange={(start, end) => {
                            setFilters(prev => ({ ...prev, startDate: start, endDate: end }));
                        }}
                        onClose={() => setShowDateDropdown(false)}
                    />
                )}
            </div>

            {/* Score Filter - Slider */}
            <div className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg ${filters.minScore > 0 ? 'bg-purple-50 border-purple-200' : 'border-slate-200'}`}>
              <span className="text-xs text-slate-500 whitespace-nowrap">Score ≥</span>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={filters.minScore}
                onChange={e => setFilters({...filters, minScore: Number(e.target.value)})}
                className="w-24 h-1.5 accent-purple-600 cursor-pointer"
              />
              <span className={`text-xs font-bold min-w-[28px] ${filters.minScore >= 80 ? 'text-green-600' : filters.minScore >= 50 ? 'text-purple-600' : 'text-slate-500'}`}>
                {filters.minScore}
              </span>
            </div>

            {/* Application Status Filter */}
            <select
              value={filters.appStatusFilter}
              onChange={e => setFilters({...filters, appStatusFilter: e.target.value as any})}
              className={`px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${filters.appStatusFilter !== 'all' ? (filters.appStatusFilter === 'sent' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200') : 'border-slate-200 text-slate-600'}`}
            >
              <option value="all">{t('jobs.filters.applicationAll')}</option>
              <option value="sent">{t('jobs.filters.applicationSent')}</option>
              <option value="written_not_sent">{t('jobs.filters.applicationWritten')}</option>
              <option value="not_written">{t('jobs.filters.applicationNone')}</option>
            </select>

            {/* Form Type Filter (Application method) */}
            <select
              value={filters.formTypeFilter}
              onChange={e => setFilters({...filters, formTypeFilter: e.target.value as any})}
              className={`px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${filters.formTypeFilter !== 'all' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'border-slate-200 text-slate-600'}`}
            >
              <option value="all">{t('jobs.filters.formAll')}</option>
              <option value="no_url">{t('jobs.filters.formNoUrl')} ({jobsNeedingUrlExtraction.length})</option>
              <option value="finn_easy">{t('jobs.filters.formFinnEasy')}</option>
              <option value="external_form">{t('jobs.filters.formExternal')}</option>
              <option value="external_registration">{t('jobs.filters.formRegistration')}</option>
              <option value="unknown">{t('jobs.filters.formUnknown')}</option>
            </select>

            {/* Deadline Filter */}
            <select
              value={filters.deadlineFilter}
              onChange={e => setFilters({...filters, deadlineFilter: e.target.value as any})}
              className={`px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${filters.deadlineFilter !== 'all' ? (filters.deadlineFilter === 'expired' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-green-50 text-green-700 border-green-200') : 'border-slate-200 text-slate-600'}`}
            >
              <option value="all">{t('jobs.filters.deadlineAll')}</option>
              <option value="expired">{t('jobs.filters.deadlineExpired')}</option>
              <option value="active">{t('jobs.filters.deadlineActive')}</option>
              <option value="no_deadline">{t('jobs.filters.deadlineNone')}</option>
            </select>

            {/* Source Filter (FINN/NAV/LinkedIn) */}
            <select
              value={filters.sourceFilter}
              onChange={e => setFilters({...filters, sourceFilter: e.target.value as any})}
              className={`px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${filters.sourceFilter !== 'all' ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'border-slate-200 text-slate-600'}`}
            >
              <option value="all">{t('jobs.filters.sourceAll')}</option>
              <option value="FINN">🏠 FINN</option>
              <option value="NAV">🏛️ NAV</option>
              <option value="LINKEDIN">💼 LinkedIn</option>
            </select>
        </div>

        <div className="flex items-center gap-2 pl-0 md:pl-3 md:border-l border-slate-200 justify-between md:justify-start w-full md:w-auto">
          {selectedIds.size > 0 ? (
            <>
              <button
                onClick={handleBulkExtract}
                disabled={isProcessingBulk || jobsToExtract.length === 0}
                title="Extract description"
                className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                   jobsToExtract.length > 0 ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
              >
                 {isProcessingBulk ? <Loader2 className="animate-spin" size={14} /> : <Download size={14} />}
                 <span className="inline">{t('jobs.extract')}</span> {jobsToExtract.length > 0 && <span className="bg-white/20 px-1.5 rounded text-xs">{jobsToExtract.length}</span>}
              </button>
              <HelpTip text={t('jobs.help.extract')} />

              {/* Re-analyze button (for selected jobs with descriptions) */}
              <button
                onClick={handleReanalyze}
                disabled={isProcessingBulk || jobsToReanalyze.length === 0}
                className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                   jobsToReanalyze.length > 0 ? 'bg-violet-600 text-white hover:bg-violet-700' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
              >
                 {isProcessingBulk ? <Loader2 className="animate-spin" size={14} /> : <Brain size={14} />}
                 <span className="hidden md:inline">{t('jobs.reanalyze')}</span> {jobsToReanalyze.length > 0 && <span className="bg-white/20 px-1.5 rounded text-xs">{jobsToReanalyze.length}</span>}
              </button>
              <HelpTip text={t('jobs.help.reanalyze')} />

              <button
                onClick={handleCheckEnkelSoknad}
                disabled={isProcessingBulk || jobsToCheckEnkel.length === 0}
                className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                   jobsToCheckEnkel.length > 0 ? 'bg-cyan-600 text-white hover:bg-cyan-700' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
              >
                 {isProcessingBulk ? <Loader2 className="animate-spin" size={14} /> : <Zap size={14} />}
                 <span className="hidden md:inline">{t('jobs.filters.formAll').split(':')[0]}</span> {jobsToCheckEnkel.length > 0 && <span className="bg-white/20 px-1.5 rounded text-xs">{jobsToCheckEnkel.length}</span>}
              </button>
              <HelpTip text={t('jobs.help.formType')} />

              <button
                onClick={handleBulkAutoApply}
                disabled={isProcessingBulk || jobsToAutoApply.length === 0}
                className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                   jobsToAutoApply.length > 0 ? 'bg-gradient-to-r from-green-600 to-emerald-600 text-white hover:from-green-700 hover:to-emerald-700 shadow-sm' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
              >
                 {isProcessingBulk ? <Loader2 className="animate-spin" size={14} /> : <Rocket size={14} />}
                 <span className="hidden md:inline">Auto-Apply</span> {jobsToAutoApply.length > 0 && <span className="bg-white/20 px-1.5 rounded text-xs">{jobsToAutoApply.length}</span>}
              </button>
              <HelpTip text={t('jobs.help.autoApply')} />

            </>
          ) : null}
        </div>
      </div>

      {/* TABLE VIEW (Desktop) */}
      <div className="hidden md:block bg-white shadow-sm rounded-xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto min-h-[400px]">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs uppercase text-slate-500 font-semibold tracking-wider">
              <tr>
                <th className="px-4 py-3 w-10">
                  <button onClick={toggleSelectAll} className="text-slate-400 hover:text-blue-600">
                    {selectedIds.size === filteredJobs.length && filteredJobs.length > 0 ? <CheckSquare size={18} /> : <Square size={18} />}
                  </button>
                </th>
                <th className="px-4 py-3 w-10"></th>
                <th className="px-4 py-3"><div className="flex items-center gap-1">
                  <button onClick={(e) => { e.stopPropagation(); onToggleExportColumn?.('title'); }} className="text-slate-400 hover:text-blue-600" title="Включити в експорт">
                    {exportColumns?.has('title') ? <CheckSquare size={14} className="text-blue-500" /> : <Square size={14} className="text-slate-300" />}
                  </button>
                  {t('jobs.table.title')}
                </div></th>
                <th className="px-4 py-3"><div className="flex items-center gap-1">
                  <button onClick={(e) => { e.stopPropagation(); onToggleExportColumn?.('company'); }} className="text-slate-400 hover:text-blue-600" title="Включити в експорт">
                    {exportColumns?.has('company') ? <CheckSquare size={14} className="text-blue-500" /> : <Square size={14} className="text-slate-300" />}
                  </button>
                  {t('jobs.table.company')}
                </div></th>
                <th className="px-4 py-3 w-28"><div className="flex items-center gap-1">
                  <button onClick={(e) => { e.stopPropagation(); onToggleExportColumn?.('location'); }} className="text-slate-400 hover:text-blue-600" title="Включити в експорт">
                    {exportColumns?.has('location') ? <CheckSquare size={14} className="text-blue-500" /> : <Square size={14} className="text-slate-300" />}
                  </button>
                  {t('jobs.table.location')}
                </div></th>
                <th className="px-4 py-3"><div className="flex items-center gap-1">
                  <button onClick={(e) => { e.stopPropagation(); onToggleExportColumn?.('added'); }} className="text-slate-400 hover:text-blue-600" title="Включити в експорт">
                    {exportColumns?.has('added') ? <CheckSquare size={14} className="text-blue-500" /> : <Square size={14} className="text-slate-300" />}
                  </button>
                  {t('jobs.table.added')}
                </div></th>
                <th className="px-4 py-3"><div className="flex items-center gap-1">
                  <button onClick={(e) => { e.stopPropagation(); onToggleExportColumn?.('deadline'); }} className="text-slate-400 hover:text-blue-600" title="Включити в експорт">
                    {exportColumns?.has('deadline') ? <CheckSquare size={14} className="text-blue-500" /> : <Square size={14} className="text-slate-300" />}
                  </button>
                  Frist
                </div></th>
                <th className="px-4 py-3"><div className="flex items-center gap-1">
                  <button onClick={(e) => { e.stopPropagation(); onToggleExportColumn?.('match'); }} className="text-slate-400 hover:text-blue-600" title="Включити в експорт">
                    {exportColumns?.has('match') ? <CheckSquare size={14} className="text-blue-500" /> : <Square size={14} className="text-slate-300" />}
                  </button>
                  {t('jobs.table.match')}
                </div></th>
                <th className="px-4 py-3 text-center"><div className="flex items-center justify-center gap-1">
                  <button onClick={(e) => { e.stopPropagation(); onToggleExportColumn?.('soknad'); }} className="text-slate-400 hover:text-blue-600" title="Включити в експорт">
                    {exportColumns?.has('soknad') ? <CheckSquare size={14} className="text-blue-500" /> : <Square size={14} className="text-slate-300" />}
                  </button>
                  Søknad
                </div></th>
                <th className="px-4 py-3 text-center"><div className="flex items-center justify-center gap-1">
                  <button onClick={(e) => { e.stopPropagation(); onToggleExportColumn?.('formtype'); }} className="text-slate-400 hover:text-blue-600" title="Включити в експорт">
                    {exportColumns?.has('formtype') ? <CheckSquare size={14} className="text-blue-500" /> : <Square size={14} className="text-slate-300" />}
                  </button>
                  Подача
                </div></th>
                <th className="px-4 py-3 text-right"><div className="flex items-center justify-end gap-1">
                  <button onClick={(e) => { e.stopPropagation(); onToggleExportColumn?.('url'); }} className="text-slate-400 hover:text-blue-600" title="Включити в експорт">
                    {exportColumns?.has('url') ? <CheckSquare size={14} className="text-blue-500" /> : <Square size={14} className="text-slate-300" />}
                  </button>
                  {t('jobs.table.link')}
                </div></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredJobs.length === 0 ? (
                  <tr>
                      <td colSpan={11} className="px-4 py-12 text-center text-slate-400 italic">
                          No jobs found matching filters.
                      </td>
                  </tr>
              ) : filteredJobs.map((job) => (
                <React.Fragment key={job.id}>
                  <tr className={`${getRowStyles(job, selectedIds.has(job.id))} group cursor-pointer`} onClick={() => toggleExpand(job)}>
                    <td className="px-4 py-4" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => toggleSelectOne(job.id)} className="text-slate-400 hover:text-blue-600">
                            {selectedIds.has(job.id) ? <CheckSquare size={18} className="text-blue-600" /> : <Square size={18} />}
                        </button>
                    </td>
                    <td className="px-4 py-4 text-slate-400">
                        {expandedJobId === job.id ? <ChevronUp size={18} /> : <ChevronDown size={18} className="group-hover:text-blue-500" />}
                    </td>
                    <td className="px-4 py-4">
                        <span className="font-medium text-slate-900 block flex items-center gap-2">
                            {job.title}
                            {job.position_uk && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-amber-50 text-amber-700 border border-amber-200 whitespace-nowrap">
                                    {job.position_uk}
                                </span>
                            )}
                        </span>
                        {getSourceBadge(job.source, 'sm')}
                    </td>
                    <td className="px-4 py-4 text-slate-600">{job.company}</td>
                    <td className="px-4 py-4 text-slate-500 w-28 max-w-[112px] truncate" title={job.location}>{job.location}</td>
                    <td className="px-4 py-4 text-slate-500 text-xs">{job.postedDate}</td>
                    <td className="px-4 py-4">
                      {job.deadline ? (
                        <span className={`text-xs font-medium px-2 py-1 rounded ${
                          isDeadlineExpired(job)
                            ? 'bg-red-100 text-red-700'
                            : isEstimatedDeadline(job.deadline)
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-green-50 text-green-700'
                        }`} title={isEstimatedDeadline(job.deadline) ? 'Snarest - estimated deadline' : undefined}>
                          {formatDeadline(job.deadline)}
                        </span>
                      ) : (
                        <span className="text-slate-300 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      {job.matchScore ? (
                        <div className="flex items-center gap-2">
                          <div className="w-full max-w-[40px] bg-slate-100 rounded-full h-1.5"><div className={`h-1.5 rounded-full ${job.matchScore >= 80 ? 'bg-green-500' : job.matchScore >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: `${job.matchScore}%` }}></div></div>
                          <span className={`font-bold text-xs ${job.matchScore >= 80 ? 'text-green-600' : job.matchScore >= 50 ? 'text-yellow-600' : 'text-red-600'}`}>{job.matchScore}</span>
                        </div>
                      ) : <span className="text-slate-300 text-xs">-</span>}
                    </td>
                    <td className="px-4 py-4 text-center">
                      {job.application_id ? (
                        job.application_status === 'sent' ? (
                          <span className="inline-flex items-center justify-center px-2 py-1 rounded-full bg-green-500 text-white text-xs font-bold" title={`Відправлено ${job.application_sent_at ? new Date(job.application_sent_at).toLocaleDateString() : ''}`}>
                            ✅
                          </span>
                        ) : job.application_status === 'sending' ? (
                          <div className="inline-flex items-center gap-1">
                            <span className="inline-flex items-center justify-center px-2 py-1 rounded-full bg-yellow-400 text-yellow-900 text-xs font-bold animate-pulse" title="Відправляється...">
                              ⏳
                            </span>
                            <button
                              onClick={(e) => { e.stopPropagation(); if (job.application_id && window.confirm('Зупинити задачу?')) { api.cancelTask(job.application_id).then(() => onRefresh?.()); }}}
                              className="text-red-400 hover:text-red-600"
                              title="Зупинити"
                            >
                              <StopCircle size={14}/>
                            </button>
                          </div>
                        ) : job.application_status === 'failed' ? (
                          <span className="inline-flex items-center justify-center px-2 py-1 rounded-full bg-red-500 text-white text-xs font-bold" title="Помилка відправки">
                            ❌
                          </span>
                        ) : job.application_status === 'approved' ? (
                          <span className="inline-flex items-center justify-center px-2 py-1 rounded-full bg-blue-500 text-white text-xs font-bold" title="Затверджено, готово до відправки">
                            ✓
                          </span>
                        ) : (
                          <span className="inline-flex items-center justify-center px-2 py-1 rounded-full bg-slate-400 text-white text-xs font-bold" title="Чернетка">
                            📝
                          </span>
                        )
                      ) : (
                        <span className="text-slate-300 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-center">
                      {/* Priority 1: FINN Easy Apply (check flag first, not URL) */}
                      {(job.has_enkel_soknad || job.application_form_type === 'finn_easy') ? (
                        <span className="inline-flex items-center justify-center px-2 py-1 rounded-full bg-blue-500 text-white text-xs font-bold" title="FINN Enkel søknad - автозаповнення доступне">
                          ⚡
                        </span>
                      ) : job.external_apply_url ? (
                        <a
                          href={job.external_apply_url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 cursor-pointer hover:ring-2 hover:ring-offset-1 transition-all rounded"
                          title={`Відкрити: ${job.external_apply_url}`}
                        >
                          {getApplyBadge(job.external_apply_url)}
                          <span className="text-xs text-blue-600 font-medium">Лінк</span>
                        </a>
                      ) : job.application_form_type === 'external_form' ? (
                        <span className="inline-flex items-center justify-center px-2 py-1 rounded-full bg-green-500 text-white text-xs font-bold" title="External form (no registration)">
                          📝
                        </span>
                      ) : job.application_form_type === 'external_registration' ? (
                        <span className="inline-flex items-center justify-center px-2 py-1 rounded-full bg-orange-500 text-white text-xs font-bold" title="Registration required">
                          🔐
                        </span>
                      ) : job.application_form_type === 'processing' ? (
                        <span className="inline-flex items-center justify-center px-2 py-1 rounded-full bg-yellow-400 text-yellow-900 text-xs font-bold animate-pulse" title="Skyvern обробляє...">
                          ⏳
                        </span>
                      ) : (
                        <span className="inline-flex items-center justify-center px-2 py-1 rounded-full bg-slate-300 text-slate-600 text-xs font-bold" title="Натисніть 'Тип подачі' щоб витягти URL">
                          ?
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right">
                        <a href={job.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 text-xs font-medium p-1"><ExternalLink size={14} /> Лінк</a>
                    </td>
                  </tr>

                  {expandedJobId === job.id && (
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <td colSpan={11} className="p-0">
                         {renderExpansionContent(job)}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* CARD VIEW (Mobile) */}
      <div className="md:hidden space-y-3">
         {filteredJobs.length === 0 ? (
             <div className="text-center py-12 text-slate-400 italic">No jobs match your filters.</div>
         ) : filteredJobs.map((job) => (
            <div key={job.id} className={`bg-white rounded-xl border shadow-sm overflow-hidden ${selectedIds.has(job.id) ? 'border-blue-500 ring-1 ring-blue-500' : 'border-slate-200'}`}>
               <div 
                 className={`p-4 flex gap-3 relative ${expandedJobId === job.id ? 'bg-slate-50' : ''}`}
                 onClick={() => toggleExpand(job)}
               >
                  <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${
                      String(job.status).includes('NEW') ? 'bg-blue-500' :
                      String(job.status).includes('ANALYZED') ? 'bg-purple-500' :
                      String(job.status).includes('APPLIED') || String(job.status).includes('SENT') ? 'bg-green-500' :
                      'bg-slate-300'
                  }`} />

                  <div onClick={(e) => { e.stopPropagation(); toggleSelectOne(job.id); }} className="pt-1">
                      {selectedIds.has(job.id) ? <CheckSquare size={20} className="text-blue-600"/> : <Square size={20} className="text-slate-300"/>}
                  </div>

                  <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-start mb-1">
                          <h3 className="font-bold text-slate-800 truncate pr-2 text-sm">{job.title}</h3>
                          {job.matchScore && (
                             <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                                 job.matchScore >= 70 ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                             }`}>
                                {job.matchScore}%
                             </span>
                          )}
                      </div>
                      <div className="text-xs text-slate-600 mb-1 flex items-center gap-1">
                          <Building size={12} /> {job.company}
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-slate-400">
                          <div className="flex items-center gap-2">
                             <span className="flex items-center gap-0.5"><MapPin size={10}/> {job.location}</span>
                             <span>•</span>
                             {getSourceBadge(job.source, 'sm')}
                          </div>
                          <div className="flex items-center gap-2">
                              <span>{job.postedDate}</span>
                              <a href={job.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-0.5 text-blue-600 hover:text-blue-800 text-xs font-medium"><ExternalLink size={12} /> Лінк</a>
                          </div>
                      </div>
                      
                      {/* Mobile Badges */}
                      <div className="mt-2 flex flex-wrap gap-1">
                          {job.deadline && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-bold border flex items-center gap-1 w-fit ${
                                isDeadlineExpired(job)
                                  ? 'border-red-300 bg-red-50 text-red-600'
                                  : isEstimatedDeadline(job.deadline)
                                  ? 'border-amber-300 bg-amber-50 text-amber-600'
                                  : 'border-green-300 bg-green-50 text-green-600'
                              }`}>
                                  {isDeadlineExpired(job) ? '🔴' : isEstimatedDeadline(job.deadline) ? '⚡' : '📅'} {formatDeadline(job.deadline)}
                              </span>
                          )}
                          {job.position_uk && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-amber-50 text-amber-700 border border-amber-200 w-fit">
                                  {job.position_uk}
                              </span>
                          )}
                          {job.application_form_type === 'finn_easy' ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded uppercase font-bold border border-blue-300 bg-blue-50 text-blue-600 flex items-center gap-1 w-fit">
                                  ⚡ FINN
                              </span>
                          ) : job.application_form_type === 'external_form' ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded uppercase font-bold border border-green-300 bg-green-50 text-green-600 flex items-center gap-1 w-fit">
                                  📝 Форма
                              </span>
                          ) : job.application_form_type === 'external_registration' ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded uppercase font-bold border border-orange-300 bg-orange-50 text-orange-600 flex items-center gap-1 w-fit">
                                  🔐 Реєстр.
                              </span>
                          ) : (
                              <span className="text-[10px] px-1.5 py-0.5 rounded uppercase font-bold border border-slate-300 bg-slate-50 text-slate-500 flex items-center gap-1 w-fit">
                                  ? Невідомо
                              </span>
                          )}
                          {job.application_id && (
                              job.application_status === 'sent' ? (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded uppercase font-bold border border-green-400 bg-green-100 text-green-700 flex items-center gap-1 w-fit">
                                      ✅ Відправлено
                                  </span>
                              ) : job.application_status === 'sending' ? (
                                  <div className="flex items-center gap-1">
                                      <span className="text-[10px] px-1.5 py-0.5 rounded uppercase font-bold border border-yellow-300 bg-yellow-50 text-yellow-700 flex items-center gap-1 w-fit animate-pulse">
                                          ⏳ Надсилається
                                      </span>
                                      <button
                                          onClick={(e) => { e.stopPropagation(); if (job.application_id && window.confirm('Зупинити задачу?')) { api.cancelTask(job.application_id).then(() => onRefresh?.()); }}}
                                          className="text-red-400 hover:text-red-600"
                                          title="Зупинити"
                                      >
                                          <StopCircle size={12}/>
                                      </button>
                                  </div>
                              ) : job.application_status === 'failed' ? (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded uppercase font-bold border border-red-300 bg-red-50 text-red-600 flex items-center gap-1 w-fit">
                                      ❌ Помилка
                                  </span>
                              ) : (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded uppercase font-bold border border-green-300 bg-green-50 text-green-600 flex items-center gap-1 w-fit">
                                      📝 Søknad
                                  </span>
                              )
                          )}
                      </div>
                  </div>
               </div>
               
               {expandedJobId === job.id && (
                   <div className="border-t border-slate-200">
                      {renderExpansionContent(job)}
                   </div>
               )}
            </div>
         ))}
      </div>

    </div>
  );
};
