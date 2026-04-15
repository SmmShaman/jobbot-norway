
export enum JobStatus {
  NEW = 'NEW',
  ANALYZED = 'ANALYZED',
  APPLIED = 'APPLIED',
  REJECTED = 'REJECTED',
  INTERVIEW = 'INTERVIEW',
  SENT = 'SENT'
}

export interface RadarMetric {
  subject: string;
  A: number;
  fullMark: number;
}

export interface Aura {
  status: 'Toxic' | 'Growth' | 'Balanced' | 'Chill' | 'Grind' | 'Neutral';
  color: string; // Hex code or Tailwind class
  tags: string[]; // e.g. ["🚩 Low Pay", "🚀 Stock Options"]
  explanation: string;
}

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  source: 'FINN' | 'LINKEDIN' | 'NAV';
  postedDate: string;
  scannedAt: string;
  status: JobStatus;
  matchScore?: number;
  description?: string;
  ai_recommendation?: string; // Analysis text
  tasks_summary?: string; // Specific duties list
  application_id?: string; // Link to the generated application if exists
  application_status?: 'draft' | 'approved' | 'sending' | 'manual_review' | 'sent' | 'failed' | 'rejected'; // Status of the application
  application_sent_at?: string; // When the application was sent
  cover_letter_no?: string; // Norwegian cover letter text
  cover_letter_uk?: string; // Ukrainian cover letter text
  cost_usd?: number; // Cost of analysis
  has_enkel_soknad?: boolean; // FINN.no "Enkel søknad" (Easy Apply) available
  application_form_type?: 'finn_easy' | 'external_form' | 'external_registration' | 'email' | 'processing' | 'skyvern_failed' | 'unknown'; // Type of application form
  external_apply_url?: string; // URL to external application page
  deadline?: string; // Application deadline (søknadsfrist) in ISO date format (YYYY-MM-DD)

  // Cyberpunk Features
  aura?: Aura;
  radarData?: RadarMetric[];
  position_uk?: string;
}

export interface Application {
  id: string;
  job_id: string;
  user_id: string;
  cover_letter_no: string; // Norwegian version
  cover_letter_uk?: string; // Ukrainian translation (optional)
  status: 'draft' | 'approved' | 'sending' | 'manual_review' | 'sent' | 'failed' | 'rejected';
  created_at: string;
  approved_at?: string;
  sent_at?: string;
  skyvern_metadata?: {
    task_id?: string;
    url?: string;
    [key: string]: any;
  };
  cost_usd?: number; // NEW: Cost of generation
}

export interface ScanTask {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  type: string;
  createdAt: string;
}

export interface WorkerStatus {
  isOnline: boolean;
  lastSeen: string;
  currentTask?: string;
  cpuUsage: number;
  memoryUsage: number;
}

export interface DashboardStats {
  totalJobs: number;
  newJobsToday: number;
  applicationsSent: number;
  activeScans: number;
  totalCost: number; // NEW
}

// --- NEW: Structured Profile Interfaces ---
export interface WorkExperience {
  company: string;
  position: string;
  startDate: string;
  endDate: string;
  responsibilities: string[];
  achievements?: string[];
  technologiesUsed?: string[];
}

export interface Education {
  institution: string;
  degree: string;
  field: string;
  graduationYear: string;
}

export interface TechnicalSkills {
  aiTools: string[];
  programmingLanguages: string[];
  frameworks: string[];
  databases: string[];
  cloudPlatforms: string[];
  developmentTools: string[];
  other: string[];
}

export interface LanguageSkill {
  language: string;
  proficiencyLevel: string;
}

export interface StructuredProfile {
  personalInfo: {
    fullName: string;
    email: string;
    phone: string;
    website?: string;
    driverLicense?: string;
    birthDate?: string;
    nationality?: string;
    gender?: string;
    address?: {
      street?: string;
      postalCode?: string;
      city: string;
      country: string;
    };
  };
  professionalSummary: string;
  workExperience: WorkExperience[];
  education: Education[];
  technicalSkills: TechnicalSkills;
  softSkills: string[];
  languages: LanguageSkill[];
  certifications: string[];
  interests?: string[];
  careerStats?: {
    totalExperienceYears: number;
    currentRole: string;
    industries: string[];
  };
  location?: string;
  preferredWorkFormat?: string;
}

