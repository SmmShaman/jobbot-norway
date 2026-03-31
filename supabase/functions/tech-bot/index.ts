import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
const VERSION_STAMP = '2026-03-29-force-redeploy';
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

console.log("🔧 [TechBot] v1.0 - @vitalljobtechbot system notifications");

const BOT_TOKEN = Deno.env.get('TELEGRAM_TECH_BOT_TOKEN');
console.log(`🔧 [TechBot] TOKEN exists: ${!!BOT_TOKEN}`);

// --- HELPERS ---

function formatAgo(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'щойно';
    if (mins < 60) return `${mins} хв тому`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} год тому`;
    const days = Math.floor(hours / 24);
    return `${days} дн тому`;
}

function formatUptime(startDate: Date): string {
    const diffMs = Date.now() - startDate.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${mins}хв`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) return remMins > 0 ? `${hours}г ${remMins}хв` : `${hours}г`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}д ${remHours}г` : `${days}д`;
}

async function getUserIdFromChat(supabase: any, chatId: number | string): Promise<string | null> {
    const { data } = await supabase
        .from('user_settings')
        .select('user_id')
        .eq('telegram_chat_id', chatId.toString())
        .single();
    return data?.user_id || null;
}

async function isAdmin(supabase: any, userId: string): Promise<boolean> {
    const { data } = await supabase
        .from('user_settings')
        .select('role')
        .eq('user_id', userId)
        .single();
    return data?.role === 'admin';
}

async function sendTelegram(chatId: string, text: string) {
    if (!BOT_TOKEN) {
        console.error("❌ [TechBot] TOKEN missing!");
        return;
    }
    try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        });
        if (!res.ok) {
            const err = await res.text();
            console.error(`❌ [TechBot] Send error (${res.status}):`, err);
        }
    } catch (e) {
        console.error("❌ [TechBot] Network error:", e);
    }
}

// --- MAIN HANDLER ---

async function handleUpdate(update: any) {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, supabaseKey);

    const message = update.message;
    if (!message?.text) return;

    const chatId = String(message.chat.id);
    const text = message.text.trim();

    // /start
    if (text === '/start') {
        await sendTelegram(chatId,
            `🔧 <b>JobBot Tech</b>\n\n` +
            `Сюди приходять технічні сповіщення:\n` +
            `• Прогрес сканування\n` +
            `• Статус worker/Skyvern\n` +
            `• Скріншоти та дашборди задач\n` +
            `• Підсумки аналізу\n\n` +
            `Команди:\n` +
            `/worker — статус системи`
        );
        return;
    }

    // /worker — system status (admin only)
    if (text === '/worker') {
        const userId = await getUserIdFromChat(supabase, chatId);
        if (!userId) {
            await sendTelegram(chatId, "⚠️ Telegram не прив'язаний до акаунту.");
            return;
        }

        if (!(await isAdmin(supabase, userId))) {
            await sendTelegram(chatId, "⛔ Тільки для адміністратора.");
            return;
        }

        // --- Worker + Skyvern Health (multi-worker support) ---
        const { data: heartbeats } = await supabase
            .from('worker_heartbeat')
            .select('*')
            .order('last_heartbeat', { ascending: false });

        let msg = `🔧 <b>Статус системи</b>\n\n`;

        let isAlive = false;
        if (heartbeats && heartbeats.length > 0) {
            for (const hb of heartbeats) {
                const lastBeat = new Date(hb.last_heartbeat);
                const staleMs = Date.now() - lastBeat.getTime();
                const alive = staleMs < 30000;
                const loc = hb.location || hb.id || '?';

                if (alive) {
                    isAlive = true;
                    const uptime = hb.started_at ? formatUptime(new Date(hb.started_at)) : '?';
                    msg += `🟢 <b>${loc}:</b> працює (${uptime})\n`;
                    msg += hb.skyvern_healthy
                        ? `   ✅ Skyvern доступний\n`
                        : `   ❌ Skyvern недоступний\n`;
                    msg += `   🔄 Цикл: #${hb.poll_cycle} | Оброблено: ${hb.applications_processed}\n`;
                } else {
                    msg += `🔴 <b>${loc}:</b> не працює\n`;
                    msg += `   Останній сигнал: ${formatAgo(lastBeat)}\n`;
                }
            }
        } else {
            msg += `🔴 <b>Worker:</b> не працює\n`;
            msg += `   Жодного сигналу\n`;
            msg += `❓ <b>Skyvern:</b> невідомо\n`;
        }

        // --- Queue ---
        const { count: sendingCount } = await supabase
            .from('applications')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'sending');

        const { count: approvedCount } = await supabase
            .from('applications')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'approved');

        const { data: lastSent } = await supabase
            .from('applications')
            .select('sent_at')
            .eq('status', 'sent')
            .order('sent_at', { ascending: false })
            .limit(1)
            .single();

        msg += `\n📊 <b>Черга</b>\n`;
        msg += `📨 Надсилаються: ${sendingCount || 0}\n`;
        msg += `✅ Готові: ${approvedCount || 0}\n`;
        if (lastSent?.sent_at) {
            msg += `🕐 Остання відправка: ${formatAgo(new Date(lastSent.sent_at))}\n`;
        }

        // --- Per-User Breakdown ---
        const { data: allUsers } = await supabase
            .from('user_settings')
            .select('user_id, is_auto_scan_enabled')
            .order('user_id');

        if (allUsers && allUsers.length > 0) {
            msg += `\n👥 <b>Користувачі</b>\n`;
            for (let i = 0; i < allUsers.length; i++) {
                const u = allUsers[i];
                const isLast = i === allUsers.length - 1;
                const prefix = isLast ? '└' : '├';

                const { data: authUser } = await supabase.rpc('get_user_email', { uid: u.user_id }).single();
                const email = authUser?.email || u.user_id.substring(0, 8);
                const username = email.includes('@') ? email.split('@')[0] : email;

                const { count: jobCount } = await supabase
                    .from('jobs')
                    .select('*', { count: 'exact', head: true })
                    .eq('user_id', u.user_id);

                const { count: appCount } = await supabase
                    .from('applications')
                    .select('*', { count: 'exact', head: true })
                    .eq('user_id', u.user_id)
                    .in('status', ['sent', 'approved', 'sending']);

                const scanIcon = u.is_auto_scan_enabled ? '✅' : '⏸';
                msg += `${prefix} ${username} — ${jobCount || 0} вакансій, ${appCount || 0} заявок ${scanIcon}\n`;
            }
        }

        // --- Last Activity ---
        const { data: lastScan } = await supabase
            .from('system_logs')
            .select('created_at, details')
            .eq('event_type', 'SCAN')
            .eq('status', 'SUCCESS')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        const { data: lastAnalysis } = await supabase
            .from('system_logs')
            .select('created_at, details')
            .eq('event_type', 'ANALYSIS')
            .eq('status', 'SUCCESS')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: costData } = await supabase
            .from('system_logs')
            .select('cost_usd')
            .gte('created_at', twentyFourHoursAgo);

        msg += `\n📋 <b>Активність</b>\n`;

        if (lastScan?.created_at) {
            const scanDetails = lastScan.details as any;
            const newJobs = scanDetails?.new_jobs || scanDetails?.newJobs || '?';
            msg += `🔍 Скан: ${formatAgo(new Date(lastScan.created_at))} (${newJobs} нових)\n`;
        } else {
            msg += `🔍 Скан: немає даних\n`;
        }

        if (lastAnalysis?.created_at) {
            const analysisDetails = lastAnalysis.details as any;
            const analyzed = analysisDetails?.jobs_analyzed || analysisDetails?.analyzed || '?';
            msg += `📊 Аналіз: ${formatAgo(new Date(lastAnalysis.created_at))} (${analyzed} оброблено)\n`;
        }

        const totalCost24h = costData?.reduce((sum: number, row: any) => sum + (row.cost_usd || 0), 0) || 0;
        msg += `💰 Витрати 24г: $${totalCost24h.toFixed(2)}\n`;

        // --- Startup instructions if worker is not running ---
        if (!isAlive) {
            msg += `\n⚙️ <b>Запуск</b>\n\n`;
            msg += `1. Відкрий Docker Desktop\n`;
            msg += `2. Термінал: <code>wsl</code>\n`;
            msg += `3. <code>cd ~/Jobbot-NO && ./worker/start.sh</code>\n\n`;
            msg += `<code>./worker/start.sh --status</code> — статус\n`;
            msg += `<code>./worker/start.sh --stop</code> — зупинити\n`;
            msg += `<code>Ctrl+C</code> — зупинити worker`;
        }

        await sendTelegram(chatId, msg);
        return;
    }
}

// --- SERVE ---

serve(async (req: Request) => {
    console.log(`📥 [TechBot] ${req.method} request`);

    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const update = await req.json();
        console.log(`📥 [TechBot] Update:`, JSON.stringify(update).substring(0, 200));

        // Skip old messages
        if (update.message?.date) {
            const msgAge = Math.floor(Date.now() / 1000) - update.message.date;
            if (msgAge > 120) {
                return new Response(JSON.stringify({ success: true, skipped: true }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }
        }

        handleUpdate(update).catch(e => console.error(`❌ [TechBot] Error:`, e));

        return new Response(JSON.stringify({ success: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    } catch (error: any) {
        console.error(`❌ [TechBot] Error:`, error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});

