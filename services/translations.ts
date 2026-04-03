
export type Language = 'en' | 'no' | 'uk';

export const translations = {
  en: {
    nav: {
      dashboard: 'Dashboard',
      jobs: 'Jobs',
      activity: 'Activity Log',
      settings: 'Settings',
      account: 'My Account',
      admin: 'User Management',
      logout: 'Log Out',
      workerStatus: 'Worker Status',
      collapse: 'Collapse Sidebar'
    },
    login: {
      subtitle: 'Automated Job Search & Application Platform',
      email: 'Email Address',
      password: 'Password',
      signIn: 'Sign In',
      signUp: 'Create Account',
      loginBtn: 'Login to Workspace',
      createAccount: 'Sign Up Free',
      checkEmail: 'Check your email for confirmation link!',
    },
    profile: {
      title: 'Client Cabinet',
      subtitle: 'Manage your account and subscription',
      activePlan: 'Active Plan',
      userId: 'User ID',
      lastLogin: 'Last Login',
      logout: 'Sign Out',
      usageStats: 'Usage Statistics',
      jobsScanned: 'Jobs Processed',
      costIncurred: 'AI Cost (Est.)'
    },
    admin: {
      title: 'User Management',
      subtitle: 'Create, manage and delete users.',
      addUser: 'Add User',
      totalAiCost: 'Total AI Cost',
      totalJobs: 'Total Jobs',
      totalApps: 'Total Applications',
      jobs: 'Jobs',
      apps: 'Apps',
      cost: 'Cost'
    },
    dashboard: {
      title: 'Dashboard',
      subtitle: 'System Overview',
      syncData: 'Sync Data',
      activityStats: 'Activity Statistics',
      sources: 'Sources',
      totalJobs: 'Total Jobs',
      analyzed: 'Analyzed',
      applications: 'Applications',
      newToday: 'New Today',
      estCost: 'AI Cost (Est.)',
      mapTitle: 'Job Map',
      costPanel: {
        title: 'Cost Analysis',
        lastAction: 'Last Action',
        daily: 'Daily Cost',
        total: 'Total Cost',
        calculator: 'Manual Calculator',
        calcDesc: 'Cost of last',
        jobs: 'jobs'
      },
      map: {
        filters: 'Map Filters',
        days7: 'Last 7 Days',
        days10: 'Last 10 Days',
        month: 'Last Month',
        hideApplied: 'Hide Applied',
        showAll: 'Show All',
        clear: 'Clear Map'
      },
      filter: {
        all: 'All'
      }
    },
    jobs: {
      title: 'Jobs Market',
      subtitle: 'Manage and track your opportunities.',
      refresh: 'Refresh',
      export: 'Export CSV',
      searchPlaceholder: 'Search title...',
      companyPlaceholder: 'Company...',
      locationPlaceholder: 'Location...',
      dateFilter: 'Date',
      extract: 'Extract',
      analyze: 'Analyze',
      rescan: 'Rescan',
      reanalyze: 'Analyze',
      selectAction: 'Select jobs for actions',
      help: {
        refresh: 'Reload job list from database without scanning',
        rescan: 'Run full scan: scrape FINN/NAV URLs, save new jobs, analyze with AI',
        excel: 'Export filtered jobs to Excel spreadsheet',
        pdf: 'Export filtered jobs to PDF document',
        print: 'Print filtered jobs list',
        exportLang: 'Language for cover letters in export (Norwegian or Ukrainian)',
        history: 'View previous exports',
        extract: 'Download job descriptions from source websites',
        reanalyze: 'Run AI analysis to score job relevance',
        formType: 'Detect application form type (FINN Easy, external form, registration)',
        autoApply: 'Send applications automatically via Skyvern browser automation',
      },
      table: {
        title: 'Title',
        company: 'Company',
        location: 'Location',
        added: 'Added',
        match: 'Match',
        link: 'Link'
      },
      status: {
        new: 'New',
        analyzed: 'Analyzed',
        applied: 'Applied',
        rejected: 'Rejected',
        sent: 'Sent',
        draft: 'Draft'
      },
      actions: {
        writeSoknad: 'Write',
        approve: 'Approve',
        sendSkyvern: 'Send Skyvern',
        resetStatus: 'Reset status',
        sendManually: 'Send manually',
        confirmSent: 'Yes, sent!',
        viewTask: 'Task'
      },
      sections: {
        aiAnalysis: 'AI Relevance Analysis',
        duties: 'Key Duties (What to do)',
        description: 'Job Description',
        application: 'Application (Søknad)'
      },
      filters: {
        applicationAll: 'Application: All',
        applicationSent: 'Sent',
        applicationWritten: 'Written',
        applicationNone: 'No application',
        formAll: 'Form type: All',
        formNoUrl: 'No URL',
        formFinnEasy: 'FINN Easy',
        formExternal: 'Form',
        formRegistration: 'Registration',
        formUnknown: 'Unknown',
        deadlineAll: 'Deadline: All',
        deadlineExpired: 'Expired',
        deadlineActive: 'Active',
        deadlineNone: 'No deadline',
        sourceAll: 'Source: All',
      }
    },
    settings: {
      title: 'Settings',
      tabs: {
        profile: 'Profile',
        resume: 'Resume Upload & AI',
        search: 'Job Search URLs',
        aiConfig: 'AI Configuration',
        automation: 'Automation',
        knowledge: 'Knowledge Base'
      },
      resume: {
        uploadTitle: 'Click to upload',
        analyzeBtn: 'Analyze Resumes',
        previewTitle: 'Preview Generated Profile',
        saveProfile: 'Save Profile',
        savedProfiles: 'Saved Profiles',
        viewContent: 'View Content',
        setActive: 'Set Active',
        activeBadge: 'Active'
      },
      search: {
        title: 'Search Sources',
        placeholder: 'e.g. FINN or NAV URL',
        add: 'Add',
        save: 'Save Configuration'
      },
      aiConfig: {
        title: 'AI Brain Configuration',
        subtitle: 'Control how the AI thinks, analyzes, and writes.',
        genTab: '1. Profile Gen',
        analyzeTab: '2. Job Analysis',
        appTab: '3. Application',
        savePrompt: 'Save Prompt',
        analysisLangTitle: 'AI Analysis Language',
        analysisLangDesc: 'Force the AI to output analysis and tasks in a specific language, regardless of the UI language.'
      },
      automation: {
        title: 'Scheduled Scanner',
        enable: 'Enable Auto-Scanning',
        runTime: 'Daily Run Time (UTC)',
        runTest: 'Run Test',
        save: 'Save Schedule',
        debug: 'Debug Console',
        autoSoknad: {
          title: 'Auto Cover Letter',
          subtitle: 'Automatically generate cover letters for relevant jobs',
          enable: 'Enable auto cover letter',
          threshold: 'Minimum relevance score',
          thresholdHint: 'Generate cover letter for jobs scoring at or above this threshold',
          save: 'Save'
        }
      },
      knowledge: {
        title: 'Knowledge Base',
        question: 'Question',
        answer: 'Answer',
        category: 'Category',
        add: 'Add'
      }
    },
    activity: {
      title: 'System Logs',
      subtitle: 'Centralized event and cost log',
      empty: 'Log is empty.',
      scanned: 'Scanned',
      success: 'Success',
      error: 'Error',
      scannedCount: 'Scanned',
      duplicates: 'duplicates',
      added: 'added',
      analyzed: 'analyzed',
      source: 'Source',
      cost: 'Cost'
    },
    dateRange: {
      today: 'Today',
      days3: '3 days',
      week: 'Week',
      clear: 'Clear',
      noSelection: 'Select dates'
    }
  },
  no: {
    nav: {
      dashboard: 'Oversikt',
      jobs: 'Stillinger',
      activity: 'Aktivitetslogg',
      settings: 'Innstillinger',
      account: 'Min Konto',
      admin: 'Brukeradministrasjon',
      logout: 'Logg ut',
      workerStatus: 'Worker Status',
      collapse: 'Kollaps'
    },
    login: {
      subtitle: 'Automatisert jobbsøkeplattform',
      email: 'E-postadresse',
      password: 'Passord',
      signIn: 'Logg inn',
      signUp: 'Opprett konto',
      loginBtn: 'Logg inn',
      createAccount: 'Registrer deg gratis',
      checkEmail: 'Sjekk e-posten din for bekreftelse!',
    },
    profile: {
      title: 'Klientkabinett',
      subtitle: 'Administrer kontoen din',
      activePlan: 'Aktiv Plan',
      userId: 'Bruker ID',
      lastLogin: 'Siste pålogging',
      logout: 'Logg ut',
      usageStats: 'Bruksstatistikk',
      jobsScanned: 'Jobber behandlet',
      costIncurred: 'AI Kostnad (Est.)'
    },
    admin: {
      title: 'Brukeradministrasjon',
      subtitle: 'Opprett, administrer og slett brukere.',
      addUser: 'Legg til bruker',
      totalAiCost: 'Total AI-kostnad',
      totalJobs: 'Totalt stillinger',
      totalApps: 'Totalt søknader',
      jobs: 'Stillinger',
      apps: 'Søknader',
      cost: 'Kostnad'
    },
    dashboard: {
      title: 'Oversikt',
      subtitle: 'Systemoversikt',
      syncData: 'Synkroniser',
      activityStats: 'Aktivitetsstatistikk',
      sources: 'Kilder',
      totalJobs: 'Totalt stillinger',
      analyzed: 'Analysert',
      applications: 'Søknader',
      newToday: 'Nye i dag',
      estCost: 'AI Kostnad (Est.)',
      mapTitle: 'Jobbkart',
      costPanel: {
        title: 'Kostnadsanalyse',
        lastAction: 'Siste handling',
        daily: 'Daglig kostnad',
        total: 'Total kostnad',
        calculator: 'Manuell Kalkulator',
        calcDesc: 'Kostnad for siste',
        jobs: 'jobber'
      },
      map: {
        filters: 'Kartfiltre',
        days7: 'Siste 7 dager',
        days10: 'Siste 10 dager',
        month: 'Siste måned',
        hideApplied: 'Skjul søkte',
        showAll: 'Vis alle',
        clear: 'Tøm kart'
      },
      filter: {
        all: 'Alle'
      }
    },
    jobs: {
      title: 'Jobbmarked',
      subtitle: 'Administrer og spor dine muligheter.',
      refresh: 'Oppdater',
      export: 'Eksporter CSV',
      searchPlaceholder: 'Søk tittel...',
      companyPlaceholder: 'Selskap...',
      locationPlaceholder: 'Sted...',
      dateFilter: 'Dato',
      extract: 'Hent info',
      analyze: 'Analyser',
      rescan: 'Skann på nytt',
      reanalyze: 'Analyser',
      selectAction: 'Velg jobber for handling',
      help: {
        refresh: 'Last inn jobblisten på nytt fra databasen uten å skanne',
        rescan: 'Kjør full skanning: hent FINN/NAV-URLer, lagre nye jobber, analyser med AI',
        excel: 'Eksporter filtrerte jobber til Excel-regneark',
        pdf: 'Eksporter filtrerte jobber til PDF-dokument',
        print: 'Skriv ut filtrerte jobber',
        exportLang: 'Språk for søknader i eksport (norsk eller ukrainsk)',
        history: 'Vis tidligere eksporter',
        extract: 'Last ned jobbeskrivelser fra kildenettsteder',
        reanalyze: 'Kjør AI-analyse for å vurdere jobbrelevans',
        formType: 'Finn søknadstype (FINN Easy, eksternt skjema, registrering)',
        autoApply: 'Send søknader automatisk via Skyvern nettleserautomatisering',
      },
      table: {
        title: 'Tittel',
        company: 'Selskap',
        location: 'Sted',
        added: 'Lagt til',
        match: 'Match',
        link: 'Lenke'
      },
      status: {
        new: 'Ny',
        analyzed: 'Analysert',
        applied: 'Søkt',
        rejected: 'Avvist',
        sent: 'Sendt',
        draft: 'Utkast'
      },
      actions: {
        writeSoknad: 'Skriv',
        approve: 'Godkjenn',
        sendSkyvern: 'Send Skyvern',
        resetStatus: 'Tilbakestill',
        sendManually: 'Send manuelt',
        confirmSent: 'Ja, sendt!',
        viewTask: 'Oppgave'
      },
      sections: {
        aiAnalysis: 'AI Relevanseanalyse',
        duties: 'Nøkkeloppgaver (Hva må gjøres)',
        description: 'Stillingsbeskrivelse',
        application: 'Søknad'
      },
      filters: {
        applicationAll: 'Søknad: Alle',
        applicationSent: 'Sendt',
        applicationWritten: 'Skrevet',
        applicationNone: 'Ingen søknad',
        formAll: 'Skjematype: Alle',
        formNoUrl: 'Uten URL',
        formFinnEasy: 'FINN Easy',
        formExternal: 'Skjema',
        formRegistration: 'Registrering',
        formUnknown: 'Ukjent',
        deadlineAll: 'Frist: Alle',
        deadlineExpired: 'Utløpt',
        deadlineActive: 'Aktiv',
        deadlineNone: 'Ingen frist',
        sourceAll: 'Kilde: Alle',
      }
    },
    settings: {
      title: 'Innstillinger',
      tabs: {
        profile: 'Profil',
        resume: 'CV Opplasting & AI',
        search: 'Søke-URLer',
        aiConfig: 'AI Konfigurasjon',
        automation: 'Automasjon',
        knowledge: 'Kunnskapsbase'
      },
      resume: {
        uploadTitle: 'Klikk for å laste opp',
        analyzeBtn: 'Analyser CVer',
        previewTitle: 'Forhåndsvisning av profil',
        saveProfile: 'Lagre Profil',
        savedProfiles: 'Lagrede Profiler',
        viewContent: 'Se innhold',
        setActive: 'Sett Aktiv',
        activeBadge: 'Aktiv'
      },
      search: {
        title: 'Søkekilder',
        placeholder: 'f.eks. FINN eller NAV URL',
        add: 'Legg til',
        save: 'Lagre Konfigurasjon'
      },
      aiConfig: {
        title: 'AI Hjerne Konfigurasjon',
        subtitle: 'Kontroller hvordan AI tenker, analyserer og skriver.',
        genTab: '1. Profil Gen',
        analyzeTab: '2. Jobbanalyse',
        appTab: '3. Søknad',
        savePrompt: 'Lagre Prompt',
        analysisLangTitle: 'AI Analysespråk',
        analysisLangDesc: 'Tving AI til å gi analyse og oppgaver på et spesifikt språk, uavhengig av UI-språk.'
      },
      automation: {
        title: 'Planlagt Skanner',
        enable: 'Aktiver Autoskanning',
        runTime: 'Daglig kjøretid (UTC)',
        runTest: 'Kjør Test',
        save: 'Lagre Tidsplan',
        debug: 'Debug Konsoll',
        autoSoknad: {
          title: 'Auto-Søknad',
          subtitle: 'Generer søknader automatisk for relevante stillinger',
          enable: 'Aktiver auto-søknad',
          threshold: 'Minimum relevansscore',
          thresholdHint: 'Generer søknad for stillinger med score ≥ denne verdien',
          save: 'Lagre'
        }
      },
      knowledge: {
        title: 'Kunnskapsbase',
        question: 'Spørsmål',
        answer: 'Svar',
        category: 'Kategori',
        add: 'Legg til'
      }
    },
    activity: {
      title: 'Systemlogger',
      subtitle: 'Sentralisert hendelses- og kostnadslogg',
      empty: 'Loggen er tom.',
      scanned: 'Skannet',
      success: 'Suksess',
      error: 'Feil',
      scannedCount: 'Skannet',
      duplicates: 'duplikater',
      added: 'lagt til',
      analyzed: 'analysert',
      source: 'Kilde',
      cost: 'Kostnad'
    },
    dateRange: {
      today: 'I dag',
      days3: '3 dager',
      week: 'Uke',
      clear: 'Tøm',
      noSelection: 'Velg datoer'
    }
  },
  uk: {
    nav: {
      dashboard: 'Дашборд',
      jobs: 'Вакансії',
      activity: 'Логи',
      settings: 'Налаштування',
      account: 'Мій Кабінет',
      admin: 'Керування Користувачами',
      logout: 'Вийти',
      workerStatus: 'Статус Воркера',
      collapse: 'Згорнути'
    },
    login: {
      subtitle: 'Автоматизована платформа пошуку роботи',
      email: 'Електронна пошта',
      password: 'Пароль',
      signIn: 'Увійти',
      signUp: 'Створити акаунт',
      loginBtn: 'Увійти в кабінет',
      createAccount: 'Реєстрація',
      checkEmail: 'Перевірте пошту для підтвердження!',
    },
    profile: {
      title: 'Кабінет Клієнта',
      subtitle: 'Керування акаунтом та підпискою',
      activePlan: 'Активна підписка',
      userId: 'ID Користувача',
      lastLogin: 'Останній вхід',
      logout: 'Вийти',
      usageStats: 'Статистика використання',
      jobsScanned: 'Оброблено вакансій',
      costIncurred: 'Витрати AI'
    },
    admin: {
      title: 'Керування Користувачами',
      subtitle: 'Створення, керування та видалення користувачів.',
      addUser: 'Додати Користувача',
      totalAiCost: 'Загальна вартість AI',
      totalJobs: 'Всього вакансій',
      totalApps: 'Всього заявок',
      jobs: 'Вакансії',
      apps: 'Заявки',
      cost: 'Вартість'
    },
    dashboard: {
      title: 'Дашборд',
      subtitle: 'Огляд системи',
      syncData: 'Синхронізація',
      activityStats: 'Статистика активності',
      sources: 'Джерела',
      totalJobs: 'Всього вакансій',
      analyzed: 'Проаналізовано',
      applications: 'Заявки',
      newToday: 'Нові сьогодні',
      estCost: 'Витрати AI',
      mapTitle: 'Карта Вакансій',
      costPanel: {
        title: 'Аналіз Витрат',
        lastAction: 'Остання дія',
        daily: 'За день',
        total: 'Всього',
        calculator: 'Калькулятор',
        calcDesc: 'Вартість останніх',
        jobs: 'вакансій'
      },
      map: {
        filters: 'Фільтри Карти',
        days7: '7 Днів',
        days10: '10 Днів',
        month: 'Місяць',
        hideApplied: 'Приховати Подані',
        showAll: 'Показати Всі',
        clear: 'Очистити'
      },
      filter: {
        all: 'Всі'
      }
    },
    jobs: {
      title: 'Ринок Вакансій',
      subtitle: 'Керуйте та відстежуйте можливості.',
      refresh: 'Оновити',
      export: 'Експорт CSV',
      searchPlaceholder: 'Пошук назви...',
      companyPlaceholder: 'Компанія...',
      locationPlaceholder: 'Місце...',
      dateFilter: 'Дата',
      extract: 'Витягнути',
      analyze: 'Аналізувати',
      rescan: 'Пересканувати',
      reanalyze: 'Проаналізувати',
      selectAction: 'Виберіть для дій',
      help: {
        refresh: 'Перезавантажити список вакансій з бази без сканування',
        rescan: 'Повне сканування: парсинг FINN/NAV, збереження нових вакансій, аналіз AI',
        excel: 'Експорт відфільтрованих вакансій у Excel',
        pdf: 'Експорт відфільтрованих вакансій у PDF',
        print: 'Друк відфільтрованих вакансій',
        exportLang: 'Мова супровідних листів в експорті (норвезька або українська)',
        history: 'Переглянути попередні експорти',
        extract: 'Завантажити описи вакансій з сайтів-джерел',
        reanalyze: 'Запустити AI аналіз для оцінки релевантності',
        formType: 'Визначити тип форми подачі (FINN Easy, зовнішня форма, реєстрація)',
        autoApply: 'Автоматична подача заявок через Skyvern (браузерна автоматизація)',
      },
      table: {
        title: 'Назва',
        company: 'Компанія',
        location: 'Місце',
        added: 'Додано',
        match: 'Збіг',
        link: 'Лінк'
      },
      status: {
        new: 'Нова',
        analyzed: 'Аналіз',
        applied: 'Подано',
        rejected: 'Відмова',
        sent: 'Відправлено',
        draft: 'Чернетка'
      },
      actions: {
        writeSoknad: 'Написати',
        approve: 'Схвалити',
        sendSkyvern: 'Надіслати Skyvern',
        resetStatus: 'Скинути статус',
        sendManually: 'Відправити вручну',
        confirmSent: 'Так, відправлено!',
        viewTask: 'Завдання'
      },
      sections: {
        aiAnalysis: 'AI Аналіз Релевантності',
        duties: 'Ключові Обов\'язки (Що робити)',
        description: 'Опис Вакансії',
        application: 'Заявка (Søknad)'
      },
      filters: {
        applicationAll: 'Заявка: Всі',
        applicationSent: 'Відправлені',
        applicationWritten: 'Написані',
        applicationNone: 'Без заявки',
        formAll: 'Подача: Всі',
        formNoUrl: 'Без URL',
        formFinnEasy: 'FINN Easy',
        formExternal: 'Форма',
        formRegistration: 'Реєстрація',
        formUnknown: 'Невідомо',
        deadlineAll: 'Дедлайн: Всі',
        deadlineExpired: 'Протерміновані',
        deadlineActive: 'Активні',
        deadlineNone: 'Без дедлайну',
        sourceAll: 'Джерело: Всі',
      }
    },
    settings: {
      title: 'Налаштування',
      tabs: {
        profile: 'Профіль',
        resume: 'Завантаження CV та AI',
        search: 'URL для пошуку',
        aiConfig: 'Конфігурація AI',
        automation: 'Автоматизація',
        knowledge: 'База Знань'
      },
      resume: {
        uploadTitle: 'Натисніть для завантаження',
        analyzeBtn: 'Аналізувати резюме',
        previewTitle: 'Попередній перегляд профілю',
        saveProfile: 'Зберегти Профіль',
        savedProfiles: 'Збережені Профілі',
        viewContent: 'Переглянути вміст',
        setActive: 'Активувати',
        activeBadge: 'Активний'
      },
      search: {
        title: 'Джерела Пошуку',
        placeholder: 'напр. посилання FINN або NAV',
        add: 'Додати',
        save: 'Зберегти Конфігурацію'
      },
      aiConfig: {
        title: 'Налаштування AI Мозку',
        subtitle: 'Керуйте тим, як AI думає, аналізує та пише.',
        genTab: '1. Генерація Профілю',
        analyzeTab: '2. Аналіз Вакансій',
        appTab: '3. Заявка (App)',
        savePrompt: 'Зберегти Промпт',
        analysisLangTitle: 'Мова AI Аналізу',
        analysisLangDesc: 'Змусити AI видавати аналіз та список завдань конкретною мовою, незалежно від мови інтерфейсу.'
      },
      automation: {
        title: 'Планувальник Сканування',
        enable: 'Увімкнути Авто-сканування',
        runTime: 'Час запуску (UTC)',
        runTest: 'Запустити Тест',
        save: 'Зберегти Розклад',
        debug: 'Консоль Налагодження',
        autoSoknad: {
          title: 'Авто-Søknad',
          subtitle: 'Автоматично генерувати супровідні листи для релевантних вакансій',
          enable: 'Увімкнути авто-søknad',
          threshold: 'Мінімальний бал релевантності',
          thresholdHint: 'Генерувати søknad для вакансій з балом ≥ цього значення',
          save: 'Зберегти'
        }
      },
      knowledge: {
        title: 'База Знань',
        question: 'Питання',
        answer: 'Відповідь',
        category: 'Категорія',
        add: 'Додати'
      }
    },
    activity: {
      title: 'Системні Логи',
      subtitle: 'Централізований журнал подій та витрат',
      empty: 'Журнал порожній.',
      scanned: 'Скановано',
      success: 'Успіх',
      error: 'Помилка',
      scannedCount: 'Відскановано',
      duplicates: 'вже в базі',
      added: 'додано',
      analyzed: 'проаналізовано',
      source: 'Джерело',
      cost: 'Вартість'
    },
    dateRange: {
      today: 'Сьогодні',
      days3: '3 дні',
      week: 'Тиждень',
      clear: 'Очистити',
      noSelection: 'Виберіть дати'
    }
  }
};
