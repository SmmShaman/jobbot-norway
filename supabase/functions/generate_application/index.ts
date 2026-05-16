
const VERSION_STAMP = '2026-05-16-groq-fallback-authfix';
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Gemini model fallback chain — try most powerful first.
const GEMINI_MODELS: Array<{ name: string; priceIn: number; priceOut: number }> = [
  { name: 'gemini-2.5-pro',         priceIn: 1.25, priceOut: 10.00 },
  { name: 'gemini-2.5-flash',       priceIn: 0.30, priceOut: 2.50 },
  { name: 'gemini-2.5-flash-lite',  priceIn: 0.10, priceOut: 0.40 },
];

// Groq fallback models (OpenAI-compatible API)
const GROQ_MODELS: Array<{ name: string; priceIn: number; priceOut: number }> = [
  { name: 'llama-3.3-70b-versatile', priceIn: 0.59, priceOut: 0.79 },
  { name: 'llama-3.1-8b-instant',    priceIn: 0.05, priceOut: 0.08 },
];

interface LLMCallResult {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

async function callGeminiWithFallback(apiKey: string, prompt: string, systemInstruction: string): Promise<LLMCallResult> {
  const errors: string[] = [];

  for (const model of GEMINI_MODELS) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:generateContent?key=${apiKey}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: systemInstruction }] },
            generationConfig: {
              temperature: 0.7,
              responseMimeType: 'application/json',
              maxOutputTokens: 4096
            }
          })
        });

        if (response.status >= 500 || response.status === 429) {
          errors.push(`${model.name} ${response.status}`);
          if (attempt < 1) {
            await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
            continue;
          }
          break;
        }

        if (!response.ok) {
          const txt = await response.text();
          errors.push(`${model.name} ${response.status}: ${txt.slice(0, 200)}`);
          break;
        }

        const json = await response.json();
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (!text) { errors.push(`${model.name}: empty response`); break; }

        const usage = json.usageMetadata || {};
        const tokensIn = usage.promptTokenCount || 0;
        const tokensOut = usage.candidatesTokenCount || 0;
        const cost = (tokensIn / 1_000_000 * model.priceIn) + (tokensOut / 1_000_000 * model.priceOut);

        console.log(`[generate_application] Gemini: ${model.name}, tokens=${tokensIn}/${tokensOut}`);
        return { text, model: model.name, tokensIn, tokensOut, cost };
      } catch (e: any) {
        errors.push(`${model.name} threw: ${e.message}`);
        break;
      }
    }
  }

  throw new Error(`Gemini failed: ${errors.join(' | ')}`);
}

async function callGroqFallback(apiKey: string, prompt: string, systemInstruction: string): Promise<LLMCallResult> {
  const errors: string[] = [];

  for (const model of GROQ_MODELS) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model.name,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 4096,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        const txt = await response.text();
        errors.push(`groq/${model.name} ${response.status}: ${txt.slice(0, 200)}`);
        continue;
      }

      const json = await response.json();
      const text = json.choices?.[0]?.message?.content || '';
      if (!text) { errors.push(`groq/${model.name}: empty`); continue; }

      const usage = json.usage || {};
      const tokensIn = usage.prompt_tokens || 0;
      const tokensOut = usage.completion_tokens || 0;
      const cost = (tokensIn / 1_000_000 * model.priceIn) + (tokensOut / 1_000_000 * model.priceOut);

      console.log(`[generate_application] Groq: ${model.name}, tokens=${tokensIn}/${tokensOut}`);
      return { text, model: `groq/${model.name}`, tokensIn, tokensOut, cost };
    } catch (e: any) {
      errors.push(`groq/${model.name} threw: ${e.message}`);
    }
  }

  throw new Error(`Groq failed: ${errors.join(' | ')}`);
}

