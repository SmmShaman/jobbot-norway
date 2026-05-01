
const VERSION_STAMP = '2026-03-29-force-redeploy';
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PRICE_PER_1M_INPUT = 0.30;
const PRICE_PER_1M_OUTPUT = 2.50;

const GEMINI_MODEL = 'gemini-2.5-flash';

const DEFAULT_ANALYSIS_PROMPT = `
You are a Vibe & Fit Scanner for Recruitment.

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
❌ Мінуси:
- [specific con about candidate fit]
- [another con]

✅ Плюси:
- [specific pro about candidate fit]
- [another pro]

Write 2-5 bullet points for each section. Always include BOTH sections even if one side is weak.
When listing pros, explicitly reference the SPECIFIC role/period from the candidate's history that is relevant.
If the target language is Norwegian, use "❌ Ulemper:" and "✅ Fordeler:".
If the target language is English, use "❌ Cons:" and "✅ Pros:".

OUTPUT FORMAT (JSON ONLY):
{
  "score": number (0-100),
  "analysis": "string (structured cons/pros format as described above)",
  "tasks": "string (bullet point list of duties/responsibilities)",
  "requirements": "string (bullet point list of required qualifications)",
  "offers": "string (bullet point list of what the company offers)",
  "aura": {
      "status": "Toxic" | "Growth" | "Balanced" | "Chill" | "Grind" | "Neutral",
      "color": "#hex color code matching status (Toxic=#ef4444, Growth=#22c55e, Balanced=#3b82f6, Chill=#06b6d4, Grind=#a855f7, Neutral=#6b7280)",
      "tags": ["string", "string"] (e.g. "🚩 High Turnover", "🚀 Stock Options", "🛡️ Stable"),
      "explanation": "short reason for aura"
  },
  "radar": {
      "tech_stack": number (0-100 fit),
      "soft_skills": number (0-100 fit),
      "culture": number (0-100 match),
      "salary_potential": number (0-100 estimate based on market),
      "career_growth": number (0-100)
  }
}
`;

// Color mapping for aura status (fallback if AI doesn't provide color)
const AURA_COLORS: Record<string, string> = {
    'Toxic': '#ef4444',
    'Growth': '#22c55e',
    'Balanced': '#3b82f6',
    'Chill': '#06b6d4',
    'Grind': '#a855f7',
    'Neutral': '#6b7280'
};

