
const VERSION_STAMP = '2026-03-29-force-redeploy';
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import * as cheerio from "https://esm.sh/cheerio@1.0.0-rc.12";

declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const logs: string[] = [];
function log(msg: string) {
    console.log(msg);
    logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function sendTelegramMessage(token: string, chatId: string, text: string, keyboard?: any) {
  try {
    const body: any = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (keyboard) body.reply_markup = keyboard;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
  } catch (e: any) {
    console.log(`⚠️ TG send failed (chat=${chatId}): ${e.message}`);
  }
}

// Note: Job analysis moved to worker/analyze_worker.py for no timeout limits
// This Edge Function only handles scraping, insertion, extraction, and triggering the worker

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  logs.length = 0;
  log(`🔔 [Orchestrator] Request received.`);

  let totalFound = 0, totalInserted = 0;
  const allScannedJobIds: string[] = []; // Track all jobs from this scan
  const processedUserIds: string[] = []; // Track which users were actually scanned
  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  const tgToken = Deno.env.get('TELEGRAM_TECH_BOT_TOKEN') || Deno.env.get('TELEGRAM_BOT_TOKEN');

  try {
    const { forceRun, source, userId: requestUserId } = await req.json().catch(() => ({}));

    // MULTI-USER SUPPORT: Fetch all users with auto-scan enabled (or specific user if forceRun)
    let usersQuery = supabase.from('user_settings')
        .select('user_id, finn_search_urls, telegram_chat_id, preferred_analysis_language, is_auto_scan_enabled, scan_time_utc, linkedin_search_terms, linkedin_scan_enabled, linkedin_location');

    if (requestUserId) {
        // If specific user requested (e.g., from Telegram /scan), only process that user
        usersQuery = usersQuery.eq('user_id', requestUserId);
    } else if (!forceRun) {
        // For scheduled cron, only process users with auto-scan enabled
        usersQuery = usersQuery.eq('is_auto_scan_enabled', true);
    }

    const { data: allUsers, error: usersError } = await usersQuery;

    if (usersError) throw new Error(`Failed to fetch users: ${usersError.message}`);
    if (!allUsers || allUsers.length === 0) {
        log(`⏭️ No users with auto-scan enabled found.`);
        return new Response(JSON.stringify({ success: true, message: "No users with auto-scan enabled", logs }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    log(`👥 Found ${allUsers.length} user(s) to process`);

    // Process each user separately
    for (const settings of allUsers) {
        const userId = settings.user_id;
        log(`\n👤 Processing user: ${userId}`);

        // Skip if auto-scan disabled (unless forceRun)
        if (!forceRun && !settings.is_auto_scan_enabled) {
            log(`⏭️ Auto-scan disabled for user ${userId}`);
            continue;
        }

        // Check if current hour matches scheduled time (unless forceRun)
        if (!forceRun && settings.scan_time_utc) {
            const [scheduledHour] = settings.scan_time_utc.split(':').map(Number);
            const now = new Date();
            const currentUtcHour = now.getUTCHours();
            const currentUtcMinutes = now.getUTCMinutes();

            // GitHub Actions cron is unreliable — can run 0-60 min late or slightly early.
            // Accept: exact hour match, previous hour (late run), or near-boundary (early run).
            const prevHour = (currentUtcHour - 1 + 24) % 24;
            const nextHour = (currentUtcHour + 1) % 24;
            const isNearHourBoundary = currentUtcMinutes >= 55;
            const hourMatches = currentUtcHour === scheduledHour ||
                               prevHour === scheduledHour ||
                               (isNearHourBoundary && nextHour === scheduledHour);

            if (!hourMatches) {
                log(`⏰ Skipping user ${userId}: Current time (${currentUtcHour}:${currentUtcMinutes.toString().padStart(2, '0')} UTC) doesn't match scheduled hour (${scheduledHour} UTC, ±1h tolerance)`);
                continue;
            }
            log(`✅ Time match for user ${userId}! Running scheduled scan (current: ${currentUtcHour}:${currentUtcMinutes.toString().padStart(2, '0')} UTC, scheduled: ${scheduledHour}:00 UTC)`);
        }

        // Get THIS USER's active profile
        const { data: activeProfile } = await supabase.from('cv_profiles')
            .select('content')
            .eq('is_active', true)
            .eq('user_id', userId)
            .single();

        if (!activeProfile?.content) {
            log(`⚠️ No active profile or empty content for user ${userId}, skipping...`);
            if (settings.telegram_chat_id) {
                const msg = !activeProfile
                    ? `⚠️ <b>Сканування пропущено</b>\n\nНемає активного профілю. Перейдіть в Settings → Resume і встановіть профіль як активний.`
                    : `⚠️ <b>Аналіз пропущено</b>\n\nПрофіль не має тексту CV. Перейдіть в Settings → Resume і перегенеруйте або відредагуйте профіль.`;
                await sendTelegramMessage(tgToken, settings.telegram_chat_id, msg);
            }
            continue;
        }

        const urls = settings.finn_search_urls || [];
        const userScannedJobIds: string[] = []; // Track jobs for this user
        let userFound = 0, userInserted = 0;

        if (urls.length === 0) {
            log(`⚠️ No search URLs configured for user ${userId}`);
            continue;
        }

        // Start scanning message for this user
        if (settings.telegram_chat_id) {
            await sendTelegramMessage(tgToken, settings.telegram_chat_id, `🔎 <b>Починаю сканування...</b>\n\n📋 URL для перевірки: ${urls.length}`);
        }

        for (let urlIdx = 0; urlIdx < urls.length; urlIdx++) {
            const url = urls[urlIdx];
            // Notify which URL is being scanned
            const urlSource = url.includes('finn.no') ? 'FINN.no' : url.includes('nav.no') ? 'NAV.no' : 'Джерело';
            if (settings.telegram_chat_id) {
                await sendTelegramMessage(tgToken, settings.telegram_chat_id, `🔍 Сканую <b>${urlSource}</b>...`);
            }

            // Rate limit between consecutive URL scrapes to avoid triggering bot detection
            if (urlIdx > 0) await new Promise(r => setTimeout(r, 1500));

            const { data: scrapeData } = await supabase.functions.invoke('job-scraper', { body: { searchUrl: url, userId: userId } });
            if (!scrapeData?.success) {
                if (settings.telegram_chat_id) {
                    await sendTelegramMessage(tgToken, settings.telegram_chat_id, `⚠️ Помилка сканування ${urlSource}`);
                }
                continue;
            }

            const jobs = scrapeData.jobs || [];
            userFound += jobs.length;
            totalFound += jobs.length;
            const scannedUrls = jobs.map((j: any) => j.job_url);
            // Check for existing jobs FOR THIS USER
            const { data: existingRows } = await supabase.from('jobs').select('job_url').in('job_url', scannedUrls).eq('user_id', userId);
            const existingUrlSet = new Set((existingRows || []).map((r: any) => r.job_url));
            const newJobsToInsert = jobs.filter((j: any) => !existingUrlSet.has(j.job_url));

            // Report findings for this URL
            const existingCount = existingUrlSet.size;
            const newCount = newJobsToInsert.length;
            if (settings.telegram_chat_id) {
                await sendTelegramMessage(tgToken, settings.telegram_chat_id,
                    `📊 <b>${urlSource}:</b>\n` +
                    `   📋 Знайдено: ${jobs.length}\n` +
                    `   ℹ️ В архіві: ${existingCount}\n` +
                    `   🆕 Нових: ${newCount}`
                );
            }

            if (newJobsToInsert.length > 0) {
                await supabase.from('jobs').insert(newJobsToInsert);
                userInserted += newJobsToInsert.length;
                totalInserted += newJobsToInsert.length;

                // Extract full job details (company, deadline, form type) for each new job
                log(`📄 Extracting details for ${newJobsToInsert.length} new jobs...`);
                if (settings.telegram_chat_id) {
                    await sendTelegramMessage(tgToken, settings.telegram_chat_id, `📄 <b>Витягую деталі для ${newJobsToInsert.length} нових вакансій...</b>`);
                }

                for (const job of newJobsToInsert) {
                    try {
                        const { data: extractResult } = await supabase.functions.invoke('extract_job_text', {
                            body: { url: job.job_url }
                        });

                        if (extractResult) {
                            const updates: any = {};

                            // Update company if we got a better one
                            if (extractResult.company && extractResult.company !== 'Unknown Company' &&
                                (job.company === 'Unknown Company' || !job.company)) {
                                updates.company = extractResult.company;
                            }

                            // Update deadline
                            if (extractResult.deadline) {
                                updates.deadline = extractResult.deadline;
                            }

                            // Update form type info (extract_job_text returns snake_case!)
                            if (extractResult.has_enkel_soknad !== undefined) {
                                updates.has_enkel_soknad = extractResult.has_enkel_soknad;
                            }
                            if (extractResult.application_form_type) {
                                updates.application_form_type = extractResult.application_form_type;
                            }
                            if (extractResult.external_apply_url) {
                                updates.external_apply_url = extractResult.external_apply_url;
                            }

                            // Update description if we got a better one
                            if (extractResult.text && (!job.description || job.description.length < 100)) {
                                updates.description = extractResult.text;
                            }

                            if (Object.keys(updates).length > 0) {
                                await supabase.from('jobs').update(updates).eq('job_url', job.job_url);
                                log(`✅ Extracted details for: ${job.title.substring(0, 40)}...`);
                            }
                        }
                    } catch (e: any) {
                        log(`⚠️ Failed to extract details for ${job.job_url}: ${e.message}`);
                    }
                }
            }

            // Note: Individual job cards are sent by analyze_worker.py after analysis
            // (unified single message per job with score + buttons)

            // Track job IDs for this scan (analysis done by worker)
            const { data: jobsToProcess } = await supabase.from('jobs').select('id').in('job_url', scannedUrls).eq('user_id', userId);

            // Track all job IDs from this scan (per user and global)
            (jobsToProcess || []).forEach((j: any) => {
                userScannedJobIds.push(j.id);
                allScannedJobIds.push(j.id);
            });

        } // end URL loop

        // ========== LINKEDIN SCANNING ==========
        // NOTE: LinkedIn Guest API blocks datacenter IPs (Supabase Edge Functions).
        // LinkedIn scanning is handled by the LOCAL Python worker (auto_apply.py → linkedin_scraper.py).
        // This section is disabled to avoid wasting API calls that return 0 results.
        const linkedinTerms: string[] = []; // settings.linkedin_search_terms || [];
        const linkedinEnabled = false; // settings.linkedin_scan_enabled || false;
        const linkedinLocation = settings.linkedin_location || 'Norway';

        if (linkedinEnabled && linkedinTerms.length > 0) {
            // LinkedIn runs max 2x/day: check last scan time
            const { data: lastLinkedinScan } = await supabase.from('system_logs')
                .select('created_at')
                .eq('user_id', userId)
                .eq('event_type', 'SCAN')
                .like('message', '%LinkedIn%')
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            const hoursSinceLastLinkedin = lastLinkedinScan
                ? (Date.now() - new Date(lastLinkedinScan.created_at).getTime()) / (1000 * 60 * 60)
                : 999;

            if (hoursSinceLastLinkedin < 10) {
                log(`⏭️ LinkedIn: Last scan was ${hoursSinceLastLinkedin.toFixed(1)}h ago, skipping (min 10h)`);
            } else {
                log(`🟣 LinkedIn: Scanning ${linkedinTerms.length} search term(s) in ${linkedinLocation}`);
                if (settings.telegram_chat_id) {
                    await sendTelegramMessage(tgToken, settings.telegram_chat_id,
                        `🟣 <b>LinkedIn сканування...</b>\n📍 ${linkedinLocation}\n🔎 ${linkedinTerms.join(', ')}`);
                }

                let linkedinFound = 0, linkedinInserted = 0;

                for (const term of linkedinTerms) {
                    const linkedinUrl = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(term)}&location=${encodeURIComponent(linkedinLocation)}&f_TPR=r86400&sortBy=DD&start=0`;

                    try {
                        const { data: scrapeData } = await supabase.functions.invoke('job-scraper', {
                            body: { searchUrl: linkedinUrl, userId: userId }
                        });

                        if (!scrapeData?.success) {
                            log(`⚠️ LinkedIn scrape failed for "${term}"`);
                            continue;
                        }

                        const linkedinJobs = scrapeData.jobs || [];
                        linkedinFound += linkedinJobs.length;
                        log(`🟣 LinkedIn "${term}": ${linkedinJobs.length} found`);

                        if (linkedinJobs.length === 0) continue;

                        // Dedup 1: URL-based (same LinkedIn URL)
                        const linkedinUrls = linkedinJobs.map((j: any) => j.job_url);
                        const { data: existingByUrl } = await supabase.from('jobs')
                            .select('job_url').in('job_url', linkedinUrls).eq('user_id', userId);
                        const existingUrlSet = new Set((existingByUrl || []).map((r: any) => r.job_url));

                        // Dedup 2: Cross-source (same company + title from FINN/NAV)
                        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
                        const { data: recentJobs } = await supabase.from('jobs')
                            .select('title, company').eq('user_id', userId)
                            .gte('created_at', thirtyDaysAgo);

                        const normalizeForDedup = (text: string) =>
                            (text || '').toLowerCase().replace(/[^a-zæøå0-9\s]/g, '').replace(/\s+/g, ' ').trim();

                        const existingTitleCompany = new Set(
                            (recentJobs || []).map((j: any) =>
                                `${normalizeForDedup(j.company)}||${normalizeForDedup(j.title)}`)
                        );

                        const trulyNew = linkedinJobs.filter((j: any) => {
                            if (existingUrlSet.has(j.job_url)) return false;
                            const key = `${normalizeForDedup(j.company)}||${normalizeForDedup(j.title)}`;
                            return !existingTitleCompany.has(key);
                        });

                        if (trulyNew.length > 0) {
                            // Remove posted_date before insert (not in jobs schema)
                            const toInsert = trulyNew.map((j: any) => {
                                const { posted_date, ...rest } = j;
                                return rest;
                            });
                            await supabase.from('jobs').insert(toInsert);
                            linkedinInserted += trulyNew.length;
                            userInserted += trulyNew.length;
                            totalInserted += trulyNew.length;

                            // Fetch descriptions for new LinkedIn jobs
                            for (const job of trulyNew) {
                                try {
                                    const jobIdMatch = job.job_url.match(/\/jobs\/view\/(\d+)/);
                                    if (jobIdMatch) {
                                        const detailUrl = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobIdMatch[1]}`;
                                        const detailRes = await fetch(detailUrl, {
                                            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                                        });
                                        if (detailRes.ok) {
                                            const detailHtml = await detailRes.text();
                                            const $d = cheerio.load(detailHtml);
                                            const description = $d('div.show-more-less-html__markup, div.description__text').first().text().trim();
                                            const externalUrl = $d('a.apply-button, a[href*="applyUrl"], a.topcard__link--apply').attr('href') || '';

                                            const updates: any = {};
                                            if (description && description.length > 50) updates.description = description.substring(0, 5000);
                                            if (externalUrl && !externalUrl.includes('linkedin.com')) {
                                                updates.external_apply_url = externalUrl.split('?')[0];
                                                updates.application_form_type = 'external_form';
                                            } else {
                                                updates.application_form_type = 'linkedin_easy_apply';
                                            }
                                            if (Object.keys(updates).length > 0) {
                                                await supabase.from('jobs').update(updates).eq('job_url', job.job_url).eq('user_id', userId);
                                            }
                                        }
                                    }
                                    // Rate limit between detail fetches
                                    await new Promise(r => setTimeout(r, 1500));
                                } catch (e: any) {
                                    log(`⚠️ LinkedIn detail fetch failed: ${e.message}`);
                                }
                            }

                            // Track IDs
                            const { data: newIds } = await supabase.from('jobs')
                                .select('id').in('job_url', trulyNew.map((j: any) => j.job_url)).eq('user_id', userId);
                            (newIds || []).forEach((j: any) => {
                                userScannedJobIds.push(j.id);
                                allScannedJobIds.push(j.id);
                            });
                        }

                        if (settings.telegram_chat_id) {
                            await sendTelegramMessage(tgToken, settings.telegram_chat_id,
                                `🟣 <b>LinkedIn "${term}":</b>\n` +
                                `   📋 Знайдено: ${linkedinJobs.length}\n` +
                                `   🔄 Дублікати: ${linkedinJobs.length - trulyNew.length}\n` +
                                `   🆕 Нових: ${trulyNew.length}`);
                        }
                    } catch (e: any) {
                        log(`⚠️ LinkedIn error for "${term}": ${e.message}`);
                    }

                    // Rate limit between search terms
                    await new Promise(r => setTimeout(r, 2000));
                } // end LinkedIn terms loop

                // Log LinkedIn scan
                await supabase.from('system_logs').insert({
                    user_id: userId,
                    event_type: 'SCAN',
                    status: 'SUCCESS',
                    message: `LinkedIn scan: ${linkedinFound} found, ${linkedinInserted} new`,
                    details: { linkedin: true, terms: linkedinTerms, found: linkedinFound, inserted: linkedinInserted },
                    source: 'LINKEDIN'
                });

                log(`🟣 LinkedIn done: ${linkedinFound} found, ${linkedinInserted} new`);
            }
        }

        // Note: Summary message removed - individual job cards will be sent by analyze_worker.py

        // Insert per-user system log for data isolation
        const { error: logError } = await supabase.from('system_logs').insert({
            user_id: userId, // Link log to specific user
            event_type: 'SCAN',
            status: 'SUCCESS',
            message: `Scan completed. Analysis delegated to worker.`,
            details: {
                jobsFound: userFound,
                newJobs: userInserted,
                scannedJobIds: userScannedJobIds
            },
            source: source || 'CRON'
        });
        if (logError) {
            log(`⚠️ Failed to write system log: ${logError.message}`);
        }

        log(`✅ Completed processing for user ${userId}: found=${userFound}, new=${userInserted}`);
        if (userInserted > 0) {
            processedUserIds.push(userId);
        }
    } // end user loop

    // ========== TRIGGER ANALYZE WORKER ==========
    // Trigger GitHub Actions analyze-worker to handle any remaining unanalyzed jobs
    const githubToken = Deno.env.get('GITHUB_PAT');
    const githubRepo = Deno.env.get('GITHUB_REPO') || 'SmmShaman/Jobbot-NO'; // owner/repo format

    if (githubToken && totalInserted > 0) {
        try {
            const dispatchUrl = `https://api.github.com/repos/${githubRepo}/dispatches`;
            const dispatchRes = await fetch(dispatchUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${githubToken}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'JobBot-Scanner'
                },
                body: JSON.stringify({
                    event_type: 'analyze-jobs',
                    client_payload: {
                        trigger: source || 'CRON',
                        jobs_inserted: totalInserted,
                        user_ids: processedUserIds,
                        timestamp: new Date().toISOString()
                    }
                })
            });

            if (dispatchRes.ok || dispatchRes.status === 204) {
                log(`🚀 Triggered analyze-worker via GitHub Actions`);
            } else {
                const errText = await dispatchRes.text();
                log(`⚠️ GitHub dispatch failed: ${dispatchRes.status} - ${errText.substring(0, 100)}`);
            }
        } catch (e: any) {
            log(`⚠️ Failed to trigger analyze-worker: ${e.message}`);
        }
    } else if (!githubToken) {
        log(`ℹ️ GITHUB_PAT not configured, skipping worker trigger`);
    }

    return new Response(JSON.stringify({ success: true, jobsFound: totalFound, usersProcessed: allUsers.length, logs }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: any) {
    // Note: For failed scans we can't always know the user_id, so it may be null
    const { error: logError } = await supabase.from('system_logs').insert({
        event_type: 'SCAN',
        status: 'FAILED',
        message: error.message,
        source: 'CRON',
        user_id: null // Failed scans may not have user context
    });
    if (logError) {
        console.error(`⚠️ Failed to write error log: ${logError.message}`);
    }
    return new Response(JSON.stringify({ success: false, error: error.message, logs }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
