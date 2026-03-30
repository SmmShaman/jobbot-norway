"""
navigation_goals.py - Site-specific Skyvern navigation goal templates

This module contains navigation goal templates for different recruitment platforms.
Each template is tailored to the specific UI and flow of the platform.

Usage:
    from navigation_goals import get_navigation_goal

    goal = get_navigation_goal(
        domain="webcruiter.no",
        action="apply",
        profile_data={...},
        credentials={...}
    )
"""

from typing import Optional


# ============================================
# MASTER SKILL — Universal Norwegian form knowledge
# Injected into EVERY first-time form encounter
# ============================================

MASTER_SKILL = """
--- MASTER SKILL: Norwegian Recruitment Form Navigator ---

KNOWN PLATFORMS: Webcruiter, Easycruit, Teamtailor, Jobylon, Recman, FINN, JobbNorge,
SuccessFactors (SAP), CSOD (Cornerstone), Workday (myworkdayjobs.com), NUU, LinkedIn.

PLATFORM IDENTIFICATION RULES:
- ALWAYS identify the platform BEFORE filling. Check URL domain, page title, footer, login form.
- If platform is KNOWN — follow its specific patterns from memory.
- If platform is NEW/UNKNOWN — treat carefully: examine the form structure first,
  identify field types (text vs dropdown vs autocomplete vs select), note multi-step vs single-page.
- AFTER every attempt (success or failure) — save what you learned:
  what worked, what failed, field types, navigation flow, special elements.
- These learnings are stored as SKILLS and injected into future attempts on the same platform.
- Each new platform encounter adds to the knowledge base for ALL future users.

UNIVERSAL APPROACH FOR ANY NORWEGIAN RECRUITMENT FORM:

1. COOKIE CONSENT: Click "Godta alle", "Aksepter alle", "Godkjenn alle", "Accept Cookies", or "OK".

2. LOGIN vs REGISTER: If both exist — ALWAYS use Login first. If "email already registered" — use Login tab.
   Easycruit may ask to CREATE a password for candidate portal — fill it.

3. PRIVACY: Look for "Personvern" checkbox → check it → click "Neste" (Next).

4. FORM FIELDS (Norwegian labels):
   - Fornavn (first name), Etternavn (last name), E-post (email), Telefon (phone)
   - Adresse, Postnummer (postal code), Sted/By (city), Land (country = Norge)
   - Fødselsdato: 3 dropdowns (day, month, year)
   - Kjønn: radio buttons (Mann/Kvinne/Annet)
   - Fylke (county), Kommune (municipality): dropdowns
   - Søknadstekst / Motivasjon / Søknadsbrev: textarea for cover letter
   - Utdanning (education), Arbeidserfaring (work experience): click "Legg til" (Add) to create entries
   - Språk (languages): Norsk + Engelsk proficiency
   - Medie/nettsted (where found job): select "Finn.no" or any option

5. CRITICAL PITFALLS:
   - Dropdowns that RESET: after selecting value, CLICK OUTSIDE dropdown before clicking Submit
   - AUTOCOMPLETE DROPDOWNS (Workday, SuccessFactors): These LOOK like text fields but are actually
     dropdowns. After typing text, a SUGGESTION LIST appears. You MUST CLICK on a suggestion from
     the list. Just typing text and clicking Next will NOT work — the field resets.
     Pattern: input_text → wait 1 sec → click on first suggestion in dropdown list → then Next.
     If stuck on same field 3x with input_text → try select_option or click on visible option.
   - Rich text editors: CLICK inside iframe/contenteditable first, then type
   - Slider/range inputs: use click + input_text, NEVER drag
   - Multi-step forms: click "Lagre / Neste" to proceed. If stuck 3x on same page — look for validation errors (red borders)
   - Required sections (Utdanning, Arbeidserfaring): MUST add at least one entry before Submit
   - File upload: use upload_file on input[type=file]. If fails 2x — skip and continue

6. SUBMIT: Click "Send søknad", "Søk", "Submit", "Fullfør". Wait for confirmation page.

7. STOP IF: CAPTCHA, 404/500 error, no form visible, login failed 3x, position closed.
--- END MASTER SKILL ---
"""


# ============================================
# SITE DETECTION
# ============================================

def detect_site_type(domain: str) -> str:
    """Detect the type of recruitment site based on domain."""
    domain = domain.lower()

    # Known platforms - use specific domain patterns to avoid false positives
    # Order matters: more specific patterns first
    if 'webcruiter.no' in domain or 'webcruiter.com' in domain:
        return 'webcruiter'
    elif 'easycruit.com' in domain:
        return 'easycruit'
    elif 'jobylon.com' in domain:
        return 'jobylon'
    elif 'teamtailor.com' in domain:
        return 'teamtailor'
    elif 'lever.co' in domain or domain.startswith('jobs.lever.'):
        return 'lever'
    elif 'recman.no' in domain or 'recman.page' in domain:
        return 'recman'
    elif 'cvpartner.com' in domain:
        return 'cvpartner'
    elif 'reachmee.com' in domain:
        return 'reachmee'
    elif 'varbi.com' in domain:
        return 'varbi'
    elif 'hrmanager.no' in domain:
        return 'hrmanager'
    elif 'finn.no' in domain:
        return 'finn'
    elif 'nav.no' in domain or 'arbeidsplassen' in domain:
        return 'nav'
    elif 'adecco.com' in domain or 'adecco.no' in domain:
        return 'adecco'
    elif 'jobbnorge.no' in domain:
        return 'jobbnorge'
    elif 'myworkdayjobs.com' in domain or 'workday.com' in domain or 'wd3.' in domain or 'wd5.' in domain:
        return 'workday'
    elif 'easyapply.jobs' in domain:
        return 'easyapply'
    elif 'csod.com' in domain:
        return 'csod'
    elif 'successfactors' in domain or domain.endswith('.jobs'):
        return 'successfactors'
    else:
        return 'generic'


# ============================================
# REGISTRATION GOALS
# ============================================

def get_registration_goal(domain: str, profile_data: dict, email: str, password: str) -> str:
    """Get site-specific registration navigation goal."""
    site_type = detect_site_type(domain)

    if site_type == 'webcruiter':
        return _webcruiter_registration(profile_data, email, password)
    elif site_type == 'easycruit':
        return _easycruit_registration(profile_data, email, password)
    elif site_type == 'jobylon':
        return _jobylon_registration(profile_data, email, password)
    elif site_type == 'teamtailor':
        return _teamtailor_registration(profile_data, email, password)
    elif site_type == 'recman':
        return _recman_registration(profile_data, email, password)
    elif site_type == 'reachmee':
        return _reachmee_registration(profile_data, email, password)
    elif site_type == 'successfactors':
        return _successfactors_registration(profile_data, email, password)
    else:
        return _generic_registration(profile_data, email, password)


