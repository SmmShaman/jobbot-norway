// finn-apply/index.ts
const VERSION_STAMP = '2026-03-29-force-redeploy';
// Edge Function to mark application for FINN submission
// The actual form fill is done by the agent-driven Playwright pipeline
// (submission_method='agent') -- Skyvern decommissioned 2026-07-20.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Environment
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

interface RequestBody {
    jobId: string;
    applicationId: string;
}

serve(async (req: Request) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
        const { jobId, applicationId }: RequestBody = await req.json();

        console.log(`[finn-apply] Marking for submission: job=${jobId}, app=${applicationId}`);

        // 1. Get job data
        const { data: job, error: jobError } = await supabase
            .from("jobs")
            .select("*")
            .eq("id", jobId)
            .single();

        if (jobError || !job) {
            return new Response(
                JSON.stringify({ success: false, error: "Job not found" }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 }
            );
        }

        // Verify this is a FINN Easy Apply job
        // CRITICAL: Only allow if explicitly marked as Enkel søknad!
        // Priority 1: Check has_enkel_soknad flag (most reliable)
        // Priority 2: Check application_form_type (second most reliable)
        // Priority 3: Check external_apply_url ONLY if one of the above is true
        // This prevents false positives from incorrectly detected external forms
        const isFinnEasy = job.has_enkel_soknad === true ||
                          job.application_form_type === 'finn_easy' ||
                          (job.has_enkel_soknad === true || job.application_form_type === 'finn_easy') && 
                          job.external_apply_url?.includes("finn.no/job/apply");

        if (!isFinnEasy) {
            return new Response(
                JSON.stringify({ 
                    success: false, 
                    error: "This is not a FINN Enkel Søknad job. Only jobs with 'Enkel søknad' button can be submitted via FINN login.",
                    has_enkel_soknad: job.has_enkel_soknad,
                    application_form_type: job.application_form_type,
                    external_apply_url: job.external_apply_url
                }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
            );
        }

        // Helper function to extract finnkode
        const extractFinnkode = (url: string | null): string | null => {
            if (!url || !url.includes('finn.no')) {
                return null;
            }

            // Pattern 1: Query parameter format - ?finnkode=123456789 or &finnkode=123456789
            const queryMatch = url.match(/[?&]finnkode=(\d+)/);
            if (queryMatch) {
                return queryMatch[1];
            }

            // Pattern 2: Path-based format - /job/123456789 or /job/123456789.html
            const jobPathMatch = url.match(/\/job\/(\d{8,})(?:\.html|\?|$)/);
            if (jobPathMatch) {
                return jobPathMatch[1];
            }

            // Pattern 3: Old format - /ad/123456789 or /ad.html?finnkode=...
            const adPathMatch = url.match(/\/ad[\/.](\d{8,})(?:\?|$)/);
            if (adPathMatch) {
                return adPathMatch[1];
            }

            // Pattern 4: Just a number at the end of URL path (8+ digits)
            const endMatch = url.match(/\/(\d{8,})(?:\?|$)/);
            if (endMatch) {
                return endMatch[1];
            }

            // Pattern 5: In path like /job/fulltime/123456789
            const fulltimeMatch = url.match(/\/job\/[^\/]+\/(\d{8,})(?:\?|$)/);
            if (fulltimeMatch) {
                return fulltimeMatch[1];
            }

            return null;
        };

        // Construct FINN apply URL from finnkode if not already set
        let finnApplyUrl = job.external_apply_url;
        if (!finnApplyUrl || !finnApplyUrl.includes("finn.no/job/apply")) {
            const finnkode = extractFinnkode(job.job_url);

            if (finnkode) {
                finnApplyUrl = `https://www.finn.no/job/apply/${finnkode}`;
                console.log(`[finn-apply] Constructed URL: ${finnApplyUrl}`);
                
                // Update job with the constructed URL for future use
                await supabase
                    .from("jobs")
                    .update({ external_apply_url: finnApplyUrl })
                    .eq("id", jobId);
            } else {
                console.error(`[finn-apply] Could not extract finnkode from job_url: ${job.job_url}`);
                return new Response(
                    JSON.stringify({
                        success: false,
                        error: "Cannot construct FINN apply URL - no finnkode found in job_url",
                        job_url: job.job_url
                    }),
                    { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
                );
            }
        }

        // 2. Get application data
        const { data: application, error: appError } = await supabase
            .from("applications")
            .select("*")
            .eq("id", applicationId)
            .single();

        if (appError || !application) {
            return new Response(
                JSON.stringify({ success: false, error: "Application not found" }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 }
            );
        }

        // 3. Get user settings (for telegram notifications)
        const { data: settings } = await supabase
            .from("user_settings")
            .select("telegram_chat_id")
            .eq("user_id", job.user_id)
            .single();

        const telegramChatId = settings?.telegram_chat_id;

        // 4. Update application status to 'sending', routed to the agent pipeline
        await supabase
            .from("applications")
            .update({
                status: "sending",
                submission_method: "agent",
                skyvern_metadata: {
                    source: "dashboard",
                    finn_apply: true,
                    queued_at: new Date().toISOString()
                }
            })
            .eq("id", applicationId);

        // 5. Update job status
        await supabase
            .from("jobs")
            .update({ status: "APPLIED" })
            .eq("id", jobId);

        // 6. Send Telegram notification
        if (telegramChatId && TELEGRAM_BOT_TOKEN) {
            const message = `🚀 *Заявка в черзі на FINN*

📋 *${job.title}*
🏢 ${job.company || "Unknown"}

⏳ Агент зараз обробить заявку.
🔐 Очікуйте запит на 2FA код!

Коли отримаєте код на пошту, надішліть:
\`/code XXXXXX\``;

            await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: telegramChatId,
                    text: message,
                    parse_mode: "Markdown"
                })
            });
        }

        // 8. Log to system_logs
        await supabase.from("system_logs").insert({
            event_type: "FINN_APPLY",
            status: "queued",
            message: `Queued FINN application for job: ${job.title}`,
            metadata: {
                job_id: jobId,
                application_id: applicationId,
                finn_url: finnApplyUrl,
                has_enkel_soknad: job.has_enkel_soknad,
                application_form_type: job.application_form_type
            }
        });

        return new Response(
            JSON.stringify({
                success: true,
                message: "Application queued for FINN submission via the agent pipeline.",
                queued: true
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

    } catch (error) {
        console.error("[finn-apply] Error:", error);
        return new Response(
            JSON.stringify({ success: false, error: error.message }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
        );
    }
});
