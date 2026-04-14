
const VERSION_STAMP = '2026-03-29-force-redeploy';
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import * as cheerio from "https://esm.sh/cheerio@1.0.0-rc.12";

declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper: Check if URL is an actual external application form (not an aggregator page)
function isExternalApplyUrl(url: string): boolean {
  if (!url || !url.startsWith('http')) return false;
  const lower = url.toLowerCase();
  // Reject aggregator/intermediate pages — these are NOT final application forms
  if (lower.includes('finn.no') && !lower.includes('finn.no/job/apply')) return false;
  if (lower.includes('arbeidsplassen.nav.no')) return false;
  if (lower.includes('nav.no/stillinger')) return false;
  return true;
}

// Helper: Extract domain from URL
function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    // Remove www. prefix and get main domain
    return hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

// Helper: Extract finnkode from FINN URL using multiple patterns
function extractFinnkode(url: string): string | null {
  if (!url || !url.includes('finn.no')) {
    return null;
  }

  // Pattern 1: Query parameter format - ?finnkode=123456789
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
}

// Helper: Parse Norwegian date format to ISO date string
// Handles formats like: "31. desember 2024", "31.12.2024", "31/12/2024", "2024-12-31"
function parseNorwegianDate(dateStr: string): string | null {
  if (!dateStr) return null;

  const norwegianMonths: Record<string, string> = {
    'januar': '01', 'februar': '02', 'mars': '03', 'april': '04',
    'mai': '05', 'juni': '06', 'juli': '07', 'august': '08',
    'september': '09', 'oktober': '10', 'november': '11', 'desember': '12'
  };

  const cleaned = dateStr.toLowerCase().trim();

  // Try format: "31. desember 2024" or "31 desember 2024"
  const norwegianMatch = cleaned.match(/(\d{1,2})\.?\s*([a-zæøå]+)\s*(\d{4})/);
  if (norwegianMatch) {
    const day = norwegianMatch[1].padStart(2, '0');
    const month = norwegianMonths[norwegianMatch[2]];
    const year = norwegianMatch[3];
    if (month) {
      return `${year}-${month}-${day}`;
    }
  }

  // Try format: "31.12.2024" or "31/12/2024"
  const numericMatch = cleaned.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
  if (numericMatch) {
    const day = numericMatch[1].padStart(2, '0');
    const month = numericMatch[2].padStart(2, '0');
    const year = numericMatch[3];
    return `${year}-${month}-${day}`;
  }

  // Try ISO format: "2024-12-31"
  const isoMatch = cleaned.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return isoMatch[0];
  }

  return null;
}

// Helper: Check if text indicates ASAP/immediate deadline
function isAsapDeadline(text: string): boolean {
  const asapTerms = ['snarest', 'asap', 'fortløpende', 'løpende', 'straks', 'umiddelbart', 'så snart som mulig'];
  const lower = text.toLowerCase().trim();
  return asapTerms.some(term => lower.includes(term));
}

// ========================================
// QUALITY SCORING FUNCTIONS
// ========================================

// Score company name quality (0-100)
// Higher score = better quality, more reliable data
function scoreCompanyName(name: string | null | undefined): number {
  if (!name) return 0;
  const trimmed = name.trim();

  // Known bad values
  if (trimmed === 'Unknown Company' || trimmed === 'Unknown' || trimmed === '') return 0;

  let score = 50;

  // Bonuses
  if (trimmed.includes(' AS') || trimmed.includes(' ASA')) score += 20;  // Norwegian company suffix
  if (trimmed.length > 10) score += 10;  // Longer = likely full name
  if (/^[A-ZÆØÅ]/.test(trimmed)) score += 5;  // Starts with capital

  // Penalties
  if (trimmed.length < 3) score -= 30;  // Too short
  if (/^\d/.test(trimmed)) score -= 40;  // Starts with digit (likely garbage)
  if (trimmed.includes('...')) score -= 20;  // Truncated
  if (/[<>{}[\]]/.test(trimmed)) score -= 50;  // HTML/JSON garbage
  if (trimmed.toLowerCase().includes('finn.no')) score -= 40;  // Site name, not company
  if (trimmed.toLowerCase().includes('nav.no')) score -= 40;
  if (trimmed.toLowerCase() === 'arbeidsgiver') score -= 30;  // Label, not company name
  if (trimmed.toLowerCase().includes('arbeidsplassen logo')) score -= 50;  // NAV site logo alt text
  if (trimmed.toLowerCase().includes('om bedriften')) score -= 30;  // Section header, not company
  if (trimmed.toLowerCase().startsWith('om bedriften')) score -= 40;
  if (/^(Sektor|Sted|Bransje|Stillingsfunksjon)/i.test(trimmed)) score -= 40;  // NAV field labels

  return Math.max(0, Math.min(100, score));
}

// Score location quality (0-100)
// Higher score = more specific/useful location
function scoreLocation(loc: string | null | undefined): number {
  if (!loc) return 0;
  const trimmed = loc.trim();
  if (trimmed === '') return 0;

  let score = 50;

  // Generic/vague locations get low scores
  if (trimmed === 'Norway' || trimmed === 'Norge') return 10;
  if (trimmed === 'Flere steder' || trimmed === 'Multiple locations') return 15;
  if (trimmed.toLowerCase() === 'remote' || trimmed.toLowerCase() === 'hjemmekontor') return 20;

  // Bonuses for specificity
  if (/\d{4}/.test(trimmed)) score += 20;  // Contains postal code
  if (trimmed.includes(',')) score += 10;  // Multiple parts (address, city)

  // Known Norwegian cities
  const majorCities = ['Oslo', 'Bergen', 'Trondheim', 'Stavanger', 'Drammen', 'Kristiansand', 'Tromsø', 'Fredrikstad', 'Sandnes', 'Bodø'];
  const mediumCities = ['Gjøvik', 'Lillehammer', 'Hamar', 'Ålesund', 'Haugesund', 'Tønsberg', 'Moss', 'Sarpsborg', 'Skien', 'Arendal'];

  if (majorCities.some(c => trimmed.includes(c))) score += 20;
  else if (mediumCities.some(c => trimmed.includes(c))) score += 15;

  // Penalties
  if (trimmed.length < 3) score -= 30;
  if (/[<>{}[\]]/.test(trimmed)) score -= 50;  // HTML/JSON garbage
  if (trimmed.includes('...')) score -= 15;  // Truncated

  return Math.max(0, Math.min(100, score));
}

