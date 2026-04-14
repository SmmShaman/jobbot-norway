
import { supabase } from './supabase';
import { Job, JobStatus, DashboardStats, CVProfile, Application, UserSettings, KnowledgeBaseItem, SystemLog, AdminUser, RadarMetric, Aura, StructuredProfile, ExportHistory } from '../types';
import { Language } from './translations';

// Fallback colors for aura status (in case AI didn't provide color)
const AURA_COLOR_MAP: Record<string, string> = {
    'Toxic': '#ef4444',
    'Growth': '#22c55e',
    'Balanced': '#3b82f6',
    'Chill': '#06b6d4',
    'Grind': '#a855f7',
    'Neutral': '#6b7280'
};

// Comprehensive list of Norwegian cities and municipalities (focus on Innlandet/Viken based on user data)
const NORWEGIAN_CITIES = [
    // Major Cities
    "Oslo", "Bergen", "Trondheim", "Stavanger", "Kristiansand", "Drammen", "Fredrikstad", "Tromsø", "Sandnes", "Sarpsborg", "Skien", "Ålesund", "Sandefjord", "Haugesund", "Tønsberg", "Moss", "Porsgrunn", "Bodø", "Arendal", "Hamar", "Larvik", "Halden", "Kongsberg", "Molde", "Horten", "Gjøvik", "Lillehammer", "Mo i Rana", "Kristiansund", "Harstad", "Narvik", "Kongsvinger", "Elverum", "Brumunddal", "Askim", "Drøbak", "Steinkjer", "Nesodden", "Egersund", "Vennesla", "Mandal", "Grimstad", "Mosjøen", "Eidsvoll", "Alta", "Søgne", "Notodden", "Florø", "Namsos", "Førde", "Levanger", "Lillestrøm", "Bryne", "Knarrevik", "Råholt",
    
    // Innlandet & Surroundings (User's specific region)
    "Raufoss", "Lena", "Skreia", "Kapp", "Bøverbru", "Eina", "Reinsvoll", "Hunndalen", "Biri", "Snertingdal", // Toten/Gjøvik areas
    "Dokka", "Hov", "Fagernes", "Leira", "Bagn", "Beitostølen", // Valdres/Land
    "Gran", "Jaren", "Brandbu", "Lunner", "Harestua", "Grua", "Jevnaker", // Hadeland
    "Moelv", "Brumunddal", "Stange", "Løten", "Ilseng", "Ottestad", "Ridabu", "Ingeberg", // Hamar region
    "Vinstra", "Otta", "Lom", "Vågå", "Dombås", "Ringebu", "Hundorp", // Gudbrandsdalen
    "Tynset", "Alvdal", "Røros", "Tolga", "Os", "Koppang", "Rena", "Trysil", "Nybergsund", "Innbygda", // Østerdalen
    "Flisa", "Kirkenær", "Kongsvinger", "Skarnes", "Magnor", // Glåmdalen
    "Øyer", "Tretten", "Gausdal", "Segalstad Bru", "Follebu", // Lillehammer region
    "Svingvoll", "Skeikampen", "Hafjell", "Kvitfjell", "Beitostølen", // Ski destinations
    
    // Municipalities / Regions often used as location
    "Vestre Toten", "Østre Toten", "Nordre Land", "Søndre Land", "Gjøvik", "Lillehammer", "Ringsaker", "Hamar", "Stange", "Løten", "Elverum", "Trysil", "Åmot", "Stor-Elvdal", "Rendalen", "Engerdal", "Tolga", "Tynset", "Alvdal", "Folldal", "Os", "Dovre", "Lesja", "Skjåk", "Lom", "Vågå", "Nord-Fron", "Sør-Fron", "Ringebu", "Øyer", "Gausdal", "Gran", "Lunner", "Jevnaker", "Vang", "Vestre Slidre", "Øystre Slidre", "Nord-Aurdal", "Sør-Aurdal", "Etnedal",
    "Innlandet", "Viken", "Oslo", "Vestland", "Rogaland", "Møre og Romsdal", "Trøndelag", "Nordland", "Troms", "Finnmark", "Agder", "Vestfold", "Telemark"
];

const isGenericLocation = (loc: string) => {
    if (!loc) return true;
    const l = loc.toLowerCase().trim();
    return l === 'norway' || l === 'norge' || l === 'innlandet' || l === 'vestland' || l === 'rogland' || l === 'viken' || l === 'unknown' || l === '' || l === 'agder' || l === 'troms' || l === 'finnmark' || l === 'nordland' || l === 'trøndelag';
};

