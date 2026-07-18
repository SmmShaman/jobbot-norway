
const VERSION_STAMP = '2026-06-19-llama4-primary';
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Groq Llama 4 — primary for job analysis (fast, cheap, great reasoning)
const GROQ_MODEL_PRIMARY  = 'meta-llama/llama-4-maverick-17b-128e-instruct';
const GROQ_MODEL_FALLBACK = 'meta-llama/llama-4-scout-17b-16e-instruct';
const PRICE_PER_1M_INPUT  = 0.50;  // Llama 4 Maverick via Groq
const PRICE_PER_1M_OUTPUT = 0.77;

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

HARD REQUIREMENT GATE (CRITICAL — check this FIRST, before scoring):
- Determine if the job requires a specific licensed/vocational/formal qualification
  (e.g. culinary chef training, licensed mechanic/electrician/welder, professional
  engineering degree, healthcare license, specific certified trade).
- If such a requirement exists AND the candidate's profile shows NO matching education,
  license, or hands-on trade experience — this is a HARD BLOCKER:
  - Score MUST NOT exceed 35, regardless of leadership/soft-skill/business experience.
  - Prefix the cons section with "🚫 Блокуюча вимога: [конкретна вимога]" (or the
    equivalent in the target language).
- Distinguish this from ordinary industry-adjacent gaps (e.g. general retail experience
  vs. this specific chain), which should score normally based on transferable overlap —
  the gate is ONLY for genuine licensed/vocational trade mismatches.
- Do NOT invent generic filler pros (e.g. "experience with various clients/technologies/
  products") to fill the pros section when genuine overlap is weak or absent. Writing
  0-1 pro bullets, or a single line like "Немає прямого релевантного досвіду, окрім
  загальних управлінських навичок", is CORRECT and preferred over padding with
  unrelated buzzwords pulled from the candidate's general summary.

SCORING GUIDELINES:
- Apply the HARD REQUIREMENT GATE above first. If it triggers, cap the score at 35 max.
- 70-100: Strong match — candidate has direct experience or education in this field, and no gate triggered
- 50-69: Moderate match — candidate has transferable skills or partial experience, no hard blocker
- 30-49: Weak match — some overlap but significant gaps, OR a gated job where candidate has adjacent (not exact) experience
- 0-29: Poor match — very little relevant experience, or gate triggered with zero adjacency

ANALYSIS FORMAT (CRITICAL):
The "analysis" field MUST use this EXACT structure — cons FIRST, then pros:
❌ Мінуси:
- [specific con about candidate fit]
- [another con]

✅ Плюси:
- [specific pro about candidate fit]
- [another pro]

Write 2-5 bullet points for the cons section. For pros, write ONLY as many bullets as are
genuinely justified by real profile overlap (0-5) — never pad with generic filler just to
fill space.
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

// Deterministic safety net: the LLM sometimes ignores the HARD REQUIREMENT GATE prompt
// instruction (temperature=0.3, no cross-field consistency guarantee between "score" and
// "requirements"). Keyword-match on title + the ❌ (unmet) requirements text and force-cap
// the score, independent of what the model decided.
const VOCATIONAL_GATE_KEYWORDS = [
  'kokk', 'kjøkkensjef', 'kokkefaget',
  'mekaniker', 'bilmekaniker',
  'elektriker', 'elektrofag',
  'snekker', 'tømrer', 'rørlegger', 'sveiser',
  'sivilingeniør', 'ingeniør', 'ingeniørfag',
  'frisør', 'tannlege', 'sykepleier', 'jordmor',
  'advokat', 'revisor', 'lege',
];

function applyHardRequirementGate(score: number, title: string, requirementsText: string): number {
  if (!requirementsText) return score;
  const haystack = `${title} ${requirementsText}`.toLowerCase();
  const hasVocationalKeyword = VOCATIONAL_GATE_KEYWORDS.some((kw) => haystack.includes(kw));
  const hasUnmetMarker = requirementsText.includes('❌');
  if (hasVocationalKeyword && hasUnmetMarker) {
    return Math.min(score, 35);
  }
  return score;
}

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

    // 4. Groq Llama 4 API
    const groqApiKey = Deno.env.get('GROQ_API_KEY');

    if (!groqApiKey) throw new Error("GROQ_API_KEY secret missing.");

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

      const systemText = `You are a helpful HR assistant that outputs strictly valid JSON only (no markdown, no extra text). IMPORTANT: Write all text content (analysis, tasks, explanations) in ${targetLang} language.`;

      async function callGroqModel(model: string): Promise<Response> {
        const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${groqApiKey}`
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemText },
              { role: 'user', content: fullPrompt }
            ],
            temperature: 0.3,
            max_tokens: 4096,
            response_format: { type: 'json_object' }
          })
        });
        if (resp.status === 429) throw new Error(`Groq quota exceeded (429) on ${model}`);
        if (!resp.ok) throw new Error(`Groq API Error ${resp.status} on ${model}`);
        return resp;
      }

      try {
        let groqResponse: Response;
        let modelUsed = GROQ_MODEL_PRIMARY;
        try {
          groqResponse = await callGroqModel(GROQ_MODEL_PRIMARY);
        } catch (e: any) {
          console.warn(`[job-analyzer] Primary model failed (${e.message}), trying fallback`);
          modelUsed = GROQ_MODEL_FALLBACK;
          groqResponse = await callGroqModel(GROQ_MODEL_FALLBACK);
        }

        const json = await groqResponse.json();
        const textContent = json.choices?.[0]?.message?.content || '';
        if (!textContent) throw new Error('Empty response from Groq');
        const content = JSON.parse(textContent);

        console.log(`[job-analyzer] Groq model used: ${modelUsed}`);
        let cost = 0;
        const usage = json.usage || {};
        let tokensIn = usage.prompt_tokens || 0;
        let tokensOut = usage.completion_tokens || 0;
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

        const gatedScore = applyHardRequirementGate(content.score, job.title, content.requirements || '');

        await supabase
          .from('jobs')
          .update({
            relevance_score: gatedScore,
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