const LANG_MAP: any = {
    'uk': 'Ukrainian',
    'no': 'Norwegian (Bokmål)',
    'en': 'English'
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { jobIds, userId } = await req.json();

    if (!jobIds || !Array.isArray(jobIds) || jobIds.length === 0) {
      throw new Error('No jobIds provided');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 1. Fetch Profile - MUST be filtered by user_id (no unsafe fallback!)
    if (!userId) {
      throw new Error("userId is required for job analysis. Each user must have their own profile.");
    }

    const { data: activeProfile, error: profileError } = await supabase
      .from('cv_profiles')
      .select('content')
      .eq('is_active', true)
      .eq('user_id', userId)
      .single();

    if (profileError || !activeProfile?.content) {
      console.log(`[job-analyzer] No profile found for user ${userId}:`, profileError?.message);
      throw new Error(`No active CV profile found for user ${userId}. Please create and activate a profile in Settings → Resume.`);
    }

    const profileContent = activeProfile.content;
    console.log(`[job-analyzer] Using profile for user ${userId} (${profileContent.length} chars)`);

    // 2. Fetch Settings (Prompt & Language) - filter by user_id!
    let analysisPrompt = DEFAULT_ANALYSIS_PROMPT;
    let targetLang = "Ukrainian"; // Default

    const { data: settings, error: settingsError } = await supabase.from('user_settings').select('job_analysis_prompt, preferred_analysis_language').eq('user_id', userId).single();

    console.log(`[job-analyzer] Settings fetch for user ${userId}:`, {
        hasSettings: !!settings,
        error: settingsError?.message,
        preferred_analysis_language: settings?.preferred_analysis_language,
        hasCustomPrompt: !!settings?.job_analysis_prompt
    });
    
    // If user has a custom prompt, append the required JSON schema
    // This ensures radar/aura data is always generated even with custom prompts
    const REQUIRED_JSON_SCHEMA = `

CRITICAL: Your response MUST be valid JSON with this EXACT structure:
{
  "score": <number 0-100>,
  "analysis": "<structured: ❌ Мінуси/Cons bullet points, then ✅ Плюси/Pros bullet points>",
  "tasks": "<bullet point list of duties>",
  "aura": {
      "status": "<one of: Toxic, Growth, Balanced, Chill, Grind, Neutral>",
      "color": "<hex color: Toxic=#ef4444, Growth=#22c55e, Balanced=#3b82f6, Chill=#06b6d4, Grind=#a855f7, Neutral=#6b7280>",
      "tags": ["<tag1>", "<tag2>"],
      "explanation": "<short reason>"
  },
  "radar": {
      "tech_stack": <number 0-100>,
      "soft_skills": <number 0-100>,
      "culture": <number 0-100>,
      "salary_potential": <number 0-100>,
      "career_growth": <number 0-100>
  }
}`;

    if (settings?.job_analysis_prompt && settings.job_analysis_prompt.length > 20) {
         analysisPrompt = settings.job_analysis_prompt + REQUIRED_JSON_SCHEMA;
    }
    
    if (settings?.preferred_analysis_language && LANG_MAP[settings.preferred_analysis_language]) {
        targetLang = LANG_MAP[settings.preferred_analysis_language];
    }

    // 3. Fetch Jobs
    const { data: jobs } = await supabase.from('jobs').select('id, title, company, description, location').in('id', jobIds);
    if (!jobs) throw new Error(`Error fetching jobs`);

    // 4. Gemini API
    const geminiApiKey = Deno.env.get('GEMINI_API_KEY');

    if (!geminiApiKey) throw new Error("GEMINI_API_KEY secret missing.");

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`;
    const results = [];

    for (const job of jobs) {
      if (!job.description || job.description.length < 50) continue;

      // Log actual language being used for debugging
      console.log(`[job-analyzer] Using language: ${targetLang} (from setting: ${settings?.preferred_analysis_language || 'not set'})`);

      const fullPrompt = `
        ${analysisPrompt}

        🌐 LANGUAGE REQUIREMENT (MANDATORY):
        You MUST write the following fields in ${targetLang}:
        - "analysis" field - write in ${targetLang}
        - "tasks" field - write in ${targetLang}
        - "aura.explanation" field - write in ${targetLang}

        DO NOT write these fields in English unless ${targetLang} IS English.

        --- CANDIDATE PROFILE ---
        ${profileContent}

        --- JOB DESCRIPTION ---
        Title: ${job.title}
        Company: ${job.company}
        Location: ${job.location}

        ${job.description}
      `;

      try {
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              { role: 'user', parts: [{ text: fullPrompt }] }
            ],
            systemInstruction: {
              parts: [{ text: `You are a helpful HR assistant that outputs strictly valid JSON. IMPORTANT: Write all text content (analysis, tasks, explanations) in ${targetLang} language.` }]
            },
            generationConfig: {
              temperature: 0.3,
              responseMimeType: 'application/json'
            }
          })
        });

        if (response.status === 429) {
          throw new Error('Gemini quota exceeded (429). Daily free-tier limit reached — try again in 24 hours or check billing at console.cloud.google.com.');
        }
        if (!response.ok) throw new Error(`Gemini API Error: ${response.status}`);
        const json = await response.json();

        const candidates = json.candidates || [];
        if (!candidates.length) throw new Error('No candidates in Gemini response');
        const textContent = candidates[0]?.content?.parts?.[0]?.text || '';
        const content = JSON.parse(textContent);

        let cost = 0;
        const usageMetadata = json.usageMetadata || {};
        let tokensIn = usageMetadata.promptTokenCount || 0;
        let tokensOut = usageMetadata.candidatesTokenCount || 0;
        cost = (tokensIn / 1000000 * PRICE_PER_1M_INPUT) + (tokensOut / 1000000 * PRICE_PER_1M_OUTPUT);

        // Validate and normalize Aura data
        let aura = content.aura;
        if (aura && aura.status) {
            // Ensure color is set (fallback to mapped color if AI didn't provide it)
            if (!aura.color || !aura.color.startsWith('#')) {
                aura.color = AURA_COLORS[aura.status] || AURA_COLORS['Neutral'];
            }
            // Ensure tags is an array
            if (!Array.isArray(aura.tags)) {
                aura.tags = [];
            }
        } else {
            // Create default aura if AI didn't return it
            aura = null;
        }

        // Validate Radar data
        let radar = content.radar;
        if (radar) {
            // Ensure all fields are numbers between 0-100
            const fields = ['tech_stack', 'soft_skills', 'culture', 'salary_potential', 'career_growth'];
            for (const field of fields) {
                if (typeof radar[field] !== 'number' || radar[field] < 0 || radar[field] > 100) {
                    radar[field] = 50; // Default to middle value
                }
            }
        } else {
            // AI didn't return radar data
            radar = null;
        }

        // Prepare Metadata (Aura + Radar)
        const metadata = {
            aura: aura,
            radar: radar
        };

        await supabase
          .from('jobs')
          .update({
            relevance_score: content.score,
            ai_recommendation: content.analysis,
            tasks_summary: content.tasks,
            analysis_metadata: metadata, // NEW COLUMN
            status: 'ANALYZED',
            analyzed_at: new Date().toISOString(),
            cost_usd: cost,
            tokens_input: tokensIn,
            tokens_output: tokensOut
          })
          .eq('id', job.id);

        results.push({ id: job.id, success: true, cost });
      } catch (err: any) {
        results.push({ id: job.id, success: false, error: err.message });
      }
    }

    return new Response(
      JSON.stringify({ success: true, processed: results.length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