const extractLocation = (text: string, title?: string): string | null => {
    if (!text) return null;
    
    // 0. Clean inputs
    const cleanText = text.replace(/[\n\r]+/g, ' ').substring(0, 5000); 
    const cleanTitle = title ? title.replace(/[\n\r]+/g, ' ') : '';

    // 1. Enhanced Address Search Strategy
    // Look for ZIP (4 digits) + City, then scan BACKWARDS to find Street or Institution name.
    // e.g. "Parkgata 64, 2560 Alvdal" or "Storsteigen videregående skole, 2560 Alvdal"
    const zipCityRegex = /\b(\d{4})\s+([A-ZÆØÅ][a-zæøåA-ZÆØÅ]+(?:\s+[a-zæøåA-ZÆØÅ]+)*)/g;
    
    let match;
    while ((match = zipCityRegex.exec(cleanText)) !== null) {
        const [fullZipCity, zip, city] = match;
        const index = match.index;
        
        // Context: Look backwards 60 chars
        const contextBefore = cleanText.substring(Math.max(0, index - 60), index);
        
        // Regex: (Words/Digits) + (Optional Comma/Space) + End of string
        const streetRegex = /([A-ZÆØÅ0-9][\w\s\.\-]+?)(?:,?\s*)$/;
        const streetMatch = contextBefore.match(streetRegex);
        
        if (streetMatch) {
            const candidate = streetMatch[1].trim();
            // Filter noise: Must be longer than 3 chars and NOT be a common header word
            if (candidate.length > 3 && !/^(Tlf|Fax|Mob|Post|Box|Norge|Norway|Adresse)/i.test(candidate)) {
                return `${candidate}, ${zip} ${city}`;
            }
        }
    }

    // 2. Fallback: Simple Postal Code + City (first occurrence)
    const simpleMatch = cleanText.match(/\b(\d{4})\s+([A-ZÆØÅ][a-zæøåA-ZÆØÅ]+)/);
    if (simpleMatch) {
         const cityCandidate = simpleMatch[2];
         if (cityCandidate.length > 2 && !['Norge', 'Norway'].includes(cityCandidate)) {
             return `${simpleMatch[1]} ${cityCandidate}`;
         }
    }

    // 3. Check Title for City Names
    if (cleanTitle) {
        for (const city of NORWEGIAN_CITIES) {
            const regex = new RegExp(`\\b${city}\\b`, 'i');
            if (regex.test(cleanTitle)) {
                return city;
            }
        }
    }

    // 4. Fallback: Check Description for specific City Names
    for (const city of NORWEGIAN_CITIES) {
        const regex = new RegExp(`\\b${city}\\b`, 'i');
        if (regex.test(cleanText)) {
            return city;
        }
    }

    return null;
};

// Helper to map database job to Job interface with enhanced parsing
const mapJob = (job: any): Job => {
    // HARDENED: Prevent Null Crashes
    if (!job) {
        return {
            id: `error-${Math.random()}`, title: 'Error Loading Job', company: 'Unknown', location: 'Unknown',
            url: '#', source: 'FINN', postedDate: new Date().toISOString(), scannedAt: new Date().toISOString(),
            status: JobStatus.NEW
        };
    }

    // Defensive coding: Ensure crucial fields are never null
    const safeTitle = String(job.title || 'Untitled Position');
    const safeCompany = String(job.company || 'Unknown Company');
    let location = String(job.location || 'Norway');

    // Smart Parse Logic with Priority
    try {
        const extractedLocation = extractLocation(job.description || '', safeTitle);
        
        if (extractedLocation) {
            const dbIsGeneric = isGenericLocation(location);
            const extractedHasZip = /\d{4}/.test(extractedLocation);
            const dbHasZip = /\d{4}/.test(location);

            // Override logic: prefer full addresses or specific zips over generic region names
            if (dbIsGeneric || (extractedHasZip && !dbHasZip) || (extractedLocation.length > location.length && extractedLocation.includes(location))) {
                 location = extractedLocation;
            }
        }
    } catch (e) {
        console.warn("Location extraction failed for job:", job.id, e);
    }

    return {
        id: job.id || `unknown-${Math.random()}`,
        title: safeTitle,
        company: safeCompany,
        location: location,
        url: job.job_url || '#',
        source: job.source || 'OTHER',
        postedDate: job.created_at ? new Date(job.created_at).toLocaleDateString() : 'Unknown Date',
        scannedAt: job.created_at || new Date().toISOString(),
        status: (job.status as JobStatus) || JobStatus.NEW,
        matchScore: job.relevance_score,
        description: job.description,
        ai_recommendation: job.ai_recommendation,
        tasks_summary: job.tasks_summary,
        application_id: job.application_id,
        application_status: job.application_status || undefined,
        application_sent_at: job.application_sent_at || undefined,
        cover_letter_no: job.cover_letter_no || undefined,
        cover_letter_uk: job.cover_letter_uk || undefined,
        cost_usd: job.cost_usd,
        has_enkel_soknad: job.has_enkel_soknad || false,
        application_form_type: job.application_form_type || undefined,
        external_apply_url: job.external_apply_url || undefined,
        deadline: job.deadline || undefined,
        // Normalize aura with fallback color for old jobs
        aura: job.analysis_metadata?.aura ? {
            ...job.analysis_metadata.aura,
            color: job.analysis_metadata.aura.color || AURA_COLOR_MAP[job.analysis_metadata.aura.status] || AURA_COLOR_MAP['Neutral'],
            tags: job.analysis_metadata.aura.tags || []
        } : undefined,
        radarData: job.analysis_metadata?.radar ? [
            { subject: 'Tech Stack', A: job.analysis_metadata.radar.tech_stack || 0, fullMark: 100 },
            { subject: 'Soft Skills', A: job.analysis_metadata.radar.soft_skills || 0, fullMark: 100 },
            { subject: 'Culture', A: job.analysis_metadata.radar.culture || 0, fullMark: 100 },
            { subject: 'Salary', A: job.analysis_metadata.radar.salary_potential || 0, fullMark: 100 },
            { subject: 'Growth', A: job.analysis_metadata.radar.career_growth || 0, fullMark: 100 },
        ] : undefined
    };
};

