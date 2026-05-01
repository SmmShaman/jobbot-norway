import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
const VERSION_STAMP = '2026-03-29-force-redeploy';
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-skyvern-signature',
};

console.log("🔐 [FINN-2FA] v3.0 - No internal polling (Skyvern polls every 10s for 15min)");

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');

// Send Telegram message
async function sendTelegram(chatId: string, text: string) {
  if (!BOT_TOKEN) {
    console.error("❌ BOT_TOKEN missing");
    return;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {
    console.error("❌ Telegram send error:", e);
  }
}

serve(async (req: Request) => {
  console.log(`📥 [FINN-2FA] ${req.method} request received at ${new Date().toISOString()}`);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const body = await req.json();
    const taskId = body.task_id;
    let totpIdentifier = body.totp_identifier || body.identifier || body.email;
    let resolvedUserId: string | null = null; // Track user_id for query scoping

    console.log(`📦 [FINN-2FA] Received: task_id=${taskId}, totp_identifier=${totpIdentifier || 'undefined'}`);

    // STEP 1: Find totp_identifier if not provided
    if (!totpIdentifier) {
      console.log(`🔍 [FINN-2FA] No totp_identifier, searching for recent auth requests...`);

      const { data: recentRequests } = await supabase
        .from('finn_auth_requests')
        .select('id, totp_identifier, user_id, status, verification_code, expires_at')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(5);

      console.log(`📊 [FINN-2FA] Found ${recentRequests?.length || 0} recent requests`);

      // Priority: code_received > pending > code_requested > completed (with code)
      const priorityOrder = ['code_received', 'pending', 'code_requested', 'completed'];
      let bestRequest = null;

      for (const status of priorityOrder) {
        const found = recentRequests?.find(r => r.status === status);
        if (found) {
          if (status === 'completed' && !found.verification_code) continue;
          bestRequest = found;
          break;
        }
      }

      if (bestRequest) {
        totpIdentifier = bestRequest.totp_identifier;
        resolvedUserId = bestRequest.user_id; // Scope all subsequent queries to this user
        console.log(`✅ [FINN-2FA] Selected request: ${bestRequest.id} (status=${bestRequest.status}, user=${resolvedUserId})`);

        // If it's code_received or completed with code - return it immediately
        if (bestRequest.verification_code &&
            (bestRequest.status === 'code_received' || bestRequest.status === 'completed')) {
          console.log(`🔄 [FINN-2FA] Returning existing code: ${bestRequest.verification_code}`);

          // Mark as completed if it was code_received
          if (bestRequest.status === 'code_received') {
            await supabase
              .from('finn_auth_requests')
              .update({ status: 'completed', success: true })
              .eq('id', bestRequest.id);
          }

          return new Response(
            JSON.stringify({
              task_id: taskId,
              totp: bestRequest.verification_code,
              totp_code: bestRequest.verification_code,
              verification_code: bestRequest.verification_code,
              code: bestRequest.verification_code
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      } else {
        console.log("⚠️ [FINN-2FA] No suitable auth requests found - returning empty (Skyvern will retry)");
        // Return empty response - Skyvern will poll again
        return new Response(
          JSON.stringify({}),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    console.log(`🔍 [FINN-2FA] Processing for: ${totpIdentifier}`);

    // STEP 2: Check for code_received (user already entered code)
    let step2Query = supabase
      .from('finn_auth_requests')
      .select('*')
      .eq('totp_identifier', totpIdentifier)
      .eq('status', 'code_received')
      .gt('expires_at', new Date().toISOString())
      .order('code_received_at', { ascending: false })
      .limit(1);
    if (resolvedUserId) step2Query = step2Query.eq('user_id', resolvedUserId);
    const { data: withCode } = await step2Query.single();

    if (withCode?.verification_code) {
      console.log(`✅ [FINN-2FA] Code already received: ${withCode.verification_code}`);

      await supabase
        .from('finn_auth_requests')
        .update({ status: 'completed', success: true })
        .eq('id', withCode.id);

      return new Response(
        JSON.stringify({
          task_id: taskId,
          totp: withCode.verification_code,
          totp_code: withCode.verification_code,
          verification_code: withCode.verification_code,
          code: withCode.verification_code
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // STEP 3: Check for completed with code (Skyvern retry)
    let step3Query = supabase
      .from('finn_auth_requests')
      .select('*')
      .eq('totp_identifier', totpIdentifier)
      .eq('status', 'completed')
      .not('verification_code', 'is', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1);
    if (resolvedUserId) step3Query = step3Query.eq('user_id', resolvedUserId);
    const { data: completedWithCode } = await step3Query.single();

    if (completedWithCode?.verification_code) {
      console.log(`🔄 [FINN-2FA] RETRY: Returning code from completed request: ${completedWithCode.verification_code}`);
      return new Response(
        JSON.stringify({
          task_id: taskId,
          totp: completedWithCode.verification_code,
          totp_code: completedWithCode.verification_code,
          verification_code: completedWithCode.verification_code,
          code: completedWithCode.verification_code
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // STEP 4: Find or create code_requested record
    let step4Query = supabase
      .from('finn_auth_requests')
      .select('*')
      .eq('totp_identifier', totpIdentifier)
      .in('status', ['pending', 'code_requested'])
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1);
    if (resolvedUserId) step4Query = step4Query.eq('user_id', resolvedUserId);
    const { data: pendingRequest } = await step4Query.single();

    let authRequest: any;
    let chatId: string | null = null;
    let shouldSendTelegram = false;

    if (pendingRequest) {
      console.log(`✅ [FINN-2FA] Found request: ${pendingRequest.id} (status=${pendingRequest.status})`);
      chatId = pendingRequest.telegram_chat_id;
      if (!resolvedUserId) resolvedUserId = pendingRequest.user_id;

      if (pendingRequest.status === 'pending') {
        // First call from Skyvern - update to code_requested and send Telegram
        const { data: updated, error } = await supabase
          .from('finn_auth_requests')
          .update({
            status: 'code_requested',
            code_requested_at: new Date().toISOString()
          })
          .eq('id', pendingRequest.id)
          .select()
          .single();

        if (error) {
          console.error("❌ Update error:", error);
          throw error;
        }
        authRequest = updated;
        shouldSendTelegram = true;
        console.log(`📝 [FINN-2FA] Updated status to code_requested`);
      } else {
        // Already code_requested - Skyvern is polling, don't send Telegram again
        authRequest = pendingRequest;
        console.log(`📝 [FINN-2FA] Using existing code_requested record (poll #N)`);
      }
    } else {
      // No pending request - try to find user from previous requests
      console.log(`⚠️ [FINN-2FA] No pending/code_requested found, looking for user info...`);

      let anyQuery = supabase
        .from('finn_auth_requests')
        .select('telegram_chat_id, user_id')
        .eq('totp_identifier', totpIdentifier)
        .order('created_at', { ascending: false })
        .limit(1);
      if (resolvedUserId) anyQuery = anyQuery.eq('user_id', resolvedUserId);
      const { data: anyRequest } = await anyQuery.single();

      if (!anyRequest?.telegram_chat_id) {
        console.log(`⚠️ [FINN-2FA] No user found for: ${totpIdentifier} - returning empty`);
        // Return empty response - Skyvern will poll again
        return new Response(
          JSON.stringify({}),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      chatId = anyRequest.telegram_chat_id;

      // Create new request
      const { data: newRequest, error } = await supabase
        .from('finn_auth_requests')
        .insert({
          telegram_chat_id: chatId,
          user_id: anyRequest.user_id,
          totp_identifier: totpIdentifier,
          status: 'code_requested',
          code_requested_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() // 15 min to match Skyvern timeout
        })
        .select()
        .single();

      if (error) {
        console.error("❌ Insert error:", error);
        throw error;
      }

      authRequest = newRequest;
      shouldSendTelegram = true;
      console.log(`📝 [FINN-2FA] Created new code_requested record: ${newRequest.id}`);
    }

    // STEP 5: Send Telegram notification ONLY on first call
    if (shouldSendTelegram && chatId) {
      const message = `🔐 <b>FINN потребує код верифікації!</b>\n\n` +
        `📧 Код надіслано на: <code>${totpIdentifier}</code>\n\n` +
        `Введіть код:\n<code>123456</code> (просто цифри)\n\n` +
        `⏱ Маєте 15 хвилин!`;

      await sendTelegram(chatId, message);
      console.log(`📤 [FINN-2FA] Telegram notification sent to ${chatId}`);
    }

    // STEP 6: Return IMMEDIATELY with empty response
    // Skyvern will poll again in 10 seconds (polls for 15 minutes total)
    console.log(`⏳ [FINN-2FA] No code yet - returning empty (Skyvern will poll again in 10s)`);

    return new Response(
      JSON.stringify({}),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error("❌ [FINN-2FA] Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