async function callLLM(geminiKey: string | null, groqKey: string | null, prompt: string, systemInstruction: string): Promise<LLMCallResult> {
  const geminiErrors: string[] = [];

  if (geminiKey) {
    try {
      return await callGeminiWithFallback(geminiKey, prompt, systemInstruction);
    } catch (e: any) {
      geminiErrors.push(e.message);
      console.log(`[generate_application] Gemini failed, trying Groq fallback: ${e.message}`);
    }
  }

  if (groqKey) {
    try {
      return await callGroqFallback(groqKey, prompt, systemInstruction);
    } catch (e: any) {
      throw new Error(`All LLMs failed. Gemini: ${geminiErrors.join('; ')} | Groq: ${e.message}`);
    }
  }

  throw new Error('No LLM API keys configured. Add GEMINI_API_KEY or GROQ_API_KEY to Supabase secrets.');
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { job_id, user_id } = await req.json();

    if (!job_id) throw new Error('Job ID is required');

    const geminiApiKey = Deno.env.get('GEMINI_API_KEY') || null;
    const groqApiKey = Deno.env.get('GROQ_API_KEY') || null;
    if (!geminiApiKey && !groqApiKey) throw new Error("No LLM key configured. Add GEMINI_API_KEY or GROQ_API_KEY to Supabase secrets.");

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, supabaseKey);

    if (!user_id) {
      throw new Error("user_id is required for generating applications. Please log in first.");
    }

    // Validate that the caller's JWT matches the requested user_id (prevent cross-user forgery)
    const authHeader = req.headers.get('authorization') ?? req.headers.get('apikey') ?? '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        throw new Error("Authentication required. Please log in.");
      }
      if (user.id !== user_id) {
        throw new Error("Unauthorized: user_id does not match authenticated user.");
      }
    }

    console.log(`[generate_application ${VERSION_STAMP}] Processing for user: ${user_id}`);

    // 2. Check existing application for this user
    const { data: existingApp } = await supabase
      .from('applications')
      .select('*')
      .eq('job_id', job_id)
      .eq('user_id', user_id)
      .limit(1)
      .single();

    if (existingApp) {
      return new Response(JSON.stringify({ success: true, application: existingApp, message: "Returning existing application" }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 3. Job description
    const { data: job } = await supabase.from('jobs').select('description, title, company').eq('id', job_id).single();
    if (!job || !job.description) {
      throw new Error("Job description missing. Please click 'Extract Details' first.");
    }

    // 4. Active profile (filtered by user)
    const { data: profile, error: profileError } = await supabase
      .from('cv_profiles')
      .select('content')
      .eq('is_active', true)
      .eq('user_id', user_id)
      .single();

    if (profileError || !profile?.content) {
      throw new Error(`No active CV profile found for your account. Go to Settings → Resume and create/activate a profile.`);
    }

    // 5. Custom prompt (per-user)
    let userPrompt = "Write a professional cover letter in Norwegian (Bokmål). Make it formal but personable.";
    const { data: settings } = await supabase
      .from('user_settings')
      .select('application_prompt')
      .eq('user_id', user_id)
      .single();
    if (settings?.application_prompt) userPrompt = settings.application_prompt;

    // 6. Build prompt + call Gemini with fallback
    const systemInstruction = `You are an expert career consultant for the Norwegian job market.
Your task is to write a "Soknad" (Cover Letter) based on the provided Job Description and Candidate Profile.

OUTPUT FORMAT:
You must output valid JSON only, with no markdown fences or extra text.
{
   "soknad_no": "The application text in Norwegian (Bokmal)",
   "translation_uk": "A translation in Ukrainian for the user"
}`;

    const fullPrompt = `
      ${userPrompt}

      --- JOB DESCRIPTION ---
      Title: ${job.title}
      Company: ${job.company}

      ${job.description}

      --- CANDIDATE PROFILE ---
      ${profile.content}
    `;

    const { text, model, tokensIn, tokensOut, cost } = await callLLM(geminiApiKey, groqApiKey, fullPrompt, systemInstruction);

    let contentObj;
    try {
      let raw = text.trim();
      if (raw.startsWith('```')) {
        raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      contentObj = JSON.parse(raw);
    } catch (e) {
      console.error("Failed to parse AI response as JSON:", text);
      throw new Error("AI did not return valid JSON. Try again.");
    }

    if (!contentObj.soknad_no) {
      throw new Error("AI response missing 'soknad_no' field.");
    }

    // 7. Save
    const { data: savedApp, error: saveError } = await supabase
      .from('applications')
      .insert([{
        job_id,
        user_id,
        cover_letter_no: contentObj.soknad_no,
        cover_letter_uk: contentObj.translation_uk || null,
        status: 'draft',
        created_at: new Date().toISOString(),
        generated_prompt: fullPrompt,
        prompt_source: `web-dashboard:${model}`,
        cost_usd: cost,
        tokens_input: tokensIn,
        tokens_output: tokensOut
      }])
      .select()
      .single();

    if (saveError) {
      console.error("Database Save Error:", saveError);
      throw new Error(`Database Save Error: ${saveError.message}`);
    }

    await supabase.from('system_logs').insert({
      user_id,
      event_type: 'APPLICATION_GEN',
      status: 'SUCCESS',
      message: `Cover letter: "${job.title}" at ${job.company} [${model}]`,
      tokens_used: tokensIn + tokensOut,
      cost_usd: cost,
      source: 'WEB_DASHBOARD',
      details: { job_id, application_id: savedApp?.id, model, tokens_input: tokensIn, tokens_output: tokensOut }
    });

    return new Response(JSON.stringify({ success: true, application: savedApp }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error("Generate Application Error:", error);
    return new Response(JSON.stringify({ success: false, message: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200
    });
  }
});