// --- HELPER: Generate Text from JSON for LLM Context ---
export const generateProfileTextFromJSON = (p: StructuredProfile): string => {
    if (!p) return "";
    
    const personal = p.personalInfo || { fullName: '', email: '', phone: '' };
    const work = p.workExperience || [];
    const edu = p.education || [];
    const tech = p.technicalSkills || {} as Partial<StructuredProfile['technicalSkills']>;
    const langs = p.languages || [];
    
    let text = `Legacy Text Profile\nGenerated from Structured Editor at ${new Date().toLocaleString()}\n\n`;
    
    text += `1) Summary\n${p.professionalSummary || 'No summary provided.'}\n\n`;
    
    text += `2) Core Competencies & Skills\n`;
    if (p.softSkills?.length) text += `- Soft Skills: ${p.softSkills.join(', ')}\n`;
    if (tech.programmingLanguages?.length) text += `- Languages: ${tech.programmingLanguages.join(', ')}\n`;
    if (tech.frameworks?.length) text += `- Frameworks: ${tech.frameworks.join(', ')}\n`;
    if (tech.aiTools?.length) text += `- AI Tools: ${tech.aiTools.join(', ')}\n`;
    if (tech.cloudPlatforms?.length) text += `- Cloud: ${tech.cloudPlatforms.join(', ')}\n`;
    if (tech.databases?.length) text += `- Databases: ${tech.databases.join(', ')}\n`;
    if (tech.developmentTools?.length) text += `- Tools: ${tech.developmentTools.join(', ')}\n`;
    text += '\n';

    text += `3) Experience Patterns\n`;
    work.forEach((w, index) => {
        text += `${String.fromCharCode(97 + index)}) ${w.position || 'Role'} at ${w.company || 'Company'}\n`;
        text += `   Period: ${w.startDate || ''} - ${w.endDate || ''}\n`;
        if (w.responsibilities?.length) {
             text += `   - ${w.responsibilities.join('\n   - ')}\n`;
        }
        text += '\n';
    });

    text += `4) Education & Certifications\n`;
    edu.forEach(e => {
        text += `- ${e.degree || ''} in ${e.field || ''} at ${e.institution || ''} (${e.graduationYear || ''})\n`;
    });
    if (p.certifications?.length) {
        text += `\nCertifications:\n- ${p.certifications.join('\n- ')}\n`;
    }
    text += '\n';

    text += `5) Additional Information\n`;
    text += `- Name: ${personal.fullName || ''}\n`;
    text += `- Contact: ${personal.email || ''} / ${personal.phone || ''}\n`;
    if (personal.address?.street || personal.address?.postalCode) {
        text += `- Address: ${personal.address?.street || ''}, ${personal.address?.postalCode || ''} ${personal.address?.city || ''}, ${personal.address?.country || ''}\n`;
    } else {
        text += `- Location: ${personal.address?.city || ''}, ${personal.address?.country || ''}\n`;
    }
    if (personal.birthDate) {
        text += `- Birth Date: ${personal.birthDate}\n`;
    }
    if (personal.nationality) {
        text += `- Nationality: ${personal.nationality}\n`;
    }
    if (personal.gender) {
        text += `- Gender: ${personal.gender}\n`;
    }
    if (personal.driverLicense) {
        text += `- Driver's License: ${personal.driverLicense}\n`;
    }
    if (langs.length > 0) {
        text += `- Languages: ${langs.map(l => `${l.language} (${l.proficiencyLevel})`).join(', ')}\n`;
    }
    if (p.interests?.length) {
        text += `- Interests: ${p.interests.join(', ')}\n`;
    }

    return text;
};

