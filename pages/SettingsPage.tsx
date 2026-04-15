
import React, { useState, useEffect } from 'react';
import {
  User, FileText, Globe, Briefcase, Lock, Save, Upload,
  Trash2, Play, CheckCircle, AlertCircle, Loader2, Edit2, Plus, Database, Key, ExternalLink, Bot, PenTool, Clock, Zap, BookOpen, Terminal, Eye, X, StickyNote, RefreshCw, Wand2, File, ChevronDown, ChevronUp, Calendar, Files, ScrollText, Download, MessageCircle, Link2, Unlink, Copy, Check, Search
} from 'lucide-react';
import { api, generateProfileTextFromJSON } from '../services/api';
import { CVProfile, KnowledgeBaseItem, StructuredProfile, SiteCredential } from '../types';
import { useLanguage } from '../contexts/LanguageContext';
import { Language } from '../services/translations';
import { ProfileEditor } from '../components/ProfileEditor';

const DEFAULT_PROFILE_GEN_PROMPT = `You are a professional CV consolidation expert. Your task is to merge multiple resume/CV documents into ONE comprehensive profile.

CRITICAL TASK: Merge all provided resume files into a UNIFIED profile. Remove duplicates but keep ALL unique information.

INSTRUCTIONS:

1. MERGE & DEDUPLICATE: If the same job, education, or skill appears in multiple files, include it ONLY ONCE. Choose the most detailed version.

2. PRESERVE ORIGINAL LANGUAGE: Keep Norwegian (Bokmål), English, Ukrainian text as-is. Do NOT translate.

3. PRESERVE EXACT WORDING: Copy responsibilities, achievements, skills VERBATIM. Do NOT rephrase or summarize.

4. WORK EXPERIENCE: Include ALL unique positions. For each:
   - Use "Nåværende" or "Present" for current jobs
   - Keep FULL responsibility descriptions (not shortened)
   - Include ALL technologies mentioned for that role

5. COMPREHENSIVE SUMMARY: In "professionalSummary", write ONE merged paragraph that covers:
   - Total years of experience
   - Main expertise areas
   - Key achievements
   - Current focus/specialization
   This should be 150-300 words, comprehensive, in Norwegian.

6. FULL TEXT VERSION: In "fullResumeText", create a complete merged CV as plain text with sections:
   - PERSONALIA (navn, kontakt, adresse)
   - SAMMENDRAG (the professionalSummary)
   - ARBEIDSERFARING (all jobs, newest first, with full descriptions)
   - UTDANNING (all education)
   - KURS OG SERTIFISERINGER
   - TEKNISKE FERDIGHETER (all tools, no duplicates)
   - SPRÅK
   - KOMPETANSER
   - INTERESSER

7. DO NOT INVENT data. Only include what exists in source files.

OUTPUT JSON SCHEMA:
{
  "fullResumeText": "string - COMPLETE merged CV as plain text, well-formatted with section headers",
  "personalInfo": {
    "fullName": "string",
    "email": "string",
    "phone": "string",
    "website": "string",
    "address": { "city": "string", "country": "string" }
  },
  "professionalSummary": "string - comprehensive 150-300 word summary in Norwegian",
  "workExperience": [
    {
      "company": "string",
      "position": "string",
      "startDate": "string",
      "endDate": "string or 'Nåværende'",
      "responsibilities": ["full lines verbatim"],
      "achievements": ["verbatim if present"],
      "technologiesUsed": ["exact tool names"]
    }
  ],
  "education": [
    { "institution": "string", "degree": "string", "field": "string", "graduationYear": "string" }
  ],
  "technicalSkills": {
    "aiTools": [], "programmingLanguages": [], "frameworks": [],
    "databases": [], "cloudPlatforms": [], "developmentTools": [], "other": []
  },
  "softSkills": ["verbatim"],
  "languages": [{ "language": "string", "proficiencyLevel": "string" }],
  "certifications": ["string"],
  "interests": ["string"]
}`;

const DEFAULT_JOB_ANALYSIS_PROMPT = `You are a Vibe & Fit Scanner for Recruitment.

TASK:
1. Analyze how well the candidate fits this job.
2. Provide a Relevance Score (0-100).
3. AURA SCAN: Detect the "vibe" of the job description.
4. RADAR METRICS: Rate the job on 5 specific axes (0-100).
5. EXTRACT TASKS: List specifically what the candidate needs to DO (duties/responsibilities).
6. EXTRACT REQUIREMENTS: List qualifications, skills, experience the employer requires.
7. EXTRACT OFFERS: List what the company offers (benefits, salary, perks, work conditions).

CANDIDATE EVALUATION RULES (CRITICAL):
- The candidate may have a DIVERSE career spanning multiple fields and decades.
- You MUST consider ALL work experience listed in the profile — not just recent roles.
- Old experience (even 10-20+ years ago) is STILL RELEVANT if it matches the job requirements.
- Examples: teaching experience matters for education jobs, management experience matters for leader roles, military/security experience matters for safety roles, economics background matters for finance roles.
- Do NOT bias the score toward the candidate's most recent or most prominent career track.
- Match the SPECIFIC job requirements against the ENTIRE profile — find the best-fitting experience from ANY period.
- Education and certifications from any period are always relevant.
- Transferable skills (leadership, communication, planning, budgeting) apply across fields.

SCORING GUIDELINES:
- 70-100: Strong match — candidate has direct experience or education in this field
- 50-69: Moderate match — candidate has transferable skills or partial experience
- 30-49: Weak match — some overlap but significant gaps
- 0-29: Poor match — very little relevant experience

ANALYSIS FORMAT (CRITICAL):
The "analysis" field MUST use this EXACT structure — cons FIRST, then pros:
❌ Cons:
- [specific con about candidate fit]
- [another con]

✅ Pros:
- [specific pro about candidate fit]
- [another pro]

Write 2-5 bullet points for each section. Always include BOTH sections even if one side is weak.
When listing pros, explicitly reference the SPECIFIC role/period from the candidate's history that is relevant.

OUTPUT FORMAT (JSON ONLY):
{
  "score": number (0-100),
  "analysis": "string (structured cons/pros format as described above)",
  "tasks": "string (bullet point list of duties/responsibilities)",
  "requirements": "string (bullet point list of required qualifications)",
  "offers": "string (bullet point list of what the company offers)",
  "aura": {
      "status": "Toxic" | "Growth" | "Balanced" | "Chill" | "Grind" | "Neutral",
      "color": "#hex color code",
      "tags": ["string", "string"],
      "explanation": "short reason for aura"
  },
  "radar": {
      "tech_stack": number (0-100),
      "soft_skills": number (0-100),
      "culture": number (0-100),
      "salary_potential": number (0-100),
      "career_growth": number (0-100)
  }
}`;

const DEFAULT_APP_PROMPT = `You are an expert career consultant for the Norwegian job market.
Your task is to write a "Søknad" (Cover Letter) based on the provided Job Description and Candidate Profile.

GUIDELINES:
1. Language: Norwegian (Bokmål).
2. Tone: Professional, enthusiastic, but humble (Norwegian work culture).
3. Structure:
   - Header (Standard formal letter format).
   - Introduction: Mention specific position and company.
   - Body Paragraph 1: Why this company? (Connect to their values/mission).
   - Body Paragraph 2: Why me? (Connect my skills to their requirements).
   - Body Paragraph 3: Personal touch / Motivation.
   - Conclusion: Request for interview.
4. Length: ~300-400 words.
5. Do not invent facts. Use the Candidate Profile.`;

// EXACT JSON SCHEMA FOR UPGRADE
const UPGRADE_PROMPT = `
TASK: Extract structured data from the provided legacy resume text and populate the JSON schema.
CRITICAL: Output MUST be valid JSON matching this exact schema. Do not make up data if not present, but try to infer reasonable values from context.

OUTPUT JSON FORMAT:
{
  "personalInfo": {
    "fullName": "string", "email": "string", "phone": "string", 
    "website": "string", "address": { "city": "string", "country": "string" }
  },
  "professionalSummary": "string (Comprehensive summary)",
  "workExperience": [
    { "company": "string", "position": "string", "startDate": "string", "endDate": "string", "responsibilities": ["string", "string"] }
  ],
  "education": [ { "institution": "string", "degree": "string", "field": "string", "graduationYear": "string" } ],
  "technicalSkills": {
    "aiTools": ["string"], "programmingLanguages": ["string"], "frameworks": ["string"], "databases": ["string"], "cloudPlatforms": ["string"], "developmentTools": ["string"], "other": ["string"]
  },
  "softSkills": ["string"],
  "languages": [ { "language": "string", "proficiencyLevel": "string" } ],
  "certifications": ["string"],
  "interests": ["string"]
}
`;

