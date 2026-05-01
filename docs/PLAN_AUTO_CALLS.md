# План: Автоматичні дзвінки після подачі заявки

**Статус:** Чернетка плану (не реалізовано)  
**Дата:** 2026-05-01  
**Технологічний стек:** Pipecat (OSS) + Voip.ms SIP + ElevenLabs TTS + Oracle VM

---

## Мета

Після того як система надсилає заявку на вакансію — автоматично телефонувати роботодавцю:
- **День +1**: "Чи отримали ви заявку?"
- **День +5**: "Чи підходить кандидат? Коли можна чекати відповіді?"

Дзвінки ініціюються системно, без участі користувача. Результат дзвінка (транскрипт + підсумок) зберігається в БД і приходить у Telegram.

---

## Компоненти стеку

| Компонент | Рішення | Обґрунтування |
|---|---|---|
| Voice AI framework | **Pipecat** (open-source, BSD) | Безплатний, підтримує SIP telephony, Python |
| Телефонія | **Voip.ms** (SIP trunk) | Дешевший за Twilio (~$0.015/хв Норвегія), SIP API |
| TTS (синтез голосу) | **ElevenLabs** Streaming API | Найкраща якість, streaming для мінімальної затримки |
| STT (розпізнавання) | **Faster-Whisper** (self-hosted) | Безплатно, ~200ms latency на CPU |
| LLM | **Claude Haiku** / Gemini Flash | Вже є ключі в системі |
| Хостинг | **Oracle VM** (вже є) | auto_apply.py вже там крутиться |
| Планувальник | Python daemon (новий модуль) | Поряд з auto_apply.py |

---

## Зміни в базі даних

### Міграція 1: Додати контактні поля до `jobs`

```sql
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS contact_person text,
  ADD COLUMN IF NOT EXISTS contact_email_extracted text;
```

### Міграція 2: Нова таблиця `call_schedule`

```sql
CREATE TABLE IF NOT EXISTS call_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES jobs(id) ON DELETE CASCADE,
  application_id uuid REFERENCES applications(id) ON DELETE CASCADE,
  phone text NOT NULL,
  contact_person text,
  call_type text NOT NULL CHECK (call_type IN ('day1', 'day5')),
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'calling', 'done', 'failed', 'no_answer', 'skipped')),
  transcript text,
  outcome text CHECK (outcome IN (
    'confirmed_received',
    'not_received',
    'not_interested',
    'callback_requested',
    'voicemail',
    'no_answer',
    'wrong_number'
  )),
  callback_date date,
  duration_sec int,
  cost_usd numeric(8,4),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX ON call_schedule (status, scheduled_at);
CREATE INDEX ON call_schedule (job_id);
CREATE INDEX ON call_schedule (application_id);
```

---

## Зміни в коді

### 1. `supabase/functions/extract_job_text/index.ts`

Вже витягує `contact_phone` з HTML — додати збереження в `jobs` таблицю:

```typescript
// Після успішного витягання контакту:
await supabase
  .from('jobs')
  .update({
    contact_phone: contactInfo.phone,
    contact_person: contactInfo.name,
    contact_email_extracted: contactInfo.email,
  })
  .eq('id', jobId);
```

### 2. `worker/auto_apply.py`

Після успішної подачі заявки (`status = 'sent'`) — створити записи в `call_schedule`:

```python
def schedule_followup_calls(job_id: str, application_id: str, contact_phone: str, contact_person: str):
    """Called after application.status changes to 'sent'."""
    now = datetime.utcnow()
    calls = [
        {
            'job_id': job_id,
            'application_id': application_id,
            'phone': contact_phone,
            'contact_person': contact_person,
            'call_type': 'day1',
            'scheduled_at': (now + timedelta(days=1)).replace(hour=10, minute=0).isoformat(),
            'status': 'pending',
        },
        {
            'job_id': job_id,
            'application_id': application_id,
            'phone': contact_phone,
            'contact_person': contact_person,
            'call_type': 'day5',
            'scheduled_at': (now + timedelta(days=5)).replace(hour=10, minute=0).isoformat(),
            'status': 'pending',
        },
    ]
    supabase.table('call_schedule').insert(calls).execute()
```

### 3. Новий файл `worker/call_worker.py`

Основний демон — щогодини перевіряє заплановані дзвінки та ініціює їх через Pipecat:

```
Логіка:
1. SELECT * FROM call_schedule WHERE status='pending' AND scheduled_at <= NOW()
2. UPDATE status='calling'
3. Зібрати контекст: job title/company + cover letter excerpt + cv_profiles summary
4. Побудувати "картку дзвінка" (call card) — JSON для Pipecat агента
5. Запустити Pipecat pipeline → Voip.ms SIP → дзвінок
6. Після завершення: UPDATE call_schedule SET status, outcome, transcript, duration_sec
7. Надіслати Telegram-сповіщення
```

Скрипти розмов (system prompts):