def _webcruiter_registration(profile_data: dict, email: str, password: str) -> str:
    return f"""
GOAL: Register for a new account on Webcruiter recruitment platform.

IMPORTANT RULES:
1. Fill ONLY fields that have data provided. DO NOT guess or make up information.
2. If a required field has no data, STOP and report it.
3. Phone numbers should include country code (+47 for Norway).

REGISTRATION DATA:
- Email: {email}
- Password: {password}
- First Name: {profile_data.get('first_name', '')}
- Last Name: {profile_data.get('last_name', '')}
- Phone: {profile_data.get('phone', '')}

PHASE 1: COOKIE HANDLING
1. If cookie popup appears, click "Godta alle" or "Aksepter".

PHASE 2: FIND REGISTRATION
2. Look for "Opprett bruker", "Ny bruker", or "Registrer deg som arbeidssøker".
3. If on login page, look for "Registrer deg" or "Opprett konto" link.
4. Click to go to registration form.

PHASE 3: FILL REGISTRATION FORM
5. Enter email address: {email}
6. Enter password: {password}
7. Confirm password if there's a second field: {password}
8. Enter first name (Fornavn): {profile_data.get('first_name', '')}
9. Enter last name (Etternavn): {profile_data.get('last_name', '')}
10. Enter phone number (Telefon): {profile_data.get('phone', '')} (with +47 if needed)

PHASE 4: ACCEPT TERMS
11. Check the terms and conditions checkbox.
12. Check GDPR/privacy checkbox if present.

PHASE 5: SUBMIT
13. Click "Registrer", "Opprett bruker", or similar button.
14. Wait for confirmation or verification message.

VERIFICATION CHECK:
15. Check if email verification is required.
16. Report any verification requirements.

REPORT:
- registration_successful: true if account created
- needs_email_verification: true if verification email sent
- filled_fields: {{}} with all fields that were filled
- missing_fields: [] with any required fields that couldn't be filled
"""


def _easycruit_registration(profile_data: dict, email: str, password: str) -> str:
    return f"""
GOAL: Register for a new account on Easycruit recruitment platform.

REGISTRATION DATA:
- Email: {email}
- Password: {password}
- Full Name: {profile_data.get('full_name', '')}
- Phone: {profile_data.get('phone', '')}

PHASE 1: COOKIE HANDLING
1. If cookie popup appears, click "Accept", "Godta alle", or close button.

PHASE 2: FIND REGISTRATION
2. Look for "Create profile", "Opprett profil", "Register", or "Sign up".
3. May redirect to company-specific subdomain - that's expected.
4. Click registration link/button.

PHASE 3: FILL FORM
5. Enter email: {email}
6. Enter password: {password}
7. Confirm password: {password}
8. Enter name: {profile_data.get('full_name', '')}
9. Enter phone: {profile_data.get('phone', '')}
10. Select country "Norge" or "Norway" if dropdown present.

PHASE 4: SUBMIT
11. Accept terms checkbox.
12. Click submit button.
13. Check for verification requirements.

REPORT all results including verification needs.
"""


def _jobylon_registration(profile_data: dict, email: str, password: str) -> str:
    return f"""
GOAL: Register on Jobylon recruitment platform.

REGISTRATION DATA:
- Email: {email}
- Password: {password}
- Name: {profile_data.get('full_name', '')}
- Phone: {profile_data.get('phone', '')}

PHASE 1: COOKIE HANDLING
1. Accept cookies if popup appears.

PHASE 2: FIND REGISTRATION
2. Look for "Sign up" button (usually in top navigation).
3. Ignore social login options (LinkedIn, Google) - use email registration.
4. Click email registration option.

PHASE 3: FILL FORM
5. Jobylon typically has a single-page form:
   - Email: {email}
   - Password: {password}
   - Name: {profile_data.get('full_name', '')}
6. Fill available fields.

PHASE 4: SUBMIT
7. Click "Create account" or "Sign up".
8. Wait for confirmation.

NOTE: Jobylon has modern UI - buttons are usually clearly visible.
"""


def _teamtailor_registration(profile_data: dict, email: str, password: str) -> str:
    return f"""
GOAL: Register on Teamtailor candidate portal.

REGISTRATION DATA:
- Email: {email}
- Password: {password}
- Name: {profile_data.get('full_name', '')}

PHASE 1: COOKIE HANDLING
1. Accept cookies.

PHASE 2: FIND REGISTRATION
2. Look for "Create account" in top navigation or login area.
3. Skip LinkedIn import option - use manual entry.
4. Click to go to registration form.

PHASE 3: FILL FORM
5. Enter email: {email}
6. Enter password: {password}
7. Enter name if field exists.

PHASE 4: SUBMIT
8. Accept terms.
9. Submit registration.
10. Check for email verification.
"""


def _recman_registration(profile_data: dict, email: str, password: str) -> str:
    return f"""
GOAL: Register on Recman recruitment platform.

NOTE: Recman is a Norwegian system, use Norwegian terms.

REGISTRATION DATA:
- Email: {email}
- Password: {password}
- Full Name: {profile_data.get('full_name', '')}
- First Name: {profile_data.get('first_name', '')}
- Last Name: {profile_data.get('last_name', '')}
- Phone: {profile_data.get('phone', '')}

PHASE 1: COOKIE HANDLING
1. Click "Godta" or "Aksepter" on cookie popup.

PHASE 2: FIND REGISTRATION
2. Look for "Registrer deg", "Opprett bruker", or "Bli kandidat".
3. Click registration link.

PHASE 3: FILL FORM
4. Recman often has multi-step registration:
   Step 1: Email and password
   Step 2: Personal info (name, phone)
   Step 3: CV upload (optional)

5. Fill each step:
   - Email: {email}
   - Password: {password}
   - First name: {profile_data.get('first_name', '')}
   - Last name: {profile_data.get('last_name', '')}
   - Phone: {profile_data.get('phone', '')}

PHASE 4: COMPLETE
6. Skip optional steps like CV upload for now.
7. Click "Fullfør" or "Registrer".
8. Check for email verification.
"""