export const api = {
  // --- REALTIME SUBSCRIPTION ---
  subscribeToChanges: (onUpdate: () => void) => {
    const channel = supabase
      .channel('db-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'jobs' },
        (payload) => {
          console.log('[Realtime] Job Change:', payload.eventType);
          onUpdate();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'applications' },
        (payload) => {
          console.log('[Realtime] Application Change:', payload.eventType);
          onUpdate();
        }
      )
      .subscribe();

    // Return cleanup function
    return () => {
      supabase.removeChannel(channel);
    };
  },

  getJobs: async (sinceDate?: string): Promise<Job[]> => {
    try {
      // Get current user for multi-user isolation
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        console.warn("getJobs: No authenticated user");
        return [];
      }

      // PostgREST max-rows (1000) caps total results BEFORE offset,
      // so .range() pagination doesn't work. Use cursor-based pagination
      // with created_at as cursor. Use lte + dedup to handle duplicate timestamps.
      const PAGE_SIZE = 1000;
      let allData: any[] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();

      for (let page = 0; page < 20; page++) { // safety: max 20k jobs
        let query = supabase
          .from('jobs')
          .select('*, applications(id, status, sent_at, cover_letter_no, cover_letter_uk)')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(PAGE_SIZE);

        // Server-side date filter to reduce payload
        if (sinceDate) {
          query = query.gte('created_at', sinceDate);
        }

        if (cursor) {
          query = query.lte('created_at', cursor);
        }

        const { data, error } = await query;

        if (error) {
          console.error("Supabase getJobs Error:", error);
          break;
        }

        if (!data || data.length === 0) break;

        let newRows = 0;
        for (const row of data) {
          if (!seen.has(row.id)) {
            seen.add(row.id);
            allData.push(row);
            newRows++;
          }
        }

        // No new unique rows = everything fetched
        if (newRows === 0) break;

        // Fewer than PAGE_SIZE = last page
        if (data.length < PAGE_SIZE) break;

        cursor = data[data.length - 1].created_at;
      }

      if (allData.length === 0) {
          console.warn("Supabase returned no data for jobs");
          return [];
      }

      console.log(`getJobs: Fetched ${allData.length} jobs`);

      // Safe Map - extract application_id and status from joined data
      return allData.map(job => {
        const app = job.applications && job.applications.length > 0
          ? job.applications[0]
          : null;
        return mapJob({
          ...job,
          application_id: app?.id || null,
          application_status: app?.status || null,
          application_sent_at: app?.sent_at || null,
          cover_letter_no: app?.cover_letter_no || null,
          cover_letter_uk: app?.cover_letter_uk || null
        });
      }).filter(Boolean);
    } catch (e) {
        console.error("Unexpected error in getJobs:", e);
        return [];
    }
  },

  getTotalCost: async (): Promise<number> => {
      // Get current user for multi-user isolation
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        console.warn("getTotalCost: No authenticated user");
        return 0;
      }

      // Cursor-based pagination to avoid PostgREST 1000-row limit
      let total = 0;
      let cursor: string | null = null;
      const PAGE_SIZE = 1000;
      for (let page = 0; page < 20; page++) {
        let query = supabase
          .from('system_logs')
          .select('cost_usd, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(PAGE_SIZE);
        if (cursor) query = query.lt('created_at', cursor);
        const { data } = await query;
        if (!data || data.length === 0) break;
        total += data.reduce((acc, curr) => acc + (curr.cost_usd || 0), 0);
        if (data.length < PAGE_SIZE) break;
        cursor = data[data.length - 1].created_at;
      }
      return total;
  },

  getSystemLogs: async (): Promise<SystemLog[]> => {
    // Get current user for multi-user isolation
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      console.warn("getSystemLogs: No authenticated user");
      return [];
    }

    const { data } = await supabase
      .from('system_logs')
      .select('*')
      .eq('user_id', user.id) // Filter by current user
      .order('created_at', { ascending: false })
      .limit(50);
    return data || [];
  },

  extractJobText: async (id: string, url: string) => {
    const { data, error } = await supabase.functions.invoke('extract_job_text', {
        body: { job_id: id, url }
    });
    if (error) return { success: false, message: error.message };
    return data;
  },

  analyzeJobs: async (jobIds: string[]) => {
     const { data: { user } } = await supabase.auth.getUser();
     const { data, error } = await supabase.functions.invoke('job-analyzer', {
         body: { jobIds, userId: user?.id }
     });
     if (error) return { success: false, message: error.message };
     return data;
  },

  getApplication: async (jobId: string): Promise<Application | null> => {
     const { data } = await supabase
        .from('applications')
        .select('*')
        .eq('job_id', jobId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
     return data;
  },

  generateApplication: async (jobId: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error } = await supabase.functions.invoke('generate_application', {
          body: { job_id: jobId, user_id: user?.id }
      });
      if (error) return { success: false, message: error.message };
      return data;
  },

  approveApplication: async (appId: string) => {
      const { error } = await supabase
          .from('applications')
          .update({ status: 'approved', approved_at: new Date().toISOString() })
          .eq('id', appId);
      return { success: !error, message: error?.message };
  },

  sendApplication: async (appId: string) => {
       const { error } = await supabase
          .from('applications')
          .update({ status: 'sending' })
          .eq('id', appId);
       return { success: !error, message: error?.message };
  },

  retrySend: async (appId: string) => {
      const { error } = await supabase
          .from('applications')
          .update({ status: 'approved' })
          .eq('id', appId);
      return { success: !error, message: error?.message };
  },

  markAsSent: async (appId: string) => {
      const { error } = await supabase
          .from('applications')
          .update({
              status: 'sent',
              sent_at: new Date().toISOString(),
              skyvern_metadata: { source: 'manual' }
          })
          .eq('id', appId);
      return { success: !error, message: error?.message };
  },

  // Fill FINN Easy Apply form via Skyvern
  fillFinnForm: async (jobId: string, applicationId: string): Promise<{ success: boolean; message?: string; taskId?: string; workerWarning?: string }> => {
      try {
          const response = await fetch(`https://ptrmidlhfdbybxmyovtm.supabase.co/functions/v1/finn-apply`, {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0cm1pZGxoZmRieWJ4bXlvdnRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI0MzQ3NDksImV4cCI6MjA3ODAxMDc0OX0.rdOIJ9iMnbz5uxmGrtxJxb0n1cwf6ee3ppz414IaDWM`
              },
              body: JSON.stringify({ jobId, applicationId })
          });

          const data = await response.json();
          return {
              success: data.success || response.ok,
              message: data.message || data.error,
              taskId: data.taskId,
              workerWarning: data.workerWarning
          };
      } catch (e: any) {
          return { success: false, message: e.message };
      }
  },

  // Cancel a running Skyvern task and reset application to 'approved'
  cancelTask: async (applicationId: string): Promise<{ success: boolean; message?: string; taskId?: string }> => {
      try {
          const response = await fetch(`https://ptrmidlhfdbybxmyovtm.supabase.co/functions/v1/cancel-task`, {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0cm1pZGxoZmRieWJ4bXlvdnRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI0MzQ3NDksImV4cCI6MjA3ODAxMDc0OX0.rdOIJ9iMnbz5uxmGrtxJxb0n1cwf6ee3ppz414IaDWM`
              },
              body: JSON.stringify({ applicationId })
          });

          const data = await response.json();
          return {
              success: data.success || response.ok,
              message: data.message || data.error,
              taskId: data.taskId
          };
      } catch (e: any) {
          return { success: false, message: e.message };
      }
  },

  cv: {
      verifyDatabaseConnection: async () => {
        const { error } = await supabase.from('cv_profiles').select('count').limit(1).single();
        return { success: !error, message: error ? error.message : 'Connected' };
      },
      getProfiles: async (): Promise<CVProfile[]> => {
        // Get current user for multi-user isolation
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          console.warn("getProfiles: No authenticated user");
          return [];
        }

        const { data } = await supabase
          .from('cv_profiles')
          .select('*')
          .eq('user_id', user.id) // Filter by current user
          .order('created_at', { ascending: false });
        return (data || []).map((d: any) => ({
            id: d.id,
            name: d.profile_name,
            content: d.content,
            structured_content: d.structured_content,
            isActive: d.is_active,
            createdAt: d.created_at,
            resumeCount: d.resume_count || 0,
            sourceFiles: d.source_files || [],
            // New versioning fields
            source_type: d.source_type || 'generated',
            raw_resume_text: d.raw_resume_text,
            parent_profile_id: d.parent_profile_id,
            profile_name: d.profile_name
        }));
    },
    getActiveProfile: async (): Promise<CVProfile | null> => {
        // Get current user for multi-user isolation
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          console.warn("getActiveProfile: No authenticated user");
          return null;
        }

        const { data, error } = await supabase
          .from('cv_profiles')
          .select('*')
          .eq('is_active', true)
          .eq('user_id', user.id) // Filter by current user
          .limit(1)
          .single();

        if (error || !data) return null;

        return {
            id: data.id,
            name: data.profile_name,
            content: data.content,
            structured_content: data.structured_content,
            isActive: data.is_active,
            createdAt: data.created_at,
            resumeCount: data.resume_count || 0,
            sourceFiles: data.source_files || [],
            // New versioning fields
            source_type: data.source_type || 'generated',
            raw_resume_text: data.raw_resume_text,
            parent_profile_id: data.parent_profile_id,
            profile_name: data.profile_name
        };
    },
    uploadResume: async (file: File): Promise<string | null> => {
        const fileName = `${Date.now()}_${file.name}`;
        const { data, error } = await supabase.storage.from('resumes').upload(fileName, file);
        if (error) return null;
        return data.path;
    },
    // Extract text ONLY (Skip AI Analysis)
    extractResumeText: async (filePaths: string[]): Promise<string> => {
         console.log("Extracting text...", { fileCount: filePaths.length });
         const { data, error } = await supabase.functions.invoke('analyze_profile', {
            body: { file_paths: filePaths, skip_analysis: true }
         });
         
         if (error) {
             console.error("Extraction Invoke Error:", error);
             throw new Error(`Extraction Failed: ${error.message || "Unknown invoke error"}`);
         }
         
         if (data && !data.success) {
             console.error("Extraction Function Error:", data.error);
             throw new Error(data.error || "Unknown extraction error");
         }

         return data.text;
    },
    analyzeResumes: async (filePaths: string[], systemPrompt: string, userPrompt: string, rawText?: string): Promise<{text: string, json: StructuredProfile | null}> => {
         console.log("Sending analysis request...", { fileCount: filePaths.length, hasRawText: !!rawText });
         const { data: { user: currentUser } } = await supabase.auth.getUser();
         const { data, error } = await supabase.functions.invoke('analyze_profile', {
            body: { file_paths: filePaths, system_prompt: systemPrompt, user_prompt: userPrompt, raw_text: rawText, user_id: currentUser?.id }
         });
         
         // Error during invocation (e.g. 500 status from Supabase gateway)
         if (error) {
            console.error("Analysis Failed (Invoke Error):", error);
            throw new Error(`Analysis Failed: ${error.message || "Edge Function Invocation Failed"}`);
         }

         // Error returned by the function itself (we return 200 with success: false)
         if (data && !data.success) {
             console.error("Analysis Failed (Function Error):", data.error);
             throw new Error(data.error || "Unknown error during analysis.");
         }

         console.log("Analysis Response:", data);
         return { text: data.profileText, json: data.profileJSON };
    },
    saveProfile: async (
        name: string,
        content: string,
        count: number,
        files: string[],
        structuredContent?: StructuredProfile,
        rawResumeText?: string
    ) => {
         const { data: { user } } = await supabase.auth.getUser();
         console.log('[saveProfile] User:', user?.id);
         console.log('[saveProfile] Data to insert:', {
             profile_name: name,
             content_length: content?.length,
             structured_content_keys: structuredContent ? Object.keys(structuredContent) : null,
             resume_count: count,
             source_files: files,
             raw_resume_text_length: rawResumeText?.length
         });

         // Deactivate all other profiles first
         const { error: deactivateError } = await supabase.from('cv_profiles').update({ is_active: false }).neq('id', '00000000-0000-0000-0000-000000000000');
         if (deactivateError) console.error('[saveProfile] Deactivate error:', deactivateError);

         // Insert new profile as active
         const { data, error } = await supabase.from('cv_profiles').insert({
             name: name,  // Required NOT NULL column
             profile_name: name,
             content: content,
             structured_content: structuredContent,
             resume_count: count,
             source_files: files,
             user_id: user?.id,
             source_type: 'generated',
             raw_resume_text: rawResumeText,
             is_active: true
         }).select().single();

         if (error) {
             console.error('[saveProfile] Insert error:', error);
             throw new Error(`Failed to save profile: ${error.message}`);
         }
         console.log('[saveProfile] Success:', data?.id);
         return data;
    },
    // Create new profile when editing (preserves original)
    saveEditedProfile: async (
        parentProfileId: string,
        content: string,
        structuredContent: StructuredProfile,
        makeActive: boolean = false
    ) => {
        const { data: { user } } = await supabase.auth.getUser();
        // Get parent profile info
        const { data: parent } = await supabase.from('cv_profiles')
            .select('profile_name, raw_resume_text')
            .eq('id', parentProfileId)
            .single();

        const newName = `${parent?.profile_name || 'Profile'} (Edited ${new Date().toLocaleDateString()})`;

        if (makeActive) {
            await supabase.from('cv_profiles').update({ is_active: false }).neq('id', '00000000-0000-0000-0000-000000000000');
        }

        const { data } = await supabase.from('cv_profiles').insert({
            name: newName,  // Required NOT NULL column
            profile_name: newName,
            content: content,
            structured_content: structuredContent,
            user_id: user?.id,
            source_type: 'edited',
            parent_profile_id: parentProfileId,
            raw_resume_text: parent?.raw_resume_text,
            is_active: makeActive
        }).select().single();
        return data;
    },
    updateProfileContent: async (id: string, content: string, structuredContent: StructuredProfile) => {
        await supabase.from('cv_profiles').update({
            content: content,
            structured_content: structuredContent
        }).eq('id', id);
    },
    setProfileActive: async (id: string) => {
        await supabase.from('cv_profiles').update({ is_active: false }).neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('cv_profiles').update({ is_active: true }).eq('id', id);
    },
    deleteProfile: async (id: string) => {
        await supabase.from('cv_profiles').delete().eq('id', id);
    }
  },

  settings: {
      getSettings: async (): Promise<UserSettings | null> => {
           const { data: { user } } = await supabase.auth.getUser();
           if (!user) return null;
           const { data } = await supabase.from('user_settings').select('*').eq('user_id', user.id).single();
           return data;
      },
      getSearchUrls: async (): Promise<string[]> => {
          const s = await api.settings.getSettings();
          return s?.finn_search_urls || [];
      },
      saveSearchUrls: async (urls: string[]) => {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) throw new Error("No user logged in");
          const { error } = await supabase.from('user_settings').upsert(
              { user_id: user.id, finn_search_urls: urls },
              { onConflict: 'user_id' }
          );
          if (error) throw error;
      },
      getLinkedInSettings: async () => {
          const s = await api.settings.getSettings();
          return {
              terms: s?.linkedin_search_terms || [],
              enabled: s?.linkedin_scan_enabled || false,
              location: s?.linkedin_location || 'Norway'
          };
      },
      saveLinkedInSettings: async (terms: string[], enabled: boolean, location: string) => {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) throw new Error("No user logged in");
          const { error } = await supabase.from('user_settings').upsert(
              { user_id: user.id, linkedin_search_terms: terms, linkedin_scan_enabled: enabled, linkedin_location: location },
              { onConflict: 'user_id' }
          );
          if (error) throw error;
      },
      getAllPrompts: async () => {
          const s = await api.settings.getSettings();
          return {
              app: s?.application_prompt,
              gen: s?.profile_gen_prompt,
              analyze: s?.job_analysis_prompt
          };
      },
      savePrompts: async (app?: string, gen?: string, analyze?: string) => {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return false;
          const update: any = { user_id: user.id };
          if (app !== undefined) update.application_prompt = app;
          if (gen !== undefined) update.profile_gen_prompt = gen;
          if (analyze !== undefined) update.job_analysis_prompt = analyze;
          const { error } = await supabase.from('user_settings').upsert(update, { onConflict: 'user_id' });
          return !error;
      },
      saveAnalysisLanguage: async (lang: Language) => {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) {
              console.warn('[saveAnalysisLanguage] No user logged in');
              return false;
          }
          console.log(`[saveAnalysisLanguage] Saving language: ${lang} for user: ${user.id}`);
          const { error } = await supabase.from('user_settings').upsert(
              { user_id: user.id, preferred_analysis_language: lang },
              { onConflict: 'user_id' }
          );
          if (error) {
              console.error('[saveAnalysisLanguage] Error:', error);
              return false;
          }
          console.log('[saveAnalysisLanguage] Success');
          return true;
      },
      saveLanguage: async (lang: Language) => {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return;
          await supabase.from('user_settings').upsert(
              { user_id: user.id, ui_language: lang },
              { onConflict: 'user_id' }
          );
      },
      saveAutomation: async (enabled: boolean, time: string) => {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return;
          await supabase.from('user_settings').upsert(
              { user_id: user.id, is_auto_scan_enabled: enabled, scan_time_utc: time },
              { onConflict: 'user_id' }
          );
      },
      saveAutoSoknad: async (enabled: boolean, minScore: number) => {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return;
          await supabase.from('user_settings').upsert(
              { user_id: user.id, auto_soknad_enabled: enabled, auto_soknad_min_score: minScore },
              { onConflict: 'user_id' }
          );
      },
      triggerManualScan: async () => {
          const { data: { user } } = await supabase.auth.getUser();
          const { data, error } = await supabase.functions.invoke('scheduled-scanner', {
              body: { forceRun: true, source: 'WEB_MANUAL' }
          });
          if (error) throw error;
          return data;
      },
      triggerUserScan: async () => {
          const { data: { user }, error: authError } = await supabase.auth.getUser();
          if (authError || !user) return { success: false, message: 'Not authenticated' };

          try {
              // Use direct fetch with longer timeout (5 min) for scan operation
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 min timeout

              const { data: { session } } = await supabase.auth.getSession();
              const response = await fetch('https://ptrmidlhfdbybxmyovtm.supabase.co/functions/v1/scheduled-scanner', {
                  method: 'POST',
                  headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${session?.access_token || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0cm1pZGxoZmRieWJ4bXlvdnRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI0MzQ3NDksImV4cCI6MjA3ODAxMDc0OX0.rdOIJ9iMnbz5uxmGrtxJxb0n1cwf6ee3ppz414IaDWM'}`
                  },
                  body: JSON.stringify({
                      forceRun: true,
                      source: 'WEB_DASHBOARD',
                      userId: user.id
                  }),
                  signal: controller.signal
              });

              clearTimeout(timeoutId);

              if (!response.ok) {
                  const errorText = await response.text();
                  console.error('[triggerUserScan] Response error:', response.status, errorText);
                  return { success: false, message: `Error ${response.status}: ${errorText.substring(0, 200)}` };
              }

              const data = await response.json();
              return { success: true, ...data };
          } catch (e: any) {
              console.error('[triggerUserScan] Fetch error:', e);
              if (e.name === 'AbortError') {
                  return { success: false, message: 'Scan timed out (5 min). Check Telegram for results.' };
              }
              return { success: false, message: e.message };
          }
      },
      getKnowledgeBase: async (): Promise<KnowledgeBaseItem[]> => {
          const { data } = await supabase.from('user_knowledge_base').select('*');
          return data || [];
      },
      addKnowledgeBaseItem: async (q: string, a: string, c: string) => {
           await supabase.from('user_knowledge_base').insert({ question: q, answer: a, category: c });
      },
      deleteKnowledgeBaseItem: async (id: string) => {
           await supabase.from('user_knowledge_base').delete().eq('id', id);
      },

      // --- Telegram Link Code Functions ---
      generateTelegramLinkCode: async (): Promise<string | null> => {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return null;

          // Generate 6-character alphanumeric code (uppercase)
          const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars (0, O, 1, I)
          let code = '';
          for (let i = 0; i < 6; i++) {
              code += chars.charAt(Math.floor(Math.random() * chars.length));
          }

          // Set expiration to 24 hours from now
          const expiresAt = new Date();
          expiresAt.setHours(expiresAt.getHours() + 24);

          const { error } = await supabase
              .from('user_settings')
              .upsert({
                  user_id: user.id,
                  telegram_link_code: code,
                  telegram_link_code_expires_at: expiresAt.toISOString()
              }, { onConflict: 'user_id' });

          if (error) {
              console.error('[generateTelegramLinkCode] Error:', error);
              return null;
          }

          return code;
      },

      getTelegramLinkCode: async (): Promise<{ code: string | null; expiresAt: string | null; isExpired: boolean }> => {
          const settings = await api.settings.getSettings();
          if (!settings || !settings.telegram_link_code) {
              return { code: null, expiresAt: null, isExpired: false };
          }

          const isExpired = settings.telegram_link_code_expires_at
              ? new Date(settings.telegram_link_code_expires_at) < new Date()
              : true;

          return {
              code: settings.telegram_link_code,
              expiresAt: settings.telegram_link_code_expires_at || null,
              isExpired
          };
      },

      disconnectTelegram: async (): Promise<boolean> => {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return false;

          const { error } = await supabase
              .from('user_settings')
              .update({
                  telegram_chat_id: null,
                  telegram_link_code: null,
                  telegram_link_code_expires_at: null
              })
              .eq('user_id', user.id);

          return !error;
      }
  },

  exports: {
      // Save export file to Supabase Storage and record in history
      saveExport: async (file: Blob, filename: string, format: 'xlsx' | 'pdf', jobsCount: number, filters?: Record<string, any>): Promise<{ success: boolean; data?: ExportHistory; error?: string }> => {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return { success: false, error: 'Not authenticated' };

          // Upload file to storage (path: user_id/filename)
          const filePath = `${user.id}/${filename}`;
          const { data: uploadData, error: uploadError } = await supabase.storage
              .from('exports')
              .upload(filePath, file, {
                  contentType: format === 'xlsx'
                      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                      : 'application/pdf',
                  upsert: true
              });

          if (uploadError) {
              console.error('[saveExport] Upload error:', uploadError);
              return { success: false, error: uploadError.message };
          }

          // Save record to exports_history table
          const { data: historyData, error: historyError } = await supabase
              .from('exports_history')
              .insert({
                  user_id: user.id,
                  filename,
                  format,
                  file_path: filePath,
                  file_size: file.size,
                  jobs_count: jobsCount,
                  filters_applied: filters || null
              })
              .select()
              .single();

          if (historyError) {
              console.error('[saveExport] History error:', historyError);
              return { success: false, error: historyError.message };
          }

          return { success: true, data: historyData };
      },

      // Get list of previous exports
      getExportHistory: async (): Promise<ExportHistory[]> => {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return [];

          const { data, error } = await supabase
              .from('exports_history')
              .select('*')
              .eq('user_id', user.id)
              .order('created_at', { ascending: false })
              .limit(20);

          if (error) {
              console.error('[getExportHistory] Error:', error);
              return [];
          }

          // Add download URLs
          const exportsWithUrls = await Promise.all((data || []).map(async (exp) => {
              const { data: urlData } = await supabase.storage
                  .from('exports')
                  .createSignedUrl(exp.file_path, 3600); // 1 hour expiry
              return { ...exp, download_url: urlData?.signedUrl || null };
          }));

          return exportsWithUrls;
      },

      // Delete an export
      deleteExport: async (id: string, filePath: string): Promise<boolean> => {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return false;

          // Delete from storage
          await supabase.storage.from('exports').remove([filePath]);

          // Delete from history
          const { error } = await supabase
              .from('exports_history')
              .delete()
              .eq('id', id)
              .eq('user_id', user.id);

          return !error;
      },

      // Get download URL for an export
      getDownloadUrl: async (filePath: string): Promise<string | null> => {
          const { data } = await supabase.storage
              .from('exports')
              .createSignedUrl(filePath, 3600);
          return data?.signedUrl || null;
      }
  },

  admin: {
      listUsers: async () => {
           const { data, error } = await supabase.functions.invoke('admin-actions', {
               body: { action: 'list_users' }
           });
           if (error) return { success: false, error: error.message };
           return data;
      },
      createUser: async (email: string, password: string, role: string) => {
           const { data, error } = await supabase.functions.invoke('admin-actions', {
               body: { action: 'create_user', email, password, role }
           });
           if (error) return { success: false, error: error.message };
           return data;
      },
      deleteUser: async (userId: string) => {
           const { data, error } = await supabase.functions.invoke('admin-actions', {
               body: { action: 'delete_user', userId }
           });
           if (error) return { success: false, error: error.message };
           return data;
      },
      getStats: async () => {
           const { data, error } = await supabase.functions.invoke('admin-actions', {
               body: { action: 'admin_stats' }
           });
           if (error) return { success: false, error: error.message };
           return data;
      }
  }
};

export const {
    getJobs, getTotalCost, getSystemLogs, extractJobText, analyzeJobs,
    getApplication, generateApplication, approveApplication, sendApplication, retrySend, fillFinnForm, cancelTask,
    settings, admin, cv, exports, subscribeToChanges
} = api;