**Day +1:**
```
Ти — AI-асистент що телефонує від імені кандидата {{candidate_name}}.
Вакансія: {{job_title}} в {{company}}.
Мета: підтвердити що заявка дійшла, дізнатися статус.

Сценарій:
1. Привітайся, представ кандидата
2. Запитай чи отримали заявку надіслану {{sent_date}}
3. Якщо отримали — подякуй, запитай коли можна чекати відповіді
4. Якщо ні — попроси перевірити {{candidate_email}}
5. Увічно попрощайся, запиши результат
```

**Day +5:**
```
Ти — AI-асистент що телефонує від імені кандидата {{candidate_name}}.
Вакансія: {{job_title}} в {{company}}.
Мета: дізнатися чи розглядається кандидатура, коли чекати відповіді.

Сценарій:
1. Привітайся, нагадай хто телефонує та щодо якої позиції
2. Запитай чи мали можливість переглянути заявку
3. Якщо так — запитай чи є питання до досвіду кандидата
4. Запитай орієнтовні терміни зворотного зв'язку
5. Якщо просять передзвонити — уточни дату/час
```

### 4. Зміни в UI (`components/JobTable.tsx`)

Нова колонка `📞` між `Søknad` і `Подача`:

```typescript
// Статуси колонки:
const callStatusIcon = (calls: CallSchedule[]) => {
  if (!calls?.length) return '—';
  const latest = calls[calls.length - 1];
  const icons: Record<string, string> = {
    pending: '📅',
    calling: '📞',
    done: outcomeToIcon(latest.outcome),
    failed: '⚠️',
    no_answer: '📵',
  };
  return icons[latest.status] ?? '—';
};

const outcomeToIcon = (outcome: string) => ({
  confirmed_received: '✅',
  callback_requested: '🔄',
  not_interested: '❌',
  voicemail: '📨',
  no_answer: '📵',
})[outcome] ?? '❓';
```

Розгорнутий рядок — блок "Дзвінки":

```
┌─ Дзвінки ──────────────────────────────────────────┐
│ День +1 (02.05.2026): ✅ Підтверджено отримання     │
│ День +5 (06.05.2026): 📅 Заплановано                │
│                                                     │
│ Транскрипт (день +1):                               │
│ "Так, ми отримали вашу заявку. Розглянемо           │
│  протягом тижня..."                [розгорнути]     │
└─────────────────────────────────────────────────────┘
```

### 5. Dashboard (`pages/DashboardPage.tsx`)

Додати MetricCard блок:

```
[📞 Заплановано: 3] [✅ Підтверджень: 7] [🔄 Чекають: 2] [❌ Відмов: 1]
```

---

## Потік даних (end-to-end)

```
[FINN/NAV] → extract_job_text → jobs.contact_phone (зберігається)
                                        ↓
[Заявка надіслана] → auto_apply.py → call_schedule (+1d, +5d)
                                        ↓
                              call_worker.py (щогодини)
                                        ↓
                              Pipecat pipeline
                              ├─ Faster-Whisper (STT)
                              ├─ Claude Haiku (LLM)
                              └─ ElevenLabs (TTS)
                                        ↓
                              Voip.ms SIP trunk → +47xxxxxxxx
                                        ↓
                              Розмова 1-3 хвилини
                                        ↓
                              call_schedule.outcome + transcript
                                        ↓
                              Telegram: "📞 [Company]: ✅ отримали"
                                        ↓
                              UI: realtime Supabase subscription
```

---

## Вартість (оцінка)

| Сценарій | Вартість за дзвінок | 100 дзвінків/міс |
|---|---|---|
| Мінімальний (Piper TTS) | ~$0.03 | ~$3 |
| Рекомендований (ElevenLabs TTS) | ~$0.25 | ~$25 |
| Комерційний (VoxAgent/VAPI) | ~$0.30–0.50 | ~$40+ |

**Telephony (Voip.ms, Норвегія):** ~$0.015–0.025/хв

---

## Що потрібно від користувача (перед стартом розробки)

| # | Дія | Де | Час |
|---|---|---|---|
| 1 | Створити акаунт | voip.ms | 10 хв |
| 2 | Поповнити баланс ~$10 | voip.ms | 5 хв |
| 3 | Купити SIP DID номер | voip.ms → DID Numbers | 5 хв |
| 4 | Надати Voip.ms API username + API key | voip.ms → Settings → API | 2 хв |
| 5 | Надати ElevenLabs API key | elevenlabs.io → Profile → API Keys | 2 хв |
| 6 | Вибрати голос для агента (чоловічий/жіночий, стиль) | — | 1 хв |

**Не потрібно:** VoxAgent, Twilio, нові сервери.

---

## Орієнтовні терміни розробки

| Етап | Що | Час |
|---|---|---|
| 1 | SQL міграції + `extract_job_text` оновлення | 2 год |
| 2 | `auto_apply.py` — логіка планування дзвінків | 2 год |
| 3 | `call_worker.py` — Pipecat pipeline + Voip.ms | 8–12 год |
| 4 | UI зміни (колонка + expansion panel + dashboard) | 4 год |
| 5 | Тестування + промт-тюнінг | 4 год |
| **Разом** | | **~20–24 год** |

---

*Документ створений: 2026-05-01. Реалізація починається після отримання Voip.ms та ElevenLabs credentials.*