def _reachmee_registration(profile_data: dict, email: str, password: str) -> str:
    return f"""
GOAL: Register on ReachMee recruitment platform.

REGISTRATION DATA:
- Email: {email}
- Password: {password}
- Name: {profile_data.get('full_name', '')}
- Phone: {profile_data.get('phone', '')}

PHASE 1: COOKIE HANDLING
1. Accept cookies.

PHASE 2: FIND REGISTRATION
2. Look for "Create account", "Register", or "Sign up".
3. May be on attract.reachmee.com subdomain.
4. Click registration option.

PHASE 3: FILL FORM
5. Enter email: {email}
6. Enter password: {password}
7. Enter name: {profile_data.get('full_name', '')}
8. Enter phone if field exists.

PHASE 4: SUBMIT
9. Accept terms.
10. Submit registration.
"""


def _successfactors_registration(profile_data: dict, email: str, password: str) -> str:
    return f"""
GOAL: Register / Create Talent Profile on SAP SuccessFactors career portal.

REGISTRATION DATA:
- Email: {email}
- Password: {password}
- Name: {profile_data.get('full_name', '')}
- Phone: {profile_data.get('phone', '')}

PHASE 1: COOKIE HANDLING
1. Click "Accept All Cookies" / "Godta alle" if cookie banner appears.
2. Close any popups.

PHASE 2: FIND REGISTRATION
3. Look for "Create Profile" / "Register" / "Sign Up" / "Opprett profil" link.
4. If on a login page, look for "New user?" / "Create account" / "Register here" link.
5. Click to open registration form.

PHASE 3: FILL REGISTRATION FORM
6. SuccessFactors Talent Profile registration typically requires:
   - Email: {email}
   - Password: {password} (must meet complexity requirements)
   - Confirm Password: {password}
   - First Name: {profile_data.get('full_name', '').split()[0] if profile_data.get('full_name') else ''}
   - Last Name: {' '.join(profile_data.get('full_name', '').split()[1:]) if profile_data.get('full_name') else ''}
7. Fill all required fields (marked with *).
8. If country/region dropdown exists, select "Norway" / "Norge".

PHASE 4: SUBMIT
9. Check any required checkboxes (privacy, terms).
10. Click "Create" / "Register" / "Submit" / "Opprett".
11. Wait for confirmation or redirect.
12. If email verification is required, report this - do not wait.

NOTE: Do NOT click "Apply with LinkedIn" — use the manual registration form.
"""


def _generic_registration(profile_data: dict, email: str, password: str) -> str:
    return f"""
GOAL: Register for a new account on this recruitment website.

IMPORTANT: This is a generic registration flow. Adapt to what you see on the page.

REGISTRATION DATA:
- Email: {email}
- Password: {password}
- Full Name: {profile_data.get('full_name', '')}
- First Name: {profile_data.get('first_name', '')}
- Last Name: {profile_data.get('last_name', '')}
- Phone: {profile_data.get('phone', '')}
- Country: {profile_data.get('country', 'Norge')}

PHASE 1: COOKIE HANDLING
1. Accept any cookie popups: "Godta alle", "Accept all", "OK", "I agree".

PHASE 2: FIND REGISTRATION
2. Common registration links:
   - "Register", "Sign up", "Create account"
   - "Registrer deg", "Opprett konto", "Ny bruker"
3. If on login page, look for registration link below login form.
4. Click to go to registration.

PHASE 3: FILL FORM
5. Fill available fields with provided data:
   - Email field: {email}
   - Password field: {password}
   - Confirm password: {password}
   - Name fields: Use full_name or first_name/last_name
   - Phone: {profile_data.get('phone', '')}
   - Country dropdown: Select "Norge" or "Norway"

PHASE 4: TERMS & SUBMIT
6. Check required checkboxes (terms, GDPR).
7. Click submit button.
8. Wait for result.

PHASE 5: VERIFICATION CHECK
9. Check if page shows:
   - "Verification email sent" → needs_email_verification = true
   - "Confirm your phone" → needs_sms_verification = true
   - "Registration complete" → registration_successful = true

REPORT all fields that were filled and any that couldn't be filled.
"""


# ============================================
# APPLICATION GOALS
# ============================================

def get_application_goal(
    domain: str,
    profile_data: dict,
    cover_letter: str,
    credentials: Optional[dict] = None,
    resume_url: Optional[str] = None
) -> str:
    """Get site-specific application navigation goal."""
    site_type = detect_site_type(domain)

    if site_type == 'webcruiter':
        return _webcruiter_application(profile_data, cover_letter, credentials, resume_url)
    elif site_type == 'easycruit':
        return _easycruit_application(profile_data, cover_letter, credentials, resume_url)
    elif site_type == 'jobylon':
        return _jobylon_application(profile_data, cover_letter, credentials, resume_url)
    elif site_type == 'finn':
        return _finn_application(profile_data, cover_letter, credentials)
    elif site_type == 'jobbnorge':
        return _jobbnorge_application(profile_data, cover_letter, credentials, resume_url)
    elif site_type == 'workday':
        return _workday_application(profile_data, cover_letter, credentials, resume_url)
    elif site_type == 'successfactors':
        return _successfactors_application(profile_data, cover_letter, credentials, resume_url)
    else:
        return _generic_application(profile_data, cover_letter, credentials, resume_url)