// Score job title quality (0-100)
// Higher score = cleaner, more complete title
function scoreTitle(title: string | null | undefined): number {
  if (!title) return 0;
  const trimmed = title.trim();
  if (trimmed === '') return 0;

  // Known bad values
  if (trimmed === 'Untitled Job' || trimmed === 'Job' || trimmed === 'Stilling') return 0;

  let score = 50;

  // Bonuses for longer, more descriptive titles
  if (trimmed.length > 20) score += 15;
  if (trimmed.length > 40) score += 10;

  // Good job title patterns
  if (trimmed.split(' ').length >= 2 && trimmed.split(' ').length <= 8) score += 10;  // Reasonable word count
  if (/^[A-ZÆØÅ]/.test(trimmed)) score += 5;  // Starts with capital

  // Penalties
  if (/^\d/.test(trimmed)) score -= 30;  // Starts with digit
  if (trimmed.includes('...')) score -= 15;  // Truncated
  if (/[<>{}[\]]/.test(trimmed)) score -= 50;  // HTML/JSON garbage
  if (trimmed.split(' ').length < 2) score -= 20;  // Too short (single word)
  if (trimmed.length > 150) score -= 15;  // Too long (likely includes extra text)
  if (trimmed.toLowerCase().includes('- finn') || trimmed.toLowerCase().includes('| finn')) score -= 20;  // Site name in title
  if (trimmed.toLowerCase().includes('- nav') || trimmed.toLowerCase().includes('| nav')) score -= 20;

  return Math.max(0, Math.min(100, score));
}

// Helper: Calculate estimated deadline (today + N days)
function getEstimatedDeadline(daysFromNow: number = 14): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return '~' + date.toISOString().split('T')[0]; // Prefix with ~ to indicate estimated
}

// Helper: Extract deadline (søknadsfrist) from FINN page
function extractDeadline($: cheerio.CheerioAPI, html: string): string | null {
  // Method 0: FINN-specific structure - <li>Frist<span>DATE</span></li>
  // This is the actual FINN HTML structure as of Dec 2025
  try {
    const fristLi = $('li').filter((_, el) => {
      const text = $(el).clone().children().remove().end().text().trim();
      return text.toLowerCase().includes('frist');
    }).first();

    if (fristLi.length > 0) {
      const dateSpan = fristLi.find('span').first();
      if (dateSpan.length > 0) {
        const dateText = dateSpan.text().trim();

        // Check for "Snarest" / ASAP indicators
        if (isAsapDeadline(dateText)) {
          const estimated = getEstimatedDeadline(14); // 2 weeks from now
          console.log(`📅 Found ASAP deadline "${dateText}", estimated: ${estimated}`);
          return estimated;
        }

        const parsed = parseNorwegianDate(dateText);
        if (parsed) {
          console.log(`📅 Found deadline from FINN li>span: ${dateText} -> ${parsed}`);
          return parsed;
        }
      }
    }
  } catch (e) {
    console.log(`⚠️ Error in FINN li>span selector: ${e}`);
  }

  // Method 1: Look for specific selectors (order matters - most specific first)
  const deadlineSelectors = [
    'dt:contains("Søknadsfrist") + dd',
    'dt:contains("Frist") + dd',
    'th:contains("Søknadsfrist") + td',
    'th:contains("Frist") + td',
    '[data-testid*="deadline"]',
    '[data-testid*="frist"]',
    '.deadline',
  ];

  for (const selector of deadlineSelectors) {
    try {
      const el = $(selector).first();
      if (el.length > 0) {
        // Check for datetime attribute first
        const datetime = el.attr('datetime');
        if (datetime) {
          const parsed = parseNorwegianDate(datetime);
          if (parsed) {
            console.log(`📅 Found deadline from datetime attr: ${parsed}`);
            return parsed;
          }
        }

        // Otherwise use text content
        const text = el.text().trim();
        const parsed = parseNorwegianDate(text);
        if (parsed) {
          console.log(`📅 Found deadline from selector "${selector}": ${text} -> ${parsed}`);
          return parsed;
        }
      }
    } catch (e) {
      // Continue
    }
  }

  // Method 2: Regex search in HTML for "Søknadsfrist" or "Frist"
  const htmlLower = html.toLowerCase();
  const fristPatterns = [
    /søknadsfrist[:\s]*(\d{1,2}\.?\s*[a-zæøå]+\s*\d{4})/i,  // "søknadsfrist: 16. januar 2026"
    /søknadsfrist[:\s]*(\d{1,2}[.\/]\d{1,2}[.\/]\d{4})/i,  // "søknadsfrist: 16.01.2026"
    /frist[:\s]*(\d{1,2}[.\/]\d{1,2}[.\/]\d{4})/i,         // "frist: 16.01.2026" - FINN format!
    /frist[:\s]*(\d{1,2}\.?\s*[a-zæøå]+\s*\d{4})/i,        // "frist: 16. januar 2026"
    /deadline[:\s]*(\d{1,2}[.\/]\d{1,2}[.\/]\d{4})/i       // "deadline: 16.01.2026"
  ];

  for (const pattern of fristPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      const parsed = parseNorwegianDate(match[1]);
      if (parsed) {
        console.log(`📅 Found deadline from regex: ${match[1]} -> ${parsed}`);
        return parsed;
      }
    }
  }

  // Method 3: Look for "Snarest" or "ASAP" indicators in HTML
  if (isAsapDeadline(html)) {
    const estimated = getEstimatedDeadline(14);
    console.log(`📅 Found ASAP indicator in HTML, estimated: ${estimated}`);
    return estimated;
  }

  return null;
}

// Helper: Extract contact information from job page
interface ContactInfo {
  name: string | null;
  phone: string | null;
  email: string | null;
  title: string | null;
}

