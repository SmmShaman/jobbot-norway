
const VERSION_STAMP = '2026-07-18-manual-agent-draft';
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// No LLM API calls here anymore. Cover letters are written manually by the Jobbot
// agent (no paid Claude/Gemini/Groq key involved) and picked up by a polling task
// that fills in cover_letter_no/cover_letter_uk on the 'pending_manual' row below.

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { job_id, user_id } = await req.json();

    if (!job_id) throw new Error('Job ID is required');

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, supabaseKey);

    if (!user_id) {
      throw new Error("user_id is required for generating applications. Please log in first.");
    }

    // Validate that the caller's JWT matches the requested user_id (prevent cross-user forgery).
    // Trusted backend callers (worker, GitHub Actions) authenticate with the service-role key
    // itself, which only our own infra holds — skip the per-user check for them.
    const authHeader = req.headers.get('authorization') ?? req.headers.get('apikey') ?? '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '');
      if (token !== supabaseKey) {
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
          throw new Error("Authentication required. Please log in.");
        }
        if (user.id !== user_id) {
          throw new Error("Unauthorized: user_id does not match authenticated user.");
        }
      }
    }

    console.log(`[generate_application ${VERSION_STAMP}] Processing for user: ${user_id}`);

    // Check existing application for this user — covers both finished drafts
    // and ones already queued for manual writing.
    const { data: existingApp } = await supabase
      .from('applications')
      .select('*')
      .eq('job_id', job_id)
      .eq('user_id', user_id)
      .limit(1)
      .single();

    if (existingApp) {
      return new Response(JSON.stringify({
        success: true,
        application: existingApp,
        pending: existingApp.status === 'pending_manual',
        message: existingApp.status === 'pending_manual' ? "Draft queued for manual writing" : "Returning existing application"
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { data: job } = await supabase.from('jobs').select('description, title, company').eq('id', job_id).single();
    if (!job || !job.description) {
      throw new Error("Job description missing. Please click 'Extract Details' first.");
    }

    // No LLM call — queue for manual writing by the Jobbot agent. A polling task
    // picks up 'pending_manual' rows, writes cover_letter_no/cover_letter_uk, and
    // flips status to 'draft'.
    const { data: pendingApp, error: saveError } = await supabase
      .from('applications')
      .insert([{
        job_id,
        user_id,
        status: 'pending_manual',
        created_at: new Date().toISOString(),
        prompt_source: 'pending:manual-agent',
        cost_usd: 0,
        tokens_input: 0,
        tokens_output: 0
      }])
      .select()
      .single();

    if (saveError) {
      console.error("Database Save Error:", saveError);
      throw new Error(`Database Save Error: ${saveError.message}`);
    }

    return new Response(JSON.stringify({ success: true, application: pendingApp, pending: true, message: "Queued for manual draft" }), {
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