def _webcruiter_application(
    profile_data: dict,
    cover_letter: str,
    credentials: Optional[dict],
    resume_url: Optional[str]
) -> str:
    login_phase = ""
    if credentials:
        login_phase = f"""
PHASE 2: LOGIN
3. Look for "Logg inn" button/link.
4. Enter email: {credentials.get('email', '')}
5. Enter password from payload.
6. Click "Logg inn".
7. Wait for login to complete.
"""
    else:
        login_phase = """
PHASE 2: CONTINUE WITHOUT LOGIN (if possible)
3. If login is required, report requires_registration = true.
4. Otherwise, continue to application form.
"""

    extra_fields = ""
    if profile_data.get('birth_date'):
        extra_fields += f"\n- Birth Date / Fødselsdato: {profile_data['birth_date']}"
    if profile_data.get('street'):
        extra_fields += f"\n- Address / Adresse: {profile_data['street']}, {profile_data.get('postal_code', '')} {profile_data.get('city', '')}"
    if profile_data.get('nationality'):
        extra_fields += f"\n- Nationality: {profile_data['nationality']}"

    return f"""
GOAL: Submit job application on Webcruiter.

LOADING OVERLAY HANDLING (applies to ALL phases):
IMPORTANT: Webcruiter pages often show a loading overlay ("Siden laster...", "Loading...", a spinner,
or a semi-transparent overlay covering the page). If you see such an overlay:
1. Do NOT try to click through it or interact with elements behind it.
2. WAIT 5 seconds, then check if the page has finished loading.
3. If still loading after 3 waits (15 seconds total), try scrolling down or clicking
   on an empty area of the page body to dismiss the overlay.
4. Only proceed with form interaction once the overlay is gone.

APPLICATION DATA:
- Name: {profile_data.get('full_name', '')}
- Email: {profile_data.get('email', '')}
- Phone: {profile_data.get('phone', '')}{extra_fields}
- Cover Letter: (in payload)
- Resume URL: {resume_url or 'Not provided'}

PHASE 1: COOKIE HANDLING
1. Click "Godta alle" if cookie popup appears.
2. Close any modals.

{login_phase}

PHASE 3: FIND APPLICATION FORM
8. Look for "Søk på stillingen", "Apply", or "Send søknad" button.
9. Click to open application form.

PHASE 4: FILL APPLICATION
10. Fill form fields using APPLICATION DATA and navigation_payload:
    - Name/Navn: {profile_data.get('full_name', '')}
    - Email/E-post: {profile_data.get('email', '')}
    - Phone/Telefon: {profile_data.get('phone', '')}
    - Birth date/Fødselsdato: Use birth_date from data if field exists
    - Address fields: Use street, postal_code, city from data
    - Cover Letter/Søknadstekst: Use 'cover_letter' from navigation_payload.
      CRITICAL: This is a RICH TEXT EDITOR (TinyMCE/CKEditor), NOT a regular input field.
      Do NOT try to use input_text on <span> elements — it WILL fail.

      Step A: CLICK on the white text editing area below the formatting toolbar (bold/italic/underline buttons).
              This may be inside an <iframe> — if so, click inside the iframe body.
              Or it may be a <div contenteditable="true"> — click on it.
              Wait for a blinking cursor to appear.

      Step B: After clicking and seeing the cursor, type the cover letter text.
              If input_text fails on the clicked element, try using the element
              WITHOUT specifying element_id to type into the currently focused area.

      If the cover letter field cannot be filled after 2 attempts, SKIP IT
      and continue with the rest of the form. Do not retry more than twice.
    - Any other field: Check navigation_payload for matching data
    - SLIDER / RANGE INPUTS (input type="range"): Do NOT drag. CLICK the input, then use input_text
      to type the numeric value. If that fails, click at approximate position on slider track.
      After 2 failed attempts, SKIP the slider and continue.
    - Work experience dates (Fra/Til / From/To):
      IMPORTANT: If a work experience "Til" (To) date field is empty in the payload
      or endDate is empty, this means CURRENT POSITION.
      Look for a checkbox like "Nåværende stilling" / "Nåværende" / "Current position"
      and CHECK IT instead of filling a date. Do NOT type "Nåværende" as text in a date field —
      it will cause a validation error.
      If no such checkbox exists, leave the "Til" date field EMPTY.
11. Upload CV/Resume if file upload field exists and resume_url provided:
    IMPORTANT: Do NOT get stuck on CV upload. If it fails twice, move on to the next section.
    Webcruiter CV sections are often COLLAPSED by default and use custom upload widgets.

    Step A: Look for a "CV" or "Dokumenter" section header. If collapsed, CLICK to expand it.

    Step B: Try to find and click an upload button:
       - Look for "Last opp fil" / "Velg fil" / "Upload" / "Last opp" button
       - Click it.

    Step C: If that opens a file chooser dialog, use upload_file with resume_url from navigation_payload.

    Step D: If upload_file fails with "No file chooser dialog":
       - Look for ANY <input type="file"> element on the page, including HIDDEN ones.
         These are often invisible (display:none or opacity:0) but still functional.
       - Try upload_file directly on that <input type="file"> element.

    Step E: If ALL upload attempts fail after 2 tries total, SKIP the CV upload entirely
       and continue to the next section. The cover letter and other form fields are
       more important than the CV file — do NOT retry endlessly.
12. If cover letter upload field exists, paste the cover_letter text.

PHASE 5: SUBMIT
13. Check required checkboxes.
14. Click "Send søknad" or "Submit".
15. Wait for confirmation.

COVER LETTER TEXT:
{cover_letter[:500]}...
"""


def _easycruit_application(
    profile_data: dict,
    cover_letter: str,
    credentials: Optional[dict],
    resume_url: Optional[str]
) -> str:
    login_phase = ""
    if credentials:
        login_phase = f"""
PHASE 2: LOGIN
3. Find login form.
4. Enter email: {credentials.get('email', '')}
5. Enter password.
6. Submit login.
"""

    return f"""
GOAL: Submit job application on Easycruit.

APPLICATION DATA:
- Name: {profile_data.get('full_name', '')}
- Email: {profile_data.get('email', '')}
- Phone: {profile_data.get('phone', '')}

PHASE 1: COOKIE HANDLING
1. Accept cookies.

{login_phase}

PHASE 3: APPLICATION FORM
7. Easycruit forms are usually multi-step.
8. Fill each step with provided data.
9. Use cover letter from payload for motivation text.
10. Upload CV if required.

PHASE 4: SUBMIT
11. Review application.
12. Submit.

COVER LETTER:
{cover_letter[:500]}...
"""


def _jobylon_application(
    profile_data: dict,
    cover_letter: str,
    credentials: Optional[dict],
    resume_url: Optional[str]
) -> str:
    return f"""
GOAL: Submit job application on Jobylon.

APPLICATION DATA:
- Name: {profile_data.get('full_name', '')}
- Email: {profile_data.get('email', '')}
- Phone: {profile_data.get('phone', '')}

PHASE 1: COOKIES
1. Accept cookies.

PHASE 2: APPLY
2. Click "Apply" or "Søk" button.
3. Jobylon has simple forms - fill:
   - Name
   - Email
   - Phone
   - Cover letter/motivation

PHASE 3: SUBMIT
4. Upload CV if required.
5. Submit application.

COVER LETTER:
{cover_letter[:500]}...
"""


def _finn_application(
    profile_data: dict,
    cover_letter: str,
    credentials: Optional[dict]
) -> str:
    """FINN Enkel Søknad - special handling."""
    if credentials:
        return f"""
GOAL: Submit FINN Enkel Søknad application.

PHASE 1: LOGIN
1. Accept cookies (Schibsted popup).
2. Enter email: {credentials.get('email', '')}
3. Click "Neste".
4. Enter password.
5. Handle 2FA if prompted.
6. Complete login.

PHASE 2: APPLICATION
7. Fill application form:
   - Name: {profile_data.get('full_name', '')}
   - Email: {profile_data.get('email', '')}
   - Phone: {profile_data.get('phone', '')}
   - Message: (cover letter from payload)

PHASE 3: SUBMIT
8. Check GDPR checkbox.
9. Click "Send søknad".

COVER LETTER:
{cover_letter[:500]}...
"""
    else:
        return f"""
GOAL: Submit FINN Enkel Søknad application.

NOTE: FINN requires login. Credentials not provided - this will likely fail.

PHASE 1: COOKIES
1. Accept Schibsted cookie popup.

PHASE 2: LOGIN REQUIRED
2. FINN Enkel Søknad requires authentication.
3. If login form appears, report requires_registration = true.

COVER LETTER:
{cover_letter[:500]}...
"""