export interface CVProfile {
  id: string;
  name: string;
  content: string; // The AI generated analysis (Text Summary)
  structured_content?: StructuredProfile; // NEW: The JSON Data
  isActive: boolean;
  createdAt: string;
  resumeCount: number;
  sourceFiles?: string[];
  // Profile versioning fields
  source_type?: 'generated' | 'edited'; // How profile was created
  raw_resume_text?: string; // Original extracted text from PDF
  parent_profile_id?: string; // If edited, references original profile
  profile_name?: string; // User-friendly name
}

export interface UserSettings {
  id: string;
  user_id: string;
  telegram_chat_id?: string;
  finn_search_urls: string[];
  linkedin_search_terms?: string[];
  linkedin_scan_enabled?: boolean;
  linkedin_location?: string;
  is_auto_scan_enabled?: boolean;
  scan_time_utc?: string; // Format "HH:MM"

  // Languages
  ui_language?: 'en' | 'no' | 'uk';
  preferred_analysis_language?: 'en' | 'no' | 'uk';

  // Prompts
  application_prompt?: string;
  profile_gen_prompt?: string; // NEW
  job_analysis_prompt?: string; // NEW

  // Roles
  role?: 'admin' | 'user';

  // Telegram link code for secure account linking
  telegram_link_code?: string;
  telegram_link_code_expires_at?: string;

  // Auto-søknad settings
  auto_soknad_enabled?: boolean;
  auto_soknad_min_score?: number; // 0-100, default 50
}

export interface KnowledgeBaseItem {
  id: string;
  question: string;
  answer: string;
  category: string;
}

export interface AutomationSettings {
  is_auto_scan_enabled: boolean;
  scan_time_utc: string;
}

export interface SystemLog {
  id: string;
  user_id?: string; // User who triggered this action (for multi-user isolation)
  event_type: 'SCAN' | 'PROFILE_GEN' | 'APPLICATION_GEN' | 'ANALYSIS' | 'MANUAL_TRIGGER';
  status: 'SUCCESS' | 'FAILED';
  message: string;
  details?: {
    jobsFound?: number;
    newJobs?: number;
    analyzed?: number;
    duplicates?: number;
    [key: string]: any;
  };
  tokens_used: number;
  cost_usd: number;
  source: 'TELEGRAM' | 'WEB_DASHBOARD' | 'CRON' | 'GITHUB_ACTIONS';
  created_at: string;
}

// Admin Types
export interface AdminUser {
  id: string;
  email?: string;
  role: string;
  created_at: string;
  last_sign_in_at?: string;
  jobsCount?: number;
  appsCount?: number;
  costUsd?: number;
}

export interface AdminStats {
  totalCost: number;
  totalJobs: number;
  totalApplications: number;
  perUser: { user_id: string; email?: string; jobs: number; applications: number; cost: number }[];
}

// Site Credentials
export interface SiteCredential {
  id: string;
  site_domain: string;
  site_name?: string;
  email?: string;
  password?: string;
  status: 'active' | 'needs_verification' | 'verification_failed' | 'login_failed' | 'expired' | 'inactive';
  auth_type?: 'password' | 'magic_link' | 'oauth' | 'unknown';
  notes?: string;
  created_at: string;
  updated_at: string;
  last_login_at?: string;
}

// Export History
export interface ExportHistory {
  id: string;
  user_id: string;
  filename: string;
  format: 'xlsx' | 'pdf';
  file_path: string;
  file_size?: number;
  jobs_count: number;
  filters_applied?: Record<string, any>;
  created_at: string;
  download_url?: string;
}

export interface JobTableExportInfo {
  filteredJobs: Job[];
  selectedIds: Set<string>;
  filters: {
    startDate: string;
    endDate: string;
    sourceFilter: string;
    [key: string]: any;
  };
  totalJobsCount: number;
}