// Helper to calculate next scan time
const calculateNextScan = (scanTimeUtc: string): { nextScanIn: string; nextScanDate: string } => {
  if (!scanTimeUtc) return { nextScanIn: 'Not scheduled', nextScanDate: '' };

  const [hours, minutes] = scanTimeUtc.split(':').map(Number);
  const now = new Date();
  const nowUtc = new Date(now.toISOString());

  let nextScan = new Date(Date.UTC(
    nowUtc.getUTCFullYear(),
    nowUtc.getUTCMonth(),
    nowUtc.getUTCDate(),
    hours,
    minutes,
    0
  ));

  if (nextScan <= nowUtc) {
    nextScan.setUTCDate(nextScan.getUTCDate() + 1);
  }

  const diffMs = nextScan.getTime() - nowUtc.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  const norwayTimeStr = nextScan.toLocaleTimeString('no-NO', {
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

  return { nextScanIn, nextScanDate: `${norwayTimeStr} (Norway)` };
};

// Helper to create blank profile
const createBlankProfile = (): StructuredProfile => ({
    personalInfo: { fullName: '', email: '', phone: '', website: '', address: { city: '', country: '' } },
    professionalSummary: '',
    workExperience: [],
    education: [],
    technicalSkills: { aiTools: [], programmingLanguages: [], frameworks: [], databases: [], cloudPlatforms: [], developmentTools: [], other: [] },
    softSkills: [],
    languages: [],
    certifications: [],
    interests: []
});

interface SettingsPageProps {
  initialTab?: string;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ initialTab = 'resume' }) => {
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState(initialTab);
  
  // State Variables
  const [files, setFiles] = useState<File[]>([]);
  const [extractedText, setExtractedText] = useState<string>('');
  const [isExtracting, setIsExtracting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showTextSpoiler, setShowTextSpoiler] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState<string>('');

  const [profiles, setProfiles] = useState<CVProfile[]>([]);
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false);
  const [dbStatus, setDbStatus] = useState<{ success: boolean; message: string } | null>(null);
  
  // Profile Tab State
  const [activeProfileData, setActiveProfileData] = useState<CVProfile | null>(null);
  const [isLoadingActive, setIsLoadingActive] = useState(false);
  const [structuredData, setStructuredData] = useState<StructuredProfile>(createBlankProfile());
  const [isUpgradingProfile, setIsUpgradingProfile] = useState(false); // For Legacy -> JSON conversion
  
  // Editor State (Modal)
  const [editingProfile, setEditingProfile] = useState<CVProfile | null>(null);
  const [parsedJson, setParsedJson] = useState<StructuredProfile | null>(null);

  // View modals for profile details
  const [viewFilesProfile, setViewFilesProfile] = useState<CVProfile | null>(null);
  const [viewRawTextProfile, setViewRawTextProfile] = useState<CVProfile | null>(null);
  const [isSavingTextOnly, setIsSavingTextOnly] = useState(false);

  // ... (Keep other existing states for searchUrls, prompts, automation) ...
  const [searchUrls, setSearchUrls] = useState<string[]>([]);
  const [newUrl, setNewUrl] = useState('');
  const [isSavingUrls, setIsSavingUrls] = useState(false);
  const [isLoadingUrls, setIsLoadingUrls] = useState(false);

  const [appPrompt, setAppPrompt] = useState(DEFAULT_APP_PROMPT);
  const [genPrompt, setGenPrompt] = useState(DEFAULT_PROFILE_GEN_PROMPT);
  const [analyzePrompt, setAnalyzePrompt] = useState(DEFAULT_JOB_ANALYSIS_PROMPT);
  const [isSavingPrompts, setIsSavingPrompts] = useState(false);
  const [activePromptTab, setActivePromptTab] = useState<'gen' | 'analyze' | 'app'>('gen');

  const [analysisLang, setAnalysisLang] = useState<Language>('uk');

  const [autoEnabled, setAutoEnabled] = useState(false);
  const [scanTime, setScanTime] = useState('15:00');
  const [isSavingAuto, setIsSavingAuto] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanLogs, setScanLogs] = useState<string[]>([]);

  // Auto-søknad state
  const [autoSoknadEnabled, setAutoSoknadEnabled] = useState(false);
  const [autoSoknadMinScore, setAutoSoknadMinScore] = useState(50);
  const [isSavingAutoSoknad, setIsSavingAutoSoknad] = useState(false);

  // LinkedIn state
  const [linkedinTerms, setLinkedinTerms] = useState<string[]>([]);
  const [newLinkedinTerm, setNewLinkedinTerm] = useState('');
  const [linkedinEnabled, setLinkedinEnabled] = useState(false);
  const [linkedinLocation, setLinkedinLocation] = useState('Norway');
  const [isSavingLinkedin, setIsSavingLinkedin] = useState(false);
  const [isLoadingLinkedin, setIsLoadingLinkedin] = useState(false);

  // Telegram link state
  const [telegramChatId, setTelegramChatId] = useState<string | null>(null);
  const [telegramLinkCode, setTelegramLinkCode] = useState<string | null>(null);
  const [telegramCodeExpiresAt, setTelegramCodeExpiresAt] = useState<string | null>(null);
  const [isLoadingTelegram, setIsLoadingTelegram] = useState(false);
  const [isGeneratingCode, setIsGeneratingCode] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  // Site credentials state
  const [siteCredentials, setSiteCredentials] = useState<SiteCredential[]>([]);
  const [isLoadingCredentials, setIsLoadingCredentials] = useState(false);
  const [newCredDomain, setNewCredDomain] = useState('');
  const [newCredEmail, setNewCredEmail] = useState('');
  const [newCredPassword, setNewCredPassword] = useState('');
  const [isSavingCred, setIsSavingCred] = useState(false);

  // Load Active Profile Logic
  useEffect(() => { setActiveTab(initialTab); }, [initialTab]);
  useEffect(() => {
    if (activeTab === 'resume') { checkDb(); loadProfiles(); }
    if (activeTab === 'profile') { loadActiveProfile(); }
    if (activeTab === 'search') { loadSearchUrls(); loadLinkedinSettings(); }
    if (activeTab === 'ai_config') { loadPrompts(); loadAnalysisLanguage(); }
    if (activeTab === 'automation') { loadAutomation(); loadTelegramStatus(); }
    if (activeTab === 'credentials') { loadCredentials(); }
  }, [activeTab]);

  const checkDb = async () => { const status = await api.cv.verifyDatabaseConnection(); setDbStatus(status); };
  const loadProfiles = async () => { setIsLoadingProfiles(true); const data = await api.cv.getProfiles(); setProfiles(data); setIsLoadingProfiles(false); };
  
  const loadActiveProfile = async () => {
      setIsLoadingActive(true);
      try {
          const profile = await api.cv.getActiveProfile();
          if (profile) {
              setActiveProfileData(profile);
              const hasRealData = profile.structured_content && 
                                  (profile.structured_content.personalInfo?.fullName || 
                                   (profile.structured_content.workExperience && profile.structured_content.workExperience.length > 0));

              if (hasRealData) {
                  setStructuredData(profile.structured_content!);
              } else if (profile.content && profile.content.length > 50) {
                  if (!isUpgradingProfile) {
                      handleUpgradeLegacyProfile(profile.content, profile.id);
                  }
              } else {
                  setStructuredData(createBlankProfile());
              }
          } else {
              setActiveProfileData(null);
              setStructuredData(createBlankProfile());
          }
      } catch (e) {
          console.error("Load Profile Error", e);
      } finally {
          setIsLoadingActive(false);
      }
  };

  const handleUpgradeLegacyProfile = async (text: string, id: string) => {
      if (!text || text.length < 20) return;
      setIsUpgradingProfile(true);
      try {
          const result = await api.cv.analyzeResumes([], genPrompt, UPGRADE_PROMPT, text);
          if (result.json) {
              setStructuredData(result.json);
              await api.cv.updateProfileContent(id, text, result.json);
          }
      } catch (e) {
          console.error("Failed to upgrade legacy profile:", e);
      } finally {
          setIsUpgradingProfile(false);
      }
  };

  const handleSaveActiveProfile = async (updatedData: StructuredProfile) => {
      if (!activeProfileData) {
           alert("No active profile found. Please create one in 'Resume' tab first.");
           return;
      }
      const newTextContent = generateProfileTextFromJSON(updatedData);

      // If this is a generated profile, create a new edited version instead of overwriting
      if (activeProfileData.source_type === 'generated' || !activeProfileData.source_type) {
          const makeActive = confirm(
              "Ви редагуєте оригінальний профіль.\n\n" +
              "Створити НОВИЙ профіль з вашими змінами?\n" +
              "(Оригінальний профіль залишиться незмінним)\n\n" +
              "OK = Створити новий і зробити активним\n" +
              "Cancel = Оновити існуючий профіль"
          );

          if (makeActive) {
              await api.cv.saveEditedProfile(activeProfileData.id, newTextContent, updatedData, true);
              loadActiveProfile();
              loadProfiles();
              alert("✅ Новий профіль створено і встановлено як активний!");
              return;
          }
      }

      // Update existing profile (for edited profiles or if user chose to overwrite)
      await api.cv.updateProfileContent(activeProfileData.id, newTextContent, updatedData);
      setStructuredData(updatedData);
      setActiveProfileData(prev => prev ? { ...prev, content: newTextContent, structured_content: updatedData } : null);
      alert("Profile updated! The Legacy Text has been regenerated.");
  };

  const loadPrompts = async () => { 
      const p = await api.settings.getAllPrompts(); 
      setAppPrompt(p.app || DEFAULT_APP_PROMPT);
      setGenPrompt(p.gen || DEFAULT_PROFILE_GEN_PROMPT);
      setAnalyzePrompt(p.analyze || DEFAULT_JOB_ANALYSIS_PROMPT);
  };
  const loadAnalysisLanguage = async () => {
      const s = await api.settings.getSettings();
      if (s && s.preferred_analysis_language) setAnalysisLang(s.preferred_analysis_language);
  };
  const loadSearchUrls = async () => { setIsLoadingUrls(true); setSearchUrls(await api.settings.getSearchUrls()); setIsLoadingUrls(false); };
  const loadLinkedinSettings = async () => {
      setIsLoadingLinkedin(true);
      try {
          const li = await api.settings.getLinkedInSettings();
          setLinkedinTerms(li.terms);
          setLinkedinEnabled(li.enabled);
          setLinkedinLocation(li.location);
      } catch (e) { console.error('Failed to load LinkedIn settings:', e); }
      setIsLoadingLinkedin(false);
  };
  const loadAutomation = async () => {
      const settings = await api.settings.getSettings();
      if (settings) {
        setAutoEnabled(!!settings.is_auto_scan_enabled);
        setScanTime(settings.scan_time_utc || '15:00');
        setAutoSoknadEnabled(!!settings.auto_soknad_enabled);
        setAutoSoknadMinScore(settings.auto_soknad_min_score ?? 50);
      }
  };

  const loadCredentials = async () => {
      setIsLoadingCredentials(true);
      const data = await api.credentials.getAll();
      setSiteCredentials(data);
      setIsLoadingCredentials(false);
  };

  const deleteCredential = async (id: string) => {
      if (!confirm('Видалити цей запис?')) return;
      await api.credentials.delete(id);
      setSiteCredentials(prev => prev.filter(c => c.id !== id));
  };

  const saveNewCredential = async () => {
      if (!newCredDomain.trim() || !newCredEmail.trim() || !newCredPassword.trim()) return;
      setIsSavingCred(true);
      const ok = await api.credentials.create(newCredDomain.trim(), newCredEmail.trim(), newCredPassword.trim());
      if (ok) {
          setNewCredDomain(''); setNewCredEmail(''); setNewCredPassword('');
          await loadCredentials();
      }
      setIsSavingCred(false);
  };

  const loadTelegramStatus = async () => {
      setIsLoadingTelegram(true);
      try {
          const settings = await api.settings.getSettings();
          if (settings) {
              setTelegramChatId(settings.telegram_chat_id || null);
              setTelegramLinkCode(settings.telegram_link_code || null);
              setTelegramCodeExpiresAt(settings.telegram_link_code_expires_at || null);
          }
      } catch (e) {
          console.error('Failed to load Telegram status:', e);
      } finally {
          setIsLoadingTelegram(false);
      }
  };

  const handleGenerateTelegramCode = async () => {
      setIsGeneratingCode(true);
      try {
          const code = await api.settings.generateTelegramLinkCode();
          if (code) {
              setTelegramLinkCode(code);
              const expiresAt = new Date();
              expiresAt.setHours(expiresAt.getHours() + 24);
              setTelegramCodeExpiresAt(expiresAt.toISOString());
          }
      } catch (e) {
          console.error('Failed to generate code:', e);
          alert('Помилка генерації коду');
      } finally {
          setIsGeneratingCode(false);
      }
  };

  const handleDisconnectTelegram = async () => {
      if (!confirm("Ви впевнені, що хочете від'єднати Telegram?\n\nСповіщення більше не працюватимуть.")) {
          return;
      }
      setIsDisconnecting(true);
      try {
          const success = await api.settings.disconnectTelegram();
          if (success) {
              setTelegramChatId(null);
              setTelegramLinkCode(null);
              setTelegramCodeExpiresAt(null);
          } else {
              alert("Помилка від'єднання");
          }
      } catch (e) {
          console.error('Failed to disconnect Telegram:', e);
          alert("Помилка від'єднання");
      } finally {
          setIsDisconnecting(false);
      }
  };

  const handleCopyCode = () => {
      if (telegramLinkCode) {
          navigator.clipboard.writeText(telegramLinkCode);
          setCodeCopied(true);
          setTimeout(() => setCodeCopied(false), 2000);
      }
  };

  const getCodeExpirationText = () => {
      if (!telegramCodeExpiresAt) return '';
      const expiresAt = new Date(telegramCodeExpiresAt);
      const now = new Date();
      if (expiresAt < now) return 'Код прострочений';
      const diffMs = expiresAt.getTime() - now.getTime();
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      if (diffHours > 0) return `${diffHours} год ${diffMinutes} хв`;
      return `${diffMinutes} хв`;
  };

  const isCodeExpired = () => {
      if (!telegramCodeExpiresAt) return true;
      return new Date(telegramCodeExpiresAt) < new Date();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => { 
      if (e.target.files) setFiles(Array.from(e.target.files)); 
  };
  
  // --- Step 1: Extract Text ---
  const handleExtractText = async () => { 
      if (files.length === 0) return;
      setIsExtracting(true);
      setAnalysisStatus("Uploading files & Extracting text...");
      
      try {
          const paths = [];
          for (const file of files) {
              const path = await api.cv.uploadResume(file);
              if (path) paths.push(path);
          }
          
          if (paths.length > 0) {
              const text = await api.cv.extractResumeText(paths);
              setExtractedText(text);
              setShowTextSpoiler(true);
              setAnalysisStatus("Text extraction successful! Review below before analysis.");
          } else {
              setAnalysisStatus("Failed to upload files.");
          }
      } catch (e: any) {
          setAnalysisStatus("Error: " + e.message);
      } finally {
          setIsExtracting(false);
      }
  };

  // --- Step 2: Analyze Text ---
  const handleAnalyzeText = async () => {
      if (!extractedText) return;
      setIsAnalyzing(true);
      setAnalysisStatus("Analyzing extracted text with AI...");

      try {
          // Use extracted text as raw input for AI
          const systemPrompt = genPrompt || DEFAULT_PROFILE_GEN_PROMPT;
          const result = await api.cv.analyzeResumes([], systemPrompt, "Generate comprehensive profile.", extractedText);

          const safeJson = result.json || createBlankProfile();
          const name = `Profile ${new Date().toLocaleDateString()} (${files.length} files)`;
          const fileNames = files.map(f => f.name);

          // Save profile with raw resume text for future reference
          await api.cv.saveProfile(name, result.text, files.length, fileNames, safeJson, extractedText);

          loadProfiles();
          loadActiveProfile(); // Reload active profile since new one is now active
          setAnalysisStatus("✅ Profile Created and set as ACTIVE! You can now edit it in the Profile tab.");
      } catch (e: any) {
          setAnalysisStatus("Error Analysis: " + e.message);
      } finally {
          setIsAnalyzing(false);
      }
  };

  // --- Save Text Only (without AI analysis) ---
  const handleSaveTextOnly = async () => {
      if (!extractedText) return;
      setIsSavingTextOnly(true);
      setAnalysisStatus("Saving extracted text...");

      try {
          const name = `Text Only ${new Date().toLocaleDateString()} (${files.length} files)`;
          const fileNames = files.map(f => f.name);

          // Save with text as content, no structured data
          await api.cv.saveProfile(name, extractedText, files.length, fileNames, undefined, extractedText);

          loadProfiles();
          setAnalysisStatus("✅ Text saved! You can now analyze it later or use as reference.");
      } catch (e: any) {
          setAnalysisStatus("Error saving text: " + e.message);
      } finally {
          setIsSavingTextOnly(false);
      }
  };

  // --- Editor Modal Logic ---
  const openProfileEditor = (p: CVProfile) => {
      setEditingProfile(p);
      if (p.structured_content) {
          setParsedJson(p.structured_content);
      } else {
          setParsedJson(null); 
      }
  };

  const saveProfileChanges = async (updatedJson: StructuredProfile, createNew: boolean = true) => {
      if (!editingProfile) return;
      const newText = generateProfileTextFromJSON(updatedJson);
      setParsedJson(updatedJson);

      if (createNew && editingProfile.source_type === 'generated') {
          // Create new edited profile (preserves original generated profile)
          const makeActive = confirm("Зробити новий профіль активним?\n\nОригінальний профіль залишиться незмінним.");
          await api.cv.saveEditedProfile(editingProfile.id, newText, updatedJson, makeActive);
          alert("✅ Новий профіль створено!" + (makeActive ? " Він тепер активний." : ""));
      } else {
          // Update existing edited profile
          await api.cv.updateProfileContent(editingProfile.id, newText, updatedJson);
          alert("Profile updated successfully!");
      }
      loadProfiles();
      if (createNew) loadActiveProfile();
  };

  const handleSetActive = async (id: string) => { await api.cv.setProfileActive(id); loadProfiles(); };
  const handleDelete = async (id: string) => { await api.cv.deleteProfile(id); loadProfiles(); };
  
  const addUrl = (e?: React.FormEvent) => { 
      e?.preventDefault();
      if (newUrl) setSearchUrls([...searchUrls, newUrl]); 
      setNewUrl(''); 
  };
  const removeUrl = (i: number) => { const u = [...searchUrls]; u.splice(i, 1); setSearchUrls(u); };
  const saveUrls = async () => { 
      setIsSavingUrls(true); 
      try {
          await api.settings.saveSearchUrls(searchUrls); 
          alert(t('settings.search.save') + " Success!");
      } catch (error) {
          console.error(error);
          alert("Failed to save URLs");
      } finally {
          setIsSavingUrls(false); 
      }
  };

  const saveCurrentPrompt = async () => {
      setIsSavingPrompts(true);
      let success = false;
      if (activePromptTab === 'gen') success = await api.settings.savePrompts(undefined, genPrompt, undefined);
      if (activePromptTab === 'analyze') success = await api.settings.savePrompts(undefined, undefined, analyzePrompt);
      if (activePromptTab === 'app') success = await api.settings.savePrompts(appPrompt, undefined, undefined);
      const langSaved = await api.settings.saveAnalysisLanguage(analysisLang);
      console.log(`[SettingsPage] Language save result: ${langSaved}`);
      setIsSavingPrompts(false);
      if(success) alert("Saved!");
      else if (langSaved) alert("Language preference saved!");
  };
  const saveAutomation = async () => { setIsSavingAuto(true); await api.settings.saveAutomation(autoEnabled, scanTime); setIsSavingAuto(false); alert("Saved!"); };
  const saveAutoSoknad = async () => { setIsSavingAutoSoknad(true); await api.settings.saveAutoSoknad(autoSoknadEnabled, autoSoknadMinScore); setIsSavingAutoSoknad(false); alert("Saved!"); };
  const triggerManualScan = async () => {
      setScanLogs([]); setIsScanning(true); 
      setScanLogs(prev => [...prev, `Starting...`]);
      try {
          const res: any = await api.settings.triggerManualScan();
          setScanLogs(prev => [...prev, res.success ? `Success! Found ${res.jobsFound}` : `Failed: ${res.message}`]);
      } catch (error: any) { alert("Error: " + error.message); } 
      finally { setIsScanning(false); }
  };


  const renderTabs = () => (
    <div className="flex overflow-x-auto border-b border-slate-200 mb-6">
      {[
        { id: 'profile', label: t('settings.tabs.profile'), icon: User },
        { id: 'resume', label: t('settings.tabs.resume'), icon: Upload },
        { id: 'search', label: t('settings.tabs.search'), icon: Globe },
        { id: 'ai_config', label: t('settings.tabs.aiConfig'), icon: Bot },
        { id: 'credentials', label: 'Credentials', icon: Key },
        { id: 'automation', label: t('settings.tabs.automation'), icon: Zap },
      ].map(tab => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={`flex items-center gap-2 px-6 py-3 border-b-2 font-medium text-sm whitespace-nowrap transition-colors ${
            activeTab === tab.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
        >
          <tab.icon size={16} /> {tab.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 min-h-[calc(100vh-100px)]">
      <div className="p-6">
        <h2 className="text-xl font-bold text-slate-900 mb-6">{t('settings.title')}</h2>
        {renderTabs()}

        {/* --- PROFILE TAB (MAIN EDITOR) --- */}
        {activeTab === 'profile' && (
            <div className="animate-fade-in">
                {isLoadingActive ? <div className="flex justify-center py-20"><Loader2 className="animate-spin text-blue-600" size={32}/></div> : (
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                         {/* Left Column: The Editor */}
                         <div className="lg:col-span-2 relative">
                             {activeProfileData ? (
                                 isUpgradingProfile ? (
                                     <div className="absolute inset-0 z-20 bg-white/80 flex flex-col items-center justify-center rounded-xl backdrop-blur-sm border border-blue-100">
                                         <Loader2 size={40} className="animate-spin mb-4 text-blue-600"/>
                                         <p className="font-bold text-blue-800">AI is Parsing Profile...</p>
                                         <p className="text-sm text-blue-600">Reading Legacy Text and filling fields...</p>
                                     </div>
                                 ) : null
                             ) : null}

                             {activeProfileData ? (
                                 <ProfileEditor initialData={structuredData} onSave={handleSaveActiveProfile} />
                             ) : (
                                 <div className="bg-yellow-50 border border-yellow-200 p-6 rounded-xl text-center">
                                     <AlertCircle className="text-yellow-500 mx-auto mb-4" size={32}/>
                                     <h3 className="font-bold text-slate-800">No Active Profile</h3>
                                     <p className="text-sm text-slate-600 mb-4">You haven't selected an active profile yet. Please go to the <b>Resume Upload</b> tab, upload your CV, and set it as active.</p>
                                     <button onClick={() => setActiveTab('resume')} className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700">Go to Resume Upload</button>
                                 </div>
                             )}
                         </div>

                         {/* Right Column: Source Data */}
                         <div className="lg:col-span-1 space-y-6">
                            {/* Status Card */}
                            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm sticky top-4">
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="font-bold text-slate-700 flex items-center gap-2"><StickyNote size={18}/> Legacy Text File</h3>
                                    {activeProfileData && (
                                        <button 
                                            onClick={() => handleUpgradeLegacyProfile(activeProfileData?.content || '', activeProfileData?.id)}
                                            disabled={isUpgradingProfile}
                                            className="text-[10px] bg-blue-50 text-blue-600 px-2 py-1 rounded border border-blue-100 hover:bg-blue-100 flex items-center gap-1 transition-colors"
                                            title="Force re-parse of text to editor"
                                        >
                                            <Wand2 size={10} className={isUpgradingProfile ? "animate-spin" : ""}/> Reset Editor from Text
                                        </button>
                                    )}
                                </div>
                                {activeProfileData ? (
                                    <>
                                        <div className="text-xs text-slate-500 mb-2">
                                            <b>Active Profile:</b> {activeProfileData.name}<br/>
                                            <b>Sync Status:</b> {isUpgradingProfile ? 'Syncing...' : <span className="text-green-600 font-bold">Synced</span>}
                                        </div>
                                        <div className="p-3 bg-blue-50 border border-blue-100 rounded text-xs text-blue-800 mb-4">
                                            ℹ️ This text is what the AI reads when applying for jobs. It updates automatically when you save the Editor.
                                        </div>
                                        <div className="border-t border-slate-100 pt-3">
                                             <div className="bg-slate-50 border border-slate-200 rounded p-2 text-[10px] text-slate-600 font-mono h-[500px] overflow-y-auto whitespace-pre-wrap">
                                                {activeProfileData.content}
                                             </div>
                                        </div>
                                    </>
                                ) : (
                                    <div className="text-sm text-slate-400 italic">Select an active profile to view source data.</div>
                                )}
                            </div>
                         </div>
                    </div>
                )}
            </div>
        )}

        {/* --- Resume Tab --- */}
        {activeTab === 'resume' && (
           <div className="space-y-8 animate-fade-in">
              {/* 1. Upload Area */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="md:col-span-1 border-2 border-dashed border-slate-300 rounded-xl p-8 text-center bg-slate-50 hover:bg-slate-100 transition-colors relative flex flex-col justify-center min-h-[200px]">
                     <input type="file" multiple accept=".pdf,.txt" onChange={handleFileChange} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                     <div className="flex flex-col items-center gap-3">
                         <Upload size={32} className="text-blue-500" />
                         <p className="text-lg font-medium">{t('settings.resume.uploadTitle')}</p>
                         <p className="text-sm text-slate-500">PDF or Text files</p>
                     </div>
                  </div>
                  <div className="md:col-span-2 bg-white border border-slate-200 rounded-xl p-4 flex flex-col">
                      <h3 className="font-bold text-slate-700 mb-3 flex items-center gap-2"><File size={18}/> Selected Files ({files.length})</h3>
                      <div className="flex-1 bg-slate-50 rounded-lg p-3 overflow-y-auto max-h-[150px] mb-4">
                          {files.length === 0 ? <p className="text-slate-400 text-sm italic">No files selected.</p> : (
                              <div className="space-y-2">
                                  {files.map((f, i) => (
                                      <div key={i} className="flex items-center gap-2 text-sm text-slate-700 bg-white p-2 rounded border border-slate-200">
                                          <FileText size={16} className="text-blue-500"/>
                                          <span className="truncate flex-1">{f.name}</span>
                                          <span className="text-xs text-slate-400">{(f.size / 1024).toFixed(1)} KB</span>
                                      </div>
                                  ))}
                              </div>
                          )}
                      </div>
                      
                      <div className="flex items-center justify-between border-t pt-4 mt-auto">
                           <div className="text-xs text-slate-500">{analysisStatus && <span className="text-blue-600 animate-pulse font-medium">{analysisStatus}</span>}</div>
                           <button 
                                onClick={handleExtractText} 
                                disabled={isExtracting || files.length === 0} 
                                className={`bg-blue-600 text-white px-6 py-2 rounded-lg flex items-center gap-2 text-sm font-medium ${isExtracting || files.length === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-700'}`}
                           >
                                {isExtracting ? <Loader2 className="animate-spin" size={16}/> : <FileText size={16} />}
                                Extract Text from Resume
                           </button>
                      </div>
                  </div>
              </div>

              {/* 2. Text Preview Area (Collapsible) */}
              {extractedText && (
                  <div className="bg-white rounded-xl border border-blue-200 shadow-sm overflow-hidden animate-fade-in">
                      <div 
                          onClick={() => setShowTextSpoiler(!showTextSpoiler)}
                          className="bg-blue-50 p-4 flex justify-between items-center cursor-pointer hover:bg-blue-100 transition-colors"
                      >
                          <div className="flex items-center gap-2 text-blue-800 font-bold">
                              <Eye size={18}/> Extracted Text Content
                          </div>
                          {showTextSpoiler ? <ChevronUp size={20} className="text-blue-600"/> : <ChevronDown size={20} className="text-blue-600"/>}
                      </div>
                      
                      {showTextSpoiler && (
                          <div className="p-4 border-t border-blue-100">
                              <div className="bg-slate-50 p-4 rounded-lg border border-slate-200 font-mono text-xs text-slate-700 whitespace-pre-wrap max-h-[400px] overflow-y-auto mb-4">
                                  {extractedText}
                              </div>
                              <div className="flex justify-end gap-3">
                                  <button
                                      onClick={handleSaveTextOnly}
                                      disabled={isSavingTextOnly || isAnalyzing}
                                      className="bg-slate-600 text-white px-5 py-3 rounded-lg flex items-center gap-2 font-medium shadow-sm hover:bg-slate-700 transition-colors"
                                  >
                                      {isSavingTextOnly ? <Loader2 className="animate-spin" size={18} /> : <Download size={18} />}
                                      Зберегти текст
                                  </button>
                                  <button
                                      onClick={handleAnalyzeText}
                                      disabled={isAnalyzing || isSavingTextOnly}
                                      className="bg-green-600 text-white px-6 py-3 rounded-lg flex items-center gap-2 font-bold shadow-md hover:bg-green-700 transition-transform hover:scale-105"
                                  >
                                      {isAnalyzing ? <Loader2 className="animate-spin" size={20} /> : <Wand2 size={20} />}
                                      Analyze Resume & Generate Profile
                                  </button>
                              </div>
                          </div>
                      )}
                  </div>
              )}

              {/* 3. Saved Profiles List */}
              <div className="mt-12 pt-8 border-t">
                 <h3 className="font-bold mb-4">{t('settings.resume.savedProfiles')}</h3>
                 {isLoadingProfiles ? <Loader2 className="animate-spin" /> : profiles.map(p => (
                    <div key={p.id} className={`p-4 mb-3 rounded-lg border flex justify-between items-center ${p.isActive ? 'bg-blue-50 border-blue-200' : 'bg-white hover:bg-slate-50'}`}>
                       <div className="flex items-center gap-3">
                           <div className={`p-2 rounded-full ${p.isActive ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-400'}`}><User size={20}/></div>
                           <div>
                               <div className="font-medium text-slate-900 flex items-center gap-2">
                                   {p.name}
                                   {p.isActive && <span className="bg-blue-200 text-blue-800 text-[10px] px-2 py-0.5 rounded-full uppercase font-bold">{t('settings.resume.activeBadge')}</span>}
                                   {p.source_type === 'edited' ? (
                                       <span className="bg-amber-100 text-amber-700 text-[10px] px-2 py-0.5 rounded-full uppercase font-bold">Edited</span>
                                   ) : (
                                       <span className="bg-green-100 text-green-700 text-[10px] px-2 py-0.5 rounded-full uppercase font-bold">Generated</span>
                                   )}
                               </div>
                               <div className="text-xs text-slate-500">
                                   {new Date(p.createdAt).toLocaleDateString()} • {p.resumeCount} source(s)
                                   {p.parent_profile_id && <span className="ml-2 text-amber-600">← edited from original</span>}
                               </div>
                           </div>
                       </div>
                       <div className="flex gap-2">
                          {/* Source Files button */}
                          {p.sourceFiles && p.sourceFiles.length > 0 && (
                              <button
                                  onClick={() => setViewFilesProfile(p)}
                                  className="text-xs border px-2 py-1.5 rounded bg-white hover:bg-amber-50 text-amber-600 border-amber-200 flex items-center gap-1"
                                  title="Переглянути файли"
                              >
                                  <Files size={14}/> {p.sourceFiles.length}
                              </button>
                          )}
                          {/* Raw Text button */}
                          {p.raw_resume_text && (
                              <button
                                  onClick={() => setViewRawTextProfile(p)}
                                  className="text-xs border px-2 py-1.5 rounded bg-white hover:bg-purple-50 text-purple-600 border-purple-200 flex items-center gap-1"
                                  title="Переглянути витягнутий текст"
                              >
                                  <ScrollText size={14}/>
                              </button>
                          )}
                          <button onClick={() => openProfileEditor(p)} className="text-xs border px-3 py-1.5 rounded bg-white hover:bg-slate-50 text-slate-600 flex items-center gap-1"><Eye size={14}/> {t('settings.resume.viewContent')}</button>
                          {!p.isActive && <button onClick={() => handleSetActive(p.id)} className="text-xs border px-3 py-1.5 rounded hover:bg-blue-50 text-blue-600 border-blue-200">{t('settings.resume.setActive')}</button>}
                          <button onClick={() => handleDelete(p.id)} className="text-red-400 hover:text-red-600 p-1.5"><Trash2 size={16} /></button>
                       </div>
                    </div>
                 ))}
              </div>
           </div>
        )}

        {/* --- Search Tab --- */}
        {activeTab === 'search' && (
          <div className="max-w-2xl animate-fade-in">
             <div className="flex justify-between items-center mb-4">
                <h3 className="font-bold text-lg text-slate-800">{t('settings.search.title')}</h3>
                <button onClick={saveUrls} disabled={isSavingUrls} className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-2 text-sm font-medium hover:bg-blue-700">
                    {isSavingUrls ? <Loader2 className="animate-spin" size={16}/> : <Save size={16}/>} {t('settings.search.save')}
                </button>
             </div>
             
             <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 mb-6">
                <form onSubmit={addUrl} className="flex gap-2">
                    <input 
                        type="url" 
                        placeholder={t('settings.search.placeholder')} 
                        className="flex-1 p-2 border border-slate-300 rounded-lg text-sm"
                        value={newUrl}
                        onChange={e => setNewUrl(e.target.value)}
                    />
                    <button type="submit" className="bg-white border border-slate-300 text-slate-700 px-4 py-2 rounded-lg hover:bg-slate-100 flex items-center gap-2 text-sm font-medium">
                        <Plus size={16}/> {t('settings.search.add')}
                    </button>
                </form>
             </div>

             <div className="space-y-2">
                {isLoadingUrls ? <Loader2 className="animate-spin text-blue-500 mx-auto"/> : searchUrls.map((url, idx) => (
                    <div key={idx} className="flex items-center gap-2 bg-white p-3 rounded-lg border border-slate-200 shadow-sm group">
                        <Globe size={16} className="text-slate-400"/>
                        <span className="flex-1 text-sm text-slate-600 truncate">{url}</span>
                        <button onClick={() => removeUrl(idx)} className="text-slate-400 hover:text-red-500 p-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Trash2 size={16}/>
                        </button>
                    </div>
                ))}
                {searchUrls.length === 0 && <div className="text-center text-slate-400 italic py-4">No URLs added yet.</div>}
             </div>

             {/* LinkedIn Section */}
             <div className="mt-8 bg-white rounded-xl border border-purple-200 shadow-sm p-6">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                            <span className="text-purple-600 font-bold text-sm">in</span>
                        </div>
                        <div>
                            <h3 className="font-bold text-slate-800">LinkedIn</h3>
                            <p className="text-xs text-slate-500">Job search by keywords (1-2x/day)</p>
                        </div>
                    </div>
                    <button
                        onClick={async () => {
                            setLinkedinEnabled(!linkedinEnabled);
                            setIsSavingLinkedin(true);
                            try { await api.settings.saveLinkedInSettings(linkedinTerms, !linkedinEnabled, linkedinLocation); } catch(e) {}
                            setIsSavingLinkedin(false);
                        }}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${linkedinEnabled ? 'bg-purple-600' : 'bg-slate-300'}`}
                    >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${linkedinEnabled ? 'translate-x-6' : 'translate-x-1'}`}/>
                    </button>
                </div>

                {linkedinEnabled && (
                    <>
                        <div className="mb-4">
                            <label className="text-xs font-medium text-slate-600 mb-1 block">Location / Lokasjon</label>
                            <input
                                type="text"
                                value={linkedinLocation}
                                onChange={e => setLinkedinLocation(e.target.value)}
                                placeholder="Norway"
                                className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                            />
                            <p className="text-xs text-slate-400 mt-1">Examples: Norway, Oslo, Gjøvik, Innlandet</p>
                        </div>

                        <div className="bg-purple-50 p-4 rounded-xl border border-purple-100 mb-4">
                            <form onSubmit={e => {
                                e.preventDefault();
                                if (newLinkedinTerm.trim() && linkedinTerms.length < 5) {
                                    setLinkedinTerms([...linkedinTerms, newLinkedinTerm.trim()]);
                                    setNewLinkedinTerm('');
                                }
                            }} className="flex gap-2">
                                <input
                                    type="text"
                                    placeholder="Enter keyword: utvikler, IT support, prosjektleder..."
                                    className="flex-1 p-2 border border-purple-200 rounded-lg text-sm"
                                    value={newLinkedinTerm}
                                    onChange={e => setNewLinkedinTerm(e.target.value)}
                                    maxLength={50}
                                />
                                <button type="submit" disabled={linkedinTerms.length >= 5} className="bg-white border border-purple-300 text-purple-700 px-4 py-2 rounded-lg hover:bg-purple-50 flex items-center gap-2 text-sm font-medium disabled:opacity-50">
                                    <Plus size={16}/> Add
                                </button>
                            </form>
                            <p className="text-xs text-purple-400 mt-1">{linkedinTerms.length}/5 keywords</p>
                        </div>

                        <div className="space-y-2 mb-4">
                            {isLoadingLinkedin ? <Loader2 className="animate-spin text-purple-500 mx-auto"/> : linkedinTerms.map((term, idx) => (
                                <div key={idx} className="flex items-center gap-2 bg-white p-3 rounded-lg border border-purple-200 shadow-sm group">
                                    <Search size={16} className="text-purple-400"/>
                                    <span className="flex-1 text-sm text-slate-600">{term}</span>
                                    <button onClick={() => { const t = [...linkedinTerms]; t.splice(idx, 1); setLinkedinTerms(t); }} className="text-slate-400 hover:text-red-500 p-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <Trash2 size={16}/>
                                    </button>
                                </div>
                            ))}
                            {linkedinTerms.length === 0 && <div className="text-center text-purple-300 italic py-4">No keywords yet. Add keywords to search LinkedIn.</div>}
                        </div>

                        <button
                            onClick={async () => {
                                setIsSavingLinkedin(true);
                                try { await api.settings.saveLinkedInSettings(linkedinTerms, linkedinEnabled, linkedinLocation); } catch(e) {}
                                setIsSavingLinkedin(false);
                            }}
                            disabled={isSavingLinkedin}
                            className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 flex items-center gap-2 text-sm font-medium disabled:opacity-50"
                        >
                            {isSavingLinkedin ? <Loader2 className="animate-spin" size={14}/> : <Save size={14}/>} Save LinkedIn Settings
                        </button>
                    </>
                )}
             </div>
          </div>
        )}

        {/* --- AI Config Tab --- */}
        {activeTab === 'ai_config' && (
           <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fade-in">
               <div className="lg:col-span-1 space-y-2">
                  <button onClick={() => setActivePromptTab('gen')} className={`w-full text-left p-3 rounded-lg border text-sm font-medium transition-colors ${activePromptTab === 'gen' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{t('settings.aiConfig.genTab')}</button>
                  <button onClick={() => setActivePromptTab('analyze')} className={`w-full text-left p-3 rounded-lg border text-sm font-medium transition-colors ${activePromptTab === 'analyze' ? 'bg-purple-50 border-purple-200 text-purple-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{t('settings.aiConfig.analyzeTab')}</button>
                  <button onClick={() => setActivePromptTab('app')} className={`w-full text-left p-3 rounded-lg border text-sm font-medium transition-colors ${activePromptTab === 'app' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{t('settings.aiConfig.appTab')}</button>
                  
                  <div className="mt-6 p-4 bg-slate-50 rounded-xl border border-slate-200">
                      <h4 className="font-bold text-slate-700 text-sm mb-2">{t('settings.aiConfig.analysisLangTitle')}</h4>
                      <p className="text-xs text-slate-500 mb-3">{t('settings.aiConfig.analysisLangDesc')}</p>
                      <div className="flex gap-2">
                          <button onClick={() => setAnalysisLang('uk')} className={`flex-1 py-1.5 text-xs rounded border ${analysisLang === 'uk' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300'}`}>🇺🇦 UK</button>
                          <button onClick={() => setAnalysisLang('no')} className={`flex-1 py-1.5 text-xs rounded border ${analysisLang === 'no' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300'}`}>🇳🇴 NO</button>
                          <button onClick={() => setAnalysisLang('en')} className={`flex-1 py-1.5 text-xs rounded border ${analysisLang === 'en' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300'}`}>🇬🇧 EN</button>
                      </div>
                  </div>
               </div>

               <div className="lg:col-span-2">
                   <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 h-full flex flex-col">
                       <div className="flex justify-between items-center mb-4">
                           <h3 className="font-bold text-slate-800">
                               {activePromptTab === 'gen' ? 'Profile Generation Prompt' : activePromptTab === 'analyze' ? 'Job Analysis Prompt' : 'Application Writer Prompt'}
                           </h3>
                           <button onClick={saveCurrentPrompt} disabled={isSavingPrompts} className="text-xs bg-slate-900 text-white px-3 py-2 rounded-lg hover:bg-slate-800 flex items-center gap-2">
                               {isSavingPrompts ? <Loader2 className="animate-spin" size={14}/> : <Save size={14}/>} {t('settings.aiConfig.savePrompt')}
                           </button>
                       </div>
                       <textarea 
                           className="flex-1 w-full p-4 bg-slate-50 border border-slate-200 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 outline-none resize-none"
                           value={activePromptTab === 'gen' ? genPrompt : activePromptTab === 'analyze' ? analyzePrompt : appPrompt}
                           onChange={e => {
                               if (activePromptTab === 'gen') setGenPrompt(e.target.value);
                               else if (activePromptTab === 'analyze') setAnalyzePrompt(e.target.value);
                               else setAppPrompt(e.target.value);
                           }}
                       />
                       <p className="text-xs text-slate-400 mt-2">
                           Variables like <code>{'${jobDescription}'}</code> and <code>{'${profile}'}</code> are injected automatically.
                       </p>
                   </div>
               </div>
           </div>
        )}

        {/* --- Automation Tab --- */}
        {activeTab === 'credentials' && (
            <div className="animate-fade-in">
                <div className="flex items-center gap-3 mb-6">
                    <div className="p-2 rounded-lg bg-amber-100 text-amber-600">
                        <Key size={24}/>
                    </div>
                    <div>
                        <h3 className="font-bold text-lg text-slate-900">Збережені облікові дані</h3>
                        <p className="text-sm text-slate-500">Логіни та паролі для сайтів рекрутингу</p>
                    </div>
                </div>

                {/* Add new credential form */}
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-6">
                    <h4 className="font-medium text-slate-700 mb-3 flex items-center gap-2"><Plus size={16}/> Додати логін</h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <input
                            type="text"
                            placeholder="Домен (webcruiter.com)"
                            value={newCredDomain}
                            onChange={e => setNewCredDomain(e.target.value)}
                            className="p-2.5 border border-slate-300 rounded-lg text-sm"
                        />
                        <input
                            type="email"
                            placeholder="Email"
                            value={newCredEmail}
                            onChange={e => setNewCredEmail(e.target.value)}
                            className="p-2.5 border border-slate-300 rounded-lg text-sm"
                        />
                        <div className="flex gap-2">
                            <input
                                type="text"
                                placeholder="Пароль"
                                value={newCredPassword}
                                onChange={e => setNewCredPassword(e.target.value)}
                                className="flex-1 p-2.5 border border-slate-300 rounded-lg text-sm font-mono"
                            />
                            <button
                                onClick={saveNewCredential}
                                disabled={isSavingCred || !newCredDomain.trim() || !newCredEmail.trim() || !newCredPassword.trim()}
                                className="bg-blue-600 text-white px-4 rounded-lg hover:bg-blue-700 disabled:opacity-40 flex items-center gap-1.5 text-sm font-medium whitespace-nowrap"
                            >
                                {isSavingCred ? <Loader2 className="animate-spin" size={14}/> : <Save size={14}/>} Зберегти
                            </button>
                        </div>
                    </div>
                </div>

                {isLoadingCredentials ? (
                    <div className="flex justify-center py-20"><Loader2 className="animate-spin text-blue-600" size={32}/></div>
                ) : siteCredentials.length === 0 ? (
                    <div className="text-center py-16 text-slate-400">
                        <Key size={48} className="mx-auto mb-4 opacity-30"/>
                        <p className="font-medium">Немає збережених облікових даних</p>
                        <p className="text-sm mt-1">Додайте вручну або вони з'являться автоматично після реєстрації через бота</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto border border-slate-200 rounded-xl">
                        <table className="w-full text-sm">
                            <thead className="bg-slate-50 border-b border-slate-200">
                                <tr>
                                    <th className="text-left px-4 py-3 font-semibold text-slate-600">Сайт</th>
                                    <th className="text-left px-4 py-3 font-semibold text-slate-600">Email</th>
                                    <th className="text-left px-4 py-3 font-semibold text-slate-600">Пароль</th>
                                    <th className="text-left px-4 py-3 font-semibold text-slate-600">Статус</th>
                                    <th className="text-left px-4 py-3 font-semibold text-slate-600">Оновлено</th>
                                    <th className="px-4 py-3"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {siteCredentials.map(cred => (
                                    <tr key={cred.id} className="hover:bg-slate-50 transition-colors">
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-2">
                                                <Globe size={14} className="text-slate-400 shrink-0"/>
                                                <div>
                                                    <div className="font-medium text-slate-800">{cred.site_name || cred.site_domain}</div>
                                                    {cred.site_name && <div className="text-xs text-slate-400">{cred.site_domain}</div>}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-4 py-3">
                                            <code className="text-xs bg-slate-100 px-2 py-0.5 rounded">{cred.email || '—'}</code>
                                        </td>
                                        <td className="px-4 py-3">
                                            {cred.password ? (
                                                <div className="flex items-center gap-1.5">
                                                    <code className="text-xs bg-slate-100 px-2 py-0.5 rounded font-mono">
                                                        {cred.password}
                                                    </code>
                                                    <button
                                                        onClick={() => { navigator.clipboard.writeText(cred.password!); }}
                                                        className="text-slate-400 hover:text-slate-600 p-0.5"
                                                        title="Копіювати"
                                                    >
                                                        <Copy size={14}/>
                                                    </button>
                                                </div>
                                            ) : (
                                                <span className="text-xs text-slate-400">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                                                cred.status === 'active' ? 'bg-green-100 text-green-700' :
                                                cred.status === 'inactive' ? 'bg-slate-100 text-slate-600' :
                                                cred.status === 'login_failed' ? 'bg-red-100 text-red-700' :
                                                'bg-amber-100 text-amber-700'
                                            }`}>
                                                {cred.status}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-xs text-slate-400">
                                            {new Date(cred.updated_at).toLocaleDateString('uk-UA')}
                                        </td>
                                        <td className="px-4 py-3">
                                            <button onClick={() => deleteCredential(cred.id)} className="text-red-400 hover:text-red-600 p-1" title="Видалити">
                                                <Trash2 size={14}/>
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        )}

        {activeTab === 'automation' && (
            <div className="animate-fade-in max-w-3xl">
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 mb-6">
                    <div className="flex justify-between items-center mb-6">
                        <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-lg ${autoEnabled ? 'bg-green-100 text-green-600' : 'bg-slate-100 text-slate-400'}`}>
                                <Zap size={24}/>
                            </div>
                            <div>
                                <h3 className="font-bold text-lg text-slate-900">{t('settings.automation.title')}</h3>
                                <p className="text-sm text-slate-500">{autoEnabled ? 'Active and scheduled.' : 'Currently disabled.'}</p>
                            </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" className="sr-only peer" checked={autoEnabled} onChange={e => setAutoEnabled(e.target.checked)} />
                            <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                        </label>
                    </div>

                    {/* Next Scan Info */}
                    {autoEnabled && scanTime && (
                        <div className="bg-gradient-to-r from-green-50 to-blue-50 border border-green-200 rounded-lg p-4 mb-6">
                            <div className="flex items-center gap-4 text-sm">
                                <div className="flex items-center gap-2 text-green-700">
                                    <Clock size={16} />
                                    <span>Сканування щодня о <b>{calculateNextScan(scanTime).nextScanDate}</b></span>
                                </div>
                                <div className="flex items-center gap-2 bg-white px-3 py-1 rounded-full border border-green-200 text-green-800">
                                    <Calendar size={14} />
                                    <span>Наступне через <b>{calculateNextScan(scanTime).nextScanIn}</b></span>
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-6 border-t border-slate-100">
                        <div>
                            <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">{t('settings.automation.runTime')}</label>
                            <input 
                                type="time" 
                                value={scanTime} 
                                onChange={e => setScanTime(e.target.value)}
                                className="w-full p-2 border border-slate-300 rounded-lg"
                            />
                        </div>
                        <div className="flex items-end">
                            <button onClick={saveAutomation} disabled={isSavingAuto} className="w-full bg-slate-900 text-white px-4 py-2.5 rounded-lg font-medium hover:bg-slate-800 flex justify-center items-center gap-2">
                                {isSavingAuto ? <Loader2 className="animate-spin" size={16}/> : <Save size={16}/>} {t('settings.automation.save')}
                            </button>
                        </div>
                    </div>
                </div>

                {/* --- Auto-Søknad Section --- */}
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 mb-6">
                    <div className="flex justify-between items-center mb-6">
                        <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-lg ${autoSoknadEnabled ? 'bg-purple-100 text-purple-600' : 'bg-slate-100 text-slate-400'}`}>
                                <FileText size={24}/>
                            </div>
                            <div>
                                <h3 className="font-bold text-lg text-slate-900">{t('settings.automation.autoSoknad.title')}</h3>
                                <p className="text-sm text-slate-500">
                                    {autoSoknadEnabled ? `Active (≥ ${autoSoknadMinScore}%)` : t('settings.automation.autoSoknad.subtitle')}
                                </p>
                            </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" className="sr-only peer" checked={autoSoknadEnabled} onChange={e => setAutoSoknadEnabled(e.target.checked)} />
                            <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-purple-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
                        </label>
                    </div>

                    {autoSoknadEnabled && (
                        <div className="pt-4 border-t border-slate-100">
                            <label className="text-xs font-bold text-slate-500 uppercase mb-2 block">
                                {t('settings.automation.autoSoknad.threshold')}
                            </label>
                            <div className="flex items-center gap-4">
                                <input
                                    type="range"
                                    min="0"
                                    max="100"
                                    step="5"
                                    value={autoSoknadMinScore}
                                    onChange={e => setAutoSoknadMinScore(Number(e.target.value))}
                                    className="flex-1 h-2 rounded-lg appearance-none cursor-pointer accent-purple-600"
                                />
                                <span className={`text-lg font-bold min-w-[3rem] text-center ${
                                    autoSoknadMinScore >= 70 ? 'text-green-600' : autoSoknadMinScore >= 40 ? 'text-yellow-600' : 'text-red-500'
                                }`}>
                                    {autoSoknadMinScore}%
                                </span>
                            </div>
                            <p className="text-xs text-slate-400 mt-1">{t('settings.automation.autoSoknad.thresholdHint')}</p>
                        </div>
                    )}

                    <div className="mt-4">
                        <button onClick={saveAutoSoknad} disabled={isSavingAutoSoknad} className="w-full bg-slate-900 text-white px-4 py-2.5 rounded-lg font-medium hover:bg-slate-800 flex justify-center items-center gap-2">
                            {isSavingAutoSoknad ? <Loader2 className="animate-spin" size={16}/> : <Save size={16}/>} {t('settings.automation.autoSoknad.save')}
                        </button>
                    </div>
                </div>

                {/* --- Telegram Bot Section --- */}
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 mb-6">
                    <div className="flex items-center gap-3 mb-6">
                        <div className={`p-2 rounded-lg ${telegramChatId ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-400'}`}>
                            <MessageCircle size={24}/>
                        </div>
                        <div>
                            <h3 className="font-bold text-lg text-slate-900">Telegram Bot</h3>
                            <p className="text-sm text-slate-500">
                                {telegramChatId ? 'Підключено - сповіщення активні' : 'Не підключено'}
                            </p>
                        </div>
                    </div>

                    {isLoadingTelegram ? (
                        <div className="flex justify-center py-8">
                            <Loader2 className="animate-spin text-blue-600" size={24}/>
                        </div>
                    ) : telegramChatId ? (
                        /* Connected State */
                        <div className="space-y-4">
                            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                                <div className="flex items-center gap-2 text-green-700 mb-2">
                                    <CheckCircle size={18}/>
                                    <span className="font-medium">Telegram підключено</span>
                                </div>
                                <div className="text-sm text-green-600">
                                    Chat ID: <code className="bg-green-100 px-2 py-0.5 rounded">{telegramChatId}</code>
                                </div>
                            </div>
                            <button
                                onClick={handleDisconnectTelegram}
                                disabled={isDisconnecting}
                                className="flex items-center gap-2 text-red-600 hover:text-red-700 text-sm font-medium px-4 py-2 border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
                            >
                                {isDisconnecting ? <Loader2 className="animate-spin" size={16}/> : <Unlink size={16}/>}
                                Від'єднати Telegram
                            </button>
                        </div>
                    ) : (
                        /* Not Connected State */
                        <div className="space-y-4">
                            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                                <div className="flex items-center gap-2 text-amber-700 mb-2">
                                    <AlertCircle size={18}/>
                                    <span className="font-medium">Telegram не підключено</span>
                                </div>
                                <p className="text-sm text-amber-600">
                                    Підключіть Telegram для отримання сповіщень про нові вакансії та 2FA коди.
                                </p>
                            </div>

                            {/* Link Code Section */}
                            <div className="border border-slate-200 rounded-lg p-4">
                                <h4 className="font-medium text-slate-800 mb-3 flex items-center gap-2">
                                    <Link2 size={16}/>
                                    Код привязки
                                </h4>

                                {telegramLinkCode && !isCodeExpired() ? (
                                    <div className="space-y-3">
                                        <div className="flex items-center gap-2">
                                            <div className="flex-1 bg-slate-100 border border-slate-200 rounded-lg px-4 py-3 font-mono text-2xl text-center tracking-widest text-slate-800">
                                                {telegramLinkCode}
                                            </div>
                                            <button
                                                onClick={handleCopyCode}
                                                className="p-3 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                                                title="Копіювати код"
                                            >
                                                {codeCopied ? <Check size={20} className="text-green-600"/> : <Copy size={20} className="text-slate-500"/>}
                                            </button>
                                        </div>
                                        <div className="flex items-center justify-between text-sm">
                                            <span className="text-slate-500">
                                                Дійсний: <span className="font-medium text-slate-700">{getCodeExpirationText()}</span>
                                            </span>
                                            <button
                                                onClick={handleGenerateTelegramCode}
                                                disabled={isGeneratingCode}
                                                className="text-blue-600 hover:text-blue-700 flex items-center gap-1"
                                            >
                                                {isGeneratingCode ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>}
                                                Новий код
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <button
                                        onClick={handleGenerateTelegramCode}
                                        disabled={isGeneratingCode}
                                        className="w-full bg-blue-600 text-white px-4 py-2.5 rounded-lg font-medium hover:bg-blue-700 flex justify-center items-center gap-2 transition-colors"
                                    >
                                        {isGeneratingCode ? <Loader2 className="animate-spin" size={16}/> : <Key size={16}/>}
                                        Згенерувати код
                                    </button>
                                )}
                            </div>

                            {/* Instructions */}
                            <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                                <h4 className="font-medium text-slate-800 mb-2">Інструкція:</h4>
                                <ol className="text-sm text-slate-600 space-y-2">
                                    <li className="flex gap-2">
                                        <span className="bg-slate-200 text-slate-700 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold shrink-0">1</span>
                                        <span>Знайдіть бота <code className="bg-slate-200 px-1.5 py-0.5 rounded text-slate-800">@JobBotNorwayBot</code> в Telegram</span>
                                    </li>
                                    <li className="flex gap-2">
                                        <span className="bg-slate-200 text-slate-700 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold shrink-0">2</span>
                                        <span>Надішліть команду: <code className="bg-blue-100 px-1.5 py-0.5 rounded text-blue-800">/link {telegramLinkCode || 'XXXXXX'}</code></span>
                                    </li>
                                    <li className="flex gap-2">
                                        <span className="bg-slate-200 text-slate-700 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold shrink-0">3</span>
                                        <span>Отримайте підтвердження про успішне підключення</span>
                                    </li>
                                </ol>
                            </div>
                        </div>
                    )}
                </div>

                <div className="bg-slate-900 rounded-xl shadow-lg overflow-hidden text-slate-300 font-mono text-xs">
                    <div className="bg-slate-800 p-3 flex justify-between items-center border-b border-slate-700">
                        <span className="flex items-center gap-2 font-bold text-white"><Terminal size={14}/> {t('settings.automation.debug')}</span>
                        <button onClick={triggerManualScan} disabled={isScanning} className="bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-500 flex items-center gap-1 text-[10px] font-bold">
                            {isScanning ? <Loader2 className="animate-spin" size={12}/> : <Play size={12}/>} {t('settings.automation.runTest')}
                        </button>
                    </div>
                    <div className="p-4 h-64 overflow-y-auto space-y-1">
                        {scanLogs.length === 0 ? <span className="text-slate-600 italic">// Logs will appear here...</span> : scanLogs.map((log, i) => (
                            <div key={i} className="border-b border-slate-800/50 pb-1 mb-1 last:border-0">{log}</div>
                        ))}
                    </div>
                </div>
            </div>
        )}

        {/* --- EDITOR MODAL (For Resume Tab Viewing) --- */}
        {editingProfile && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
                <div className="bg-white rounded-xl w-full max-w-5xl max-h-[90vh] flex flex-col shadow-2xl animate-fade-in">
                    <div className="p-4 border-b flex justify-between items-center bg-slate-50 rounded-t-xl">
                        <div>
                            <h3 className="font-bold text-lg text-slate-800">{editingProfile.name}</h3>
                            <p className="text-xs text-slate-500">Structured Profile Editor</p>
                        </div>
                        <button onClick={() => setEditingProfile(null)} className="text-slate-400 hover:text-slate-700 p-2 hover:bg-slate-200 rounded-full"><X size={24} /></button>
                    </div>
                    
                    <div className="flex-1 overflow-y-auto bg-slate-100 p-4">
                        {parsedJson ? (
                            <ProfileEditor initialData={parsedJson} onSave={saveProfileChanges} />
                        ) : (
                            <div className="bg-white p-6 rounded-xl border border-yellow-200 text-center">
                                <AlertCircle size={40} className="text-yellow-500 mx-auto mb-4" />
                                <h4 className="font-bold text-slate-800 mb-2">No Structured Data</h4>
                                <p className="text-sm text-slate-600 mb-4">This profile was created with an older version. <br/>You need to generate structured data from the text first.</p>
                                <button 
                                    onClick={async () => {
                                        if(!editingProfile.content) return;
                                        const res = await api.cv.analyzeResumes([], genPrompt, UPGRADE_PROMPT, editingProfile.content);
                                        if (res.json) {
                                            setParsedJson(res.json);
                                            await api.cv.updateProfileContent(editingProfile.id, editingProfile.content, res.json);
                                        }
                                    }}
                                    className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm"
                                >
                                    Upgrade to Structured Profile
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        )}

        {/* --- View Source Files Modal --- */}
        {viewFilesProfile && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
                <div className="bg-white rounded-xl w-full max-w-lg shadow-2xl animate-fade-in">
                    <div className="p-4 border-b flex justify-between items-center bg-amber-50 rounded-t-xl">
                        <div className="flex items-center gap-2">
                            <Files size={20} className="text-amber-600"/>
                            <div>
                                <h3 className="font-bold text-slate-800">Файли профілю</h3>
                                <p className="text-xs text-slate-500">{viewFilesProfile.name}</p>
                            </div>
                        </div>
                        <button onClick={() => setViewFilesProfile(null)} className="text-slate-400 hover:text-slate-700 p-2 hover:bg-amber-100 rounded-full"><X size={20} /></button>
                    </div>
                    <div className="p-4 max-h-[60vh] overflow-y-auto">
                        {viewFilesProfile.sourceFiles && viewFilesProfile.sourceFiles.length > 0 ? (
                            <div className="space-y-2">
                                {viewFilesProfile.sourceFiles.map((file, idx) => (
                                    <div key={idx} className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200">
                                        <FileText size={18} className="text-amber-500"/>
                                        <span className="text-sm text-slate-700 flex-1 truncate">{file}</span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="text-slate-400 text-center italic py-4">Немає файлів</p>
                        )}
                    </div>
                </div>
            </div>
        )}

        {/* --- View Raw Text Modal --- */}
        {viewRawTextProfile && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
                <div className="bg-white rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl animate-fade-in">
                    <div className="p-4 border-b flex justify-between items-center bg-purple-50 rounded-t-xl">
                        <div className="flex items-center gap-2">
                            <ScrollText size={20} className="text-purple-600"/>
                            <div>
                                <h3 className="font-bold text-slate-800">Витягнутий текст резюме</h3>
                                <p className="text-xs text-slate-500">{viewRawTextProfile.name}</p>
                            </div>
                        </div>
                        <button onClick={() => setViewRawTextProfile(null)} className="text-slate-400 hover:text-slate-700 p-2 hover:bg-purple-100 rounded-full"><X size={20} /></button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4">
                        {viewRawTextProfile.raw_resume_text ? (
                            <div className="bg-slate-50 p-4 rounded-lg border border-slate-200 font-mono text-xs text-slate-700 whitespace-pre-wrap">
                                {viewRawTextProfile.raw_resume_text}
                            </div>
                        ) : (
                            <p className="text-slate-400 text-center italic py-4">Немає витягнутого тексту для цього профілю</p>
                        )}
                    </div>
                </div>
            </div>
        )}
      </div>
    </div>
  );
};