def _jobbnorge_application(
    profile_data: dict,
    cover_letter: str,
    credentials: Optional[dict],
    resume_url: Optional[str]
) -> str:
    login_phase = ""
    if credentials:
        login_phase = f"""
PHASE 2: LOGIN (CRITICAL - DO NOT REGISTER AGAIN)
3. JobbNorge has a LOGIN form and a REGISTER form on the same page.
   IMPORTANT: You MUST use the LOGIN form, NOT the registration form!
4. Look for "Logg inn" / "Log in" tab, button, or link. Click it.
5. If you see "E-post" and "Passord" fields in the LOGIN section:
   - Email: {credentials.get('email', '')}
   - Password: from payload (look for key 'password' in navigation_payload)
6. Click "Logg inn" / "Log in" button.
7. If login fails with "wrong password" or error page:
   - Do NOT try to register — email is already registered.
   - Do NOT retry more than 2 times.
   - If error page has no form/buttons — STOP and report login_failed = true.
8. If you see "E-postadressen er allerede registrert" — use LOGIN tab, not registration.
9. If you see an error page with no way forward — STOP immediately.
   Do NOT spend steps clicking random elements on error pages.
10. After successful login, you should see the application form for the specific job.
"""
    else:
        login_phase = """
PHASE 2: REGISTER OR LOGIN
3. If no credentials, try to register:
   - Look for "Registrer" / "Register" tab
   - Enter email and create password
4. If "email already registered" appears — report requires_registration = false, login_failed = true.
"""

    extra_fields = ""
    if profile_data.get('birth_date'):
        extra_fields += f"\n- Birth Date: {profile_data['birth_date']}"

    return f"""
GOAL: Submit job application on JobbNorge (jobseeker.jobbnorge.no).

CRITICAL: JobbNorge shows login AND register on the same page. Always use LOGIN if credentials exist.
The email {credentials.get('email', '') if credentials else 'N/A'} is ALREADY registered — do NOT try to register again.

APPLICATION DATA:
- Full Name: {profile_data.get('full_name', '')}
- Email: {profile_data.get('email', '')}
- Phone: {profile_data.get('phone', '')}{extra_fields}
- Resume URL: {resume_url or 'Not provided'}

PHASE 1: COOKIE HANDLING
1. Click "Godta alle" / "Accept" if cookie popup appears.
2. Close any popups.

{login_phase}

PHASE 3: FILL APPLICATION FORM
10. After login, you should see the application form. JobbNorge uses multi-step forms with "Lagre / Neste" (Save / Next) buttons.

11. CRITICAL — "Medie/nettsted" dropdown (where you found the vacancy):
    This dropdown is REQUIRED. Select ANY value (e.g., "Finn.no", "NAV.no", "Jobbnorge.no").
    IMPORTANT: After selecting the value, CLICK OUTSIDE the dropdown (on the page body)
    to ensure the value is registered BEFORE clicking "Lagre / Neste".
    If the dropdown resets after clicking "Lagre / Neste", try:
    - Select the FIRST available option (not the placeholder)
    - Click on a different field or empty area to trigger the change event
    - Then click "Lagre / Neste"
    DO NOT retry this dropdown more than 3 times. If it keeps failing, skip it and continue.

12. Fill text fields:
    - Name / Navn: {profile_data.get('full_name', '')}
    - Email / E-post: {profile_data.get('email', '')}
    - Phone / Telefon: {profile_data.get('phone', '')}
    - Cover Letter / Søknadsbrev: Use cover_letter from navigation_payload
    - Any textarea questions: answer from cover_letter context or navigation_payload
13. CV Upload: If file upload exists, use resume_url from navigation_payload.
    If upload fails twice, skip and continue.
14. Language skills (Norsk/Engelsk): Select "Godt" for both if available.
15. Additional required fields: fill from navigation_payload data.

PHASE 4: NAVIGATE MULTI-STEP FORM
16. Click "Lagre / Neste" to go to next page.
17. If validation error appears, fix the field and try again.
18. If STUCK on same page after 3 clicks of "Lagre / Neste" — look for validation errors
    (red borders, error messages) and fix them. If cannot fix after 2 attempts, click submit anyway.

PHASE 5: SUBMIT
19. On the final page, click "Send søknad" / "Submit application".
20. Wait for confirmation: "Søknaden er mottatt" / "Application received".

COVER LETTER:
{cover_letter[:500]}...
"""


def _workday_application(
    profile_data: dict,
    cover_letter: str,
    credentials: Optional[dict],
    resume_url: Optional[str]
) -> str:
    extra_fields = ""
    if profile_data.get('birth_date'):
        extra_fields += f"\n- Birth Date: {profile_data['birth_date']}"
    if profile_data.get('street'):
        extra_fields += f"\n- Address: {profile_data['street']}, {profile_data.get('postal_code', '')} {profile_data.get('city', '')}"

    return f"""
GOAL: Submit job application on Workday recruitment portal.

CRITICAL WORKDAY-SPECIFIC RULES:
- Workday uses AUTOCOMPLETE DROPDOWNS that look like text fields.
  After typing, a SUGGESTION LIST appears below the field.
  You MUST CLICK on a suggestion from that list. Just typing and clicking Next will NOT save the value.
- Pattern for autocomplete fields: input_text → WAIT 1 second → CLICK on first visible suggestion → proceed.
- If field keeps resetting after 2 attempts with input_text → try clicking the field, then clicking a visible option.
- Common autocomplete fields: "How Did You Hear About Us?", "Country", "Source".
- Multi-page form: click "Next" to advance. If validation error — fix the field.

APPLICATION DATA:
- Full Name: {profile_data.get('full_name', '')}
- First Name: {profile_data.get('first_name', '')}
- Last Name: {profile_data.get('last_name', '')}
- Email: {profile_data.get('email', '')}
- Phone: {profile_data.get('phone', '')}{extra_fields}
- Country: {profile_data.get('country', 'Norge')}
- Resume URL: {resume_url or 'Not provided'}

PHASE 1: COOKIE & START
1. Click "Accept Cookies" / cookie consent.
2. Click "Apply" / "Apply Manually" (NOT "Apply with LinkedIn").

PHASE 2: FILL APPLICATION
3. Fill personal info:
   - Country: Select "Norway" / "Norge" (autocomplete — type "Nor" then CLICK suggestion)
   - Given Name / First Name: {profile_data.get('first_name', '')}
   - Family Name / Last Name: {profile_data.get('last_name', '')}
   - Address / Street: {profile_data.get('street', '')}
   - Postal Code: {profile_data.get('postal_code', '')}
   - City: {profile_data.get('city', '')}
   - Email: {profile_data.get('email', '')}
   - Phone: {profile_data.get('phone', '')}
   - Phone Device Type: select "Mobile"
   - Country Phone Code: select "+47 (Norway)" (autocomplete)
4. "How Did You Hear About Us?" — type "Finn" then CLICK the suggestion from dropdown list.
   DO NOT just type and click Next — you MUST select from the dropdown.
5. "Previously worked at company?" — select "No" if available, or type "Nei".
6. Click "Next" to proceed.

PHASE 3: EXPERIENCE & CV
7. Upload CV if file upload field exists.
8. Fill work experience if required.
9. Click "Next".

PHASE 4: SUBMIT
10. Review and check required checkboxes (privacy, terms).
11. Click "Submit" / "Send".
12. Wait for confirmation page.

COVER LETTER:
{cover_letter[:500]}...
"""