function extractContactInfo($: cheerio.CheerioAPI, html: string): ContactInfo {
  const contact: ContactInfo = { name: null, phone: null, email: null, title: null };

  // Method 1: Look for structured contact sections
  const contactSelectors = [
    'dt:contains("Kontaktperson") + dd',
    'dt:contains("Kontakt") + dd',
    'th:contains("Kontaktperson") + td',
    '[data-testid*="contact"]',
    '[class*="contact"]',
    '.contact-info',
    '.kontaktperson',
  ];

  for (const selector of contactSelectors) {
    try {
      const el = $(selector).first();
      if (el.length > 0) {
        const text = el.text().trim();
        if (text && text.length > 2) {
          // Try to extract name (first part before phone/email)
          const parts = text.split(/[\n\r,]/);
          if (parts[0] && parts[0].length > 2 && parts[0].length < 50) {
            contact.name = parts[0].trim();
            console.log(`👤 Found contact name from selector: ${contact.name}`);
          }
        }
      }
    } catch (e) {
      // Continue
    }
  }

  // Method 2: FINN-specific li>span structure
  try {
    const kontaktLi = $('li').filter((_, el) => {
      const text = $(el).clone().children().remove().end().text().trim().toLowerCase();
      return text.includes('kontakt') || text.includes('spørsmål');
    }).first();

    if (kontaktLi.length > 0) {
      const spans = kontaktLi.find('span');
      spans.each((_, span) => {
        const text = $(span).text().trim();
        // Check for phone
        if (/^\+?\d[\d\s]{7,}$/.test(text.replace(/\s/g, ''))) {
          contact.phone = text;
          console.log(`📞 Found phone from li>span: ${contact.phone}`);
        }
        // Check for email
        else if (text.includes('@')) {
          contact.email = text;
          console.log(`📧 Found email from li>span: ${contact.email}`);
        }
        // Check for name (if not phone/email and looks like a name)
        else if (text.length > 2 && text.length < 50 && !contact.name && /^[A-ZÆØÅ]/.test(text)) {
          contact.name = text;
          console.log(`👤 Found contact name from li>span: ${contact.name}`);
        }
      });
    }
  } catch (e) {
    console.log(`⚠️ Error in contact li>span selector: ${e}`);
  }

  // Method 3: Extract phone numbers from HTML
  if (!contact.phone) {
    // Norwegian phone patterns: +47 XXX XX XXX, 4X XX XX XX, 9X XX XX XX
    const phonePatterns = [
      /(?:\+47|0047)?\s*[49]\d[\s\-]?\d{2}[\s\-]?\d{2}[\s\-]?\d{2,3}/g,
      /tlf\.?:?\s*(\+?\d[\d\s\-]{7,})/gi,
      /telefon:?\s*(\+?\d[\d\s\-]{7,})/gi,
      /mobil:?\s*(\+?\d[\d\s\-]{7,})/gi,
    ];

    for (const pattern of phonePatterns) {
      const matches = html.match(pattern);
      if (matches && matches.length > 0) {
        // Take first match that looks valid
        for (const match of matches) {
          const cleaned = match.replace(/[^\d+]/g, '');
          if (cleaned.length >= 8 && cleaned.length <= 14) {
            contact.phone = match.trim();
            console.log(`📞 Found phone from regex: ${contact.phone}`);
            break;
          }
        }
        if (contact.phone) break;
      }
    }
  }

  // Method 4: Extract email addresses from HTML
  if (!contact.email) {
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const matches = html.match(emailPattern);
    if (matches && matches.length > 0) {
      // Filter out common non-contact emails
      const ignorePatterns = ['@finn.no', '@nav.no', '@example', 'noreply', 'no-reply', 'info@', 'post@', 'firmapost@'];
      for (const email of matches) {
        const lower = email.toLowerCase();
        if (!ignorePatterns.some(p => lower.includes(p))) {
          contact.email = email;
          console.log(`📧 Found email from regex: ${contact.email}`);
          break;
        }
      }
    }
  }

  // Method 5: Look for contact name patterns in text
  if (!contact.name) {
    // Pattern: "Kontakt: Name" or "Kontaktperson: Name"
    const namePatterns = [
      /kontaktperson:?\s*([A-ZÆØÅ][a-zæøå]+(?:\s+[A-ZÆØÅ][a-zæøå]+){1,2})/i,
      /kontakt:?\s*([A-ZÆØÅ][a-zæøå]+(?:\s+[A-ZÆØÅ][a-zæøå]+){1,2})/i,
      /spørsmål.*?:?\s*([A-ZÆØÅ][a-zæøå]+(?:\s+[A-ZÆØÅ][a-zæøå]+){1,2})/i,
    ];

    for (const pattern of namePatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        if (name.length > 2 && name.length < 40) {
          contact.name = name;
          console.log(`👤 Found contact name from regex: ${contact.name}`);
          break;
        }
      }
    }
  }

  return contact;
}

// Helper: Extract company name from job page
function extractCompanyName($: cheerio.CheerioAPI, html: string, url: string): string | null {
  const isNav = url.includes('nav.no') || url.includes('arbeidsplassen');
  const isFinn = url.includes('finn.no');

  // Method 0: NAV-specific - try to get from JSON-LD or API data embedded in page
  if (isNav) {
    // NAV often embeds job data in script tags
    try {
      // Look for JSON-LD structured data
      const jsonLdScript = $('script[type="application/ld+json"]').html();
      if (jsonLdScript) {
        const jsonData = JSON.parse(jsonLdScript);
        if (jsonData.hiringOrganization?.name) {
          console.log(`🏢 Found company from NAV JSON-LD: ${jsonData.hiringOrganization.name}`);
          return jsonData.hiringOrganization.name;
        }
      }
    } catch (e) {
      // Continue
    }

    // NAV page structure - company appears near the title with building icon
    const navCompanySelectors = [
      // Common NAV selectors for employer
      '[class*="employer"]',
      '[class*="Employer"]',
      '[class*="company"]',
      '[class*="Company"]',
      '[class*="arbeidsgiver"]',
      '[data-testid*="employer"]',
      // Look for paragraph/span near title that contains company
      'header p',
      'header span',
      '.job-header p',
      // Generic patterns
      'p:has(svg)', // NAV often shows company with an icon
    ];

    for (const selector of navCompanySelectors) {
      try {
        const el = $(selector).first();
        if (el.length > 0) {
          const text = el.text().trim();
          // Filter out addresses and other non-company text
          if (text && text.length > 2 && text.length < 100 &&
              !text.match(/^\d/) && // Doesn't start with number (address)
              !text.includes('Søk senest') && // Not deadline text
              !text.includes('Hjemmekontor')) { // Not work location
            console.log(`🏢 Found company from NAV selector "${selector}": ${text}`);
            return text;
          }
        }
      } catch (e) {
        // Continue
      }
    }

    // NAV: Look for text pattern "employer" in any element following the title
    const h1 = $('h1').first();
    if (h1.length > 0) {
      const nextElements = h1.nextAll().slice(0, 5);
      nextElements.each((_, el) => {
        const text = $(el).text().trim();
        // Company names often contain AS, kommune, or are capitalized
        if (text && text.length > 2 && text.length < 100 &&
            !text.match(/^\d/) && !text.includes('Søk') &&
            (text.includes(' AS') || text.includes(' as') ||
             text.includes('kommune') || text.includes('Kommune') ||
             text.match(/^[A-ZÆØÅ]/))) {
          console.log(`🏢 Found company from NAV h1 sibling: ${text}`);
          return text;
        }
      });
    }
  }

  // Method 1: FINN-specific - look for company in JSON config data
  // Pattern: "company_name","value":["Company Name"]
  if (isFinn) {
    const configMatch = html.match(/"company_name"\s*,\s*"value"\s*:\s*\[\s*"([^"]+)"\s*\]/);
    if (configMatch && configMatch[1]) {
      console.log(`🏢 Found company from FINN config data: ${configMatch[1]}`);
      return configMatch[1];
    }
  }

  // Method 2: Look for employer/arbeidsgiver section (works for both FINN and NAV)
  const employerSelectors = [
    'dt:contains("Arbeidsgiver") + dd',
    'dt:contains("Bedrift") + dd',
    'th:contains("Arbeidsgiver") + td',
    '[data-testid*="employer"]',
    '[data-testid*="company"]',
    '.employer-name',
    '.company-name',
  ];

  for (const selector of employerSelectors) {
    try {
      const el = $(selector).first();
      if (el.length > 0) {
        const text = el.text().trim();
        if (text && text.length > 1 && text.length < 100) {
          console.log(`🏢 Found company from selector "${selector}": ${text}`);
          return text;
        }
      }
    } catch (e) {
      // Continue
    }
  }

  // Method 3: FINN-specific li>span structure - <li>Arbeidsgiver<span>Company</span></li>
  if (isFinn) {
    try {
      const arbeidsgiverLi = $('li').filter((_, el) => {
        const text = $(el).clone().children().remove().end().text().trim().toLowerCase();
        return text.includes('arbeidsgiver') || text.includes('bedrift');
      }).first();

      if (arbeidsgiverLi.length > 0) {
        const companySpan = arbeidsgiverLi.find('span').first();
        if (companySpan.length > 0) {
          const company = companySpan.text().trim();
          if (company && company.length > 1) {
            console.log(`🏢 Found company from FINN li>span: ${company}`);
            return company;
          }
        }
      }
    } catch (e) {
      console.log(`⚠️ Error in company li>span selector: ${e}`);
    }
  }

  // Method 4: Look for og:site_name or similar meta tags
  const metaCompany = $('meta[property="og:site_name"]').attr('content') ||
                      $('meta[name="author"]').attr('content');
  if (metaCompany && !metaCompany.toLowerCase().includes('finn') &&
      !metaCompany.toLowerCase().includes('nav') &&
      !metaCompany.toLowerCase().includes('arbeidsplassen') &&
      metaCompany.length < 100) {
    console.log(`🏢 Found company from meta tag: ${metaCompany}`);
    return metaCompany;
  }

  // Method 5: Generic - look for text with "AS" suffix (Norwegian company indicator)
  try {
    const allText = $('body').text();
    const asMatch = allText.match(/([A-ZÆØÅ][A-Za-zæøåÆØÅ\s&]+(?:\s+AS|\s+ASA))/);
    if (asMatch && asMatch[1] && asMatch[1].length > 3 && asMatch[1].length < 80) {
      console.log(`🏢 Found company from AS pattern: ${asMatch[1].trim()}`);
      return asMatch[1].trim();
    }
  } catch (e) {
    // Continue
  }

  return null;
}

