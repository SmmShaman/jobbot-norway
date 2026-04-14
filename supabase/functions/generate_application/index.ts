
const VERSION_STAMP = '2026-04-14-anthropic';
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// --- PRICING CONFIGURATION (Claude Sonnet 4.6, USD per 1M tokens) ---
const PRICE_PER_1M_INPUT = 3.00;
const PRICE_PER_1M_OUTPUT = 15.00;

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

serve(async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    let { job_id, user_id } = await req.json();

    if (!job_id) {
      throw new Error('Job ID is required');
    }

    // 1. Check Secrets FIRST
    const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY');

    if (!anthropicApiKey) {
      throw new Error("Missing ANTHROPIC_API_KEY secret.");
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, supabaseKey);

    // MULTI-USER: user_id is required
    if (!user_id) {
      console.log('[generate_application] No user_id provided');
      throw new Error("user_id is required for generating applications. Please log in first.");
    }
    console.log(`[generate_application] Processing for user: ${user_id}`);

    // 2. Check if Application already exists FOR THIS USER
    const { data: existingApp } = await supabase
      .from('applications')
      .select('*')
      .eq('job_id', job_id)
      .eq('user_id', user_id)
      .limit(1)
      .single();

    if (existingApp) {
      console.log(`[generate_application] Returning existing application ${existingApp.id} for user ${user_id}`);
      return new Response(JSON.stringify({ success: true, application: existingApp, message: "Returning existing application" }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 3. Fetch Job Description
    const { data: job } = await supabase.from('jobs').select('description, title, company').eq('id', job_id).single();
    if (!job || !job.description) {
      throw new Error("Job description missing. Please click 'Extract Details' first.");
    }

    // 4. Fetch Active Profile - MUST be filtered by user_id (no unsafe fallback!)
    const { data: profile, error: profileError } = await supabase
      .from('cv_profiles')
      .select('content')
      .eq('is_active', true)
      .eq('user_id', user_id)
      .single();

    if (profileError || !profile?.content) {
      console.log(`[generate_application] No profile for user_id=${user_id}:`, profileError?.message);
      throw new Error(`No active CV profile found for your account. Go to Settings → Resume and create/activate a profile.`);
    }
    console.log(`[generate_application] Using profile for user ${user_id} (${profile.content.length} chars)`);

    // 5. Fetch Application Prompt (User Settings) - filter by user_id (no unsafe fallback)
    let userPrompt = "Write a professional cover letter in Norwegian (Bokmål). Make it formal but personable.";

    const { data: settings } = await supabase
      .from('user_settings')
      .select('application_prompt')
      .eq('user_id', user_id)
      .single();

    if (settings?.application_prompt) {
      userPrompt = settings.application_prompt;
      console.log(`[generate_application] Using custom prompt for user ${user_id}`);
    } else {
      console.log(`[generate_application] Using default prompt for user ${user_id}`);
    }

    // 6. Call Anthropic Claude API
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

    console.log("Sending request to Anthropic API...");

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        temperature: 0.7,
        system: systemInstruction,
        messages: [
          { role: 'user', content: fullPrompt }
        ]
      })
    });

    if (!response.ok) {
       const txt = await response.text();
       console.error("Anthropic API Error:", txt);
       throw new Error(`Anthropic API returned error: ${response.status} - ${txt}`);
    }

    const json = await response.json();

    const textBlock = json.content?.find((b: any) => b.type === 'text');
    if (!textBlock?.text) {
      throw new Error("Invalid response from Anthropic API");
    }

    let contentObj;
    try {
      // Strip markdown fences if present
      let raw = textBlock.text.trim();
      if (raw.startsWith('```')) {
        raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      contentObj = JSON.parse(raw);
    } catch (e) {
      console.error("Failed to parse AI response as JSON:", textBlock.text);
      throw new Error("AI did not return valid JSON. Try again.");
    }

    // --- CALCULATE COST ---
    let cost = 0;
    let tokensIn = 0;
    let tokensOut = 0;

    const usage = json.usage;
    if (usage) {
        tokensIn = usage.input_tokens || 0;
        tokensOut = usage.output_tokens || 0;
        cost = (tokensIn / 1000000 * PRICE_PER_1M_INPUT) +
               (tokensOut / 1000000 * PRICE_PER_1M_OUTPUT);
    }

    // 7. Save to Database
    const { data: savedApp, error: saveError } = await supabase
      .from('applications')
      .insert([{
        job_id,
        user_id, 
        cover_letter_no: contentObj.soknad_no,
        cover_letter_uk: contentObj.translation_uk,
        status: 'draft',
        created_at: new Date().toISOString(),
        generated_prompt: fullPrompt,
        prompt_source: 'web-dashboard',
        // Cost Tracking
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

    // Log cost to system_logs for per-user cost tracking
    await supabase.from('system_logs').insert({
      user_id,
      event_type: 'APPLICATION_GEN',
      status: 'SUCCESS',
      message: `Cover letter: "${job.title}" at ${job.company}`,
      tokens_used: tokensIn + tokensOut,
      cost_usd: cost,
      source: 'WEB_DASHBOARD',
      details: { job_id, application_id: savedApp?.id, tokens_input: tokensIn, tokens_output: tokensOut }
    });

    return new Response(JSON.stringify({ success: true, application: savedApp }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error("Generate Application Error:", error);
    // Return 200 with success: false so the frontend can read the error message
    return new Response(JSON.stringify({ success: false, message: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, 
      status: 200 
    });
  }
});