def _successfactors_application(
    profile_data: dict,
    cover_letter: str,
    credentials: Optional[dict],
    resume_url: Optional[str]
) -> str:
    login_phase = ""
    if credentials:
        login_phase = f"""
PHASE 2: LOGIN
3. Look for "Log in", "Sign in", "Logg inn", or "Talent Profile Login" button/link.
4. If a CAS login page appears, enter:
   - Email / Username: {credentials.get('email', '')}
   - Password: from payload
5. Click "Sign In" / "Log in" / "Logg inn".
6. Wait for redirect back to the application form.
7. If already logged in, skip to PHASE 3.
"""
    else:
        login_phase = """
PHASE 2: REGISTRATION (if required)
3. If login/registration is required, report requires_registration = true.
4. Otherwise, continue as guest if possible.
"""

    extra_fields = ""
    if profile_data.get('birth_date'):
        extra_fields += f"\n- Birth Date: {profile_data['birth_date']}"
    if profile_data.get('street'):
        extra_fields += f"\n- Address: {profile_data['street']}, {profile_data.get('postal_code', '')} {profile_data.get('city', '')}"
    if profile_data.get('nationality'):
        extra_fields += f"\n- Nationality: {profile_data['nationality']}"

    return f"""
GOAL: Submit job application on SAP SuccessFactors career portal.

IMPORTANT NOTES ABOUT SUCCESSFACTORS:
- Forms are often multi-section with expandable accordion panels.
- Sections may include: Personal Info, Work Experience, Education, Cover Letter, Attachments.
- Required fields are usually marked with * or red asterisks.
- Some sections may be pre-filled from Talent Profile (if logged in).
- The "Apply" button may redirect to a separate form page after login.

APPLICATION DATA:
- Full Name: {profile_data.get('full_name', '')}
- First Name: {profile_data.get('first_name', '')}
- Last Name: {profile_data.get('last_name', '')}
- Email: {profile_data.get('email', '')}
- Phone: {profile_data.get('phone', '')}{extra_fields}
- Resume URL: {resume_url or 'Not provided'}

PHASE 1: COOKIE HANDLING
1. Click "Accept All Cookies" / "Godta alle" if cookie banner appears.
2. Close any popups or modals.

{login_phase}

PHASE 3: NAVIGATE TO APPLICATION FORM
8. After login, look for "Apply" / "Søk nå" / "Apply Now" button on the job page.
9. Click it to open the application form.
10. If redirected to Talent Profile creation, fill minimum required fields and continue.

PHASE 4: FILL APPLICATION FORM
11. SuccessFactors forms have multiple sections. Fill each section:

    PERSONAL INFORMATION section:
    - First Name / Fornavn: {profile_data.get('first_name', '')}
    - Last Name / Etternavn: {profile_data.get('last_name', '')}
    - Email / E-post: {profile_data.get('email', '')}
    - Phone / Telefon: {profile_data.get('phone', '')}
    - Country / Land: {profile_data.get('country', 'Norway')}
    - City / By: {profile_data.get('city', '')}

    COVER LETTER / MOTIVATION section:
    - If there is a text area for cover letter / motivation / søknadstekst:
      Paste the cover_letter text from navigation_payload.
    - WARNING: If the field has a formatting toolbar, it is a rich text editor.
      CLICK the editable area first, wait for cursor, then type.
    - If cover letter fails twice, skip and continue.

    ATTACHMENTS / CV section (CRITICAL - often REQUIRED on SuccessFactors):
    - This section is usually MANDATORY. The submit button will be blocked without a CV.
    - If file upload exists and resume_url is provided:
      Step A: Look for "Attach Resume" / "Upload CV" / "Last opp CV" / "Choose File" / "Browse" button
      Step B: Click the upload button. A file dialog should appear.
      Step C: Use upload_file action with resume_url from navigation_payload
      Step D: If no file dialog appears, look for ANY <input type="file"> element on the page
              (including HIDDEN ones with display:none or opacity:0). Use upload_file directly on it.
      Step E: If upload_file fails, try drag-and-drop zone: look for "Drag and drop" / "Dra og slipp" area
      Step F: After upload, WAIT 3 seconds for the file to process. Look for filename appearing.
      Step G: If ALL attempts fail after 3 tries, proceed to submit anyway —
              the form may show a validation error which is better than being stuck.

    OTHER SECTIONS (Work Experience, Education):
    - If these sections are REQUIRED and empty, try to fill from navigation_payload.
    - If data is not available, check if sections can be skipped.
    - Do NOT get stuck on optional sections — skip them.

    ADDITIONAL QUESTIONS:
    - Answer any custom questions using data from navigation_payload.
    - For dropdown questions, select the closest matching option.
    - For slider/range inputs: CLICK the input, then type the value. Do NOT drag.

12. Check all required fields are filled (marked with *).

PHASE 5: REVIEW AND SUBMIT
13. If there is a "Review" / "Preview" step, check the summary.
14. Check any required checkboxes (data privacy, terms, GDPR):
    - "I agree" / "Jeg godtar" / "Samtykke"
    - Privacy policy / Personvern
15. Click "Submit" / "Send" / "Send søknad" / "Submit Application".
16. WAIT for confirmation page — look for "Thank you", "Takk", "Application received".
17. Do NOT click away before seeing confirmation.

COVER LETTER TEXT TO USE:
{cover_letter[:500]}...
"""