// Helper: Extract job title from job page
// More reliable than search results - gets full title from detail page
function extractTitle($: cheerio.CheerioAPI, html: string, url: string): string | null {
  // Method 1: H1 tag (most reliable for job pages)
  const h1 = $('h1').first().text().trim();
  if (h1 && h1.length > 5 && h1.length < 200) {
    // Clean up common patterns
    let title = h1;
    // Remove " - FINN.no" or " | NAV" suffixes
    title = title.split(' - FINN')[0].split(' | FINN')[0];
    title = title.split(' - NAV')[0].split(' | NAV')[0];
    title = title.split(' - Arbeidsplassen')[0];
    title = title.trim();

    if (title.length > 5) {
      console.log(`📝 Found title from H1: "${title}"`);
      return title;
    }
  }

  // Method 2: og:title meta tag
  const ogTitle = $('meta[property="og:title"]').attr('content');
  if (ogTitle && ogTitle.length > 5) {
    // Clean up "Job Title - FINN.no" format
    let title = ogTitle.split(' - FINN')[0].split(' | FINN')[0];
    title = title.split(' - NAV')[0].split(' | NAV')[0];
    title = title.trim();

    if (title.length > 5) {
      console.log(`📝 Found title from og:title: "${title}"`);
      return title;
    }
  }

  // Method 3: title tag (fallback)
  const titleTag = $('title').text().trim();
  if (titleTag && titleTag.length > 5) {
    let title = titleTag.split(' - ')[0].split(' | ')[0].trim();
    if (title.length > 5 && title.length < 150) {
      console.log(`📝 Found title from <title>: "${title}"`);
      return title;
    }
  }

  // Method 4: NAV-specific patterns
  if (url.includes('nav.no') || url.includes('arbeidsplassen')) {
    // Try data-testid selectors
    const navTitleSelectors = [
      '[data-testid="job-title"]',
      '.job-title',
      'header h1',
      '.JobPosting__Title'
    ];

    for (const sel of navTitleSelectors) {
      const el = $(sel).first();
      if (el.length > 0) {
        const title = el.text().trim();
        if (title.length > 5 && title.length < 200) {
          console.log(`📝 Found title from NAV selector "${sel}": "${title}"`);
          return title;
        }
      }
    }
  }

  return null;
}

// Helper: Extract location from job page
// More accurate than search results - gets full address/city
function extractLocation($: cheerio.CheerioAPI, html: string, url: string): string | null {
  const isFinn = url.includes('finn.no');
  const isNav = url.includes('nav.no') || url.includes('arbeidsplassen');

  // Method 1: FINN-specific li>span pattern - <li>Sted<span>City</span></li>
  if (isFinn) {
    try {
      const stedLi = $('li').filter((_, el) => {
        const text = $(el).clone().children().remove().end().text().trim().toLowerCase();
        return text.includes('sted') || text.includes('arbeidssted') || text.includes('lokasjon');
      }).first();

      if (stedLi.length > 0) {
        const locationSpan = stedLi.find('span').first();
        if (locationSpan.length > 0) {
          const loc = locationSpan.text().trim();
          if (loc && loc.length > 2 && loc.length < 100) {
            console.log(`📍 Found location from FINN li>span: "${loc}"`);
            return loc;
          }
        }
      }
    } catch (e) {
      // Continue
    }
  }

  // Method 2: Standard semantic selectors
  const locationSelectors = [
    'dt:contains("Arbeidssted") + dd',
    'dt:contains("Sted") + dd',
    'dt:contains("Lokasjon") + dd',
    'th:contains("Arbeidssted") + td',
    '[data-testid*="location"]',
    '[data-testid*="sted"]',
    '.location',
    '.job-location'
  ];

  for (const sel of locationSelectors) {
    try {
      const el = $(sel).first();
      if (el.length > 0) {
        const text = el.text().trim();
        if (text && text.length > 2 && text.length < 100) {
          console.log(`📍 Found location from selector "${sel}": "${text}"`);
          return text;
        }
      }
    } catch (e) {
      // Continue
    }
  }

  // Method 3: NAV-specific - look for address near building icon or in structured data
  if (isNav) {
    // Already handled in navFullAddress from __NEXT_DATA__ - this is a fallback
    const navLocationSelectors = [
      '[class*="location"]',
      '[class*="address"]',
      '.workplace-address'
    ];

    for (const sel of navLocationSelectors) {
      try {
        const el = $(sel).first();
        if (el.length > 0) {
          const text = el.text().trim();
          if (text && text.length > 2 && text.length < 100 && !text.includes('Hjemmekontor')) {
            console.log(`📍 Found location from NAV selector "${sel}": "${text}"`);
            return text;
          }
        }
      } catch (e) {
        // Continue
      }
    }
  }

  // Method 4: Look for city patterns in the first part of the page
  // Norwegian cities often appear near the job title
  try {
    const majorCities = ['Oslo', 'Bergen', 'Trondheim', 'Stavanger', 'Drammen', 'Kristiansand'];
    const headerText = $('header, .job-header, [class*="header"]').text();

    for (const city of majorCities) {
      if (headerText.includes(city)) {
        // Try to extract more context around the city name
        const match = headerText.match(new RegExp(`([\\d\\w\\s,]*${city}[\\w\\s,]*)`, 'i'));
        if (match && match[1]) {
          const loc = match[1].trim().substring(0, 80);  // Limit length
          if (loc.length > 2) {
            console.log(`📍 Found location from header city match: "${loc}"`);
            return loc;
          }
        }
      }
    }
  } catch (e) {
    // Continue
  }

  return null;
}