def _generic_application(
    profile_data: dict,
    cover_letter: str,
    credentials: Optional[dict],
    resume_url: Optional[str]
) -> str:
    login_phase = ""
    if credentials:
        login_phase = f"""
PHASE 2: LOGIN (if required)
3. If login form appears, use:
   - Email: {credentials.get('email', '')}
   - Password: from payload
4. Complete login and continue.
"""
    else:
        login_phase = """
PHASE 2: CONTINUE WITHOUT LOGIN
3. If login is required, report requires_registration = true.
4. Otherwise, proceed to application.
"""

    birth_date = profile_data.get('birth_date', '')
    nationality = profile_data.get('nationality', '')
    gender = profile_data.get('gender', '')
    street = profile_data.get('street', '')
    postal_code = profile_data.get('postal_code', '')
    city = profile_data.get('city', '')
    country = profile_data.get('country', 'Norge')
    driver_license = profile_data.get('driver_license', '')

    extra_data = ""
    if birth_date:
        extra_data += f"\n- Birth Date / Fødselsdato: {birth_date}"
    if nationality:
        extra_data += f"\n- Nationality / Nasjonalitet: {nationality}"
    if gender:
        extra_data += f"\n- Gender / Kjønn: {gender}"
    if street:
        extra_data += f"\n- Street / Adresse: {street}"
    if postal_code:
        extra_data += f"\n- Postal Code / Postnummer: {postal_code}"
    if city:
        extra_data += f"\n- City / Sted: {city}"
    if country:
        extra_data += f"\n- Country / Land: {country}"
    if driver_license:
        extra_data += f"\n- Driver License / Førerkort: {driver_license}"

    return f"""
GOAL: Find the job application form on this website and submit a job application.

CRITICAL: This URL was provided as the application link for a job posting. It may be:
- A direct link to an application form
- A company website where you need to find the careers/jobs section
- A recruitment platform page
Do NOT terminate just because the landing page doesn't look like a recruitment site.
You MUST explore the site to find the application form before giving up.

LOADING OVERLAY HANDLING (applies to ALL phases):
IMPORTANT: Many sites show a loading overlay ("Siden laster...", "Loading...", a spinner,
or a semi-transparent overlay covering the page). If you see such an overlay:
1. Do NOT try to click through it or interact with elements behind it.
2. WAIT 5 seconds, then check if the page has finished loading.
3. If still loading after 3 waits (15 seconds total), try scrolling down or clicking
   on an empty area of the page body to dismiss the overlay.
4. Only proceed with form interaction once the overlay is gone.

APPLICATION DATA:
- Full Name: {profile_data.get('full_name', '')}
- First Name: {profile_data.get('first_name', '')}
- Last Name: {profile_data.get('last_name', '')}
- Email: {profile_data.get('email', '')}
- Phone: {profile_data.get('phone', '')}{extra_data}
- Resume URL: {resume_url or 'Not provided'}

PHASE 1: COOKIE HANDLING
1. Accept cookies: "Godta alle", "Accept", "OK".
2. Close any popups.

{login_phase}

PHASE 3: FIND APPLICATION FORM
5. First, look for direct apply buttons on the current page:
   - "Apply", "Søk", "Send søknad", "Søk på stillingen", "Apply now"
6. If NO apply button found, look for career/jobs navigation links:
   - "Karriere", "Ledige stillinger", "Jobs", "Jobb hos oss", "Work with us"
   - "Bli en del av teamet", "Join us", "Jobbe hos oss", "Stillinger"
   - Check header menu, footer links, and sidebar navigation
7. Navigate through career pages to find the application form.
8. If after exploring 3-4 pages you still cannot find any application form,
   look for a "Kontakt oss" (Contact us) page or email link as last resort.
9. Click to open form.

PHASE 4: FILL APPLICATION
7. Fill all form fields using the APPLICATION DATA above:
   - Name fields: Use full_name or first/last name
   - Email: {profile_data.get('email', '')}
   - Phone: {profile_data.get('phone', '')}
   - Birth date / Fødselsdato: Use birth_date from data if field exists
   - Address / Adresse: Use street, postal code, city from data
   - Nationality / Gender: Use from data if fields exist
   - Cover Letter / Motivation / Søknadstekst: Use 'cover_letter' text from navigation_payload.
     WARNING: If this field has a formatting toolbar, it is a rich text editor.
     Do NOT use input_text on <span> elements — it will fail.
     Instead: CLICK the editable area first (inside <iframe> or <div contenteditable="true">),
     wait for cursor, then type. If fill fails twice, skip this field and continue.
   - Any other field: Check navigation_payload for matching data
   - SLIDER / RANGE INPUTS (input type="range"): These appear as draggable sliders.
     Do NOT try to drag them. Instead:
     Step 1: CLICK directly on the <input type="range"> element.
     Step 2: Use input_text to type the numeric value from navigation_payload.
     Step 3: If input_text fails, try clicking at the approximate position on the slider track.
     Step 4: After setting value, CLICK elsewhere on the page to trigger change event.
     Step 5: If the slider still won't set after 2 attempts, SKIP it and continue.
     Common slider fields: "Antall år med bransjeerfaring", "Years of experience", etc.
8. CV/Resume upload (if file upload field exists and resume_url is provided):
   IMPORTANT: Do NOT get stuck on CV upload. If it fails twice, move on.
   Step A: Look for an upload button ("Last opp fil", "Velg fil", "Upload", "Choose file") and click it.
   Step B: If a file chooser dialog opens, use upload_file with resume_url from navigation_payload.
   Step C: If upload_file fails with "No file chooser dialog", look for ANY <input type="file">
      element on the page, including HIDDEN ones (display:none, opacity:0). Try upload_file
      directly on that <input type="file"> element.
   Step D: If ALL upload attempts fail after 2 tries total, SKIP the CV upload entirely
      and continue. The cover letter and other fields are more important — do NOT retry endlessly.
   If resume_url is not provided, skip the upload entirely.
9. If there is a cover letter upload field, paste the cover_letter text from payload.

PHASE 5: SUBMIT
10. Check required checkboxes (terms, GDPR).
11. Click submit button.
12. Wait for confirmation.

COVER LETTER TEXT TO USE:
{cover_letter[:500]}...
"""


# ============================================
# MAIN API
# ============================================

def get_navigation_goal(
    domain: str,
    action: str,
    profile_data: dict,
    cover_letter: str = "",
    credentials: Optional[dict] = None,
    email: str = "",
    password: str = "",
    resume_url: Optional[str] = None
) -> str:
    """
    Get the appropriate navigation goal for a given site and action.

    Args:
        domain: The site domain (e.g., 'webcruiter.no')
        action: Either 'register' or 'apply'
        profile_data: User profile data dict
        cover_letter: Cover letter text (for apply)
        credentials: Saved credentials dict (for apply with login)
        email: Registration email (for register)
        password: Registration password (for register)
        resume_url: URL to CV file (for apply)

    Returns:
        Navigation goal string for Skyvern
    """
    if action == 'register':
        return get_registration_goal(domain, profile_data, email, password)
    elif action == 'apply':
        return get_application_goal(domain, profile_data, cover_letter, credentials, resume_url)
    else:
        raise ValueError(f"Unknown action: {action}. Use 'register' or 'apply'.")


# ============================================
# UTILITY FUNCTIONS
# ============================================

def build_memory_section(memory: dict = None, stats: dict = None) -> str:
    """Build a PREVIOUS EXPERIENCE section to inject into navigation goals.

    Args:
        memory: Latest form memory dict from site_form_memory table.
                May contain '_master_skill' key with AI-generated cross-domain patterns.
        stats: Aggregated domain stats from get_domain_stats().

    Returns:
        String to append to navigation_goal, or empty string if no memory.
    """
    # Determine which master skill to use: AI-generated (from DB) or static fallback
    ai_master_skill = memory.get("_master_skill") if memory else None

    if not memory or (not memory.get("site_domain") and not memory.get("skill_text")):
        # No domain-specific experience — inject master skill for first-time encounters
        if ai_master_skill:
            return f"\n\n--- MASTER SKILL (learned from {stats.get('success_count', 'multiple') if stats else 'multiple'} successful submissions) ---\n{ai_master_skill}\n--- END MASTER SKILL ---\n"
        return MASTER_SKILL

    outcome = memory.get("outcome", "")
    lines = ["\n\n--- PREVIOUS EXPERIENCE ON THIS SITE ---"]

    # MetaClaw-style: if AI-generated skill exists, use it as primary source
    skill_text = memory.get("skill_text")
    if skill_text:
        lines.append("")
        lines.append("AI-GENERATED SKILL GUIDE (from previous attempts):")
        lines.append(skill_text)
        lines.append("")
        # Also add master skill as supplementary cross-domain knowledge
        if ai_master_skill:
            lines.append("ADDITIONAL CROSS-DOMAIN PATTERNS:")
            lines.append(ai_master_skill[:800])
            lines.append("")
    else:
        # No domain-specific AI skill — include master skill as baseline knowledge
        if ai_master_skill:
            lines.append(f"\n--- MASTER SKILL (cross-domain patterns) ---\n{ai_master_skill}\n--- END MASTER SKILL ---")
        else:
            lines.append(MASTER_SKILL)

    # Always include structured data as supplement
    # Navigation flow
    nav_flow = memory.get("navigation_flow", [])
    if nav_flow and len(nav_flow) > 1:
        truncated = [u[:60] for u in nav_flow[:6]]
        lines.append(f"Navigation flow ({len(nav_flow)} pages): " + " → ".join(truncated))

    # Form fields from successful submission
    form_fields = memory.get("form_fields", [])
    if form_fields and outcome == "success":
        filled = [f for f in form_fields if f.get("was_filled")]
        labels = [f.get("label", f.get("field_name", "?"))[:30] for f in filled if f.get("label") or f.get("field_name")]
        if labels:
            lines.append(f"Form had {len(filled)} fields: {', '.join(labels[:12])}")

    # File upload info
    if memory.get("has_file_upload"):
        method = memory.get("file_upload_method", "unknown")
        element = memory.get("file_upload_element", "")
        if method and method != "failed" and element:
            lines.append(f"File upload: worked via {method} (element: {element[:50]})")
        elif method == "failed":
            lines.append("File upload: FAILED last time. Try <input type='file'> first, skip after 2 attempts.")

    # Rich text editor info
    if memory.get("has_rich_text_editor"):
        method = memory.get("rich_text_method", "unknown")
        if method == "contenteditable":
            lines.append("Cover letter: Uses contenteditable div. Click editable area, then type.")
        elif method == "iframe":
            lines.append("Cover letter: Uses iframe (TinyMCE/CKEditor). Click inside iframe body, then type.")
        elif method == "failed":
            lines.append("Cover letter: Rich text editor FAILED last time. Try iframe body first.")

    # Step count hint
    total_steps = memory.get("total_steps", 0)
    if total_steps and outcome == "success":
        lines.append(f"Last successful submission took {total_steps} steps.")

    # Failure avoidance
    if outcome == "failure":
        reason = memory.get("failure_reason", "")
        if reason:
            lines.append(f"WARNING: Previous attempt FAILED with: {reason}")

    # Stats-based avoidance instructions
    if stats:
        sc = stats.get("success_count", 0)
        fc = stats.get("failure_count", 0)
        if sc + fc >= 2:
            rate = stats.get("success_rate", 0)
            lines.append(f"Site track record: {sc} successes, {fc} failures ({rate:.0%} rate)")

        for cf in stats.get("common_failures", []):
            if cf["count"] >= 2:
                reason = cf["reason"]
                if reason == "reach_max_steps":
                    lines.append("CRITICAL: Site often exceeds step limits. Focus on essential fields only.")
                elif reason == "magic_link":
                    lines.append("STOP: Site uses magic link login. Report requires_registration=true.")
                elif reason == "login_failed":
                    lines.append("WARNING: Login fails often. If login fails, report immediately.")
                elif "file_upload" in reason:
                    lines.append("WARNING: File upload often fails. Try once, skip if failing.")

    lines.append("--- END PREVIOUS EXPERIENCE ---\n")
    return "\n".join(lines)


def get_supported_sites() -> list:
    """Return list of supported recruitment platforms."""
    return [
        'webcruiter',
        'easycruit',
        'jobylon',
        'teamtailor',
        'lever',
        'recman',
        'cvpartner',
        'reachmee',
        'varbi',
        'hrmanager',
        'finn',
        'nav',
        'successfactors',
        'csod',
        'easyapply',
        'jobbnorge',
        'workday'
    ]


def is_site_supported(domain: str) -> bool:
    """Check if a site has specific support (vs generic)."""
    site_type = detect_site_type(domain)
    return site_type != 'generic'