// Helper: Detect form type from external page HTML
function detectFormType(html: string, $: cheerio.CheerioAPI): 'form' | 'registration' | 'unknown' {
  const htmlLower = html.toLowerCase();

  // Registration indicators (strong signals)
  const registrationPatterns = [
    'create account', 'create an account', 'sign up', 'signup',
    'register', 'registrer', 'opprett konto', 'opprett bruker',
    'lag konto', 'log in to apply', 'logg inn for å søke',
    'create your profile', 'opprett din profil'
  ];

  // Check for password field (strong registration indicator)
  const hasPasswordField = $('input[type="password"]').length > 0;

  // Check for registration patterns in text
  const hasRegistrationText = registrationPatterns.some(pattern =>
    htmlLower.includes(pattern)
  );

  // Check for social login buttons (indicates registration required)
  const hasSocialLogin = htmlLower.includes('sign in with') ||
                         htmlLower.includes('logg inn med') ||
                         htmlLower.includes('linkedin') && htmlLower.includes('login');

  // Form indicators (direct application)
  const formPatterns = [
    'upload cv', 'last opp cv', 'attach resume', 'legg ved',
    'søknadsskjema', 'application form', 'send søknad',
    'submit application', 'apply now', 'søk nå'
  ];

  const hasDirectForm = formPatterns.some(pattern =>
    htmlLower.includes(pattern)
  ) && !hasPasswordField;

  // Decision logic
  if (hasPasswordField || hasSocialLogin) {
    return 'registration';
  }

  if (hasRegistrationText && !hasDirectForm) {
    return 'registration';
  }

  if (hasDirectForm) {
    return 'form';
  }

  // If we find a form element with file upload but no password, likely direct form
  const hasFileUpload = $('input[type="file"]').length > 0;
  const hasEmailField = $('input[type="email"]').length > 0;

  if (hasFileUpload && hasEmailField && !hasPasswordField) {
    return 'form';
  }

  return 'unknown';
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { job_id, url } = await req.json();

    if (!url) {
      throw new Error('URL is required');
    }

    // Validate URL - reject search/filter pages
    const invalidPatterns = [
      'finn.no/job/search',
      'finn.no/job/fulltime?',  // search with filters
      'finn.no/job/parttime?',
      '/search?',
      '/filter?'
    ];

    const urlLower = url.toLowerCase();
    for (const pattern of invalidPatterns) {
      if (urlLower.includes(pattern)) {
        console.log(`❌ Rejected search URL: ${url}`);
        return new Response(
          JSON.stringify({
            success: false,
            error: 'This is a search/filter page URL, not a specific job listing. Please provide a direct job URL.'
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
        );
      }
    }

    console.log(`Scraping job text for: ${url}`);

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 1. Fetch URL HTML
    const response = await fetch(url, {
       headers: {
         'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
       }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // 2. Detect application type - prioritize button detection over raw text
    let hasEnkelSoknad = false;
    let hasSokHerButton = false;
    let applicationFormType: 'finn_easy' | 'external_form' | 'external_registration' | 'unknown' = 'unknown';
    let externalApplyUrl: string | null = null;

    // NAV-specific data extracted from __NEXT_DATA__
    let navDeadline: string | null = null;
    let navFullAddress: string | null = null;
    let navCompany: string | null = null;

    // NEW: For NAV pages, check for embedded FINN apply URLs first
    // NAV often embeds applicationUrl in JSON or uses FINN for applications
    if (url.includes('nav.no') || url.includes('arbeidsplassen')) {
      // Method 1: Look for applicationUrl in embedded JSON
      // NAV may use escaped quotes (\") or double-escaped (\\") in embedded JSON
      // Match applicationUrl followed by https:// URL, stop at first unescaped quote
      const applicationUrlMatch = html.match(/applicationUrl[\\"]?\s*:\s*[\\"]?(https?:\/\/[^"]+)/);
      if (applicationUrlMatch && applicationUrlMatch[1]) {
        let appUrl = applicationUrlMatch[1]
          .split(/\\"/)[0]            // Stop at escaped quote boundary (\\")
          .replace(/\\+$/, '')        // Remove trailing backslashes
          .replace(/\\u0026/g, '&')   // Decode unicode ampersand
          .replace(/&amp;/g, '&')     // Decode HTML ampersand
          .replace(/\\\\/g, '')       // Remove remaining double backslashes
          .replace(/\\/g, '');        // Remove remaining single backslashes
        console.log(`🔍 NAV: Found applicationUrl in JSON: ${appUrl}`);
        if (appUrl.includes('finn.no/job/apply')) {
          externalApplyUrl = appUrl;
          hasEnkelSoknad = true;
          applicationFormType = 'finn_easy';
          console.log(`✅ NAV job uses FINN Enkel Søknad: ${externalApplyUrl}`);
        } else if (isExternalApplyUrl(appUrl)) {
          externalApplyUrl = appUrl;
          applicationFormType = 'external_form';
          console.log(`🔗 NAV job uses external form: ${externalApplyUrl}`);
        } else {
          console.log(`⚠️ NAV: Rejected intermediate URL: ${appUrl}`);
        }
      }

      // Method 2: Look for FINN apply URL in href attributes
      if (!externalApplyUrl) {
        const finnApplyMatch = html.match(/href="(https?:\/\/[^"]*finn\.no\/job\/apply[^"]*)"/);
        if (finnApplyMatch && finnApplyMatch[1]) {
          externalApplyUrl = finnApplyMatch[1];
          hasEnkelSoknad = true;
          applicationFormType = 'finn_easy';
          console.log(`✅ NAV: Found FINN apply URL in href: ${externalApplyUrl}`);
        }
      }

      // Method 3: Parse __NEXT_DATA__ JSON for comprehensive NAV data
      // NAV uses Next.js and embeds job data in this script tag
      const nextDataScript = $('script#__NEXT_DATA__').html();
      if (nextDataScript) {
        try {
          const nextData = JSON.parse(nextDataScript);
          const adData = nextData?.props?.pageProps?.adData || nextData?.props?.pageProps?.ad;

          if (adData) {
            console.log('📦 NAV: Found __NEXT_DATA__ with adData');

            // Extract deadline from __NEXT_DATA__
            // Check multiple possible fields
            const applicationDue = adData.application?.applicationDueDate ||
                                   adData.applicationDue ||
                                   adData.properties?.applicationdue ||
                                   adData.expires;
            if (applicationDue) {
              console.log(`📅 NAV __NEXT_DATA__: applicationDue raw = "${applicationDue}"`);
              // Parse the deadline
              if (typeof applicationDue === 'string') {
                if (isAsapDeadline(applicationDue)) {
                  navDeadline = getEstimatedDeadline(14);
                  console.log(`📅 NAV __NEXT_DATA__: ASAP deadline -> estimated: ${navDeadline}`);
                } else if (applicationDue.includes('T')) {
                  // ISO format with time: "2026-02-11T00:00:00+01:00"
                  navDeadline = applicationDue.split('T')[0];
                  console.log(`📅 NAV __NEXT_DATA__: Parsed ISO deadline: ${navDeadline}`);
                } else {
                  navDeadline = parseNorwegianDate(applicationDue);
                  console.log(`📅 NAV __NEXT_DATA__: Parsed deadline: ${navDeadline}`);
                }
              }
            }

            // Extract location list from __NEXT_DATA__
            const locationList = adData.locationList || adData.locations;
            if (locationList?.length > 0) {
              const loc = locationList[0];
              const locParts = [];
              if (loc.address) locParts.push(loc.address);
              if (loc.postalCode) locParts.push(loc.postalCode);
              if (loc.city) locParts.push(loc.city);
              if (locParts.length > 0) {
                navFullAddress = locParts.join(', ');
                console.log(`📍 NAV __NEXT_DATA__: Full address = "${navFullAddress}"`);
              }
            }

            // Extract company from __NEXT_DATA__ (backup)
            const employerName = adData.employer?.name || adData.businessName;
            if (employerName) {
              navCompany = employerName;
              console.log(`🏢 NAV __NEXT_DATA__: Employer = "${navCompany}"`);
            }

            // Check for external application URL in __NEXT_DATA__
            if (!externalApplyUrl && adData.applicationUrl) {
              const appUrl = adData.applicationUrl.replace(/\\/g, '');
              if (appUrl.includes('finn.no/job/apply')) {
                externalApplyUrl = appUrl;
                hasEnkelSoknad = true;
                applicationFormType = 'finn_easy';
                console.log(`✅ NAV __NEXT_DATA__: FINN apply URL = "${externalApplyUrl}"`);
              } else if (isExternalApplyUrl(appUrl)) {
                externalApplyUrl = appUrl;
                applicationFormType = 'external_form';
                console.log(`🔗 NAV __NEXT_DATA__: External apply URL = "${externalApplyUrl}"`);
              } else {
                console.log(`⚠️ NAV __NEXT_DATA__: Rejected intermediate URL: ${appUrl}`);
              }
            }
          }
        } catch (e) {
          console.log(`⚠️ NAV: Could not parse __NEXT_DATA__: ${e}`);
        }
      }
    }

    // FIRST: Check for "Søk her" / "Gå til søknad" button (external apply) - this takes priority!
    const sokHerSelectors = [
      'a:contains("Gå til søknad")',
      'a:contains("Søk her")',
      'a:contains("Søk på stillingen")',
      'a:contains("Søk på jobben")',
      'button:contains("Gå til søknad")',
      'button:contains("Søk her")',
    ];

    for (const selector of sokHerSelectors) {
      try {
        const el = $(selector).first();
        if (el.length > 0) {
          const href = el.attr('href');
          const text = el.text().trim();
          console.log(`🔍 Found "Søk her" button: "${text}" with href: ${href}`);
          hasSokHerButton = true;

          // FIXED: Also capture FINN apply URLs (for cross-platform cases like NAV->FINN)
          if (href && href.startsWith('http')) {
            if (href.includes('finn.no/job/apply')) {
              // This is a FINN Easy Apply through another platform
              externalApplyUrl = href;
              hasEnkelSoknad = true;
              applicationFormType = 'finn_easy';
              console.log(`✅ Cross-platform FINN Enkel Søknad: ${externalApplyUrl}`);
            } else if (isExternalApplyUrl(href)) {
              externalApplyUrl = href;
              console.log(`🔗 External apply URL: ${externalApplyUrl}`);
            } else {
              console.log(`⚠️ Rejected intermediate URL from button: ${href}`);
            }
          }
          break;
        }
      } catch (e) {
        // Continue
      }
    }

    // PRE-CHECK: Detect external apply links inside Shadow DOM templates (invisible to cheerio)
    // FINN wraps the real apply button in <template shadowrootmode="open"> which cheerio can't see.
    // Look for known external patterns in raw HTML before falling back to "Enkel søknad" detection.
    if (!externalApplyUrl) {
      const shadowApplyMatch = html.match(/href=['"](https?:\/\/easyapply\.jobs\/[^'"]+)['"]/);
      if (!shadowApplyMatch) {
        // Also check for other known external apply patterns inside shadow DOM templates
        const templateMatch = html.match(/id=['"]job-apply-button['"][^>]*href=['"](https?:\/\/[^'"]+)['"]/);
        if (templateMatch && isExternalApplyUrl(templateMatch[1])) {
          externalApplyUrl = templateMatch[1];
          applicationFormType = 'external_form';
          console.log(`🔗 Found external apply URL inside Shadow DOM: ${externalApplyUrl}`);
        }
      } else {
        externalApplyUrl = shadowApplyMatch[1];
        applicationFormType = 'external_form';
        console.log(`🔗 Found easyapply.jobs URL inside Shadow DOM: ${externalApplyUrl}`);
      }

      // Also detect data-job-application-type="external" which means it's NOT Enkel søknad
      if (!externalApplyUrl && html.includes('data-job-application-type') && html.includes('"external"')) {
        const extBtnMatch = html.match(/href=['"](https?:\/\/[^'"]+)['"][^>]*data-job-application-type/);
        if (extBtnMatch && isExternalApplyUrl(extBtnMatch[1])) {
          externalApplyUrl = extBtnMatch[1];
          applicationFormType = 'external_form';
          console.log(`🔗 Found external apply URL from data attribute: ${externalApplyUrl}`);
        }
      }
    }

    // SECOND: Only check for "Enkel søknad" if NO "Søk her" button AND no external URL was found
    if (!hasSokHerButton && !externalApplyUrl) {
      const enkelSoknadSelectors = [
        'button:contains("Enkel søknad")',
        'a:contains("Enkel søknad")',
        'button:contains("Enkel Søknad")',
        'a:contains("Enkel Søknad")',
        '[data-testid*="easy-apply"]',
        '[data-testid*="enkel"]',
        '[class*="easy-apply"]',
        '[class*="enkel"]',
        '[class*="Enkel"]',
        'button:contains("Easy apply")',
        '.apply-button:contains("Enkel")',
        '[aria-label*="Enkel søknad"]',
        '[aria-label*="enkel søknad"]',
        'button[type="button"]:contains("Enkel")',
        'a[role="button"]:contains("Enkel")'
      ];

      for (const selector of enkelSoknadSelectors) {
        try {
          const el = $(selector).first();
          if (el.length > 0) {
            const text = el.text().trim();
            console.log(`✅ Found "Enkel søknad" button: "${text}" with selector: ${selector}`);
            hasEnkelSoknad = true;
            break;
          }
        } catch (e) {
          // Continue
        }
      }

      // Check raw HTML with multiple patterns if no button found
      if (!hasEnkelSoknad) {
        const htmlLower = html.toLowerCase();
        // Multiple patterns to catch different HTML structures
        const patterns = [
          />enkel\s*søknad</i,
          /"enkel\s*søknad"/i,
          /'enkel\s*søknad'/i,
          /enkel\s*søknad/i,
          /button[^>]*>.*enkel\s*søknad/i,
          /<a[^>]*>.*enkel\s*søknad/i
        ];
        
        for (const pattern of patterns) {
          if (pattern.test(html)) {
            hasEnkelSoknad = true;
            console.log(`✅ Found "Enkel søknad" in HTML with pattern: ${pattern}`);
            break;
          }
        }
      }

      // FINN-specific fallback: If no external button found and this is a FINN job,
      // check if there's an apply section without external links - likely Enkel søknad
      if (!hasEnkelSoknad && url.includes('finn.no') && !hasSokHerButton) {
        // Look for apply-related sections that don't have external links
        const applySections = $('[class*="apply"], [class*="søknad"], [id*="apply"]');
        let hasExternalLink = false;
        
        applySections.each((_, section) => {
          const links = $(section).find('a[href^="http"]');
          links.each((_, link) => {
            const href = $(link).attr('href') || '';
            if (isExternalApplyUrl(href)) {
              hasExternalLink = true;
              return false; // break
            }
          });
          if (hasExternalLink) return false; // break
        });

        // If we found apply sections but no external links, likely Enkel søknad
        if (applySections.length > 0 && !hasExternalLink) {
          hasEnkelSoknad = true;
          console.log('✅ FINN fallback: Found apply section without external links - likely Enkel søknad');
        }
      }
    }

    console.log(`📋 Søk her button: ${hasSokHerButton}, Enkel søknad: ${hasEnkelSoknad}`);

    // 2.5. Extract deadline (søknadsfrist)
    // For NAV pages, prioritize deadline from __NEXT_DATA__ (more reliable than HTML scraping)
    let deadline: string | null = null;
    if (navDeadline) {
      deadline = navDeadline;
      console.log(`📅 Deadline from NAV __NEXT_DATA__: ${deadline}`);
    } else {
      deadline = extractDeadline($, html);
      console.log(`📅 Deadline from HTML: ${deadline || 'not found'}`);
    }

    // 2.6. Extract company name (will be used if current company is "Unknown Company")
    // For NAV pages, prioritize company from __NEXT_DATA__
    let extractedCompany: string | null = null;
    if (navCompany) {
      extractedCompany = navCompany;
      console.log(`🏢 Company from NAV __NEXT_DATA__: ${extractedCompany}`);
    } else {
      extractedCompany = extractCompanyName($, html, url);
      console.log(`🏢 Company from HTML: ${extractedCompany || 'not found'}`);
    }

    // 2.7. Extract title from job page (more accurate than search results)
    let extractedTitle: string | null = null;
    extractedTitle = extractTitle($, html, url);
    console.log(`📝 Title from HTML: ${extractedTitle || 'not found'}`);

    // 2.8. Extract location from job page
    // For NAV pages, prioritize location from __NEXT_DATA__
    let extractedLocation: string | null = null;
    if (navFullAddress) {
      extractedLocation = navFullAddress;
      console.log(`📍 Location from NAV __NEXT_DATA__: ${extractedLocation}`);
    } else {
      extractedLocation = extractLocation($, html, url);
      console.log(`📍 Location from HTML: ${extractedLocation || 'not found'}`);
    }

    // 2.9. Extract contact information
    const contactInfo = extractContactInfo($, html);
    console.log(`👤 Contact: name=${contactInfo.name || 'none'}, phone=${contactInfo.phone || 'none'}, email=${contactInfo.email || 'none'}`);

    // 3. Determine application form type
    if (hasEnkelSoknad) {
      applicationFormType = 'finn_easy';
      console.log('📝 Application type: FINN Easy Apply');
      
      // For FINN Easy Apply, construct and set the apply URL
      if (url.includes('finn.no')) {
        const finnkode = extractFinnkode(url);
        if (finnkode) {
          externalApplyUrl = `https://www.finn.no/job/apply/${finnkode}`;
          console.log(`🔗 Constructed FINN apply URL: ${externalApplyUrl}`);
        } else {
          console.log(`⚠️ Could not extract finnkode from URL: ${url}`);
        }
      }
    } else {
      // FINN.no specific: Look for "Søk her" or "Søk på stillingen" buttons
      // These buttons typically have external URLs

      // First, try to find FINN-specific apply button selectors
      const finnApplySelectors = [
        'a:contains("Søk her")',
        'a:contains("Søk på stillingen")',
        'a:contains("Søk på jobben")',
        'button:contains("Søk her")',
        '[data-testid*="apply"] a',
        '[class*="apply"] a',
        '.job-apply a',
        'a[href*="webcruiter"]',
        'a[href*="jobylon"]',
        'a[href*="teamtailor"]',
        'a[href*="recman"]',
        'a[href*="cvpartner"]'
      ];

      // Try FINN-specific selectors first
      for (const selector of finnApplySelectors) {
        try {
          const el = $(selector).first();
          if (el.length > 0) {
            const href = el.attr('href');
            const text = el.text().trim();
            console.log(`🔍 Found apply element: "${text}" with href: ${href}`);

            if (href && isExternalApplyUrl(href)) {
              externalApplyUrl = href;
              console.log(`🔗 Found external apply URL from FINN button: ${externalApplyUrl}`);
              break;
            }
          }
        } catch (e) {
          // Continue
        }
      }

      // If still not found, scan ALL links for external recruitment sites
      if (!externalApplyUrl) {
        const knownRecruitmentDomains = [
          'webcruiter', 'jobylon', 'teamtailor', 'recman', 'cvpartner',
          'easycruit', 'varbi', 'greenhouse', 'lever', 'workday',
          'smartrecruiters', 'talentech', 'csod', 'cornerstone'
        ];

        $('a[href]').each((_, el) => {
          const href = $(el).attr('href') || '';
          const isRecruitmentSite = knownRecruitmentDomains.some(domain =>
            href.toLowerCase().includes(domain)
          );

          if (isExternalApplyUrl(href) && isRecruitmentSite) {
            externalApplyUrl = href;
            console.log(`🔗 Found recruitment site URL: ${externalApplyUrl}`);
            return false; // break
          }
        });
      }

      // Fallback: look for any external link in apply-related sections
      if (!externalApplyUrl) {
        $('a, button').each((_, el) => {
          const href = $(el).attr('href') || '';
          const onclick = $(el).attr('onclick') || '';
          const text = $(el).text().toLowerCase();

          // Check if this looks like an apply button
          const isApplyButton = text.includes('søk') || text.includes('apply') ||
                               text.includes('send') || text.includes('registrer');

          if (isApplyButton) {
            // Try to extract URL from href or onclick
            if (isExternalApplyUrl(href)) {
              externalApplyUrl = href;
              console.log(`🔗 Found apply URL from button text: ${externalApplyUrl}`);
              return false;
            }

            const urlMatch = onclick.match(/https?:\/\/[^\s'"]+/);
            if (urlMatch && !urlMatch[0].includes('finn.no')) {
              externalApplyUrl = urlMatch[0];
              console.log(`🔗 Found apply URL from onclick: ${externalApplyUrl}`);
              return false;
            }
          }
        });
      }

      if (externalApplyUrl) {
        const domain = extractDomain(externalApplyUrl);
        console.log(`🏢 External domain: ${domain}`);

        // Check if domain is in our known agencies database
        const { data: knownAgency } = await supabase
          .from('recruitment_agencies')
          .select('form_type, name')
          .eq('domain', domain)
          .single();

        if (knownAgency) {
          console.log(`✅ Found known agency: ${knownAgency.name} (${knownAgency.form_type})`);
          applicationFormType = knownAgency.form_type === 'registration' ? 'external_registration' : 'external_form';
        } else {
          // Unknown agency - scrape external page to detect form type
          console.log(`🔍 Unknown agency, scanning external page...`);

          try {
            const extResponse = await fetch(externalApplyUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              },
              redirect: 'follow'
            });

            if (extResponse.ok) {
              const extHtml = await extResponse.text();
              const $ext = cheerio.load(extHtml);
              const detectedType = detectFormType(extHtml, $ext);

              console.log(`🎯 Detected form type: ${detectedType}`);

              // Save new agency to database for future reference
              if (detectedType !== 'unknown') {
                await supabase
                  .from('recruitment_agencies')
                  .upsert({
                    domain: domain,
                    form_type: detectedType,
                    detection_method: 'auto',
                    sample_urls: [externalApplyUrl],
                    updated_at: new Date().toISOString()
                  }, { onConflict: 'domain' });

                console.log(`💾 Saved new agency: ${domain} (${detectedType})`);
              }

              applicationFormType = detectedType === 'registration' ? 'external_registration' :
                                   detectedType === 'form' ? 'external_form' : 'unknown';
            }
          } catch (extError) {
            console.error('Error fetching external page:', extError);
            applicationFormType = 'unknown';
          }
        }
      } else {
        console.log('⚠️ No external apply URL found');
        applicationFormType = 'unknown';
      }
    }

    // 4. Extract Text based on domain
    let text = "";

    if (url.includes('finn.no')) {
       const selectors = [
         'div[data-testid="job-description-text"]',
         '.import_decoration',
         'section[aria-label="Jobbbeskrivelse"]'
       ];

       for (const selector of selectors) {
         const content = $(selector).text();
         if (content && content.length > 100) {
           text = content;
           break;
         }
       }

       if (!text) {
          text = $('main p').map((_, el) => $(el).text()).get().join('\n\n');
       }

    } else if (url.includes('nav.no')) {
       text = $('.job-posting-text').text()
           || $('section.description').text()
           || $('div[data-testid="description"]').text()
           || $('section[aria-label="Stillingstekst"]').text();

       if (!text || text.length < 50) {
           text = $('.JobPosting__Description').text();
       }
    }

    // Clean up text
    text = text.replace(/\s\s+/g, ' ').trim();

    // Generic Fallback
    if (!text || text.length < 50) {
         text = $('main').text() || $('article').text() || $('body').text();
         if (text.length > 10000) text = text.substring(0, 10000);
    }

    if (!text) {
       text = "Could not extract text automatically. Please visit the link.";
    }

    // 5. Save to Database (if job_id provided)
    if (job_id) {
      // Fetch current job data to compare quality scores
      const { data: currentJob } = await supabase
        .from('jobs')
        .select('company, title, location')
        .eq('id', job_id)
        .single();

      // Determine what needs updating using quality scoring
      let shouldUpdateCompany = false;
      let shouldUpdateTitle = false;
      let shouldUpdateLocation = false;

      // Company: update if new is better quality
      if (extractedCompany && currentJob) {
        const currentScore = scoreCompanyName(currentJob.company);
        const newScore = scoreCompanyName(extractedCompany);
        if (newScore > currentScore) {
          shouldUpdateCompany = true;
          console.log(`🏢 Better company: "${currentJob.company}" (${currentScore}) → "${extractedCompany}" (${newScore})`);
        } else {
          console.log(`🏢 Keeping company: "${currentJob.company}" (${currentScore}) ≥ new "${extractedCompany}" (${newScore})`);
        }
      }

      // Title: update if new is better quality
      if (extractedTitle && currentJob) {
        const currentScore = scoreTitle(currentJob.title);
        const newScore = scoreTitle(extractedTitle);
        if (newScore > currentScore) {
          shouldUpdateTitle = true;
          console.log(`📝 Better title: "${currentJob.title}" (${currentScore}) → "${extractedTitle}" (${newScore})`);
        } else {
          console.log(`📝 Keeping title: "${currentJob.title}" (${currentScore}) ≥ new "${extractedTitle}" (${newScore})`);
        }
      }

      // Location: update if new is more specific
      if (extractedLocation && currentJob) {
        const currentScore = scoreLocation(currentJob.location);
        const newScore = scoreLocation(extractedLocation);
        if (newScore > currentScore) {
          shouldUpdateLocation = true;
          console.log(`📍 Better location: "${currentJob.location}" (${currentScore}) → "${extractedLocation}" (${newScore})`);
        } else {
          console.log(`📍 Keeping location: "${currentJob.location}" (${currentScore}) ≥ new "${extractedLocation}" (${newScore})`);
        }
      }

      const updateData: any = {
        has_enkel_soknad: hasEnkelSoknad,
        application_form_type: applicationFormType
      };

      if (text.length > 50) {
        updateData.description = text;
      }

      // Update company if new is better
      if (shouldUpdateCompany && extractedCompany) {
        updateData.company = extractedCompany;
      }

      // Update title if new is better
      if (shouldUpdateTitle && extractedTitle) {
        updateData.title = extractedTitle;
      }

      // Update location if new is better
      if (shouldUpdateLocation && extractedLocation) {
        updateData.location = extractedLocation;
      }

      // Always set external_apply_url if we have one (especially for FINN Easy Apply)
      // This ensures the URL is saved even if it was constructed from finnkode
      if (externalApplyUrl) {
        updateData.external_apply_url = externalApplyUrl;
        console.log(`💾 Saving external_apply_url: ${externalApplyUrl}`);
      } else if (hasEnkelSoknad && applicationFormType === 'finn_easy') {
        // For FINN Easy Apply, if we couldn't extract finnkode here,
        // it will be constructed later by finn-apply or auto_apply.py
        // But we should still mark it as finn_easy
        console.log(`⚠️ FINN Easy Apply detected but no URL constructed (will be built from job_url later)`);
      }

      if (deadline) {
        updateData.deadline = deadline;
      }

      await supabase
        .from('jobs')
        .update(updateData)
        .eq('id', job_id);

      // Log summary of updates
      const updates: string[] = [];
      if (shouldUpdateCompany) updates.push(`company="${extractedCompany}"`);
      if (shouldUpdateTitle) updates.push(`title="${extractedTitle?.substring(0, 30)}..."`);
      if (shouldUpdateLocation) updates.push(`location="${extractedLocation}"`);
      if (externalApplyUrl) updates.push('url=set');

      console.log(`✅ Updated job ${job_id}: type=${applicationFormType}, enkel=${hasEnkelSoknad}${updates.length > 0 ? ', ' + updates.join(', ') : ''}`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        text,
        has_enkel_soknad: hasEnkelSoknad,
        application_form_type: applicationFormType,
        external_apply_url: externalApplyUrl,
        deadline: deadline,
        company: extractedCompany,
        title: extractedTitle,
        location: extractedLocation,
        contact: contactInfo
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    );
  }
});
